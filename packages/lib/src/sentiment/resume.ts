import { createHash } from "node:crypto";
import { and, asc, eq, isNull } from "drizzle-orm";
import { db } from "../db/db";
import { sentimentAnalyses, sentimentResolutionCases } from "../db/schema";
import { prepareStructuredOutputSchema } from "../providers/schema-contract";
import { segmentAnswer } from "./anchors";
import { databaseNow, decideBreaker, readBreaker } from "./breaker";
import { assessCandidate, sentimentInputHash } from "./classifier";
import { type ControlActor, issuePermit, RESERVATION_ESTIMATES_USD, requireActor } from "./controls";
import { type SentimentSender, sendSentimentJob } from "./enqueue";
import { requestScopeKey, schemaShapeFingerprint, sentimentRequestProfile } from "./fingerprint";
import { analyzeAnswerRanges } from "./ranges";
import { verifierResultSchemaFor } from "./resolution";
import {
	candidatesFromMentions,
	type Executor,
	loadDetectableEntities,
	loadMentions,
	loadProviderAttempts,
	loadRunForSentiment,
} from "./store";
import {
	SENTIMENT_CLASSIFIER_VERSION,
	SENTIMENT_TAXONOMY_VERSION,
	type SentimentClassificationResult,
	sentimentClassificationResultSchema,
} from "./types";

/**
 * Verifier-only resumption of cases parked for review (Amendment C): the
 * cases are selected by invariant — never by a pasted list — from the
 * current instance's own evidence, frozen into a manifest, and authorized one
 * bounded batch at a time with verify-only permits. The job core then reuses
 * the stored candidate and may make exactly one verifier request.
 */

export const RESUME_VERIFY_ESTIMATED_BUDGET_USD = 0.02;
export const RESUME_VERIFY_TTL_SECONDS = 2 * 60 * 60;
export const RESUME_DEFAULT_BATCH = 10;
export const RESUME_MANIFEST_VERSION = 1;

export type ResumeExclusion =
	| "no-accepted-candidate"
	| "candidate-outside-instance"
	| "sending-or-unknown-attempt"
	| "paid-or-accepted-verify"
	| "candidate-malformed"
	| "input-drift"
	| "needs-repair"
	| "contract-defect"
	| "verifier-schema-refused"
	| "breaker-blocked"
	| "run-unreadable";

export interface ResumeEligible {
	analysisId: string;
	promptRunId: string;
	instanceId: string;
	inputHash: string;
	latestOrdinal: number;
	latestAttemptId: string;
}

export interface ResumeManifest {
	version: number;
	classifierVersion: string;
	generatedAt: string;
	eligible: ResumeEligible[];
	excluded: { analysisId: string; reason: ResumeExclusion }[];
	count: number;
	/** sha256 over the ordered eligible analysis ids. */
	digest: string;
	/** sha256 over the ordered latest accepted attempt ids the resumed workflows will reuse. */
	attemptDigest: string;
	projected: { verifyCalls: number; reservationEstimateUsd: string; hardLimits: string };
}

const digestOf = (values: string[]) => createHash("sha256").update(values.join("\n")).digest("hex");

/** Predicates 1–4 in SQL: the parked review case of a current-version analysis whose instance holds an accepted candidate and only unpaid verifier attempts. */
async function candidateCases(executor: Executor) {
	return executor
		.select({
			analysisId: sentimentResolutionCases.analysisId,
			promptRunId: sentimentAnalyses.promptRunId,
			instanceId: sentimentResolutionCases.instanceId,
			inputHash: sentimentResolutionCases.inputHash,
			createdAt: sentimentResolutionCases.createdAt,
		})
		.from(sentimentResolutionCases)
		.innerJoin(sentimentAnalyses, eq(sentimentAnalyses.id, sentimentResolutionCases.analysisId))
		.where(
			and(
				eq(sentimentAnalyses.classifierVersion, SENTIMENT_CLASSIFIER_VERSION),
				eq(sentimentAnalyses.taxonomyVersion, SENTIMENT_TAXONOMY_VERSION),
				eq(sentimentAnalyses.status, "pending_resolution"),
				isNull(sentimentAnalyses.verifiedAt),
				isNull(sentimentAnalyses.verifierVersion),
				eq(sentimentResolutionCases.status, "awaiting_review"),
				eq(sentimentResolutionCases.reviewReason, "contract-defect"),
				isNull(sentimentResolutionCases.nextAttemptAt),
			),
		)
		.orderBy(asc(sentimentResolutionCases.createdAt), asc(sentimentResolutionCases.analysisId));
}

