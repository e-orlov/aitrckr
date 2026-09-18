import type { SentimentAnalysis } from "../db/schema";
import type { Provider, StructuredResearchRequestSummary, StructuredResearchUsage } from "../providers/types";
import { StructuredResearchRequestError, StructuredResearchResponseError } from "../providers/types";
import { type EvidenceAnchor, segmentAnswer } from "./anchors";
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
import { resolveSentimentProvider } from "./provider";
import { type AnalyzableText, analyzeAnswerRanges } from "./ranges";
import {
	backoffMs,
	buildRepairPrompt,
	buildVerifierPrompt,
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
	listUnresolvedCases,
	type loadAnalysisState,
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
	SENTIMENT_TAXONOMY_VERSION,
	type SentimentCandidate,
	type SentimentClassificationResult,
	type SentimentJobData,
	sentimentClassificationResultSchema,
	sentimentJobSchema,
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

/** Deterministic refusals of the request itself (request, authentication, permission, credit, configuration): the operator's, never repeated. */
const REVIEW_STATUSES: ReadonlySet<number> = new Set([400, 401, 402, 403, 404, 409, 422]);

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
}

type PaidPhase = "classify" | "repair" | "verify";

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

/**
 * One provider request with its ledger row and attribution: the intent is
 * recorded before the request leaves; a paid answer (whatever becomes of it)
 * is settled exactly once; a proven refusal is an unpaid attempt that parks
 * the case in `retry_wait` and re-throws for the queue's bounded retry; an
 * unknown outcome hands the case to reconciliation without another request.
 * The budget is checked before every request.
 */
async function paidCall<T>(
	w: Workflow,
	phase: PaidPhase,
	request: () => Promise<PaidAnswer<T>>,
	usable: (value: T) => boolean,
): Promise<T> {
	if (w.paidCalls >= w.policy.maxPaidCalls) throw new HandOver("call-limit");
	if (w.costUsd >= w.policy.maxCostUsd) throw new HandOver("cost-limit");
	if (w.options.signal?.aborted) {
		// The job was cancelled (shutdown, expiry, canary deadline) before the request left: a transient local
		// failure with the request demonstrably never sent — the one pre-dispatch case the queue may repeat.
		const safe = sanitizeSentimentError(new DOMException("job aborted before the request", "AbortError"));
		await retryLater(w, 1, null);
		await park(w.claim, safe, w.deps);
		throw new SentimentJobError({ ...safe, requestSent: false });
	}
	const attempt = await (w.deps.openProviderAttempt ?? openProviderAttempt)({
		analysisId: w.claim.analysisId,
		phase,
		inputHash: w.inputHash,
		claim: w.claim,
	});
	const finish = w.deps.finishProviderAttempt ?? finishProviderAttempt;
	let answer: PaidAnswer<T>;
	try {
		answer = await request();
	} catch (error) {
		const safe = sanitizeSentimentError(error);
		if (safe.requestSent && safe.envelope?.generationId) {
			// The provider answered and charged, but the answer could not be shaped: a paid, unusable attempt.
			await settlePaidAnswer(
				w,
				attempt,
				{
					outcome: "rejected",
					generationId: safe.envelope.generationId,
					costUsd: safe.envelope.usage?.costUsd ?? null,
					candidate: null,
					succeeded: false,
				},
				{ provider: safe.provider, model: safe.model },
			);
			throw new HandOver("contract-defect");
		}
		const routed = routeFailure(error, safe);
		if (routed.route === "retry") {
			await finish(attempt.id, { outcome: "provider-error" });
			w.consecutiveFailures += 1;
			await retryLater(w, w.consecutiveFailures, routed.retryAfterMs);
			await park(w.claim, safe, w.deps);
			throw new SentimentJobError(safe);
		}
		if (routed.route === "review") {
			// The provider refused the request itself, or it never left for a local defect: the operator's, not the queue's.
			await finish(attempt.id, { outcome: "provider-error" });
			throw new HandOver("contract-defect", attempt.ordinal, safe);
		}
		// Unknown outcome: the row keeps `sending` (or `aborted`) as the reconciliation record; no automatic repeat.
		if (safe.kind === "aborted") await finish(attempt.id, { outcome: "aborted" });
		throw new HandOver("unknown-provider-outcome", attempt.ordinal, safe);
	}
	await settlePaidAnswer(
		w,
		attempt,
		{
			outcome: usable(answer.value) ? "accepted" : "rejected",
			generationId: answer.generationId,
			costUsd: answer.costUsd,
			candidate: answer.candidate ?? null,
			succeeded: true,
		},
		{ provider: w.provider.id, model: SENTIMENT_MODEL },
	);
	w.consecutiveFailures = 0;
	return answer.value;
}

/**
 * Park the case for the queue's bounded retry after an unpaid attempt. A
 * `Retry-After` the provider sent controls the wait; otherwise the policy's
 * backoff does. Either way the wait never exceeds the policy's maximum.
 */
