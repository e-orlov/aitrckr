/**
 * CP3 — the serialized provider request of classifier v4: the discriminated
 * result schema (one branch per category, dual evidence structurally required
 * for Mixed), exact per-request enums for candidate keys and anchor ids,
 * strict output, `require_parameters`, the unchanged model / search / token
 * limits, and no JSON Schema keyword outside the strict structured-output
 * subset. The only network call is a stubbed fetch.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { toStructuredOutputJsonSchema } from "../../providers/json-schema";
import { openrouter } from "../../providers/registry/openrouter";
import { segmentAnswer } from "../anchors";
import { classifySentiment, SENTIMENT_MAX_OUTPUT_TOKENS } from "../classifier";
import { dereferenceSchema } from "../schema-budget";
import {
	assertStrictStructuredOutputSubset,
	type SentimentCandidate,
	STRICT_STRUCTURED_OUTPUT_KEYWORDS,
	sentimentProviderResultSchemaFor,
} from "../types";

const answer = "Arvo ist empfehlenswert.\n\nBeltra ist günstig, aber der Service ist langsam.";
const candidates: SentimentCandidate[] = [
	{ key: "brand", entityType: "brand", competitorId: null, name: "Arvo", aliases: [] },
	{ key: "c-beltra", entityType: "competitor", competitorId: "c-beltra", name: "Beltra", aliases: [] },
];
const anchorIds = segmentAnswer(answer).map((a) => a.id);

const providerAnswer = {
	entities: [
		{
			key: "brand",
			category: "positive",
			score: 80,
			confidence: 0.9,
			evidence: [{ anchorId: "s0001", polarity: "positive" }],
			aspects: [],
		},
		{
			key: "c-beltra",
			category: "mixed",
			score: 50,
			confidence: 0.8,
			positiveEvidence: [{ anchorId: "s0002", polarity: "positive" }],
			negativeEvidence: [{ anchorId: "s0002", polarity: "negative" }],
			aspects: [
				{
					key: "price",
					category: "positive",
					score: 75,
					confidence: 0.8,
					evidence: [{ anchorId: "s0002", polarity: "positive" }],
				},
				{
					key: "service",
					category: "negative",
					score: 25,
					confidence: 0.8,
					evidence: [{ anchorId: "s0002", polarity: "negative" }],
				},
			],
		},
	],
};

function stubFetch(json: unknown) {
	const fetchMock = vi.fn(async () => new Response(JSON.stringify(json), { status: 200 }));
	vi.stubGlobal("fetch", fetchMock);
	return fetchMock;
}
function sentBody(fetchMock: ReturnType<typeof vi.fn>): Record<string, any> {
	const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
	return JSON.parse(String(init.body));
}
/** Every JSON Schema keyword used anywhere in a schema object (property names inside `properties` are data, not keywords). */
function keywordsOf(schema: unknown): Set<string> {
	const out = new Set<string>();
	const walk = (node: unknown, underProperties: boolean) => {
		if (Array.isArray(node)) {
			for (const item of node) walk(item, false);
			return;
		}
		if (typeof node !== "object" || node === null) return;
		for (const [key, value] of Object.entries(node)) {
			if (!underProperties) out.add(key);
			walk(value, key === "properties" || key === "$defs");
		}
	};
	walk(schema, false);
	return out;
}

afterEach(() => {
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
});

