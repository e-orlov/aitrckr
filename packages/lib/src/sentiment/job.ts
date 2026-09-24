import { randomUUID } from "node:crypto";
import type { z } from "zod";
import type { SentimentAnalysis } from "../db/schema";
import { toStructuredOutputJsonSchema } from "../providers/json-schema";
import { prepareStructuredOutputSchema, StructuredOutputSchemaError } from "../providers/schema-contract";
import type { Provider, StructuredResearchRequestSummary, StructuredResearchUsage } from "../providers/types";
import { StructuredResearchRequestError, StructuredResearchResponseError } from "../providers/types";
import { type EvidenceAnchor, segmentAnswer } from "./anchors";
import {
	acquireProbe,
	BREAKER_OPENING_CLASSES,
	classifyDispatchFailure,
	type DispatchFailureClass,
	databaseNow,
	decideBreaker,
	openBreaker,
	type ProbeOutcome,
	readBreaker,
	settleProbe,
} from "./breaker";
import {
	assessCandidate,
	type CandidateAssessment,
	classifySentiment,
	countFilteredClaimCodes,
	SENTIMENT_MAX_OUTPUT_TOKENS,
	type SentimentClassification,
	type SentimentClassifierDeps,
	sentimentInputHash,
	type UnresolvedTarget,
} from "./classifier";
import {
	consumePermitPhase,
	type DispatchState,
	findLivePermit,
	isHeld,
	isPermitEffective,
	loadPermit,
	type PermitPhase,
	type PermitPurpose,
	permitPurposeAllowsPhase,
	permitSettlementFor,
	RESERVATION_ESTIMATES_USD,
	readDispatchState,
	settlePermitReservation,
} from "./controls";
import { type DetectableEntity, detectEntityMentions } from "./detector";
import { diagnostic, type SentimentDiagnostic, safeGenerationId } from "./diagnostics";
import { type SentimentSender, sendSentimentJob } from "./enqueue";
import {
	ClaimLostError,
	type SafeSentimentError,
	SentimentJobError,
	sanitizeSentimentError,
	storedErrorMessage,
} from "./errors";
import { type PaidResponseEnvelope, SentimentValidationError } from "./errors-validation";
import { requestScopeKey, schemaShapeFingerprint, sentimentRequestProfile } from "./fingerprint";
import { resolveSentimentProvider } from "./provider";
import { type AnalyzableText, analyzeAnswerRanges } from "./ranges";
import {
	backoffMs,
	buildRepairPrompt,
	buildVerifierPrompt,
	dropVerifierRejectedAspects,
	mergeRepairedEntities,
	RESOLUTION_POLICY,
	type ResolutionPolicy,
	type ReviewReason,
	repairResultSchemaFor,
	SENTIMENT_VERIFIER_VERSION,
	type VerifierResult,
	verifierIssuesToTargets,
	verifierResultSchemaFor,
} from "./resolution";
import {
	type AnalysisClaim,
	candidatesFromMentions,
	chargeResolutionCase,
	claimAnalysis,
	detectionResultFor,
	type Executor,
	ensureAnalysis,
	ensureResolutionCase,
	finishProviderAttempt,
	isAnalysisCurrent,
	listDueRetryWaitCases,
	listUnresolvedCases,
	type loadAnalysisState,
	loadAttemptDispatch,
	loadDetectableEntities,
	loadDetection,
	loadMentions,
	loadProviderAttempts,
	loadResolutionCase,
	loadRunForSentiment,
	markAnalysis,
	openProviderAttempt,
	persistClassification,
	persistDetection,
	type ResolutionOwner,
	recordSentimentUsageEvent,
	runInTransaction,
	type StoredMention,
	type StoredResolutionCase,
	type StoredRunForSentiment,
	updateResolutionCase,
} from "./store";
import {
	isTaxonomyDrift,
	SENTIMENT_CLASSIFIER_VERSION,
	SENTIMENT_MODEL,
	SENTIMENT_PROVIDER_ID,
	SENTIMENT_TAXONOMY_VERSION,
	type SentimentCandidate,
	type SentimentClassificationResult,
	type SentimentJobData,
	sentimentClassificationResultSchema,
	sentimentJobSchema,
	sentimentProviderResultSchemaFor,
	toClassificationResult,
} from "./types";

export type SentimentJobOutcome =
	| {
			/** The verified result is persisted: the only successful final state (`completed_verified`). */
			status: "classified";
			entities: number;
			/** Entity keys the classification covered: the brand key or competitor ids, never names or text. */
			entityKeys: string[];
			/** Usage, request summary and generation id of the initial classification call. */
			usage?: StructuredResearchUsage;
			request?: StructuredResearchRequestSummary;
			generationId: string | null;
			/** Aspect claims dropped as unsupported by the answer; the analysis is complete without them. */
			filteredClaimCount: number;
			filteredClaimCodes: Record<string, number>;
			verified: true;
			verifierVersion: string;
			/** Paid provider answers this analysis consumed automatically, all phases, all job runs. */
			paidCalls: number;
			costUsd: number;
			repairs: number;
			verifierRejections: number;
	  }
	| { status: "already-completed" }
	| { status: "claimed-elsewhere"; analysisStatus: string }
	/** The attempt ran but a later attempt took the row over; nothing of this attempt was written. */
	| { status: "claim-lost"; generation: number }
	| { status: "no-mentions" }
	| { status: "skipped"; reason: string }
	/**
	 * The automatic policy is exhausted or the answer's contract is broken: the
	 * run is an open operator work item (`awaiting_review`), never a closed
	 * failure. No call is made while it waits.
	 */
	| { status: "awaiting-review"; reason: ReviewReason; paidCalls: number; costUsd: number; unresolved: number }
	/**
	 * Dispatch is held (or the request's scope is blocked by the breaker) and no permit authorizes this call:
	 * the work stays durable and unclaimed or parked; no request left, no attempt row was written.
	 */
	| {
			status: "held";
			reason: "dispatch-held" | "permit-unavailable" | "breaker-open" | "probe-in-progress";
			nextAttemptAt: Date | null;
	  }
	/** The case is not due yet by the database clock; the maintenance inventory re-sends it when it is. */
	| { status: "deferred"; nextAttemptAt: Date }
	/** An unpaid transient refusal parked the case for the maintenance inventory; the queue does not retry it. */
	| { status: "retry-wait"; nextAttemptAt: Date; consecutiveFailures: number }
	/**
	 * A provider request whose outcome is unknown (crash mid-call, timeout,
	 * abort, connection loss, ambiguous 5xx, or a paid answer that could not be
	 * settled): no automatic call until an operator reconciles it.
	 */
	| { status: "awaiting-reconciliation"; attemptOrdinal: number }
	/** Retained for tooling that reads historical outcomes; the v5 workflow never produces it. */
	| {
			status: "terminal-validation-failure";
			code: string;
			requestSent: boolean;
			diagnostic: SentimentDiagnostic | null;
			envelope: PaidResponseEnvelope | null;
	  };

export interface SentimentJobDeps extends SentimentClassifierDeps {
	loadRun?: typeof loadRunForSentiment;
	loadEntities?: typeof loadDetectableEntities;
	loadDetection?: typeof loadDetection;
	loadMentions?: typeof loadMentions;
	loadAnalysisState?: typeof loadAnalysisState;
	persistDetection?: typeof persistDetection;
	ensureAnalysis?: typeof ensureAnalysis;
	claimAnalysis?: typeof claimAnalysis;
	markAnalysis?: typeof markAnalysis;
	classify?: typeof classifySentiment;
	persist?: typeof persistClassification;
	recordUsage?: typeof recordSentimentUsageEvent;
	ensureResolutionCase?: typeof ensureResolutionCase;
	updateResolutionCase?: typeof updateResolutionCase;
	chargeResolutionCase?: typeof chargeResolutionCase;
	openProviderAttempt?: typeof openProviderAttempt;
	finishProviderAttempt?: typeof finishProviderAttempt;
	loadProviderAttempts?: typeof loadProviderAttempts;
	loadResolutionCase?: typeof loadResolutionCase;
	/**
	 * Queue an immediate re-invocation of this run's job (the worker passes the
	 * singleton-keyed send). Fired by a worker that lost its claim after its paid
	 * answer's evidence was committed. An optimization only: the resolved job id
	 * proves a successor exists, `null` proves nothing but that the queue already
	 * holds a queued-or-active job for the run — the durable guarantee is
	 * `enqueueResumableSentimentRuns` on the maintenance schedule.
	 */
	enqueueResume?: (promptRunId: string) => Promise<string | null>;
	/** Runs the settlement of one paid answer (ledger row, usage event, case budget) as one transaction. */
	transaction?: <T>(fn: (tx: Executor) => Promise<T>) => Promise<T>;
	/** Overrides of the automatic budget and backoff (tests); production uses `RESOLUTION_POLICY`. */
	resolutionPolicy?: Partial<ResolutionPolicy>;
	sleep?: (ms: number) => Promise<void>;
	/** Dispatch safety controls (hold, permits, breaker); tests inject fakes, production uses the store. */
	dispatch?: Partial<DispatchDeps>;
}

export interface DispatchDeps {
	readDispatchState: () => Promise<DispatchState>;
	databaseNow: () => Promise<Date>;
	findLivePermit: typeof findLivePermit;
	consumePermitPhase: typeof consumePermitPhase;
	settlePermitReservation: typeof settlePermitReservation;
	readBreaker: typeof readBreaker;
	acquireProbe: typeof acquireProbe;
	openBreaker: typeof openBreaker;
	settleProbe: typeof settleProbe;
	loadAttemptDispatch: typeof loadAttemptDispatch;
	loadPermit: typeof loadPermit;
}

const PRODUCTION_DISPATCH: DispatchDeps = {
	readDispatchState: () => readDispatchState(),
	databaseNow: () => databaseNow(),
	findLivePermit,
	consumePermitPhase,
	settlePermitReservation,
	readBreaker,
	acquireProbe,
	openBreaker,
	settleProbe,
	loadAttemptDispatch,
	loadPermit,
};

