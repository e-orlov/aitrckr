import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "../db/db";
import {
	brands,
	competitors,
	promptRunEntityMentions,
	promptRuns,
	prompts,
	type SentimentAnalysis,
	sentimentAnalyses,
	sentimentAspectObservations,
	sentimentObservations,
	usageEvents,
} from "../db/schema";
import { estimateRunCostUsd } from "../usage/cost";
import type { SentimentClassification } from "./classifier";
import { brandEntity, competitorEntity, type DetectableEntity, type DetectedMention } from "./detector";
import { extractAnswerBody } from "./text";
import {
	SENTIMENT_ASPECTS,
	SENTIMENT_CLASSIFIER_VERSION,
	SENTIMENT_DETECTOR_VERSION,
	SENTIMENT_TAXONOMY_VERSION,
	type SentimentCandidate,
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

/**
 * Idempotently persist the detector's result for one run at the current
 * detector version: rows for entities no longer detected at this version are
 * removed, existing rows are refreshed in place (ids preserved), new rows
 * inserted. Returns the stored rows in detector order.
 */
export async function persistMentions(
	args: { promptRunId: string; brandId: string; mentions: DetectedMention[] },
	executor: Executor = db,
): Promise<StoredMention[]> {
	const keys = args.mentions.map((m) => m.key);
	const existing = await executor.query.promptRunEntityMentions.findMany({
		where: eq(promptRunEntityMentions.promptRunId, args.promptRunId),
	});
	const stale = existing.filter((row) => !keys.includes(row.entityKey));
	if (stale.length > 0) {
		// Observations reference mention rows; a mention that disappeared under
		// a newer detector keeps its row when it already has observations so the
		// audit trail survives — it is simply marked with the old detector version.
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
				},
			});
	}
	return loadMentions(args.promptRunId, executor);
}

export async function loadMentions(promptRunId: string, executor: Executor = db): Promise<StoredMention[]> {
	const rows = await executor.query.promptRunEntityMentions.findMany({
		where: and(
			eq(promptRunEntityMentions.promptRunId, promptRunId),
			eq(promptRunEntityMentions.detectorVersion, SENTIMENT_DETECTOR_VERSION),
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

export async function markAnalysis(
	analysisId: string,
	patch: Partial<{
		status: "pending" | "processing" | "completed" | "no_mentions" | "failed";
		errorCode: string | null;
		errorMessage: string | null;
		startedAt: Date | null;
		completedAt: Date | null;
	}> & { incrementAttempts?: boolean },
	executor: Executor = db,
): Promise<void> {
	const { incrementAttempts, ...fields } = patch;
	await executor
		.update(sentimentAnalyses)
		.set({
			...fields,
			...(incrementAttempts ? { attempts: sql`${sentimentAnalyses.attempts} + 1` } : {}),
			updatedAt: new Date(),
		})
		.where(eq(sentimentAnalyses.id, analysisId));
}

const ERROR_MESSAGE_MAX = 500;
export function boundedErrorMessage(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	return message.length > ERROR_MESSAGE_MAX ? `${message.slice(0, ERROR_MESSAGE_MAX - 1)}…` : message;
}

/**
 * Persist a validated classification atomically: observations and aspect rows
 * for every candidate, then the analysis flips to `completed`. Re-running for
 * the same analysis replaces its observations (the job is idempotent).
 */
export async function persistClassification(args: {
	analysisId: string;
	promptRunId: string;
	brandId: string;
	mentions: StoredMention[];
	classification: SentimentClassification;
}): Promise<void> {
	const mentionByKey = new Map(args.mentions.map((m) => [m.key, m]));
	await db.transaction(async (tx) => {
		const previous = await tx
			.select({ id: sentimentObservations.id })
			.from(sentimentObservations)
			.where(eq(sentimentObservations.analysisId, args.analysisId));
		if (previous.length > 0) {
			const ids = previous.map((row) => row.id);
			await tx.delete(sentimentAspectObservations).where(inArray(sentimentAspectObservations.observationId, ids));
			await tx.delete(sentimentObservations).where(inArray(sentimentObservations.id, ids));
		}
		for (const entity of args.classification.entities) {
			const mention = mentionByKey.get(entity.key);
			if (!mention) throw new Error(`classified entity "${entity.key}" has no mention row`);
			const [observation] = await tx
				.insert(sentimentObservations)
				.values({
					analysisId: args.analysisId,
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
		await tx
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
			.where(eq(sentimentAnalyses.id, args.analysisId));
	});
}

/**
 * Billing-grade attribution for one classifier call, success or failure.
 * Never throws — attribution must not break the job.
 */
export async function recordSentimentUsageEvent(args: {
	organizationId: string;
	brandId: string;
	promptId: string;
	provider: string | null;
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
