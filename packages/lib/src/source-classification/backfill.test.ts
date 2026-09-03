import { Buffer } from "node:buffer";
import { describe, expect, it, vi } from "vitest";
import {
	BACKFILL_MAX_BATCH_SIZE,
	type BackfillBrandContext,
	type BackfillCitationPageRow,
	type BackfillCursor,
	type BackfillInventory,
	type BackfillPagedSource,
	type BackfillRunResult,
	backfillOrderingKey,
	decodeBackfillCursorToken,
	encodeBackfillCursorToken,
	runSourceClassificationBackfill,
} from "./backfill";
import { SOURCE_CLASSIFIER_VERSION } from "./types";

const brandContexts = new Map<string, BackfillBrandContext>([
	["brand-a", { brandDomains: new Set(["mybrand.com"]), competitorDomains: new Set(["rival.io"]) }],
	["brand-b", { brandDomains: new Set(["otherbrand.com"]), competitorDomains: new Set<string>() }],
]);

const row = (domain: string, brandId: string, citationCount = 1): BackfillCitationPageRow => ({
	key: backfillOrderingKey(domain),
	domain,
	brandId,
	citationCount,
});

/**
 * Explicit (key, domain, brandId) tuple comparator — element-by-element, so
 * no joined-string delimiter can collide with data (and no exotic bytes are
 * needed in this file).
 */
type CursorTuple = readonly [string, string, string];
const tupleOf = (r: { key: string; domain: string; brandId: string }): CursorTuple => [r.key, r.domain, r.brandId];
function compareTuples(a: CursorTuple, b: CursorTuple): number {
	for (let i = 0; i < 3; i++) {
		if (a[i] < b[i]) return -1;
		if (a[i] > b[i]) return 1;
	}
	return 0;
}

/**
 * In-memory keyset source ordered by (key, domain, brandId) — mirrors the SQL
 * pagination exactly, including a nextCursor only when the page is full.
 */