const dispatchDeps = (deps: SentimentJobDeps): DispatchDeps => ({ ...PRODUCTION_DISPATCH, ...deps.dispatch });

/**
 * What one request is authorized to be, decided in the dispatch transaction
 * and handed explicitly to the guarded provider: the `sending` attempt, the
 * permit that paid for it under a held dispatch (or null when open), the
 * request-profile scope and schema shape the document must match, and the
 * breaker probe lease when this request is the probe.
 */
export interface DispatchContext {
	attemptId: string;
	permitId: string | null;
	scopeKey: string;
	schemaFp: string;
	phase: PaidPhase;
	webSearch: boolean;
	probeGeneration: number | null;
	reservedEstimateUsd: number | null;
}

/** Thrown by the guarded provider when a request reaches it without matching authorization; nothing was sent. */
export class SentimentDispatchHeldError extends Error {
	readonly requestSent = false as const;
	constructor(
		readonly code:
			| "no-dispatch-context"
			| "fingerprint-mismatch"
			| "held-without-permit"
			| "attempt-not-sending"
			| "attempt-evidence-mismatch"
			| "permit-ineligible"
			| "breaker-open"
			| "probe-lost",
		/** For `breaker-open`: when the scope may be probed again, so the case parks until then. */
		readonly until: Date | null = null,
	) {
		super(`dispatch refused at the provider boundary: ${code}`);
		this.name = "SentimentDispatchHeldError";
	}
}

export interface SentimentJobOptions {
	/** pg-boss job signal: aborted on graceful shutdown or expiry; forwarded to the provider request. */
	signal?: AbortSignal;
}

/**
 * The current-version mention rows for the run. A run without a
 * current-version detection receipt is scanned here, deterministically and
 * before any call (repair path); a run with a receipt is never re-scanned by
 * the job — roster changes reach history through the mention backfill.
 */
async function resolveMentions(
	run: StoredRunForSentiment,
	entities: DetectableEntity[],
	deps: SentimentJobDeps,
): Promise<StoredMention[]> {
	const receipt = await (deps.loadDetection ?? loadDetection)(run.id);
	if (receipt) return receipt.status === "mentions" ? (deps.loadMentions ?? loadMentions)(run.id) : [];
	const detected = run.answerBody === null ? [] : detectEntityMentions(run.answerBody, entities);
	return (deps.persistDetection ?? persistDetection)({
		promptRunId: run.id,
		brandId: run.brandId,
		result: detectionResultFor(run.answerBody, detected),
	});
}

/**
 * Routing write of an attempt that could not finish: the analysis leaves the
 * `processing` claim parked as `pending_resolution` with the safe code. Never
 * a product outcome and never `failed`; the resolution case carries the
 * workflow, and only that workflow or adjudication may move the row again.
 */
function park(claim: AnalysisClaim, safe: SafeSentimentError | null, deps: SentimentJobDeps): Promise<boolean> {
	return (deps.markAnalysis ?? markAnalysis)(claim, {
		status: "pending_resolution",
		errorCode: safe?.code ?? null,
		errorMessage: safe ? storedErrorMessage(safe) : null,
		inputHash: null,
	});
}

const MAX_INLINE_WAIT_MS = 30_000;
/** DB-only retries of settling a paid answer before the attempt is left for reconciliation. */
const SETTLE_ATTEMPTS = 3;
const SETTLE_RETRY_MS = 250;

/**
 * The closed allow-list of refusals the workflow may repeat on its own: the
 * provider's own structured error envelope, with exactly this status and
 * canonical type, carrying no generation id, usage, cost, content or partial
 * output. Nothing is inferred from an HTTP class or from a missing generation
 * id alone.
 */
const AUTOMATIC_RETRY_ALLOW_LIST: ReadonlySet<string> = new Set(["429:rate_limit_exceeded", "503:provider_overloaded"]);

/** Deterministic refusals of the request itself (request, authentication, permission, configuration): the operator's, never repeated. */
const REVIEW_STATUSES: ReadonlySet<number> = new Set([400, 401, 403, 404, 409, 422]);
/** Refusals of the account rather than the request (402 insufficient credits): transient once the account is topped up. */
const TRANSIENT_STATUSES: ReadonlySet<number> = new Set([402]);

type FailureRoute = { route: "retry"; retryAfterMs: number | null } | { route: "review" } | { route: "reconcile" };

/**
 * Where a failed request goes. `retry`: only an allow-listed typed refusal,
 * or a request that demonstrably never left for a transient local reason.
 * `review`: a deterministic refusal or a local contract/configuration defect —
 * repeating it cannot help. `reconcile`: everything whose billing outcome is
 * unknown — timeouts, aborts, connection loss, status-less errors, HTTP 408,
 * ambiguous or untyped 5xx, unknown types, and any refusal that carried
 * output. No exactly-once or non-billing claim is made for those.
 */
function routeFailure(error: unknown, safe: SafeSentimentError): FailureRoute {
	if (!safe.requestSent) return { route: "review" };
	if (!(error instanceof StructuredResearchRequestError)) return { route: "reconcile" };
	if (!error.structured || error.carriesOutput) return { route: "reconcile" };
	if (AUTOMATIC_RETRY_ALLOW_LIST.has(`${error.httpStatus}:${error.errorType}`)) {
		return { route: "retry", retryAfterMs: error.retryAfterMs };
	}
	if (TRANSIENT_STATUSES.has(error.httpStatus)) return { route: "retry", retryAfterMs: error.retryAfterMs };
	if (REVIEW_STATUSES.has(error.httpStatus)) return { route: "review" };
	return { route: "reconcile" };
}

/** Thrown inside the workflow to leave the automatic path; never escapes `resolve`. */
class HandOver extends Error {
	constructor(
		readonly reason: ReviewReason,
		readonly attemptOrdinal = 0,
		/** The safe failure that caused the hand-over, kept on the parked analysis row for the operator. */
		readonly safe: SafeSentimentError | null = null,
	) {
		super(`resolution handed over: ${reason}`);
		this.name = "HandOver";
	}
}

interface Workflow {
	run: StoredRunForSentiment & { answerBody: string };
	claim: ResolutionOwner;
	mentions: StoredMention[];
	candidates: SentimentCandidate[];
	anchors: EvidenceAnchor[];
	analysis: AnalyzableText;
	inputHash: string;
	provider: Provider;
	policy: ResolutionPolicy;
	deps: SentimentJobDeps;
	options: SentimentJobOptions;
	kase: StoredResolutionCase;
	paidCalls: number;
	costUsd: number;
	repairs: number;
	verifierRejections: number;
	consecutiveFailures: number;
	initial: { usage?: StructuredResearchUsage; request?: StructuredResearchRequestSummary; generationId: string | null };
	/** Set for exactly the duration of one authorized request; read by the guarded provider. */
	dispatch: DispatchContext | null;
	controls: DispatchDeps;
	/** The purpose of the permit that let a parked case resume, when it did: a resume permit authorizes verification only. */
	resumePermitPurpose: PermitPurpose | null;
	/** Parked verifier targets a repair-resume permit authorizes the workflow to repair before its one verification. */
	resumeTargets: UnresolvedTarget[];
}

type PaidPhase = PermitPhase;

interface PaidAnswer<T> {
	value: T;
	generationId: string | null;
	costUsd: number | null;
	/** The normalized candidate this answer produced, kept on its attempt row; verdicts carry none. */
	candidate?: SentimentClassificationResult | null;
}

/** Run a DB-only step again from the answer already in hand; when that is exhausted the case goes to reconciliation. */
async function retryDbOnly<T>(w: Workflow, attemptOrdinal: number, step: () => Promise<T>): Promise<T> {
	for (let round = 1; ; round++) {
		try {
			return await step();
		} catch (error) {
			if (error instanceof ClaimLostError) throw error;
			const pgCode = (error as { code?: unknown }).code;
			console.warn(
				`[sentiment] settlement step ${round}/${SETTLE_ATTEMPTS} failed on analysis ${w.claim.analysisId}: ${error instanceof Error ? error.name : typeof error}${typeof pgCode === "string" ? ` ${pgCode}` : ""}`,
			);
			if (round >= SETTLE_ATTEMPTS) throw new HandOver("unknown-provider-outcome", attemptOrdinal);
			await (w.deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms))))(SETTLE_RETRY_MS);
		}
	}
}

/**
 * One paid answer becomes durable in two steps with different owners. First
 * the attempt's own evidence — outcome, generation id, charged cost,
 * normalized candidate and the usage event — commits in one transaction keyed
 * on the immutable attempt id and never fenced on the claim, exactly once: a
 * worker that lost its lease while the request was out still leaves its
 * answer behind for reconciliation. Only then is the case budget recomputed
 * from the ledger under the claim and instance fence; losing that fence ends
 * the attempt as `claim-lost` without undoing the evidence. Either step is
 * retried DB-only; a paid answer is never bought again because it could not
 * be recorded.
 */
async function settlePaidAnswer(
	w: Workflow,
	attempt: { id: string; ordinal: number },
	dispatch: DispatchContext,
	args: {
		outcome: "accepted" | "rejected";
		generationId: string | null;
		costUsd: number | null;
		candidate: SentimentClassificationResult | null;
		succeeded: boolean;
	},
	attribution: { provider: string; model: string | null },
): Promise<void> {
	const usage = { organizationId: w.run.organizationId, brandId: w.run.brandId, promptId: w.run.promptId };
	const recordUsage = w.deps.recordUsage ?? recordSentimentUsageEvent;
	const finish = w.deps.finishProviderAttempt ?? finishProviderAttempt;
	const charge = w.deps.chargeResolutionCase ?? chargeResolutionCase;
	const transaction = w.deps.transaction ?? runInTransaction;
	await retryDbOnly(w, attempt.ordinal, () =>
		transaction(async (tx) => {
			const settled = await finish(
				attempt.id,
				{
					outcome: args.outcome,
					generationId: args.generationId,
					actualCostUsd: args.costUsd,
					candidate: args.candidate,
				},
				tx,
			);
			// The usage event is written with the first settlement only, so a replay never attributes twice.
			if (settled === "settled") {
				await recordUsage({ ...usage, ...attribution, succeeded: args.succeeded, actualCostUsd: args.costUsd }, tx);
				await settleDispatch(w, dispatch, { paid: true, actualCostUsd: args.costUsd, probe: "accepted" }, tx);
			}
		}),
	);
	let charged: Awaited<ReturnType<typeof charge>>;
	try {
		charged = await retryDbOnly(w, attempt.ordinal, () => charge(w.claim.analysisId, w.claim));
	} catch (error) {
		// The claim is gone but the evidence is durable: wake the run so its current owner can resume from it.
		if (error instanceof ClaimLostError) await wakeResume(w);
		throw error;
	}
	w.paidCalls = charged.automatedProviderCalls;
	w.costUsd = charged.totalActualCostUsd;
}

