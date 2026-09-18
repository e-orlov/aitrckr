import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/db";
import { sentimentAnalyses } from "../db/schema";
import { segmentAnswer } from "./anchors";
import {
	SentimentValidationError,
	sentimentInputHash,
	type ValidatedClassification,
	validateClassificationDetailed,
} from "./classifier";
import { groundAnchors } from "./grounding";
import { analyzeAnswerRanges } from "./ranges";
import {
	HUMAN_ADJUDICATION_VERSION,
	type ResolutionCaseStatus,
	type ReviewReason,
	type UnresolvedTarget,
} from "./resolution";
import {
	candidatesFromMentions,
	claimAnalysis,
	loadDetectableEntities,
	loadMentions,
	loadProviderAttempts,
	loadResolutionCase,
	loadRunForSentiment,
	persistClassification,
} from "./store";
import {
	SENTIMENT_CLASSIFIER_VERSION,
	SENTIMENT_MODEL,
	SENTIMENT_PROVIDER_ID,
	SENTIMENT_TAXONOMY_VERSION,
	type SentimentClassificationResult,
	sentimentClassificationResultSchema,
} from "./types";

/**
 * Human fallback of the reliability contract (ADR Amendment B): an operator
 * resolves a case the automatic policy could not. Everything here is
 * identifiers, anchor ids, contexts and codes — the answer text is read by
 * the operator in their own session, never written into a template, a
 * decision file, evidence or a log.
 */

export interface AdjudicationTemplate {
	analysisId: string;
	promptRunId: string;
	brandId: string;
	inputHash: string;
	status: ResolutionCaseStatus;
	reviewReason: ReviewReason | null;
	automatedProviderCalls: number;
	totalActualCostUsd: number;
	/** Candidate keys in canonical order with display names (roster data, not answer text). */
	entities: { key: string; entityType: "brand" | "competitor"; name: string }[];
	/** Every anchor id of the answer with its grounding: which candidates it names explicitly / inherits, or `generic`. */
	anchors: { id: string; explicit: string[]; inherited: string[]; context: string | null }[];
	/** The last automatic candidate (keys, verdicts, anchor ids, polarities). */
	provisionalResult: SentimentClassificationResult | null;
	unresolvedTargets: UnresolvedTarget[];
	attempts: { ordinal: number; phase: string; outcome: string; costUsd: number | null }[];
	/** The decision the operator fills in: the full internal result for every entity. */
	decision: {
		analysisId: string;
		inputHash: string;
		decidedBy: string;
		entities: SentimentClassificationResult["entities"];
	};
}

export const adjudicationDecisionSchema = z.strictObject({
	analysisId: z.guid(),
	inputHash: z.string().regex(/^[0-9a-f]{64}$/),
	decidedBy: z.string().min(1).max(120),
	entities: sentimentClassificationResultSchema.shape.entities,
});
export type AdjudicationDecision = z.infer<typeof adjudicationDecisionSchema>;

export type AdjudicationResult =
	| { status: "applied"; analysisId: string; entities: number; filteredClaimCount: number; verifierVersion: string }
	| { status: "refused"; analysisId: string; code: string; detail?: string | null };

async function analysisById(analysisId: string) {
	return db.query.sentimentAnalyses.findFirst({
		where: and(
			eq(sentimentAnalyses.id, analysisId),
			eq(sentimentAnalyses.classifierVersion, SENTIMENT_CLASSIFIER_VERSION),
		),
	});
}

async function loadInput(analysisId: string) {
	const analysis = await analysisById(analysisId);
	if (!analysis) throw new Error(`no ${SENTIMENT_CLASSIFIER_VERSION} analysis ${analysisId}`);
	const run = await loadRunForSentiment(analysis.promptRunId);
	if (!run || run.answerBody === null) throw new Error(`run ${analysis.promptRunId} has no extractable answer`);
	const mentions = await loadMentions(run.id);
	const candidates = candidatesFromMentions(mentions, await loadDetectableEntities(run.brandId, "historical"));
	const ranges = analyzeAnswerRanges(run.answerBody);
	const anchors = segmentAnswer(run.answerBody, ranges);
	return { analysis, run: { ...run, answerBody: run.answerBody }, mentions, candidates, ranges, anchors };
}

