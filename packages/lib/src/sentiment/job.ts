import { classifySentiment, type SentimentClassifierDeps, SentimentValidationError } from "./classifier";
import { type DetectableEntity, detectEntityMentions } from "./detector";
import {
	boundedErrorMessage,
	candidatesFromMentions,
	ensureAnalysis,
	loadDetectableEntities,
	loadMentions,
	loadRunForSentiment,
	markAnalysis,
	persistClassification,
	persistMentions,
	recordSentimentUsageEvent,
	type StoredMention,
	type StoredRunForSentiment,
} from "./store";
import {
	SENTIMENT_CLASSIFIER_VERSION,
	SENTIMENT_TAXONOMY_VERSION,
	type SentimentJobData,
	sentimentJobSchema,
} from "./types";

export type SentimentJobOutcome =
	| { status: "classified"; entities: number }
	| { status: "already-completed" }
	| { status: "no-mentions" }
	| { status: "skipped"; reason: string };

export interface SentimentJobDeps extends SentimentClassifierDeps {
	loadRun?: typeof loadRunForSentiment;
	loadEntities?: typeof loadDetectableEntities;
	loadMentions?: typeof loadMentions;
	persistMentions?: typeof persistMentions;
	ensureAnalysis?: typeof ensureAnalysis;
	markAnalysis?: typeof markAnalysis;
	classify?: typeof classifySentiment;
	persist?: typeof persistClassification;
	recordUsage?: typeof recordSentimentUsageEvent;
}

async function resolveMentions(
	run: StoredRunForSentiment,
	entities: DetectableEntity[],
	deps: SentimentJobDeps,
): Promise<StoredMention[]> {
	const mentions = await (deps.loadMentions ?? loadMentions)(run.id);
	if (mentions.length > 0 || run.answerBody === null) return mentions;
	// Repair path: a run that reached the queue without current-version
	// mention rows is detected here, deterministically, before any call.
	const detected = detectEntityMentions(run.answerBody, entities);
	return (deps.persistMentions ?? persistMentions)({ promptRunId: run.id, brandId: run.brandId, mentions: detected });
}

async function classifyAndPersist(
	run: StoredRunForSentiment & { answerBody: string },
	analysisId: string,
	mentions: StoredMention[],
	entities: DetectableEntity[],
	deps: SentimentJobDeps,
): Promise<number> {
	const candidates = candidatesFromMentions(mentions, entities);
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
		await recordUsage({ ...usage, provider: null, model: null, succeeded: false });
		throw error;
	}
}

/**
 * Worker-side core for one classify-sentiment job. Idempotent against
 * duplicates and restarts: the analysis row is re-checked after the queue's
 * singleton dedupe, a completed current-version analysis makes no provider
 * call, and observations are written atomically with the status flip.
 * Invalid or stale payloads are skipped without a call and without failing
 * the job; provider and validation errors mark the analysis `failed` with a
 * bounded reason and propagate so pg-boss applies its bounded retry policy —
 * nothing partial is ever written.
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
	if (analysis.status === "completed") return { status: "already-completed" };

	const mark = deps.markAnalysis ?? markAnalysis;
	await mark(analysis.id, { status: "processing", startedAt: new Date(), incrementAttempts: true });

	const entities = await (deps.loadEntities ?? loadDetectableEntities)(run.brandId, "historical");
	const mentions = await resolveMentions(run, entities, deps);
	if (mentions.length === 0 || run.answerBody === null) {
		await mark(analysis.id, { status: "no_mentions", completedAt: new Date(), errorCode: null, errorMessage: null });
		return { status: "no-mentions" };
	}

	const classified = await classifyAndPersist(
		{ ...run, answerBody: run.answerBody },
		analysis.id,
		mentions,
		entities,
		deps,
	);
	return { status: "classified", entities: classified };
}
