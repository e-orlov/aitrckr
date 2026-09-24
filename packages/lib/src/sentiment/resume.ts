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
	isResumeRepairBudget,
	isResumeVerifyBudget,
	issuePermit,
	PERMIT_LIVE_STATES,
	type PermitPurpose,
	type PhaseBudget,
	RESERVATION_ESTIMATES_USD,
	RESUME_REPAIR_PHASE_BUDGET,
	RESUME_VERIFY_PHASE_BUDGET,
	requireActor,
} from "./controls";
import { type SentimentSender, sendSentimentJob } from "./enqueue";
import { requestScopeKey, schemaShapeFingerprint, sentimentRequestProfile } from "./fingerprint";
import { analyzeAnswerRanges } from "./ranges";
import { RESOLUTION_POLICY, type ReviewReason, verifierResultSchemaFor } from "./resolution";
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
/** Planning estimate for the repair+verify pair (two reservations of 0.02); not a price, not a cap. */
export const RESUME_REPAIR_ESTIMATED_BUDGET_USD = 0.05;
export const RESUME_VERIFY_TTL_SECONDS = 2 * 60 * 60;
export const RESUME_DEFAULT_BATCH = 10;
export const RESUME_MANIFEST_VERSION = 2;

/** The parked review states a verify-only resume may address; each has its own evidence invariant. */
export const RESUME_REVIEW_REASONS = ["contract-defect", "call-limit", "verifier-rejected"] as const;
export type ResumeReviewReason = (typeof RESUME_REVIEW_REASONS)[number];

/** The permit each review reason resumes with: verify-only for a stored unverified candidate, the repair+verify pair for a verifier-rejected one. */
export function resumePermitFor(reviewReason: ResumeReviewReason): {
	purpose: PermitPurpose;
	budget: Readonly<PhaseBudget>;
	estimatedBudgetUsd: number;
	matches: (budget: PhaseBudget) => boolean;
} {
	return reviewReason === "verifier-rejected"
		? {
				purpose: "resume-repair",
				budget: RESUME_REPAIR_PHASE_BUDGET,
				estimatedBudgetUsd: RESUME_REPAIR_ESTIMATED_BUDGET_USD,
				matches: isResumeRepairBudget,
			}
		: {
				purpose: "resume-verify",
				budget: RESUME_VERIFY_PHASE_BUDGET,
				estimatedBudgetUsd: RESUME_VERIFY_ESTIMATED_BUDGET_USD,
				matches: isResumeVerifyBudget,
			};
}
/** The only automatic path that parks an unverified repair under `call-limit`: the fifth paid call was that repair. */
export const CALL_LIMIT_RESUMABLE_PATH: readonly string[] = Object.freeze([
	"classify",
	"verify",
	"repair",
	"verify",
	"repair",
]);

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
	| "run-unreadable"
	/** call-limit: the instance's answered attempts are not exactly the policy's paid-call budget. */
	| "wrong-call-count"
	/** call-limit: the instance's paid phases are not the exact parked-repair path. */
	| "wrong-path"
	/** call-limit: an attempt of the instance follows the parked repair. */
	| "later-attempt"
	/** verifier-rejected: the parked targets are not exclusively the verifier's (or are missing). */
	| "targets-not-verifier"
	/** verifier-rejected: the latest paid attempt is not the accepted verify that rejected the candidate. */
	| "no-rejecting-verify"
	/** verifier-rejected: this instance already spent its one permitted repair+verify pair; the rest is a human's decision. */
	| "pair-already-spent";

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
	/** The review state this manifest resumes; re-checked under the row lock at apply. */
	reviewReason: ResumeReviewReason;
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

