import { beforeEach, describe, expect, it, vi } from "vitest";

// `createServerFn` is a Vite-transformed builder; stand it in with one that
// hands the validated payload straight to the handler so the wire contract
// (validator → auth → brand access → read) can be exercised in-process.
const captured = vi.hoisted(() => ({
	schema: undefined as undefined | { parse: (value: unknown) => unknown },
	handler: undefined as undefined | ((ctx: { data: unknown }) => Promise<unknown>),
}));
vi.mock("@tanstack/react-start", () => {
	const builder = {
		validator(schema: { parse: (value: unknown) => unknown }) {
			captured.schema = schema;
			return builder;
		},
		handler(fn: (ctx: { data: unknown }) => Promise<unknown>) {
			captured.handler = fn;
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

// The default read path goes through Drizzle and the raw pg reader; both are
// replaced so the handler can run without a database. `select().from(table)`
// dispatches on the table object so brand and prompt reads stay distinct.
const store = vi.hoisted(() => ({
	brands: [] as { id: string; name: string; website: string | null; additionalDomains: string[] | null }[],
	prompts: [] as {
		id: string;
		brandId: string;
		enabled: boolean;
		tags: string[] | null;
		systemTags: string[] | null;
	}[],
	urlStats: [] as { url: string; count: number }[],
	urlStatCalls: [] as unknown[][],
	/** Rendered `where` clauses, in call order, so the test can assert the real query shape. */
	whereClauses: [] as { table: string; sql: string; params: unknown[] }[],
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
					const rendered = dialect.sqlToQuery(condition);
					store.whereClauses.push({
						table: isBrands ? "brands" : "prompts",
						sql: rendered.sql,
						params: rendered.params,
					});
					const brandId = rendered.params[0] as string;
					const result = isBrands
						? store.brands.filter((b) => b.id === brandId).map(({ id: _id, ...rest }) => rest)
						: store.prompts
								.filter((p) => p.brandId === brandId && p.enabled === (rendered.params[1] as boolean))
								.map((p) => ({ id: p.id, tags: p.tags, systemTags: p.systemTags }));
					return Object.assign(Promise.resolve(result), { limit: async () => result.slice(0, 1) });
				},
			};
		},
	});
	return { db: { select } };
});
vi.mock("@/lib/postgres-read", () => ({
	getCitationUrlStats: async (...args: unknown[]) => {
		store.urlStatCalls.push(args);
		return store.urlStats;
	},
}));

import { citationDateWindow } from "@/lib/chart-utils";
import { getCitationStructureFn } from "@/server/citation-structure";
import { type CitationStructureReads, loadCitationStructure } from "@/server/citation-structure-load";

const BRAND = "arag";
const NOW = new Date("2026-09-06T09:00:00Z");

function fakeReads(overrides: Partial<CitationStructureReads> = {}) {
	const calls: { urlStats: unknown[][] } = { urlStats: [] };
	const reads: CitationStructureReads = {
		loadBrand: async () => ({ name: "ARAG", website: "https://arag.de/", additionalDomains: ["arag.com"] }),
		loadEnabledPrompts: async () => [
			{ id: "p-branded", tags: ["rechtsschutz"], systemTags: ["branded"] },
			{ id: "p-unbranded", tags: [], systemTags: ["unbranded"] },
		],
		loadUrlStats: async (...args) => {
			calls.urlStats.push(args);
			return [
				{ url: "https://www.arag.de/service/", count: 3 },
				{ url: "https://arag.de/service", count: 2 },
				{ url: "https://www.arag.com/", count: 1 },
				{ url: "https://notarag.de/x", count: 9 },
				{ url: "ftp://arag.de/x", count: 1 },
			];
		},
		...overrides,
	};
	return { reads, calls };
}

beforeEach(() => {
	auth.session = null;
	auth.allowed.clear();
	auth.calls.length = 0;
	store.brands = [{ id: BRAND, name: "ARAG", website: "https://arag.de/", additionalDomains: ["arag.com"] }];
	store.prompts = [
		{ id: "p1", brandId: BRAND, enabled: true, tags: ["rechtsschutz"], systemTags: ["branded"] },
		{ id: "p2", brandId: BRAND, enabled: false, tags: ["rechtsschutz"], systemTags: ["branded"] },
	];
	store.urlStats = [{ url: "https://www.arag.de/service", count: 4 }];
	store.urlStatCalls.length = 0;
	store.whereClauses.length = 0;
});

describe("getCitationStructureFn authorization", () => {
	it("rejects an unauthenticated request before reading anything", async () => {
		await expect(getCitationStructureFn({ data: { brandId: BRAND } })).rejects.toThrow(/Unauthorized/);
		expect(auth.calls).toEqual(["session"]);
		expect(store.urlStatCalls).toEqual([]);
	});

	it("rejects an authenticated user without access to the brand", async () => {
		auth.session = { user: { id: "u1" } };
		auth.allowed.add("u1:other-brand");
		await expect(getCitationStructureFn({ data: { brandId: BRAND } })).rejects.toThrow(/Forbidden/);
		expect(auth.calls).toEqual(["session", `access:u1:${BRAND}`]);
		expect(store.urlStatCalls).toEqual([]);
	});

	it("rejects a malformed payload", async () => {
		auth.session = { user: { id: "u1" } };
		auth.allowed.add(`u1:${BRAND}`);
		await expect(getCitationStructureFn({ data: { brandId: BRAND, days: 0 } })).rejects.toThrow();
		await expect(getCitationStructureFn({ data: { brandId: BRAND, days: 1.5 } })).rejects.toThrow();
		await expect(getCitationStructureFn({ data: {} as { brandId: string } })).rejects.toThrow();
	});

	it("serves the requested brand to a user with access, reading only that brand's enabled prompts", async () => {
		auth.session = { user: { id: "u1" } };
		auth.allowed.add(`u1:${BRAND}`);
		const result = (await getCitationStructureFn({ data: { brandId: BRAND, days: 7 } })) as Awaited<
			ReturnType<typeof loadCitationStructure>
		>;
		expect(result.totalOwnedOccurrences).toBe(4);
		expect(result.nodes.map((n) => n.name)).toEqual(["ARAG", "arag.de", "www.arag.de", "/service"]);
		const [brandId, , , timezone, promptIds, model] = store.urlStatCalls[0] as [
			string,
			string,
			string,
			string,
			string[],
			string,
		];
		expect(brandId).toBe(BRAND);
		expect(timezone).toBe("UTC");
		expect(promptIds).toEqual(["p1"]);
		expect(model).toBeUndefined();

		expect(store.whereClauses).toEqual([
			{ table: "brands", sql: '"brands"."id" = $1', params: [BRAND] },
			{ table: "prompts", sql: '("prompts"."brand_id" = $1 and "prompts"."enabled" = $2)', params: [BRAND, true] },
		]);
	});
});