function retryLater(w: Workflow, failures: number, retryAfterMs: number | null): Promise<void> {
	const wait =
		retryAfterMs === null ? backoffMs(failures, w.policy) : Math.min(Math.max(retryAfterMs, 0), w.policy.backoffMaxMs);
	return (w.deps.updateResolutionCase ?? updateResolutionCase)(
		w.claim.analysisId,
		{ status: "retry_wait", nextAttemptAt: new Date(Date.now() + wait) },
		w.claim,
	);
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
	let pending: UnresolvedTarget[] = [];
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
				candidate = await repair(w, candidate, targets);
				pending = [];
				continue;
			}
			const verdict = await verify(w, assessedCandidate(w, assessment));
			if (verdict.verdict === "accept") return await persistVerified(w, assessment);
			w.verifierRejections += 1;
			pending = verifierIssuesToTargets(verdict.issues);
		}
	} catch (error) {
		return leaveWorkflow(w, error, candidate, pending);
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
): { attempt: StoredAttempt; candidate: SentimentClassificationResult } | null {
	if (kase.status !== "awaiting_reconciliation" || kase.reviewReason !== "unknown-provider-outcome") return null;
	if (kase.inputHash !== inputHash) return null;
	if (attempts.some((a) => a.outcome === "sending")) return null;
	const latest = attempts
		.filter((a) => a.instanceId === kase.instanceId && (a.phase === "classify" || a.phase === "repair"))
		.at(-1);
	if (!latest || latest.outcome !== "accepted" || latest.inputHash !== inputHash) return null;
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
export async function listResumableSentimentRuns(): Promise<ResumableSentimentRun[]> {
	const parked = (await listUnresolvedCases()).filter(
		(row) => row.status === "awaiting_reconciliation" && row.reviewReason === "unknown-provider-outcome",
	);
	const resumable: ResumableSentimentRun[] = [];
	for (const row of parked) {
		const kase = await loadResolutionCase(row.analysisId);
		if (!kase) continue;
		const evidence = resumableEvidence(kase, kase.inputHash, await loadProviderAttempts(row.analysisId));
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

export interface ResumableEnqueueResult {
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
	const runs = await listResumableSentimentRuns();
	const result: ResumableEnqueueResult = { discovered: runs.length, enqueued: 0, deduplicated: 0, failed: 0 };
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
): Promise<{ kase: StoredResolutionCase } | { outcome: SentimentJobOutcome }> {
	const evidence = resumableEvidence(kase, inputHash, attempts);
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
	const resumed = {
		status: "verifying" as const,
		provisionalResult: evidence.candidate,
		unresolvedTargets: [],
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
	if (isParked(kase)) {
		const resumed = await resumeParkedCase(kase, claim, inputHash, attempts, deps);
		if ("outcome" in resumed) return resumed.outcome;
		kase = resumed.kase;
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
	if (kase.nextAttemptAt && kase.nextAttemptAt.getTime() > Date.now()) {
		const wait = Math.min(kase.nextAttemptAt.getTime() - Date.now(), MAX_INLINE_WAIT_MS);
		await (deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms))))(wait);
	}
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
	return resolve({
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
	});
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
	if (isTaxonomyDrift(analysis)) {
		// The same disposition the inventory gives: a versioning defect, not work — no claim, no call, nothing rewritten.
		console.error(
			`[sentiment] taxonomy drift on analysis ${analysis.id}: ${analysis.classifierVersion} row carries ${analysis.taxonomyVersion}, current is ${SENTIMENT_TAXONOMY_VERSION}; a taxonomy change ships as a classifier version`,
		);
		return {
			status: "skipped",
			reason: `taxonomy drift: ${analysis.classifierVersion} analysis carries ${analysis.taxonomyVersion}, expected ${SENTIMENT_TAXONOMY_VERSION}`,
		};
	}
	const entities = await (deps.loadEntities ?? loadDetectableEntities)(run.brandId, "historical");
	const mentions = await resolveMentions(run, entities, deps);
	const candidates = candidatesFromMentions(mentions, entities);
	const body = mentions.length === 0 ? null : run.answerBody;
	if (body === null && analysis.status === "no_mentions") return { status: "already-completed" };
	const inputHash = body === null ? null : sentimentInputHash(body, candidates);
	const settled = inputHash === null ? null : await settledWithoutClaim(analysis, inputHash, deps);
	if (settled) return settled;

	// This is the resolution workflow itself, so it may resume a run it parked; a plain claim never does.
	const claimed = await (deps.claimAnalysis ?? claimAnalysis)(analysis.id, {
		allowFinished: true,
		resumeResolution: true,
	});
	if (!claimed.claimed) return { status: "claimed-elsewhere", analysisStatus: claimed.status };
	const claim = claimed.claim;

	if (body === null || inputHash === null) {
		const owned = await (deps.markAnalysis ?? markAnalysis)(claim, {
			status: "no_mentions",
			completedAt: new Date(),
			errorCode: null,
			errorMessage: null,
		});
		return owned ? { status: "no-mentions" } : { status: "claim-lost", generation: claim.generation };
	}

	return classifyAndPersist({ ...run, answerBody: body }, claim, mentions, candidates, inputHash, deps, options);
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
	return resumableEvidence(kase, inputHash, attempts) ? null : reviewOutcome(kase);
}
