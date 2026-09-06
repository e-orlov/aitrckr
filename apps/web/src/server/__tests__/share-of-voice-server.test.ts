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
// resolveFilteredPrompts (enabled + tag semantics) runs against fixture prompts.
const store = vi.hoisted(() => ({
	brands: [] as { id: string; name: string }[],
	prompts: [] as {
		id: string;
		brandId: string;
		value: string;
		enabled: boolean;
		tags: string[];
		systemTags: string[];
	}[],
	daily: [] as { prompt_id: string; date: string; brand_mentions: number; competitor_mentions: number }[],
	competitorDaily: [] as { prompt_id: string; date: string; competitor: string; mentions: number }[],
	totals: { total_runs: 0, brand_mentioned_runs: 0, brand_mentioned_prompts: 0 },
	reads: [] as { fn: string; args: unknown[] }[],
}));
vi.mock("@workspace/lib/db/db", async () => {
	const schema = await import("@workspace/lib/db/schema");
	const { PgDialect } = await import("drizzle-orm/pg-core");
	const { SQL } = await import("drizzle-orm");
	const dialect = new PgDialect();
	const select = () => ({
		from(table: unknown) {
			const isBrands = table === schema.brands;
			return {
				where: (condition: unknown) => {
					if (!(condition instanceof SQL)) throw new Error("where() expects a drizzle SQL condition");
					const { params } = dialect.sqlToQuery(condition);
					const brandId = params[0] as string;
					const result = isBrands
						? store.brands.filter((b) => b.id === brandId).map((b) => ({ name: b.name }))
						: store.prompts
								.filter((p) => p.brandId === brandId && p.enabled === (params[1] as boolean))
								.map((p) => ({ id: p.id, value: p.value, tags: p.tags, systemTags: p.systemTags }));
					return Object.assign(Promise.resolve(result), { limit: async () => result.slice(0, 1) });
				},
			};
		},
	});
	return { db: { select } };
});
vi.mock("@/lib/postgres-read", () => ({
	getBrandMentionTotals: async (...args: unknown[]) => {
		store.reads.push({ fn: "totals", args });
		return store.totals;
	},
	getPerPromptDailyMentions: async (...args: unknown[]) => {
		store.reads.push({ fn: "daily", args });
		const [, , , , promptIds, model] = args as [string, string, string, string, string[], string | undefined];
		return store.daily.filter((r) => promptIds.includes(r.prompt_id) && modelMatches(r.prompt_id, model));
	},
	getPerPromptDailyCompetitorMentions: async (...args: unknown[]) => {
		store.reads.push({ fn: "competitorDaily", args });
		const [, , , , promptIds, model] = args as [string, string, string, string, string[], string | undefined];
		return store.competitorDaily.filter((r) => promptIds.includes(r.prompt_id) && modelMatches(r.prompt_id, model));
	},
}));

// Fixture convention: prompt ids ending in "-claude" only have runs on the claude model.
function modelMatches(promptId: string, model: string | undefined) {
	if (!model) return true;
	return promptId.endsWith("-claude") ? model === "claude" : model === "chatgpt";
}

import { getShareOfVoiceFn, type ShareOfVoiceResponse } from "@/server/analysis";

const BRAND = "arag";
const USER = "u1";
const NOW = new Date("2026-09-06T12:00:00Z");
// 1w in UTC from NOW: 2026-08-31 .. 2026-09-06 inclusive.
const D = ["2026-08-31", "2026-09-01", "2026-09-02", "2026-09-03", "2026-09-04", "2026-09-05", "2026-09-06"];

const NINE = ["Advocard", "Allianz", "Roland", "Deurag", "DAS", "WGV", "Huk", "Ergo", "Auxilia"];

