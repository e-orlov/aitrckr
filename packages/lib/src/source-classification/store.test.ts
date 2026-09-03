import { beforeEach, describe, expect, it, vi } from "vitest";

// Drive the store through a mocked drizzle client (the repo's convention for
// DB-adjacent units — see secrets/store.test.ts): selects resolve to
// `dbState.rows`, upserts record their arguments.
const dbState = vi.hoisted(() => ({
	rows: [] as unknown[],
	selects: 0,
	upserts: [] as { values: Record<string, unknown>; onConflict: Record<string, unknown> }[],
}));

vi.mock("../db/db", () => ({
	db: {
		select: () => ({
			from: () => ({
				where: () => {
					dbState.selects++;
					return Promise.resolve(dbState.rows);
				},
			}),
		}),
		insert: () => ({
			values: (values: Record<string, unknown>) => ({
				onConflictDoUpdate: (onConflict: Record<string, unknown>) => {
					dbState.upserts.push({ values, onConflict });
					return Promise.resolve();
				},
			}),
		}),
	},
}));

import {
	filterHostnamesNeedingClassification,
	getCurrentSourceClassifications,
	getSupplementalDomainCategories,
	upsertSourceClassification,
} from "./store";
import { SOURCE_CLASSIFICATION_CATEGORIES, SOURCE_CLASSIFIER_VERSION, type SourceClassification } from "./types";

beforeEach(() => {
	dbState.rows = [];
	dbState.selects = 0;
	dbState.upserts = [];
});

const row = (hostname: string, category: string) => ({
	hostname,
	category,
	classifierVersion: SOURCE_CLASSIFIER_VERSION,
});

describe("getCurrentSourceClassifications", () => {
	it("returns a hostname-keyed map from one bounded query", async () => {
		dbState.rows = [row("a.de", "editorial"), row("b.de", "other")];
		const result = await getCurrentSourceClassifications(["a.de", "b.de", "a.de", "missing.de"]);
		expect(dbState.selects).toBe(1);
		expect([...result.keys()].sort()).toEqual(["a.de", "b.de"]);
	});

	it("queries nothing for an empty input", async () => {
		expect((await getCurrentSourceClassifications([])).size).toBe(0);
		expect(dbState.selects).toBe(0);
	});
});

describe("getSupplementalDomainCategories", () => {
	// F05R — every current-version row surfaces, including a definitive cached
	// "other"; only out-of-contract categories are dropped.
	it("returns each of the nine categories including cached other, dropping out-of-contract rows", async () => {
		dbState.rows = [
			...SOURCE_CLASSIFICATION_CATEGORIES.map((category) => row(`${category}.example`, category)),
			row("corrupt.example", "brand"),
		];
		const result = await getSupplementalDomainCategories(dbState.rows.map((r) => (r as { hostname: string }).hostname));
		for (const category of SOURCE_CLASSIFICATION_CATEGORIES) {
			expect(result.get(`${category}.example`)).toBe(category);
		}
		expect(result.has("corrupt.example")).toBe(false);
	});
});

describe("filterHostnamesNeedingClassification", () => {
	// F05-IT-006 — any current-version row, including "other", suppresses re-enqueue.
	it("drops hostnames with a current-version row, keeps the rest, and dedupes", async () => {
		dbState.rows = [row("cached.de", "other")];
		const result = await filterHostnamesNeedingClassification(["cached.de", "new.de", "new.de"]);
		expect(result).toEqual(["new.de"]);
	});
});

describe("upsertSourceClassification", () => {
	const classification: SourceClassification = {
		hostname: "unknown-source.de",
		category: "institutional",
		confidence: 0.925,
		reason: "official portal",
		provider: "fake-provider",
		model: "fake-model",
		classifierVersion: SOURCE_CLASSIFIER_VERSION,
	};

	// F05-DB-002 (adapter level) — one INSERT … ON CONFLICT with the full
	// replacement set, so concurrent duplicates resolve to a single row.
	it("performs a single conflict-targeted upsert with the validated values", async () => {
		await upsertSourceClassification(classification);
		expect(dbState.upserts).toHaveLength(1);
		const { values, onConflict } = dbState.upserts[0];
		expect(values).toMatchObject({
			hostname: "unknown-source.de",
			category: "institutional",
			confidence: "0.925",
			reason: "official portal",
			provider: "fake-provider",
			model: "fake-model",
			classifierVersion: SOURCE_CLASSIFIER_VERSION,
		});
		expect(onConflict).toHaveProperty("target");
		expect(onConflict).toHaveProperty("set");
		const set = (onConflict as { set: Record<string, unknown> }).set;
		expect(set).toMatchObject({ category: "institutional", classifierVersion: SOURCE_CLASSIFIER_VERSION });
	});

	// F05-FR-004 / F05-UT-007 — an invalid value can never become a cache row,
	// whatever path produced it.
	it("re-validates at the persistence boundary and writes nothing for invalid values", async () => {
		await expect(upsertSourceClassification({ ...classification, category: "brand" as never })).rejects.toThrow();
		await expect(upsertSourceClassification({ ...classification, category: "competitor" as never })).rejects.toThrow();
		await expect(upsertSourceClassification({ ...classification, confidence: 1.5 })).rejects.toThrow();
		await expect(upsertSourceClassification({ ...classification, reason: "" })).rejects.toThrow();
		expect(dbState.upserts).toHaveLength(0);
	});
});
