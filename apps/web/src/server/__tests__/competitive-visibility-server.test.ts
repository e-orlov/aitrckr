import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// `createServerFn` is a Vite-transformed builder; stand it in with one that
// hands the validated payload straight to the handler so the wire contract
// (validator → auth → brand access → reads → response) runs in-process.
const captured = vi.hoisted(() => ({
	schema: undefined as undefined | { parse: (value: unknown) => unknown },
}));
vi.mock("@tanstack/react-start", () => {
	const builder = {
		validator(schema: { parse: (value: unknown) => unknown }) {
			captured.schema = schema;
			return builder;
		},
		handler(fn: (ctx: { data: unknown }) => Promise<unknown>) {
			return async (call: { data: unknown }) => fn({ data: captured.schema?.parse(call.data) });
		},
	};
	return { createServerFn: () => builder };
});

const auth = vi.hoisted(() => ({
	session: null as null | { user: { id: string } },
	allowed: new Set<string>(),
	calls: [] as string[],
}));
vi.mock("@/lib/auth/helpers", () => ({
	requireAuthSession: async () => {
		auth.calls.push("session");
		if (!auth.session) throw new Error("Unauthorized: Authentication required");
		return auth.session;
	},
	requireBrandAccess: async (userId: string, brandId: string) => {
		auth.calls.push(`access:${userId}:${brandId}`);
		if (!auth.allowed.has(`${userId}:${brandId}`)) throw new Error("Forbidden: No access to this brand");
	},
}));

// Drizzle is replaced by an in-memory table dispatch so the real
// resolveFilteredPrompts (enabled + tag + search semantics) runs against fixtures.
const store = vi.hoisted(() => ({
	brands: [] as { id: string; name: string }[],
	competitors: [] as { id: string; brandId: string; name: string }[],
	prompts: [] as {
		id: string;
		brandId: string;
		value: string;
		enabled: boolean;
		tags: string[];
		systemTags: string[];
	}[],
	runs: [] as { prompt_id: string; date: string; total_runs: number; brand_mentioned_count: number; model: string }[],
	competitorRuns: [] as { prompt_id: string; date: string; competitor: string; runs: number; model: string }[],
	citations: 0,
	reads: [] as { fn: string; args: unknown[] }[],
	failReads: false,
}));
vi.mock("@workspace/lib/db/db", async () => {
	const schema = await import("@workspace/lib/db/schema");
	const { PgDialect } = await import("drizzle-orm/pg-core");
	const { SQL } = await import("drizzle-orm");
	const dialect = new PgDialect();
	const select = () => ({
		from(table: unknown) {
			return {
				where: (condition: unknown) => {
					if (!(condition instanceof SQL)) throw new Error("where() expects a drizzle SQL condition");
					const { params } = dialect.sqlToQuery(condition);
					const brandId = params[0] as string;
					let result: unknown[];
					if (table === schema.brands) {
						result = store.brands.filter((b) => b.id === brandId).map((b) => ({ id: b.id, name: b.name }));
					} else if (table === schema.competitors) {
						result = store.competitors.filter((c) => c.brandId === brandId).map((c) => ({ id: c.id, name: c.name }));
					} else {
						result = store.prompts
							.filter((p) => p.brandId === brandId && p.enabled === (params[1] as boolean))
							.map((p) => ({ id: p.id, value: p.value, tags: p.tags, systemTags: p.systemTags }));
					}
					return Object.assign(Promise.resolve(result), { limit: async () => result.slice(0, 1) });
				},
			};
		},
	});
	return { db: { select } };
});
vi.mock("@/lib/postgres-read", () => ({
	getPerPromptVisibilityTimeSeries: async (...args: unknown[]) => {
		store.reads.push({ fn: "runs", args });
		if (store.failReads) throw new Error("connection terminated unexpectedly");
		const [, , , , promptIds, model] = args as [string, string, string, string, string[], string | undefined];
		return store.runs
			.filter((r) => promptIds.includes(r.prompt_id) && (!model || r.model === model))
			.map(({ model: _m, ...row }) => row);
	},
	getPerPromptDailyCompetitorRuns: async (...args: unknown[]) => {
		store.reads.push({ fn: "competitorRuns", args });
		if (store.failReads) throw new Error("connection terminated unexpectedly");
		const [, , , , promptIds, model] = args as [string, string, string, string, string[], string | undefined];
		return store.competitorRuns
			.filter((r) => promptIds.includes(r.prompt_id) && (!model || r.model === model))
			.map(({ model: _m, ...row }) => row);
	},
	getCitationsTotalCount: async (...args: unknown[]) => {
		store.reads.push({ fn: "citations", args });
		if (store.failReads) throw new Error("connection terminated unexpectedly");
		return store.citations;
	},
}));

