import type { StructuredResearchRequestSummary, StructuredResearchUsage } from "../providers/types";
import {
	classifySentiment,
	countFilteredClaimCodes,
	type SentimentClassifierDeps,
	sentimentInputHash,
} from "./classifier";
import { type DetectableEntity, detectEntityMentions } from "./detector";
import type { SentimentDiagnostic } from "./diagnostics";
import {
	ClaimLostError,
	type SafeSentimentError,
	SentimentJobError,
	sanitizeSentimentError,
	storedErrorMessage,
} from "./errors";
import type { PaidResponseEnvelope } from "./errors-validation";
import {
	type AnalysisClaim,
	candidatesFromMentions,
	claimAnalysis,
	detectionResultFor,
	ensureAnalysis,
	isAnalysisCurrent,
	isAnalysisTerminallyFailed,
	type loadAnalysisState,
	loadDetectableEntities,
	loadDetection,
	loadMentions,
	loadRunForSentiment,
	markAnalysis,
	persistClassification,
	persistDetection,
	recordSentimentUsageEvent,
	type StoredMention,
	type StoredRunForSentiment,
} from "./store";
import {
	SENTIMENT_CLASSIFIER_VERSION,
	SENTIMENT_TAXONOMY_VERSION,
	type SentimentCandidate,
	type SentimentJobData,
	sentimentJobSchema,
} from "./types";