describe("CP3 provider request contract (classifier v4)", () => {
	it("sends the discriminated schema with exact enums, strict output and unchanged limits", async () => {
		vi.stubEnv("OPENROUTER_API_KEY", "sk-or-test");
		vi.stubEnv("APP_URL", "http://localhost:1515");
		const fetchMock = stubFetch({
			id: "gen-test",
			model: "openai/gpt-5-mini",
			choices: [{ message: { content: JSON.stringify(providerAnswer) } }],
		});
		const result = await classifySentiment({ answerBody: answer, candidates }, { resolveProvider: () => openrouter });
		expect(result.entities.map((e) => [e.key, e.category])).toEqual([
			["brand", "positive"],
			["c-beltra", "mixed"],
		]);

		const body = sentBody(fetchMock);
		expect(body.model).toBe("openai/gpt-5-mini");
		expect(body.provider).toEqual({ require_parameters: true });
		expect(body.max_tokens).toBe(SENTIMENT_MAX_OUTPUT_TOKENS);
		expect(body.max_tool_calls).toBe(1);
		expect(body.response_format.type).toBe("json_schema");
		expect(body.response_format.json_schema.strict).toBe(true);

		const rawSchema = body.response_format.json_schema.schema;
		expect(rawSchema.type).toBe("object");
		expect(rawSchema.additionalProperties).toBe(false);
		// The document carries the anchor-id and entity-key enums once, under `$defs`; the branches reference them.
		expect(rawSchema.$defs.anchorId).toEqual({ type: "string", enum: anchorIds });
		expect(rawSchema.$defs.entityKey).toEqual({ type: "string", enum: ["brand", "c-beltra"] });
		expect(JSON.stringify(rawSchema).split(JSON.stringify(anchorIds))).toHaveLength(2);
		const schema = dereferenceSchema(rawSchema) as any;
		const entityBranches = schema.properties.entities.items.anyOf;
		expect(entityBranches).toHaveLength(4);
		const categories = entityBranches.flatMap((b: any) => b.properties.category.enum).sort();
		expect(categories).toEqual(["mixed", "negative", "neutral", "positive"]);
		for (const branch of entityBranches) {
			expect(branch.additionalProperties).toBe(false);
			expect(branch.properties.key.enum).toEqual(["brand", "c-beltra"]);
			expect(branch.required).toEqual(Object.keys(branch.properties));
		}
		const mixedBranch = entityBranches.find((b: any) => b.properties.category.enum[0] === "mixed");
		expect(mixedBranch.properties.positiveEvidence.minItems).toBe(1);
		expect(mixedBranch.properties.negativeEvidence.minItems).toBe(1);
		expect(mixedBranch.properties.positiveEvidence.items.properties.anchorId.enum).toEqual(anchorIds);
		expect(mixedBranch.properties.positiveEvidence.items.properties.polarity.enum).toEqual(["positive"]);
		expect(mixedBranch.properties.negativeEvidence.items.properties.polarity.enum).toEqual(["negative"]);
		expect(mixedBranch.properties).not.toHaveProperty("evidence");
		const positiveBranch = entityBranches.find((b: any) => b.properties.category.enum[0] === "positive");
		expect(positiveBranch.properties.evidence.minItems).toBe(1);
		expect(positiveBranch.properties.evidence.maxItems).toBe(3);
		expect(positiveBranch.properties.evidence.items.properties.polarity.enum).toEqual(["positive"]);
		expect(positiveBranch.properties.score).toEqual({ type: "integer", minimum: 51, maximum: 100 });
		const aspectBranches = positiveBranch.properties.aspects.items.anyOf;
		expect(aspectBranches).toHaveLength(4);
		expect(aspectBranches[0].properties.key.enum).toEqual(["price", "coverage", "service", "other"]);

		const used = keywordsOf(rawSchema);
		for (const keyword of used) expect(STRICT_STRUCTURED_OUTPUT_KEYWORDS, keyword).toContain(keyword);
		expect(() => assertStrictStructuredOutputSubset(rawSchema)).not.toThrow();
	});

	it("the compatibility guard rejects unsupported constructs", () => {
		for (const bad of [
			'{"type":"object","if":{},"then":{}}',
			'{"type":"object","if":{},"else":{}}',
			'{"type":"array","contains":{"type":"string"}}',
			'{"allOf":[{"type":"object"}]}',
			'{"not":{"type":"string"}}',
			'{"type":"object","patternProperties":{}}',
			'{"oneOf":[{"type":"string"}]}',
		]) {
			expect(() => assertStrictStructuredOutputSubset(JSON.parse(bad)), bad).toThrow();
		}
		expect(() =>
			assertStrictStructuredOutputSubset(
				toStructuredOutputJsonSchema(sentimentProviderResultSchemaFor(anchorIds, ["brand"])),
			),
		).not.toThrow();
	});

	it("stays inside the enum-length budget at the anchor cap", () => {
		const many = Array.from({ length: 400 }, (_, i) => `s${String(i + 1).padStart(4, "0")}`);
		const keys = [
			"brand",
			...Array.from({ length: 12 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`),
		];
		const json = toStructuredOutputJsonSchema(sentimentProviderResultSchemaFor(many, keys));
		let enumChars = 0;
		JSON.stringify(json, (key, value) => {
			if (key === "enum" && Array.isArray(value)) enumChars += value.join("").length;
			return value;
		});
		expect(enumChars).toBeLessThan(120_000);
		expect(JSON.stringify(json).length).toBeLessThan(150_000);
	});
});
