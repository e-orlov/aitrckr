#!/usr/bin/env tsx
/**
 * F-05 historical backfill: inventory (default) or bounded enqueue of
 * classification jobs for hostnames cited historically that are still
 * unresolved for the current classifier version.
 *
 * Modes:
 *   - DRY RUN (default): scans citations, applies the same eligibility rules
 *     as live ingestion, and prints counts. No DB write, no queue send, no LLM
 *     call. Safe to repeat; counts are stable for the same data.
 *   - ENQUEUE: requires BOTH `--enqueue` and a positive `--limit N`. Sends at
 *     most N classify-source-domain jobs (deduplicated globally by normalized
 *     hostname and by pg-boss singleton key). Still makes no LLM call itself —
 *     the worker processes the queued jobs.
 *
 * Running this against production (or any shared database) is an operations
 * action that belongs to a separately authorized deployment phase — do not
 * point it at a database you don't own for that purpose.
 *
 * Usage (from apps/worker):
 *   pnpm backfill:source-classification                      # dry run
 *   pnpm backfill:source-classification -- --enqueue --limit 100
 */
import { parseArgs } from "node:util";
import { db } from "@workspace/lib/db/db";
import { brands, citations, competitors, sourceDomainClassifications } from "@workspace/lib/db/schema";
import {
	type BackfillBrandContext,
	SOURCE_CLASSIFICATION_QUEUE,
	SOURCE_CLASSIFIER_VERSION,
	selectBackfillCandidates,
	sourceClassificationSingletonKey,
} from "@workspace/lib/source-classification";
import { sql } from "drizzle-orm";
import boss from "../src/boss";

function extractDomainFromUrl(urlOrDomain: string): string {
	try {
		const url = new URL(urlOrDomain.startsWith("http") ? urlOrDomain : `https://${urlOrDomain}`);
		return url.hostname.replace(/^www\./, "").toLowerCase();
	} catch {
		return urlOrDomain.replace(/^www\./, "").toLowerCase();
	}
}

async function main(): Promise<void> {
	const { values } = parseArgs({
		options: {
			enqueue: { type: "boolean", default: false },
			limit: { type: "string" },
		},
	});

	const limit = values.limit === undefined ? undefined : Number(values.limit);
	if (values.enqueue && (!Number.isInteger(limit) || (limit as number) <= 0)) {
		console.error("--enqueue requires an explicit positive --limit N (batch size bound).");
		process.exit(2);
	}

	// Distinct (domain, brand) pairs with citation counts — one bounded scan.
	const domainRows = await db
		.select({
			domain: citations.domain,
			brandId: citations.brandId,
			count: sql<number>`count(*)::int`,
		})
		.from(citations)
		.groupBy(citations.domain, citations.brandId);

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

	const cachedVersions = new Map<string, string>();
	const cacheRows = await db
		.select({
			hostname: sourceDomainClassifications.hostname,
			classifierVersion: sourceDomainClassifications.classifierVersion,
		})
		.from(sourceDomainClassifications);
	for (const row of cacheRows) cachedVersions.set(row.hostname, row.classifierVersion);

	const scannedCitations = domainRows.reduce((sum, row) => sum + Number(row.count), 0);
	const { inventory, eligibleHostnames } = selectBackfillCandidates({
		citations: domainRows.map((row) => ({ domain: row.domain, brandId: row.brandId })),
		brandContexts,
		cachedVersions,
	});
	// The grouped scan collapses per-citation rows; restore the true citation count.
	inventory.scannedCitations = scannedCitations;

	const mode = values.enqueue ? "ENQUEUE" : "DRY RUN";
	console.log(`F-05 backfill (${mode}) — classifier version ${SOURCE_CLASSIFIER_VERSION}`);
	console.log(JSON.stringify({ ...inventory, mode, limit: limit ?? null }, null, 2));

	if (!values.enqueue) {
		console.log("Dry run: no jobs enqueued, no rows written, no LLM calls made.");
		return;
	}

	const toEnqueue = eligibleHostnames.slice(0, limit as number);
	await boss.start();
	let enqueued = 0;
	for (const hostname of toEnqueue) {
		await boss.send(
			SOURCE_CLASSIFICATION_QUEUE,
			{ hostname, classifierVersion: SOURCE_CLASSIFIER_VERSION, builtInCategory: "other" as const },
			{ singletonKey: sourceClassificationSingletonKey(hostname, SOURCE_CLASSIFIER_VERSION) },
		);
		enqueued++;
	}
	await boss.stop({ graceful: true, timeout: 10_000 });
	console.log(JSON.stringify({ enqueued, remainingEligible: eligibleHostnames.length - enqueued }, null, 2));
}

main().then(
	() => process.exit(0),
	(error) => {
		console.error(error);
		process.exit(1);
	},
);
