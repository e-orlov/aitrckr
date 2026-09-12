import { describe, expect, it, vi } from "vitest";
import type { Provider } from "../../providers/types";
import {
	classifySentiment,
	locateEvidence,
	SentimentValidationError,
	sentimentInputHash,
	validateSentimentResult,
} from "../classifier";
import { buildSentimentPrompt } from "../prompt";
import { normalizeIndexed, normalizeText } from "../text";
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
			evidence: [{ quote: "ARAG ist nicht teuer und bietet einen sehr guten Service.", polarity: "positive" }],
			aspects: [
				{
					key: "price",
					score: 70,
					category: "positive",
					confidence: 0.8,
					evidence: [{ quote: "nicht teuer", polarity: "positive" }],
				},
				{
					key: "service",
					score: 85,
					category: "positive",
					confidence: 0.9,
					evidence: [{ quote: "sehr guten Service", polarity: "positive" }],
				},
			],
		},
		{
			key: "c-huk",
			score: 50,
			category: "mixed",
			confidence: 0.7,
			evidence: [
				{ quote: "HUK-COBURG ist günstig", polarity: "positive" },
				{ quote: "die Schadenabwicklung dauert lange", polarity: "negative" },
			],
			aspects: [
				{
					key: "price",
					score: 75,
					category: "positive",
					confidence: 0.8,
					evidence: [{ quote: "ist günstig", polarity: "positive" }],
				},
				{
					key: "service",
					score: 25,
					category: "negative",
					confidence: 0.8,
					evidence: [{ quote: "Schadenabwicklung dauert lange", polarity: "negative" }],
				},
			],
		},
		{
			key: "c-wgv",
			score: 50,
			category: "neutral",
			confidence: 0.95,
			evidence: [{ quote: "WGV wird nur genannt.", polarity: "neutral" }],
			aspects: [],
		},
	],
};

describe("UT-SNT-006 evidence and consistency validation", () => {
	it("accepts a grounded, consistent result and resolves evidence offsets into the raw stored body", () => {
		const entities = validateSentimentResult(good, { answerBody: answer, candidates });
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
		expect(entities[1].evidence.map((ev) => ev.polarity)).toEqual(["positive", "negative"]);
		expect(entities[1].aspects.map((a) => `${a.key}:${a.category}`)).toEqual(["price:positive", "service:negative"]);
	});

	it("tolerates whitespace and Unicode differences in excerpts but rejects paraphrases", () => {
		const indexed = normalizeIndexed(answer);
		const hit = locateEvidence(indexed, answer, "HUK-COBURG   ist\ngünstig", "positive");
		expect(hit).not.toBeNull();
		expect(answer.slice(hit?.start, hit?.end)).toBe("HUK-COBURG ist günstig");
		expect(locateEvidence(indexed, answer, "HUK-COBURG ist billig", "positive")).toBeNull();
		const bad = structuredClone(good);
		bad.entities[2].evidence = [{ quote: "WGV is only mentioned.", polarity: "neutral" }];
		expect(() => validateSentimentResult(bad, { answerBody: answer, candidates })).toThrow(
			expect.objectContaining({ code: "evidence-not-in-answer" }),
		);
	});

	it("B7: offsets survive NFKC ligatures, fullwidth letters and collapsed whitespace in the stored body", () => {
		const raw = "Die  Schadenregulierung\u00a0ist   e\uFB03zient;\n\n\uFF21RAG   bleibt  fair.";
		const indexed = normalizeIndexed(raw);
		const hit = locateEvidence(indexed, raw, "schadenregulierung ist effizient; arag bleibt fair", "positive");
		expect(hit).not.toBeNull();
		if (!hit) return;
		expect(raw.slice(hit.start, hit.end)).toBe(
			"Schadenregulierung\u00a0ist   e\uFB03zient;\n\n\uFF21RAG   bleibt  fair",
		);
		expect(hit.quote).toBe(raw.slice(hit.start, hit.end));
		expect(normalizeText(hit.quote)).toBe("schadenregulierung ist effizient; arag bleibt fair");
	});

	it("requires one positive and one negative excerpt for Mixed; two same-polarity excerpts fail", () => {
		const single = structuredClone(good);
		single.entities[1].evidence = [{ quote: "HUK-COBURG ist günstig", polarity: "positive" }];
		expect(() => validateSentimentResult(single, { answerBody: answer, candidates })).toThrow(
			expect.objectContaining({ code: "mixed-needs-dual-evidence" }),
		);
		const samePolarity = structuredClone(good);
		samePolarity.entities[1].evidence = [
			{ quote: "HUK-COBURG ist günstig", polarity: "positive" },
			{ quote: "die Schadenabwicklung dauert lange", polarity: "positive" },
		];
		expect(() => validateSentimentResult(samePolarity, { answerBody: answer, candidates })).toThrow(
			expect.objectContaining({ code: "mixed-needs-dual-evidence" }),
		);
		const noPolarity = structuredClone(good) as unknown as { entities: { evidence: unknown[] }[] };
		noPolarity.entities[1].evidence = [
			{ quote: "HUK-COBURG ist günstig" },
			{ quote: "die Schadenabwicklung dauert lange" },
		];
		expect(() => validateSentimentResult(noPolarity, { answerBody: answer, candidates })).toThrow(
			expect.objectContaining({ code: "schema" }),
		);
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

	it("tells the model that search may only disambiguate identities", () => {
		const prompt = buildSentimentPrompt({ answerBody: answer, candidates });
		expect(prompt).toMatch(/never to change a sentiment the ANSWER does not express/);
		expect(prompt).toContain('"price" (Price)');
		expect(prompt).toContain("Synonyms: cost");
	});
});