async function wakeResume(w: Workflow): Promise<void> {
	if (!w.deps.enqueueResume) return;
	try {
		const jobId = await w.deps.enqueueResume(w.run.id);
		if (jobId === null) {
			// Not a success: the exclusive queue already holds a queued-or-active job for this run, which may finish
			// without ever seeing the evidence just committed. The maintenance inventory rediscovers the case.
			console.warn(
				`sentiment resume wake-up for run ${w.run.id}: no new job created (one is queued or active); the maintenance inventory rediscovers the case`,
			);
		} else {
			console.log(`sentiment resume wake-up for run ${w.run.id}: queued job ${jobId}`);
		}
	} catch (error) {
		console.error("sentiment resume wake-up failed:", error instanceof Error ? error.name : typeof error);
	}
}

/** Leaves the automatic path with a parked, non-failing outcome; never escapes `resolve`. */
class Parked extends Error {
	constructor(
		readonly outcome: SentimentJobOutcome,
		readonly nextAttemptAt: Date | null,
		readonly safe: SafeSentimentError | null,
	) {
		super(`resolution parked: ${outcome.status}`);
		this.name = "Parked";
	}
}

/** Holds a case for a dispatch control (hold, permit, breaker): `retry_wait` at `until`, no attempt, no request. */
function heldOutcome(
	reason: Extract<SentimentJobOutcome, { status: "held" }>["reason"],
	until: Date | null,
	code: string,
): Parked {
	const safe: SafeSentimentError = {
		code,
		kind: "hold",
		provider: SENTIMENT_PROVIDER_ID,
		model: SENTIMENT_MODEL,
		httpStatus: null,
		errorName: "DispatchControl",
		requestSent: false,
		envelope: null,
		diagnostic: null,
	};
	return new Parked({ status: "held", reason, nextAttemptAt: until }, until, safe);
}

/**
 * The provider every request of a lifecycle goes through — the linearization
 * point of dispatch authorization. Immediately before the adapter's network
 * call it re-reads, from the database, everything T1 decided on: the attempt
 * still `sending` with exactly the recorded permit, scope and shape (which must
 * also equal what is about to be sent); the hold (held ⇒ a permit is required);
 * the permit itself — bound to this analysis, instance and input, in a live
 * state, unexpired by the database clock and of a purpose that authorizes this
 * phase; and the breaker of the exact scope — absent or closed, or half-open
 * with this attempt owning the still-live probe lease. A breaker opened by a
 * concurrent transaction after T1 is therefore refused here with no request;
 * only a request already past this read is the documented in-flight residual.
 * Any mismatch is refused without a request and surfaced as a gate breach.
 */
function guardProvider(provider: Provider, w: Workflow): Provider {
	const research = provider.runStructuredResearch?.bind(provider);
	if (!research) return provider;
	return {
		...provider,
		async runStructuredResearch<T>(options: StructuredResearchOptions<T>) {
			const context = w.dispatch;
			if (!context) throw new SentimentDispatchHeldError("no-dispatch-context");
			const document = prepareStructuredOutputSchema(options.schema as z.ZodType);
			const schemaFp = schemaShapeFingerprint(document);
			const scopeKey = requestScopeKey(sentimentRequestProfile({ webSearch: options.webSearch ?? true, schemaFp }));
			if (schemaFp !== context.schemaFp || scopeKey !== context.scopeKey) {
				throw new SentimentDispatchHeldError("fingerprint-mismatch");
			}
			await reauthorizeAttempt(w, context, scopeKey, schemaFp);
			await reauthorizePermit(w, context);
			await reauthorizeBreaker(w, context, scopeKey);
			return research(options);
		},
	};
}

/** The durable attempt must still be `sending` and carry exactly the permit, scope and shape T1 recorded. */
async function reauthorizeAttempt(w: Workflow, context: DispatchContext, scopeKey: string, schemaFp: string) {
	const attempt = await w.controls.loadAttemptDispatch(context.attemptId);
	if (attempt?.outcome !== "sending") throw new SentimentDispatchHeldError("attempt-not-sending");
	const matches =
		(attempt.permitId ?? null) === context.permitId && attempt.scopeKey === scopeKey && attempt.schemaFp === schemaFp;
	if (!matches) throw new SentimentDispatchHeldError("attempt-evidence-mismatch");
}

/** A held dispatch needs a permit; a permit must still be bound, live, unexpired by the database clock and fit for the phase. */
async function reauthorizePermit(w: Workflow, context: DispatchContext) {
	const held = isHeld(await w.controls.readDispatchState());
	if (held && context.permitId === null) throw new SentimentDispatchHeldError("held-without-permit");
	if (context.permitId === null) return;
	const permit = await w.controls.loadPermit(context.permitId);
	const now = await w.controls.databaseNow();
	const eligible =
		permit !== null &&
		permit.analysisId === w.claim.analysisId &&
		permit.instanceId === w.claim.instanceId &&
		permit.inputHash === w.inputHash &&
		isPermitEffective(permit, now) &&
		permitPurposeAllowsPhase(permit.purpose, context.phase);
	if (!eligible) throw new SentimentDispatchHeldError("permit-ineligible");
}

/** The scope must be absent or closed, or half-open with this attempt owning the still-live probe lease. */
async function reauthorizeBreaker(w: Workflow, context: DispatchContext, scopeKey: string) {
	const breaker = await w.controls.readBreaker(scopeKey);
	if (!breaker || breaker.state === "closed") return;
	if (breaker.state === "open") throw new SentimentDispatchHeldError("breaker-open", breaker.openUntil);
	const now = await w.controls.databaseNow();
	const ownsLiveProbe =
		context.probeGeneration !== null &&
		breaker.probeAttemptId === context.attemptId &&
		breaker.probeGeneration === context.probeGeneration &&
		breaker.probeLeaseUntil !== null &&
		breaker.probeLeaseUntil.getTime() > now.getTime();
	if (!ownsLiveProbe) throw new SentimentDispatchHeldError("probe-lost", breaker.probeLeaseUntil);
}

type StructuredResearchOptions<T> = Parameters<NonNullable<Provider["runStructuredResearch"]>>[0] & {
	schema: z.ZodType<T>;
};

/**
 * The dispatch transaction T1 and its preconditions, run before every provider
 * request (Amendment C):
 *  1. the local strict-schema guard (a refusal opens the breaker, writes no attempt);
 *  2. the dispatch hold is read;
 *  3. the breaker scope of the exact request profile is read;
 *  4. in one transaction: the half-open probe lease when the scope is probing,
 *     the permit phase consumption when dispatch is held, and the `sending`
 *     attempt row carrying permit, scope, shape and reservation evidence.
 * Anything refused leaves no row behind and parks the case without a request.
 */
async function authorizeDispatch(
	w: Workflow,
	phase: PaidPhase,
	request: { schema: z.ZodType; webSearch: boolean },
	options: { requirePermit?: boolean } = {},
): Promise<DispatchContext & { ordinal: number }> {
	let document: Record<string, unknown>;
	try {
		document = prepareStructuredOutputSchema(request.schema);
	} catch (error) {
		if (!(error instanceof StructuredOutputSchemaError)) throw error;
		const schemaFp = schemaShapeFingerprint(toStructuredOutputJsonSchema(request.schema));
		const profile = sentimentRequestProfile({ webSearch: request.webSearch, schemaFp });
		await recordBreakerOpen(w, {
			scopeKey: requestScopeKey(profile),
			profile,
			schemaFp,
			failureClass: "local-contract",
			phase,
			attemptId: null,
			httpStatus: null,
			errorType: null,
			rule: error.violations[0]?.rule ?? null,
		});
		throw new HandOver("contract-defect", 0, sanitizeSentimentError(error));
	}
	const schemaFp = schemaShapeFingerprint(document);
	const profile = sentimentRequestProfile({ webSearch: request.webSearch, schemaFp });
	const scopeKey = requestScopeKey(profile);
	const held = isHeld(await w.controls.readDispatchState());
	const now = await w.controls.databaseNow();
	const decision = decideBreaker(await w.controls.readBreaker(scopeKey), now);
	if (!decision.allow) throw heldOutcome(decision.reason, decision.until, decision.reason);
	const attemptId = randomUUID();
	const reserve = RESERVATION_ESTIMATES_USD[phase];
	const transaction = w.deps.transaction ?? runInTransaction;
	const open = w.deps.openProviderAttempt ?? openProviderAttempt;
	return transaction(async (tx) => {
		let probeGeneration: number | null = null;
		if (decision.probe) {
			const lease = await w.controls.acquireProbe(tx, scopeKey, attemptId);
			if (!lease) throw heldOutcome("probe-in-progress", null, "probe-in-progress");
			probeGeneration = lease.generation;
		}
		let permitId: string | null = null;
		let reservedEstimateUsd: number | null = null;
		// A call beyond the automatic budget is only ever authorized by consuming a permit phase, open or held.
		if (held || options.requirePermit) {
			const consumed = await w.controls.consumePermitPhase(tx, {
				analysisId: w.claim.analysisId,
				instanceId: w.claim.instanceId,
				inputHash: w.inputHash,
				phase,
				reserveUsd: reserve,
			});
			if (!consumed.consumed) throw heldOutcome("permit-unavailable", null, `permit-${consumed.reason}`);
			permitId = consumed.permitId;
			reservedEstimateUsd = consumed.reservedEstimateUsd;
		}
		const attempt = await open(
			{
				id: attemptId,
				analysisId: w.claim.analysisId,
				phase,
				inputHash: w.inputHash,
				claim: w.claim,
				permitId,
				scopeKey,
				schemaFp,
				reservedEstimateUsd,
			},
			tx,
		);
		return {
			attemptId: attempt.id,
			ordinal: attempt.ordinal,
			permitId,
			scopeKey,
			schemaFp,
			phase,
			webSearch: request.webSearch,
			probeGeneration,
			reservedEstimateUsd,
		};
	});
}

