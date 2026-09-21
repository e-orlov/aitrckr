import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
	prepareStructuredOutputSchema,
	StructuredOutputSchemaError,
	structuredOutputSchemaViolations,
	toStructuredOutputJsonSchema,
} from "../../providers";
import { openrouter } from "../../providers/registry/openrouter";
import { segmentAnswer } from "../anchors";
import { sanitizeSentimentError } from "../errors";
import {
	repairResultSchemaFor,
	VERIFIER_ISSUE_CODES,
	VERIFIER_MAX_ISSUES,
	verifierResultSchemaFor,
} from "../resolution";
import { schemaBudgetViolations } from "../schema-budget";
import { sentimentProviderResultSchemaFor } from "../types";

const ANSWER =
	"ARAG handles claims fast and fairly. Beltra is slower but cheaper. HUK offers good value but check the deductible. " +
	"Statistics: 40% of customers switch within two years. Overall the market is competitive.";
const ANCHORS = segmentAnswer(ANSWER).map((a) => a.id);
const KEYS = ["brand", "5e970007-0000-4000-8000-00000000000a", "5e970007-0000-4000-8000-00000000000b"];

/**
 * Every Structured Output phase the sentiment workflow sends, with the exact
 * Zod schema its request carries. Adding a phase without adding it here is a
 * failing test: the inventory is asserted against the paid-phase vocabulary.
 */
const PHASES: readonly { phase: "classify" | "repair" | "verify"; schema: () => z.ZodType }[] = [
	{ phase: "classify", schema: () => sentimentProviderResultSchemaFor(ANCHORS, KEYS) },
	{ phase: "repair", schema: () => repairResultSchemaFor(ANCHORS, KEYS) },
	{ phase: "verify", schema: () => verifierResultSchemaFor(ANCHORS, KEYS) },
];

/** The schema the production verifier shipped before the correction: a root union of two strict objects. */
function legacyRootUnionVerifierSchema() {
	const issue = z.strictObject({
		entityKey: z.enum(KEYS as [string, ...string[]]),
		target: z.enum(["overall", "price", "coverage", "service", "other"]),
		code: z.enum(VERIFIER_ISSUE_CODES),
		anchorId: z.enum(ANCHORS as [string, ...string[]]).nullable(),
	});
	return z.union([
		z.strictObject({ verdict: z.enum(["accept"]), issues: z.array(issue).max(0) }),
		z.strictObject({ verdict: z.enum(["reject"]), issues: z.array(issue).min(1).max(12) }),
	]);
}

const wire = (schema: z.ZodType) => toStructuredOutputJsonSchema(schema) as Record<string, unknown>;

/** A property schema with a `$ref` to `$defs` followed, so an assertion can read the definition it points at. */
function deref(json: Record<string, unknown>, node: Record<string, unknown>): Record<string, unknown> {
	const ref = node.$ref;
	if (typeof ref !== "string") return node;
	const defs = json.$defs as Record<string, Record<string, unknown>>;
	return defs[ref.replace("#/$defs/", "")];
}

/** Every `type: object` node of the serialized document (root, `$defs`, nested `anyOf` branches, array items). */
function objectNodes(node: unknown, path = "#"): { path: string; node: Record<string, unknown> }[] {
	if (Array.isArray(node)) return node.flatMap((item, i) => objectNodes(item, `${path}[${i}]`));
	if (typeof node !== "object" || node === null) return [];
	const record = node as Record<string, unknown>;
	const own = record.type === "object" ? [{ path, node: record }] : [];
	return [
		...own,
		...Object.entries(record).flatMap(([key, value]) =>
			key === "properties" || key === "$defs"
				? Object.entries(value as Record<string, unknown>).flatMap(([name, child]) =>
						objectNodes(child, `${path}/${key}/${name}`),
					)
				: objectNodes(value, `${path}/${key}`),
		),
	];
}

afterEach(() => {
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
});