describe("loadCitationStructure read semantics", () => {
	it("uses the Citations UTC window for the requested number of days", async () => {
		const { reads, calls } = fakeReads();
		await loadCitationStructure({ brandId: BRAND, days: 30 }, reads, NOW);
		const expected = citationDateWindow(NOW, 30);
		expect(calls.urlStats).toHaveLength(1);
		expect(calls.urlStats[0].slice(0, 4)).toEqual([BRAND, expected.fromDateStr, expected.toDateStr, "UTC"]);
		expect(expected.fromDateStr).toBe("2026-08-08");
		expect(expected.toDateStr).toBe("2026-09-06");
	});

	it("passes every enabled prompt when no tag is selected", async () => {
		const { reads, calls } = fakeReads();
		await loadCitationStructure({ brandId: BRAND, days: 7, tags: "" }, reads, NOW);
		expect(calls.urlStats[0][4]).toEqual(["p-branded", "p-unbranded"]);
	});

	it("narrows to the prompts matching the tags, including system tags", async () => {
		const { reads, calls } = fakeReads();
		await loadCitationStructure({ brandId: BRAND, days: 7, tags: "unbranded" }, reads, NOW);
		await loadCitationStructure({ brandId: BRAND, days: 7, tags: "rechtsschutz,unbranded" }, reads, NOW);
		expect(calls.urlStats[0][4]).toEqual(["p-unbranded"]);
		expect(calls.urlStats[1][4]).toEqual(["p-branded", "p-unbranded"]);
	});

	it("returns an empty result without querying when no prompt matches the tags", async () => {
		const { reads, calls } = fakeReads();
		const result = await loadCitationStructure({ brandId: BRAND, days: 7, tags: "no-such-tag" }, reads, NOW);
		expect(calls.urlStats).toEqual([]);
		expect(result).toMatchObject({ totalOwnedOccurrences: 0, nodes: [], links: [], ownedDomainCount: 2 });
		expect(result.availableTags).toEqual(["branded", "unbranded", "rechtsschutz"]);
	});

	it("passes the model filter through to the citation query", async () => {
		const { reads, calls } = fakeReads();
		await loadCitationStructure({ brandId: BRAND, days: 7, model: "chatgpt" }, reads, NOW);
		expect(calls.urlStats[0][5]).toBe("chatgpt");
	});

	it("feeds raw URLs and counts to the builder: www survives, counts add, non-owned and invalid are excluded", async () => {
		const { reads } = fakeReads();
		const result = await loadCitationStructure({ brandId: BRAND, days: 7 }, reads, NOW);
		expect(result.totalOwnedOccurrences).toBe(6);
		expect(result.eligibleRawUrlGroups).toBe(3);
		expect(result.excludedInvalidUrlOccurrences).toBe(1);
		expect(result.nodes.filter((n) => n.kind === "host").map((n) => [n.name, n.value])).toEqual([
			["www.arag.de", 3],
			["arag.de", 2],
			["www.arag.com", 1],
		]);
		expect(result.nodes.filter((n) => n.kind === "domain").map((n) => [n.name, n.value])).toEqual([
			["arag.de", 5],
			["arag.com", 1],
		]);
	});

	it("reports a brand without owned domains as configuration-empty without querying citations", async () => {
		const { reads, calls } = fakeReads({
			loadBrand: async () => ({ name: "Nameless", website: "", additionalDomains: [] }),
		});
		const result = await loadCitationStructure({ brandId: BRAND, days: 7 }, reads, NOW);
		expect(calls.urlStats).toEqual([]);
		expect(result).toMatchObject({ ownedDomainCount: 0, totalOwnedOccurrences: 0, nodes: [] });
	});

	it("exposes only aggregate structure — no titles, prompt text, responses or raw URL lists", async () => {
		const { reads } = fakeReads();
		const result = await loadCitationStructure({ brandId: BRAND, days: 7 }, reads, NOW);
		expect(Object.keys(result).sort()).toEqual([
			"availableTags",
			"eligibleRawUrlGroups",
			"excludedInvalidUrlOccurrences",
			"links",
			"nodes",
			"ownedDomainCount",
			"totalOwnedOccurrences",
		]);
		for (const node of result.nodes) {
			expect(Object.keys(node).sort()).toEqual(["depth", "fullLabel", "id", "kind", "name", "value"]);
		}
		expect(JSON.stringify(result)).not.toContain("notarag");
		expect(JSON.stringify(result)).not.toContain("ftp:");
	});
});