/** Open the breaker for a deterministic refusal in its own transaction (never inside a rolled-back T1). */
async function recordBreakerOpen(w: Workflow, evidence: Parameters<typeof openBreaker>[1]): Promise<void> {
	const transaction = w.deps.transaction ?? runInTransaction;
	await transaction((tx) => w.controls.openBreaker(tx, evidence));
}

/**
 * Settle the dispatch side of an attempt together with its ledger row: the
 * permit reservation per the settlement contract (released for a known-unpaid
 * or priced answer, kept counted for a paid answer of unknown cost), and the
 * probe lease closed, re-opened, released or left standing. An unknown outcome
 * settles nothing — the reservation and the lease stand until the attempt is
 * reconciled or the lease expires.
 */
async function settleDispatch(
	w: Workflow,
	dispatch: DispatchContext,
	result: { paid: boolean; actualCostUsd: number | null; probe: ProbeOutcome },
	tx: Executor,
): Promise<void> {
	if (dispatch.permitId && dispatch.reservedEstimateUsd !== null) {
		await w.controls.settlePermitReservation(tx, {
			permitId: dispatch.permitId,
			reservedEstimateUsd: dispatch.reservedEstimateUsd,
			settlement: permitSettlementFor(result.paid, result.actualCostUsd),
		});
	}
	if (dispatch.probeGeneration !== null) {
		await w.controls.settleProbe(tx, {
			scopeKey: dispatch.scopeKey,
			attemptId: dispatch.attemptId,
			generation: dispatch.probeGeneration,
			outcome: result.probe,
		});
	}
}

/** A boundary refusal parks the case: a breaker refusal until the scope may probe again, anything else as a gate breach. */
function boundaryRefusal(w: Workflow, phase: PaidPhase, error: SentimentDispatchHeldError): Parked {
	if (error.code === "breaker-open") return heldOutcome("breaker-open", error.until, error.code);
	if (error.code === "probe-lost") return heldOutcome("probe-in-progress", error.until, error.code);
	console.error(`[sentiment] gate-breach on analysis ${w.claim.analysisId} (${phase}): ${error.code}`);
	return heldOutcome("dispatch-held", null, `gate-breach:${error.code}`);
}

/**
 * Decide what one failed request becomes. Returns the control-flow error the
 * caller throws: a paid-but-unshapeable answer is settled as rejected and
 * handed over; a guard refusal closes the attempt as aborted (a defect of an
 * earlier gate); a deterministic refusal of the request shape opens the
 * breaker; then the existing routing applies — retry parks for the inventory
 * (or exhausts to review), review hands over, anything unknown goes to
 * reconciliation with the reservation and lease left standing.
 */
async function requestFailure(
	w: Workflow,
	phase: PaidPhase,
	dispatch: DispatchContext,
	attempt: { id: string; ordinal: number },
	error: unknown,
): Promise<Error> {
	const safe = sanitizeSentimentError(error);
	const finish = w.deps.finishProviderAttempt ?? finishProviderAttempt;
	const transaction = w.deps.transaction ?? runInTransaction;
	const closeUnpaid = (outcome: "provider-error" | "aborted", probe: ProbeOutcome) =>
		transaction(async (tx) => {
			await finish(attempt.id, { outcome }, tx);
			await settleDispatch(w, dispatch, { paid: false, actualCostUsd: null, probe }, tx);
		});
	if (error instanceof SentimentDispatchHeldError) {
		// Nothing left: the attempt is a known-unpaid abort, its reservation is released and its probe lease freed.
		await closeUnpaid("aborted", "released");
		return boundaryRefusal(w, phase, error);
	}
	if (safe.requestSent && safe.envelope?.generationId) {
		// The provider answered and charged, but the answer could not be shaped: a paid, unusable attempt.
		await settlePaidAnswer(
			w,
			attempt,
			dispatch,
			{
				outcome: "rejected",
				generationId: safe.envelope.generationId,
				costUsd: safe.envelope.usage?.costUsd ?? null,
				candidate: null,
				succeeded: false,
			},
			{ provider: safe.provider, model: safe.model },
		);
		return new HandOver("contract-defect");
	}
	const failureClass = classifyDispatchFailure(error, safe);
	if (BREAKER_OPENING_CLASSES.has(failureClass)) {
		await recordBreakerOpen(w, {
			scopeKey: dispatch.scopeKey,
			profile: sentimentRequestProfile({ webSearch: dispatch.webSearch, schemaFp: dispatch.schemaFp }),
			schemaFp: dispatch.schemaFp,
			failureClass,
			phase,
			attemptId: attempt.id,
			httpStatus: safe.httpStatus,
			errorType: error instanceof StructuredResearchRequestError ? error.errorType : null,
			rule: safe.code === "schema-budget-exceeded" ? "schema-budget-exceeded" : null,
		});
	}
	const routed = routeFailure(error, safe);
	// Only a deterministic refusal re-opens a probing scope; a transient or configuration refusal leaves the lease standing.
	const probe: ProbeOutcome = BREAKER_OPENING_CLASSES.has(failureClass) ? "refused" : "untouched";
	if (routed.route === "retry") {
		await closeUnpaid("provider-error", probe);
		w.consecutiveFailures += 1;
		if (w.consecutiveFailures >= w.policy.maxConsecutiveTransientFailures) {
			return new HandOver("retry-exhausted", attempt.ordinal, safe);
		}
		const nextAttemptAt = await retryLater(w, w.consecutiveFailures, routed.retryAfterMs);
		return new Parked(
			{ status: "retry-wait", nextAttemptAt, consecutiveFailures: w.consecutiveFailures },
			nextAttemptAt,
			safe,
		);
	}
	if (routed.route === "review") {
		// The provider refused the request itself, or it never left for a local defect: the operator's, not the queue's.
		await closeUnpaid("provider-error", probe);
		return new HandOver("contract-defect", attempt.ordinal, safe);
	}
	// Unknown outcome: the row keeps `sending` (or `aborted`) as the reconciliation record; the permit reservation and
	// any probe lease stand until an operator reconciles the attempt. No automatic repeat.
	console.warn(
		`[sentiment] unknown provider outcome on analysis ${w.claim.analysisId} (${phase}, attempt ${attempt.ordinal}): ${safe.kind} ${safe.code} (${safe.errorName})`,
	);
	if (safe.kind === "aborted") await finish(attempt.id, { outcome: "aborted" });
	return new HandOver("unknown-provider-outcome", attempt.ordinal, safe);
}

/**
 * One provider request with its ledger row and attribution: the request is
 * authorized and its intent recorded before it leaves (T1); a paid answer
 * (whatever becomes of it) is settled exactly once; a proven refusal is an
 * unpaid attempt that parks the case for the maintenance inventory; an
 * unknown outcome hands the case to reconciliation without another request;
 * a deterministic refusal of the request shape opens the breaker. The budget
 * is checked before every request.
 */
async function paidCall<T>(
	w: Workflow,
	phase: PaidPhase,
	requestShape: { schema: z.ZodType; webSearch: boolean },
	request: () => Promise<PaidAnswer<T>>,
	usable: (value: T) => boolean,
): Promise<T> {
	// Beyond the automatic budget only a verify-only resume permit may authorize a call, and only a verification:
	// the permit's phase budget (verify 1, classify 0, repair 0) is consumed below, so it authorizes exactly one.
	const overCap = w.paidCalls >= w.policy.maxPaidCalls;
	const permittedOverCap =
		(phase === "verify" && (w.resumePermitPurpose === "resume-verify" || w.resumePermitPurpose === "resume-repair")) ||
		(phase === "repair" && w.resumePermitPurpose === "resume-repair");
	if (overCap && !permittedOverCap) throw new HandOver("call-limit");
	if (w.costUsd >= w.policy.maxCostUsd) throw new HandOver("cost-limit");
	if (w.options.signal?.aborted) {
		// The job was cancelled (shutdown, expiry, canary deadline) before the request left: a transient local
		// failure with the request demonstrably never sent — the one pre-dispatch case the queue may repeat.
		const safe = sanitizeSentimentError(new DOMException("job aborted before the request", "AbortError"));
		await retryLater(w, 1, null);
		await park(w.claim, safe, w.deps);
		throw new SentimentJobError({ ...safe, requestSent: false });
	}
	// A resumed workflow spends every call from its permit, open or held, so the permit's phase budget is the ledger of
	// exactly what the resume authorized.
	const dispatch = await authorizeDispatch(w, phase, requestShape, {
		requirePermit: overCap || w.resumePermitPurpose !== null,
	});
	const attempt = { id: dispatch.attemptId, ordinal: dispatch.ordinal };
	let answer: PaidAnswer<T>;
	w.dispatch = dispatch;
	try {
		answer = await request();
	} catch (error) {
		throw await requestFailure(w, phase, dispatch, attempt, error);
	} finally {
		w.dispatch = null;
	}
	// A paid answer without a generation id cannot be reconciled against the provider's ledger: it is settled as a
	// paid, rejected attempt (never as unsent) and the case is handed over rather than built on.
	const reconcilable = answer.generationId !== null;
	await settlePaidAnswer(
		w,
		attempt,
		dispatch,
		{
			outcome: reconcilable && usable(answer.value) ? "accepted" : "rejected",
			generationId: answer.generationId,
			costUsd: answer.costUsd,
			candidate: reconcilable ? (answer.candidate ?? null) : null,
			succeeded: true,
		},
		{ provider: w.provider.id, model: SENTIMENT_MODEL },
	);
	if (!reconcilable) throw new HandOver("contract-defect", attempt.ordinal);
	w.consecutiveFailures = 0;
	return answer.value;
}

