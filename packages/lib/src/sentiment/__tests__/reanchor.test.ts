import { describe, expect, it } from "vitest";
import { segmentAnswer } from "../anchors";
import { sentimentInputHash } from "../classifier";
import { planReanchor, type StoredEntityResult } from "../reanchor";
import type { SentimentCandidate, SentimentEvidence } from "../types";

/**
 * SENT-ATTR-01 — re-anchoring stored results under the cell-level evidence
 * contract: a whole-row span written under the old segmentation keeps only
 * the cells of its own entity, and the plan says whether the stored result
 * is untouched, only stale in its hash, to be verified again, to be repaired,
 * or to be classified again.
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

const TABLE =
	"Kurzer Vergleich.\n\n| Kriterium | Arvo | Beltra |\n|---|---|---|\n| Preis | Eher teuer | Günstig |\n| Service | Sehr gut erreichbar | Langsame Bearbeitung |\n\nArvo ist insgesamt die rundere Wahl.";

/** A span exactly as the pre-v3 segmenter stored it: the whole row line, pipes included. */
function rowSpan(answer: string, startsWith: string, polarity: SentimentEvidence["polarity"]): SentimentEvidence {
	const start = answer.indexOf(startsWith);
	const end = answer.indexOf("\n", start);
	return { quote: answer.slice(start, end), start, end, polarity };
}
function sentenceSpan(answer: string, text: string, polarity: SentimentEvidence["polarity"]): SentimentEvidence {
	const start = answer.indexOf(text);
	return { quote: text, start, end: start + text.length, polarity };
}
const idOf = (answer: string, text: string) => segmentAnswer(answer).find((a) => a.text === text)?.id;

