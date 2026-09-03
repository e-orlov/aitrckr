import { describe, expect, it, vi } from "vitest";
import type { Provider } from "../providers/types";
import { classifySourceHostname } from "./classifier";
import {
	SOURCE_CLASSIFICATION_CATEGORIES,
	SOURCE_CLASSIFICATION_REASON_MAX_LENGTH,
	SOURCE_CLASSIFIER_VERSION,
	type SourceClassificationJobData,
	sourceClassificationResultSchema,
} from "./types";

function fakeProvider(object: unknown, modelVersion?: string): { provider: Provider; calls: () => number } {
	const run = vi.fn(async ({ schema }: { schema: { parse: (v: unknown) => unknown } }) => ({
		object: schema.parse(object),
		modelVersion,
	}));
	return {
		provider: {
			id: "fake-provider",
			name: "Fake",
			access: "api",
			isConfigured: () => true,
			run: async () => {
				throw new Error("not used");
			},
			runStructuredResearch: run as never,
		},
		calls: () => run.mock.calls.length,
	};
}

const request = (overrides: Partial<SourceClassificationJobData> = {}): SourceClassificationJobData => ({
	hostname: "unknown-source.de",
	classifierVersion: SOURCE_CLASSIFIER_VERSION,
	...overrides,
});

// F05-UT-007 — strict result schema and category whitelist.
describe("sourceClassificationResultSchema", () => {
	const valid = { category: "editorial", confidence: 0.9, reason: "independent publication" };

	it("accepts each of the nine classifiable categories and boundary confidences", () => {
		expect(SOURCE_CLASSIFICATION_CATEGORIES).toHaveLength(9);
		for (const category of SOURCE_CLASSIFICATION_CATEGORIES) {
			expect(sourceClassificationResultSchema.parse({ ...valid, category })).toMatchObject({ category });
		}
		expect(sourceClassificationResultSchema.parse({ ...valid, confidence: 0 }).confidence).toBe(0);
		expect(sourceClassificationResultSchema.parse({ ...valid, confidence: 1 }).confidence).toBe(1);
	});

	it("rejects brand, competitor, and unknown labels", () => {
		for (const category of ["brand", "competitor", "Google", "google", "news", "Editorial", ""]) {
			expect(sourceClassificationResultSchema.safeParse({ ...valid, category }).success, category).toBe(false);
		}
	});

	it("rejects NaN, infinite, and out-of-range confidence", () => {
		for (const confidence of [Number.NaN, -0.01, 1.01, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, "0.5"]) {
			expect(sourceClassificationResultSchema.safeParse({ ...valid, confidence }).success, String(confidence)).toBe(
				false,
			);
		}
	});

	// F05-UT-010 — reason bounds.
	it("rejects missing, empty, whitespace-only, and oversized reasons, and extra keys", () => {
		expect(sourceClassificationResultSchema.safeParse({ category: "other", confidence: 0.5 }).success).toBe(false);
		expect(sourceClassificationResultSchema.safeParse({ ...valid, reason: "" }).success).toBe(false);
		expect(sourceClassificationResultSchema.safeParse({ ...valid, reason: "   " }).success).toBe(false);
		expect(
			sourceClassificationResultSchema.safeParse({
				...valid,
				reason: "x".repeat(SOURCE_CLASSIFICATION_REASON_MAX_LENGTH + 1),
			}).success,
		).toBe(false);
		expect(sourceClassificationResultSchema.safeParse({ ...valid, extra: "field" }).success).toBe(false);
	});
});

describe("classifySourceHostname", () => {
	it("returns the validated result with actual provider id, model metadata, and classifier version (F05-IT-001 metadata)", async () => {
		const { provider } = fakeProvider(
			{ category: "institutional", confidence: 0.97, reason: "official federal legal portal" },
			"fake-model-v2",
		);
		const result = await classifySourceHostname(request(), { resolveProvider: () => provider });
		expect(result).toEqual({
			hostname: "unknown-source.de",
			category: "institutional",
			confidence: 0.97,
			reason: "official federal legal portal",
			provider: "fake-provider",
			model: "fake-model-v2",
			classifierVersion: SOURCE_CLASSIFIER_VERSION,
		});
	});

	// F05R — a deterministic hint never blocks the call and every LLM category is returnable.
	it("classifies a hostname carrying any deterministic hint into any of the nine categories", async () => {
		const { provider } = fakeProvider({ category: "reviews", confidence: 0.95, reason: "comparison platform" });
		const result = await classifySourceHostname(request({ deterministicHint: "other" }), {
			resolveProvider: () => provider,
		});
		expect(result.category).toBe("reviews");
	});

	it("rejects non-normalized or invalid hostnames before any provider call", async () => {
		const { provider, calls } = fakeProvider({ category: "other", confidence: 0.5, reason: "n/a" });
		for (const hostname of ["WWW.Example.de", "https://example.de/path", "localhost", ""]) {
			await expect(classifySourceHostname(request({ hostname }), { resolveProvider: () => provider })).rejects.toThrow(
				/normalized hostname/,
			);
		}
		expect(calls()).toBe(0);
	});

	// F05-FR-004 — an invalid provider answer is an error, never a coerced result.
	it("throws on an out-of-contract provider answer instead of coercing it", async () => {
		const badProvider: Provider = {
			id: "bad",
			name: "Bad",
			access: "api",
			isConfigured: () => true,
			run: async () => {
				throw new Error("not used");
			},
			// Skips schema parsing and returns garbage — the local re-validation must catch it.
			runStructuredResearch: (async () => ({
				object: { category: "ecommerce", confidence: 2, reason: "" },
				modelVersion: "bad-model",
			})) as never,
		};
		await expect(classifySourceHostname(request(), { resolveProvider: () => badProvider })).rejects.toThrow();
	});

	it("makes exactly one provider call per invocation", async () => {
		const { provider, calls } = fakeProvider({ category: "other", confidence: 0.2, reason: "unclear" });
		await classifySourceHostname(request(), { resolveProvider: () => provider });
		expect(calls()).toBe(1);
	});
});