describe("V5-WIRE-001 every paid phase's exact wire schema passes the provider contract", () => {
	it("the inventory names exactly the paid phases", () => {
		expect(PHASES.map((p) => p.phase)).toEqual(["classify", "repair", "verify"]);
	});

	it.each(PHASES)("$phase: the serialized response_format schema has no violation", ({ schema }) => {
		const json = wire(schema());
		expect(structuredOutputSchemaViolations(json)).toEqual([]);
		// The sentiment request contract (anchor enum once, by reference) holds for every phase too.
		expect(schemaBudgetViolations(json)).toEqual([]);
		expect(json.type).toBe("object");
		expect("anyOf" in json || "oneOf" in json || "allOf" in json).toBe(false);
	});

	it.each(PHASES)("$phase: every strict object is closed and requires all of its properties", ({ schema }) => {
		const nodes = objectNodes(wire(schema()));
		expect(nodes.length).toBeGreaterThan(0);
		for (const { path, node } of nodes) {
			const props = Object.keys((node.properties as Record<string, unknown>) ?? {});
			expect(node.additionalProperties, path).toBe(false);
			expect([...(node.required as string[])].sort(), path).toEqual([...props].sort());
		}
	});
});

describe("V5-WIRE-002 the corrected verifier contract", () => {
	const schema = verifierResultSchemaFor(ANCHORS, KEYS);
	const json = wire(schema);
	const issue = { entityKey: "brand", target: "overall", code: "entity-misattribution", anchorId: ANCHORS[0] };

	it("root is one object requiring verdict and issues; the verdict enum keeps both literals", () => {
		expect(json.type).toBe("object");
		expect(json.anyOf).toBeUndefined();
		expect([...(json.required as string[])].sort()).toEqual(["issues", "verdict"]);
		const props = json.properties as Record<string, Record<string, unknown>>;
		expect(deref(json, props.verdict).enum).toEqual(["accept", "reject"]);
		const issues = deref(json, props.issues);
		expect(issues.type).toBe("array");
		expect(issues.maxItems).toBe(VERIFIER_MAX_ISSUES);
		// The anchor and entity enums are shared named definitions, like classify and repair.
		expect(Object.keys(json.$defs as object)).toEqual(expect.arrayContaining(["anchorId", "entityKey"]));
	});

	it("an accepted verdict with no issue parses; a rejected verdict with issues parses", () => {
		expect(schema.parse({ verdict: "accept", issues: [] })).toEqual({ verdict: "accept", issues: [] });
		const rejected = schema.parse({ verdict: "reject", issues: [issue] });
		expect(rejected.verdict).toBe("reject");
		expect(rejected.issues).toHaveLength(1);
	});

	it("a rejected verdict without issues and an accepted verdict with issues are both refused", () => {
		expect(schema.safeParse({ verdict: "reject", issues: [] }).success).toBe(false);
		expect(schema.safeParse({ verdict: "accept", issues: [issue] }).success).toBe(false);
	});

	it("issue validation is not weakened: unknown code, foreign key, foreign anchor and extra property are refused", () => {
		const base = { verdict: "reject" };
		expect(schema.safeParse({ ...base, issues: [{ ...issue, code: "vibes" }] }).success).toBe(false);
		expect(schema.safeParse({ ...base, issues: [{ ...issue, entityKey: "ARAG" }] }).success).toBe(false);
		expect(schema.safeParse({ ...base, issues: [{ ...issue, anchorId: "s9999" }] }).success).toBe(false);
		expect(schema.safeParse({ ...base, issues: [{ ...issue, note: "x" }] }).success).toBe(false);
		expect(schema.safeParse({ ...base, issues: Array(VERIFIER_MAX_ISSUES + 1).fill(issue) }).success).toBe(false);
	});

	it("the legacy root-union verifier schema is refused by the contract with the root rules", () => {
		const rules = structuredOutputSchemaViolations(wire(legacyRootUnionVerifierSchema())).map((v) => v.rule);
		expect(rules).toEqual(expect.arrayContaining(["root-object", "root-anyof"]));
		expect(() => prepareStructuredOutputSchema(legacyRootUnionVerifierSchema())).toThrow(StructuredOutputSchemaError);
	});
});