/**
 * Park the case for the queue's bounded retry after an unpaid attempt. A
 * `Retry-After` the provider sent controls the wait; otherwise the policy's
 * backoff does. Either way the wait never exceeds the policy's maximum.
 */
async function retryLater(w: Workflow, failures: number, retryAfterMs: number | null): Promise<Date> {
	const wait =
		retryAfterMs === null ? backoffMs(failures, w.policy) : Math.min(Math.max(retryAfterMs, 0), w.policy.backoffMaxMs);
	// The due time is taken from the database clock, which is also what the inventory compares it against.
	const nextAttemptAt = new Date((await w.controls.databaseNow()).getTime() + wait);
	await (w.deps.updateResolutionCase ?? updateResolutionCase)(
		w.claim.analysisId,
		{ status: "retry_wait", nextAttemptAt },
		w.claim,
	);
	return nextAttemptAt;
}

type StructuredSchema = Parameters<NonNullable<Provider["runStructuredResearch"]>>[0]["schema"];

/** A request through the provider boundary with no web search, for repair and verification. */
async function structured(w: Workflow, prompt: string, schema: StructuredSchema): Promise<PaidAnswer<unknown>> {
	if (!w.provider.runStructuredResearch)
		throw new Error(`Provider "${w.provider.id}" does not implement structured research`);
	try {
		const result = await w.provider.runStructuredResearch({
			prompt,
			schema,
			webSearch: false,
			signal: w.options.signal,
			maxOutputTokens: SENTIMENT_MAX_OUTPUT_TOKENS,
		});
		return {
			value: result.object,
			generationId: safeGenerationId(result.generationId),
			costUsd: result.usage?.costUsd ?? null,
		};
	} catch (error) {
		if (error instanceof StructuredResearchResponseError) {
			throw new SentimentValidationError(
				error.code,
				error.message,
				diagnostic("provider-schema", error.code === "no-content" ? "invalid-json" : error.code),
			).withEnvelope({
				generationId: error.envelope.generationId,
				request: error.envelope.request,
				usage: error.envelope.usage ?? null,
			});
		}
		throw error;
	}
}

function parseProvisional(value: unknown): SentimentClassificationResult | null {
	const parsed = sentimentClassificationResultSchema.safeParse(value);
	return parsed.success ? parsed.data : null;
}

const assess = (w: Workflow, candidate: SentimentClassificationResult): CandidateAssessment =>
	assessCandidate(candidate, {
		answerBody: w.run.answerBody,
		candidates: w.candidates,
		anchors: w.anchors,
		analysis: w.analysis,
	});

/**
 * The assessed candidate in the internal claim representation: exactly the
 * entities and aspects that survived the deterministic checks (dropped aspect
 * claims are gone), cited by anchor id. This is what the verifier judges and
 * what a verified analysis persists.
 */
/** Anchor id of an evidence span by its exact offsets; `s0000` for a span no anchor covers. */
function anchorIdOf(w: Workflow): (span: { start: number; end: number }) => string {
	const idOf = new Map(w.anchors.map((a) => [`${a.start}:${a.end}`, a.id]));
	return (span) => idOf.get(`${span.start}:${span.end}`) ?? "s0000";
}

function assessedCandidate(w: Workflow, assessment: CandidateAssessment): SentimentClassificationResult {
	const idOf = new Map(w.anchors.map((a) => [`${a.start}:${a.end}`, a.id]));
	const refs = (evidence: { start: number; end: number; polarity: "positive" | "negative" | "neutral" }[]) =>
		evidence.map((e) => ({ anchorId: idOf.get(`${e.start}:${e.end}`) ?? "s0000", polarity: e.polarity }));
	return {
		entities: assessment.entities.map((entity) => ({
			key: entity.key,
			score: entity.score,
			category: entity.category,
			confidence: entity.confidence,
			evidence: refs(entity.evidence),
			aspects: entity.aspects.map((aspect) => ({
				key: aspect.key,
				score: aspect.score,
				category: aspect.category,
				confidence: aspect.confidence,
				evidence: refs(aspect.evidence),
			})),
		})),
	};
}

/** Phase A: the one initial classification (web search on); its candidate seeds the workflow. */
async function initialCandidate(w: Workflow): Promise<SentimentClassificationResult> {
	const attempts = await (w.deps.loadProviderAttempts ?? loadProviderAttempts)(w.claim.analysisId);
	// Only this resolution instance counts: attempts of a superseded instance (changed input) belong to its own budget.
	const initialAnswers = attempts.filter(
		(a) => a.phase === "classify" && a.generationId !== null && a.instanceId === w.claim.instanceId,
	).length;
	if (initialAnswers >= w.policy.maxInitialClassifications) throw new HandOver("initial-classification-limit");
	const classification = await paidCall<SentimentClassification>(
		w,
		"classify",
		{
			schema: sentimentProviderResultSchemaFor(
				w.anchors.map((a) => a.id),
				w.candidates.map((c) => c.key),
			),
			webSearch: true,
		},
		async () => {
			const value = await (w.deps.classify ?? classifySentiment)(
				{ answerBody: w.run.answerBody, candidates: w.candidates },
				{ ...w.deps, resolveProvider: () => w.provider },
				w.options.signal,
			);
			return {
				value,
				generationId: value.generationId ?? null,
				costUsd: value.usage?.costUsd ?? null,
				candidate: value.candidate,
			};
		},
		(value) => value.contractDefect === null && value.unresolvedTargets.length === 0,
	);
	w.initial = {
		usage: classification.usage,
		request: classification.request,
		generationId: classification.generationId ?? null,
	};
	if (classification.contractDefect || !classification.candidate) throw new HandOver("contract-defect");
	return classification.candidate;
}

/** Phase C: one targeted repair of the unresolved entities, merged into the candidate. */
async function repair(
	w: Workflow,
	candidate: SentimentClassificationResult,
	targets: UnresolvedTarget[],
): Promise<SentimentClassificationResult> {
	const keys = [...new Set(targets.map((t) => t.entityKey))];
	await (w.deps.updateResolutionCase ?? updateResolutionCase)(
		w.claim.analysisId,
		{
			status: "repairing",
			unresolvedTargets: targets,
		},
		w.claim,
	);
	const schema = repairResultSchemaFor(
		w.anchors.map((a) => a.id),
		keys,
	);
	const prompt = buildRepairPrompt({
		answerBody: w.run.answerBody,
		candidates: w.candidates,
		anchors: w.anchors,
		targets,
	});
	const repaired = await paidCall<SentimentClassificationResult>(
		w,
		"repair",
		{ schema, webSearch: false },
		async () => {
			const raw = await structured(w, prompt, schema);
			const value = toClassificationResult(schema.parse(raw.value));
			// The reusable evidence of a repair is the whole candidate it yields, not the repaired slice alone.
			return { ...raw, value, candidate: mergeRepairedEntities(candidate, value, keys) };
		},
		(value) => {
			const a = assess(w, mergeRepairedEntities(candidate, value, keys));
			return a.contractDefect === null && !a.unresolved.some((u) => keys.includes(u.entityKey));
		},
	);
	w.repairs += 1;
	return mergeRepairedEntities(candidate, repaired, keys);
}

/** Phase D: the independent verifier's verdict on a deterministically valid candidate. */
async function verify(w: Workflow, candidate: SentimentClassificationResult): Promise<VerifierResult> {
	await (w.deps.updateResolutionCase ?? updateResolutionCase)(
		w.claim.analysisId,
		{
			status: "verifying",
			unresolvedTargets: [],
		},
		w.claim,
	);
	const schema = verifierResultSchemaFor(
		w.anchors.map((a) => a.id),
		w.candidates.map((c) => c.key),
	);
	const prompt = buildVerifierPrompt({
		answerBody: w.run.answerBody,
		candidates: w.candidates,
		anchors: w.anchors,
		candidate,
	});
	return paidCall<VerifierResult>(
		w,
		"verify",
		{ schema, webSearch: false },
		async () => {
			const raw = await structured(w, prompt, schema);
			return { ...raw, value: schema.parse(raw.value) as VerifierResult };
		},
		() => true,
	);
}

/** Phase E: the verified result, its audit and the closed case in one transaction. */
async function persistVerified(w: Workflow, assessment: CandidateAssessment): Promise<SentimentJobOutcome> {
	const classification: SentimentClassification = {
		entities: assessment.entities,
		filteredClaims: assessment.filteredClaims,
		unresolvedTargets: [],
		contractDefect: null,
		candidate: null,
		provider: w.provider.id,
		model: SENTIMENT_MODEL,
		webSearch: true,
		classifierVersion: SENTIMENT_CLASSIFIER_VERSION,
		taxonomyVersion: SENTIMENT_TAXONOMY_VERSION,
		inputHash: w.inputHash,
		usage: w.initial.usage,
		request: w.initial.request,
		generationId: w.initial.generationId,
	};
	try {
		await (w.deps.persist ?? persistClassification)({
			claim: w.claim,
			promptRunId: w.run.id,
			brandId: w.run.brandId,
			mentions: w.mentions,
			classification,
			verifierVersion: SENTIMENT_VERIFIER_VERSION,
		});
	} catch (error) {
		if (error instanceof ClaimLostError) return { status: "claim-lost", generation: w.claim.generation };
		// The transaction rolled back: nothing of the result exists; the case
		// keeps its candidate for the next run and waits. No provider call is
		// needed to finish — the next run persists from the stored candidate.
		const safe = sanitizeSentimentError(error, "persist");
		await retryLater(w, 1, null);
		const owned = await park(w.claim, safe, w.deps);
		if (!owned) return { status: "claim-lost", generation: w.claim.generation };
		throw new SentimentJobError(safe);
	}
	return {
		status: "classified",
		entities: assessment.entities.length,
		entityKeys: assessment.entities.map((entity) => entity.key),
		usage: w.initial.usage,
		request: w.initial.request,
		generationId: w.initial.generationId,
		filteredClaimCount: assessment.filteredClaims.length,
		filteredClaimCodes: countFilteredClaimCodes(assessment.filteredClaims),
		verified: true,
		verifierVersion: SENTIMENT_VERIFIER_VERSION,
		paidCalls: w.paidCalls,
		costUsd: w.costUsd,
		repairs: w.repairs,
		verifierRejections: w.verifierRejections,
	};
}

