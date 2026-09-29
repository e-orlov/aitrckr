import { and, asc, eq, isNull } from "drizzle-orm";
import { db } from "../db/db";
import { sentimentAnalyses, sentimentResolutionCases } from "../db/schema";
import { segmentAnswer } from "./anchors";
import { assessCandidate, sentimentInputHash, validateClassificationDetailed } from "./classifier";
import { analyzeAnswerRanges } from "./ranges";
import {
	dropVerifierRejectedAspects,
	SENTIMENT_VERIFIER_VERSION,
	type VerifierIssue,
	type VerifierIssueCode,
} from "./resolution";
import {
	candidatesFromMentions,
	claimAnalysis,
	type Executor,
	loadDetectableEntities,
	loadMentions,
	loadProviderAttempts,
	loadRunForSentiment,
	persistClassification,
} from "./store";
import {
	SENTIMENT_ASPECT_KEYS,
	SENTIMENT_CLASSIFIER_VERSION,
	SENTIMENT_MODEL,
	SENTIMENT_PROVIDER_ID,
	SENTIMENT_TAXONOMY_VERSION,
	type SentimentAspectKey,
	sentimentClassificationResultSchema,
} from "./types";

/**
 * ADR Amendment E replayed on already-parked cases: a `verifier-rejected` case
 * whose stored verdict objected only to aspect claims is settled from durable
 * evidence — the objected aspect claims are dropped and recorded, the verdicts
 * the verifier did not object to are persisted as the verified result. No
 * provider request is made; the verification that stands is the stored accepted
 * verify attempt. Anything the invariant does not cover is left untouched with
 * a typed reason.
 */

export type SettleExclusion =
	| "not-verifier-rejected"
	| "targets-not-aspect-only"
	| "sending-or-unknown-attempt"
	| "no-rejecting-verify"
	| "candidate-malformed"
	| "input-drift"
	| "deterministic-defect"
	| "aspect-not-in-candidate"
	| "run-unreadable"
	| "claimed-elsewhere";

export interface SettleCandidate {
	analysisId: string;
	promptRunId: string;
	instanceId: string;
	inputHash: string;
	droppedAspects: { entityKey: string; aspectKey: SentimentAspectKey; code: string }[];
	verifyAttemptId: string;
}

export interface SettleManifest {
	generatedAt: string;
	eligible: SettleCandidate[];
	excluded: { analysisId: string; reason: SettleExclusion }[];
	count: number;
}

const isAspectKey = (value: unknown): value is SentimentAspectKey =>
	typeof value === "string" && (SENTIMENT_ASPECT_KEYS as readonly string[]).includes(value);

async function evaluate(
	row: {
		analysisId: string;
		promptRunId: string;
		instanceId: string;
		inputHash: string;
		unresolvedTargets: unknown;
		provisionalResult: unknown;
	},
	executor: Executor,
): Promise<
	| {
			eligible: SettleCandidate;
			classification: NonNullable<ReturnType<typeof dropVerifierRejectedAspects>>;
			run: Awaited<ReturnType<typeof loadRunForSentiment>> & { answerBody: string };
			mentions: Awaited<ReturnType<typeof loadMentions>>;
	  }
	| { reason: SettleExclusion }
