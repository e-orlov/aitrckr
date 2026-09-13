import { classifySentiment, type SentimentClassifierDeps, sentimentInputHash } from "./classifier";
import { type DetectableEntity, detectEntityMentions } from "./detector";
import {
	ClaimLostError,
	type SafeSentimentError,
	SentimentJobError,
	safeErrorMessage,
	sanitizeSentimentError,
} from "./errors";
import {
	type AnalysisClaim,
	candidatesFromMentions,
	claimAnalysis,
	detectionResultFor,
	ensureAnalysis,
	isAnalysisCurrent,
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
	| { status: "classified"; entities: number }
	| { status: "already-completed" }
	| { status: "claimed-elsewhere"; analysisStatus: string }
	/** The attempt ran but a later attempt took the row over; nothing of this attempt was written. */
	| { status: "claim-lost"; generation: number }
	| { status: "no-mentions" }
	| { status: "skipped"; reason: string };

export interface SentimentJobDeps extends SentimentClassifierDeps {
	loadRun?: typeof loadRunForSentiment;
	loadEntities?: typeof loadDetectableEntities;
	loadDetection?: typeof loadDetection;
	loadMentions?: typeof loadMentions;
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

function failAttempt(claim: AnalysisClaim, safe: SafeSentimentError, deps: SentimentJobDeps): Promise<boolean> {
	return (deps.markAnalysis ?? markAnalysis)(claim, {
		status: "failed",
		errorCode: safe.code,
		errorMessage: safeErrorMessage(safe),
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
		const owned = await failAttempt(claim, safe, deps);
		await recordUsage({ ...usage, provider: safe.provider, model: safe.model, succeeded: false });
		if (!owned) return { status: "claim-lost", generation: claim.generation };
		throw new SentimentJobError(safe);
	}
	try {
		await (deps.persist ?? persistClassification)({
			claim,
			promptRunId: run.id,
			brandId: run.brandId,
			mentions,
			classification,
		});
	} catch (error) {
		if (error instanceof ClaimLostError) {
			await recordUsage({ ...usage, provider: classification.provider, model: classification.model, succeeded: true });
			return { status: "claim-lost", generation: claim.generation };
		}
		const safe = sanitizeSentimentError(error);
		await failAttempt(claim, safe, deps);
		throw new SentimentJobError(safe);
	}
	await recordUsage({ ...usage, provider: classification.provider, model: classification.model, succeeded: true });
	return { status: "classified", entities: classification.entities.length };
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
 * skipped without a call and without failing the job; provider and
 * validation errors mark the analysis `failed` with a safe summary and
 * propagate as `SentimentJobError` so pg-boss applies its bounded retry
 * policy — nothing partial is ever written.
 */
export async function runSentimentJob(
	data: unknown,
	deps: SentimentJobDeps = {},
	options: SentimentJobOptions = {},
): Promise<SentimentJobOutcome> {
	const parsed = sentimentJobSchema.safeParse(data);
	if (!parsed.success)
		return { status: "skipped", reason: `invalid payload: ${parsed.error.issues[0]?.message ?? "unknown"}` };
	const payload: SentimentJobData = parsed.data;
	if (payload.classifierVersion !== SENTIMENT_CLASSIFIER_VERSION) {
		return { status: "skipped", reason: `stale classifier version "${payload.classifierVersion}"` };
	}
	if (payload.taxonomyVersion !== SENTIMENT_TAXONOMY_VERSION) {
		return { status: "skipped", reason: `stale taxonomy version "${payload.taxonomyVersion}"` };
	}

	const run = await (deps.loadRun ?? loadRunForSentiment)(payload.promptRunId);
	if (!run) return { status: "skipped", reason: "prompt run not found" };

	const analysis = await (deps.ensureAnalysis ?? ensureAnalysis)({ promptRunId: run.id, brandId: run.brandId });
	const entities = await (deps.loadEntities ?? loadDetectableEntities)(run.brandId, "historical");
	const mentions = await resolveMentions(run, entities, deps);
	const candidates = candidatesFromMentions(mentions, entities);
	const body = mentions.length === 0 ? null : run.answerBody;
	if (body === null && analysis.status === "no_mentions") return { status: "already-completed" };
	if (body !== null && isAnalysisCurrent(analysis, sentimentInputHash(body, candidates)))
		return { status: "already-completed" };

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
