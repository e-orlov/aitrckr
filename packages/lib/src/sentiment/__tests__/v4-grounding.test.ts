import { describe, expect, it } from "vitest";
import { segmentAnswer } from "../anchors";
import { validateClassification, validateSentimentResult, validateSentimentResultDetailed } from "../classifier";
import { SENTIMENT_ASPECT_ROUTING_RULES } from "../prompt";
import { type SentimentCandidate, sentimentProviderResultSchemaFor } from "../types";

/**
 * V4-RED-001 … V4-RED-006 — production-shaped reproducers of the classifier
 * v3 failure families, on sanitised synthetic text (fictional insurers Arvo
 * and Beltra). Every case below was accepted or mis-handled by v3; v4 must
 * refuse it fail-closed or encode the intended behaviour.
 */
const ARVO: SentimentCandidate = { key: "brand", entityType: "brand", competitorId: null, name: "Arvo", aliases: [] };
const BELTRA: SentimentCandidate = {
	key: "c-beltra",
	entityType: "competitor",
	competitorId: "c-beltra",
	name: "Beltra",
	aliases: [],
};
const candidates = [ARVO, BELTRA];

const ids = (answer: string) => segmentAnswer(answer).map((a) => a.id);

/** A provider-shaped positive target citing the given anchors. */
const positive = (anchorIds: string[], score = 80) => ({
	category: "positive" as const,
	score,
	confidence: 0.9,
	evidence: anchorIds.map((anchorId) => ({ anchorId, polarity: "positive" as const })),
});
const neutral = (anchorIds: string[]) => ({
	category: "neutral" as const,
	score: 50,
	confidence: 0.9,
	evidence: anchorIds.map((anchorId) => ({ anchorId, polarity: "neutral" as const })),
});
const mixed = (positiveIds: string[], negativeIds: string[]) => ({
	category: "mixed" as const,
	score: 50,
	confidence: 0.9,
	positiveEvidence: positiveIds.map((anchorId) => ({ anchorId, polarity: "positive" as const })),
	negativeEvidence: negativeIds.map((anchorId) => ({ anchorId, polarity: "negative" as const })),
});

describe("V4-RED-001 entity swap", () => {
	// s0001 Beltra sentence · s0002–s0004 header cells · s0005–s0007 Beltra row cells · s0008–s0010 Arvo row cells
	const answer =
		"Für Deutschland ist derzeit die Beltra Optimal der stärkste Kandidat beim Preis-Leistungs-Verhältnis.\n\n| Tarif | Geeignet für | Besonderheit |\n|---|---|---|\n| Beltra Optimal | Preisbewusste Singles | Bestes Preis-Leistungs-Verhältnis |\n| Arvo Komfort | Wer umfangreiche Leistungen möchte | Etwas teurer, dafür starke Zusatzleistungen |";

	it("segments the reproducer as documented", () => {
		expect(ids(answer)).toEqual(["s0001", "s0002", "s0003", "s0004", "s0005", "s0006", "s0007", "s0008", "s0009", "s0010"]);
	});

	it("refuses an Arvo observation whose every anchor names only Beltra, and vice versa", () => {
		const swapped = {
			entities: [
				{ key: "brand", ...positive(["s0001", "s0005"]), aspects: [] },
				{ key: "c-beltra", ...mixed(["s0010"], ["s0010"]), aspects: [] },
			],
		};
		expect(() => validateSentimentResult(swapped, { answerBody: answer, candidates })).toThrow(
			expect.objectContaining({ code: "evidence-entity-unbound" }),
		);
	});

	it("accepts the correctly grounded labelling of the same answer", () => {
		const grounded = {
			entities: [
				{ key: "brand", ...mixed(["s0010"], ["s0010"]), aspects: [] },
				{ key: "c-beltra", ...positive(["s0001", "s0007"]), aspects: [] },
			],
		};
		const entities = validateSentimentResult(grounded, { answerBody: answer, candidates });
		expect(entities.map((e) => [e.key, e.category])).toEqual([
			["brand", "mixed"],
			["c-beltra", "positive"],
		]);
	});
});

describe("V4-RED-002 foreign-only evidence", () => {
	const answer = "Arvo bietet einen guten Service.\n\nBeltra ist günstig.";
	it("refuses an anchor that explicitly names another candidate but not the claimed one", () => {
		const foreign = {
			entities: [
				{ key: "brand", ...positive(["s0002"]), aspects: [] },
				{ key: "c-beltra", ...positive(["s0002"]), aspects: [] },
			],
		};
		expect(() => validateSentimentResult(foreign, { answerBody: answer, candidates })).toThrow(
			expect.objectContaining({
				code: "evidence-entity-unbound",
				diagnostic: expect.objectContaining({ anchorId: "s0002" }),
			}),
		);
	});
});

