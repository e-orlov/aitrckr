import { describe, expect, it, vi } from "vitest";
import type { Provider } from "../../providers/types";
import { classifySentiment, locateEvidence, SentimentValidationError, validateSentimentResult } from "../classifier";
import { buildSentimentPrompt } from "../prompt";
import { normalizeText } from "../text";
import { SENTIMENT_CLASSIFIER_VERSION, SENTIMENT_TAXONOMY_VERSION, type SentimentCandidate } from "../types";

const answer =
	"ARAG ist nicht teuer und bietet einen sehr guten Service.\n\nDie HUK-COBURG ist günstig, aber die Schadenabwicklung dauert lange.  WGV wird nur genannt.";
const candidates: SentimentCandidate[] = [
	{ key: "brand", entityType: "brand", competitorId: null, name: "ARAG", aliases: [] },
	{ key: "c-huk", entityType: "competitor", competitorId: "c-huk", name: "HUK-COBURG", aliases: ["HUK"] },
	{ key: "c-wgv", entityType: "competitor", competitorId: "c-wgv", name: "WGV", aliases: [] },
];

const good = {
	entities: [
		{
			key: "brand",
			score: 80,
			category: "positive",
			confidence: 0.9,
			evidence: [{ quote: "ARAG ist nicht teuer und bietet einen sehr guten Service." }],
			aspects: [
				{ key: "price", score: 70, category: "positive", confidence: 0.8, evidence: [{ quote: "nicht teuer" }] },
				{
					key: "service",
					score: 85,
					category: "positive",
					confidence: 0.9,
					evidence: [{ quote: "sehr guten Service" }],
				},
			],
		},
		{
			key: "c-huk",
			score: 50,
			category: "mixed",
			confidence: 0.7,
			evidence: [{ quote: "HUK-COBURG ist günstig" }, { quote: "die Schadenabwicklung dauert lange" }],
			aspects: [
				{ key: "price", score: 75, category: "positive", confidence: 0.8, evidence: [{ quote: "ist günstig" }] },
				{
					key: "service",
					score: 25,
					category: "negative",
					confidence: 0.8,
					evidence: [{ quote: "Schadenabwicklung dauert lange" }],
				},
			],
		},
		{
			key: "c-wgv",
			score: 50,
			category: "neutral",
			confidence: 0.95,
			evidence: [{ quote: "WGV wird nur genannt." }],
			aspects: [],
		},
	],
};

