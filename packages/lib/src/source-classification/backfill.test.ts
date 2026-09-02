import { describe, expect, it, vi } from "vitest";
import {
	BACKFILL_MAX_BATCH_SIZE,
	type BackfillBrandContext,
	type BackfillCitationPageRow,
	type BackfillCursor,
	type BackfillPagedSource,
	runSourceClassificationBackfill,
} from "./backfill";
import { SOURCE_CLASSIFIER_VERSION } from "./types";

const brandContexts = new Map<string, BackfillBrandContext>([
	["brand-a", { brandDomains: new Set(["mybrand.com"]), competitorDomains: new Set(["rival.io"]) }],
	["brand-b", { brandDomains: new Set(["otherbrand.com"]), competitorDomains: new Set<string>() }],
]);

const row = (domain: string, brandId: string, citationCount = 1): BackfillCitationPageRow => ({
	domain,
	brandId,
	citationCount,
});

/**
 * In-memory keyset source over a sorted grouped row list — mirrors the SQL
 * pagination exactly, including a nextCursor only when the page is full.
 */
function memorySource(
	rows: BackfillCitationPageRow[],
	cachedVersions: Map<string, string> = new Map(),
): BackfillPagedSource & { citationPageCalls: number[]; cacheCalls: string[][] } {
	const sorted = [...rows].sort((a, b) => a.domain.localeCompare(b.domain) || a.brandId.localeCompare(b.brandId));
	const citationPageCalls: number[] = [];
	const cacheCalls: string[][] = [];
	return {
		citationPageCalls,
		cacheCalls,
		async fetchCitationPage(cursor: BackfillCursor | null, batchSize: number) {
			citationPageCalls.push(batchSize);
			const start = cursor
				? sorted.findIndex(
						(r) => r.domain > cursor.domain || (r.domain === cursor.domain && r.brandId > cursor.brandId),
					)
				: 0;
			const slice = start === -1 ? [] : sorted.slice(start, start + batchSize);
			const last = slice[slice.length - 1];
			return {
				rows: slice,
				nextCursor: slice.length === batchSize && last ? { domain: last.domain, brandId: last.brandId } : null,
			};
		},
		async fetchCachedVersions(hostnames: string[]) {
			cacheCalls.push(hostnames);
			const result = new Map<string, string>();
			for (const hostname of hostnames) {
				const version = cachedVersions.get(hostname);
				if (version !== undefined) result.set(hostname, version);
			}
			return result;
		},
	};
}

const DATASET = [
	// eligible hostname cited by two brands, plus a www variant
	row("unknown-source.de", "brand-a", 3),
	row("unknown-source.de", "brand-b", 2),
	row("www.unknown-source.de", "brand-a", 1),
	// invalid
	row("not a domain", "brand-a"),
	// brand/competitor for every citing brand
	row("mybrand.com", "brand-a"),
	row("rival.io", "brand-a"),
	// brand for one brand, plain source for another -> eligible
	row("otherbrand.com", "brand-a"),
	row("otherbrand.com", "brand-b"),
	// deterministic
	row("wikipedia.org", "brand-a"),
	// cached
	row("cached-current.de", "brand-a"),
	row("cached-stale.de", "brand-a"),
	// more eligible hostnames for limit tests
	row("zeta-source.de", "brand-b"),
];

const CACHE = new Map([
	["cached-current.de", SOURCE_CLASSIFIER_VERSION],
	["cached-stale.de", "f05-v0"],
]);

