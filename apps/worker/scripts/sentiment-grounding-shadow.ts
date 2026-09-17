#!/usr/bin/env tsx
/**
 * SENT-01 classifier shadow oracle — read-only. Replays the current validation
 * rules (entity grounding, polarity/category fit, anchor resolution; since v5
 * the mandatory overall is terminal and an unsupported aspect claim is dropped
 * on its own) over every stored completed sentiment analysis of the database
 * DATABASE_URL points at, without changing a row. Prints ids, codes and counts
 * only: no answer text, no quotes, no provider payload.
 *
 * Usage (against a restored copy, never production):
 *   pnpm -C apps/worker exec tsx --env-file=<env> scripts/sentiment-grounding-shadow.ts [--version sent-classifier-v3[,sent-classifier-v4]] [--json <file>]
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
	type SentimentEvidence,
	SentimentValidationError,
	segmentAnswer,
	validateClassificationDetailed,
} from "@workspace/lib/sentiment";
import { eq, inArray } from "drizzle-orm";

interface ShadowRow {
	analysisId: string;
	promptRunId: string;
	classifierVersion: string;
	/** `accept` (completed) or the terminal validation code the current rules raise for this analysis. */
	outcome: string;
	entityKey: string | null;
	aspectKey: string | null;
	anchorId: string | null;
	/** Per cited anchor: how it was attributed to its entity (explicit / inherited context / generic / names-others). */
	anchorContexts: Record<string, number>;
	/** Stored aspect rows replayed, and how many of them the current rules keep. */
	aspectsStored: number;
	aspectsKept: number;
	/** Aspect claims the current rules drop (classifier v5): identifiers and codes only. */
	filteredClaims: { entityKey: string; aspectKey: string; code: string; anchorIds: string[] }[];
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

type StoredAnalysis = { id: string; promptRunId: string; brandId: string; classifierVersion: string };
type Grounding = ReturnType<typeof groundAnchors>;

/** How a stored citation was attributed to its entity under the v4 grounding guard. */
function contextLabel(grounding: Grounding, anchorId: string, entityKey: string): string {
	const g = grounding.get(anchorId);
	if (!g) return "unknown";
	if (g.explicit.size > 0) return g.explicit.has(entityKey) ? "explicit" : "names-others";
	return g.inherited.has(entityKey) ? `inherited:${g.context}` : "generic";
}

async function loadAspects(observationId: string, body: string, anchors: ReturnType<typeof segmentAnswer>) {
	const aspects = await db
		.select({
			key: sentimentAspectObservations.aspectKey,
			score: sentimentAspectObservations.score,
			category: sentimentAspectObservations.category,
			confidence: sentimentAspectObservations.confidence,
			evidence: sentimentAspectObservations.evidence,
		})
		.from(sentimentAspectObservations)
		.where(eq(sentimentAspectObservations.observationId, observationId));
	return aspects.map((a) => ({
		key: a.key,
		score: a.score,
		category: a.category,
		confidence: Number(a.confidence),
		evidence: refsFromStored(body, a.evidence as SentimentEvidence[], anchors),
	}));
}

/** Replays the v4 rules over one stored analysis; returns its row and the per-anchor context tallies. */
async function shadowOne(analysis: StoredAnalysis): Promise<ShadowRow> {
	const empty = { entityKey: null, aspectKey: null, anchorId: null };
	const [run] = await db
		.select({ rawOutput: promptRuns.rawOutput, provider: promptRuns.provider, model: promptRuns.model })
		.from(promptRuns)
		.where(eq(promptRuns.id, analysis.promptRunId));
	const body = run ? extractAnswerBody(run.rawOutput, run.provider, run.model) : null;
	const none = { anchorContexts: {}, aspectsStored: 0, aspectsKept: 0, filteredClaims: [] };
	if (!body) return { ...base(analysis), outcome: "body-missing", ...empty, ...none };

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
	const anchorContexts: Record<string, number> = {};
	const internal = {
		entities: await Promise.all(
			observations.map(async (o) => {
				const refs = refsFromStored(body, o.evidence as SentimentEvidence[], anchors);
				for (const ref of refs) {
					const label = contextLabel(grounding, ref.anchorId, o.entityKey);
					anchorContexts[label] = (anchorContexts[label] ?? 0) + 1;
				}
				return {
					key: o.entityKey,
					score: o.score,
					category: o.category,
					confidence: Number(o.confidence),
					evidence: refs,
					aspects: await loadAspects(o.id, body, anchors),
				};
			}),
		),
	};
	const aspectsStored = internal.entities.reduce((n, e) => n + e.aspects.length, 0);
	try {
		const validated = validateClassificationDetailed(internal, {
			answerBody: body,
			candidates,
			anchors,
			analysis: ranges,
		});
		return {
			...base(analysis),
			outcome: "accept",
			...empty,
			anchorContexts,
			aspectsStored,
			aspectsKept: validated.entities.reduce((n, e) => n + e.aspects.length, 0),
			filteredClaims: validated.filteredClaims,
		};
	} catch (error) {
		if (!(error instanceof SentimentValidationError)) throw error;
		return {
			...base(analysis),
			outcome: error.code,
			entityKey: error.diagnostic?.entityKey ?? null,
			aspectKey: error.diagnostic?.aspectKey ?? null,
			anchorId: error.diagnostic?.anchorId ?? null,
			anchorContexts,
			aspectsStored,
			aspectsKept: 0,
			filteredClaims: [],
		};
	}
}

async function main(): Promise<void> {
	const { values } = parseArgs({
		options: { version: { type: "string" }, json: { type: "string" }, brand: { type: "string" } },
	});
	const versions = (values.version ?? "sent-classifier-v3").split(",");
	const analyses = await db
		.select({
			id: sentimentAnalyses.id,
			promptRunId: sentimentAnalyses.promptRunId,
			brandId: sentimentAnalyses.brandId,
			classifierVersion: sentimentAnalyses.classifierVersion,
			status: sentimentAnalyses.status,
		})
		.from(sentimentAnalyses)
		.where(inArray(sentimentAnalyses.classifierVersion, versions));
	const completed = analyses.filter((a) => a.status === "completed" && (!values.brand || a.brandId === values.brand));
	const rows: ShadowRow[] = [];
	const contextTotals: Record<string, number> = {};
	for (const analysis of completed) {
		const row = await shadowOne(analysis);
		rows.push(row);
		for (const [k, v] of Object.entries(row.anchorContexts)) contextTotals[k] = (contextTotals[k] ?? 0) + v;
	}
	const byOutcome: Record<string, number> = {};
	for (const row of rows) byOutcome[row.outcome] = (byOutcome[row.outcome] ?? 0) + 1;
	const accepted = rows.filter((r) => r.outcome === "accept");
	const report = {
		versions,
		analyses: completed.length,
		byOutcome,
		completed: accepted.length,
		terminal: rows.length - accepted.length,
		aspectsStored: rows.reduce((n, r) => n + r.aspectsStored, 0),
		aspectsConfirmed: accepted.reduce((n, r) => n + r.aspectsKept, 0),
		filteredClaims: accepted.reduce((n, r) => n + r.filteredClaims.length, 0),
		anchorContexts: contextTotals,
		rejected: rows.filter((r) => r.outcome !== "accept"),
		filtered: accepted.filter((r) => r.filteredClaims.length > 0),
		accepted: accepted.map((r) => r.promptRunId),
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
