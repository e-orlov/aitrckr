import { describe, expect, it } from "vitest";
import { segmentAnswer } from "../anchors";
import { SentimentValidationError, validateSentimentResult } from "../classifier";
import { GOLDEN_CASES } from "../golden/corpus";
import { goldenReference } from "../golden/reference";
import { GOLDEN_V4_CASES, type GoldenV4Case } from "../golden/v4-cases";

/**
 * V4-RED-004 / V4-RED-006 / CP5 — the v4 golden cases: sanitised reproducers
 * of every proven v3 failure family with human-labelled entity, overall
 * category, aspect key/category, allowed and forbidden anchor ids and the
 * expected validator outcome. Offline and deterministic; no provider call.
 */
const REQUIRED_IDS = [
	"v4-swap-de",
	"v4-foreign-only-en",
	"v4-checklist-de",
	"v4-stat-cases-de",
	"v4-stat-usage-de",
	"v4-huk-caveat-de",
	"v4-table-en",
	"v4-multi-entity-de",
	"v4-same-anchor-mixed-de",
	"v4-cross-aspect-en",
	"v4-continuation-de",
	"v4-list-intro-de",
];

const byId = new Map(GOLDEN_V4_CASES.map((c) => [c.id, c]));

describe("V4 golden cases", () => {
	it("contains every required reproducer with human labels", () => {
		for (const id of REQUIRED_IDS) expect(byId.has(id), id).toBe(true);
		for (const c of GOLDEN_V4_CASES) {
			expect(c.expectedValidator.kind === "accept" || typeof c.expectedValidator.code === "string").toBe(true);
			for (const entity of Object.values(c.grounding)) {
				expect(entity.allowedAnchors.length + entity.forbiddenAnchors.length).toBeGreaterThan(0);
			}
		}
	});

	it("the corpus ids are unique across the v3 and v4 sets", () => {
		const all = [...GOLDEN_CASES.map((c) => c.id), ...GOLDEN_V4_CASES.map((c) => c.id)];
		expect(new Set(all).size).toBe(all.length);
	});

	it("every accept case validates and cites only allowed anchors; every reject case fails with the labelled code", () => {
		for (const c of GOLDEN_V4_CASES) {
			const anchors = segmentAnswer(c.answer);
			const raw = c.result;
			if (c.expectedValidator.kind === "accept") {
				const entities = validateSentimentResult(raw, { answerBody: c.answer, candidates: c.candidates });
				for (const entity of entities) {
					const labels = c.grounding[entity.key];
					expect(labels, `${c.id}: ${entity.key} labelled`).toBeDefined();
					expect(entity.category, `${c.id}: ${entity.key} overall`).toBe(c.expected[entity.key].category);
					const cited = [...entity.evidence, ...entity.aspects.flatMap((a) => a.evidence)].map(
						(e) => anchors.find((a) => a.start === e.start && a.end === e.end)?.id,
					);
					for (const id of cited) {
						expect(labels.allowedAnchors, `${c.id}: ${entity.key} cites ${id}`).toContain(id);
						expect(labels.forbiddenAnchors, `${c.id}: ${entity.key} cites forbidden ${id}`).not.toContain(id);
					}
					for (const [key, aspect] of Object.entries(c.expected[entity.key].aspects ?? {})) {
						const actual = entity.aspects.find((a) => a.key === key);
						expect(actual?.category, `${c.id}: ${entity.key} aspect ${key}`).toBe(aspect.category);
					}
					for (const key of c.expected[entity.key].forbiddenAspects ?? []) {
						expect(entity.aspects.some((a) => a.key === key), `${c.id}: ${entity.key} must not carry ${key}`).toBe(false);
					}
				}
			} else {
				let thrown: unknown;
				try {
					validateSentimentResult(raw, { answerBody: c.answer, candidates: c.candidates });
				} catch (error) {
					thrown = error;
				}
				expect(thrown, `${c.id}: expected rejection`).toBeInstanceOf(SentimentValidationError);
				expect((thrown as SentimentValidationError).code, c.id).toBe(c.expectedValidator.code);
			}
		}
	});

	it("the v3 corpus references still validate under the v4 contract", () => {
		for (const goldenCase of GOLDEN_CASES) {
			expect(
				() => validateSentimentResult(goldenReference(goldenCase), { answerBody: goldenCase.answer, candidates: goldenCase.candidates }),
				goldenCase.id,
			).not.toThrow();
		}
	});

	it("labels cover the semantic families the audit found", () => {
		const families = new Set(GOLDEN_V4_CASES.map((c: GoldenV4Case) => c.family));
		for (const f of ["entity-swap", "foreign-only", "unbound-aspect", "neutral-statistic", "value-deductible-caveat", "table", "multi-entity", "same-anchor-mixed", "cross-aspect", "continuation", "list-intro"]) {
			expect(families, f).toContain(f);
		}
	});
});
