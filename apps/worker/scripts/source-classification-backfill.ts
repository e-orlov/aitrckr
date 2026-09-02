#!/usr/bin/env tsx
/**
 * F-05 historical backfill: inventory (default) or bounded enqueue of
 * classification jobs for hostnames cited historically that are still
 * unresolved for the current classifier version.
 *
 * The citation inventory is scanned in bounded keyset pages (grouped
 * (domain, brand_id) rows, `--batch-size` per page, hard max
 * BACKFILL_MAX_BATCH_SIZE) and the cache is checked one page-sized hostname
 * batch at a time — nothing table-sized is held in memory. `--max-pages N`
 * bounds a run further; a bounded run reports `partial: true` plus a
 * `nextCursor` to resume from via `--cursor "domain,brandId"`.
 *
 * Modes:
 *   - DRY RUN (default): read-only counting. No DB write, no queue send, no
 *     LLM call. Repeatable with stable counts for the same data.
 *   - ENQUEUE: requires BOTH `--enqueue` and a positive `--limit N` — a hard
 *     upper bound on ACCEPTED jobs (a send deduplicated by the exclusive queue
 *     policy returns null and does not consume the limit). Still makes no LLM
 *     call itself; the worker processes the queued jobs. Reruns are idempotent
 *     and progress past already-handled hostnames via the cache filter and
 *     queue dedupe.
 *
 * Running this against production (or any shared database) is an operations
 * action that belongs to a separately authorized deployment phase — do not
 * point it at a database you don't own for that purpose.
 *
 * Usage (from apps/worker):
 *   pnpm backfill:source-classification                                # dry run, full inventory
 *   pnpm backfill:source-classification --max-pages 10                 # bounded dry run + cursor
 *   pnpm backfill:source-classification --enqueue --limit 100
 *   pnpm backfill:source-classification --cursor "example.com,brand-1" # resume
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

async function fetchCitationPage(cursor: BackfillCursor | null, batchSize: number): Promise<BackfillCitationPage> {
	const rows = await db
		.select({
			domain: citations.domain,
			brandId: citations.brandId,
			citationCount: sql<number>`count(*)::int`,
		})
		.from(citations)
		.where(
			cursor ? sql`(${citations.domain}, ${citations.brandId}) > (${cursor.domain}, ${cursor.brandId})` : sql`true`,
		)
		.groupBy(citations.domain, citations.brandId)
		.orderBy(citations.domain, citations.brandId)
		.limit(batchSize);
	const last = rows[rows.length - 1];
	return {
		rows,
		nextCursor: rows.length === batchSize && last ? { domain: last.domain, brandId: last.brandId } : null,
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

function parseCursor(value: string | undefined): BackfillCursor | null {
	if (!value) return null;
	const comma = value.indexOf(",");
	if (comma <= 0 || comma === value.length - 1) {
		throw new Error(`--cursor must be "domain,brandId", got "${value}"`);
	}
	return { domain: value.slice(0, comma), brandId: value.slice(comma + 1) };
}

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

	const { inventory, nextCursor, attempted, accepted, deduplicated, failed } = await runSourceClassificationBackfill({
		source: { fetchCitationPage, fetchCachedVersions },
		brandContexts,
		batchSize,
		maxPages,
		cursor: parseCursor(values.cursor),
		enqueue,
	});

	if (values.enqueue) await boss.stop({ graceful: true, timeout: 10_000 });

	console.log(
		JSON.stringify(
			{
				mode,
				...inventory,
				attempted,
				accepted,
				deduplicated,
				failed,
				limit: limit ?? null,
				nextCursor: nextCursor ? `${nextCursor.domain},${nextCursor.brandId}` : null,
			},
			null,
			2,
		),
	);
	if (!values.enqueue) {
		console.log("Dry run: no jobs enqueued, no rows written, no LLM calls made.");
	}
	if (inventory.partial) {
		console.log(`Partial scan: resume with --cursor "${nextCursor?.domain},${nextCursor?.brandId}".`);
	}
}

main().then(
	() => process.exit(0),
	(error) => {
		console.error(error);
		process.exit(1);
	},
);
