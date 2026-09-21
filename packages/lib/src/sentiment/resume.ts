import { createHash } from "node:crypto";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "../db/db";
import { sentimentAnalyses, sentimentDispatchPermits, sentimentResolutionCases } from "../db/schema";
import { prepareStructuredOutputSchema } from "../providers/schema-contract";
import { segmentAnswer } from "./anchors";
import { databaseNow, decideBreaker, readBreaker } from "./breaker";
import { assessCandidate, sentimentInputHash } from "./classifier";
import {
	type ControlActor,
	expireUnconsumedPermits,
	isResumeVerifyBudget,
	issuePermit,
	PERMIT_LIVE_STATES,
	type PhaseBudget,
	RESERVATION_ESTIMATES_USD,
	RESUME_VERIFY_PHASE_BUDGET,
	requireActor,
} from "./controls";
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

export type ResumeApplySkip =
	| ResumeExclusion
	/** The case row changed between the frozen manifest and the row lock (status, instance, input or stored candidate). */
	| "case-changed"
	/** A concurrent issuer won the partial unique index while this transaction ran. */
	| "already-permitted"
	/** The lifecycle's live permit already consumed a phase: reconciliation or revocation, never a replacement. */
	| "permit-consumed"
	/** The lifecycle's live permit carries an unresolved `sending` attempt: reconciliation only. */
	| "permit-unresolved-attempt"
	/** The lifecycle's live permit is not this manifest's verify-only permit (purpose, budget, input or manifest differ). */
	| "permit-mismatch";

export interface ResumeApplyResult {
	applied: {
		analysisId: string;
		permitId: string;
		jobId: string | null;
		/** `issued`: a new permit; `reused`: the live permit of this manifest, its send retried; `replaced-expired`: an unconsumed expired permit was expired durably and replaced. */
		permit: "issued" | "reused" | "replaced-expired";
	}[];
	skipped: { analysisId: string; reason: ResumeApplySkip }[];
	/** Cases whose permit stands but whose singleton send failed; repeating the same manifest apply retries them. */
	failed: { analysisId: string; permitId: string; error: string }[];
	drift: string | null;
}

type PermitDecision =
	| { skipped: ResumeApplySkip }
	| { permitId: string; permit: ResumeApplyResult["applied"][number]["permit"] };

/**
 * Decide, under the case row lock, which permit authorizes this case's verify
 * call: reuse the live permit when it is exactly this manifest's verify-only
 * permit (same lifecycle, purpose, budget, input and manifest hash); expire an
 * unconsumed, expired permit durably and issue a replacement; refuse — with a
 * typed reason and no write — a permit that consumed a phase, carries an
 * unresolved attempt or does not match. Nothing is ever refunded or retried
 * blindly here.
 */
