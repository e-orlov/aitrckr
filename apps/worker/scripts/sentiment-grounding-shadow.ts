#!/usr/bin/env tsx
/**
 * SENT-01 classifier v4 shadow oracle — read-only. Replays the v4 validation
 * rules (entity grounding, polarity/category fit, anchor resolution) over
 * every stored completed sentiment analysis of the database DATABASE_URL
 * points at, without changing a row. Prints ids, codes and counts only: no
 * answer text, no quotes, no provider payload.
 *
 * Usage (against a restored copy, never production):
 *   pnpm -C apps/worker exec tsx --env-file=<env> scripts/sentiment-grounding-shadow.ts [--version sent-classifier-v3] [--json <file>]
 */
import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { db } from "@workspace/lib/db/db";
import {
	promptRuns,
	sentimentAnalyses,
	sentimentAspectObservations,
	sentimentObservations,
} from "@workspace/lib/db/schema";
import {
	analyzeAnswerRanges,
	candidatesFromMentions,
	extractAnswerBody,
	groundAnchors,
	loadDetectableEntities,
	loadMentions,
	segmentAnswer,
	SentimentValidationError,
	type SentimentEvidence,
	validateClassification,
} from "@workspace/lib/sentiment";
import { eq } from "drizzle-orm";

interface ShadowRow {
	analysisId: string;
	promptRunId: string;
	classifierVersion: string;
	/** `accept` or the first validation code the v4 rules raise for this analysis. */
	outcome: string;
	entityKey: string | null;
	aspectKey: string | null;
	anchorId: string | null;
	/** Per cited anchor: how it was attributed to its entity (explicit / inherited context / generic / names-others). */
	anchorContexts: Record<string, number>;
}

function refsFromStored(body: string, evidence: SentimentEvidence[], anchors: ReturnType<typeof segmentAnswer>) {
	return evidence.map((span) => {
		const anchor = anchors.find((a) => a.start === span.start && a.end === span.end);
		if (!anchor || body.slice(span.start, span.end) !== span.quote) {
			return { anchorId: "s9999", polarity: span.polarity };
		}
		return { anchorId: anchor.id, polarity: span.polarity };
	});
}

async function main(): Promise<void> {
	const { values } = parseArgs({
		options: { version: { type: "string" }, json: { type: "string" }, brand: { type: "string" } },
	});
	const version = values.version ?? "sent-classifier-v3";
	const analyses = await db
		.select({
			id: sentimentAnalyses.id,
			promptRunId: sentimentAnalyses.promptRunId,
			brandId: sentimentAnalyses.brandId,
			classifierVersion: sentimentAnalyses.classifierVersion,
			status: sentimentAnalyses.status,
		})
		.from(sentimentAnalyses)
		.where(eq(sentimentAnalyses.classifierVersion, version));
	const completed = analyses.filter((a) => a.status === "completed" && (!values.brand || a.brandId === values.brand));
	const rows: ShadowRow[] = [];
	const contextTotals: Record<string, number> = {};
	for (const analysis of completed) {
		const [run] = await db
			.select({ rawOutput: promptRuns.rawOutput, provider: promptRuns.provider, model: promptRuns.model })
			.from(promptRuns)
			.where(eq(promptRuns.id, analysis.promptRunId));
		const body = run ? extractAnswerBody(run.rawOutput, run.provider, run.model) : null;
		if (!body) {
			rows.push({ ...base(analysis), outcome: "body-missing", entityKey: null, aspectKey: null, anchorId: null, anchorContexts: {} });
			continue;
		}
		const entities = await loadDetectableEntities(analysis.brandId, "historical");
		const mentions = await loadMentions(analysis.promptRunId);
		const candidates = candidatesFromMentions(mentions, entities);
		const ranges = analyzeAnswerRanges(body);
		const anchors = segmentAnswer(body, ranges);
		const grounding = groundAnchors(body, anchors, candidates);
		const observations = await db
			.select({
				id: sentimentObservations.id,
				entityKey: sentimentObservations.entityKey,
				score: sentimentObservations.score,
				category: sentimentObservations.category,
				confidence: sentimentObservations.confidence,
				evidence: sentimentObservations.evidence,
			})
			.from(sentimentObservations)
			.where(eq(sentimentObservations.analysisId, analysis.id));
		const contexts: Record<string, number> = {};
		const internal = {
			entities: await Promise.all(
				observations.map(async (o) => {
					const aspects = await db
						.select({
							key: sentimentAspectObservations.aspectKey,
							score: sentimentAspectObservations.score,
							category: sentimentAspectObservations.category,
							confidence: sentimentAspectObservations.confidence,
							evidence: sentimentAspectObservations.evidence,
						})
						.from(sentimentAspectObservations)
						.where(eq(sentimentAspectObservations.observationId, o.id));
					const refs = refsFromStored(body, o.evidence as SentimentEvidence[], anchors);
					for (const ref of refs) {
						const g = grounding.get(ref.anchorId);
						const label = !g ? "unknown" : g.explicit.size > 0 ? (g.explicit.has(o.entityKey) ? "explicit" : "names-others") : g.inherited.has(o.entityKey) ? `inherited:${g.context}` : "generic";
						contexts[label] = (contexts[label] ?? 0) + 1;
					}
					return {
						key: o.entityKey,
						score: o.score,
						category: o.category,
						confidence: Number(o.confidence),
						evidence: refs,
						aspects: aspects.map((a) => ({
							key: a.key,
							score: a.score,
							category: a.category,
							confidence: Number(a.confidence),
							evidence: refsFromStored(body, a.evidence as SentimentEvidence[], anchors),
						})),
					};
				}),
			),
		};
		for (const [k, v] of Object.entries(contexts)) contextTotals[k] = (contextTotals[k] ?? 0) + v;
		try {
			validateClassification(internal, { answerBody: body, candidates, anchors, analysis: ranges });
			rows.push({ ...base(analysis), outcome: "accept", entityKey: null, aspectKey: null, anchorId: null, anchorContexts: contexts });
		} catch (error) {
			if (error instanceof SentimentValidationError) {
				rows.push({
					...base(analysis),
					outcome: error.code,
					entityKey: error.diagnostic?.entityKey ?? null,
					aspectKey: error.diagnostic?.aspectKey ?? null,
					anchorId: error.diagnostic?.anchorId ?? null,
					anchorContexts: contexts,
				});
			} else throw error;
		}
	}
	const byOutcome: Record<string, number> = {};
	for (const row of rows) byOutcome[row.outcome] = (byOutcome[row.outcome] ?? 0) + 1;
	const report = {
		version,
		analyses: completed.length,
		byOutcome,
		anchorContexts: contextTotals,
		rejected: rows.filter((r) => r.outcome !== "accept"),
		accepted: rows.filter((r) => r.outcome === "accept").map((r) => r.promptRunId),
	};
	console.log(JSON.stringify(report, null, 1));
	if (values.json) writeFileSync(values.json, JSON.stringify(report, null, 1));
	process.exit(0);
}

function base(analysis: { id: string; promptRunId: string; classifierVersion: string }) {
	return { analysisId: analysis.id, promptRunId: analysis.promptRunId, classifierVersion: analysis.classifierVersion };
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
});