describe("planReanchor", () => {
	it("a table-free stored result is current: identical anchors, unchanged hash, nothing to do", () => {
		const answer = "Arvo ist teuer. Beltra ist günstig.";
		const entities: StoredEntityResult[] = [
			{
				key: "brand",
				category: "negative",
				score: 30,
				confidence: 0.9,
				evidence: [sentenceSpan(answer, "Arvo ist teuer.", "negative")],
				aspects: [],
			},
			{
				key: "c-beltra",
				category: "positive",
				score: 75,
				confidence: 0.9,
				evidence: [sentenceSpan(answer, "Beltra ist günstig.", "positive")],
				aspects: [],
			},
		];
		const plan = planReanchor({
			answerBody: answer,
			candidates,
			storedInputHash: sentimentInputHash(answer, candidates),
			entities,
		});
		expect(plan.action).toBe("current");
		expect(plan.mappings.every((m) => m.mapping.kind === "identical")).toBe(true);
	});

	it("a table-bearing answer whose cited spans are prose only is stale in its hash alone", () => {
		const entities: StoredEntityResult[] = [
			{
				key: "brand",
				category: "positive",
				score: 75,
				confidence: 0.9,
				evidence: [sentenceSpan(TABLE, "Arvo ist insgesamt die rundere Wahl.", "positive")],
				aspects: [],
			},
			{
				key: "c-beltra",
				category: "neutral",
				score: 50,
				confidence: 0.9,
				evidence: [sentenceSpan(TABLE, "Kurzer Vergleich.", "neutral")],
				aspects: [],
			},
		];
		// Beltra's only citation names nobody: under the current rules it is not attributable, so this one is not restamped.
		const plan = planReanchor({ answerBody: TABLE, candidates, storedInputHash: "old", entities });
		expect(plan.action).toBe("repair");

		const own: StoredEntityResult[] = [entities[0]];
		const single = planReanchor({ answerBody: TABLE, candidates: [ARVO], storedInputHash: "old", entities: own });
		expect(single.action).toBe("restamp");
		expect(single.inputHash).toBe(sentimentInputHash(TABLE, [ARVO]));
		expect(single.candidate).toBeNull();
	});

	it("whole-row spans keep only the cells of their own entity and the narrowed candidate goes to verification", () => {
		const entities: StoredEntityResult[] = [
			{
				key: "brand",
				category: "mixed",
				score: 50,
				confidence: 0.9,
				evidence: [rowSpan(TABLE, "| Service |", "positive"), rowSpan(TABLE, "| Preis |", "negative")],
				aspects: [
					{
						key: "price",
						category: "negative",
						score: 30,
						confidence: 0.9,
						evidence: [rowSpan(TABLE, "| Preis |", "negative")],
					},
					{
						key: "service",
						category: "positive",
						score: 80,
						confidence: 0.9,
						evidence: [rowSpan(TABLE, "| Service |", "positive")],
					},
				],
			},
			{
				key: "c-beltra",
				category: "mixed",
				score: 50,
				confidence: 0.9,
				evidence: [rowSpan(TABLE, "| Preis |", "positive"), rowSpan(TABLE, "| Service |", "negative")],
				aspects: [],
			},
		];
		const plan = planReanchor({ answerBody: TABLE, candidates, storedInputHash: "old", entities });
		expect(plan.action).toBe("reverify");
		expect(plan.reason).toBeNull();
		const arvo = plan.candidate!.entities.find((e) => e.key === "brand")!;
		expect(arvo.evidence).toEqual([
			{ anchorId: idOf(TABLE, "Sehr gut erreichbar"), polarity: "positive" },
			{ anchorId: idOf(TABLE, "Eher teuer"), polarity: "negative" },
		]);
		expect(arvo.aspects.map((a) => [a.key, a.evidence[0].anchorId])).toEqual([
			["price", idOf(TABLE, "Eher teuer")],
			["service", idOf(TABLE, "Sehr gut erreichbar")],
		]);
		const beltra = plan.candidate!.entities.find((e) => e.key === "c-beltra")!;
		expect(beltra.evidence).toEqual([
			{ anchorId: idOf(TABLE, "Günstig"), polarity: "positive" },
			{ anchorId: idOf(TABLE, "Langsame Bearbeitung"), polarity: "negative" },
		]);
		// Every row mapping dropped the other entity's cell and the criterion label.
		const narrowed = plan.mappings.filter((m) => m.mapping.kind === "narrowed");
		expect(narrowed.length).toBe(6);
		for (const m of narrowed) {
			if (m.mapping.kind !== "narrowed") continue;
			expect(m.mapping.kept).toHaveLength(1);
			expect(m.mapping.droppedOthers).toHaveLength(1);
			expect(m.mapping.droppedGeneric).toHaveLength(1);
		}
		expect(plan.candidate!.entities.map((e) => [e.category, e.score])).toEqual([
			["mixed", 50],
			["mixed", 50],
		]);
	});

	it("an aspect resting on the other entity's cell alone is dropped from the candidate; an overall verdict that loses a polarity needs a repair", () => {
		const entities: StoredEntityResult[] = [
			{
				key: "brand",
				category: "positive",
				score: 80,
				confidence: 0.9,
				evidence: [rowSpan(TABLE, "| Service |", "positive")],
				// The old row anchor let the model file Beltra's cheapness under Arvo's price.
				aspects: [
					{
						key: "price",
						category: "positive",
						score: 75,
						confidence: 0.9,
						evidence: [sentenceSpan(TABLE, "Günstig", "positive")],
					},
				],
			},
			{
				key: "c-beltra",
				category: "positive",
				score: 75,
				confidence: 0.9,
				evidence: [sentenceSpan(TABLE, "Günstig", "positive")],
				aspects: [],
			},
		];
		const dropped = planReanchor({ answerBody: TABLE, candidates, storedInputHash: "old", entities });
		// The stored aspect span is exactly the Beltra cell — Beltra's evidence, so Arvo's price claim is dropped, not carried to the verifier.
		expect(dropped.action).toBe("reverify");
		expect(dropped.candidate!.entities[0].aspects).toEqual([]);
		expect(dropped.droppedAspects).toEqual([{ entityKey: "brand", aspectKey: "price" }]);
		expect(dropped.mappings.find((m) => m.aspectKey === "price")?.mapping).toEqual({
			kind: "foreign",
			anchorId: idOf(TABLE, "Günstig"),
		});

		const mixed: StoredEntityResult[] = [
			{
				key: "brand",
				category: "mixed",
				score: 50,
				confidence: 0.9,
				// Positive from Arvo's cell, negative only from Beltra's cell: the negative side vanishes after narrowing.
				evidence: [rowSpan(TABLE, "| Service |", "positive"), sentenceSpan(TABLE, "Langsame Bearbeitung", "negative")],
				aspects: [],
			},
			{
				key: "c-beltra",
				category: "negative",
				score: 30,
				confidence: 0.9,
				evidence: [sentenceSpan(TABLE, "Langsame Bearbeitung", "negative")],
				aspects: [],
			},
		];
		const repair = planReanchor({ answerBody: TABLE, candidates, storedInputHash: "old", entities: mixed });
		expect(repair.action).toBe("repair");
	});

	it("a result whose overall evidence was entirely the other entity's is classified again", () => {
		const entities: StoredEntityResult[] = [
			{
				key: "brand",
				category: "positive",
				score: 80,
				confidence: 0.9,
				evidence: [sentenceSpan(TABLE, "Günstig", "positive")],
				aspects: [],
			},
			{
				key: "c-beltra",
				category: "positive",
				score: 75,
				confidence: 0.9,
				evidence: [sentenceSpan(TABLE, "Günstig", "positive")],
				aspects: [],
			},
		];
		const plan = planReanchor({ answerBody: TABLE, candidates, storedInputHash: "old", entities });
		expect(plan.action).toBe("reclassify");
		expect(plan.candidate).toBeNull();
		expect(plan.reason).toMatch(/brand/);
	});

	it("a span that no longer slices the answer cannot be carried over", () => {
		const stale: SentimentEvidence = { quote: "Eher teuer", start: 0, end: 10, polarity: "negative" };
		const plan = planReanchor({
			answerBody: TABLE,
			candidates,
			storedInputHash: "old",
			entities: [
				{ key: "brand", category: "negative", score: 30, confidence: 0.9, evidence: [stale], aspects: [] },
				{
					key: "c-beltra",
					category: "positive",
					score: 75,
					confidence: 0.9,
					evidence: [sentenceSpan(TABLE, "Günstig", "positive")],
					aspects: [],
				},
			],
		});
		expect(plan.action).toBe("reclassify");
		expect(plan.mappings[0].mapping).toEqual({ kind: "unmapped" });
	});
});
