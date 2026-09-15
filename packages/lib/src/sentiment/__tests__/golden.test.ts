import { describe, expect, it } from "vitest";
import type { Provider } from "../../providers/types";
import { segmentAnswer } from "../anchors";
import { classifySentiment, validateSentimentResult } from "../classifier";
import { competitorEntity, detectEntityMentions } from "../detector";
import {
	GOLDEN_BELTRA,
	GOLDEN_BELTRA_UUID,
	GOLDEN_BRAND,
	GOLDEN_CASES,
	GOLDEN_CORVEX,
	GOLDEN_DUNHILL,
} from "../golden/corpus";
import { GOLDEN_GATES, goldenGatesPass, scoreGoldenCase, summarizeGolden } from "../golden/evaluate";
import { goldenReference } from "../golden/reference";
import { sentimentClassificationResultSchemaFor } from "../types";

const brandEntityForGolden = {
	key: GOLDEN_BRAND.key,
	entityType: "brand" as const,
	competitorId: null,
	name: GOLDEN_BRAND.name,
	aliases: GOLDEN_BRAND.aliases,
	domains: ["arvo.example"],
};

const args = (goldenCase: (typeof GOLDEN_CASES)[number]) => ({
	answerBody: goldenCase.answer,
	candidates: goldenCase.candidates,
});