describe("V4-RED-003 entity-unbound aspect", () => {
	// s0001 Arvo sentence · s0002 list intro without an entity · s0003/s0004 generic checklist bullets
	const answer = "Arvo kann gut sein.\n\nAchte vor Abschluss besonders auf:\n- Beitragserhöhungen\n- Selbstbeteiligung";
	it("refuses a price aspect that cites only generic checklist text", () => {
		const result = {
			entities: [
				{
					key: "brand",
					...positive(["s0001"]),
					aspects: [
						{
							key: "price",
							category: "negative",
							score: 25,
							confidence: 0.8,
							evidence: [
								{ anchorId: "s0003", polarity: "negative" },
								{ anchorId: "s0004", polarity: "negative" },
							],
						},
					],
				},
			],
		};
		// Classifier v5: the claim is dropped, not the analysis; nothing takes the aspect's place.
		const { entities, filteredClaims } = validateSentimentResultDetailed(result, {
			answerBody: answer,
			candidates: [ARVO],
		});
		expect(entities[0].aspects).toEqual([]);
		expect(filteredClaims).toEqual([
			{ entityKey: "brand", aspectKey: "price", code: "aspect-ungrounded", anchorIds: ["s0003", "s0004"] },
		]);
	});

	it("still accepts a generic anchor beside one anchor that names the entity", () => {
		const result = {
			entities: [
				{
					key: "brand",
					...positive(["s0001"]),
					aspects: [
						{
							key: "coverage",
							category: "positive",
							score: 70,
							confidence: 0.8,
							evidence: [
								{ anchorId: "s0001", polarity: "positive" },
								{ anchorId: "s0004", polarity: "positive" },
							],
						},
					],
				},
			],
		};
		expect(() => validateSentimentResult(result, { answerBody: answer, candidates: [ARVO] })).not.toThrow();
	});
});

describe("V4-RED-005 Mixed structural mismatch", () => {
	// s0001 positive sentence · s0002 negative sentence · s0003 both-sides sentence
	const answer =
		"Arvo ist günstig.\n\nDer Arvo Service ist langsam.\n\nArvo bietet gute Leistungen, aber die Selbstbeteiligung kann steigen.";
	const anchorIds = ids(answer);
	const schema = sentimentProviderResultSchemaFor(anchorIds, ["brand"]);

	it("the provider schema cannot express Mixed without both polarities", () => {
		const oneSided = {
			entities: [
				{
					key: "brand",
					category: "mixed",
					score: 50,
					confidence: 0.9,
					positiveEvidence: [{ anchorId: "s0001", polarity: "positive" }],
					negativeEvidence: [],
					aspects: [],
				},
			],
		};
		expect(schema.safeParse(oneSided).success).toBe(false);
	});

	it("the provider schema cannot express a Positive target carrying a negative anchor", () => {
		const conflicting = {
			entities: [
				{
					key: "brand",
					category: "positive",
					score: 80,
					confidence: 0.9,
					evidence: [
						{ anchorId: "s0001", polarity: "positive" },
						{ anchorId: "s0002", polarity: "negative" },
					],
					aspects: [],
				},
			],
		};
		expect(schema.safeParse(conflicting).success).toBe(false);
	});

	it("local validation refuses a non-Mixed target whose evidence carries both polarities even when the shape parses", () => {
		const conflicting = {
			entities: [
				{
					key: "brand",
					category: "positive",
					score: 80,
					confidence: 0.9,
					evidence: [
						{ anchorId: "s0001", polarity: "positive" },
						{ anchorId: "s0002", polarity: "negative" },
					],
					aspects: [],
				},
			],
		};
		// The wire schema already refuses this shape; the internal representation reaches the second boundary directly.
		expect(() => validateClassification(conflicting, { answerBody: answer, candidates: [ARVO] })).toThrow(
			expect.objectContaining({ code: "polarity-category-mismatch" }),
		);
	});

	it("Mixed may cite the same both-sides anchor once per polarity", () => {
		const both = { entities: [{ key: "brand", ...mixed(["s0003"], ["s0003"]), aspects: [] }] };
		expect(schema.safeParse(both).success).toBe(true);
		const [entity] = validateSentimentResult(both, { answerBody: answer, candidates: [ARVO] });
		expect(entity.evidence.map((e) => e.polarity).sort()).toEqual(["negative", "positive"]);
	});

	it("different aspects may carry opposite polarities on the same anchor", () => {
		const result = {
			entities: [
				{
					key: "brand",
					...mixed(["s0003"], ["s0003"]),
					aspects: [
						{ key: "coverage", ...positive(["s0003"], 75) },
						{
							key: "price",
							category: "negative",
							score: 30,
							confidence: 0.8,
							evidence: [{ anchorId: "s0003", polarity: "negative" }],
						},
					],
				},
			],
		};
		expect(schema.safeParse(result).success).toBe(true);
		expect(() => validateSentimentResult(result, { answerBody: answer, candidates: [ARVO] })).not.toThrow();
	});
});

describe("V4-RED-006 aspect routing rules are part of the prompt contract", () => {
	it("routes deductible and value to price, scope and waiting periods to coverage, claims handling to service, and confines other to explicit evaluation", () => {
		expect(SENTIMENT_ASPECT_ROUTING_RULES).toMatch(/Selbstbeteiligung|deductible/i);
		expect(SENTIMENT_ASPECT_ROUTING_RULES).toMatch(/"price"/);
		expect(SENTIMENT_ASPECT_ROUTING_RULES).toMatch(/waiting period/i);
		expect(SENTIMENT_ASPECT_ROUTING_RULES).toMatch(/claims handling/i);
		expect(SENTIMENT_ASPECT_ROUTING_RULES).toMatch(/statistic/i);
		expect(SENTIMENT_ASPECT_ROUTING_RULES).toMatch(/"other"/);
	});
});

describe("V4 neutral descriptive statistics stay Neutral at the validator boundary", () => {
	it("a Neutral other aspect on a case-count statistic is a valid labelling", () => {
		const answer = "Der Arvo Trendmonitor analysiert Rechtskonflikte.\n\nDie Fälle bei Arvo stiegen seit 2021 um 63 %.";
		const result = {
			entities: [
				{
					key: "brand",
					...neutral(["s0001"]),
					aspects: [{ key: "other", ...neutral(["s0002"]) }],
				},
			],
		};
		expect(() => validateSentimentResult(result, { answerBody: answer, candidates: [ARVO] })).not.toThrow();
	});
});