import { generateDateRange } from "@/lib/chart-utils";
import { BRAND_SERIES_KEY } from "@/lib/competitive-visibility";
import { type CompetitiveVisibilityResponse, getCompetitiveVisibilityFn } from "@/server/competitive-visibility";

const BRAND = "arag";
const USER = "u1";
const NOW = new Date("2026-09-06T12:00:00Z");
// 1w in UTC from NOW: 2026-08-31 .. 2026-09-06 inclusive.
const D = ["2026-08-31", "2026-09-01", "2026-09-02", "2026-09-03", "2026-09-04", "2026-09-05", "2026-09-06"];
const COMPETITORS = ["Advocard", "Allianz", "Roland", "Deurag", "DAS", "WGV", "Huk", "Ergo", "Auxilia"].map(
	(name, i) => ({
		id: `c-${i + 1}`,
		brandId: BRAND,
		name,
	}),
);

function call(data: Record<string, unknown>) {
	return getCompetitiveVisibilityFn({
		data: { brandId: BRAND, timezone: "UTC", lookback: "1w", ...data },
	}) as Promise<CompetitiveVisibilityResponse>;
}
const resolvedPromptIds = () =>
	[...((store.reads.find((x) => x.fn === "runs")?.args[4] as string[] | undefined) ?? [])].sort();
const lastNonNull = (r: CompetitiveVisibilityResponse, key: string) =>
	[...r.points].reverse().find((p) => p.visibility[key] !== null)?.visibility[key] ?? null;

beforeAll(() => {
	vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
});
afterAll(() => {
	vi.useRealTimers();
});

beforeEach(() => {
	auth.session = { user: { id: USER } };
	auth.allowed = new Set([`${USER}:${BRAND}`]);
	auth.calls.length = 0;
	store.reads.length = 0;
	store.failReads = false;
	store.brands = [
		{ id: BRAND, name: "ARAG" },
		{ id: "other", name: "Other" },
	];
	store.competitors = [...COMPETITORS, { id: "c-other", brandId: "other", name: "Leak" }];
	store.prompts = [
		{
			id: "p-branded",
			brandId: BRAND,
			value: "beste rechtsschutz",
			enabled: true,
			tags: ["rechtsschutz"],
			systemTags: ["branded"],
		},
		{
			id: "p-unbranded",
			brandId: BRAND,
			value: "was kostet ein anwalt",
			enabled: true,
			tags: [],
			systemTags: ["unbranded"],
		},
		{
			id: "p-claude",
			brandId: BRAND,
			value: "rechtsschutz vergleich",
			enabled: true,
			tags: ["vergleich"],
			systemTags: ["unbranded"],
		},
		{
			id: "p-disabled",
			brandId: BRAND,
			value: "disabled rechtsschutz",
			enabled: false,
			tags: ["rechtsschutz"],
			systemTags: ["branded"],
		},
		{ id: "p-other-brand", brandId: "other", value: "other", enabled: true, tags: [], systemTags: ["branded"] },
	];
	// p-branded: 2 runs on D0 (brand 1, Advocard in both, Allianz in one), 1 run on D3 (brand 1, Roland only).
	// p-unbranded: 1 run on D2 (brand 0, Allianz, Deurag).
	// p-claude: 1 claude run on D5 (brand 1, WGV) — only visible under model=claude.
	// p-disabled / other brand: would dominate if they leaked in.
	store.runs = [
		{ prompt_id: "p-branded", date: D[0], total_runs: 2, brand_mentioned_count: 1, model: "chatgpt" },
		{ prompt_id: "p-branded", date: D[3], total_runs: 1, brand_mentioned_count: 1, model: "chatgpt" },
		{ prompt_id: "p-unbranded", date: D[2], total_runs: 1, brand_mentioned_count: 0, model: "chatgpt" },
		{ prompt_id: "p-claude", date: D[5], total_runs: 1, brand_mentioned_count: 1, model: "claude" },
		{ prompt_id: "p-disabled", date: D[5], total_runs: 50, brand_mentioned_count: 50, model: "chatgpt" },
		{ prompt_id: "p-other-brand", date: D[5], total_runs: 50, brand_mentioned_count: 50, model: "chatgpt" },
	];
	store.competitorRuns = [
		{ prompt_id: "p-branded", date: D[0], competitor: "Advocard", runs: 2, model: "chatgpt" },
		{ prompt_id: "p-branded", date: D[0], competitor: "Allianz", runs: 1, model: "chatgpt" },
		{ prompt_id: "p-branded", date: D[3], competitor: "Roland", runs: 1, model: "chatgpt" },
		{ prompt_id: "p-unbranded", date: D[2], competitor: "Allianz", runs: 1, model: "chatgpt" },
		{ prompt_id: "p-unbranded", date: D[2], competitor: "Deurag", runs: 1, model: "chatgpt" },
		{ prompt_id: "p-claude", date: D[5], competitor: "WGV", runs: 1, model: "claude" },
		{ prompt_id: "p-disabled", date: D[5], competitor: "Leak", runs: 50, model: "chatgpt" },
	];
	store.citations = 17;
});

