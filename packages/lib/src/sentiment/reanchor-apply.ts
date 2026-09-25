import { createHash } from "node:crypto";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { db } from "../db/db";
import {
	promptRuns,
	sentimentAnalyses,
	sentimentAspectObservations,
	sentimentObservations,
	sentimentResolutionCases,
} from "../db/schema";
import { sentimentInputHash } from "./classifier";
import { type SentimentSender, sendSentimentJob } from "./enqueue";
import { analyzeAnswerRanges } from "./ranges";
import { selectedSentimentAnalyses } from "./read-selection";
import { planReanchor, type ReanchorAction, type ReanchorPlan, type StoredEntityResult } from "./reanchor";
import {
	candidatesFromMentions,
	ensureResolutionCase,
	loadDetectableEntities,
	loadMentions,
	loadResolutionCase,
	updateResolutionCase,
} from "./store";
import { extractAnswerBody } from "./text";
import {
	SENTIMENT_CLASSIFIER_VERSION,
	type SentimentAspectKey,
	type SentimentCategory,
	type SentimentEvidence,
	sentimentClassificationResultSchema,
} from "./types";

/**
 * Re-anchoring of stored sentiment results (SENT-ATTR-01) against the
 * database: the manifest of what every stored analysis becomes under the
 * current evidence contract, and its bounded application. A `restamp` is the
 * only write that touches an analysis directly — its result is byte-identical
 * under the current anchors, so only the input hash moves. Everything else
 * goes through the resolution workflow: the case is rotated to a fresh
 * instance for the current input, seeded with the narrowed candidate where
 * one exists, and the worker verifies (or repairs, or classifies again) and
 * persists as it does for every run. Nothing here calls a provider.
 */

export const REANCHOR_MANIFEST_VERSION = "sent-attr-01-reanchor-v1";

export type ReanchorScope =
	/** A completed analysis of the current classifier version. */
	| "current-version"
	/** A current-version analysis parked in its resolution case whose input hash is not the current one: the job rotates and classifies again. */
	| "parked-drift"
	/** A completed older-version analysis the Sentiment page currently reads because no current-version result exists for the run. */
	| "fallback";

export interface ReanchorManifestEntry {
	analysisId: string;
	promptRunId: string;
	brandId: string;
	classifierVersion: string;
	scope: ReanchorScope;
	action: ReanchorAction | "enqueue" | "none";
	reason: string | null;
	storedInputHash: string | null;
	inputHash: string;
	storedDigest: string;
	/** sha256 of the provisional candidate, when the action carries one. */
	candidateDigest: string | null;
	candidate: ReanchorPlan["candidate"];
	spans: {
		identical: number;
		foreign: number;
		narrowed: number;
		unmapped: number;
		droppedOthers: number;
		droppedGeneric: number;
	};
	droppedAspects: ReanchorPlan["droppedAspects"];
}

export interface ReanchorManifest {
	version: typeof REANCHOR_MANIFEST_VERSION;
	classifierVersion: string;
	generatedAt: string;
	brandId: string | null;
	totals: Record<string, number>;
	entries: ReanchorManifestEntry[];
}

