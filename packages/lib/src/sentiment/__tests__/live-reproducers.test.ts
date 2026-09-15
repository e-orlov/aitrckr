/**
 * UT-SNT-CIT-003 — synthetic reproducers of the three terminal failures seen on
 * the first live day (2026-09-14/15), built from their sanitized diagnostics only
 * (stage, entity key, target, evidence index, anchor id). Written RED against
 * the v2 contract: the request schema carried no exact-key enum, identical
 * evidence claims were rejected instead of de-duplicated.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { segmentAnswer } from "../anchors";
import { classifySentiment, validateSentimentResult } from "../classifier";
import { type SentimentCandidate, sentimentClassificationResultSchemaFor } from "../types";

/** Live shape 1 and 2: one candidate, the own brand with the generic opaque key `brand` and display name ARAG. */
const brandOnly: SentimentCandidate[] = [
	{ key: "brand", entityType: "brand", competitorId: null, name: "ARAG", aliases: [] },
];
const brandAnswer = "ARAG bietet einen Mietrechtsschutz ohne Wartezeit an. Die Prämie ist vergleichsweise günstig.";

/** Live shape 3: three candidates; the conflict arose in the competitor's overall evidence list. */
const three: SentimentCandidate[] = [
	{ key: "brand", entityType: "brand", competitorId: null, name: "ARAG", aliases: [] },
	{
		key: "b64b96f5-3bbd-4e42-a5ea-f30821cb9f8c",
		entityType: "competitor",
		competitorId: "b64b96f5-3bbd-4e42-a5ea-f30821cb9f8c",
		name: "WGV",
		aliases: [],
	},
	{
		key: "c8c99a71-eaa9-46a5-9e48-ede16f090241",
		entityType: "competitor",
		competitorId: "c8c99a71-eaa9-46a5-9e48-ede16f090241",
		name: "HUK-COBURG",
		aliases: ["HUK"],
	},
];
const HUK = "c8c99a71-eaa9-46a5-9e48-ede16f090241";
const WGV = "b64b96f5-3bbd-4e42-a5ea-f30821cb9f8c";
const threeAnswer =
	"ARAG ist solide. WGV ist günstig. Die HUK-COBURG ist preiswert, aber der Service ist langsam. Die HUK deckt vieles ab.";

const entity = (key: string, patch: Record<string, unknown> = {}) => ({
	key,
	score: 50,
	category: "neutral",
	confidence: 0.9,
	evidence: [{ anchorId: "s0001", polarity: "neutral" }],
	aspects: [],
	...patch,
});

afterEach(() => {
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
});

describe("UT-SNT-CIT-003 live failure 1/2 — unknown-entity: the display name instead of the opaque key", () => {
	it("reproduces the live rejection: key ARAG for candidate brand is unknown-entity, never repaired", () => {
		const result = {
			entities: [
				entity("ARAG", { score: 70, category: "positive", evidence: [{ anchorId: "s0001", polarity: "positive" }] }),
			],
		};
		expect(() => validateSentimentResult(result, { answerBody: brandAnswer, candidates: brandOnly })).toThrow(
			expect.objectContaining({
				code: "unknown-entity",
				diagnostic: expect.objectContaining({ stage: "entity", entityKey: "ARAG", reason: "unknown-entity" }),
			}),
		);
	});

	it("the request schema binds the entity key to the exact candidate keys (strict enum), not to any string", () => {
		const ids = segmentAnswer(brandAnswer).map((a) => a.id);
		type Shape = { properties: { entities: { items: { properties: { key: Record<string, unknown> } } } } };
		const json = z.toJSONSchema(sentimentClassificationResultSchemaFor(ids, ["brand"])) as unknown as Shape;
		expect(json.properties.entities.items.properties.key).toEqual({ type: "string", enum: ["brand"] });
		const multi = z.toJSONSchema(
			sentimentClassificationResultSchemaFor(
				ids,
				three.map((c) => c.key),
			),
		) as unknown as Shape;
		expect(multi.properties.entities.items.properties.key.enum).toEqual(three.map((c) => c.key));
	});

	it("the serialized OpenRouter request carries strict json_schema, the exact-key enum and require_parameters", async () => {
		vi.stubEnv("OPENROUTER_API_KEY", "sk-or-test");
		vi.stubEnv("APP_URL", "http://localhost:1515");
		const fetchMock = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			text: async () => "",
			json: async () => ({
				id: "gen-test",
				model: "openai/gpt-5-mini-2025-08-07",
				choices: [
					{
						message: {
							content: JSON.stringify({
								entities: [
									entity("brand", {
										score: 70,
										category: "positive",
										evidence: [{ anchorId: "s0001", polarity: "positive" }],
									}),
								],
							}),
						},
					},
				],
				usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.001, server_tool_use: { web_search_requests: 1 } },
			}),
		});
		vi.stubGlobal("fetch", fetchMock);

		const result = await classifySentiment({ answerBody: brandAnswer, candidates: brandOnly });

		const body = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string) as {
			response_format: {
				type: string;
				json_schema: {
					strict: boolean;
					schema: { properties: { entities: { items: { properties: { key: { enum?: string[] } } } } } };
				};
			};
			provider?: { require_parameters?: boolean };
		};
		expect(body.response_format.type).toBe("json_schema");
		expect(body.response_format.json_schema.strict).toBe(true);
		expect(body.response_format.json_schema.schema.properties.entities.items.properties.key.enum).toEqual(["brand"]);
		expect(body.provider).toEqual({ require_parameters: true });
		expect(result.request).toMatchObject({ strictJsonSchema: true, requireParameters: true });
	});

	it("a key that is not a candidate is still refused locally even if it reached the validator", () => {
		const lookalike = { entities: [entity("Brand")] };
		expect(() => validateSentimentResult(lookalike, { answerBody: brandAnswer, candidates: brandOnly })).toThrow(
			expect.objectContaining({ code: "unknown-entity" }),
		);
	});
});