describe("getCompetitiveVisibilityFn authorization", () => {
	it("rejects an unauthenticated request before reading anything", async () => {
		auth.session = null;
		await expect(call({})).rejects.toThrow(/Unauthorized/);
		expect(auth.calls).toEqual(["session"]);
		expect(store.reads).toEqual([]);
	});

	it("rejects an authenticated user without access to the brand before reading anything", async () => {
		auth.allowed = new Set();
		await expect(call({})).rejects.toThrow(/Forbidden/);
		expect(auth.calls).toEqual(["session", `access:${USER}:${BRAND}`]);
		expect(store.reads).toEqual([]);
	});

	it("serves only the requested brand's enabled prompts and competitors", async () => {
		const r = await call({});
		const promptIds = store.reads.find((x) => x.fn === "runs")?.args[4] as string[];
		expect([...promptIds].sort()).toEqual(["p-branded", "p-claude", "p-unbranded"]);
		expect(r.entities.map((e) => e.name)).not.toContain("Leak");
		expect(r.entities).toHaveLength(1 + COMPETITORS.length);
		expect(r.brand).toEqual({ id: BRAND, name: "ARAG" });
	});
});

describe("getCompetitiveVisibilityFn reads and filters", () => {
	it("performs exactly three run/citation reads, in one round, with identical range, prompts and model", async () => {
		await call({ model: "chatgpt" });
		expect(store.reads.map((x) => x.fn).sort()).toEqual(["citations", "competitorRuns", "runs"]);
		const [a, b, c] = store.reads.map((x) => x.args);
		expect(a.slice(0, 4)).toEqual([BRAND, D[0], D[6], "UTC"]);
		expect(b.slice(0, 4)).toEqual(a.slice(0, 4));
		expect(c.slice(0, 4)).toEqual(a.slice(0, 4));
		expect([...(b[4] as string[])].sort()).toEqual([...(a[4] as string[])].sort());
		expect([a[5], b[5], c[5]]).toEqual(["chatgpt", "chatgpt", "chatgpt"]);
	});

	it("returns the empty payload without any run read when no prompt matches the filters", async () => {
		const r = await call({ tags: "no-such-tag" });
		expect(store.reads).toEqual([]);
		expect(r).toMatchObject({
			brand: { id: BRAND, name: "ARAG" },
			dateRange: { fromDate: D[0], toDate: D[6] },
			asOfDate: null,
			snapshotRuns: 0,
			evaluatedPromptCount: 0,
			windowRuns: 0,
			windowCitations: 0,
			entities: [],
			series: [],
			points: [],
		});
	});

	it("narrows by user tags OR-ed together, including the effective system tag, like the existing resolution", async () => {
		await call({ tags: "rechtsschutz" });
		expect(store.reads.find((x) => x.fn === "runs")?.args[4]).toEqual(["p-branded"]);
		store.reads.length = 0;
		await call({ tags: "rechtsschutz,vergleich" });
		expect(resolvedPromptIds()).toEqual(["p-branded", "p-claude"]);
		store.reads.length = 0;
		await call({ tags: "unbranded" });
		expect(resolvedPromptIds()).toEqual(["p-claude", "p-unbranded"]);
	});

	it("applies the search query to the prompt text — search is part of the Visibility scope", async () => {
		const r = await call({ search: "anwalt" });
		expect(store.reads.find((x) => x.fn === "runs")?.args[4]).toEqual(["p-unbranded"]);
		expect(r.evaluatedPromptCount).toBe(1);
		expect(r.snapshotRuns).toBe(1);
		expect(r.entities.find((e) => e.isBrand)?.visibility).toBe(0);
		expect(r.entities.find((e) => e.name === "Allianz")?.visibility).toBe(100);
	});

	it("scopes runs by model and recomputes roster and points together", async () => {
		const all = await call({});
		const claude = await call({ model: "claude" });
		const chatgpt = await call({ model: "chatgpt" });
		expect(all.snapshotRuns).toBe(3);
		expect(claude.snapshotRuns).toBe(1);
		expect(chatgpt.snapshotRuns).toBe(2);
		expect(claude.entities.find((e) => e.name === "WGV")?.visibility).toBe(100);
		expect(all.entities.find((e) => e.name === "WGV")?.visibility).toBeCloseTo(100 / 3, 10);
		expect(chatgpt.entities.find((e) => e.name === "WGV")?.visibility).toBe(0);
		expect(claude.series.slice(1).map((s) => s.name)).toEqual([
			"WGV",
			"Advocard",
			"Allianz",
			"Auxilia",
			"DAS",
			"Deurag",
		]);
		expect(chatgpt.series.slice(1).map((s) => s.name)).not.toContain("WGV");
		expect(chatgpt.evaluatedPromptCount).toBe(2);
	});

	it("resolves the lookback window in the requested timezone, with all = one year", async () => {
		await call({ timezone: "Pacific/Kiritimati" });
		expect(store.reads[0].args.slice(1, 4)).toEqual(["2026-09-01", "2026-09-07", "Pacific/Kiritimati"]);
		store.reads.length = 0;
		const r = await call({ lookback: "all" });
		expect(store.reads[0].args.slice(1, 3)).toEqual(["2025-09-06", "2026-09-06"]);
		expect(r.dateRange).toEqual({ fromDate: "2025-09-06", toDate: "2026-09-06" });
		// Same date domain as the Overview and Share of Voice build from the same bounds.
		expect(r.points.map((p) => p.date)).toEqual(generateDateRange(new Date("2025-09-06"), new Date("2026-09-06")));
	});

	it("propagates a database failure instead of fabricating zero data", async () => {
		store.failReads = true;
		await expect(call({})).rejects.toThrow(/connection terminated/);
	});
});