describe("runSourceClassificationBackfill — dry run", () => {
	// F05-RC-AT-005 — a dataset spanning many small pages is processed without
	// loss or duplication, including a domain whose rows straddle a page boundary.
	it("counts a multi-page dataset exactly like a single page, with bounded batches", async () => {
		const singlePage = await runSourceClassificationBackfill({
			source: memorySource(DATASET, CACHE),
			brandContexts,
			batchSize: 1000,
		});
		for (const batchSize of [1, 2, 3, 5]) {
			const paged = await runSourceClassificationBackfill({
				source: memorySource(DATASET, CACHE),
				brandContexts,
				batchSize,
			});
			expect({ ...paged.inventory, pagesScanned: 0 }, `batchSize=${batchSize}`).toEqual({
				...singlePage.inventory,
				pagesScanned: 0,
			});
		}
		expect(singlePage.inventory).toMatchObject({
			scannedCitations: 15,
			// unknown-source.de (www variant folds into it), invalid, mybrand, rival,
			// otherbrand, wikipedia, cached-current, cached-stale, zeta-source
			distinctHostnames: 9,
			invalid: 1,
			brandOrCompetitorSkipped: 2,
			deterministicSkipped: 1,
			cachedCurrentSkipped: 1,
			staleCached: 1,
			eligible: 4, // unknown-source.de, otherbrand.com, cached-stale.de, zeta-source.de
			partial: false,
		});
		expect(singlePage.nextCursor).toBeNull();
	});

	// F05-RC-AT-006 — dry-run performs no enqueue and is repeatable.
	it("is read-only and idempotent: identical counts on a second run, no sends", async () => {
		const source = memorySource(DATASET, CACHE);
		const first = await runSourceClassificationBackfill({ source, brandContexts, batchSize: 3 });
		const second = await runSourceClassificationBackfill({ source, brandContexts, batchSize: 3 });
		expect(second.inventory).toEqual(first.inventory);
		expect(first).toMatchObject({ attempted: 0, accepted: 0, deduplicated: 0, failed: 0 });
	});

	it("clamps the batch size to the hard maximum", async () => {
		const source = memorySource(DATASET, CACHE);
		await runSourceClassificationBackfill({ source, brandContexts, batchSize: 10_000_000 });
		expect(Math.max(...source.citationPageCalls)).toBe(BACKFILL_MAX_BATCH_SIZE);
	});

	it("reports a bounded scan as partial with a resumable cursor that continues, not repeats", async () => {
		const source = memorySource(DATASET, CACHE);
		const first = await runSourceClassificationBackfill({ source, brandContexts, batchSize: 4, maxPages: 1 });
		expect(first.inventory.partial).toBe(true);
		expect(first.inventory.pagesScanned).toBe(1);
		expect(first.nextCursor).not.toBeNull();

		const resumed = await runSourceClassificationBackfill({
			source: memorySource(DATASET, CACHE),
			brandContexts,
			batchSize: 4,
			cursor: first.nextCursor,
		});
		expect(resumed.inventory.partial).toBe(false);
		// Together the two bounded runs cover every citation.
		expect(first.inventory.scannedCitations + resumed.inventory.scannedCitations).toBe(15);
	});
});

describe("runSourceClassificationBackfill — enqueue mode", () => {
	it("requires an explicit positive limit", async () => {
		await expect(
			runSourceClassificationBackfill({
				source: memorySource(DATASET, CACHE),
				brandContexts,
				enqueue: { send: async () => "id", limit: 0 },
			}),
		).rejects.toThrow(/positive integer limit/);
	});

	// F05-RC-AT-002 (backfill side) + hard accepted cap.
	it("caps ACCEPTED jobs at the limit; deduplicated sends do not consume it", async () => {
		const sent: string[] = [];
		const send = vi.fn(async (hostname: string) => {
			sent.push(hostname);
			// First eligible hostname is already queued -> exclusive policy dedupes.
			return hostname === "cached-stale.de" ? null : `job-${hostname}`;
		});
		const result = await runSourceClassificationBackfill({
			source: memorySource(DATASET, CACHE),
			brandContexts,
			batchSize: 3,
			enqueue: { send, limit: 2 },
		});
		expect(result.accepted).toBe(2);
		expect(result.deduplicated).toBe(1);
		expect(result.attempted).toBe(3);
		expect(new Set(sent).size).toBe(sent.length); // no hostname attempted twice
	});

	// F05-RC-AT-003 (backfill side) — a failing send never resets earlier successes.
	it("keeps earlier accepted jobs when a later send fails", async () => {
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		let calls = 0;
		const send = async () => {
			calls++;
			if (calls === 2) throw new Error("pg-boss unavailable");
			return `job-${calls}`;
		};
		const result = await runSourceClassificationBackfill({
			source: memorySource(DATASET, CACHE),
			brandContexts,
			batchSize: 3,
			enqueue: { send, limit: 10 },
		});
		expect(result.accepted).toBe(3);
		expect(result.failed).toBe(1);
		expect(result.attempted).toBe(4);
		errorSpy.mockRestore();
	});

	it("stops scanning once the limit is reached and returns a resume cursor when data remains", async () => {
		const source = memorySource(DATASET, CACHE);
		const result = await runSourceClassificationBackfill({
			source,
			brandContexts,
			batchSize: 2,
			enqueue: { send: async (h) => `job-${h}`, limit: 1 },
		});
		expect(result.accepted).toBe(1);
		// The dataset holds more eligible hostnames, so the bounded run is partial.
		expect(result.inventory.partial).toBe(true);
		expect(result.nextCursor).not.toBeNull();
	});
});