describe("UT-SNT-CIT-003 live failure 3 — evidence-anchor-polarity-conflict is target-scoped", () => {
	const validate = (raw: unknown) => validateSentimentResult(raw, { answerBody: threeAnswer, candidates: three });
	const base = () => [
		entity("brand"),
		entity(WGV, { evidence: [{ anchorId: "s0002", polarity: "neutral" }] }),
		entity(HUK, { evidence: [{ anchorId: "s0003", polarity: "neutral" }] }),
	];

	it("reproduces the live rejection: one anchor cited twice with two labels inside the overall list of a non-Mixed entity", () => {
		const entities = base();
		entities[2] = entity(HUK, {
			score: 60,
			category: "positive",
			evidence: [
				{ anchorId: "s0004", polarity: "positive" },
				{ anchorId: "s0004", polarity: "negative" },
			],
		});
		expect(() => validate({ entities })).toThrow(
			expect.objectContaining({
				code: "evidence-anchor-polarity-conflict",
				diagnostic: expect.objectContaining({
					stage: "evidence",
					entityKey: HUK,
					aspectKey: null,
					evidenceIndex: 1,
					anchorId: "s0004",
				}),
			}),
		);
	});

	it("one anchor may carry different polarities for different aspects of the same entity", () => {
		const entities = base();
		entities[2] = entity(HUK, {
			score: 50,
			category: "mixed",
			evidence: [
				{ anchorId: "s0003", polarity: "positive" },
				{ anchorId: "s0003", polarity: "negative" },
			],
			aspects: [
				{
					key: "price",
					score: 75,
					category: "positive",
					confidence: 0.8,
					evidence: [{ anchorId: "s0003", polarity: "positive" }],
				},
				{
					key: "service",
					score: 25,
					category: "negative",
					confidence: 0.8,
					evidence: [{ anchorId: "s0003", polarity: "negative" }],
				},
			],
		});
		const validated = validate({ entities });
		expect(validated[2].aspects.map((a) => `${a.key}:${a.evidence[0].polarity}`)).toEqual([
			"price:positive",
			"service:negative",
		]);
	});

	it("a Mixed target with one positive and one negative citation on the same anchor passes", () => {
		const entities = base();
		entities[2] = entity(HUK, {
			category: "mixed",
			evidence: [
				{ anchorId: "s0003", polarity: "positive" },
				{ anchorId: "s0003", polarity: "negative" },
			],
		});
		expect(validate({ entities })[2].evidence.map((e) => e.polarity)).toEqual(["positive", "negative"]);
	});

	it("a differing pair on one anchor within one non-Mixed aspect is still rejected, naming the aspect", () => {
		const entities = base();
		entities[2] = entity(HUK, {
			aspects: [
				{
					key: "price",
					score: 75,
					category: "positive",
					confidence: 0.8,
					evidence: [
						{ anchorId: "s0003", polarity: "positive" },
						{ anchorId: "s0003", polarity: "neutral" },
					],
				},
			],
		});
		expect(() => validate({ entities })).toThrow(
			expect.objectContaining({
				code: "evidence-anchor-polarity-conflict",
				diagnostic: expect.objectContaining({
					stage: "evidence",
					entityKey: HUK,
					aspectKey: "price",
					anchorId: "s0003",
				}),
			}),
		);
	});

	it("identical claims within one target are de-duplicated deterministically instead of rejected", () => {
		const entities = base();
		entities[2] = entity(HUK, {
			score: 60,
			category: "positive",
			evidence: [
				{ anchorId: "s0003", polarity: "positive" },
				{ anchorId: "s0003", polarity: "positive" },
			],
		});
		const validated = validate({ entities });
		expect(validated[2].evidence).toEqual([
			expect.objectContaining({ polarity: "positive", start: expect.any(Number) }),
		]);
		expect(validated[2].evidence).toHaveLength(1);
	});

	it("never repairs evidence: a polarity is stored exactly as labelled, an unknown anchor is refused", () => {
		const entities = base();
		entities[1] = entity(WGV, { evidence: [{ anchorId: "s0099", polarity: "neutral" }] });
		expect(() => validate({ entities })).toThrow(expect.objectContaining({ code: "evidence-unknown-anchor" }));
		const labelled = validate({ entities: base() });
		expect(labelled.map((e) => e.evidence[0].polarity)).toEqual(["neutral", "neutral", "neutral"]);
	});
});
