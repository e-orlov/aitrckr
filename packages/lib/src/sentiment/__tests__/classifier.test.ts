import { describe, expect, it, vi } from "vitest";
import type { Provider } from "../../providers/types";
import { segmentAnswer } from "../anchors";
import {
	classifySentiment,
	SentimentValidationError,
	sentimentInputHash,
	validateSentimentResult,
} from "../classifier";
import { buildSentimentPrompt, renderAnchoredAnswer } from "../prompt";
import { SENTIMENT_CLASSIFIER_VERSION, SENTIMENT_TAXONOMY_VERSION, type SentimentCandidate } from "../types";

const answer =
	"ARAG ist nicht teuer und bietet einen sehr guten Service.\n\nDie HUK-COBURG ist günstig, aber die Schadenabwicklung dauert lange.  WGV wird nur genannt.";
const candidates: SentimentCandidate[] = [
	{ key: "brand", entityType: "brand", competitorId: null, name: "ARAG", aliases: [] },
	{ key: "c-huk", entityType: "competitor", competitorId: "c-huk", name: "HUK-COBURG", aliases: ["HUK"] },
	{ key: "c-wgv", entityType: "competitor", competitorId: "c-wgv", name: "WGV", aliases: [] },
];

// s0001 = the ARAG sentence, s0002 = the HUK sentence, s0003 = the WGV sentence.
const good = {
	entities: [
		{
			key: "brand",
			score: 80,
			category: "positive",
			confidence: 0.9,
			evidence: [{ anchorId: "s0001", polarity: "positive" }],
			aspects: [
				{
					key: "price",
					score: 70,
					category: "positive",
					confidence: 0.8,
					evidence: [{ anchorId: "s0001", polarity: "positive" }],
				},
				{
					key: "service",
					score: 85,
					category: "positive",
					confidence: 0.9,
					evidence: [{ anchorId: "s0001", polarity: "positive" }],
				},
			],
		},
		{
			key: "c-huk",
			score: 50,
			category: "mixed",
			confidence: 0.7,
			evidence: [
				{ anchorId: "s0002", polarity: "positive" },
				{ anchorId: "s0002", polarity: "negative" },
			],
			aspects: [
				{
					key: "price",
					score: 75,
					category: "positive",
					confidence: 0.8,
					evidence: [{ anchorId: "s0002", polarity: "positive" }],
				},
				{
					key: "service",
					score: 25,
					category: "negative",
					confidence: 0.8,
					evidence: [{ anchorId: "s0002", polarity: "negative" }],
				},
			],
		},
		{
			key: "c-wgv",
			score: 50,
			category: "neutral",
			confidence: 0.95,
			evidence: [{ anchorId: "s0003", polarity: "neutral" }],
			aspects: [],
		},
	],
};

const validate = (raw: unknown) => validateSentimentResult(raw, { answerBody: answer, candidates });