/**
 * Leave the automatic path: the case becomes the operator's work item
 * (`awaiting_review`, or `awaiting_reconciliation` when a request's outcome is
 * unknown) and the analysis is parked as `pending_resolution`.
 */
async function handOver(
	w: Workflow,
	reason: ReviewReason,
	candidate: SentimentClassificationResult | null,
	unresolved: UnresolvedTarget[],
	attemptOrdinal: number,
	safe: SafeSentimentError | null = null,
): Promise<SentimentJobOutcome> {
	const reconcile = reason === "unknown-provider-outcome";
	await (w.deps.updateResolutionCase ?? updateResolutionCase)(
		w.claim.analysisId,
		{
			status: reconcile ? "awaiting_reconciliation" : "awaiting_review",
			reviewReason: reason,
			provisionalResult: candidate,
			unresolvedTargets: unresolved,
			nextAttemptAt: null,
		},
		w.claim,
	);
	await park(w.claim, safe, w.deps);
	if (reconcile) return { status: "awaiting-reconciliation", attemptOrdinal };
	return {
		status: "awaiting-review",
		reason,
		paidCalls: w.paidCalls,
		costUsd: w.costUsd,
		unresolved: unresolved.length,
	};
}

/**
 * The resolution workflow of one claimed analysis (ADR Amendment B): classify
 * once, assess deterministically, repair the unresolved entities, verify the
 * whole candidate independently, persist only a verified result. Every paid
 * answer is one ledger row and one usage event; every exit that is not a
 * verified result leaves the case open.
 */
async function resolve(w: Workflow): Promise<SentimentJobOutcome> {
	let candidate = parseProvisional(w.kase.provisionalResult);
	let pending: UnresolvedTarget[] = [...w.resumeTargets];
	try {
		if (!candidate) candidate = await initialCandidate(w);
		for (;;) {
			const assessment = assess(w, candidate);
			if (assessment.contractDefect) throw new HandOver("contract-defect");
			const targets = [...assessment.unresolved, ...pending];
			await (w.deps.updateResolutionCase ?? updateResolutionCase)(
				w.claim.analysisId,
				{
					provisionalResult: candidate,
					unresolvedTargets: targets,
				},
				w.claim,
			);
			if (targets.length > 0) {
				assertRepairPairAffordable(w, pending);
				candidate = await repair(w, candidate, targets);
				pending = [];
				continue;
			}
			const verdict = await verify(w, assessedCandidate(w, assessment));
			if (verdict.verdict === "accept") return await persistVerified(w, assessment);
			w.verifierRejections += 1;
			// Aspect claims are independent findings: when the verifier objects only to specific aspect claims, those claims
			// are dropped and recorded, and the verdicts it did not object to are persisted (ADR Amendment E).
			const filtered = dropVerifierRejectedAspects(assessment, verdict.issues, anchorIdOf(w));
			if (filtered) return await persistVerified(w, filtered);
			pending = verifierIssuesToTargets(verdict.issues);
			// A resume permit authorizes verification only: a rejected verdict is the operator's decision (D14), never a
			// repair or classify request and never a retry wait.
			if (w.resumePermitPurpose === "resume-verify" || w.resumePermitPurpose === "resume-repair")
				throw new HandOver("verifier-rejected", w.paidCalls);
		}
	} catch (error) {
		return leaveWorkflow(w, error, candidate, pending);
	}
}

/**
 * A repair is only worth paying for if its verification also fits the budget: a verifier-caused repair otherwise parks
 * the candidate the verifier actually rejected (with its issues); a deterministic one parks the candidate under its own
 * typed exit with the unbound targets — never a paid repair nobody can verify. A repair permit carries its own pair.
 */
function assertRepairPairAffordable(w: Workflow, pending: readonly UnresolvedTarget[]): void {
	if (w.paidCalls + 2 > w.policy.maxPaidCalls && w.resumePermitPurpose !== "resume-repair") {
		throw new HandOver(pending.length > 0 ? "verifier-rejected" : "call-limit", w.paidCalls);
	}
}

/** Every non-verified exit of the workflow: a lost lease writes nothing more; a hand-over parks the case; anything else propagates. */
async function leaveWorkflow(
	w: Workflow,
	error: unknown,
	candidate: SentimentClassificationResult | null,
	pending: UnresolvedTarget[],
): Promise<SentimentJobOutcome> {
	// A lease taken over by a newer attempt: nothing of this attempt is written further.
	if (error instanceof ClaimLostError) return { status: "claim-lost", generation: w.claim.generation };
	if (error instanceof Parked) {
		try {
			await (w.deps.updateResolutionCase ?? updateResolutionCase)(
				w.claim.analysisId,
				{
					status: "retry_wait",
					nextAttemptAt: error.nextAttemptAt,
					provisionalResult: candidate,
					unresolvedTargets: pending,
				},
				w.claim,
			);
			const owned = await park(w.claim, error.safe, w.deps);
			if (!owned) return { status: "claim-lost", generation: w.claim.generation };
		} catch (inner) {
			if (inner instanceof ClaimLostError) return { status: "claim-lost", generation: w.claim.generation };
			throw inner;
		}
		return error.outcome;
	}
	if (!(error instanceof HandOver)) throw error;
	const unresolved = candidate ? assess(w, candidate).unresolved : [];
	try {
		return await handOver(w, error.reason, candidate, [...unresolved, ...pending], error.attemptOrdinal, error.safe);
	} catch (inner) {
		if (inner instanceof ClaimLostError) return { status: "claim-lost", generation: w.claim.generation };
		throw inner;
	}
}

/** The outcome of a case parked for the operator; nothing is claimed or written for it. */
function reviewOutcome(kase: StoredResolutionCase, attemptOrdinal = 0): SentimentJobOutcome {
	if (kase.status === "awaiting_reconciliation") return { status: "awaiting-reconciliation", attemptOrdinal };
	return {
		status: "awaiting-review",
		reason: (kase.reviewReason as ReviewReason | null) ?? "call-limit",
		paidCalls: kase.automatedProviderCalls,
		costUsd: Number(kase.totalActualCostUsd),
		unresolved: ((kase.unresolvedTargets as UnresolvedTarget[]) ?? []).length,
	};
}

const isParked = (kase: StoredResolutionCase) =>
	kase.status === "awaiting_review" || kase.status === "awaiting_reconciliation";

type StoredAttempt = Awaited<ReturnType<typeof loadProviderAttempts>>[number];

/**
 * The durable evidence that lets a case parked for an unknown provider outcome
 * resume without repeating the call: exactly `awaiting_reconciliation` for
 * `unknown-provider-outcome`; the latest classify/repair attempt of the same
 * instance, built for the frozen current input, `accepted`, carrying a
 * candidate that still passes the runtime schema; no `sending` attempt
 * anywhere on the analysis. Verdicts, refusals, aborts, other instances or
 * inputs and malformed candidates never qualify.
 */
export function resumableEvidence(
	kase: StoredResolutionCase,
	inputHash: string,
	attempts: StoredAttempt[],
	options: { verifyPermit?: boolean; repairPermit?: boolean } = {},
): { attempt: StoredAttempt; candidate: SentimentClassificationResult } | null {
	const reconcilable = kase.status === "awaiting_reconciliation" && kase.reviewReason === "unknown-provider-outcome";
	// Amendment C: a case parked for review may resume at verification only under an explicit verify-only permit; a
	// verifier-rejected case resumes only under a permit that carries the repair+verify pair its budget could not afford.
	const pair = options.repairPermit === true && options.verifyPermit === true;
	const permitted =
		kase.status === "awaiting_review" &&
		((options.verifyPermit === true &&
			(kase.reviewReason === "contract-defect" || kase.reviewReason === "call-limit")) ||
			(pair && (kase.reviewReason === "verifier-rejected" || kase.reviewReason === "contract-defect")));
	if (!reconcilable && !permitted) return null;
	if (kase.inputHash !== inputHash) return null;
	if (attempts.some((a) => a.outcome === "sending")) return null;
	// A refusal that never answered (unpaid provider error) carries no candidate and is not the evidence.
	const latest = attempts
		.filter(
			(a) =>
				a.instanceId === kase.instanceId &&
				(a.phase === "classify" || a.phase === "repair") &&
				a.outcome !== "provider-error",
		)
		.at(-1);
	// Under a repair permit a call-limit case resumes from its latest candidate even when that repair was refused by
	// the deterministic checks: re-assessing it is exactly what the permitted repair is for.
	const acceptable =
		latest?.outcome === "accepted" || (pair && kase.reviewReason === "call-limit" && latest?.outcome === "rejected");
	if (!latest || !acceptable || latest.inputHash !== inputHash) return null;
	const parsed = sentimentClassificationResultSchema.safeParse(latest.candidate);
	return parsed.success ? { attempt: latest, candidate: parsed.data } : null;
}

export interface ResumableSentimentRun {
	analysisId: string;
	promptRunId: string;
	/** Ordinal of the attempt whose stored candidate the resumed workflow will reuse. */
	attemptOrdinal: number;
}

/**
 * The parked cases the maintenance schedule may wake: exactly those the
 * resume predicate accepts against their frozen instance input (the job
 * re-checks it against the live input under a new claim). Cases awaiting
 * review, cases with an unresolved `sending` request, retry waits and every
 * other `pending_resolution` state are never listed, so the inventory cannot
 * keep queueing work that would only park again.
 */
/** Owner decision D7: at most this many parked cases are re-sent per maintenance tick. */
export const RESUME_BATCH_MAX = 25;

