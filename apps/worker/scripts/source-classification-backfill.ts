#!/usr/bin/env tsx
/**
 * F-05 historical backfill: inventory (default) or bounded enqueue of
 * classification jobs for hostnames cited historically that are still
 * unresolved for the current classifier version.
 *
 * The citation inventory is scanned in bounded keyset pages of grouped
 * (domain, brand_id) rows ordered by the hostname normalization key, so every
 * variant of one logical hostname is contiguous and per-run state stays
 * bounded by the batch size (`--batch-size`, hard max BACKFILL_MAX_BATCH_SIZE;
 * the result's `peakPendingGroups` reports the actual peak). `--max-pages N`
 * bounds a run further. Any bounded or interrupted run reports
 * `partial: true` plus an opaque `nextCursor` token to resume via
 * `--cursor TOKEN`; the token always points at the last fully settled
 * hostname, so no eligible hostname can be skipped by resuming, and a resume
 * sequence sums to the same inventory as one uninterrupted scan.
 *
 * Modes:
 *   - DRY RUN (default): read-only counting. No DB write, no queue send, no
 *     LLM call. Repeatable with stable counts for the same data.
 *   - ENQUEUE: requires BOTH `--enqueue` and a positive `--limit N` — a hard
 *     upper bound on ACCEPTED jobs (a send deduplicated by the exclusive queue
 *     policy returns null and does not consume the limit; a failing send stops
 *     the run with a cursor that retries that hostname). Still makes no LLM
 *     call itself; the worker processes the queued jobs.
 *
 * Running this against production (or any shared database) is an operations
 * action that belongs to a separately authorized deployment phase — do not
 * point it at a database you don't own for that purpose.
 *
 * Usage (from apps/worker):
 *   pnpm backfill:source-classification                       # dry run, full inventory
 *   pnpm backfill:source-classification --max-pages 10        # bounded dry run + resume token
 *   pnpm backfill:source-classification --enqueue --limit 100
 *   pnpm backfill:source-classification --cursor TOKEN        # resume a bounded run
 */
import { parseArgs } from "node:util";
import { db } from "@workspace/lib/db/db";
import { brands, citations, competitors, sourceDomainClassifications } from "@workspace/lib/db/schema";
import {
	BACKFILL_DEFAULT_BATCH_SIZE,
	BACKFILL_MAX_BATCH_SIZE,
	type BackfillBrandContext,
	type BackfillCitationPage,
	type BackfillCursor,
	decodeBackfillCursorToken,
	encodeBackfillCursorToken,
	ensureSourceClassificationQueue,
	runSourceClassificationBackfill,
	SOURCE_CLASSIFICATION_QUEUE,
	SOURCE_CLASSIFIER_VERSION,
	sourceClassificationSingletonKey,
} from "@workspace/lib/source-classification";
import { inArray, sql } from "drizzle-orm";
import boss from "../src/boss";

function extractDomainFromUrl(urlOrDomain: string): string {
	try {
		const url = new URL(urlOrDomain.startsWith("http") ? urlOrDomain : `https://${urlOrDomain}`);
		return url.hostname.replace(/^www\./, "").toLowerCase();
	} catch {
		return urlOrDomain.replace(/^www\./, "").toLowerCase();
	}
}

// SQL twin of backfillOrderingKey (lowercase, strip trailing dots, strip one
// leading "www.") — keeps every variant of a logical hostname contiguous.
// Bracket classes instead of backslash escapes: drizzle's sql template
// tag consumes backslashes from its literal chunks.
const keyExpr = sql<string>`regexp_replace(regexp_replace(lower(${citations.domain}), '[.]+$', ''), '^www[.]', '')`;

async function fetchCitationPage(cursor: BackfillCursor | null, batchSize: number): Promise<BackfillCitationPage> {
	const rows = await db
		.select({
			key: sql<string>`${keyExpr}`.as("key"),
			domain: citations.domain,
			brandId: citations.brandId,
			citationCount: sql<number>`count(*)::int`,
		})
		.from(citations)
		.where(
			cursor
				? sql`(${keyExpr}, ${citations.domain}, ${citations.brandId}) > (${cursor.key}, ${cursor.domain}, ${cursor.brandId})`
				: sql`true`,
		)
		.groupBy(citations.domain, citations.brandId)
		.orderBy(keyExpr, citations.domain, citations.brandId)
		.limit(batchSize);
	const last = rows[rows.length - 1];
	return {
		rows,
		nextCursor:
			rows.length === batchSize && last ? { key: last.key, domain: last.domain, brandId: last.brandId } : null,
	};
}

const CACHE_CHUNK = 1000;

async function fetchCachedVersions(hostnames: string[]): Promise<Map<string, string>> {
	const result = new Map<string, string>();
	for (let i = 0; i < hostnames.length; i += CACHE_CHUNK) {
		const rows = await db
			.select({
				hostname: sourceDomainClassifications.hostname,
				classifierVersion: sourceDomainClassifications.classifierVersion,
			})
			.from(sourceDomainClassifications)
			.where(inArray(sourceDomainClassifications.hostname, hostnames.slice(i, i + CACHE_CHUNK)));
		for (const row of rows) result.set(row.hostname, row.classifierVersion);
	}
	return result;
}

