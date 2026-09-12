import { Buffer } from "node:buffer";
import { and, asc, eq, gt, or } from "drizzle-orm";
import { db } from "../db/db";
import { promptRunEntityMentions, promptRuns, sentimentAnalyses } from "../db/schema";
import { type DetectableEntity, detectEntityMentions, entityTerms } from "./detector";
import { type SentimentSender, sendSentimentJob } from "./enqueue";
import { ensureAnalysis, loadDetectableEntities, persistMentions } from "./store";
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
	/** Runs whose current-version mention rows already matched the detector. */
	alreadyCurrent: number;
	/** Runs whose mention rows were (or would be) written or refreshed. */
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

async function mentionRowsAreCurrent(runId: string, detectedKeys: string[]): Promise<boolean> {
	const existing = await db
		.select({ key: promptRunEntityMentions.entityKey, version: promptRunEntityMentions.detectorVersion })
		.from(promptRunEntityMentions)
		.where(eq(promptRunEntityMentions.promptRunId, runId));
	const currentKeys = existing
		.filter((row) => row.version === SENTIMENT_DETECTOR_VERSION)
		.map((row) => row.key)
		.sort();
	const wanted = [...detectedKeys].sort();
	return (
		existing.length === currentKeys.length &&
		currentKeys.length === wanted.length &&
		currentKeys.every((key, index) => key === wanted[index])
	);
}

async function processMentionRun(run: ScannedRun, state: MentionScanState, apply: boolean): Promise<void> {
	const { counts } = state;
	counts.scanned++;
	const entities = await entitiesFor(run.brandId, state.entitiesByBrand);
	reconcileLegacyNames(run, entities, state);
	const body = extractAnswerBody(run.rawOutput, run.provider, run.model);
	if (body === null) {
		counts.unextractable++;
		return;
	}
	const detected = detectEntityMentions(body, entities);
	if (detected.length === 0) counts.withoutMentions++;
	else counts.withMentions++;
	counts.mentionRows += detected.length;
	if (
		await mentionRowsAreCurrent(
			run.id,
			detected.map((m) => m.key),
		)
	) {
		counts.alreadyCurrent++;
		return;
	}
	counts.written++;
	if (apply) await persistMentions({ promptRunId: run.id, brandId: run.brandId, mentions: detected });
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
	/** Runs with current-version mentions and a completed current-version analysis. */
	completed: number;
	/** Runs with current-version mentions and no completed current-version analysis. */
	eligible: number;
	/** Eligible runs whose analysis row is `failed` (would be retried by a re-enqueue). */
	eligibleFailed: number;
	/** Runs without current-version mention rows (mention backfill has not covered them). */
	noMentionRows: number;
	/** Runs whose current-version mention scan found nothing (no call needed). */
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

type RunEligibility = "eligible" | "completed" | "no-mentions" | "no-mention-rows";

/**
 * Where one run stands: classified at the current version, waiting for a
 * classification, needing no call, or not yet covered by the mention backfill.
 * A run the detector already visited (any row at any version) but found
 * nothing at the current version needs no call; one it never visited still
 * needs the mention backfill first.
 */
async function classifyRunEligibility(run: ScannedRun, counts: SentimentEnqueueInventory): Promise<RunEligibility> {
	counts.scanned++;
	const rows = await db
		.select({ version: promptRunEntityMentions.detectorVersion })
		.from(promptRunEntityMentions)
		.where(eq(promptRunEntityMentions.promptRunId, run.id));
	const currentMentions = rows.filter((row) => row.version === SENTIMENT_DETECTOR_VERSION).length;
	const analyses = await db
		.select({ version: sentimentAnalyses.classifierVersion, status: sentimentAnalyses.status })
		.from(sentimentAnalyses)
		.where(eq(sentimentAnalyses.promptRunId, run.id));
	const current = analyses.find((row) => row.version === SENTIMENT_CLASSIFIER_VERSION);
	if (!current && analyses.length > 0) counts.staleVersionOnly++;

	if (currentMentions === 0) {
		const body = extractAnswerBody(run.rawOutput, run.provider, run.model);
		if (rows.length > 0 || body === null || current?.status === "no_mentions") {
			counts.noMentions++;
			return "no-mentions";
		}
		counts.noMentionRows++;
		return "no-mention-rows";
	}
	if (current?.status === "completed") {
		counts.completed++;
		return "completed";
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
		noMentionRows: 0,
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
	const { cursor, partial } = await scanAllRuns(args, async (run) => {
		const eligibility = await classifyRunEligibility(run, counts);
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