/** Predicates 1–4 in SQL: the parked review case (of the requested reason) of a current-version, unverified analysis. */
async function candidateCases(executor: Executor, reviewReason: ResumeReviewReason) {
	return executor
		.select({
			analysisId: sentimentResolutionCases.analysisId,
			promptRunId: sentimentAnalyses.promptRunId,
			instanceId: sentimentResolutionCases.instanceId,
			inputHash: sentimentResolutionCases.inputHash,
			unresolvedTargets: sentimentResolutionCases.unresolvedTargets,
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
				eq(sentimentResolutionCases.reviewReason, reviewReason),
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

/**
 * The call-limit invariant: within the instance, exactly `maxPaidCalls` answered attempts whose paid phases are exactly
 * classify → verify → repair → verify → repair, all accepted, nothing after the parked repair, no unknown outcome
 * anywhere, and the parked repair carries a parseable candidate built for the frozen input. Anything else — a
 * deterministic-target parity path, a later attempt, a different count — is excluded with a typed reason.
 */
export function selectCallLimitCandidate(
	attempts: Attempt[],
	instanceId: string,
	inputHash: string,
	maxPaidCalls: number = RESOLUTION_POLICY.maxPaidCalls,
): { attempt: Attempt; candidate: SentimentClassificationResult } | { reason: ResumeExclusion } {
	if (attempts.some((a) => a.outcome === "sending" || a.outcome === "aborted"))
		return { reason: "sending-or-unknown-attempt" };
	const own = attempts.filter((a) => a.instanceId === instanceId).sort((a, b) => a.ordinal - b.ordinal);
	const answered = own.filter((a) => a.generationId !== null || a.actualCostUsd !== null);
	if (answered.length !== maxPaidCalls) return { reason: "wrong-call-count" };
	if (
		answered.length !== CALL_LIMIT_RESUMABLE_PATH.length ||
		answered.some((a, i) => a.phase !== CALL_LIMIT_RESUMABLE_PATH[i] || a.outcome !== "accepted")
	) {
		return { reason: "wrong-path" };
	}
	const latest = answered.at(-1);
	if (!latest) return { reason: "no-accepted-candidate" };
	if (own.at(-1)?.id !== latest.id) return { reason: "later-attempt" };
	if (latest.candidate === null || latest.inputHash !== inputHash) return { reason: "no-accepted-candidate" };
	const parsed = sentimentClassificationResultSchema.safeParse(latest.candidate);
	if (!parsed.success) return { reason: "candidate-malformed" };
	return { attempt: latest, candidate: parsed.data };
}

/**
 * The verifier-rejected invariant: the instance's latest paid attempt is the accepted verify whose reject verdict parked
 * the case; the candidate it judged is the latest accepted classify/repair of the instance, built for the frozen input;
 * the parked targets are exactly the verifier's (non-empty, all `source: "verifier"`); no unknown outcome anywhere. The
 * resumed workflow repairs those targets once and verifies once — the pair the automatic budget could not afford.
 */
export function selectVerifierRejectedCandidate(
	attempts: Attempt[],
	instanceId: string,
	inputHash: string,
	unresolvedTargets: unknown,
): { attempt: Attempt; candidate: SentimentClassificationResult } | { reason: ResumeExclusion } {
	if (attempts.some((a) => a.outcome === "sending" || a.outcome === "aborted"))
		return { reason: "sending-or-unknown-attempt" };
	const targets = Array.isArray(unresolvedTargets) ? (unresolvedTargets as { source?: unknown }[]) : [];
	if (targets.length === 0 || targets.some((t) => t?.source !== "verifier")) return { reason: "targets-not-verifier" };
	const own = attempts.filter((a) => a.instanceId === instanceId).sort((a, b) => a.ordinal - b.ordinal);
	// One permitted pair per instance: a rejection after a permit-bound attempt is final for the automatic path.
	if (own.some((a) => a.permitId !== null)) return { reason: "pair-already-spent" };
	const answered = own.filter((a) => a.generationId !== null || a.actualCostUsd !== null);
	const last = answered.at(-1);
	if (!last || last.phase !== "verify" || last.outcome !== "accepted" || own.at(-1)?.id !== last.id)
		return { reason: "no-rejecting-verify" };
	const latest = answered.filter((a) => a.phase === "classify" || a.phase === "repair").at(-1);
	if (!latest || latest.outcome !== "accepted" || latest.candidate === null || latest.inputHash !== inputHash)
		return { reason: "no-accepted-candidate" };
	const parsed = sentimentClassificationResultSchema.safeParse(latest.candidate);
	if (!parsed.success) return { reason: "candidate-malformed" };
	return { attempt: latest, candidate: parsed.data };
}

/** The stored-candidate invariant of one review reason; the contract-defect rule is unchanged. */
export function selectResumeCandidate(
	reviewReason: ResumeReviewReason,
	attempts: Attempt[],
	instanceId: string,
	inputHash: string,
	unresolvedTargets: unknown = null,
): ReturnType<typeof selectStoredCandidate> {
	if (reviewReason === "call-limit") return selectCallLimitCandidate(attempts, instanceId, inputHash);
	if (reviewReason === "verifier-rejected")
		return selectVerifierRejectedCandidate(attempts, instanceId, inputHash, unresolvedTargets);
	return selectStoredCandidate(attempts, instanceId, inputHash);
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
export async function selectResumableForVerify(
	executor: Executor = db,
	options: { reviewReason?: ResumeReviewReason } = {},
): Promise<ResumeManifest> {
	const reviewReason = options.reviewReason ?? "contract-defect";
	const eligible: ResumeEligible[] = [];
	const excluded: ResumeManifest["excluded"] = [];
	for (const row of await candidateCases(executor, reviewReason)) {
		const stored = selectResumeCandidate(
			reviewReason,
			await loadProviderAttempts(row.analysisId, executor),
			row.instanceId,
			row.inputHash,
			row.unresolvedTargets,
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
		reviewReason,
		classifierVersion: SENTIMENT_CLASSIFIER_VERSION,
		generatedAt: (await databaseNow(executor)).toISOString(),
		eligible,
		excluded,
		count: eligible.length,
		digest: digestOf(eligible.map((e) => e.analysisId)),
		attemptDigest: digestOf(eligible.map((e) => e.latestAttemptId)),
		projected:
			reviewReason === "verifier-rejected"
				? {
						verifyCalls: eligible.length,
						reservationEstimateUsd: (
							eligible.length *
							(RESERVATION_ESTIMATES_USD.repair + RESERVATION_ESTIMATES_USD.verify)
						).toFixed(6),
						hardLimits:
							"one repair and one verify phase per case; no classify; permit expiry; one live permit per instance",
					}
				: {
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
	reviewReason: ResumeReviewReason,
): Promise<PermitDecision> {
	const kind = resumePermitFor(reviewReason);
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
			existing.purpose === kind.purpose &&
			existing.inputHash === item.inputHash &&
			existing.contractSha256 === manifestSha256 &&
			kind.matches(budget);
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
				purpose: kind.purpose,
				promptRunId: item.promptRunId,
				analysisId: item.analysisId,
				instanceId: item.instanceId,
				inputHash: item.inputHash,
				classifierVersion: SENTIMENT_CLASSIFIER_VERSION,
				phaseBudget: { ...kind.budget },
				estimatedCostBudgetUsd: kind.estimatedBudgetUsd,
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
	args: {
		manifest: ResumeManifest;
		manifestSha256: string;
		limit: number;
		sender: SentimentSender;
	} & Partial<ControlActor>,
	executor: Executor = db,
): Promise<ResumeApplyResult> {
	const who = requireActor(args);
	if (!Number.isInteger(args.limit) || args.limit <= 0) throw new Error("limit must be a positive integer");
	if (!/^[0-9a-f]{64}$/i.test(args.manifestSha256)) throw new Error("manifest sha256 is required to bind the permits");
	const manifestSha256 = args.manifestSha256.toLowerCase();
	const reviewReason = args.manifest.reviewReason;
	if (!(RESUME_REVIEW_REASONS as readonly string[]).includes(reviewReason))
		throw new Error(`manifest reviewReason must be one of ${RESUME_REVIEW_REASONS.join(", ")}`);
	const current = await selectResumableForVerify(executor, { reviewReason });
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
					reviewReason: sentimentResolutionCases.reviewReason,
					instanceId: sentimentResolutionCases.instanceId,
					inputHash: sentimentResolutionCases.inputHash,
					unresolvedTargets: sentimentResolutionCases.unresolvedTargets,
				})
				.from(sentimentResolutionCases)
				.where(eq(sentimentResolutionCases.analysisId, item.analysisId))
				.for("update");
			if (
				locked?.status !== "awaiting_review" ||
				(locked.reviewReason as ReviewReason | null) !== reviewReason ||
				locked.instanceId !== item.instanceId ||
				locked.inputHash !== item.inputHash
			) {
				return { skipped: "case-changed" as const };
			}
			const stored = selectResumeCandidate(
				reviewReason,
				await loadProviderAttempts(item.analysisId, tx),
				item.instanceId,
				item.inputHash,
				locked.unresolvedTargets,
			);
			if ("reason" in stored || stored.attempt.id !== item.latestAttemptId) return { skipped: "case-changed" as const };
			return permitForCase(tx, item, manifestSha256, who, reviewReason);
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