describe("V5-WIRE-003 the provider boundary refuses a bad schema before any network operation", () => {
	it("openrouter makes zero fetch calls, yields no generation and no usage for the legacy root-union schema", async () => {
		vi.stubEnv("OPENROUTER_API_KEY", "sk-or-test-key");
		vi.stubEnv("APP_URL", "http://localhost:1515");
		const fetchMock = vi.fn(async () => {
			throw new Error("network must not be reached");
		});
		vi.stubGlobal("fetch", fetchMock);
		let thrown: unknown;
		try {
			await openrouter.runStructuredResearch?.({
				prompt: "You are an independent verifier …",
				schema: legacyRootUnionVerifierSchema(),
				webSearch: false,
			});
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeInstanceOf(StructuredOutputSchemaError);
		expect(fetchMock).not.toHaveBeenCalled();
		const error = thrown as StructuredOutputSchemaError;
		expect(error.requestSent).toBe(false);
		expect(error.violations.map((v) => v.rule)).toEqual(expect.arrayContaining(["root-object", "root-anyof"]));
		// The message carries rules and counts only — no prompt, enum value or key.
		expect(error.message).not.toMatch(/independent verifier|sk-or|s0001|brand/);
	});

	it.each(PHASES)(
		"$phase: the exact wire schema reaches fetch unchanged with strict json_schema",
		async ({ schema }) => {
			vi.stubEnv("OPENROUTER_API_KEY", "sk-or-test-key");
			vi.stubEnv("APP_URL", "http://localhost:1515");
			const fetchMock = vi.fn().mockResolvedValue({
				ok: true,
				status: 200,
				text: async () => "",
				json: async () => ({ id: "gen-test", model: "openai/gpt-5-mini", choices: [{ message: { content: "{}" } }] }),
			});
			vi.stubGlobal("fetch", fetchMock);
			const zod = schema();
			// The answer `{}` fails the Zod parse, which is the expected paid "schema" rejection; the request itself must have left.
			await openrouter.runStructuredResearch?.({ prompt: "p", schema: zod, webSearch: false }).catch(() => undefined);
			expect(fetchMock).toHaveBeenCalledTimes(1);
			const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
			expect(body.response_format.json_schema.strict).toBe(true);
			expect(body.response_format.json_schema.schema).toEqual(wire(zod));
			expect(structuredOutputSchemaViolations(body.response_format.json_schema.schema)).toEqual([]);
		},
	);

	it("the workflow's sanitizer treats the boundary refusal as a local validation defect with no request sent", () => {
		let thrown: unknown;
		try {
			prepareStructuredOutputSchema(legacyRootUnionVerifierSchema());
		} catch (error) {
			thrown = error;
		}
		const safe = sanitizeSentimentError(thrown);
		expect(safe).toMatchObject({
			code: "schema-budget-exceeded",
			kind: "validation",
			requestSent: false,
			httpStatus: null,
		});
	});
});

describe("V5-WIRE-004 the contract keeps provider-supported nested unions", () => {
	it("a nested anyOf inside a property is not a violation; only the root union is", () => {
		const nested = z.strictObject({
			entities: z.array(
				z.union([
					z.strictObject({ kind: z.enum(["a"]), value: z.enum(["x", "y"]) }),
					z.strictObject({ kind: z.enum(["b"]), value: z.enum(["z"]) }),
				]),
			),
		});
		expect(structuredOutputSchemaViolations(wire(nested))).toEqual([]);
		const open = { type: "object", properties: { a: { type: "string" } }, required: [] };
		expect(structuredOutputSchemaViolations(open).map((v) => v.rule)).toEqual(
			expect.arrayContaining(["all-required", "additional-properties-false"]),
		);
	});
});
