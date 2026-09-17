/**
 * V4-RED-009 / D2 — the JSON Schema exactly as the OpenRouter request carries
 * it must stay inside the provider's documented strict structured-output
 * limits at every size the pipeline can produce: 1 anchor, the largest
 * production answer, the sizes just around the 1000-enum-value limit, the
 * 400-anchor hard cap and the largest candidate roster. Both the raw
 * (serialized) and the conservative fully-dereferenced enum budgets are
 * recorded; a raw PASS alone does not prove provider acceptance.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_COMPETITORS } from "../../constants";
import { toStructuredOutputJsonSchema } from "../../providers/json-schema";
import { openrouter } from "../../providers/registry/openrouter";
import { ANCHOR_MAX_COUNT, segmentAnswer } from "../anchors";
import { classifySentiment } from "../classifier";
import {
	assertProviderSchemaBudget,
	measureSchemaBudget,
	PROVIDER_SCHEMA_LIMITS,
	schemaBudgetViolations,
} from "../schema-budget";
import { type SentimentCandidate, sentimentProviderResultSchemaFor } from "../types";

const anchorIds = (n: number) => Array.from({ length: n }, (_, i) => `s${String(i + 1).padStart(4, "0")}`);
const keys = (competitors: number) => [
	"brand",
	...Array.from({ length: competitors }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`),
];
/** The largest answer in the production corpus at the time of the corrective round. */
const PRODUCTION_MAX_ANCHORS = 38;
const sent = (anchors: number, competitors: number) =>
	toStructuredOutputJsonSchema(sentimentProviderResultSchemaFor(anchorIds(anchors), keys(competitors)));

afterEach(() => {
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
});

describe("provider schema budget (D2)", () => {
	it.each([
		[1, 2],
		[35, 2],
		[36, 2],
		[38, 2],
		[PRODUCTION_MAX_ANCHORS, 12],
		[ANCHOR_MAX_COUNT, 2],
		[ANCHOR_MAX_COUNT, 12],
	])("%i anchors / %i competitors: the sent schema stays inside every documented limit", (anchors, competitors) => {
		const schema = sent(anchors, competitors);
		expect(schemaBudgetViolations(schema)).toEqual([]);
		const budget = assertProviderSchemaBudget(schema);
		expect(budget.rawEnumValues).toBeLessThanOrEqual(PROVIDER_SCHEMA_LIMITS.enumValues);
		expect(budget.anchorEnumOccurrences).toBe(1);
		expect(budget.anchorSitesWithoutRef).toBe(0);
		expect(budget.anchorSitesWithRef).toBeGreaterThan(0);
		expect(budget.rootIsObject).toBe(true);
		expect(budget.rootHasAnyOf).toBe(false);
	});

	it("records the raw and the conservative dereferenced budgets at the hard cap", () => {
		const budget = measureSchemaBudget(sent(ANCHOR_MAX_COUNT, 12));
		expect(budget.rawEnumValues).toBeLessThanOrEqual(PROVIDER_SCHEMA_LIMITS.enumValues);
		// Fully dereferenced, the anchor enum is seen once per evidence site; documented as a risk, not a pass.
		expect(budget.dereferencedEnumValues).toBeGreaterThan(budget.rawEnumValues);
		expect(budget.nestingDepth).toBeLessThanOrEqual(PROVIDER_SCHEMA_LIMITS.nestingDepth);
	});

	it("the largest roster that fits at the hard cap, and the configured competitor maximum that does not", () => {
		// 400 anchors + brand + N competitor uuids: the >250-value enum may sum to at most 15,000 characters.
		const fits = keys(416);
		expect(
			schemaBudgetViolations(
				toStructuredOutputJsonSchema(sentimentProviderResultSchemaFor(anchorIds(ANCHOR_MAX_COUNT), fits)),
			),
		).toEqual([]);
		const tooMany = keys(MAX_COMPETITORS);
		const violations = schemaBudgetViolations(
			toStructuredOutputJsonSchema(sentimentProviderResultSchemaFor(anchorIds(ANCHOR_MAX_COUNT), tooMany)),
		);
		expect(violations.map((v) => v.rule)).toContain("large-enum-chars");
	});

	it("the verifier itself rejects the contract violations it exists for", () => {
		const bad = {
			type: "object",
			properties: {
				a: { type: "string", enum: anchorIds(600) },
				b: {
					type: "object",
					properties: { anchorId: { type: "string", enum: anchorIds(600) } },
					required: ["anchorId"],
					additionalProperties: false,
				},
			},
			required: ["a"],
			additionalProperties: false,
			allOf: [],
		};
		const rules = schemaBudgetViolations(bad).map((v) => v.rule);
		expect(rules).toEqual(
			expect.arrayContaining([
				"enum-values",
				"all-required",
				"unsupported-keywords",
				"anchor-enum-once",
				"anchor-sites-by-ref",
			]),
		);
		expect(() => assertProviderSchemaBudget(bad)).toThrow(/provider schema budget exceeded/);
		expect(schemaBudgetViolations({ anyOf: [{ type: "object" }] }).map((v) => v.rule)).toEqual(
			expect.arrayContaining(["root-object", "root-anyof"]),
		);
	});

	it("the schema inside a real 400-anchor request body passes the verifier", async () => {
		vi.stubEnv("OPENROUTER_API_KEY", "sk-or-test");
		vi.stubEnv("APP_URL", "http://localhost:1515");
		const sentences = Array.from({ length: ANCHOR_MAX_COUNT }, (_, i) => `Arvo bietet Leistung Nummer ${i + 1} an.`);
		const answer = sentences.join(" ");
		expect(segmentAnswer(answer)).toHaveLength(ANCHOR_MAX_COUNT);
		const candidates: SentimentCandidate[] = [
			{ key: "brand", entityType: "brand", competitorId: null, name: "Arvo", aliases: [] },
		];
		const providerAnswer = {
			entities: [
				{
					key: "brand",
					category: "positive",
					score: 70,
					confidence: 0.9,
					evidence: [{ anchorId: "s0001", polarity: "positive" }],
					aspects: [],
				},
			],
		};
		const fetchMock = vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						id: "gen-budget",
						model: "openai/gpt-5-mini",
						choices: [{ message: { content: JSON.stringify(providerAnswer) } }],
					}),
					{
						status: 200,
					},
				),
		);
		vi.stubGlobal("fetch", fetchMock);
		await classifySentiment({ answerBody: answer, candidates }, { resolveProvider: () => openrouter });
		const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		const body = JSON.parse(String(init.body));
		expect(body.response_format.json_schema.strict).toBe(true);
		expect(body.provider).toEqual({ require_parameters: true });
		const schema = body.response_format.json_schema.schema;
		expect(schemaBudgetViolations(schema)).toEqual([]);
		expect(measureSchemaBudget(schema).anchorEnumOccurrences).toBe(1);
	});
});