async function loadBrandContexts(): Promise<Map<string, BackfillBrandContext>> {
	const [brandRows, competitorRows] = await Promise.all([
		db.select({ id: brands.id, website: brands.website, additionalDomains: brands.additionalDomains }).from(brands),
		db.select({ brandId: competitors.brandId, domains: competitors.domains }).from(competitors),
	]);
	const brandContexts = new Map<string, BackfillBrandContext>();
	for (const brand of brandRows) {
		brandContexts.set(brand.id, {
			brandDomains: new Set(
				[extractDomainFromUrl(brand.website), ...(brand.additionalDomains || []).map(extractDomainFromUrl)].filter(
					Boolean,
				),
			),
			competitorDomains: new Set<string>(),
		});
	}
	for (const competitor of competitorRows) {
		const context = brandContexts.get(competitor.brandId);
		if (!context) continue;
		for (const domain of competitor.domains || []) {
			const extracted = extractDomainFromUrl(domain);
			if (extracted) context.competitorDomains.add(extracted);
		}
	}
	return brandContexts;
}

// Token codec lives in @workspace/lib (encode/decodeBackfillCursorToken) so it
// is testable without this script's DB/queue side effects. A partial run whose
// nextCursor is null (stopped before any hostname settled) encodes as the
// explicit start sentinel — never a literal "null" token.

async function main(): Promise<void> {
	const { values } = parseArgs({
		options: {
			enqueue: { type: "boolean", default: false },
			limit: { type: "string" },
			"batch-size": { type: "string" },
			"max-pages": { type: "string" },
			cursor: { type: "string" },
		},
	});

	const limit = values.limit === undefined ? undefined : Number(values.limit);
	if (values.enqueue && (!Number.isInteger(limit) || (limit as number) <= 0)) {
		console.error("--enqueue requires an explicit positive --limit N (hard cap on accepted jobs).");
		process.exit(2);
	}
	const batchSize = values["batch-size"] === undefined ? BACKFILL_DEFAULT_BATCH_SIZE : Number(values["batch-size"]);
	if (!Number.isInteger(batchSize) || batchSize <= 0 || batchSize > BACKFILL_MAX_BATCH_SIZE) {
		console.error(`--batch-size must be a positive integer up to ${BACKFILL_MAX_BATCH_SIZE}.`);
		process.exit(2);
	}
	const maxPages = values["max-pages"] === undefined ? undefined : Number(values["max-pages"]);
	if (maxPages !== undefined && (!Number.isInteger(maxPages) || maxPages <= 0)) {
		console.error("--max-pages must be a positive integer.");
		process.exit(2);
	}

	const brandContexts = await loadBrandContexts();

	let enqueue: { send: (hostname: string) => Promise<string | null>; limit: number } | null = null;
	if (values.enqueue) {
		await boss.start();
		await ensureSourceClassificationQueue(boss);
		enqueue = {
			limit: limit as number,
			send: (hostname) =>
				boss.send(
					SOURCE_CLASSIFICATION_QUEUE,
					{ hostname, classifierVersion: SOURCE_CLASSIFIER_VERSION, builtInCategory: "other" as const },
					{ singletonKey: sourceClassificationSingletonKey(hostname, SOURCE_CLASSIFIER_VERSION) },
				),
		};
	}

	const mode = values.enqueue ? "ENQUEUE" : "DRY RUN";
	console.log(`F-05 backfill (${mode}) — classifier version ${SOURCE_CLASSIFIER_VERSION}, batch size ${batchSize}`);

	const { inventory, nextCursor, attempted, accepted, deduplicated, failed, peakPendingGroups } =
		await runSourceClassificationBackfill({
			source: { fetchCitationPage, fetchCachedVersions },
			brandContexts,
			batchSize,
			maxPages,
			cursor: values.cursor === undefined ? null : decodeBackfillCursorToken(values.cursor),
			enqueue,
		});

	if (values.enqueue) await boss.stop({ graceful: true, timeout: 10_000 });

	// Every partial run gets an actionable token, even when nothing settled yet
	// (nextCursor null -> start sentinel). Completed scans report null.
	const cursorToken = inventory.partial ? encodeBackfillCursorToken(nextCursor) : null;
	console.log(
		JSON.stringify(
			{
				mode,
				...inventory,
				attempted,
				accepted,
				deduplicated,
				failed,
				peakPendingGroups,
				limit: limit ?? null,
				nextCursor: cursorToken,
			},
			null,
			2,
		),
	);
	if (!values.enqueue) {
		console.log("Dry run: no jobs enqueued, no rows written, no LLM calls made.");
	}
	if (inventory.partial) {
		console.log(`Partial scan: resume with --cursor "${cursorToken}".`);
	}
}

main().then(
	() => process.exit(0),
	(error) => {
		console.error(error);
		process.exit(1);
	},
);