describe("GOLD-SNT-001 synthetic corpus", () => {
	it("has at least 40 cases in both languages with critical must-pass cases", () => {
		expect(GOLDEN_CASES.length).toBeGreaterThanOrEqual(40);
		expect(new Set(GOLDEN_CASES.map((c) => c.id)).size).toBe(GOLDEN_CASES.length);
		expect(GOLDEN_CASES.filter((c) => c.lang === "de").length).toBeGreaterThanOrEqual(15);
		expect(GOLDEN_CASES.filter((c) => c.lang === "en").length).toBeGreaterThanOrEqual(15);
		expect(GOLDEN_CASES.filter((c) => c.critical).length).toBeGreaterThanOrEqual(10);
		const categories = new Set(GOLDEN_CASES.flatMap((c) => Object.values(c.expected).map((e) => e.category)));
		expect([...categories].sort()).toEqual(["mixed", "negative", "neutral", "positive"]);
	});

	it("every reference excerpt lies inside exactly one anchor and the anchored labelling passes the classifier validation", () => {
		for (const goldenCase of GOLDEN_CASES) {
			const reference = goldenReference(goldenCase);
			expect(() => validateSentimentResult(reference, args(goldenCase)), goldenCase.id).not.toThrow();
			const entities = validateSentimentResult(reference, args(goldenCase));
			for (const entity of entities) {
				for (const ev of [...entity.evidence, ...entity.aspects.flatMap((a) => a.evidence)]) {
					expect(goldenCase.answer.slice(ev.start, ev.end), goldenCase.id).toBe(ev.quote);
				}
			}
		}
	});

	it("the raw excerpt form of the labels is no longer accepted by the classifier contract", () => {
		const first = GOLDEN_CASES[0];
		expect(() => validateSentimentResult(first.reference, args(first))).toThrow(
			expect.objectContaining({ code: "schema" }),
		);
	});

	it("GOLD-SNT-CIT-001: against the whole roster the detector finds exactly the candidates — never an entity that occurs only as a URL, link destination or source entry", () => {
		const roster = [
			brandEntityForGolden,
			...[GOLDEN_BELTRA, GOLDEN_CORVEX, GOLDEN_DUNHILL, GOLDEN_BELTRA_UUID].map((c) =>
				competitorEntity({
					id: c.key,
					name: c.name,
					aliases: c.aliases,
					domains: [`${c.name.split(" ")[0].toLowerCase()}.example`],
				}),
			),
		];
		for (const goldenCase of GOLDEN_CASES.filter((c) => c.id >= "g43")) {
			const wanted = goldenCase.candidates.map((c) => c.key);
			const found = detectEntityMentions(goldenCase.answer, roster)
				.map((m) => m.key)
				// Beltra is on the roster twice (two keys, one name) so both keys fire on prose mentions of it.
				.filter((key) => key !== GOLDEN_BELTRA.key || wanted.includes(GOLDEN_BELTRA.key))
				.filter((key) => key !== GOLDEN_BELTRA_UUID.key || wanted.includes(GOLDEN_BELTRA_UUID.key));
			expect(found.sort(), goldenCase.id).toEqual([...wanted].sort());
		}
	});

	it("GOLD-SNT-CIT-001: the request schema of every case accepts only the exact candidate keys", () => {
		for (const goldenCase of GOLDEN_CASES) {
			const ids = segmentAnswer(goldenCase.answer).map((anchor) => anchor.id);
			const schema = sentimentClassificationResultSchemaFor(
				ids,
				goldenCase.candidates.map((c) => c.key),
			);
			const reference = goldenReference(goldenCase);
			expect(schema.safeParse(reference).success, goldenCase.id).toBe(true);
			const byName = {
				entities: reference.entities.map((entity) => ({
					...entity,
					key: goldenCase.candidates.find((c) => c.key === entity.key)?.name ?? entity.key,
				})),
			};
			expect(schema.safeParse(byName).success, goldenCase.id).toBe(false);
		}
	});

	it("the deterministic detector finds every candidate entity in every answer", () => {
		for (const goldenCase of GOLDEN_CASES) {
			const entities = goldenCase.candidates.map((c) =>
				c.entityType === "brand"
					? brandEntityForGolden
					: competitorEntity({ id: c.key, name: c.name, aliases: c.aliases, domains: [] }),
			);
			const found = detectEntityMentions(goldenCase.answer, entities).map((m) => m.key);
			expect(found.sort(), goldenCase.id).toEqual(goldenCase.candidates.map((c) => c.key).sort());
		}
	});

	it("reference labels satisfy the gates through the real classifier path with an injected provider", async () => {
		const scores = [];
		for (const goldenCase of GOLDEN_CASES) {
			const provider = {
				id: "fake",
				runStructuredResearch: async ({ schema }: { schema: { parse: (v: unknown) => unknown } }) => ({
					object: schema.parse(goldenReference(goldenCase)),
					modelVersion: "fake",
				}),
			} as unknown as Provider;
			const result = await classifySentiment(args(goldenCase), { resolveProvider: () => provider });
			scores.push(scoreGoldenCase(goldenCase, result.entities));
		}
		const summary = summarizeGolden(scores);
		expect(summary.failures).toEqual([]);
		expect(summary.validRate).toBe(1);
		expect(summary.categoryAgreement).toBe(1);
		expect(summary.aspectAgreement).toBe(1);
		expect(summary.criticalPassRate).toBe(1);
		expect(goldenGatesPass(summary)).toBe(true);
	});

	it("the evaluator fails the gates when a critical case is wrong or output is invalid", () => {
		const critical = GOLDEN_CASES.find((c) => c.critical);
		if (!critical) throw new Error("corpus has no critical case");
		const flipped = validateSentimentResult(goldenReference(critical), args(critical)).map((e) => ({
			...e,
			category: e.category === "positive" ? ("negative" as const) : ("positive" as const),
			score: e.category === "positive" ? 30 : 70,
		}));
		const bad = summarizeGolden([scoreGoldenCase(critical, flipped)]);
		expect(bad.criticalPassRate).toBe(0);
		expect(goldenGatesPass(bad)).toBe(false);
		const invalid = summarizeGolden([scoreGoldenCase(critical, null)]);
		expect(invalid.validRate).toBe(0);
		expect(goldenGatesPass(invalid)).toBe(false);
		expect(GOLDEN_GATES.categoryAgreement).toBe(0.9);
	});
});