describe("UT-SNT-006 evidence and consistency validation", () => {
	it("accepts a grounded, consistent result and locates evidence in the normalized body", () => {
		const entities = validateSentimentResult(good, { answerBody: answer, candidates });
		expect(entities.map((e) => `${e.key}:${e.category}:${e.score}`)).toEqual([
			"brand:positive:80",
			"c-huk:mixed:50",
			"c-wgv:neutral:50",
		]);
		const body = normalizeText(answer);
		for (const entity of entities) {
			for (const ev of entity.evidence) expect(body.slice(ev.start, ev.end)).toBe(normalizeText(ev.quote));
		}
		expect(entities[1].aspects.map((a) => `${a.key}:${a.category}`)).toEqual(["price:positive", "service:negative"]);
	});

	it("tolerates whitespace and Unicode differences in excerpts but rejects paraphrases", () => {
		expect(locateEvidence(normalizeText(answer), "HUK-COBURG   ist\ngünstig")).not.toBeNull();
		expect(locateEvidence(normalizeText(answer), "HUK-COBURG ist billig")).toBeNull();
		const bad = structuredClone(good);
		bad.entities[2].evidence = [{ quote: "WGV is only mentioned." }];
		expect(() => validateSentimentResult(bad, { answerBody: answer, candidates })).toThrow(
			expect.objectContaining({ code: "evidence-not-in-answer" }),
		);
	});

	it("requires dual evidence for Mixed", () => {
		const bad = structuredClone(good);
		bad.entities[1].evidence = [{ quote: "HUK-COBURG ist günstig" }];
		expect(() => validateSentimentResult(bad, { answerBody: answer, candidates })).toThrow(
			expect.objectContaining({ code: "mixed-needs-dual-evidence" }),
		);
	});

	it("rejects inconsistent score/category pairs on entities and aspects", () => {
		const bad = structuredClone(good);
		bad.entities[0].score = 50;
		expect(() => validateSentimentResult(bad, { answerBody: answer, candidates })).toThrow(
			expect.objectContaining({ code: "score-category" }),
		);
		const badAspect = structuredClone(good);
		badAspect.entities[0].aspects[0].category = "negative";
		expect(() => validateSentimentResult(badAspect, { answerBody: answer, candidates })).toThrow(
			expect.objectContaining({ code: "score-category" }),
		);
	});

	it("requires every candidate exactly once and nothing else", () => {
		const missing = structuredClone(good);
		missing.entities.pop();
		expect(() => validateSentimentResult(missing, { answerBody: answer, candidates })).toThrow(
			expect.objectContaining({ code: "missing-entity" }),
		);
		const extra = structuredClone(good);
		extra.entities.push({ ...good.entities[2], key: "c-unknown" });
		expect(() => validateSentimentResult(extra, { answerBody: answer, candidates })).toThrow(
			expect.objectContaining({ code: "unknown-entity" }),
		);
		const dup = structuredClone(good);
		dup.entities.push(good.entities[2]);
		expect(() => validateSentimentResult(dup, { answerBody: answer, candidates })).toThrow(
			expect.objectContaining({ code: "duplicate-entity" }),
		);
	});

	it("rejects unknown aspects, duplicate aspects, and out-of-schema fields", () => {
		const unknownAspect = structuredClone(good) as unknown as { entities: { aspects: { key: string }[] }[] };
		unknownAspect.entities[0].aspects[0].key = "reputation";
		expect(() => validateSentimentResult(unknownAspect, { answerBody: answer, candidates })).toThrow(
			expect.objectContaining({ code: "schema" }),
		);
		const dupAspect = structuredClone(good);
		dupAspect.entities[0].aspects.push(good.entities[0].aspects[0]);
		expect(() => validateSentimentResult(dupAspect, { answerBody: answer, candidates })).toThrow(
			expect.objectContaining({ code: "duplicate-aspect" }),
		);
		const extraField = structuredClone(good) as unknown as { entities: Record<string, unknown>[] };
		extraField.entities[0].netSentiment = 1;
		expect(() => validateSentimentResult(extraField, { answerBody: answer, candidates })).toThrow(
			expect.objectContaining({ code: "schema" }),
		);
	});
});

describe("classifySentiment through an injected provider", () => {
	it("makes exactly one structured call with web search on and returns versions and audit metadata", async () => {
		const run = vi.fn(async ({ schema }: { schema: { parse: (v: unknown) => unknown } }) => ({
			object: schema.parse(good),
			modelVersion: "openai/gpt-5-mini",
		}));
		const provider = { id: "openrouter", runStructuredResearch: run } as unknown as Provider;
		const result = await classifySentiment({ answerBody: answer, candidates }, { resolveProvider: () => provider });
		expect(run).toHaveBeenCalledTimes(1);
		const call = run.mock.calls[0][0] as unknown as { prompt: string; webSearch: boolean };
		expect(call.webSearch).toBe(true);
		expect(call.prompt).toContain('key "c-huk": HUK-COBURG (also known as: HUK)');
		expect(call.prompt).toContain(answer);
		expect(result.provider).toBe("openrouter");
		expect(result.model).toBe("openai/gpt-5-mini");
		expect(result.classifierVersion).toBe(SENTIMENT_CLASSIFIER_VERSION);
		expect(result.taxonomyVersion).toBe(SENTIMENT_TAXONOMY_VERSION);
		expect(result.inputHash).toMatch(/^[a-f0-9]{64}$/);
		expect(result.entities).toHaveLength(3);
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

	it("tells the model that search may only disambiguate identities", () => {
		const prompt = buildSentimentPrompt({ answerBody: answer, candidates });
		expect(prompt).toMatch(/never to change a sentiment the ANSWER does not express/);
		expect(prompt).toContain('"price" (Price)');
		expect(prompt).toContain("Synonyms: cost");
	});
});
