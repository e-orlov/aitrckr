import { Buffer } from "node:buffer";
import { and, asc, eq, gt, isNull, or } from "drizzle-orm";
import { db } from "../db/db";
import { promptRunEntityMentions, promptRuns, sentimentAnalyses, sentimentDetections } from "../db/schema";
import { sentimentInputHash } from "./classifier";
import { type DetectableEntity, detectEntityMentions, entityTerms } from "./detector";
import { type SentimentSender, sendSentimentJob } from "./enqueue";
import {
	candidatesFromMentions,
	detectionResultFor,
	ensureAnalysis,
	isAnalysisCurrent,
	loadDetectableEntities,
	loadMentions,
	persistDetection,
} from "./store";
import { extractAnswerBody, normalizeText } from "./text";
import { SENTIMENT_CLASSIFIER_VERSION, SENTIMENT_DETECTOR_VERSION } from "./types";

/** Resume position in the (created_at, id) keyset scan over prompt_runs. */
export interface RunCursor {
	createdAt: string;
	id: string;
}

export function encodeRunCursor(cursor: RunCursor | null): string {
	return Buffer.from(JSON.stringify(cursor ?? { start: true }), "utf8").toString("base64url");
}

export function decodeRunCursor(token: string): RunCursor | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
	} catch {
		throw new Error("resume token is not valid — pass a nextCursor token printed by a previous run");
	}
	if (typeof parsed !== "object" || parsed === null) throw new Error("resume token is not valid");
	const record = parsed as Record<string, unknown>;
	if (record.start === true) return null;
	if (typeof record.createdAt === "string" && typeof record.id === "string")
		return { createdAt: record.createdAt, id: record.id };
	throw new Error("resume token is not valid");
}

export interface MentionBackfillCounts {
	scanned: number;
	/** Runs whose answer body could not be extracted. */
	unextractable: number;
	/** Runs with at least one detected entity. */
	withMentions: number;
	withoutMentions: number;
	/** Runs whose current-version receipt and mention rows already matched the detector. */
	alreadyCurrent: number;
	/** Runs whose receipt and mention rows were (or would be) written or refreshed. */
	written: number;
	/** Mention rows detected in total. */
	mentionRows: number;
	/** Legacy `competitors_mentioned` names with exactly one entity match. */
	legacyMatched: number;
	/** Legacy names matching two or more entities (reported, never guessed). */
	legacyAmbiguous: string[];
	/** Legacy names matching no entity of the brand (reported exclusions). */
	legacyOrphans: string[];
}

export interface MentionBackfillResult {
	counts: MentionBackfillCounts;
	nextCursor: string;
	partial: boolean;
}

const PAGE_SIZE = 200;

async function scanRuns(cursor: RunCursor | null, brandId: string | undefined, limit: number) {
	const after =
		cursor === null
			? undefined
			: or(
					gt(promptRuns.createdAt, new Date(cursor.createdAt)),
					and(eq(promptRuns.createdAt, new Date(cursor.createdAt)), gt(promptRuns.id, cursor.id)),
				);
	return db
		.select({
			id: promptRuns.id,
			brandId: promptRuns.brandId,
			provider: promptRuns.provider,
			model: promptRuns.model,
			rawOutput: promptRuns.rawOutput,
			competitorsMentioned: promptRuns.competitorsMentioned,
			createdAt: promptRuns.createdAt,
		})
		.from(promptRuns)
		.where(and(after, brandId ? eq(promptRuns.brandId, brandId) : undefined))
		.orderBy(asc(promptRuns.createdAt), asc(promptRuns.id))
		.limit(limit);
}

interface ScanOptions {
	brandId?: string;
	cursor?: RunCursor | null;
	maxPages?: number;
	pageSize?: number;
}

/**
 * Walk every stored run oldest-first in bounded keyset pages, calling `onRun`
 * for each; `onRun` returns false to stop early (the cursor then points at the
 * last run that was fully handled). `partial` is true when pages remain.
 */
async function scanAllRuns(
	options: ScanOptions,
	onRun: (run: ScannedRun) => Promise<boolean>,
): Promise<{ cursor: RunCursor | null; partial: boolean }> {
	const pageSize = options.pageSize ?? PAGE_SIZE;
	let cursor = options.cursor ?? null;
	let pages = 0;
	while (true) {
		if (options.maxPages !== undefined && pages >= options.maxPages) return { cursor, partial: true };
		const rows = await scanRuns(cursor, options.brandId, pageSize);
		if (rows.length === 0) return { cursor, partial: false };
		pages++;
		for (const run of rows) {
			if (!(await onRun(run))) return { cursor, partial: true };
			cursor = { createdAt: run.createdAt.toISOString(), id: run.id };
		}
		if (rows.length < pageSize) return { cursor, partial: false };
	}
}

type ScannedRun = Awaited<ReturnType<typeof scanRuns>>[number];

/** Exact normalized match of a legacy stored name against entity names/aliases/previous names. */
function legacyNameMatches(name: string, entities: DetectableEntity[]): DetectableEntity[] {
	const needle = normalizeText(name);
	return entities.filter((entity) => entity.entityType === "competitor" && entityTerms(entity).includes(needle));
}