/**
 * The parked cases the maintenance schedule may wake, bounded per tick:
 *  - cases awaiting reconciliation whose own instance holds resumable evidence;
 *  - cases in `retry_wait` that are due by the database clock (or carry no due
 *    time), including those parked by the dispatch hold or the breaker — the
 *    job re-checks hold, breaker and due time under a new claim;
 *  - cases awaiting review that carry a live verify-only permit.
 * Cases awaiting review without a permit, unresolved `sending` requests and
 * every other state are never listed, so the inventory cannot keep queueing
 * work that would only park again.
 */
export async function listResumableSentimentRuns(limit = RESUME_BATCH_MAX): Promise<ResumableSentimentRun[]> {
	const due = await listDueRetryWaitCases(limit);
	const resumable: ResumableSentimentRun[] = due.map((row) => ({
		analysisId: row.analysisId,
		promptRunId: row.promptRunId,
		attemptOrdinal: 0,
	}));
	const parked = (await listUnresolvedCases()).filter(
		(row) =>
			(row.status === "awaiting_reconciliation" && row.reviewReason === "unknown-provider-outcome") ||
			(row.status === "awaiting_review" &&
				(row.reviewReason === "contract-defect" ||
					row.reviewReason === "call-limit" ||
					row.reviewReason === "verifier-rejected")),
	);
	for (const row of parked) {
		if (resumable.length >= limit) break;
		const kase = await loadResolutionCase(row.analysisId);
		if (!kase) continue;
		const permit =
			kase.status === "awaiting_review"
				? await findLivePermit({ analysisId: row.analysisId, instanceId: kase.instanceId, inputHash: kase.inputHash })
				: null;
		if (kase.status === "awaiting_review" && !permitAllowsVerify(permit)) continue;
		const evidence = resumableEvidence(kase, kase.inputHash, await loadProviderAttempts(row.analysisId), {
			verifyPermit: permitAllowsVerify(permit),
			repairPermit: permitAllowsRepair(permit),
		});
		if (evidence) {
			resumable.push({
				analysisId: row.analysisId,
				promptRunId: row.promptRunId,
				attemptOrdinal: evidence.attempt.ordinal,
			});
		}
	}
	return resumable;
}

/** A live permit whose verify budget is still 1. */
export function permitAllowsVerify(permit: { phaseBudget: unknown } | null): boolean {
	if (!permit) return false;
	const budget = permit.phaseBudget as Partial<Record<string, number>> | null;
	return budget?.verify === 1;
}

/** A live permit whose repair budget is still 1. */
export function permitAllowsRepair(permit: { phaseBudget: unknown } | null): boolean {
	if (!permit) return false;
	const budget = permit.phaseBudget as Partial<Record<string, number>> | null;
	return budget?.repair === 1;
}

/** The parked verifier targets a repair-resume starts from; anything else starts clean. */
function resumeTargetsOf(kase: StoredResolutionCase, purpose: PermitPurpose | null): UnresolvedTarget[] {
	if (purpose !== "resume-repair") return [];
	const targets = (kase.unresolvedTargets as UnresolvedTarget[] | null) ?? [];
	return targets.filter((t) => t.source === "verifier");
}

export interface ResumableEnqueueResult {
	/** True when dispatch was held: nothing was discovered or sent this tick. */
	held: boolean;
	discovered: number;
	/** Jobs the queue accepted (a new job id). */
	enqueued: number;
	/** Sends the exclusive queue refused because a job for the run is already queued or active. */
	deduplicated: number;
	failed: number;
}

/**
 * The durable wake-up for resumable parked cases, run on the maintenance
 * schedule: every discovered run is sent through the same singleton-keyed
 * send the workers use, so a job already queued or active for the run is
 * never duplicated and a run whose immediate wake-up was lost (send refused,
 * process gone before enqueue) is picked up within one schedule interval.
 */
export async function enqueueResumableSentimentRuns(sender: SentimentSender): Promise<ResumableEnqueueResult> {
	if (isHeld(await readDispatchState())) return { held: true, discovered: 0, enqueued: 0, deduplicated: 0, failed: 0 };
	const runs = await listResumableSentimentRuns();
	const result: ResumableEnqueueResult = {
		held: false,
		discovered: runs.length,
		enqueued: 0,
		deduplicated: 0,
		failed: 0,
	};
	for (const run of runs) {
		try {
			const jobId = await sendSentimentJob(sender, run.promptRunId);
			if (jobId === null) result.deduplicated += 1;
			else result.enqueued += 1;
		} catch (error) {
			result.failed += 1;
			console.error(
				`sentiment resume enqueue failed for run ${run.promptRunId}:`,
				error instanceof Error ? error.name : typeof error,
			);
		}
	}
	return result;
}

/** What the ledger says the instance has paid for: answered attempts and their charged cost. */
function ledgerTotals(kase: StoredResolutionCase, attempts: StoredAttempt[]): { calls: number; costUsd: number } {
	const answered = attempts.filter(
		(a) => a.instanceId === kase.instanceId && (a.outcome === "accepted" || a.outcome === "rejected"),
	);
	return {
		calls: answered.length,
		costUsd: answered.reduce((sum, a) => sum + Number(a.actualCostUsd ?? 0), 0),
	};
}

/**
 * Under a freshly acquired claim, move a parked case forward only on exact
 * same-instance evidence: the case budget is caught up from the ledger (never
 * lowered — drift keeps the case parked and is reported), then the stored
 * candidate becomes the provisional result and the workflow continues at
 * verification. Anything else hands the row back parked, untouched.
 */
async function resumeParkedCase(
	kase: StoredResolutionCase,
	claim: ResolutionOwner,
	inputHash: string,
	attempts: StoredAttempt[],
	deps: SentimentJobDeps,
): Promise<
	| { kase: StoredResolutionCase; permitPurpose: PermitPurpose | null; resumeTargets: UnresolvedTarget[] }
	| { outcome: SentimentJobOutcome }
> {
	const permit = await dispatchDeps(deps).findLivePermit({
		analysisId: claim.analysisId,
		instanceId: kase.instanceId,
		inputHash,
	});
	const evidence = resumableEvidence(kase, inputHash, attempts, {
		verifyPermit: permitAllowsVerify(permit),
		repairPermit: permitAllowsRepair(permit),
	});
	if (!evidence) {
		await park(claim, null, deps);
		return { outcome: reviewOutcome(kase) };
	}
	const ledger = ledgerTotals(kase, attempts);
	if (kase.automatedProviderCalls > ledger.calls || Number(kase.totalActualCostUsd) > ledger.costUsd + 1e-9) {
		// The case claims more than its ledger shows: never lower a counter by guessing; leave it parked and say so.
		console.error(
			`sentiment budget drift on analysis ${claim.analysisId}: case ${kase.automatedProviderCalls}/${kase.totalActualCostUsd} vs ledger ${ledger.calls}/${ledger.costUsd.toFixed(6)}`,
		);
		await park(claim, null, deps);
		return { outcome: reviewOutcome(kase, evidence.attempt.ordinal) };
	}
	// The late call the previous owner never got to charge is counted before any budget decision.
	const charged = await (deps.chargeResolutionCase ?? chargeResolutionCase)(claim.analysisId, claim);
	const permitPurpose = permit ? (permit.purpose as PermitPurpose) : null;
	const resumeTargets = resumeTargetsOf(kase, permitPurpose);
	const resumed = {
		status: resumeTargets.length > 0 ? ("repairing" as const) : ("verifying" as const),
		provisionalResult: evidence.candidate,
		unresolvedTargets: resumeTargets,
		reviewReason: null,
		nextAttemptAt: null,
	};
	await (deps.updateResolutionCase ?? updateResolutionCase)(claim.analysisId, resumed, claim);
	return {
		kase: {
			...kase,
			...resumed,
			automatedProviderCalls: charged.automatedProviderCalls,
			totalActualCostUsd: charged.totalActualCostUsd.toFixed(6),
		},
		permitPurpose,
		resumeTargets,
	};
}

async function classifyAndPersist(
	run: StoredRunForSentiment & { answerBody: string },
	analysisClaim: AnalysisClaim,
	mentions: StoredMention[],
	candidates: SentimentCandidate[],
	inputHash: string,
	deps: SentimentJobDeps,
	options: SentimentJobOptions,
): Promise<SentimentJobOutcome> {
	const policy: ResolutionPolicy = { ...RESOLUTION_POLICY, ...deps.resolutionPolicy };
	const controls = dispatchDeps(deps);
	// A case of another input rotates to a new instance here (fenced on the claim); the same input's case is reused.
	let kase = await (deps.ensureResolutionCase ?? ensureResolutionCase)(
		analysisClaim.analysisId,
		inputHash,
		analysisClaim,
	);
	const claim: ResolutionOwner = { ...analysisClaim, instanceId: kase.instanceId };
	if (kase.status === "resolved") {
		// Decided between the pre-claim check and the claim (a racing owner): hand the row back untouched.
		await park(claim, null, deps);
		return { status: "already-completed" };
	}
	const attempts = await (deps.loadProviderAttempts ?? loadProviderAttempts)(claim.analysisId);
	let resumePermitPurpose: PermitPurpose | null = null;
	let resumeTargets: UnresolvedTarget[] = [];
	if (isParked(kase)) {
		const resumed = await resumeParkedCase(kase, claim, inputHash, attempts, deps);
		if ("outcome" in resumed) return resumed.outcome;
		kase = resumed.kase;
		resumePermitPurpose = resumed.permitPurpose;
		resumeTargets = resumed.resumeTargets;
	}
	const dangling = attempts.find((a) => a.outcome === "sending");
	if (dangling) {
		await (deps.updateResolutionCase ?? updateResolutionCase)(
			claim.analysisId,
			{ status: "awaiting_reconciliation", reviewReason: "unknown-provider-outcome", nextAttemptAt: null },
			claim,
		);
		await park(claim, null, deps);
		return { status: "awaiting-reconciliation", attemptOrdinal: dangling.ordinal };
	}
	const deferred = await deferUntilDue(kase, claim, controls, deps);
	if (deferred) return deferred;
	let provider: Provider;
	try {
		provider = deps.resolveProvider ? deps.resolveProvider() : resolveSentimentProvider();
	} catch (error) {
		const safe = { ...sanitizeSentimentError(error), requestSent: false };
		if (safe.kind === "configuration") {
			// No provider is configured: a configuration defect the queue cannot repeat away; the operator's work item.
			await (deps.updateResolutionCase ?? updateResolutionCase)(
				claim.analysisId,
				{ status: "awaiting_review", reviewReason: "contract-defect", nextAttemptAt: null },
				claim,
			);
			await park(claim, safe, deps);
			return {
				status: "awaiting-review",
				reason: "contract-defect",
				paidCalls: kase.automatedProviderCalls,
				costUsd: Number(kase.totalActualCostUsd),
				unresolved: 0,
			};
		}
		await park(claim, safe, deps);
		throw new SentimentJobError(safe);
	}
	const analysis = analyzeAnswerRanges(run.answerBody);
	const anchors = segmentAnswer(run.answerBody, analysis);
	let consecutiveFailures = 0;
	for (let i = attempts.length - 1; i >= 0; i--) {
		if (attempts[i].instanceId !== claim.instanceId || attempts[i].outcome !== "provider-error") break;
		consecutiveFailures += 1;
	}
	const workflow: Workflow = {
		run,
		claim,
		mentions,
		candidates,
		anchors,
		analysis,
		inputHash,
		provider,
		policy,
		deps,
		options,
		kase,
		paidCalls: kase.automatedProviderCalls,
		costUsd: Number(kase.totalActualCostUsd),
		repairs: 0,
		verifierRejections: 0,
		consecutiveFailures,
		initial: { generationId: null },
		dispatch: null,
		controls,
		resumePermitPurpose,
		resumeTargets,
	};
	// Every request of this lifecycle passes the guard, whatever resolved the provider (production lock, canary wrapper, test double).
	workflow.provider = guardProvider(provider, workflow);
	return resolve(workflow);
}