export type SentimentJobOutcome =
	| {
			status: "classified";
			entities: number;
			/** Entity keys the classification covered: the brand key or competitor ids, never names or text. */
			entityKeys: string[];
			usage?: StructuredResearchUsage;
			request?: StructuredResearchRequestSummary;
			/** The provider's opaque generation id as validated by the classifier; null when none was reported or it was unsafe. */
			generationId: string | null;
			/** Aspect claims dropped as unsupported by the answer (classifier v5); the analysis is complete without them. */
			filteredClaimCount: number;
			/** The dropped claims by allow-listed validation code. */
			filteredClaimCodes: Record<string, number>;
	  }
	| { status: "already-completed" }
	| { status: "claimed-elsewhere"; analysisStatus: string }
	/** The attempt ran but a later attempt took the row over; nothing of this attempt was written. */
	| { status: "claim-lost"; generation: number }
	| { status: "no-mentions" }
	| { status: "skipped"; reason: string }
	/**
	 * The classifier rejected the provider's answer for this exact input. The
	 * analysis is failed with the input hash, the paid call (if any) is
	 * attributed, and the job completes: a retry would buy the same answer.
	 * Only a new classifier version or a changed input makes the run eligible.
	 */
	| {
			status: "terminal-validation-failure";
			code: string;
			/** False when the answer was refused before any request left (nothing was charged). */
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
 * Terminal write of a failed attempt. A validation failure remembers the
 * exact input it was rejected for so the same input is never sent again;
 * every other failure clears the hash so the row stays eligible.
 */
function failAttempt(
	claim: AnalysisClaim,
	safe: SafeSentimentError,
	deps: SentimentJobDeps,
	inputHash: string,
): Promise<boolean> {
	return (deps.markAnalysis ?? markAnalysis)(claim, {
		status: "failed",
		errorCode: safe.code,
		errorMessage: storedErrorMessage(safe),
		inputHash: safe.kind === "validation" ? inputHash : null,
	});
}

async function classifyAndPersist(
	run: StoredRunForSentiment & { answerBody: string },
	claim: AnalysisClaim,
	mentions: StoredMention[],
	candidates: SentimentCandidate[],
	deps: SentimentJobDeps,
	options: SentimentJobOptions,
): Promise<SentimentJobOutcome> {
	const recordUsage = deps.recordUsage ?? recordSentimentUsageEvent;
	const usage = { organizationId: run.organizationId, brandId: run.brandId, promptId: run.promptId };
	const inputHash = sentimentInputHash(run.answerBody, candidates);
	let classification: Awaited<ReturnType<typeof classifySentiment>>;
	try {
		classification = await (deps.classify ?? classifySentiment)(
			{ answerBody: run.answerBody, candidates },
			deps,
			options.signal,
		);
	} catch (error) {
		// The request went out (or was cut off): attribute the attempt, then
		// record only the safe summary — the original error may quote a
		// response body, the answer or a header and is dropped here.
		const safe = sanitizeSentimentError(error);
		const owned = await failAttempt(claim, safe, deps, inputHash);
		if (safe.requestSent) {
			// A rejected answer was still paid for: the cost the provider
			// reported for it is what gets attributed, not the estimate.
			await recordUsage({
				...usage,
				provider: safe.provider,
				model: safe.model,
				succeeded: false,
				actualCostUsd: safe.envelope?.usage?.costUsd ?? null,
			});
		}
		if (!owned) return { status: "claim-lost", generation: claim.generation };
		if (safe.kind === "validation") {
			return {
				status: "terminal-validation-failure",
				code: safe.code,
				requestSent: safe.requestSent,
				diagnostic: safe.diagnostic,
				envelope: safe.envelope,
			};
		}
		throw new SentimentJobError(safe);
	}
	// From here on the provider has answered and charged for the call. Whatever
	// happens next, that call is attributed exactly once, as the paid success it
	// was, with the cost the provider reported — and a failure to attribute it
	// never replaces the error that made the attempt fail.
	let attributed = false;
	const attributePaidCall = async () => {
		if (attributed) return;
		attributed = true;
		try {
			await recordUsage({
				...usage,
				provider: classification.provider,
				model: classification.model,
				succeeded: true,
				actualCostUsd: classification.usage?.costUsd ?? null,
			});
		} catch (error) {
			console.error("sentiment usage attribution failed:", error instanceof Error ? error.name : typeof error);
		}
	};
	try {
		await (deps.persist ?? persistClassification)({
			claim,
			promptRunId: run.id,
			brandId: run.brandId,
			mentions,
			classification,
		});
	} catch (error) {
		await attributePaidCall();
		if (error instanceof ClaimLostError) return { status: "claim-lost", generation: claim.generation };
		// The transaction rolled back: no observation exists and the analysis
		// is still ours; it ends as failed with the persistence code (or the
		// abort code when the caller cancelled between answer and write),
		// never as a provider failure.
		const safe = sanitizeSentimentError(error, "persist");
		const owned = await failAttempt(claim, safe, deps, inputHash);
		if (!owned) return { status: "claim-lost", generation: claim.generation };
		throw new SentimentJobError(safe);
	}
	await attributePaidCall();
	return {
		status: "classified",
		entities: classification.entities.length,
		entityKeys: classification.entities.map((entity) => entity.key),
		usage: classification.usage,
		request: classification.request,
		generationId: classification.generationId ?? null,
		filteredClaimCount: classification.filteredClaims.length,
		filteredClaimCodes: countFilteredClaimCodes(classification.filteredClaims),
	};
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
 * persistence errors mark the analysis `failed` with a safe summary and
 * propagate as `SentimentJobError` so pg-boss applies its bounded retry
 * policy; an answer whose mandatory overall verdicts the classifier rejects is
 * terminal for this exact input and completes the job instead — nothing is
 * written either way. An answer with valid overall verdicts completes with
 * every aspect claim the answer supports; unsupported aspect claims are
 * dropped and recorded, never persisted as placeholders.
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
	if (body !== null) {
		const inputHash = sentimentInputHash(body, candidates);
		if (isAnalysisCurrent(analysis, inputHash)) return { status: "already-completed" };
		if (isAnalysisTerminallyFailed(analysis, inputHash)) {
			return {
				status: "skipped",
				reason: `terminal validation failure ${analysis.errorCode ?? "unknown"} for this exact input; eligible again only under a new classifier version or a changed input`,
			};
		}
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
