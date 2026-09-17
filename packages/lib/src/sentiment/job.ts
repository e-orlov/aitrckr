import type { Provider, StructuredResearchRequestSummary, StructuredResearchUsage } from "../providers/types";
import { StructuredResearchResponseError } from "../providers/types";
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
	ensureAnalysis,
	ensureResolutionCase,
	finishProviderAttempt,
	isAnalysisCurrent,
	type loadAnalysisState,
	loadDetectableEntities,
	loadDetection,
	loadMentions,
	loadProviderAttempts,
	loadRunForSentiment,
	markAnalysis,
	openProviderAttempt,
	persistClassification,
	persistDetection,
	recordSentimentUsageEvent,
	type StoredMention,
	type StoredResolutionCase,
	type StoredRunForSentiment,
	updateResolutionCase,
} from "./store";
import {
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
	/** A provider request left without a recorded outcome (crash mid-call): no automatic call until an operator reconciles it. */
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
 * `processing` claim with the safe code so the run stays eligible for the next
 * job run. Never a product outcome; the resolution case carries the workflow.
 */
function failAttempt(claim: AnalysisClaim, safe: SafeSentimentError, deps: SentimentJobDeps): Promise<boolean> {
	return (deps.markAnalysis ?? markAnalysis)(claim, {
		status: "failed",
		errorCode: safe.code,
		errorMessage: storedErrorMessage(safe),
		inputHash: null,
	});
}

const MAX_INLINE_WAIT_MS = 30_000;

/** Thrown inside the workflow to leave the automatic path; never escapes `resolve`. */
class HandOver extends Error {
	constructor(readonly reason: ReviewReason) {
		super(`resolution handed over: ${reason}`);
		this.name = "HandOver";
	}
}

interface Workflow {
	run: StoredRunForSentiment & { answerBody: string };
	claim: AnalysisClaim;
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
}

/**
 * One provider request with its ledger row and attribution: the intent is
 * recorded before the request leaves; a paid answer (whatever becomes of it)
 * is charged to the case and attributed exactly once; a transport failure is
 * an unpaid attempt that parks the case in `retry_wait` and re-throws for the
 * queue's bounded retry. The budget is checked before every request.
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
		// The job was cancelled (shutdown, expiry, canary deadline): no further paid request; the case waits.
		const safe = sanitizeSentimentError(new DOMException("job aborted before the request", "AbortError"));
		await (w.deps.updateResolutionCase ?? updateResolutionCase)(
			w.claim.analysisId,
			{
				status: "retry_wait",
				nextAttemptAt: new Date(Date.now() + backoffMs(1, w.policy)),
			},
			w.claim,
		);
		await failAttempt(w.claim, safe, w.deps);
		throw new SentimentJobError({ ...safe, requestSent: false });
	}
	const attempt = await (w.deps.openProviderAttempt ?? openProviderAttempt)({
		analysisId: w.claim.analysisId,
		phase,
		inputHash: w.inputHash,
		claim: w.claim,
	});
	const usage = { organizationId: w.run.organizationId, brandId: w.run.brandId, promptId: w.run.promptId };
	const recordUsage = w.deps.recordUsage ?? recordSentimentUsageEvent;
	const finish = w.deps.finishProviderAttempt ?? finishProviderAttempt;
	const charge = w.deps.chargeResolutionCase ?? chargeResolutionCase;
	let answer: PaidAnswer<T>;
	try {
		answer = await request();
	} catch (error) {
		const safe = sanitizeSentimentError(error);
		if (safe.requestSent && safe.envelope?.generationId) {
			// The provider answered and charged, but the answer could not be shaped: a paid, unusable attempt.
			const cost = safe.envelope.usage?.costUsd ?? null;
			await finish(attempt.id, { outcome: "rejected", generationId: safe.envelope.generationId, actualCostUsd: cost });
			await recordUsage({
				...usage,
				provider: safe.provider,
				model: safe.model,
				succeeded: false,
				actualCostUsd: cost,
			});
			const charged = await charge(w.claim.analysisId, cost, w.claim);
			w.paidCalls = charged.automatedProviderCalls;
			w.costUsd = charged.totalActualCostUsd;
			throw new HandOver("contract-defect");
		}
		await finish(attempt.id, { outcome: safe.kind === "aborted" ? "aborted" : "provider-error" });
		w.consecutiveFailures += 1;
		await (w.deps.updateResolutionCase ?? updateResolutionCase)(
			w.claim.analysisId,
			{
				status: "retry_wait",
				nextAttemptAt: new Date(Date.now() + backoffMs(w.consecutiveFailures, w.policy)),
			},
			w.claim,
		);
		await failAttempt(w.claim, safe, w.deps);
		throw new SentimentJobError(safe);
	}
	await finish(attempt.id, {
		outcome: usable(answer.value) ? "accepted" : "rejected",
		generationId: answer.generationId,
		actualCostUsd: answer.costUsd,
	});
	try {
		await recordUsage({
			...usage,
			provider: w.provider.id,
			model: SENTIMENT_MODEL,
			succeeded: true,
			actualCostUsd: answer.costUsd,
		});
	} catch (error) {
		console.error("sentiment usage attribution failed:", error instanceof Error ? error.name : typeof error);
	}
	const charged = await charge(w.claim.analysisId, answer.costUsd, w.claim);
	w.paidCalls = charged.automatedProviderCalls;
	w.costUsd = charged.totalActualCostUsd;
	w.consecutiveFailures = 0;
	return answer.value;
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
	// Only this workflow instance counts: attempts before the case was (re)opened belong to an earlier run.
	const initialAnswers = attempts.filter(
		(a) => a.phase === "classify" && a.generationId !== null && a.startedAt.getTime() >= w.kase.createdAt.getTime(),
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
			return { value, generationId: value.generationId ?? null, costUsd: value.usage?.costUsd ?? null };
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
			return { ...raw, value: toClassificationResult(schema.parse(raw.value)) };
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
		// keeps its candidate for the next run and waits.
		const safe = sanitizeSentimentError(error, "persist");
		await (w.deps.updateResolutionCase ?? updateResolutionCase)(
			w.claim.analysisId,
			{
				status: "retry_wait",
				nextAttemptAt: new Date(Date.now() + backoffMs(1, w.policy)),
			},
			w.claim,
		);
		const owned = await failAttempt(w.claim, safe, w.deps);
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

async function handOver(
	w: Workflow,
	reason: ReviewReason,
	candidate: SentimentClassificationResult | null,
	unresolved: UnresolvedTarget[],
): Promise<SentimentJobOutcome> {
	await (w.deps.updateResolutionCase ?? updateResolutionCase)(
		w.claim.analysisId,
		{
			status: "awaiting_review",
			reviewReason: reason,
			provisionalResult: candidate,
			unresolvedTargets: unresolved,
			nextAttemptAt: null,
		},
		w.claim,
	);
	await (w.deps.markAnalysis ?? markAnalysis)(w.claim, {
		status: "failed",
		errorCode: "awaiting-review",
		errorMessage: null,
		inputHash: null,
	});
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
		// A lease taken over by a newer attempt: nothing of this attempt is written further.
		if (error instanceof ClaimLostError) return { status: "claim-lost", generation: w.claim.generation };
		if (!(error instanceof HandOver)) throw error;
		const unresolved = candidate ? assess(w, candidate).unresolved : [];
		try {
			return await handOver(w, error.reason, candidate, [...unresolved, ...pending]);
		} catch (inner) {
			if (inner instanceof ClaimLostError) return { status: "claim-lost", generation: w.claim.generation };
			throw inner;
		}
	}
}

function reviewOutcome(kase: StoredResolutionCase): SentimentJobOutcome {
	if (kase.status === "awaiting_reconciliation") return { status: "awaiting-reconciliation", attemptOrdinal: 0 };
	return {
		status: "awaiting-review",
		reason: (kase.reviewReason as ReviewReason | null) ?? "call-limit",
		paidCalls: kase.automatedProviderCalls,
		costUsd: Number(kase.totalActualCostUsd),
		unresolved: ((kase.unresolvedTargets as UnresolvedTarget[]) ?? []).length,
	};
}

async function classifyAndPersist(
	run: StoredRunForSentiment & { answerBody: string },
	claim: AnalysisClaim,
	mentions: StoredMention[],
	candidates: SentimentCandidate[],
	deps: SentimentJobDeps,
	options: SentimentJobOptions,
): Promise<SentimentJobOutcome> {
	const policy: ResolutionPolicy = { ...RESOLUTION_POLICY, ...deps.resolutionPolicy };
	const inputHash = sentimentInputHash(run.answerBody, candidates);
	let kase = await (deps.ensureResolutionCase ?? ensureResolutionCase)(claim.analysisId, inputHash);
	const mark = deps.markAnalysis ?? markAnalysis;
	if (kase.status === "resolved") {
		// A resolved case whose analysis is being processed again (stale lease recovery,
		// deliberate reprocessing): a fresh workflow, not a replay of the old candidate.
		const startedAt = new Date();
		const fresh = {
			status: "open" as const,
			provisionalResult: null,
			unresolvedTargets: [],
			nextAttemptAt: null,
			reviewReason: null,
			createdAt: startedAt,
			automatedProviderCalls: 0,
			totalActualCostUsd: "0",
		};
		await (deps.updateResolutionCase ?? updateResolutionCase)(claim.analysisId, fresh, claim);
		kase = { ...kase, ...fresh };
	}
	if (kase.status === "awaiting_review" || kase.status === "awaiting_reconciliation") {
		await mark(claim, {
			status: "failed",
			errorCode: kase.status.replace("_", "-"),
			errorMessage: null,
			inputHash: null,
		});
		return reviewOutcome(kase);
	}
	const attempts = await (deps.loadProviderAttempts ?? loadProviderAttempts)(claim.analysisId);
	const dangling = attempts.find((a) => a.outcome === "sending");
	if (dangling) {
		await (deps.updateResolutionCase ?? updateResolutionCase)(
			claim.analysisId,
			{
				status: "awaiting_reconciliation",
				reviewReason: "unknown-provider-outcome",
				nextAttemptAt: null,
			},
			claim,
		);
		await mark(claim, { status: "failed", errorCode: "awaiting-reconciliation", errorMessage: null, inputHash: null });
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
		const safe = sanitizeSentimentError(error);
		await failAttempt(claim, safe, deps);
		throw new SentimentJobError({ ...safe, requestSent: false });
	}
	const analysis = analyzeAnswerRanges(run.answerBody);
	const anchors = segmentAnswer(run.answerBody, analysis);
	let consecutiveFailures = 0;
	for (let i = attempts.length - 1; i >= 0; i--) {
		if (attempts[i].outcome !== "provider-error" && attempts[i].outcome !== "aborted") break;
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
 * `SentimentJobError` so pg-boss applies its bounded retry policy; the only
 * successful outcome is a verified result persisted in one transaction, and
 * an exhausted automatic budget hands the run to the operator as an open
 * `awaiting_review` case (ADR-SENT-01-GROUNDED-COMPLETION, Amendment B).
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
	const entities = await (deps.loadEntities ?? loadDetectableEntities)(run.brandId, "historical");
	const mentions = await resolveMentions(run, entities, deps);
	const candidates = candidatesFromMentions(mentions, entities);
	const body = mentions.length === 0 ? null : run.answerBody;
	if (body === null && analysis.status === "no_mentions") return { status: "already-completed" };
	if (body !== null && isAnalysisCurrent(analysis, sentimentInputHash(body, candidates))) {
		return { status: "already-completed" };
	}

	const claimed = await (deps.claimAnalysis ?? claimAnalysis)(analysis.id, { allowFinished: true });
	if (!claimed.claimed) return { status: "claimed-elsewhere", analysisStatus: claimed.status };
	const claim = claimed.claim;

	if (body === null) {
		const owned = await (deps.markAnalysis ?? markAnalysis)(claim, {
			status: "no_mentions",
			completedAt: new Date(),
			errorCode: null,
			errorMessage: null,
		});
		return owned ? { status: "no-mentions" } : { status: "claim-lost", generation: claim.generation };
	}

	return classifyAndPersist({ ...run, answerBody: body }, claim, mentions, candidates, deps, options);
}
