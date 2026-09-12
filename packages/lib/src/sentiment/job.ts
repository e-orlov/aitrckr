import {
	classifySentiment,
	type SentimentClassifierDeps,
	SentimentValidationError,
	sentimentInputHash,
} from "./classifier";
import { type DetectableEntity, detectEntityMentions } from "./detector";
import {
	boundedErrorMessage,
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
	SENTIMENT_MODEL,
	SENTIMENT_PROVIDER_ID,
	SENTIMENT_TAXONOMY_VERSION,
	type SentimentCandidate,
	type SentimentJobData,
	sentimentJobSchema,
} from "./types";

export type SentimentJobOutcome =
	| { status: "classified"; entities: number }
	| { status: "already-completed" }
	| { status: "claimed-elsewhere"; analysisStatus: string }
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

async function classifyAndPersist(
	run: StoredRunForSentiment & { answerBody: string },
	analysisId: string,
	mentions: StoredMention[],
	candidates: SentimentCandidate[],
	deps: SentimentJobDeps,
): Promise<number> {
	const recordUsage = deps.recordUsage ?? recordSentimentUsageEvent;
	const usage = { organizationId: run.organizationId, brandId: run.brandId, promptId: run.promptId };
	try {
		const classification = await (deps.classify ?? classifySentiment)({ answerBody: run.answerBody, candidates }, deps);
		await (deps.persist ?? persistClassification)({
			analysisId,
			promptRunId: run.id,
			brandId: run.brandId,
			mentions,
			classification,
		});
		await recordUsage({ ...usage, provider: classification.provider, model: classification.model, succeeded: true });
		return classification.entities.length;
	} catch (error) {
		const code = error instanceof SentimentValidationError ? error.code : "provider";
		await (deps.markAnalysis ?? markAnalysis)(analysisId, {
			status: "failed",
			errorCode: code,
			errorMessage: boundedErrorMessage(error),
		});
		await recordUsage({ ...usage, provider: SENTIMENT_PROVIDER_ID, model: SENTIMENT_MODEL, succeeded: false });
		throw error;
	}
}

/**
 * Worker-side core for one classify-sentiment job. Idempotent against
 * duplicates, restarts and racing workers: a completed analysis whose stored
 * input hash still matches the current classifier input makes no call; every
 * other state must first be claimed with a conditional update, and exactly
 * one claimant proceeds to the provider boundary while the others return a
 * non-calling outcome. Observations are written atomically with the status
 * flip. Invalid or stale payloads are skipped without a call and without
 * failing the job; provider and validation errors mark the analysis `failed`
 * with a bounded reason and propagate so pg-boss applies its bounded retry
 * policy — nothing partial is ever written.
 */
export async function runSentimentJob(data: unknown, deps: SentimentJobDeps = {}): Promise<SentimentJobOutcome> {
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

	const claim = await (deps.claimAnalysis ?? claimAnalysis)(analysis.id, { allowFinished: true });
	if (!claim.claimed) return { status: "claimed-elsewhere", analysisStatus: claim.status };

	const mark = deps.markAnalysis ?? markAnalysis;
	if (body === null) {
		await mark(analysis.id, { status: "no_mentions", completedAt: new Date(), errorCode: null, errorMessage: null });
		return { status: "no-mentions" };
	}

	const classified = await classifyAndPersist({ ...run, answerBody: body }, analysis.id, mentions, candidates, deps);
	return { status: "classified", entities: classified };
}