type Attempt = Awaited<ReturnType<typeof loadProviderAttempts>>[number];

/** Predicates 3–5 on the instance's attempts: no unknown outcome, no paid or accepted verify, a parseable latest accepted classify/repair candidate. */
export function selectStoredCandidate(
	attempts: Attempt[],
	instanceId: string,
	inputHash: string,
): { attempt: Attempt; candidate: SentimentClassificationResult } | { reason: ResumeExclusion } {
	const own = attempts.filter((a) => a.instanceId === instanceId);
	if (attempts.some((a) => a.outcome === "sending" || a.outcome === "aborted"))
		return { reason: "sending-or-unknown-attempt" };
	if (
		own.some(
			(a) =>
				a.phase === "verify" &&
				(a.outcome === "accepted" || a.outcome === "rejected" || a.generationId !== null || a.actualCostUsd !== null),
		)
	) {
		return { reason: "paid-or-accepted-verify" };
	}
	const latest = own.filter((a) => a.phase === "classify" || a.phase === "repair").at(-1);
	if (!latest) {
		const anyOther = attempts.some((a) => a.instanceId !== instanceId && a.outcome === "accepted");
		return { reason: anyOther ? "candidate-outside-instance" : "no-accepted-candidate" };
	}
	if (latest.outcome !== "accepted" || latest.candidate === null || latest.inputHash !== inputHash) {
		return { reason: "no-accepted-candidate" };
	}
	const parsed = sentimentClassificationResultSchema.safeParse(latest.candidate);
	if (!parsed.success) return { reason: "candidate-malformed" };
	return { attempt: latest, candidate: parsed.data };
}

/** Predicates 6–8 against the live run: same input, zero unresolved, a verifier document the guard and breaker accept. */
async function assessLiveInput(
	row: { promptRunId: string; instanceId: string; inputHash: string },
	candidate: SentimentClassificationResult,
	executor: Executor,
): Promise<ResumeExclusion | null> {
	const run = await loadRunForSentiment(row.promptRunId, executor);
	if (!run || run.answerBody === null) return "run-unreadable";
	const candidates = candidatesFromMentions(
		await loadMentions(run.id, executor),
		await loadDetectableEntities(run.brandId, "historical", executor),
	);
	const ranges = analyzeAnswerRanges(run.answerBody);
	if (sentimentInputHash(run.answerBody, candidates, ranges) !== row.inputHash) return "input-drift";
	const anchors = segmentAnswer(run.answerBody, ranges);
	const assessment = assessCandidate(candidate, { answerBody: run.answerBody, candidates, anchors, analysis: ranges });
	if (assessment.contractDefect) return "contract-defect";
	if (assessment.unresolved.length > 0) return "needs-repair";
	let document: Record<string, unknown>;
	try {
		document = prepareStructuredOutputSchema(
			verifierResultSchemaFor(
				anchors.map((a) => a.id),
				candidates.map((c) => c.key),
			),
		);
	} catch {
		return "verifier-schema-refused";
	}
	const scopeKey = requestScopeKey(
		sentimentRequestProfile({ webSearch: false, schemaFp: schemaShapeFingerprint(document) }),
	);
	const decision = decideBreaker(await readBreaker(scopeKey, executor), await databaseNow(executor));
	return decision.allow ? null : "breaker-blocked";
}

/** Read-only selection by invariant; mutates nothing. */
export async function selectResumableForVerify(executor: Executor = db): Promise<ResumeManifest> {
	const eligible: ResumeEligible[] = [];
	const excluded: ResumeManifest["excluded"] = [];
	for (const row of await candidateCases(executor)) {
		const stored = selectStoredCandidate(
			await loadProviderAttempts(row.analysisId, executor),
			row.instanceId,
			row.inputHash,
		);
		if ("reason" in stored) {
			excluded.push({ analysisId: row.analysisId, reason: stored.reason });
			continue;
		}
		const live = await assessLiveInput(row, stored.candidate, executor);
		if (live) {
			excluded.push({ analysisId: row.analysisId, reason: live });
			continue;
		}
		eligible.push({
			analysisId: row.analysisId,
			promptRunId: row.promptRunId,
			instanceId: row.instanceId,
			inputHash: row.inputHash,
			latestOrdinal: stored.attempt.ordinal,
			latestAttemptId: stored.attempt.id,
		});
	}
	return {
		version: RESUME_MANIFEST_VERSION,
		classifierVersion: SENTIMENT_CLASSIFIER_VERSION,
		generatedAt: (await databaseNow(executor)).toISOString(),
		eligible,
		excluded,
		count: eligible.length,
		digest: digestOf(eligible.map((e) => e.analysisId)),
		attemptDigest: digestOf(eligible.map((e) => e.latestAttemptId)),
		projected: {
			verifyCalls: eligible.length,
			reservationEstimateUsd: (eligible.length * RESERVATION_ESTIMATES_USD.verify).toFixed(6),
			hardLimits: "one verify phase per case; no classify or repair; permit expiry; one live permit per instance",
		},
	};
}