describe("UT-SNT-006 evidence and consistency validation", () => {
	it("accepts a grounded, consistent result and resolves anchors into exact raw slices of the stored body", () => {
		const entities = validate(good);
		expect(entities.map((e) => `${e.key}:${e.category}:${e.score}`)).toEqual([
			"brand:positive:80",
			"c-huk:mixed:50",
			"c-wgv:neutral:50",
		]);
		for (const entity of entities) {
			for (const ev of [...entity.evidence, ...entity.aspects.flatMap((a) => a.evidence)]) {
				expect(answer.slice(ev.start, ev.end)).toBe(ev.quote);
				expect(ev.quote).toBe(ev.quote.trim());
			}
		}
		expect(entities[0].evidence[0]).toEqual({
			quote: "ARAG ist nicht teuer und bietet einen sehr guten Service.",
			start: 0,
			end: 57,
			polarity: "positive",
		});
		expect(entities[2].evidence[0]).toMatchObject({ quote: "WGV wird nur genannt.", start: 129, end: 150 });
		expect(entities[1].evidence.map((ev) => ev.polarity)).toEqual(["positive", "negative"]);
		expect(entities[1].aspects.map((a) => `${a.key}:${a.category}`)).toEqual(["price:positive", "service:negative"]);
	});

	it("rejects an anchor that is not part of the answer, and free-text excerpts are no longer accepted at all", () => {
		const unknown = structuredClone(good);
		unknown.entities[2].evidence = [{ anchorId: "s0004", polarity: "neutral" }];
		expect(() => validate(unknown)).toThrow(expect.objectContaining({ code: "evidence-unknown-anchor" }));
		const malformed = structuredClone(good);
		malformed.entities[2].evidence = [{ anchorId: "WGV wird nur genannt.", polarity: "neutral" }];
		expect(() => validate(malformed)).toThrow(expect.objectContaining({ code: "schema" }));
		const quoted = structuredClone(good) as unknown as { entities: { evidence: unknown[] }[] };
		quoted.entities[2].evidence = [{ quote: "WGV wird nur genannt.", polarity: "neutral" }];
		expect(() => validate(quoted)).toThrow(expect.objectContaining({ code: "schema" }));
	});

	it("the resolved evidence is decided by the code, not the model: the same anchor id always yields the same slice", () => {
		const anchors = segmentAnswer(answer);
		expect(anchors.map((a) => a.id)).toEqual(["s0001", "s0002", "s0003"]);
		const entities = validate(good);
		const huk = anchors[1];
		for (const ev of entities[1].evidence) {
			expect(ev).toMatchObject({ quote: huk.text, start: huk.start, end: huk.end });
		}
	});

	it("forbids the same (anchor, polarity) twice and two polarities on one anchor outside a Mixed verdict", () => {
		const duplicate = structuredClone(good);
		duplicate.entities[0].evidence = [
			{ anchorId: "s0001", polarity: "positive" },
			{ anchorId: "s0001", polarity: "positive" },
		];
		expect(() => validate(duplicate)).toThrow(expect.objectContaining({ code: "evidence-duplicate" }));
		const conflict = structuredClone(good);
		conflict.entities[0].evidence = [
			{ anchorId: "s0001", polarity: "positive" },
			{ anchorId: "s0001", polarity: "negative" },
		];
		expect(() => validate(conflict)).toThrow(expect.objectContaining({ code: "evidence-anchor-polarity-conflict" }));
	});

	it("requires one positive and one negative citation for Mixed; two same-polarity citations fail", () => {
		const single = structuredClone(good);
		single.entities[1].evidence = [{ anchorId: "s0002", polarity: "positive" }];
		expect(() => validate(single)).toThrow(expect.objectContaining({ code: "mixed-needs-dual-evidence" }));
		const samePolarity = structuredClone(good);
		samePolarity.entities[1].evidence = [
			{ anchorId: "s0002", polarity: "positive" },
			{ anchorId: "s0003", polarity: "positive" },
		];
		expect(() => validate(samePolarity)).toThrow(expect.objectContaining({ code: "mixed-needs-dual-evidence" }));
		const noPolarity = structuredClone(good) as unknown as { entities: { evidence: unknown[] }[] };
		noPolarity.entities[1].evidence = [{ anchorId: "s0002" }, { anchorId: "s0003" }];
		expect(() => validate(noPolarity)).toThrow(expect.objectContaining({ code: "schema" }));
	});

	it("B8: the input hash covers the normalized body and every candidate identity in stable order", () => {
		const base = sentimentInputHash(answer, candidates);
		expect(sentimentInputHash(answer, [...candidates].reverse())).toBe(base);
		expect(sentimentInputHash(`${answer}  \n`, candidates)).toBe(base);
		expect(sentimentInputHash(answer, candidates.slice(0, 2))).not.toBe(base);
		const renamed = candidates.map((c) => (c.key === "c-wgv" ? { ...c, name: "WGV Versicherung" } : c));
		expect(sentimentInputHash(answer, renamed)).not.toBe(base);
		const aliased = candidates.map((c) => (c.key === "brand" ? { ...c, aliases: ["ARAG SE"] } : c));
		expect(sentimentInputHash(answer, aliased)).not.toBe(base);
		const aliasOrder = candidates.map((c) => (c.key === "c-huk" ? { ...c, aliases: ["HUK", "huk"] } : c));
		expect(sentimentInputHash(answer, aliasOrder)).toBe(base);
	});

	it("rejects inconsistent score/category pairs on entities and aspects", () => {
		const bad = structuredClone(good);
		bad.entities[0].score = 50;
		expect(() => validate(bad)).toThrow(expect.objectContaining({ code: "score-category" }));
		const badAspect = structuredClone(good);
		badAspect.entities[0].aspects[0].category = "negative";
		expect(() => validate(badAspect)).toThrow(expect.objectContaining({ code: "score-category" }));
	});

	it("requires every candidate exactly once and nothing else", () => {
		const missing = structuredClone(good);
		missing.entities.pop();
		expect(() => validate(missing)).toThrow(expect.objectContaining({ code: "missing-entity" }));
		const extra = structuredClone(good);
		extra.entities.push({ ...good.entities[2], key: "c-unknown" });
		expect(() => validate(extra)).toThrow(expect.objectContaining({ code: "unknown-entity" }));
		const dup = structuredClone(good);
		dup.entities.push(good.entities[2]);
		expect(() => validate(dup)).toThrow(expect.objectContaining({ code: "duplicate-entity" }));
	});

	it("rejects unknown aspects, duplicate aspects, and out-of-schema fields", () => {
		const unknownAspect = structuredClone(good) as unknown as { entities: { aspects: { key: string }[] }[] };
		unknownAspect.entities[0].aspects[0].key = "reputation";
		expect(() => validate(unknownAspect)).toThrow(expect.objectContaining({ code: "schema" }));
		const dupAspect = structuredClone(good);
		dupAspect.entities[0].aspects.push(good.entities[0].aspects[0]);
		expect(() => validate(dupAspect)).toThrow(expect.objectContaining({ code: "duplicate-aspect" }));
		const extraField = structuredClone(good) as unknown as { entities: Record<string, unknown>[] };
		extraField.entities[0].netSentiment = 1;
		expect(() => validate(extraField)).toThrow(expect.objectContaining({ code: "schema" }));
	});

	it("every rejection carries a bounded diagnostic that names the place, never the text", () => {
		const unknown = structuredClone(good);
		unknown.entities[1].aspects[1].evidence = [{ anchorId: "s0009", polarity: "negative" }];
		let caught: unknown;
		try {
			validate(unknown);
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(SentimentValidationError);
		const err = caught as SentimentValidationError;
		expect(err.diagnostic).toEqual({
			stage: "evidence",
			reason: "evidence-unknown-anchor",
			entityKey: "c-huk",
			aspectKey: "service",
			evidenceIndex: 0,
			anchorId: "s0009",
			quoteLength: null,
			rawLength: null,
			normalizedLength: null,
			generationId: null,
		});
		expect(JSON.stringify(err.diagnostic)).not.toContain("Schadenabwicklung");
	});
});

describe("classifySentiment through an injected provider", () => {
	it("makes exactly one structured call with web search on, the segmented answer and an anchor-bound schema", async () => {
		const run = vi.fn(async ({ schema }: { schema: { parse: (v: unknown) => unknown } }) => ({
			object: schema.parse(good),
			modelVersion: "openai/gpt-5-mini",
			generationId: "gen-1",
		}));
		const provider = { id: "openrouter", runStructuredResearch: run } as unknown as Provider;
		const controller = new AbortController();
		const result = await classifySentiment(
			{ answerBody: answer, candidates },
			{ resolveProvider: () => provider },
			controller.signal,
		);
		expect(run).toHaveBeenCalledTimes(1);
		const call = run.mock.calls[0][0] as unknown as {
			prompt: string;
			webSearch: boolean;
			signal: AbortSignal;
			schema: { safeParse: (v: unknown) => { success: boolean } };
		};
		expect(call.webSearch).toBe(true);
		expect(call.signal).toBe(controller.signal);
		expect(call.prompt).toContain('key "c-huk": HUK-COBURG (also known as: HUK)');
		expect(call.prompt).toContain(renderAnchoredAnswer(segmentAnswer(answer)));
		expect(call.prompt).toContain("[s0003] WGV wird nur genannt.");
		expect(call.prompt).not.toContain("\nWGV wird nur genannt.\n");
		// The request schema only admits this answer's anchors.
		const foreign = structuredClone(good);
		foreign.entities[2].evidence = [{ anchorId: "s0004", polarity: "neutral" }];
		expect(call.schema.safeParse(foreign).success).toBe(false);
		expect(result.provider).toBe("openrouter");
		expect(result.model).toBe("openai/gpt-5-mini");
		expect(result.classifierVersion).toBe(SENTIMENT_CLASSIFIER_VERSION);
		expect(result.taxonomyVersion).toBe(SENTIMENT_TAXONOMY_VERSION);
		expect(result.inputHash).toMatch(/^[a-f0-9]{64}$/);
		expect(result.generationId).toBe("gen-1");
		expect(result.entities).toHaveLength(3);
	});

	it("B1: refuses an OpenRouter answer produced by a model other than the locked one", async () => {
		const provider = {
			id: "openrouter",
			runStructuredResearch: async ({ schema }: { schema: { parse: (v: unknown) => unknown } }) => ({
				object: schema.parse(good),
				modelVersion: "openai/gpt-4o-mini",
			}),
		} as unknown as Provider;
		await expect(
			classifySentiment({ answerBody: answer, candidates }, { resolveProvider: () => provider }),
		).rejects.toThrow(expect.objectContaining({ code: "model-mismatch" }));
	});

	it("never persists or coerces an invalid provider answer", async () => {
		const provider = {
			id: "openrouter",
			runStructuredResearch: async () => ({
				object: { entities: [{ ...good.entities[2], key: "c-nope" }] },
				modelVersion: null,
			}),
		} as unknown as Provider;
		await expect(
			classifySentiment({ answerBody: answer, candidates }, { resolveProvider: () => provider }),
		).rejects.toBeInstanceOf(SentimentValidationError);
	});

	it("refuses providers without structured research and empty candidate lists", async () => {
		await expect(
			classifySentiment(
				{ answerBody: answer, candidates },
				{ resolveProvider: () => ({ id: "scraper" }) as unknown as Provider },
			),
		).rejects.toThrow(/does not implement structured research/);
		await expect(classifySentiment({ answerBody: answer, candidates: [] })).rejects.toThrow(/nothing to classify/);
	});

	it("an answer without a citable segment is refused before any request leaves", async () => {
		const run = vi.fn();
		const provider = { id: "openrouter", runStructuredResearch: run } as unknown as Provider;
		await expect(
			classifySentiment({ answerBody: "   \n\n  ", candidates }, { resolveProvider: () => provider }),
		).rejects.toThrow(expect.objectContaining({ code: "answer-unsegmentable", requestSent: false }));
		expect(run).not.toHaveBeenCalled();
	});

	it("tells the model that search may only disambiguate identities and that evidence is cited by anchor id", () => {
		const prompt = buildSentimentPrompt({ answerBody: answer, candidates });
		expect(prompt).toMatch(/never to change a sentiment the ANSWER does not express/);
		expect(prompt).toContain('"price" (Price)');
		expect(prompt).toContain("Synonyms: cost");
		expect(prompt).toMatch(/anchorId/);
	});
});