async function permitForCase(
	tx: Executor,
	item: ResumeEligible,
	manifestSha256: string,
	who: ControlActor,
): Promise<PermitDecision> {
	const live = await tx
		.select()
		.from(sentimentDispatchPermits)
		.where(
			and(
				eq(sentimentDispatchPermits.analysisId, item.analysisId),
				eq(sentimentDispatchPermits.instanceId, item.instanceId),
				inArray(sentimentDispatchPermits.state, [...PERMIT_LIVE_STATES]),
			),
		)
		.for("update");
	const existing = live[0];
	if (existing) {
		const [clock] = await tx
			.select({ expired: sql<boolean>`${sentimentDispatchPermits.expiresAt} <= now()` })
			.from(sentimentDispatchPermits)
			.where(eq(sentimentDispatchPermits.id, existing.id));
		const budget = existing.phaseBudget as PhaseBudget;
		const matches =
			existing.purpose === "resume-verify" &&
			existing.inputHash === item.inputHash &&
			existing.contractSha256 === manifestSha256 &&
			isResumeVerifyBudget(budget);
		if (existing.state === "active") return { skipped: "permit-consumed" };
		if (!clock.expired) {
			return matches ? { permitId: existing.id, permit: "reused" } : { skipped: "permit-mismatch" };
		}
		const stale = await expireUnconsumedPermits(tx, { analysisId: item.analysisId, instanceId: item.instanceId });
		const blocking = stale.blocking[0];
		// `permit-live` cannot occur here (the row was expired by the clock read above); anything else is typed as is.
		if (blocking) return { skipped: blocking.code === "permit-live" ? "permit-mismatch" : blocking.code };
	}
	try {
		const issued = await issuePermit(
			{
				purpose: "resume-verify",
				promptRunId: item.promptRunId,
				analysisId: item.analysisId,
				instanceId: item.instanceId,
				inputHash: item.inputHash,
				classifierVersion: SENTIMENT_CLASSIFIER_VERSION,
				phaseBudget: { ...RESUME_VERIFY_PHASE_BUDGET },
				estimatedCostBudgetUsd: RESUME_VERIFY_ESTIMATED_BUDGET_USD,
				ttlSeconds: RESUME_VERIFY_TTL_SECONDS,
				contractSha256: manifestSha256,
				...who,
			},
			tx,
		);
		return { permitId: issued.id, permit: existing ? "replaced-expired" : "issued" };
	} catch (error) {
		if (
			(error as { code?: string; cause?: { code?: string } }).cause?.code === "23505" ||
			(error as { code?: string }).code === "23505"
		) {
			return { skipped: "already-permitted" };
		}
		throw error;
	}
}

/**
 * Apply one bounded batch from a frozen manifest: the selector is recomputed
 * and must match the manifest exactly (count, ordered ids, both digests);
 * each case is re-checked under a row lock, authorized by exactly one
 * verify-only permit bound to the manifest (issued, reused or replacing an
 * expired one) and sent through the singleton-keyed send. A send failure is
 * reported per case and leaves the permit standing, so repeating the same
 * manifest apply retries the send. Any drift refuses the whole batch — it
 * never broadens selection.
 */
export async function applyResumeForVerify(
	args: { manifest: ResumeManifest; manifestSha256: string; limit: number; sender: SentimentSender } & Partial<ControlActor>,
	executor: Executor = db,
): Promise<ResumeApplyResult> {
	const who = requireActor(args);
	if (!Number.isInteger(args.limit) || args.limit <= 0) throw new Error("limit must be a positive integer");
	if (!/^[0-9a-f]{64}$/i.test(args.manifestSha256)) throw new Error("manifest sha256 is required to bind the permits");
	const manifestSha256 = args.manifestSha256.toLowerCase();
	const current = await selectResumableForVerify(executor);
	const drift =
		current.count !== args.manifest.count
			? `count ${args.manifest.count} → ${current.count}`
			: current.digest !== args.manifest.digest
				? "eligible ids changed"
				: current.attemptDigest !== args.manifest.attemptDigest
					? "stored candidates changed"
					: null;
	if (drift) return { applied: [], skipped: [], failed: [], drift };
	const result: ResumeApplyResult = { applied: [], skipped: [], failed: [], drift: null };
	for (const item of current.eligible.slice(0, args.limit)) {
		const decision = await executor.transaction(async (tx) => {
			// Lock the case row and re-check the invariants inside the transaction that authorizes the permit.
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
			return permitForCase(tx, item, manifestSha256, who);
		});
		if ("skipped" in decision) {
			result.skipped.push({ analysisId: item.analysisId, reason: decision.skipped });
			continue;
		}
		try {
			const jobId = await sendSentimentJob(args.sender, item.promptRunId);
			result.applied.push({ analysisId: item.analysisId, permitId: decision.permitId, jobId, permit: decision.permit });
		} catch (error) {
			result.failed.push({
				analysisId: item.analysisId,
				permitId: decision.permitId,
				error: error instanceof Error ? error.name : typeof error,
			});
		}
	}
	return result;
}