describe("getCompetitiveVisibilityFn response contract", () => {
	it("carries exact raw counts that reconcile with every percentage", async () => {
		const r = await call({});
		// Snapshot on D6: p-branded carried from D3 (1 run, brand 1, Roland), p-unbranded from D2 (1 run, Allianz, Deurag),
		// p-claude from D5 (1 run, brand 1, WGV) → 3 runs, brand 2.
		expect(r.asOfDate).toBe(D[6]);
		expect(r.snapshotRuns).toBe(3);
		expect(r.evaluatedPromptCount).toBe(3);
		expect(r.windowRuns).toBe(5);
		expect(r.windowCitations).toBe(17);
		const own = r.entities.find((e) => e.isBrand) as CompetitiveVisibilityResponse["entities"][number];
		expect(own).toMatchObject({ key: BRAND_SERIES_KEY, mentionedRuns: 2, visiblePromptCount: 2 });
		expect(own.visibility).toBeCloseTo((2 / 3) * 100, 10);
		expect(own.coveragePercent).toBeCloseTo((2 / 3) * 100, 10);
		for (const e of r.entities) {
			expect(e.visibility).toBeCloseTo((e.mentionedRuns / r.snapshotRuns) * 100, 10);
			expect(e.coveragePercent).toBeCloseTo((e.visiblePromptCount / r.evaluatedPromptCount) * 100, 10);
			expect(e.visiblePromptCount).toBeLessThanOrEqual(r.evaluatedPromptCount);
			expect(e.visibility as number).toBeGreaterThanOrEqual(0);
			expect(e.visibility as number).toBeLessThanOrEqual(100);
		}
	});

	it("lists every tracked competitor, including those at 0%, ranked deterministically with the brand unpinned", async () => {
		const r = await call({});
		expect(r.entities).toHaveLength(10);
		expect(r.entities.map((e) => e.rank)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
		// brand 2 runs; Allianz, Roland, Deurag, WGV 1 each (name order); the rest 0 in name order.
		expect(r.entities.map((e) => e.name)).toEqual([
			"ARAG",
			"Allianz",
			"Deurag",
			"Roland",
			"WGV",
			"Advocard",
			"Auxilia",
			"DAS",
			"Ergo",
			"Huk",
		]);
		const zero = r.entities.find((e) => e.name === "Ergo");
		expect(zero).toMatchObject({ mentionedRuns: 0, visibility: 0, visiblePromptCount: 0, coveragePercent: 0 });
	});

	it("bounds the trend to the brand plus six competitors, with no Others and no per-prompt data", async () => {
		const r = await call({});
		expect(r.series).toHaveLength(7);
		expect(r.series[0]).toMatchObject({ key: BRAND_SERIES_KEY, isBrand: true, name: "ARAG" });
		expect(r.series.some((s) => s.name === "Others" || s.key === "others")).toBe(false);
		expect(r.points).toHaveLength(7);
		for (const p of r.points) {
			expect(Object.keys(p.visibility).sort()).toEqual(r.series.map((s) => s.key).sort());
		}
		const json = JSON.stringify(r);
		expect(json).not.toMatch(/p-branded|p-unbranded|p-claude|rechtsschutz|prompt_id/);
	});

	it("reconciles the last non-null trend point with every leaderboard value it ships", async () => {
		const r = await call({});
		for (const s of r.series) {
			const entity = r.entities.find((e) => e.key === s.key);
			expect(lastNonNull(r, s.key)).toBe(entity?.visibility);
		}
		expect(lastNonNull(r, BRAND_SERIES_KEY)).toBeCloseTo((2 / 3) * 100, 10);
	});
});
