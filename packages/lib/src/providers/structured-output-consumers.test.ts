import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { buildOnboardingAnalysisSchema } from "../onboarding/analyze";
import { segmentAnswer } from "../sentiment/anchors";
import { repairResultSchemaFor, verifierResultSchemaFor } from "../sentiment/resolution";
import { sentimentProviderResultSchemaFor } from "../sentiment/types";
import { sourceClassificationResultSchema } from "../source-classification/types";
import { toStructuredOutputJsonSchema } from "./json-schema";
import { prepareStructuredOutputSchema, structuredOutputSchemaViolations } from "./schema-contract";

const anchors = segmentAnswer("Alpha is fast. Beta is slow. Gamma is cheap.").map((a) => a.id);
const keys = ["brand", "5e970007-0000-4000-8000-00000000000a"];

/**
 * Every structured-output request this package can send, serialized from the
 * exact Zod schema instance (or the exact production factory) the runtime
 * caller hands to `runStructuredResearch`. Nothing here is a copy. The
 * opportunities report lives in `apps/web` and is proven there from its own
 * production symbol; `structured-output-consumer-registry.test.ts` asserts
 * that every call site in the repository is covered by one of the two.
 */
const CONSUMERS: { consumer: string; source: string; schema: () => z.ZodType }[] = [
	{
		consumer: "sentiment classify",
		source: "packages/lib/src/sentiment/classifier.ts",
		schema: () => sentimentProviderResultSchemaFor(anchors, keys),
	},
	{
		consumer: "sentiment repair",
		source: "packages/lib/src/sentiment/job.ts",
		schema: () => repairResultSchemaFor(anchors, keys),
	},
	{
		consumer: "sentiment verify",
		source: "packages/lib/src/sentiment/job.ts",
		schema: () => verifierResultSchemaFor(anchors, keys),
	},
	{
		consumer: "source classification",
		source: "packages/lib/src/source-classification/classifier.ts",
		schema: () => sourceClassificationResultSchema,
	},
	{
		consumer: "onboarding analysis",
		source: "packages/lib/src/onboarding/analyze.ts",
		schema: () => buildOnboardingAnalysisSchema({ maxCompetitors: 10, maxPrompts: 30 }),
	},
];

describe("every structured-output consumer's wire schema passes the shared provider contract", () => {
	it("the package inventory names every consumer whose schema is defined in this package", () => {
		expect(CONSUMERS.map((c) => c.consumer).sort()).toEqual(
			[
				"onboarding analysis",
				"sentiment classify",
				"sentiment repair",
				"sentiment verify",
				"source classification",
			].sort(),
		);
	});

	it.each(CONSUMERS)("$consumer ($source)", ({ schema }) => {
		const json = toStructuredOutputJsonSchema(schema());
		expect(structuredOutputSchemaViolations(json)).toEqual([]);
		expect(json.type).toBe("object");
		expect(prepareStructuredOutputSchema(schema())).toEqual(json);
	});

	it("source classification keeps its string bounds on the wire and still passes", () => {
		const json = prepareStructuredOutputSchema(sourceClassificationResultSchema) as {
			properties: Record<string, Record<string, unknown>>;
		};
		expect(json.properties.reason).toMatchObject({ type: "string", minLength: 1, maxLength: 500 });
	});

	it("the verifier root is a closed object, not a union", () => {
		const json = prepareStructuredOutputSchema(verifierResultSchemaFor(anchors, keys));
		expect(json.type).toBe("object");
		expect(json.anyOf).toBeUndefined();
		expect(json.oneOf).toBeUndefined();
		expect(json.additionalProperties).toBe(false);
		expect(json.required).toEqual(expect.arrayContaining(["verdict", "issues"]));
	});

	// The onboarding limits are the only inputs that shape its document: they
	// change field descriptions, never structure, so every boundary must pass.
	it.each([
		{ label: "both disabled", maxCompetitors: 0, maxPrompts: 0 },
		{ label: "minimum", maxCompetitors: 1, maxPrompts: 1 },
		{ label: "defaults", maxCompetitors: 10, maxPrompts: 30 },
		{ label: "large", maxCompetitors: 1_000_000, maxPrompts: 1_000_000 },
	])("onboarding analysis at boundary limits: $label", ({ maxCompetitors, maxPrompts }) => {
		const json = prepareStructuredOutputSchema(buildOnboardingAnalysisSchema({ maxCompetitors, maxPrompts }));
		expect(json.type).toBe("object");
		expect(Object.keys((json as { properties: object }).properties).sort()).toEqual(
			["additionalDomains", "aliases", "brandName", "competitors", "suggestedPrompts"].sort(),
		);
	});
});