/**
 * Due time by the database clock: a case not due within the inline wait is
 * handed back parked and never called early; a nearly due case waits inline.
 */
async function deferUntilDue(
	kase: StoredResolutionCase,
	claim: AnalysisClaim,
	controls: DispatchDeps,
	deps: SentimentJobDeps,
): Promise<SentimentJobOutcome | null> {
	if (!kase.nextAttemptAt) return null;
	const remaining = kase.nextAttemptAt.getTime() - (await controls.databaseNow()).getTime();
	if (remaining > MAX_INLINE_WAIT_MS) {
		const owned = await (deps.markAnalysis ?? markAnalysis)(claim, { status: "pending_resolution", inputHash: null });
		if (!owned) return { status: "claim-lost", generation: claim.generation };
		return { status: "deferred", nextAttemptAt: kase.nextAttemptAt };
	}
	if (remaining > 0) await (deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms))))(remaining);
	return null;
}

/** A payload is acted on only when it is well-formed and names the current classifier and taxonomy. */
function acceptPayload(data: unknown): { payload: SentimentJobData } | { skipped: SentimentJobOutcome } {
	const parsed = sentimentJobSchema.safeParse(data);
	if (!parsed.success) {
		return {
			skipped: { status: "skipped", reason: `invalid payload: ${parsed.error.issues[0]?.message ?? "unknown"}` },
		};
	}
	const payload: SentimentJobData = parsed.data;
	if (payload.classifierVersion !== SENTIMENT_CLASSIFIER_VERSION) {
		return { skipped: { status: "skipped", reason: `stale classifier version "${payload.classifierVersion}"` } };
	}
	if (payload.taxonomyVersion !== SENTIMENT_TAXONOMY_VERSION) {
		return { skipped: { status: "skipped", reason: `stale taxonomy version "${payload.taxonomyVersion}"` } };
	}
	return { payload };
}

/**
 * Worker-side core for one classify-sentiment job. Idempotent against
 * duplicates, restarts and racing workers: a completed analysis whose stored
 * input hash still matches the current classifier input makes no call; every
 * other state must first be claimed with a conditional update, and exactly
 * one claimant proceeds to the provider boundary while the others return a
 * non-calling outcome. Every terminal write is fenced on the claim
 * generation, so an attempt that outlived its lease ends as `claim-lost`
 * without touching what a later attempt wrote. Invalid or stale payloads are
 * skipped without a call and without failing the job. Provider, network and
 * persistence errors park the resolution case and propagate as
 * `SentimentJobError` so pg-boss applies its bounded retry policy — but only a
 * proven refusal is repeated; an unknown provider outcome is parked for
 * reconciliation. The only successful outcome is a verified result persisted
 * in one transaction; an exhausted automatic budget hands the run to the
 * operator as an open `awaiting_review` case; parked work is
 * `pending_resolution`, never `failed` (ADR-SENT-01-GROUNDED-COMPLETION,
 * Amendment B).
 */
export async function runSentimentJob(
	data: unknown,
	deps: SentimentJobDeps = {},
	options: SentimentJobOptions = {},
): Promise<SentimentJobOutcome> {
	const accepted = acceptPayload(data);
	if ("skipped" in accepted) return accepted.skipped;
	const payload = accepted.payload;

	const run = await (deps.loadRun ?? loadRunForSentiment)(payload.promptRunId);
	if (!run) return { status: "skipped", reason: "prompt run not found" };

	const analysis = await (deps.ensureAnalysis ?? ensureAnalysis)({ promptRunId: run.id, brandId: run.brandId });
	const drift = taxonomyDriftOutcome(analysis);
	if (drift) return drift;
	const entities = await (deps.loadEntities ?? loadDetectableEntities)(run.brandId, "historical");
	const mentions = await resolveMentions(run, entities, deps);
	const candidates = candidatesFromMentions(mentions, entities);
	const body = mentions.length === 0 ? null : run.answerBody;
	if (body === null && analysis.status === "no_mentions") return { status: "already-completed" };
	const inputHash = body === null ? null : sentimentInputHash(body, candidates);
	const settled = inputHash === null ? null : await settledWithoutClaim(analysis, inputHash, deps);
	if (settled) return settled;

	if (inputHash !== null && (await executionGateHeld(analysis.id, inputHash, deps))) {
		return { status: "held", reason: "dispatch-held", nextAttemptAt: null };
	}

	// This is the resolution workflow itself, so it may resume a run it parked; a plain claim never does.
	const claimed = await (deps.claimAnalysis ?? claimAnalysis)(analysis.id, {
		allowFinished: true,
		resumeResolution: true,
	});
	if (!claimed.claimed) return { status: "claimed-elsewhere", analysisStatus: claimed.status };
	const claim = claimed.claim;

	if (body === null || inputHash === null) return completeWithoutMentions(claim, deps);
	return classifyAndPersist({ ...run, answerBody: body }, claim, mentions, candidates, inputHash, deps, options);
}

/** A run whose current mention set is empty is completed as `no_mentions` under the claim; no call is made. */
async function completeWithoutMentions(claim: AnalysisClaim, deps: SentimentJobDeps): Promise<SentimentJobOutcome> {
	const owned = await (deps.markAnalysis ?? markAnalysis)(claim, {
		status: "no_mentions",
		completedAt: new Date(),
		errorCode: null,
		errorMessage: null,
	});
	return owned ? { status: "no-mentions" } : { status: "claim-lost", generation: claim.generation };
}

/** The same disposition the inventory gives a versioning defect: not work — no claim, no call, nothing rewritten. */
function taxonomyDriftOutcome(analysis: SentimentAnalysis): SentimentJobOutcome | null {
	if (!isTaxonomyDrift(analysis)) return null;
	console.error(
		`[sentiment] taxonomy drift on analysis ${analysis.id}: ${analysis.classifierVersion} row carries ${analysis.taxonomyVersion}, current is ${SENTIMENT_TAXONOMY_VERSION}; a taxonomy change ships as a classifier version`,
	);
	return {
		status: "skipped",
		reason: `taxonomy drift: ${analysis.classifierVersion} analysis carries ${analysis.taxonomyVersion}, expected ${SENTIMENT_TAXONOMY_VERSION}`,
	};
}

/**
 * Execution gate, read after `ensureAnalysis` and before `claimAnalysis`: the
 * pending row is durable already; under a held dispatch only a live permit for
 * this exact instance and input lets the job claim. A held job completes
 * without claiming, so pg-boss never retries it.
 */
async function executionGateHeld(analysisId: string, inputHash: string, deps: SentimentJobDeps): Promise<boolean> {
	const controls = dispatchDeps(deps);
	if (!isHeld(await controls.readDispatchState())) return false;
	const kase = await (deps.loadResolutionCase ?? loadResolutionCase)(analysisId);
	if (!kase) return true;
	const permit = await controls.findLivePermit({ analysisId, instanceId: kase.instanceId, inputHash });
	return permit === null;
}

/**
 * What is decided before anything is claimed or written: a current verified
 * result, and the resolution instance of exactly this input — a resolved
 * instance is immutable, a parked one is the operator's; neither is touched.
 */
async function settledWithoutClaim(
	analysis: SentimentAnalysis,
	inputHash: string,
	deps: SentimentJobDeps,
): Promise<SentimentJobOutcome | null> {
	if (isAnalysisCurrent(analysis, inputHash)) return { status: "already-completed" };
	const kase = await (deps.loadResolutionCase ?? loadResolutionCase)(analysis.id);
	if (!kase || kase.inputHash !== inputHash) return null;
	if (kase.status === "resolved") return { status: "already-completed" };
	if (!isParked(kase)) return null;
	// A parked case with resumable evidence of its own is claimed and resumed; the claim re-checks the evidence.
	const attempts = await (deps.loadProviderAttempts ?? loadProviderAttempts)(analysis.id);
	const permit = await dispatchDeps(deps).findLivePermit({
		analysisId: analysis.id,
		instanceId: kase.instanceId,
		inputHash,
	});
	return resumableEvidence(kase, inputHash, attempts, {
		verifyPermit: permitAllowsVerify(permit),
		repairPermit: permitAllowsRepair(permit),
	})
		? null
		: reviewOutcome(kase);
}