export function manifestSha256(manifestJson: string): string {
	return createHash("sha256").update(manifestJson).digest("hex");
}

export interface ResumeApplyResult {
	applied: { analysisId: string; permitId: string; jobId: string | null }[];
	skipped: { analysisId: string; reason: ResumeExclusion | "already-permitted" | "case-changed" }[];
	drift: string | null;
}

/**
 * Apply one bounded batch from a frozen manifest: the selector is recomputed
 * and must match the manifest exactly (count, ordered ids, both digests);
 * each case is re-checked under a row lock, given a verify-only permit and
 * sent through the singleton-keyed send. Any mismatch refuses the whole batch
 * — it never broadens selection.
 */
export async function applyResumeForVerify(
	args: { manifest: ResumeManifest; limit: number; sender: SentimentSender } & Partial<ControlActor>,
	executor: Executor = db,
): Promise<ResumeApplyResult> {
	const who = requireActor(args);
	if (!Number.isInteger(args.limit) || args.limit <= 0) throw new Error("limit must be a positive integer");
	const current = await selectResumableForVerify(executor);
	const drift =
		current.count !== args.manifest.count
			? `count ${args.manifest.count} → ${current.count}`
			: current.digest !== args.manifest.digest
				? "eligible ids changed"
				: current.attemptDigest !== args.manifest.attemptDigest
					? "stored candidates changed"
					: null;
	if (drift) return { applied: [], skipped: [], drift };
	const result: ResumeApplyResult = { applied: [], skipped: [], drift: null };
	for (const item of current.eligible.slice(0, args.limit)) {
		const permit = await executor.transaction(async (tx) => {
			// Lock the case row and re-check the invariants inside the transaction that issues the permit.
			const [locked] = await tx
				.select({
					status: sentimentResolutionCases.status,
					instanceId: sentimentResolutionCases.instanceId,
					inputHash: sentimentResolutionCases.inputHash,
				})
				.from(sentimentResolutionCases)
				.where(eq(sentimentResolutionCases.analysisId, item.analysisId))
				.for("update");
			if (
				locked?.status !== "awaiting_review" ||
				locked.instanceId !== item.instanceId ||
				locked.inputHash !== item.inputHash
			) {
				return { skipped: "case-changed" as const };
			}
			const stored = selectStoredCandidate(
				await loadProviderAttempts(item.analysisId, tx),
				item.instanceId,
				item.inputHash,
			);
			if ("reason" in stored || stored.attempt.id !== item.latestAttemptId) return { skipped: "case-changed" as const };
			try {
				return await issuePermit(
					{
						purpose: "resume-verify",
						promptRunId: item.promptRunId,
						analysisId: item.analysisId,
						instanceId: item.instanceId,
						inputHash: item.inputHash,
						classifierVersion: SENTIMENT_CLASSIFIER_VERSION,
						phaseBudget: { classify: 0, repair: 0, verify: 1 },
						estimatedCostBudgetUsd: RESUME_VERIFY_ESTIMATED_BUDGET_USD,
						ttlSeconds: RESUME_VERIFY_TTL_SECONDS,
						...who,
					},
					tx,
				);
			} catch (error) {
				if (
					(error as { code?: string; cause?: { code?: string } }).cause?.code === "23505" ||
					(error as { code?: string }).code === "23505"
				) {
					return { skipped: "already-permitted" as const };
				}
				throw error;
			}
		});
		if ("skipped" in permit) {
			result.skipped.push({ analysisId: item.analysisId, reason: permit.skipped });
			continue;
		}
		const jobId = await sendSentimentJob(args.sender, item.promptRunId);
		result.applied.push({ analysisId: item.analysisId, permitId: permit.id, jobId });
	}
	return result;
}
