import { and, eq, inArray, isNull, lt, notExists, or, type SQL, type SQLWrapper, sql } from "drizzle-orm";
import { db } from "../db/db";
import {
	brands,
	competitors,
	promptRunEntityMentions,
	promptRuns,
	prompts,
	type SentimentAnalysis,
	type SentimentDetection,
	type SentimentResolutionCase,
	sentimentAnalyses,
	sentimentAspectObservations,
	sentimentDetections,
	sentimentFilteredClaims,
	sentimentObservations,
	sentimentProviderAttempts,
	sentimentResolutionCases,
	usageEvents,
} from "../db/schema";
import { estimateRunCostUsd } from "../usage/cost";
import type { SentimentClassification } from "./classifier";
import { brandEntity, competitorEntity, type DetectableEntity, type DetectedMention } from "./detector";
import { isValidationCode } from "./diagnostics";
import { ClaimLostError } from "./errors";
import type { ResolutionCaseStatus, ReviewReason, UnresolvedTarget } from "./resolution";
import { extractAnswerBody } from "./text";
import {
	compareSentimentEntities,
	SENTIMENT_ASPECT_KEYS,
	SENTIMENT_ASPECTS,
	SENTIMENT_CLAIM_TIMEOUT_SECONDS,
	SENTIMENT_CLASSIFIER_VERSION,
	SENTIMENT_DETECTOR_VERSION,
	SENTIMENT_MODEL,
	SENTIMENT_PROVIDER_ID,
	SENTIMENT_TAXONOMY_VERSION,
	type SentimentAnalysisStatus,
	type SentimentAspectKey,
	type SentimentCandidate,
	type SentimentClassificationResult,
	type SentimentDetectionStatus,
	sortSentimentEntities,
} from "./types";

type Db = typeof db;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
export type Executor = Db | Tx;

/** Run `fn` in one database transaction; the job's paid-answer settlement goes through this (injectable for offline tests). */
export const runInTransaction = <T>(fn: (tx: Executor) => Promise<T>): Promise<T> => db.transaction((tx) => fn(tx));

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

/**
 * The current mention projection of a run (current detector version, not
 * superseded) in the canonical entity order. Row timestamps and ids never
 * decide the order: rows written by one backfill transaction share a
 * timestamp and their ids are random, so any order derived from them would
 * differ between two databases holding the same data.
 */
export async function loadMentions(promptRunId: string, executor: Executor = db): Promise<StoredMention[]> {
	const rows = await executor.query.promptRunEntityMentions.findMany({
		where: and(
			eq(promptRunEntityMentions.promptRunId, promptRunId),
			eq(promptRunEntityMentions.detectorVersion, SENTIMENT_DETECTOR_VERSION),
			isNull(promptRunEntityMentions.supersededAt),
		),
	});
	return sortSentimentEntities(
		rows.map((row) => ({
			id: row.id,
			key: row.entityKey,
			entityType: row.entityType as "brand" | "competitor",
			competitorId: row.competitorId,
			entityName: row.entityName,
		})),
	);
}