describe("the contract walker against adversarial documents", () => {
	const closed = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({
		type: "object",
		properties,
		required,
		additionalProperties: false,
	});
	const rules = (schema: unknown) => structuredOutputSchemaViolations(schema).map((v) => v.rule);

	it("accepts $defs/$ref, repeated references and bounded recursion", () => {
		const recursive = {
			...closed({ children: { type: "array", items: { $ref: "#/$defs/node" } }, name: { type: "string" } }),
			$defs: {
				node: closed({ name: { type: "string" }, children: { type: "array", items: { $ref: "#/$defs/node" } } }),
			},
		};
		expect(rules(recursive)).toEqual([]);
		const repeated = {
			...closed({ a: { $ref: "#/$defs/leaf" }, b: { $ref: "#/$defs/leaf" }, c: { $ref: "#/$defs/leaf" } }),
			$defs: { leaf: { type: "string", enum: ["x", "y"] } },
		};
		expect(rules(repeated)).toEqual([]);
		const selfRef = closed({ next: { $ref: "#" }, value: { type: "string" } });
		expect(rules(selfRef)).toEqual([]);
	});

	it("accepts nested anyOf, nullable unions, the documented string/number/array constraints and const", () => {
		const doc = closed({
			choice: { anyOf: [closed({ kind: { const: "a" } }), closed({ kind: { const: "b" }, n: { type: "integer" } })] },
			maybe: { anyOf: [{ type: "string" }, { type: "null" }] },
			text: { type: "string", minLength: 1, maxLength: 500, pattern: "^[a-z]+$", format: "email" },
			amount: { type: "number", minimum: 0, maximum: 1, exclusiveMinimum: 0, exclusiveMaximum: 2, multipleOf: 0.5 },
			list: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 3 },
			label: { type: "string", description: "d", title: "t" },
		});
		expect(rules(doc)).toEqual([]);
	});

	it("rejects a root union of any kind and a non-object root", () => {
		expect(rules({ anyOf: [closed({ a: { type: "string" } })] })).toEqual(
			expect.arrayContaining(["root-object", "root-anyof"]),
		);
		expect(rules({ oneOf: [closed({ a: { type: "string" } })] })).toEqual(expect.arrayContaining(["root-anyof"]));
		expect(rules({ type: "array", items: { type: "string" } })).toEqual(expect.arrayContaining(["root-object"]));
	});

	it("rejects an incomplete required list, extra names in required and a missing or non-false additionalProperties", () => {
		expect(rules({ ...closed({ a: { type: "string" }, b: { type: "string" } }), required: ["a"] })).toEqual([
			"all-required",
		]);
		expect(rules({ ...closed({ a: { type: "string" } }), required: ["a", "ghost"] })).toEqual(["all-required"]);
		expect(rules({ type: "object", properties: { a: { type: "string" } }, required: ["a"] })).toEqual([
			"additional-properties-false",
		]);
		expect(rules({ ...closed({ a: { type: "string" } }), additionalProperties: true })).toEqual([
			"additional-properties-false",
		]);
		// Inside a $defs entry too.
		const inner = {
			...closed({ a: { $ref: "#/$defs/x" } }),
			$defs: { x: { type: "object", properties: {}, required: [] } },
		};
		expect(rules(inner)).toEqual(["additional-properties-false"]);
	});

	it("rejects the composition keywords the provider does not support, wherever they appear", () => {
		for (const bad of [
			{ ...closed({ a: { type: "string" } }), allOf: [] },
			closed({ a: { type: "string", not: { const: "x" } } }),
			closed({
				a: JSON.parse('{"type":"object","if":{},"then":{},"properties":{},"required":[],"additionalProperties":false}'),
			}),
			closed({ a: { type: "array", items: { type: "string" }, contains: { type: "string" } } }),
			closed({
				a: { type: "object", patternProperties: {}, properties: {}, required: [], additionalProperties: false },
			}),
			closed({ a: { oneOf: [{ type: "string" }] } }),
		]) {
			expect(rules(bad), JSON.stringify(bad)).toContain("unsupported-keywords");
		}
	});

	it("enforces the documented limits: enum values, large-enum characters, properties, depth and total string length", () => {
		const enums = Array.from({ length: 1001 }, (_, i) => `v${i}`);
		expect(rules(closed({ a: { type: "string", enum: enums } }))).toContain("enum-values");
		const large = Array.from({ length: 300 }, (_, i) => `${"x".repeat(60)}${i}`);
		expect(rules(closed({ a: { type: "string", enum: large } }))).toContain("large-enum-chars");
		const many: Record<string, unknown> = {};
		for (let i = 0; i < 5001; i++) many[`p${i}`] = { type: "string" };
		expect(rules(closed(many))).toContain("object-properties");
		let deep: Record<string, unknown> = closed({ leaf: { type: "string" } });
		for (let i = 0; i < 11; i++) deep = closed({ child: deep });
		expect(rules(deep)).toContain("nesting-depth");
		const long = closed({ ["n".repeat(120_001)]: { type: "string" } });
		expect(rules(long)).toContain("total-string-length");
	});

	it("depth counting follows $ref without looping on a cycle", () => {
		const cyclic = {
			...closed({ a: { $ref: "#/$defs/a" } }),
			$defs: { a: closed({ b: { $ref: "#/$defs/b" } }), b: closed({ a: { $ref: "#/$defs/a" } }) },
		};
		expect(() => structuredOutputSchemaViolations(cyclic)).not.toThrow();
		expect(rules(cyclic)).toEqual([]);
	});
});