function call(data: Record<string, unknown>) {
	return getShareOfVoiceFn({
		data: { brandId: BRAND, timezone: "UTC", lookback: "1w", ...data },
	}) as Promise<ShareOfVoiceResponse>;
}

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
	store.brands = [{ id: BRAND, name: "ARAG" }];
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
			id: "p-unbranded-claude",
			brandId: BRAND,
			value: "was kostet",
			enabled: true,
			tags: [],
			systemTags: ["unbranded"],
		},
		{
			id: "p-disabled",
			brandId: BRAND,
			value: "disabled",
			enabled: false,
			tags: ["rechtsschutz"],
			systemTags: ["branded"],
		},
		{ id: "p-other-brand", brandId: "other", value: "other", enabled: true, tags: [], systemTags: ["branded"] },
	];
	store.totals = { total_runs: 12, brand_mentioned_runs: 7, brand_mentioned_prompts: 2 };
	// p-branded: day 1 brand 2 with nine competitors; day 4 brand 1 with two (the rest reset to zero).
	// p-unbranded-claude: day 3 brand 0, Allianz 2 and Roland 1.
	// p-disabled: would dominate if it leaked in.
	store.daily = [
		{ prompt_id: "p-branded", date: D[0], brand_mentions: 2, competitor_mentions: 9 },
		{ prompt_id: "p-branded", date: D[3], brand_mentions: 1, competitor_mentions: 2 },
		{ prompt_id: "p-unbranded-claude", date: D[2], brand_mentions: 0, competitor_mentions: 3 },
		{ prompt_id: "p-disabled", date: D[5], brand_mentions: 0, competitor_mentions: 50 },
	];
	store.competitorDaily = [
		...NINE.map((competitor) => ({ prompt_id: "p-branded", date: D[0], competitor, mentions: 1 })),
		{ prompt_id: "p-branded", date: D[3], competitor: "Advocard", mentions: 1 },
		{ prompt_id: "p-branded", date: D[3], competitor: "Allianz", mentions: 1 },
		{ prompt_id: "p-unbranded-claude", date: D[2], competitor: "Allianz", mentions: 2 },
		{ prompt_id: "p-unbranded-claude", date: D[2], competitor: "Roland", mentions: 1 },
		{ prompt_id: "p-disabled", date: D[5], competitor: "Leak", mentions: 50 },
	];
});

describe("getShareOfVoiceFn authorization", () => {
	it("rejects an unauthenticated request before reading anything", async () => {
		auth.session = null;
		await expect(call({})).rejects.toThrow(/Unauthorized/);
		expect(auth.calls).toEqual(["session"]);
		expect(store.reads).toEqual([]);
	});

	it("rejects an authenticated user without access to the brand", async () => {
		auth.allowed = new Set([`${USER}:other`]);
		await expect(call({})).rejects.toThrow(/Forbidden/);
		expect(auth.calls).toEqual(["session", `access:${USER}:${BRAND}`]);
		expect(store.reads).toEqual([]);
	});

	it("serves only the requested brand's enabled prompts to an authorized user", async () => {
		const result = await call({});
		expect(result.brandName).toBe("ARAG");
		for (const read of store.reads) {
			expect(read.args[0]).toBe(BRAND);
			expect(read.args[4]).toEqual(["p-branded", "p-unbranded-claude"]);
		}
		expect(JSON.stringify(result)).not.toContain("Leak");
	});
});

describe("getShareOfVoiceFn reads and filters", () => {
	it("keeps exactly the three existing reads, in one round, with identical range, prompts and model", async () => {
		await call({ model: "chatgpt" });
		expect(store.reads.map((r) => r.fn).sort()).toEqual(["competitorDaily", "daily", "totals"]);
		const [first, ...rest] = store.reads.map((r) => r.args);
		expect(first.slice(0, 6)).toEqual([
			BRAND,
			"2026-08-31",
			"2026-09-06",
			"UTC",
			["p-branded", "p-unbranded-claude"],
			"chatgpt",
		]);
		for (const args of rest) expect(args).toEqual(first);
	});

	it("passes no model when none is selected", async () => {
		await call({});
		for (const read of store.reads) expect(read.args[5]).toBeUndefined();
	});

	it("returns the empty response without any read when no prompt matches the tags", async () => {
		const result = await call({ tags: "no-such-tag" });
		expect(store.reads).toEqual([]);
		expect(result).toEqual({
			brandName: "ARAG",
			entries: [],
			brandShare: null,
			totalRuns: 0,
			model: null,
			shareTimeSeries: [],
			comparisonTrend: { series: [], points: [] },
		});
	});

	it("narrows by user tags and by the effective system tag exactly like the existing resolution", async () => {
		await call({ tags: "unbranded" });
		expect(store.reads[0].args[4]).toEqual(["p-unbranded-claude"]);
		store.reads.length = 0;
		await call({ tags: "rechtsschutz" });
		expect(store.reads[0].args[4]).toEqual(["p-branded"]);
	});

	it("resolves the lookback window in the requested timezone, with all = one year", async () => {
		await call({ lookback: "all", timezone: "Europe/Berlin" });
		expect(store.reads[0].args.slice(1, 4)).toEqual(["2025-09-06", "2026-09-06", "Europe/Berlin"]);
	});
});