function digestOf(value: unknown): string {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function manifestDigest(manifest: ReanchorManifest): string {
	return digestOf(manifest);
}

async function storedEntities(analysisId: string): Promise<StoredEntityResult[]> {
	const observations = await db
		.select({
			id: sentimentObservations.id,
			key: sentimentObservations.entityKey,
			category: sentimentObservations.category,
			score: sentimentObservations.score,
			confidence: sentimentObservations.confidence,
			evidence: sentimentObservations.evidence,
		})
		.from(sentimentObservations)
		.where(eq(sentimentObservations.analysisId, analysisId))
		.orderBy(sentimentObservations.entityKey);
	if (observations.length === 0) return [];
	const aspects = await db
		.select({
			observationId: sentimentAspectObservations.observationId,
			key: sentimentAspectObservations.aspectKey,
			category: sentimentAspectObservations.category,
			score: sentimentAspectObservations.score,
			confidence: sentimentAspectObservations.confidence,
			evidence: sentimentAspectObservations.evidence,
		})
		.from(sentimentAspectObservations)
		.where(
			inArray(
				sentimentAspectObservations.observationId,
				observations.map((o) => o.id),
			),
		)
		.orderBy(sentimentAspectObservations.aspectKey);
	return observations.map((o) => ({
		key: o.key,
		category: o.category as SentimentCategory,
		score: o.score,
		confidence: Number(o.confidence),
		evidence: o.evidence as SentimentEvidence[],
		aspects: aspects
			.filter((a) => a.observationId === o.id)
			.map((a) => ({
				key: a.key as SentimentAspectKey,
				category: a.category as SentimentCategory,
				score: a.score,
				confidence: Number(a.confidence),
				evidence: a.evidence as SentimentEvidence[],
			})),
	}));
}

interface AnalysisRow {
	id: string;
	promptRunId: string;
	brandId: string;
	classifierVersion: string;
	status: string;
	inputHash: string | null;
}

async function inputOf(row: AnalysisRow) {
	const [run] = await db
		.select({ rawOutput: promptRuns.rawOutput, provider: promptRuns.provider, model: promptRuns.model })
		.from(promptRuns)
		.where(eq(promptRuns.id, row.promptRunId));
	const answerBody = run ? extractAnswerBody(run.rawOutput, run.provider, run.model) : null;
	if (answerBody === null) return null;
	const entities = await loadDetectableEntities(row.brandId, "historical");
	const candidates = candidatesFromMentions(await loadMentions(row.promptRunId), entities);
	return { answerBody, candidates, analysis: analyzeAnswerRanges(answerBody) };
}

function spanCounts(plan: ReanchorPlan): ReanchorManifestEntry["spans"] {
	const spans = { identical: 0, foreign: 0, narrowed: 0, unmapped: 0, droppedOthers: 0, droppedGeneric: 0 };
	for (const { mapping } of plan.mappings) {
		spans[mapping.kind] += 1;
		if (mapping.kind === "narrowed") {
			spans.droppedOthers += mapping.droppedOthers.length;
			spans.droppedGeneric += mapping.droppedGeneric.length;
		}
		if (mapping.kind === "foreign") spans.droppedOthers += 1;
	}
	return spans;
}

/** The plan of one stored analysis, as the manifest records it; null when its answer is not extractable. */
export async function planAnalysis(row: AnalysisRow, scope: ReanchorScope): Promise<ReanchorManifestEntry | null> {
	const input = await inputOf(row);
	if (!input) return null;
	const base = {
		analysisId: row.id,
		promptRunId: row.promptRunId,
		brandId: row.brandId,
		classifierVersion: row.classifierVersion,
		scope,
		storedInputHash: row.inputHash,
	};
	if (scope === "parked-drift") {
		const kase = await loadResolutionCase(row.id);
		const inputHash = sentimentInputHash(input.answerBody, input.candidates, input.analysis);
		const drifted = kase !== null && kase.inputHash !== inputHash;
		return {
			...base,
			action: drifted ? "enqueue" : "none",
			reason: drifted ? "the parked case was opened for another input; the job rotates it and classifies again" : null,
			storedInputHash: kase?.inputHash ?? null,
			inputHash,
			storedDigest: digestOf(kase?.provisionalResult ?? null),
			candidateDigest: null,
			candidate: null,
			spans: { identical: 0, foreign: 0, narrowed: 0, unmapped: 0, droppedOthers: 0, droppedGeneric: 0 },
			droppedAspects: [],
		};
	}
	const entities = await storedEntities(row.id);
	const plan = planReanchor({ ...input, storedInputHash: row.inputHash, entities });
	return {
		...base,
		// A fallback row is never written: the current-version result of its run supersedes it.
		action: scope === "fallback" ? (plan.action === "current" ? "none" : plan.action) : plan.action,
		reason: plan.reason,
		inputHash: plan.inputHash,
		storedDigest: plan.storedDigest,
		candidateDigest: plan.candidate ? digestOf(plan.candidate) : null,
		candidate: scope === "fallback" ? null : plan.candidate,
		spans: spanCounts(plan),
		droppedAspects: plan.droppedAspects,
	};
}

/**
 * The manifest over every analysis the page reads or the current version
 * owns: completed current-version analyses, parked current-version cases,
 * and the older-version rows still read as fallback. Read-only.
 */
export async function buildReanchorManifest(args: { brandId?: string } = {}): Promise<ReanchorManifest> {
	const where = args.brandId ? eq(sentimentAnalyses.brandId, args.brandId) : undefined;
	const rows = await db
		.select({
			id: sentimentAnalyses.id,
			promptRunId: sentimentAnalyses.promptRunId,
			brandId: sentimentAnalyses.brandId,
			classifierVersion: sentimentAnalyses.classifierVersion,
			status: sentimentAnalyses.status,
			inputHash: sentimentAnalyses.inputHash,
			completedAt: sentimentAnalyses.completedAt,
			createdAt: sentimentAnalyses.createdAt,
		})
		.from(sentimentAnalyses)
		.where(where)
		.orderBy(sentimentAnalyses.createdAt, sentimentAnalyses.id);
	const selected = new Set((await selectedSentimentAnalyses()).map((s) => s.id));
	const entries: ReanchorManifestEntry[] = [];
	for (const row of rows) {
		const current = row.classifierVersion === SENTIMENT_CLASSIFIER_VERSION;
		let scope: ReanchorScope | null = null;
		if (current && row.status === "completed") scope = "current-version";
		else if (current && row.status === "pending_resolution") scope = "parked-drift";
		else if (!current && row.status === "completed" && selected.has(row.id)) scope = "fallback";
		if (!scope) continue;
		const entry = await planAnalysis(row, scope);
		if (entry) entries.push(entry);
	}
	const totals: Record<string, number> = {};
	for (const entry of entries) {
		const key = `${entry.scope}:${entry.action}`;
		totals[key] = (totals[key] ?? 0) + 1;
	}
	return {
		version: REANCHOR_MANIFEST_VERSION,
		classifierVersion: SENTIMENT_CLASSIFIER_VERSION,
		generatedAt: new Date().toISOString(),
		brandId: args.brandId ?? null,
		totals,
		entries,
	};
}

export type ReanchorApplyOutcome =
	| { analysisId: string; outcome: "restamped" }
	| { analysisId: string; outcome: "rotated"; instanceId: string; jobId: string | null }
	| { analysisId: string; outcome: "enqueued"; jobId: string | null }
	| { analysisId: string; outcome: "skipped"; reason: string }
	| { analysisId: string; outcome: "drift"; reason: string };

const WRITE_ACTIONS: ReadonlySet<string> = new Set(["restamp", "reverify", "repair", "reclassify", "enqueue"]);

/**
 * Apply one manifest entry after re-deriving its plan from the live rows: any
 * difference from the manifest (another action, another candidate, moved rows)
 * is drift and nothing is written for that entry. A rotation that already
 * happened for exactly this input and candidate is reused, so a repeated apply
 * only sends the job again.
 */
export async function applyReanchorEntry(
	entry: ReanchorManifestEntry,
	sender: SentimentSender | null,
): Promise<ReanchorApplyOutcome> {
	if (!WRITE_ACTIONS.has(entry.action))
		return { analysisId: entry.analysisId, outcome: "skipped", reason: `action ${entry.action}` };
	if (entry.scope === "fallback")
		return { analysisId: entry.analysisId, outcome: "skipped", reason: "fallback rows are never written" };
	const [row] = await db
		.select({
			id: sentimentAnalyses.id,
			promptRunId: sentimentAnalyses.promptRunId,
			brandId: sentimentAnalyses.brandId,
			classifierVersion: sentimentAnalyses.classifierVersion,
			status: sentimentAnalyses.status,
			inputHash: sentimentAnalyses.inputHash,
		})
		.from(sentimentAnalyses)
		.where(eq(sentimentAnalyses.id, entry.analysisId));
	if (!row) return { analysisId: entry.analysisId, outcome: "drift", reason: "analysis missing" };
	const live = await planAnalysis(row, entry.scope);
	if (!live) return { analysisId: entry.analysisId, outcome: "drift", reason: "answer not extractable" };
	// The stored observations only move when the worker persists, so a repeated apply of an unprocessed entry re-derives the same plan.
	const same =
		live.action === entry.action &&
		live.inputHash === entry.inputHash &&
		live.candidateDigest === entry.candidateDigest &&
		live.storedDigest === entry.storedDigest;
	if (!same)
		return {
			analysisId: entry.analysisId,
			outcome: "drift",
			reason: `live plan ${live.action} ≠ manifest ${entry.action}`,
		};

	if (entry.action === "enqueue") {
		const jobId = sender ? await sendSentimentJob(sender, row.promptRunId) : null;
		return { analysisId: entry.analysisId, outcome: "enqueued", jobId };
	}
	if (entry.action === "restamp") {
		const updated = await db
			.update(sentimentAnalyses)
			.set({ inputHash: entry.inputHash })
			.where(
				and(
					eq(sentimentAnalyses.id, entry.analysisId),
					eq(sentimentAnalyses.status, "completed"),
					entry.storedInputHash === null
						? isNull(sentimentAnalyses.inputHash)
						: eq(sentimentAnalyses.inputHash, entry.storedInputHash),
				),
			)
			.returning({ id: sentimentAnalyses.id });
		if (updated.length !== 1) return { analysisId: entry.analysisId, outcome: "drift", reason: "input hash moved" };
		return { analysisId: entry.analysisId, outcome: "restamped" };
	}
	const candidate = entry.candidate ? sentimentClassificationResultSchema.parse(entry.candidate) : null;
	const kase = await db.transaction(async (tx) => {
		const rotated = await ensureResolutionCase(entry.analysisId, entry.inputHash, undefined, tx);
		const untouched = rotated.status === "open" && rotated.automatedProviderCalls === 0;
		const fresh = untouched && rotated.provisionalResult === null;
		const seededBefore = untouched && digestOf(rotated.provisionalResult) === digestOf(candidate);
		// An instance of this input that already moved on is the worker's; it is never seeded over.
		if (!fresh && !seededBefore) return null;
		if (fresh && candidate !== null) {
			await updateResolutionCase(
				entry.analysisId,
				{ provisionalResult: candidate, unresolvedTargets: [] },
				undefined,
				tx,
			);
		}
		return rotated;
	});
	if (!kase)
		return { analysisId: entry.analysisId, outcome: "drift", reason: "case of this input already in progress" };
	const jobId = sender ? await sendSentimentJob(sender, row.promptRunId) : null;
	return { analysisId: entry.analysisId, outcome: "rotated", instanceId: kase.instanceId, jobId };
}

/** The live state of a manifest's analyses after an apply: what the worker did with each. */
export async function reanchorStatus(manifest: ReanchorManifest) {
	const ids = manifest.entries.map((e) => e.analysisId);
	if (ids.length === 0) return [];
	const analyses = await db
		.select({
			id: sentimentAnalyses.id,
			status: sentimentAnalyses.status,
			inputHash: sentimentAnalyses.inputHash,
			verifierVersion: sentimentAnalyses.verifierVersion,
			completedAt: sentimentAnalyses.completedAt,
		})
		.from(sentimentAnalyses)
		.where(inArray(sentimentAnalyses.id, ids));
	const cases = await db
		.select({
			analysisId: sentimentResolutionCases.analysisId,
			instanceId: sentimentResolutionCases.instanceId,
			inputHash: sentimentResolutionCases.inputHash,
			status: sentimentResolutionCases.status,
			reviewReason: sentimentResolutionCases.reviewReason,
			calls: sentimentResolutionCases.automatedProviderCalls,
			costUsd: sentimentResolutionCases.totalActualCostUsd,
		})
		.from(sentimentResolutionCases)
		.where(inArray(sentimentResolutionCases.analysisId, ids));
	const caseBy = new Map(cases.map((c) => [c.analysisId, c]));
	return manifest.entries.map((entry) => {
		const analysis = analyses.find((a) => a.id === entry.analysisId);
		const kase = caseBy.get(entry.analysisId);
		return {
			analysisId: entry.analysisId,
			promptRunId: entry.promptRunId,
			plannedAction: entry.action,
			analysisStatus: analysis?.status ?? "missing",
			current: analysis?.inputHash === entry.inputHash,
			verifierVersion: analysis?.verifierVersion ?? null,
			completedAt: analysis?.completedAt?.toISOString() ?? null,
			caseStatus: kase?.status ?? null,
			reviewReason: kase?.reviewReason ?? null,
			caseForCurrentInput: kase?.inputHash === entry.inputHash,
			instanceId: kase?.instanceId ?? null,
			calls: kase?.calls ?? 0,
			costUsd: Number(kase?.costUsd ?? 0),
		};
	});
}