> {
	const targets = Array.isArray(row.unresolvedTargets)
		? (row.unresolvedTargets as {
				source?: unknown;
				reason?: unknown;
				entityKey?: unknown;
				aspectKey?: unknown;
				anchorId?: unknown;
			}[])
		: [];
	if (
		targets.length === 0 ||
		targets.some((t) => t.source !== "verifier" || !isAspectKey(t.aspectKey) || typeof t.reason !== "string")
	) {
		return { reason: "targets-not-aspect-only" };
	}
	const attempts = await loadProviderAttempts(row.analysisId, executor);
	if (attempts.some((a) => a.outcome === "sending" || a.outcome === "aborted"))
		return { reason: "sending-or-unknown-attempt" };
	const own = attempts.filter((a) => a.instanceId === row.instanceId).sort((a, b) => a.ordinal - b.ordinal);
	const answered = own.filter((a) => a.generationId !== null || a.actualCostUsd !== null);
	const last = answered.at(-1);
	if (!last || last.phase !== "verify" || last.outcome !== "accepted" || own.at(-1)?.id !== last.id)
		return { reason: "no-rejecting-verify" };
	const parsed = sentimentClassificationResultSchema.safeParse(row.provisionalResult);
	if (!parsed.success) return { reason: "candidate-malformed" };
	const run = await loadRunForSentiment(row.promptRunId, executor);
	if (!run || run.answerBody === null) return { reason: "run-unreadable" };
	const mentions = await loadMentions(run.id, executor);
	const candidates = candidatesFromMentions(
		mentions,
		await loadDetectableEntities(run.brandId, "historical", executor),
	);
	const ranges = analyzeAnswerRanges(run.answerBody);
	if (sentimentInputHash(run.answerBody, candidates, ranges) !== row.inputHash) return { reason: "input-drift" };
	const anchors = segmentAnswer(run.answerBody, ranges);
	const assessment = assessCandidate(parsed.data, {
		answerBody: run.answerBody,
		candidates,
		anchors,
		analysis: ranges,
	});
	if (assessment.contractDefect || assessment.unresolved.length > 0) return { reason: "deterministic-defect" };
	const issues: VerifierIssue[] = targets.map((t) => ({
		entityKey: String(t.entityKey),
		target: t.aspectKey as SentimentAspectKey,
		code: String(t.reason).replace(/^verifier:/, "") as VerifierIssueCode,
		anchorId: typeof t.anchorId === "string" ? t.anchorId : null,
	}));
	const idOf = new Map(anchors.map((a) => [`${a.start}:${a.end}`, a.id]));
	const filtered = dropVerifierRejectedAspects(
		assessment,
		issues,
		(span) => idOf.get(`${span.start}:${span.end}`) ?? "s0000",
	);
	if (!filtered) return { reason: "aspect-not-in-candidate" };
	return {
		eligible: {
			analysisId: row.analysisId,
			promptRunId: row.promptRunId,
			instanceId: row.instanceId,
			inputHash: row.inputHash,
			droppedAspects: issues.map((i) => ({
				entityKey: i.entityKey,
				aspectKey: i.target as SentimentAspectKey,
				code: `verifier:${i.code}`,
			})),
			verifyAttemptId: last.id,
		},
		classification: filtered,
		run: { ...run, answerBody: run.answerBody },
		mentions,
	};
}

async function parkedVerifierRejected(executor: Executor) {
	return executor
		.select({
			analysisId: sentimentResolutionCases.analysisId,
			promptRunId: sentimentAnalyses.promptRunId,
			instanceId: sentimentResolutionCases.instanceId,
			inputHash: sentimentResolutionCases.inputHash,
			unresolvedTargets: sentimentResolutionCases.unresolvedTargets,
			provisionalResult: sentimentResolutionCases.provisionalResult,
		})
		.from(sentimentResolutionCases)
		.innerJoin(sentimentAnalyses, eq(sentimentAnalyses.id, sentimentResolutionCases.analysisId))
		.where(
			and(
				eq(sentimentAnalyses.classifierVersion, SENTIMENT_CLASSIFIER_VERSION),
				eq(sentimentAnalyses.taxonomyVersion, SENTIMENT_TAXONOMY_VERSION),
				eq(sentimentAnalyses.status, "pending_resolution"),
				isNull(sentimentAnalyses.verifiedAt),
				eq(sentimentResolutionCases.status, "awaiting_review"),
				eq(sentimentResolutionCases.reviewReason, "verifier-rejected"),
			),
		)
		.orderBy(asc(sentimentResolutionCases.createdAt), asc(sentimentResolutionCases.analysisId));
}