/** Classifier candidates for stored mentions, in canonical order, with the names the model may use to disambiguate. */
export function candidatesFromMentions(mentions: StoredMention[], entities: DetectableEntity[]): SentimentCandidate[] {
	const byKey = new Map(entities.map((entity) => [entity.key, entity]));
	return sortSentimentEntities(mentions).map((mention) => {
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

/** What the current-version analysis of a run looks like right now, read-only; `null` when none exists. */
export interface StoredAnalysisState {
	status: SentimentAnalysisStatus;
	attempts: number;
	observations: number;
}

export async function loadAnalysisState(
	promptRunId: string,
	executor: Executor = db,
): Promise<StoredAnalysisState | null> {
	const row = await executor.query.sentimentAnalyses.findFirst({
		where: and(
			eq(sentimentAnalyses.promptRunId, promptRunId),
			eq(sentimentAnalyses.classifierVersion, SENTIMENT_CLASSIFIER_VERSION),
		),
	});
	if (!row) return null;
	const [{ n }] = await executor
		.select({ n: sql<number>`count(*)::int` })
		.from(sentimentObservations)
		.where(eq(sentimentObservations.analysisId, row.id));
	return { status: row.status as SentimentAnalysisStatus, attempts: row.attempts, observations: n };
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
 * current taxonomy for exactly the classifier input that would be sent now
 * and carries the verification marker. Anything else — older taxonomy,
 * missing hash, changed entity set or names, a completed row that was never
 * verified — makes the run eligible for reclassification instead of counting
 * as done.
 */
export function isAnalysisCurrent(analysis: SentimentAnalysis, expectedInputHash: string): boolean {
	return (
		analysis.status === "completed" &&
		analysis.classifierVersion === SENTIMENT_CLASSIFIER_VERSION &&
		analysis.taxonomyVersion === SENTIMENT_TAXONOMY_VERSION &&
		analysis.inputHash === expectedInputHash &&
		analysis.verifiedAt !== null
	);
}

/**
 * A failed analysis carrying a validation code and, as its input hash, the
 * input that would be sent now was rejected by the classifier's own
 * validation for exactly this input: sending it again can only buy the same
 * answer. Only terminal validation failures write the hash on a failed row;
 * a provider or persistence failure clears it, and a row failed by any other
 * path (another code, a hash left from an earlier completion) stays eligible.
 */
export function isAnalysisTerminallyFailed(analysis: SentimentAnalysis, expectedInputHash: string): boolean {
	return (
		analysis.status === "failed" &&
		analysis.classifierVersion === SENTIMENT_CLASSIFIER_VERSION &&
		analysis.taxonomyVersion === SENTIMENT_TAXONOMY_VERSION &&
		analysis.inputHash === expectedInputHash &&
		isValidationCode(analysis.errorCode)
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

export interface ClaimOptions {
	/** Also claim finished rows (`completed`/`no_mentions`) that are no longer current. */
	allowFinished: boolean;
	/**
	 * Also claim a `pending_resolution` row. Only the resolution workflow itself
	 * and the adjudication path set this: a plain worker claim, a canary or a
	 * backfill never moves parked work.
	 */
	resumeResolution?: boolean;
	/**
	 * Canary-only: claim exclusively a never-attempted row — `pending`, zero
	 * attempts and no observation — all checked inside the one UPDATE, so of
	 * any number of racing canaries exactly one ever reaches the provider and
	 * a loser changes nothing (no attempt is counted for it). The worker never
	 * uses this mode; its retry, stale-recovery and reclassification semantics
	 * are unchanged.
	 */
	pristineOnly?: boolean;
}

/**
 * Atomically claim the analysis for one provider call. Exactly one of any
 * number of racing workers wins: the conditional UPDATE only matches a row
 * that is `pending`, `failed`, a finished row that is no longer current
 * (`allowFinished`: `completed`/`no_mentions`), or a `processing` claim older than the claim timeout
 * (an abandoned worker) — or, in `pristineOnly` mode, only a never-attempted
 * row. Losers see the row's current status and make no call. The winner
 * receives the incremented claim generation; a claimant whose lease was
 * taken over later fails every fenced write. Runs in its own statement
 * (autocommit) so the claim is visible to other sessions before the provider
 * boundary.
 */
export async function claimAnalysis(
	analysisId: string,
	options: ClaimOptions,
	executor: Executor = db,
): Promise<ClaimOutcome> {
	const staleBefore = new Date(Date.now() - SENTIMENT_CLAIM_TIMEOUT_SECONDS * 1000);
	const claimable = options.pristineOnly
		? and(
				eq(sentimentAnalyses.status, "pending"),
				eq(sentimentAnalyses.attempts, 0),
				notExists(
					executor
						.select({ id: sentimentObservations.id })
						.from(sentimentObservations)
						.where(eq(sentimentObservations.analysisId, sentimentAnalyses.id)),
				),
			)
		: or(
				inArray(sentimentAnalyses.status, [
					"pending",
					"failed",
					...(options.allowFinished ? ["completed", "no_mentions"] : []),
					...(options.resumeResolution ? ["pending_resolution"] : []),
				]),
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
		/** On a failed row: the exact classifier input the answer was terminally rejected for; null for every other failure. */
		inputHash: string | null;
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
 * then its observations are replaced by the new set with their aspect rows,
 * and the audit of the aspect claims dropped as unsupported is replaced with
 * them (identifiers and codes only). A stale claimant gets `ClaimLostError`
 * before any row is touched; a failure anywhere rolls all of it back.
 */
export async function persistClassification(args: {
	claim: AnalysisClaim;
	promptRunId: string;
	brandId: string;
	mentions: StoredMention[];
	classification: SentimentClassification;
	/** Which independent verification accepted this result (verifier version or human adjudication); required since classifier v5. */
	verifierVersion: string;
}): Promise<void> {
	const mentionByKey = new Map(args.mentions.map((m) => [m.key, m]));
	await db.transaction(async (tx) => {
		const now = new Date();
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
				verifierVersion: args.verifierVersion,
				verifiedAt: now,
				completedAt: now,
				updatedAt: now,
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
		await tx.delete(sentimentFilteredClaims).where(eq(sentimentFilteredClaims.analysisId, args.claim.analysisId));
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
		// One audit row per (entity, aspect) — an aspect is dropped for exactly one
		// reason — in the canonical entity order and the taxonomy's aspect order, so
		// two databases persisting the same classification hold identical rows.
		const audit = new Map<string, typeof sentimentFilteredClaims.$inferInsert>();
		for (const claim of args.classification.filteredClaims) {
			const mention = mentionByKey.get(claim.entityKey);
			if (!mention) throw new Error(`filtered claim for entity "${claim.entityKey}" has no mention row`);
			const identity = `${claim.entityKey}|${claim.aspectKey}`;
			if (audit.has(identity)) throw new Error(`filtered claim for "${identity}" reported twice`);
			audit.set(identity, {
				analysisId: args.claim.analysisId,
				entityType: mention.entityType,
				entityKey: mention.key,
				aspectKey: claim.aspectKey,
				validationCode: claim.code,
				classifierVersion: args.classification.classifierVersion,
				anchorIds: claim.anchorIds,
			});
		}
		const rows = [...audit.values()].sort(
			(a, b) =>
				compareSentimentEntities(
					{ entityType: a.entityType as "brand" | "competitor", key: a.entityKey },
					{ entityType: b.entityType as "brand" | "competitor", key: b.entityKey },
				) ||
				SENTIMENT_ASPECT_KEYS.indexOf(a.aspectKey as SentimentAspectKey) -
					SENTIMENT_ASPECT_KEYS.indexOf(b.aspectKey as SentimentAspectKey),
		);
		for (const row of rows) await tx.insert(sentimentFilteredClaims).values(row);
		// The resolution instance of exactly this input closes in the same transaction as the verified result.
		await tx
			.update(sentimentResolutionCases)
			.set({ status: "resolved", unresolvedTargets: [], nextAttemptAt: null, reviewReason: null, updatedAt: now })
			.where(
				and(
					eq(sentimentResolutionCases.analysisId, args.claim.analysisId),
					eq(sentimentResolutionCases.inputHash, args.classification.inputHash),
				),
			);
	});
}

// ---------------------------------------------------------------------------
// Resolution workflow state (ADR-SENT-01-GROUNDED-COMPLETION, Amendment B)
// ---------------------------------------------------------------------------

export type StoredResolutionCase = SentimentResolutionCase;

/**
 * Ownership of one resolution instance: the analysis claim plus the instance
 * the claimant is working on. Every case and ledger write is fenced on both.
 */
export interface ResolutionOwner extends AnalysisClaim {
	instanceId: string;
}

/**
 * The resolution case of an analysis, created `open` for the current input
 * when none exists. A case whose input hash differs is a superseded instance:
 * the row rotates to a new instance id with a fresh budget and start time;
 * its attempt rows stay under the old id. A resolved case for the same input
 * is returned as it is — it is immutable; callers must not reopen it. The
 * rotation is fenced on the claim when one is given, so a stale claimant
 * cannot roll the case back to its own, older input.
 */
export async function ensureResolutionCase(
	analysisId: string,
	inputHash: string,
	claim?: AnalysisClaim,
	executor: Executor = db,
): Promise<StoredResolutionCase> {
	await executor
		.insert(sentimentResolutionCases)
		.values({ analysisId, inputHash, status: "open" })
		.onConflictDoNothing({ target: [sentimentResolutionCases.analysisId] });
	const row = await executor.query.sentimentResolutionCases.findFirst({
		where: eq(sentimentResolutionCases.analysisId, analysisId),
	});
	if (!row) throw new Error(`resolution case missing for analysis ${analysisId}`);
	if (row.inputHash === inputHash) return row;
	const now = new Date();
	const [fresh] = await executor
		.update(sentimentResolutionCases)
		.set({
			instanceId: sql`gen_random_uuid()`,
			inputHash,
			status: "open",
			provisionalResult: null,
			unresolvedTargets: [],
			automatedProviderCalls: 0,
			totalActualCostUsd: "0",
			nextAttemptAt: null,
			reviewReason: null,
			createdAt: now,
			updatedAt: now,
		})
		.where(ownedCase(analysisId, claim))
		.returning();
	if (!fresh) throw new ClaimLostError(claim ?? { analysisId, generation: -1 });
	return fresh;
}

export async function loadResolutionCase(
	analysisId: string,
	executor: Executor = db,
): Promise<StoredResolutionCase | null> {
	const row = await executor.query.sentimentResolutionCases.findFirst({
		where: eq(sentimentResolutionCases.analysisId, analysisId),
	});
	return row ?? null;
}

export interface ResolutionCasePatch {
	status?: ResolutionCaseStatus;
	/** Safe structural candidate (keys, scores, categories, anchor ids, polarities). */
	provisionalResult?: unknown | null;
	unresolvedTargets?: UnresolvedTarget[];
	nextAttemptAt?: Date | null;
	reviewReason?: ReviewReason | null;
}

/**
 * Case writes are fenced on the analysis claim like every other write of an
 * attempt, and on the instance when the owner names one: a claimant whose
 * lease was taken over, or whose instance was superseded by a changed input,
 * cannot move, charge or park the case a newer attempt owns.
 */
function ownedCase(analysisId: string, owner: AnalysisClaim | ResolutionOwner | undefined): SQL {
	const own = eq(sentimentResolutionCases.analysisId, analysisId);
	if (!owner) return own;
	return and(
		own,
		"instanceId" in owner ? eq(sentimentResolutionCases.instanceId, owner.instanceId) : undefined,
		sql`exists (select 1 from ${sentimentAnalyses} where ${sentimentAnalyses.id} = ${analysisId} and ${sentimentAnalyses.claimGeneration} = ${owner.generation})`,
	) as SQL;
}

export async function updateResolutionCase(
	analysisId: string,
	patch: ResolutionCasePatch,
	owner?: AnalysisClaim | ResolutionOwner,
	executor: Executor = db,
): Promise<void> {
	const rows = await executor
		.update(sentimentResolutionCases)
		.set({ ...patch, updatedAt: new Date() })
		.where(ownedCase(analysisId, owner))
		.returning({ analysisId: sentimentResolutionCases.analysisId });
	if (owner && rows.length !== 1) throw new ClaimLostError(owner);
}

/** The instance's paid answers as the ledger records them: every attempt that ended with an answer, with its charged cost. */
const ledgerOf = (analysisId: SQLWrapper | string, instanceId: SQLWrapper | string) =>
	sql`${sentimentProviderAttempts.analysisId} = ${analysisId} and ${sentimentProviderAttempts.instanceId} = ${instanceId} and ${sentimentProviderAttempts.outcome} in ('accepted', 'rejected')`;

/**
 * Bring the case's budget counters in line with the attempt ledger, which is
 * the source of truth for paid calls and cost: the counters are caches
 * recomputed from the instance's answered attempts, never incremented on
 * their own. Called inside the transaction that settles a paid answer.
 */
export async function chargeResolutionCase(
	analysisId: string,
	owner: ResolutionOwner,
	executor: Executor = db,
): Promise<{ automatedProviderCalls: number; totalActualCostUsd: number }> {
	const ledger = ledgerOf(analysisId, owner.instanceId);
	const [row] = await executor
		.update(sentimentResolutionCases)
		.set({
			automatedProviderCalls: sql`(select count(*)::int from ${sentimentProviderAttempts} where ${ledger})`,
			totalActualCostUsd: sql`(select coalesce(sum(${sentimentProviderAttempts.actualCostUsd}), 0) from ${sentimentProviderAttempts} where ${ledger})`,
			updatedAt: new Date(),
		})
		.where(ownedCase(analysisId, owner))
		.returning({
			automatedProviderCalls: sentimentResolutionCases.automatedProviderCalls,
			totalActualCostUsd: sentimentResolutionCases.totalActualCostUsd,
		});
	if (!row) throw new ClaimLostError(owner);
	return { automatedProviderCalls: row.automatedProviderCalls, totalActualCostUsd: Number(row.totalActualCostUsd) };
}

export type AttemptPhase = "classify" | "repair" | "verify";
export type AttemptOutcome = "sending" | "accepted" | "rejected" | "provider-error" | "aborted";

/** Attempts of an analysis in ordinal order (ids, phases, outcomes, costs — never text). */
export async function loadProviderAttempts(analysisId: string, executor: Executor = db) {
	return executor.query.sentimentProviderAttempts.findMany({
		where: eq(sentimentProviderAttempts.analysisId, analysisId),
		orderBy: [sentimentProviderAttempts.ordinal],
	});
}

/**
 * Record the intent to call the provider before the request leaves: the
 * ledger row exists as `sending` until the outcome is known, so a crash
 * between request and response is visible and blocks further automatic calls.
 * The ordinal runs over every instance of the analysis, so rows of a
 * superseded instance and of the current one never collide.
 */
export async function openProviderAttempt(
	args: { analysisId: string; phase: AttemptPhase; inputHash: string; claim: ResolutionOwner },
	executor: Executor = db,
): Promise<{ id: string; ordinal: number }> {
	const owned = await executor
		.select({ id: sentimentResolutionCases.analysisId })
		.from(sentimentResolutionCases)
		.where(ownedCase(args.analysisId, args.claim));
	if (owned.length !== 1) throw new ClaimLostError(args.claim);
	const [{ next }] = await executor
		.select({ next: sql<number>`coalesce(max(${sentimentProviderAttempts.ordinal}), 0)::int + 1` })
		.from(sentimentProviderAttempts)
		.where(eq(sentimentProviderAttempts.analysisId, args.analysisId));
	const [row] = await executor
		.insert(sentimentProviderAttempts)
		.values({
			analysisId: args.analysisId,
			instanceId: args.claim.instanceId,
			ordinal: next,
			phase: args.phase,
			provider: SENTIMENT_PROVIDER_ID,
			model: SENTIMENT_MODEL,
			inputHash: args.inputHash,
			outcome: "sending",
		})
		.returning({ id: sentimentProviderAttempts.id, ordinal: sentimentProviderAttempts.ordinal });
	return row;
}

/** A settlement that disagrees with the terminal evidence an attempt already holds; the first evidence stands. */
export class AttemptSettlementConflictError extends Error {
	constructor(readonly attemptId: string) {
		super(`attempt ${attemptId} is already settled with different evidence`);
		this.name = "AttemptSettlementConflictError";
	}
}

export interface AttemptSettlement {
	outcome: Exclude<AttemptOutcome, "sending">;
	generationId?: string | null;
	actualCostUsd?: number | null;
	/** The normalized candidate an answered attempt produced; omitted for refusals, aborts and verdicts. */
	candidate?: SentimentClassificationResult | null;
}

const costColumn = (value: number | null | undefined): string | null =>
	typeof value === "number" && Number.isFinite(value) && value >= 0 ? value.toFixed(6) : null;

/**
 * Settle an attempt with its terminal evidence — outcome, generation id,
 * charged cost and normalized candidate — exactly once. The evidence belongs
 * to the immutable attempt row, so this write is keyed on the attempt alone
 * and is never fenced on a case claim: a worker that lost its claim still
 * leaves its own answer behind. Only a `sending` row is written; an identical
 * repeat is a no-op (`already-settled`), and a repeat that disagrees with the
 * stored evidence fails without touching it.
 */
export async function finishProviderAttempt(
	id: string,
	args: AttemptSettlement,
	executor: Executor = db,
): Promise<"settled" | "already-settled"> {
	const generationId = args.generationId ?? null;
	const actualCostUsd = costColumn(args.actualCostUsd);
	const rows = await executor
		.update(sentimentProviderAttempts)
		.set({
			outcome: args.outcome,
			generationId,
			actualCostUsd,
			candidate: args.candidate ?? null,
			finishedAt: new Date(),
		})
		.where(and(eq(sentimentProviderAttempts.id, id), eq(sentimentProviderAttempts.outcome, "sending")))
		.returning({ id: sentimentProviderAttempts.id });
	if (rows.length === 1) return "settled";
	const row = await executor.query.sentimentProviderAttempts.findFirst({ where: eq(sentimentProviderAttempts.id, id) });
	if (!row) throw new Error(`provider attempt ${id} missing`);
	const same =
		row.outcome === args.outcome &&
		row.generationId === generationId &&
		(row.actualCostUsd === null ? actualCostUsd === null : Number(row.actualCostUsd) === Number(actualCostUsd));
	if (!same) throw new AttemptSettlementConflictError(id);
	return "already-settled";
}

export interface UnresolvedCaseRow {
	analysisId: string;
	promptRunId: string;
	brandId: string;
	status: ResolutionCaseStatus;
	reviewReason: ReviewReason | null;
	unresolvedTargets: UnresolvedTarget[];
	automatedProviderCalls: number;
	totalActualCostUsd: number;
	updatedAt: Date;
}

/**
 * Every case that is not resolved — the mandatory operator work list.
 * Identifiers and counts only; calls and cost come from the attempt ledger of
 * the current instance, not from the case's cached counters.
 */
export async function listUnresolvedCases(executor: Executor = db): Promise<UnresolvedCaseRow[]> {
	const ledger = ledgerOf(sentimentResolutionCases.analysisId, sentimentResolutionCases.instanceId);
	const rows = await executor
		.select({
			analysisId: sentimentResolutionCases.analysisId,
			promptRunId: sentimentAnalyses.promptRunId,
			brandId: sentimentAnalyses.brandId,
			status: sentimentResolutionCases.status,
			reviewReason: sentimentResolutionCases.reviewReason,
			unresolvedTargets: sentimentResolutionCases.unresolvedTargets,
			automatedProviderCalls: sql<number>`(select count(*)::int from ${sentimentProviderAttempts} where ${ledger})`,
			totalActualCostUsd: sql<string>`(select coalesce(sum(${sentimentProviderAttempts.actualCostUsd}), 0)::text from ${sentimentProviderAttempts} where ${ledger})`,
			updatedAt: sentimentResolutionCases.updatedAt,
		})
		.from(sentimentResolutionCases)
		.innerJoin(sentimentAnalyses, eq(sentimentAnalyses.id, sentimentResolutionCases.analysisId))
		.where(sql`${sentimentResolutionCases.status} <> 'resolved'`)
		.orderBy(sentimentResolutionCases.updatedAt);
	return rows.map((row) => ({
		...row,
		status: row.status as ResolutionCaseStatus,
		reviewReason: (row.reviewReason as ReviewReason | null) ?? null,
		unresolvedTargets: (row.unresolvedTargets as UnresolvedTarget[]) ?? [],
		totalActualCostUsd: Number(row.totalActualCostUsd),
	}));
}

/**
 * Billing-grade attribution for one classifier attempt, success or failure.
 * Whenever the provider answered and reported what it charged, that amount
 * is recorded — also for an answer the classifier then rejected, which was
 * paid for all the same; only a call without a reported cost falls back to
 * the tunable estimate. The column is named `estimated_cost_usd` for
 * historical reasons: for sentiment it holds the charged cost when one was
 * reported and the estimate otherwise. A failed attempt is attributed to the
 * locked provider/model without any credential or response detail. Written
 * inside the transaction that settles the paid answer, so a failure here
 * rolls the settlement back and is retried from the recorded answer instead
 * of being lost.
 */
export async function recordSentimentUsageEvent(
	args: {
		organizationId: string;
		brandId: string;
		promptId: string;
		provider: string;
		model: string | null;
		succeeded: boolean;
		/** Charged cost in USD reported by the provider for the call, whatever became of its answer. */
		actualCostUsd?: number | null;
	},
	executor: Executor = db,
): Promise<void> {
	const actual =
		typeof args.actualCostUsd === "number" && Number.isFinite(args.actualCostUsd) && args.actualCostUsd >= 0
			? args.actualCostUsd
			: null;
	const cost = actual ?? estimateRunCostUsd(args.provider, true);
	await executor.insert(usageEvents).values({
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
}

/** Prompt text lookup used by evidence/backfill reporting. */
export async function loadPromptValue(promptId: string): Promise<string | null> {
	const row = await db.query.prompts.findFirst({ where: eq(prompts.id, promptId), columns: { value: true } });
	return row?.value ?? null;
}
