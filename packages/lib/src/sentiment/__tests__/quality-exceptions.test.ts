import { describe, expect, it } from "vitest";
import { SentimentValidationError, validateSentimentResult, validateSentimentResultDetailed } from "../classifier";
import { GOLDEN_V4_CASES } from "../golden/v4-cases";
import { buildSentimentPrompt, SENTIMENT_ASPECT_ROUTING_RULES } from "../prompt";

/**
 * The three production quality exceptions of the v3 audit, each replayed on
 * its sanitised, synthetic stand-in (fictional insurers, invented wording,
 * same structure). Identified by the run id prefix of the exception register
 * only; no production text is ever stored here.
 *
 * - 996deaca — entity swap: the brand's verdict cited the competitor's
 *   sentence and comparison row.
 * - 9c472bf5 — a negative price aspect built from generic checklist bullets
 *   that name no entity.
 * - a7dd9e90 — a descriptive statistic (case counts rising) labelled as a
 *   positive `other` aspect.
 */
const byId = new Map(GOLDEN_V4_CASES.map((c) => [c.id, c]));
const standIn = (id: string) => {
	const c = byId.get(id);
	if (!c) throw new Error(`missing golden case ${id}`);
	return c;
};
const rejection = (id: string) => {
	const c = standIn(id);
	try {
		validateSentimentResult(c.result, { answerBody: c.answer, candidates: c.candidates });
	} catch (error) {
		return error;
	}
	return null;
};

describe("quality exceptions of the v3 production audit", () => {
	it("996deaca (entity swap) is refused deterministically as evidence-entity-unbound", () => {
		const error = rejection("v4-swap-de");
		expect(error).toBeInstanceOf(SentimentValidationError);
		expect((error as SentimentValidationError).code).toBe("evidence-entity-unbound");
		// Fail-closed: the diagnostic names the offending target and anchor, never any text.
		const diagnostic = (error as SentimentValidationError).diagnostic;
		expect(diagnostic).toMatchObject({ stage: "evidence", anchorId: expect.stringMatching(/^s\d{4}$/) });
		expect(JSON.stringify(diagnostic)).not.toContain(standIn("v4-swap-de").answer.slice(0, 20));
	});

	it("9c472bf5 (aspect from generic checklist bullets) completes without the price aspect (classifier v5)", () => {
		const c = standIn("v4-checklist-de");
		const { entities, filteredClaims } = validateSentimentResultDetailed(c.result, {
			answerBody: c.answer,
			candidates: c.candidates,
		});
		expect(entities).toHaveLength(1);
		expect(entities[0]).toMatchObject({ category: "positive", aspects: [] });
		expect(filteredClaims).toEqual([
			expect.objectContaining({ aspectKey: "price", code: "aspect-ungrounded", anchorIds: ["s0003", "s0004"] }),
		]);
	});

	it("a7dd9e90 (statistic as positive `other`) is addressed by the prompt contract, and its human label validates as neutral without aspects", () => {
		// A structural guard cannot tell praise from a number; the mitigation is the routing rule the provider is bound to.
		expect(SENTIMENT_ASPECT_ROUTING_RULES).toMatch(/descriptive statistic is not an evaluation/);
		expect(SENTIMENT_ASPECT_ROUTING_RULES).toMatch(/"other" is a narrow fallback, never a default bucket/);
		const c = standIn("v4-stat-cases-de");
		expect(buildSentimentPrompt({ answerBody: c.answer, candidates: c.candidates })).toContain(
			SENTIMENT_ASPECT_ROUTING_RULES,
		);
		const entities = validateSentimentResult(c.result, { answerBody: c.answer, candidates: c.candidates });
		expect(entities).toHaveLength(1);
		expect(entities[0]).toMatchObject({ category: "neutral", score: 50, aspects: [] });
	});
});