/** Read-only: which parked verifier-rejected cases the aspect-only rule settles, and why the others are left. */
export async function selectVerifierFilteredSettlements(executor: Executor = db): Promise<SettleManifest> {
	const eligible: SettleCandidate[] = [];
	const excluded: SettleManifest["excluded"] = [];
	for (const row of await parkedVerifierRejected(executor)) {
		const result = await evaluate(row, executor);
		if ("reason" in result) excluded.push({ analysisId: row.analysisId, reason: result.reason });
		else eligible.push(result.eligible);
	}
	return { generatedAt: new Date().toISOString(), eligible, excluded, count: eligible.length };
}

export interface SettleResult {
	settled: { analysisId: string; entities: number; droppedAspects: number }[];
	skipped: { analysisId: string; reason: SettleExclusion }[];
}

/**
 * Apply the rule to the cases of a frozen manifest, re-evaluating each one from
 * live rows first (drift skips it), claiming the analysis like adjudication does
 * and persisting through the one atomic path every verified result uses.
 */
export async function applyVerifierFilteredSettlements(
	manifest: SettleManifest,
	options: { limit: number },
): Promise<SettleResult> {
	const result: SettleResult = { settled: [], skipped: [] };
	const byId = new Map((await parkedVerifierRejected(db)).map((r) => [r.analysisId, r]));
	for (const item of manifest.eligible.slice(0, options.limit)) {
		const row = byId.get(item.analysisId);
		if (!row || row.instanceId !== item.instanceId || row.inputHash !== item.inputHash) {
			result.skipped.push({ analysisId: item.analysisId, reason: "not-verifier-rejected" });
			continue;
		}
		const evaluated = await evaluate(row, db);
		if ("reason" in evaluated) {
			result.skipped.push({ analysisId: item.analysisId, reason: evaluated.reason });
			continue;
		}
		if (evaluated.eligible.verifyAttemptId !== item.verifyAttemptId) {
			result.skipped.push({ analysisId: item.analysisId, reason: "no-rejecting-verify" });
			continue;
		}
		const claimed = await claimAnalysis(item.analysisId, { allowFinished: true, resumeResolution: true });
		if (!claimed.claimed) {
			result.skipped.push({ analysisId: item.analysisId, reason: "claimed-elsewhere" });
			continue;
		}
		// The stored candidate minus the objected aspect claims goes through the same deterministic validators as every
		// other persistence path; the verifier's filtered claims are appended to the deterministic ones.
		const dropped = new Set(item.droppedAspects.map((d) => `${d.entityKey} ${d.aspectKey}`));
		const candidate = sentimentClassificationResultSchema.parse(row.provisionalResult);
		const trimmed = {
			entities: candidate.entities.map((e) => ({
				...e,
				aspects: (e.aspects ?? []).filter((a) => !dropped.has(`${e.key} ${a.key}`)),
			})),
		};
		const candidates = candidatesFromMentions(
			evaluated.mentions,
			await loadDetectableEntities(evaluated.run.brandId, "historical"),
		);
		const ranges = analyzeAnswerRanges(evaluated.run.answerBody);
		const validated = validateClassificationDetailed(trimmed, {
			answerBody: evaluated.run.answerBody,
			candidates,
			anchors: segmentAnswer(evaluated.run.answerBody, ranges),
			analysis: ranges,
		});
		await persistClassification({
			claim: claimed.claim,
			promptRunId: evaluated.run.id,
			brandId: evaluated.run.brandId,
			mentions: evaluated.mentions,
			classification: {
				entities: validated.entities,
				filteredClaims: [
					...validated.filteredClaims,
					...evaluated.classification.filteredClaims.filter((c) => c.code.startsWith("verifier:")),
				],
				unresolvedTargets: [],
				contractDefect: null,
				candidate: null,
				provider: SENTIMENT_PROVIDER_ID,
				model: SENTIMENT_MODEL,
				webSearch: true,
				classifierVersion: SENTIMENT_CLASSIFIER_VERSION,
				taxonomyVersion: SENTIMENT_TAXONOMY_VERSION,
				inputHash: item.inputHash,
				generationId: null,
			},
			verifierVersion: SENTIMENT_VERIFIER_VERSION,
		});
		result.settled.push({
			analysisId: item.analysisId,
			entities: validated.entities.length,
			droppedAspects: item.droppedAspects.length,
		});
	}
	return result;
}
