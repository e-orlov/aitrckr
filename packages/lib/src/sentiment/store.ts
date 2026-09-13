import { and, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { db } from "../db/db";
import {
	brands,
	competitors,
	promptRunEntityMentions,
	promptRuns,
	prompts,
	type SentimentAnalysis,
	type SentimentDetection,
	sentimentAnalyses,
	sentimentAspectObservations,
	sentimentDetections,
	sentimentObservations,
	usageEvents,
} from "../db/schema";
import { estimateRunCostUsd } from "../usage/cost";
import type { SentimentClassification } from "./classifier";
import { brandEntity, competitorEntity, type DetectableEntity, type DetectedMention } from "./detector";
import { ClaimLostError } from "./errors";
import { extractAnswerBody } from "./text";
import {
	SENTIMENT_ASPECTS,
	SENTIMENT_CLAIM_TIMEOUT_SECONDS,
	SENTIMENT_CLASSIFIER_VERSION,
	SENTIMENT_DETECTOR_VERSION,
	SENTIMENT_MODEL,
	SENTIMENT_PROVIDER_ID,
	SENTIMENT_TAXONOMY_VERSION,
	type SentimentAnalysisStatus,
	type SentimentCandidate,
	type SentimentDetectionStatus,
} from "./types";

type Db = typeof db;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type Executor = Db | Tx;

/** The stored run the worker needs, without loading anything the queue payload already implies. */
export interface StoredRunForSentiment {
	id: string;
	promptId: string;
	brandId: string;
	provider: string | null;
	model: string;
	answerBody: string | null;
	organizationId: string;
}

export async function loadRunForSentiment(
	promptRunId: string,
	executor: Executor = db,
): Promise<StoredRunForSentiment | null> {
	const [row] = await executor
		.select({
			id: promptRuns.id,
			promptId: promptRuns.promptId,
			brandId: promptRuns.brandId,
			provider: promptRuns.provider,
			model: promptRuns.model,
			rawOutput: promptRuns.rawOutput,
			organizationId: brands.organizationId,
		})
		.from(promptRuns)
		.innerJoin(brands, eq(brands.id, promptRuns.brandId))
		.where(eq(promptRuns.id, promptRunId))
		.limit(1);
	if (!row) return null;
	return {
		id: row.id,
		promptId: row.promptId,
		brandId: row.brandId,
		provider: row.provider,
		model: row.model,
		answerBody: extractAnswerBody(row.rawOutput, row.provider, row.model),
		organizationId: row.organizationId,
	};
}

/**
 * The entities a brand's stored history can mention. `historical` includes
 * inactive competitors (their rows and ids are permanent since SENT-R0), which
 * is what the reconciliation and backfill paths need; new-run detection uses
 * the active roster only.
 */
export async function loadDetectableEntities(
	brandId: string,
	scope: "active" | "historical",
	executor: Executor = db,
): Promise<DetectableEntity[]> {
	const brand = await executor.query.brands.findFirst({ where: eq(brands.id, brandId) });
	if (!brand) return [];
	const rows = await executor.query.competitors.findMany({
		where:
			scope === "active"
				? and(eq(competitors.brandId, brandId), eq(competitors.active, true))
				: eq(competitors.brandId, brandId),
		orderBy: [competitors.createdAt, competitors.id],
	});
	return [brandEntity(brand), ...rows.map(competitorEntity)];
}

export interface StoredMention {
	id: string;
	key: string;
	entityType: "brand" | "competitor";
	competitorId: string | null;
	entityName: string;
}

/** What the detector concluded for one run; `mentions` is empty unless `status` is `mentions`. */
export interface DetectionResult {
	status: SentimentDetectionStatus;
	mentions: DetectedMention[];
}

export function detectionResultFor(answerBody: string | null, mentions: DetectedMention[]): DetectionResult {
	if (answerBody === null) return { status: "unextractable", mentions: [] };
	return { status: mentions.length > 0 ? "mentions" : "no_mentions", mentions };
}

/**
 * Idempotently persist the detector's mention rows for one run at the current
 * detector version. Rows for entities the newest pass no longer finds leave
 * the current projection: unreferenced ones are deleted, ones that
 * observations still reference are superseded (kept, invisible). Rows the
 * pass finds are refreshed in place (ids preserved) or reactivated, new rows
 * inserted. Part of `persistDetection`; exported for the DB verifier only.
 */
export async function persistMentions(
	args: { promptRunId: string; brandId: string; mentions: DetectedMention[] },
	executor: Executor = db,
): Promise<void> {
	const keys = args.mentions.map((m) => m.key);
	const existing = await executor.query.promptRunEntityMentions.findMany({
		where: eq(promptRunEntityMentions.promptRunId, args.promptRunId),
	});
	const stale = existing.filter((row) => !keys.includes(row.entityKey));
	if (stale.length > 0) {
		const referenced = new Set(
			(
				await executor
					.select({ mentionId: sentimentObservations.mentionId })
					.from(sentimentObservations)
					.where(
						inArray(
							sentimentObservations.mentionId,
							stale.map((row) => row.id),
						),
					)
			).map((row) => row.mentionId),
		);
		const deletable = stale.filter((row) => !referenced.has(row.id)).map((row) => row.id);
		if (deletable.length > 0)
			await executor.delete(promptRunEntityMentions).where(inArray(promptRunEntityMentions.id, deletable));
		const supersede = stale.filter((row) => referenced.has(row.id) && row.supersededAt === null).map((row) => row.id);
		if (supersede.length > 0)
			await executor
				.update(promptRunEntityMentions)
				.set({ supersededAt: new Date() })
				.where(inArray(promptRunEntityMentions.id, supersede));
	}
	for (const mention of args.mentions) {
		await executor
			.insert(promptRunEntityMentions)
			.values({
				promptRunId: args.promptRunId,
				brandId: args.brandId,
				entityType: mention.entityType,
				competitorId: mention.competitorId,
				entityKey: mention.key,
				entityName: mention.entityName,
				detectorVersion: SENTIMENT_DETECTOR_VERSION,
				matchedTerms: mention.matchedTerms,
			})
			.onConflictDoUpdate({
				target: [promptRunEntityMentions.promptRunId, promptRunEntityMentions.entityKey],
				set: {
					entityName: mention.entityName,
					detectorVersion: SENTIMENT_DETECTOR_VERSION,
					matchedTerms: mention.matchedTerms,
					detectedAt: new Date(),
					supersededAt: null,
				},
			});
	}
}

/**
 * Persist one completed detector pass atomically: the run-level receipt for
 * the current detector version and the mention rows it found, in one
 * transaction, so a receipt can never exist without its rows or vice versa.
 * Returns the stored mention rows in detector order.
 */
export async function persistDetection(
	args: { promptRunId: string; brandId: string; result: DetectionResult },
	executor: Executor = db,
): Promise<StoredMention[]> {
	const write = async (tx: Executor) => {
		await tx
			.insert(sentimentDetections)
			.values({
				promptRunId: args.promptRunId,
				brandId: args.brandId,
				detectorVersion: SENTIMENT_DETECTOR_VERSION,
				status: args.result.status,
				mentionCount: args.result.mentions.length,
			})
			.onConflictDoUpdate({
				target: [sentimentDetections.promptRunId, sentimentDetections.detectorVersion],
				set: { status: args.result.status, mentionCount: args.result.mentions.length, detectedAt: new Date() },
			});
		await persistMentions({ promptRunId: args.promptRunId, brandId: args.brandId, mentions: args.result.mentions }, tx);
	};
	await executor.transaction((tx) => write(tx));
	return loadMentions(args.promptRunId, executor);
}

/** The current-version detection receipt for a run, or null when the run has not been scanned. */
export async function loadDetection(promptRunId: string, executor: Executor = db): Promise<SentimentDetection | null> {
	const row = await executor.query.sentimentDetections.findFirst({
		where: and(
			eq(sentimentDetections.promptRunId, promptRunId),
			eq(sentimentDetections.detectorVersion, SENTIMENT_DETECTOR_VERSION),
		),
	});
	return row ?? null;
}

/** The current mention projection of a run: current detector version and not superseded. */
export async function loadMentions(promptRunId: string, executor: Executor = db): Promise<StoredMention[]> {
	const rows = await executor.query.promptRunEntityMentions.findMany({
		where: and(
			eq(promptRunEntityMentions.promptRunId, promptRunId),
			eq(promptRunEntityMentions.detectorVersion, SENTIMENT_DETECTOR_VERSION),
			isNull(promptRunEntityMentions.supersededAt),
		),
		orderBy: [promptRunEntityMentions.detectedAt, promptRunEntityMentions.id],
	});
	return rows.map((row) => ({
		id: row.id,
		key: row.entityKey,
		entityType: row.entityType as "brand" | "competitor",
		competitorId: row.competitorId,
		entityName: row.entityName,
	}));
}

/** Classifier candidates for stored mentions, with the names the model may use to disambiguate. */
export function candidatesFromMentions(mentions: StoredMention[], entities: DetectableEntity[]): SentimentCandidate[] {
	const byKey = new Map(entities.map((entity) => [entity.key, entity]));
	return mentions.map((mention) => {
		const entity = byKey.get(mention.key);
		return {
			key: mention.key,
			entityType: mention.entityType,
			competitorId: mention.competitorId,
			name: entity?.name ?? mention.entityName,
			aliases: entity?.aliases ?? [],
		};
	});
}

/** Get-or-create the current-version analysis row for a run (status `pending` on creation). */
export async function ensureAnalysis(
	args: { promptRunId: string; brandId: string },
	executor: Executor = db,
): Promise<SentimentAnalysis> {
	await executor
		.insert(sentimentAnalyses)
		.values({
			promptRunId: args.promptRunId,
			brandId: args.brandId,
			classifierVersion: SENTIMENT_CLASSIFIER_VERSION,
			taxonomyVersion: SENTIMENT_TAXONOMY_VERSION,
			status: "pending",
		})
		.onConflictDoNothing({ target: [sentimentAnalyses.promptRunId, sentimentAnalyses.classifierVersion] });
	const row = await executor.query.sentimentAnalyses.findFirst({
		where: and(
			eq(sentimentAnalyses.promptRunId, args.promptRunId),
			eq(sentimentAnalyses.classifierVersion, SENTIMENT_CLASSIFIER_VERSION),
		),
	});
	if (!row) throw new Error(`sentiment analysis row missing for run ${args.promptRunId}`);
	return row;
}

/**
 * A completed analysis is current only when it was produced under the
 * current taxonomy for exactly the classifier input that would be sent now.
 * Anything else — older taxonomy, missing hash, changed entity set or names —
 * makes the run eligible for reclassification instead of counting as done.
 */
export function isAnalysisCurrent(analysis: SentimentAnalysis, expectedInputHash: string): boolean {
	return (
		analysis.status === "completed" &&
		analysis.classifierVersion === SENTIMENT_CLASSIFIER_VERSION &&
		analysis.taxonomyVersion === SENTIMENT_TAXONOMY_VERSION &&
		analysis.inputHash === expectedInputHash
	);
}

export type ClaimOutcome =
	| { claimed: true; attempts: number; claim: AnalysisClaim }
	| { claimed: false; status: SentimentAnalysisStatus };

/** Ownership of one attempt: every later write is fenced on the row still carrying this generation. */
export interface AnalysisClaim {
	analysisId: string;
	generation: number;
}

/**
 * Atomically claim the analysis for one provider call. Exactly one of any
 * number of racing workers wins: the conditional UPDATE only matches a row
 * that is `pending`, `failed`, a finished row that is no longer current
 * (`allowFinished`: `completed`/`no_mentions`), or a `processing` claim older than the claim timeout
 * (an abandoned worker). Losers see the row's current status and make no
 * call. The winner receives the incremented claim generation; a claimant
 * whose lease was taken over later fails every fenced write. Runs in its own
 * statement (autocommit) so the claim is visible to other sessions before
 * the provider boundary.
 */
export async function claimAnalysis(
	analysisId: string,
	options: { allowFinished: boolean },
	executor: Executor = db,
): Promise<ClaimOutcome> {
	const staleBefore = new Date(Date.now() - SENTIMENT_CLAIM_TIMEOUT_SECONDS * 1000);
	const claimable = or(
		inArray(
			sentimentAnalyses.status,
			options.allowFinished ? ["pending", "failed", "completed", "no_mentions"] : ["pending", "failed"],
		),
		and(eq(sentimentAnalyses.status, "processing"), lt(sentimentAnalyses.startedAt, staleBefore)),
	);
	const [row] = await executor
		.update(sentimentAnalyses)
		.set({
			status: "processing",
			startedAt: new Date(),
			attempts: sql`${sentimentAnalyses.attempts} + 1`,
			claimGeneration: sql`${sentimentAnalyses.claimGeneration} + 1`,
			provider: SENTIMENT_PROVIDER_ID,
			model: SENTIMENT_MODEL,
			webSearch: true,
			updatedAt: new Date(),
		})
		.where(and(eq(sentimentAnalyses.id, analysisId), claimable))
		.returning({ attempts: sentimentAnalyses.attempts, generation: sentimentAnalyses.claimGeneration });
	if (row) return { claimed: true, attempts: row.attempts, claim: { analysisId, generation: row.generation } };
	const current = await executor.query.sentimentAnalyses.findFirst({ where: eq(sentimentAnalyses.id, analysisId) });
	return { claimed: false, status: (current?.status ?? "pending") as SentimentAnalysisStatus };
}

/**
 * Terminal status write for one attempt, fenced on the claim generation.
 * Returns false — and writes nothing — when another attempt has claimed the
 * row since, so a stale claimant can never overwrite a newer result.
 */
export async function markAnalysis(
	claim: AnalysisClaim,
	patch: Partial<{
		status: SentimentAnalysisStatus;
		errorCode: string | null;
		errorMessage: string | null;
		completedAt: Date | null;
	}>,
	executor: Executor = db,
): Promise<boolean> {
	const rows = await executor
		.update(sentimentAnalyses)
		.set({ ...patch, updatedAt: new Date() })
		.where(and(eq(sentimentAnalyses.id, claim.analysisId), eq(sentimentAnalyses.claimGeneration, claim.generation)))
		.returning({ id: sentimentAnalyses.id });
	return rows.length === 1;
}

/**
 * Persist a validated classification atomically: the analysis flips to
 * `completed` — fenced on the claim generation, which also locks the row —
 * then its observations are replaced by the new set with their aspect rows.
 * A stale claimant gets `ClaimLostError` before any observation is touched.
 */
export async function persistClassification(args: {
	claim: AnalysisClaim;
	promptRunId: string;
	brandId: string;
	mentions: StoredMention[];
	classification: SentimentClassification;
}): Promise<void> {
	const mentionByKey = new Map(args.mentions.map((m) => [m.key, m]));
	await db.transaction(async (tx) => {
		const owned = await tx
			.update(sentimentAnalyses)
			.set({
				status: "completed",
				provider: args.classification.provider,
				model: args.classification.model,
				webSearch: args.classification.webSearch,
				taxonomyVersion: args.classification.taxonomyVersion,
				inputHash: args.classification.inputHash,
				errorCode: null,
				errorMessage: null,
				completedAt: new Date(),
				updatedAt: new Date(),
			})
			.where(
				and(
					eq(sentimentAnalyses.id, args.claim.analysisId),
					eq(sentimentAnalyses.claimGeneration, args.claim.generation),
				),
			)
			.returning({ id: sentimentAnalyses.id });
		if (owned.length !== 1) throw new ClaimLostError(args.claim);
		await tx.delete(sentimentObservations).where(eq(sentimentObservations.analysisId, args.claim.analysisId));
		for (const entity of args.classification.entities) {
			const mention = mentionByKey.get(entity.key);
			if (!mention) throw new Error(`classified entity "${entity.key}" has no mention row`);
			const [observation] = await tx
				.insert(sentimentObservations)
				.values({
					analysisId: args.claim.analysisId,
					mentionId: mention.id,
					promptRunId: args.promptRunId,
					brandId: args.brandId,
					entityType: mention.entityType,
					competitorId: mention.competitorId,
					entityKey: mention.key,
					score: entity.score,
					category: entity.category,
					confidence: entity.confidence.toFixed(3),
					evidence: entity.evidence,
				})
				.returning({ id: sentimentObservations.id });
			if (entity.aspects.length > 0) {
				await tx.insert(sentimentAspectObservations).values(
					entity.aspects.map((aspect) => ({
						observationId: observation.id,
						taxonomyVersion: args.classification.taxonomyVersion,
						aspectKey: aspect.key,
						aspectLabel: SENTIMENT_ASPECTS[aspect.key].label,
						score: aspect.score,
						category: aspect.category,
						confidence: aspect.confidence.toFixed(3),
						evidence: aspect.evidence,
					})),
				);
			}
		}
	});
}

/**
 * Billing-grade attribution for one classifier attempt, success or failure.
 * A failed attempt is still attributed to the locked provider/model — the
 * request went out — without any credential or response detail. Never
 * throws: attribution must not break the job.
 */
export async function recordSentimentUsageEvent(args: {
	organizationId: string;
	brandId: string;
	promptId: string;
	provider: string;
	model: string | null;
	succeeded: boolean;
}): Promise<void> {
	try {
		const cost = estimateRunCostUsd(args.provider, true);
		await db.insert(usageEvents).values({
			organizationId: args.organizationId,
			brandId: args.brandId,
			promptId: args.promptId,
			eventType: args.succeeded ? "sentiment_classification" : "sentiment_classification_failed",
			provider: args.provider,
			model: args.model,
			webSearchEnabled: true,
			units: 1,
			estimatedCostUsd: cost === null ? null : cost.toFixed(6),
		});
	} catch (error) {
		console.error("Failed to record sentiment usage event:", error);
	}
}

/** Prompt text lookup used by evidence/backfill reporting. */
export async function loadPromptValue(promptId: string): Promise<string | null> {
	const row = await db.query.prompts.findFirst({ where: eq(prompts.id, promptId), columns: { value: true } });
	return row?.value ?? null;
}