interface MentionScanState {
	counts: MentionBackfillCounts;
	entitiesByBrand: Map<string, DetectableEntity[]>;
	ambiguous: Set<string>;
	orphans: Set<string>;
}

async function entitiesFor(brandId: string, cache: Map<string, DetectableEntity[]>): Promise<DetectableEntity[]> {
	let entities = cache.get(brandId);
	if (!entities) {
		entities = await loadDetectableEntities(brandId, "historical");
		cache.set(brandId, entities);
	}
	return entities;
}

function reconcileLegacyNames(run: ScannedRun, entities: DetectableEntity[], state: MentionScanState): void {
	for (const legacy of run.competitorsMentioned ?? []) {
		const matches = legacyNameMatches(legacy, entities);
		if (matches.length === 1) state.counts.legacyMatched++;
		else if (matches.length > 1) state.ambiguous.add(legacy);
		else state.orphans.add(legacy);
	}
}

/**
 * A run is current when a current-version receipt exists with the detected
 * status and count, and the current mention projection (not superseded,
 * current detector version) is exactly the detected entity set — the same
 * projection `loadMentions` serves. Superseded rows are history and do not
 * count either way.
 */
async function detectionIsCurrent(runId: string, status: string, detectedKeys: string[]): Promise<boolean> {
	const receipt = await db.query.sentimentDetections.findFirst({
		where: and(
			eq(sentimentDetections.promptRunId, runId),
			eq(sentimentDetections.detectorVersion, SENTIMENT_DETECTOR_VERSION),
		),
	});
	if (!receipt || receipt.status !== status || receipt.mentionCount !== detectedKeys.length) return false;
	const active = await db
		.select({ key: promptRunEntityMentions.entityKey, version: promptRunEntityMentions.detectorVersion })
		.from(promptRunEntityMentions)
		.where(and(eq(promptRunEntityMentions.promptRunId, runId), isNull(promptRunEntityMentions.supersededAt)));
	if (active.some((row) => row.version !== SENTIMENT_DETECTOR_VERSION)) return false;
	const currentKeys = active.map((row) => row.key).sort();
	const wanted = [...detectedKeys].sort();
	return currentKeys.length === wanted.length && currentKeys.every((key, index) => key === wanted[index]);
}

async function processMentionRun(run: ScannedRun, state: MentionScanState, apply: boolean): Promise<void> {
	const { counts } = state;
	counts.scanned++;
	const entities = await entitiesFor(run.brandId, state.entitiesByBrand);
	reconcileLegacyNames(run, entities, state);
	const body = extractAnswerBody(run.rawOutput, run.provider, run.model);
	const detected = body === null ? [] : detectEntityMentions(body, entities);
	const result = detectionResultFor(body, detected);
	if (result.status === "unextractable") counts.unextractable++;
	else if (detected.length === 0) counts.withoutMentions++;
	else counts.withMentions++;
	counts.mentionRows += detected.length;
	if (
		await detectionIsCurrent(
			run.id,
			result.status,
			detected.map((m) => m.key),
		)
	) {
		counts.alreadyCurrent++;
		return;
	}
	counts.written++;
	if (apply) await persistDetection({ promptRunId: run.id, brandId: run.brandId, result });
}

/**
 * Deterministic mention backfill/repair over ALL stored runs (every prompt,
 * enabled or not), oldest first, in bounded keyset pages. No provider call.
 * Dry run by default; `apply` writes current-version mention rows. Legacy
 * `competitors_mentioned` names are reconciled for the inventory only —
 * ambiguous and orphan names are reported, never mapped.
 */
export async function runMentionBackfill(args: {
	apply: boolean;
	brandId?: string;
	cursor?: RunCursor | null;
	maxPages?: number;
	pageSize?: number;
}): Promise<MentionBackfillResult> {
	const counts: MentionBackfillCounts = {
		scanned: 0,
		unextractable: 0,
		withMentions: 0,
		withoutMentions: 0,
		alreadyCurrent: 0,
		written: 0,
		mentionRows: 0,
		legacyMatched: 0,
		legacyAmbiguous: [],
		legacyOrphans: [],
	};
	const state: MentionScanState = { counts, entitiesByBrand: new Map(), ambiguous: new Set(), orphans: new Set() };
	const { cursor, partial } = await scanAllRuns(args, async (run) => {
		await processMentionRun(run, state, args.apply);
		return true;
	});
	counts.legacyAmbiguous = [...state.ambiguous].sort();
	counts.legacyOrphans = [...state.orphans].sort();
	return { counts, nextCursor: encodeRunCursor(cursor), partial };
}