describe("getShareOfVoiceFn comparison trend", () => {
	it("uses the same dates as the brand-only series and rounds the brand line to it on every date", async () => {
		const result = await call({});
		expect(result.comparisonTrend.points.map((p) => p.date)).toEqual(result.shareTimeSeries.map((p) => p.date));
		expect(result.comparisonTrend.points.map((p) => p.date)).toEqual(D);
		const brand = result.comparisonTrend.points.map((p) =>
			p.values.brand === null ? null : Math.round(p.values.brand),
		);
		expect(brand).toEqual(result.shareTimeSeries.map((p) => p.share));
		// day 1: brand 2 / (2 + 9 + 3) = 14%; day 4 onwards: brand 1 / (1 + 2 + 3) = 17%.
		expect(result.shareTimeSeries.map((p) => p.share)).toEqual([14, 14, 14, 17, 17, 17, 17]);
	});

	it("shows the brand, the end-of-window Top 6 in rank order and Others, bounded to eight series", async () => {
		const result = await call({});
		// End of window: Allianz 3 (1 + 2), Advocard 1, Roland 1; the six other day-1 competitors are now zero.
		expect(result.comparisonTrend.series).toEqual([
			{ key: "brand", name: "ARAG", kind: "brand" },
			{ key: "competitor-1", name: "Allianz", kind: "competitor" },
			{ key: "competitor-2", name: "Advocard", kind: "competitor" },
			{ key: "competitor-3", name: "Roland", kind: "competitor" },
			{ key: "others", name: "Others", kind: "others" },
		]);
		expect(result.comparisonTrend.series.length).toBeLessThanOrEqual(8);
		// Day 1 the tail (Deurag, DAS, WGV, Huk, Ergo, Auxilia = 6) is 6/14; from day 4 it is an actual 0.
		const others = result.comparisonTrend.points.map((p) => p.values.others);
		expect(others?.[0]).toBeCloseTo((6 / 14) * 100, 9);
		expect(others?.[6]).toBe(0);
	});

	it("reconciles the last point with the leaderboard entries the same response carries", async () => {
		const result = await call({});
		const last = result.comparisonTrend.points[result.comparisonTrend.points.length - 1].values;
		const shown = result.comparisonTrend.series.filter((s) => s.kind !== "others");
		for (const s of shown) {
			const entry = result.entries.find((e) => e.name === s.name);
			expect(entry).toBeDefined();
			expect(Math.round(last[s.key] as number)).toBe(Math.round((entry?.share ?? 0) * 100));
		}
		expect(Math.round(last.brand as number)).toBe(Math.round((result.brandShare ?? 0) * 100));
		// Leaderboard order is by mentions (brand ahead on a tie); the trend still lists the brand first.
		expect(result.entries.map((e) => e.name)).toEqual(["Allianz", "ARAG", "Advocard", "Roland"]);
	});

	it("recomputes series and points together when the model filter changes the result", async () => {
		const all = await call({});
		const claude = await call({ model: "claude" });
		expect(claude.model).toBe("claude");
		expect(claude.comparisonTrend.series.map((s) => s.name)).toEqual(["ARAG", "Allianz", "Roland"]);
		expect(all.comparisonTrend.series.map((s) => s.name)).not.toEqual(claude.comparisonTrend.series.map((s) => s.name));
		for (const trend of [all.comparisonTrend, claude.comparisonTrend]) {
			const keys = trend.series.map((s) => s.key).sort();
			for (const point of trend.points) expect(Object.keys(point.values).sort()).toEqual(keys);
		}
		expect(claude.comparisonTrend.points.every((p) => p.values.brand === 0)).toBe(true);
	});

	it("exposes only bounded display data — no prompt ids, prompt text, per-prompt rows or raw competitor map", async () => {
		const result = await call({});
		expect(Object.keys(result).sort()).toEqual([
			"brandName",
			"brandShare",
			"comparisonTrend",
			"entries",
			"model",
			"shareTimeSeries",
			"totalRuns",
		]);
		expect(Object.keys(result.comparisonTrend).sort()).toEqual(["points", "series"]);
		for (const s of result.comparisonTrend.series) expect(Object.keys(s).sort()).toEqual(["key", "kind", "name"]);
		for (const p of result.comparisonTrend.points) expect(Object.keys(p).sort()).toEqual(["date", "values"]);
		const json = JSON.stringify(result);
		expect(json).not.toMatch(/p-branded|p-unbranded|beste rechtsschutz|was kostet|prompt_id|promptId/);
		expect(json).not.toContain("Deurag");
		expect(result.comparisonTrend.points).toHaveLength(D.length);
	});
});