function memorySource(
	rows: BackfillCitationPageRow[],
	cachedVersions: Map<string, string> = new Map(),
): BackfillPagedSource & { citationPageCalls: number[]; cacheCalls: string[][] } {
	const sorted = [...rows].sort((a, b) => compareTuples(tupleOf(a), tupleOf(b)));
	const citationPageCalls: number[] = [];
	const cacheCalls: string[][] = [];
	return {
		citationPageCalls,
		cacheCalls,
		async fetchCitationPage(cursor: BackfillCursor | null, batchSize: number) {
			citationPageCalls.push(batchSize);
			const start = cursor ? sorted.findIndex((r) => compareTuples(tupleOf(r), tupleOf(cursor)) > 0) : 0;
			const slice = start === -1 ? [] : sorted.slice(start, start + batchSize);
			const last = slice[slice.length - 1];
			return {
				rows: slice,
				nextCursor:
					slice.length === batchSize && last ? { key: last.key, domain: last.domain, brandId: last.brandId } : null,
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

/** Re-run the backfill from each returned resume token until it completes. */
async function runToCompletion(
	makeArgs: (cursor: BackfillCursor | null) => Parameters<typeof runSourceClassificationBackfill>[0],
	maxRuns = 20,
): Promise<BackfillRunResult[]> {
	const results: BackfillRunResult[] = [];
	let cursor: BackfillCursor | null = null;
	for (let i = 0; i < maxRuns; i++) {
		const result = await runSourceClassificationBackfill(makeArgs(cursor));
		results.push(result);
		if (!result.inventory.partial) return results;
		expect(result.nextCursor).not.toBeNull();
		cursor = result.nextCursor;
	}
	throw new Error("resume sequence did not complete");
}

function sumInventories(results: BackfillRunResult[]): Omit<BackfillInventory, "partial" | "pagesScanned"> {
	const sum = {
		scannedCitations: 0,
		distinctHostnames: 0,
		invalid: 0,
		brandOrCompetitorSkipped: 0,
		cachedCurrentSkipped: 0,
		staleCached: 0,
		eligible: 0,
	};
	for (const { inventory } of results) {
		for (const key of Object.keys(sum) as (keyof typeof sum)[]) sum[key] += inventory[key];
	}
	return sum;
}

const DATASET = [
	row("unknown-source.de", "brand-a", 3),
	row("unknown-source.de", "brand-b", 2),
	row("www.unknown-source.de", "brand-a", 1), // same logical hostname, contiguous by key
	row("not a domain", "brand-a"),
	row("mybrand.com", "brand-a"),
	row("rival.io", "brand-a"),
	row("otherbrand.com", "brand-a"),
	row("otherbrand.com", "brand-b"),
	row("wikipedia.org", "brand-a"),
	row("cached-current.de", "brand-a"),
	row("cached-stale.de", "brand-a"),
	row("zeta-source.de", "brand-b"),
];

const CACHE = new Map([
	["cached-current.de", SOURCE_CLASSIFIER_VERSION],
	["cached-stale.de", "f05-v0"],
]);

const FULL_SCAN_COUNTS = {
	scannedCitations: 15,
	// unknown-source.de (www variant merges by key), invalid, mybrand, rival,
	// otherbrand, wikipedia, cached-current, cached-stale, zeta-source
	distinctHostnames: 9,
	invalid: 1,
	brandOrCompetitorSkipped: 2,
	cachedCurrentSkipped: 1,
	staleCached: 1,
	// unknown-source.de, otherbrand.com, wikipedia.org (deterministically known
	// domains stay eligible), cached-stale.de, zeta-source.de
	eligible: 5,
};

describe("runSourceClassificationBackfill — dry run", () => {
	it("counts a multi-page dataset exactly like a single page, with bounded batches", async () => {
		for (const batchSize of [1, 2, 3, 5, 1000]) {
			const result = await runSourceClassificationBackfill({
				source: memorySource(DATASET, CACHE),
				brandContexts,
				batchSize,
			});
			expect(result.inventory, `batchSize=${batchSize}`).toMatchObject({ ...FULL_SCAN_COUNTS, partial: false });
			expect(result.nextCursor).toBeNull();
		}
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

	it("a maxPages-bounded dry-run sequence sums to exactly the full-scan counts", async () => {
		const results = await runToCompletion((cursor) => ({
			source: memorySource(DATASET, CACHE),
			brandContexts,
			batchSize: 3,
			maxPages: 1,
			cursor,
		}));
		expect(results.length).toBeGreaterThan(1);
		expect(sumInventories(results)).toEqual(FULL_SCAN_COUNTS);
	});
});

// F05-RC2-AT-003 — one logical hostname whose brand rows lie on both sides of
// a maxPages/resume boundary must aggregate and decide exactly as in a
// continuous scan: one decision, one count, at most one enqueue attempt.
describe("F05-RC2-AT-003 — logical hostname straddles the stop boundary", () => {
	// otherbrand.com is brand-b's own domain: only the FULL {brand-a, brand-b}
	// aggregation makes it eligible (brand-a cites it as a plain source). Rows
	// sort as: cached-current | otherbrand(brand-a) || otherbrand(brand-b) | zeta
	// with batchSize 2, so the group straddles the page-1/page-2 boundary.
	const straddleData = [
		row("cached-current.de", "brand-a"),
		row("otherbrand.com", "brand-a"),
		row("otherbrand.com", "brand-b"),
		row("zeta-source.de", "brand-b"),
	];

	it("resumed runs give the same decisions and counts as a continuous scan, without double counting", async () => {
		const continuous = await runSourceClassificationBackfill({
			source: memorySource(straddleData, CACHE),
			brandContexts,
			batchSize: 1000,
		});
		const bounded = await runToCompletion((cursor) => ({
			source: memorySource(straddleData, CACHE),
			brandContexts,
			batchSize: 2,
			maxPages: 1,
			cursor,
		}));
		const { partial: _p, pagesScanned: _g, ...continuousCounts } = continuous.inventory;
		expect(sumInventories(bounded)).toEqual(continuousCounts);
		expect(sumInventories(bounded).eligible).toBe(2); // otherbrand.com + zeta-source.de
	});

	it("enqueues the straddling hostname exactly once across the resume sequence", async () => {
		const sent: string[] = [];
		await runToCompletion((cursor) => ({
			source: memorySource(straddleData, CACHE),
			brandContexts,
			batchSize: 2,
			maxPages: 1,
			cursor,
			enqueue: {
				limit: 100,
				send: async (hostname: string) => {
					sent.push(hostname);
					return `job-${hostname}`;
				},
			},
		}));
		expect(sent.filter((h) => h === "otherbrand.com")).toHaveLength(1);
		expect(new Set(sent).size).toBe(sent.length);
	});
});

describe("runSourceClassificationBackfill — enqueue mode", () => {
	const threeEligible = [
		row("alpha-source.de", "brand-a"),
		row("beta-source.de", "brand-a"),
		row("gamma-source.de", "brand-b"),
	];

	it("requires an explicit positive limit", async () => {
		await expect(
			runSourceClassificationBackfill({
				source: memorySource(DATASET, CACHE),
				brandContexts,
				enqueue: { send: async () => "id", limit: 0 },
			}),
		).rejects.toThrow(/positive integer limit/);
	});

	// F05-RC2-AT-001 — final-page limit: batchSize larger than the dataset,
	// limit 1: repeated resume must reach every eligible hostname.
	it("does not lose eligible hostnames beyond the limit on the final page", async () => {
		const sent: string[] = [];
		const results = await runToCompletion((cursor) => ({
			source: memorySource(threeEligible),
			brandContexts,
			batchSize: 100,
			cursor,
			enqueue: {
				limit: 1,
				send: async (hostname: string) => {
					sent.push(hostname);
					return `job-${hostname}`;
				},
			},
		}));

		// The first run must NOT claim completion while two hostnames are unprocessed.
		expect(results[0].inventory.partial).toBe(true);
		expect(results[0].accepted).toBe(1);
		// Every hostname is eventually accepted exactly once — none lost, none repeated.
		expect(sent.sort()).toEqual(["alpha-source.de", "beta-source.de", "gamma-source.de"]);
		expect(results.reduce((n, r) => n + r.accepted, 0)).toBe(3);
		expect(sumInventories(results).eligible).toBe(3);
		expect(results[results.length - 1].inventory.partial).toBe(false);
	});

	// F05-RC2-AT-002 — the limit lands on the first eligible hostname of a page
	// that still holds more eligible hostnames after it.
	it("resumes the remaining eligible hostnames of the same page", async () => {
		// alpha (eligible) | mybrand (brand skip) | beta, gamma (eligible)
		const data = [
			row("alpha-source.de", "brand-a"),
			row("mybrand.com", "brand-a"),
			row("beta-source.de", "brand-a"),
			row("gamma-source.de", "brand-b"),
		];
		const sent: string[] = [];
		const results = await runToCompletion((cursor) => ({
			source: memorySource(data),
			brandContexts,
			batchSize: 100,
			cursor,
			enqueue: {
				limit: 1,
				send: async (hostname: string) => {
					sent.push(hostname);
					return `job-${hostname}`;
				},
			},
		}));
		expect(sent.sort()).toEqual(["alpha-source.de", "beta-source.de", "gamma-source.de"]);
		expect(sumInventories(results)).toMatchObject({ eligible: 3, brandOrCompetitorSkipped: 1 });
	});

	// F05-RC-AT-002 (retained) — a null send is deduplicated, not accepted, and
	// does not consume the accepted limit.
	it("counts deduplicated sends separately and does not charge them against the limit", async () => {
		const sent: string[] = [];
		const results = await runToCompletion((cursor) => ({
			source: memorySource(threeEligible),
			brandContexts,
			batchSize: 100,
			cursor,
			enqueue: {
				limit: 2,
				send: async (hostname: string) => {
					sent.push(hostname);
					return hostname === "alpha-source.de" ? null : `job-${hostname}`;
				},
			},
		}));
		expect(results.reduce((n, r) => n + r.accepted, 0)).toBe(2);
		expect(results.reduce((n, r) => n + r.deduplicated, 0)).toBe(1);
		expect(sent.sort()).toEqual(["alpha-source.de", "beta-source.de", "gamma-source.de"]);
	});

	// F05-RC2-AT-004 — accepted / null-deduplicated / thrown / unprocessed-after-
	// limit within one page: nothing is lost and every counter is unambiguous.
	it("handles mixed outcomes on one page and retries the failed hostname on resume", async () => {
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const data = [
			row("alpha-source.de", "brand-a"), // accepted
			row("beta-source.de", "brand-a"), // deduplicated (null)
			row("delta-source.de", "brand-a"), // throws on first attempt
			row("gamma-source.de", "brand-b"), // left beyond the limit on run 1
		];
		let deltaAttempts = 0;
		const sent: string[] = [];
		const send = async (hostname: string) => {
			sent.push(hostname);
			if (hostname === "beta-source.de") return null;
			if (hostname === "delta-source.de" && deltaAttempts++ === 0) throw new Error("pg-boss unavailable");
			return `job-${hostname}`;
		};

		const first = await runSourceClassificationBackfill({
			source: memorySource(data),
			brandContexts,
			batchSize: 100,
			enqueue: { send, limit: 3 },
		});
		expect(first).toMatchObject({ attempted: 3, accepted: 1, deduplicated: 1, failed: 1 });
		expect(first.inventory.partial).toBe(true);
		// The cursor stops before the failed hostname so a resume retries it.
		expect(first.nextCursor?.key).toBe("beta-source.de");

		const rest = await runToCompletion((cursor) => ({
			source: memorySource(data),
			brandContexts,
			batchSize: 100,
			cursor: cursor ?? first.nextCursor,
			enqueue: { send, limit: 3 },
		}));
		const all = [first, ...rest];
		expect(sent.filter((h) => h === "delta-source.de")).toHaveLength(2); // failed once, retried once
		expect(all.reduce((n, r) => n + r.accepted, 0)).toBe(3); // alpha, delta, gamma
		expect(all.reduce((n, r) => n + r.deduplicated, 0)).toBe(1); // beta
		expect(all.reduce((n, r) => n + r.failed, 0)).toBe(1);
		expect(sumInventories(all).eligible).toBe(4); // each hostname counted exactly once
		errorSpy.mockRestore();
	});
});

// F05-RC2-AT-005 — per-run state is bounded by the batch size, independent of
// how many distinct domains exist.
describe("F05-RC2-AT-005 — bounded state", () => {
	it("never holds more than batchSize + 1 hostname groups, over a dataset far larger than a page", async () => {
		const bigDataset = Array.from({ length: 200 }, (_, i) =>
			row(`source-${String(i).padStart(3, "0")}.example.de`, i % 2 === 0 ? "brand-a" : "brand-b"),
		);
		const batchSize = 5;
		const source = memorySource(bigDataset);
		const result = await runSourceClassificationBackfill({ source, brandContexts, batchSize });
		expect(result.inventory.distinctHostnames).toBe(200);
		expect(result.peakPendingGroups).toBeLessThanOrEqual(batchSize + 1);
		// Cache lookups are per-page batches, never table-sized.
		expect(Math.max(...source.cacheCalls.map((call) => call.length))).toBeLessThanOrEqual(batchSize);
	});
});

// F05-RC3-001 — a run stopped before ANY hostname settled (first enqueue
// throws) must still yield an actionable resume token that restarts the scan
// from the beginning and retries the failed hostname.
describe("F05-RC3 — resume token when the first enqueue fails", () => {
	const oneEligible = [row("alpha-source.de", "brand-a")];

	// F05-RC3-AT-001 — runner-level contract for the failing first send.
	it("reports partial with no settled cursor when the very first send throws", async () => {
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const result = await runSourceClassificationBackfill({
			source: memorySource(oneEligible),
			brandContexts,
			batchSize: 100,
			enqueue: {
				limit: 1,
				send: async () => {
					throw new Error("pg-boss unavailable");
				},
			},
		});
		expect(result.inventory.partial).toBe(true);
		expect(result).toMatchObject({ attempted: 1, failed: 1, accepted: 0, deduplicated: 0 });
		expect(result.inventory.eligible).toBe(0); // nothing settled, nothing counted
		expect(result.nextCursor).toBeNull(); // no settled group to point at
		errorSpy.mockRestore();
	});

	// F05-RC3-AT-002 — the opaque token codec covers the start position.
	it("encodes the start position as a non-empty token that round-trips to the beginning", () => {
		const startToken = encodeBackfillCursorToken(null);
		expect(startToken).toBeTruthy();
		expect(startToken).not.toBe("null");
		expect(decodeBackfillCursorToken(startToken)).toBeNull();

		const cursor = { key: "alpha-source.de", domain: "alpha-source.de", brandId: "brand-a" };
		expect(decodeBackfillCursorToken(encodeBackfillCursorToken(cursor))).toEqual(cursor);

		// Legacy tokens (plain cursor JSON, pre-sentinel) keep decoding.
		const legacy = Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
		expect(decodeBackfillCursorToken(legacy)).toEqual(cursor);

		for (const invalid of ["null", "", "not-base64!", Buffer.from("[1,2]").toString("base64url")]) {
			expect(() => decodeBackfillCursorToken(invalid), JSON.stringify(invalid)).toThrow();
		}
	});

	// F05-RC3-AT-003 — a rerun from the decoded start token retries the failed
	// hostname and completes without losing or double-counting it.
	it("retries the failed hostname from the start token and counts it exactly once", async () => {
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const sent: string[] = [];
		let attempts = 0;
		const send = async (hostname: string) => {
			sent.push(hostname);
			if (attempts++ === 0) throw new Error("pg-boss unavailable");
			return `job-${hostname}`;
		};

		const first = await runSourceClassificationBackfill({
			source: memorySource(oneEligible),
			brandContexts,
			batchSize: 100,
			enqueue: { send, limit: 1 },
		});
		expect(first.inventory.partial).toBe(true);

		const resumeCursor = decodeBackfillCursorToken(encodeBackfillCursorToken(first.nextCursor));
		const second = await runSourceClassificationBackfill({
			source: memorySource(oneEligible),
			brandContexts,
			batchSize: 100,
			cursor: resumeCursor,
			enqueue: { send, limit: 1 },
		});
		expect(second.inventory.partial).toBe(false);
		expect(second).toMatchObject({ accepted: 1, failed: 0 });
		expect(sent).toEqual(["alpha-source.de", "alpha-source.de"]); // failed once, retried once
		expect(sumInventories([first, second]).eligible).toBe(1); // counted exactly once
		errorSpy.mockRestore();
	});
});