/** The read-only template for one case, addressed by analysis id or prompt run id. */
export async function adjudicationTemplate(analysisOrRunId: string): Promise<AdjudicationTemplate> {
	const byRun = await db.query.sentimentAnalyses.findFirst({
		where: and(
			eq(sentimentAnalyses.promptRunId, analysisOrRunId),
			eq(sentimentAnalyses.classifierVersion, SENTIMENT_CLASSIFIER_VERSION),
		),
	});
	const analysisId = byRun?.id ?? analysisOrRunId;
	const { analysis, run, candidates, ranges, anchors } = await loadInput(analysisId);
	const kase = await loadResolutionCase(analysisId);
	if (!kase) throw new Error(`analysis ${analysisId} has no resolution case`);
	const grounding = groundAnchors(run.answerBody, anchors, candidates);
	const provisional = sentimentClassificationResultSchema.safeParse(kase.provisionalResult);
	const attempts = await loadProviderAttempts(analysisId);
	return {
		analysisId,
		promptRunId: analysis.promptRunId,
		brandId: analysis.brandId,
		inputHash: sentimentInputHash(run.answerBody, candidates, ranges),
		status: kase.status as ResolutionCaseStatus,
		reviewReason: (kase.reviewReason as ReviewReason | null) ?? null,
		automatedProviderCalls: kase.automatedProviderCalls,
		totalActualCostUsd: Number(kase.totalActualCostUsd),
		entities: candidates.map((c) => ({ key: c.key, entityType: c.entityType, name: c.name })),
		anchors: anchors.map((a) => {
			const g = grounding.get(a.id);
			return {
				id: a.id,
				explicit: g ? [...g.explicit] : [],
				inherited: g ? [...g.inherited] : [],
				context: g?.context ?? null,
			};
		}),
		provisionalResult: provisional.success ? provisional.data : null,
		unresolvedTargets: (kase.unresolvedTargets as UnresolvedTarget[]) ?? [],
		attempts: attempts.map((t) => ({
			ordinal: t.ordinal,
			phase: t.phase,
			outcome: t.outcome,
			costUsd: t.actualCostUsd === null ? null : Number(t.actualCostUsd),
		})),
		decision: {
			analysisId,
			inputHash: sentimentInputHash(run.answerBody, candidates, ranges),
			decidedBy: "",
			entities: provisional.success ? provisional.data.entities : [],
		},
	};
}

/**
 * Apply an operator decision: the same deterministic validators as the
 * automatic path over the complete result (every entity, grounding, schema,
 * anchors — no bypass), then the same atomic persistence with the human
 * adjudication recorded as the verification. Anything the validators refuse
 * leaves the case exactly as it was.
 */
export async function applyAdjudication(input: unknown): Promise<AdjudicationResult> {
	const parsed = adjudicationDecisionSchema.safeParse(input);
	if (!parsed.success) {
		const id =
			typeof (input as { analysisId?: unknown })?.analysisId === "string"
				? (input as { analysisId: string }).analysisId
				: "";
		return {
			status: "refused",
			analysisId: id,
			code: "invalid-decision",
			detail: parsed.error.issues[0]?.path.join(".") ?? null,
		};
	}
	const decision = parsed.data;
	const kase = await loadResolutionCase(decision.analysisId);
	if (!kase) return { status: "refused", analysisId: decision.analysisId, code: "no-resolution-case" };
	if (kase.status === "resolved")
		return { status: "refused", analysisId: decision.analysisId, code: "already-resolved" };
	const { run, mentions, candidates, ranges, anchors } = await loadInput(decision.analysisId);
	const inputHash = sentimentInputHash(run.answerBody, candidates, ranges);
	if (inputHash !== decision.inputHash)
		return { status: "refused", analysisId: decision.analysisId, code: "input-hash-drift" };

	let validated: ValidatedClassification;
	try {
		validated = validateClassificationDetailed(
			{ entities: decision.entities },
			{ answerBody: run.answerBody, candidates, anchors, analysis: ranges },
		);
	} catch (error) {
		if (error instanceof SentimentValidationError) {
			return {
				status: "refused",
				analysisId: decision.analysisId,
				code: error.code,
				detail: error.diagnostic?.entityKey ?? null,
			};
		}
		throw error;
	}

	const claimed = await claimAnalysis(decision.analysisId, { allowFinished: true, resumeResolution: true });
	if (!claimed.claimed)
		return { status: "refused", analysisId: decision.analysisId, code: "claimed-elsewhere", detail: claimed.status };
	await persistClassification({
		claim: claimed.claim,
		promptRunId: run.id,
		brandId: run.brandId,
		mentions,
		classification: {
			entities: validated.entities,
			filteredClaims: validated.filteredClaims,
			unresolvedTargets: [],
			contractDefect: null,
			candidate: null,
			provider: SENTIMENT_PROVIDER_ID,
			model: SENTIMENT_MODEL,
			webSearch: true,
			classifierVersion: SENTIMENT_CLASSIFIER_VERSION,
			taxonomyVersion: SENTIMENT_TAXONOMY_VERSION,
			inputHash,
			generationId: null,
		},
		verifierVersion: HUMAN_ADJUDICATION_VERSION,
	});
	return {
		status: "applied",
		analysisId: decision.analysisId,
		entities: validated.entities.length,
		filteredClaimCount: validated.filteredClaims.length,
		verifierVersion: HUMAN_ADJUDICATION_VERSION,
	};
}