export interface SentimentEnqueueInventory {
	scanned: number;
	/** Runs with current-version mentions and a current completed analysis (same taxonomy and input hash). */
	completed: number;
	/** Runs with current-version mentions and no current completed analysis. */
	eligible: number;
	/** Eligible runs whose analysis row is `failed` (would be retried by a re-enqueue). */
	eligibleFailed: number;
	/** Eligible runs with a completed analysis whose input hash or taxonomy no longer matches (roster/name/alias change). */
	eligibleStale: number;
	/** Runs without a current-version detection receipt (mention backfill has not covered them). */
	notScanned: number;
	/** Runs whose current-version receipt says no entity was found or no text was extractable (no call needed). */
	noMentions: number;
	/** Runs with an analysis of another classifier version only (stale, auditable). */
	staleVersionOnly: number;
	attempted: number;
	accepted: number;
	deduplicated: number;
	failed: number;
}

export interface SentimentEnqueueResult {
	counts: SentimentEnqueueInventory;
	nextCursor: string;
	partial: boolean;
	/** True when the accepted-job limit stopped the scan. */
	limitReached: boolean;
}

type RunEligibility = "eligible" | "completed" | "no-mentions" | "not-scanned";

/**
 * Where one run stands: classified at the current version for the current
 * input, waiting for a classification, needing no call, or not yet covered
 * by the mention backfill. Only the detection receipt decides whether a run
 * was scanned; a completed analysis counts only while its input hash and
 * taxonomy still match what would be sent now.
 */
async function classifyRunEligibility(
	run: ScannedRun,
	counts: SentimentEnqueueInventory,
	entitiesByBrand: Map<string, DetectableEntity[]>,
): Promise<RunEligibility> {
	counts.scanned++;
	const receipt = await db.query.sentimentDetections.findFirst({
		where: and(
			eq(sentimentDetections.promptRunId, run.id),
			eq(sentimentDetections.detectorVersion, SENTIMENT_DETECTOR_VERSION),
		),
	});
	const analyses = await db.query.sentimentAnalyses.findMany({ where: eq(sentimentAnalyses.promptRunId, run.id) });
	const current = analyses.find((row) => row.classifierVersion === SENTIMENT_CLASSIFIER_VERSION);
	if (!current && analyses.length > 0) counts.staleVersionOnly++;

	if (!receipt) {
		counts.notScanned++;
		return "not-scanned";
	}
	const body = extractAnswerBody(run.rawOutput, run.provider, run.model);
	if (receipt.status !== "mentions" || body === null) {
		counts.noMentions++;
		return "no-mentions";
	}
	if (current?.status === "completed") {
		const entities = await entitiesFor(run.brandId, entitiesByBrand);
		const candidates = candidatesFromMentions(await loadMentions(run.id), entities);
		if (isAnalysisCurrent(current, sentimentInputHash(body, candidates))) {
			counts.completed++;
			return "completed";
		}
		counts.eligibleStale++;
	}
	counts.eligible++;
	if (current?.status === "failed") counts.eligibleFailed++;
	return "eligible";
}

async function enqueueOne(run: ScannedRun, sender: SentimentSender, counts: SentimentEnqueueInventory): Promise<void> {
	counts.attempted++;
	try {
		await ensureAnalysis({ promptRunId: run.id, brandId: run.brandId });
		const jobId = await sendSentimentJob(sender, run.id);
		if (jobId === null) counts.deduplicated++;
		else counts.accepted++;
	} catch (error) {
		counts.failed++;
		console.error(`Failed to enqueue sentiment for run ${run.id}:`, error);
	}
}

/**
 * Paid-work inventory and bounded enqueue. Dry run by default; enqueueing
 * requires an explicit positive `limit` that counts ACCEPTED jobs only
 * (deduplicated sends do not consume it). No provider call happens here —
 * the worker performs them, one at a time.
 */
export async function runSentimentEnqueue(args: {
	enqueue: { limit: number } | false;
	sender?: SentimentSender;
	brandId?: string;
	cursor?: RunCursor | null;
	maxPages?: number;
	pageSize?: number;
}): Promise<SentimentEnqueueResult> {
	if (args.enqueue && (!Number.isInteger(args.enqueue.limit) || args.enqueue.limit <= 0)) {
		throw new Error("--enqueue requires a positive integer --limit");
	}
	if (args.enqueue && !args.sender) throw new Error("enqueue requires a queue sender");
	const counts: SentimentEnqueueInventory = {
		scanned: 0,
		completed: 0,
		eligible: 0,
		eligibleFailed: 0,
		eligibleStale: 0,
		notScanned: 0,
		noMentions: 0,
		staleVersionOnly: 0,
		attempted: 0,
		accepted: 0,
		deduplicated: 0,
		failed: 0,
	};
	const sender = args.enqueue ? args.sender : undefined;
	const limit = args.enqueue ? args.enqueue.limit : 0;
	let limitReached = false;
	const entitiesByBrand = new Map<string, DetectableEntity[]>();
	const { cursor, partial } = await scanAllRuns(args, async (run) => {
		const eligibility = await classifyRunEligibility(run, counts, entitiesByBrand);
		if (eligibility !== "eligible" || !sender) return true;
		if (counts.accepted >= limit) {
			limitReached = true;
			return false;
		}
		await enqueueOne(run, sender, counts);
		return true;
	});
	return { counts, nextCursor: encodeRunCursor(cursor), partial, limitReached };
}
