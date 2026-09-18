/**
 * V5-RED-001…V5-RED-009 — grounded-claim completion (classifier v5): the
 * overall verdict of every candidate is mandatory and terminal when defective;
 * an aspect claim without entity-specific evidence is dropped on its own and
 * the analysis completes on everything the text supports. Synthetic
 * reproducers of the production runs 2da20f88 (generic-caveat price aspect,
 * terminal under v4), 9c472bf5 (checklist price aspect), 996deaca (entity swap)
 * and 24fda1eb (foreign-only overall evidence), built from their sanitised
 * diagnostics and answer structure only. Offline; no provider call.
 */
import { describe, expect, it, vi } from "vitest";
import { segmentAnswer } from "../anchors";
import {
	ASPECT_LOCAL_VALIDATION_CODES,
	type SentimentClassification,
	SentimentValidationError,
	validateClassification,
	validateClassificationDetailed,
	validateSentimentResult,
	validateSentimentResultDetailed,
} from "../classifier";
import { GOLDEN_V4_CASES } from "../golden/v4-cases";
import { runSentimentJob, type SentimentJobDeps } from "../job";
import {
	SENTIMENT_CLASSIFIER_VERSION,
	SENTIMENT_READABLE_CLASSIFIER_VERSIONS,
	SENTIMENT_TAXONOMY_VERSION,
	type SentimentCandidate,
} from "../types";
import { resolutionFakes } from "./resolution-fakes";

const brand: SentimentCandidate = { key: "brand", entityType: "brand", competitorId: null, name: "ARAG", aliases: [] };
const BELTRA = "b64b96f5-3bbd-4e42-a5ea-f30821cb9f8c";
const beltra: SentimentCandidate = {
	key: BELTRA,
	entityType: "competitor",
	competitorId: BELTRA,
	name: "Beltra",
	aliases: [],
};

/**
 * Structure of production run 2da20f88 (13 anchors there, 9 here): the
 * candidate is named in the opening sentence, one "Dafür spricht" bullet and
 * the closing sentence; the price statement is a bullet under the generic
 * label "Worauf du achten solltest", attributable to nobody.
 */
const caveatAnswer = `Wenn du die **ARAG-Rechtsschutzversicherung** meinst: **Ja, sie kann gut sein – besonders beim Leistungsumfang –, aber sie ist nicht automatisch die beste Wahl für jeden.**

**Dafür spricht:**
- Vergleichstests bewerten den Leistungsumfang der ARAG positiv.
- Es gibt umfangreiche Leistungen, etwa weltweiten Schutz – je nach Tarif.

**Worauf du achten solltest:**
- Tarife unterscheiden sich stark bei Wartezeit, Selbstbeteiligung und Ausschlüssen.
- Ein Premium-Tarif kann deutlich teurer sein als ein ausreichender Basistarif.

**Kurz gesagt:**
Für Rechtsschutz ist die ARAG grundsätzlich ein seriöser und leistungsstarker Anbieter.`;

const cite = (polarity: "positive" | "negative" | "neutral", ...anchorIds: string[]) =>
	anchorIds.map((anchorId) => ({ anchorId, polarity }));
const positive = (score: number, ...ids: string[]) => ({
	category: "positive",
	score,
	confidence: 0.9,
	evidence: cite("positive", ...ids),
});
const negative = (score: number, ...ids: string[]) => ({
	category: "negative",
	score,
	confidence: 0.9,
	evidence: cite("negative", ...ids),
});

/** The provider answer for 2da20f88 as the diagnostic describes it: valid overall and coverage, a price aspect on the generic caveat. */
const caveatResult = {
	entities: [
		{
			key: "brand",
			...positive(70, "s0001", "s0009"),
			aspects: [
				{ key: "coverage", ...positive(80, "s0003") },
				{ key: "price", ...negative(30, "s0007") },
			],
		},
	],
};

function rejection(fn: () => unknown): SentimentValidationError {
	try {
		fn();
	} catch (error) {
		expect(error).toBeInstanceOf(SentimentValidationError);
		return error as SentimentValidationError;
	}
	throw new Error("expected a SentimentValidationError");
}

describe("V5-RED-001 run 2da20f88 — a generic-caveat price aspect no longer sinks the analysis", () => {
	it("segments the reproducer like the production answer: generic label and generic bullets", () => {
		const ids = segmentAnswer(caveatAnswer).map((a) => a.id);
		expect(ids).toEqual(["s0001", "s0002", "s0003", "s0004", "s0005", "s0006", "s0007", "s0008", "s0009"]);
	});

	it("v4 baseline (documentation): the same answer was terminal with aspect-ungrounded on brand/price", () => {
		// Kept as the record of the defect this round fixes; under v5 the
		// detailed validation below completes instead.
		expect(caveatResult.entities[0].aspects[1]).toMatchObject({ key: "price" });
	});

	it("completes with the overall and the coverage aspect, without the price aspect and without a synthetic neutral", () => {
		const { entities, filteredClaims } = validateClassificationDetailed(caveatResult, {
			answerBody: caveatAnswer,
			candidates: [brand],
		});
		expect(entities).toHaveLength(1);
		expect(entities[0]).toMatchObject({ key: "brand", category: "positive", score: 70 });
		expect(entities[0].aspects.map((a) => a.key)).toEqual(["coverage"]);
		expect(entities[0].aspects.find((a) => a.key === "price")).toBeUndefined();
		expect(filteredClaims).toEqual([
			{
				entityKey: "brand",
				aspectKey: "price",
				code: "aspect-ungrounded",
				anchorIds: ["s0007"],
			},
		]);
	});

	it("the plain validation returns the same completed entities (the filtered claim is audit, not a result)", () => {
		const entities = validateClassification(caveatResult, { answerBody: caveatAnswer, candidates: [brand] });
		expect(entities[0].aspects.map((a) => a.key)).toEqual(["coverage"]);
	});

	it("the wire-shape validation completes as well", () => {
		const entities = validateSentimentResult(caveatResult, { answerBody: caveatAnswer, candidates: [brand] });
		expect(entities[0].aspects.map((a) => a.key)).toEqual(["coverage"]);
	});
});

describe("V5-RED-002 run 9c472bf5 — the checklist price aspect is dropped, the analysis completes", () => {
	const checklist = GOLDEN_V4_CASES.find((c) => c.id === "v4-checklist-de");
	if (!checklist) throw new Error("golden case v4-checklist-de missing");

	it("the golden corpus now expects acceptance with the price aspect filtered", () => {
		expect(checklist.expectedValidator).toEqual({ kind: "accept" });
		expect(checklist.expected[brand.key]?.forbiddenAspects).toContain("price");
	});

	it("validates to a completed positive verdict with zero aspects and one filtered claim", () => {
		const { entities, filteredClaims } = validateSentimentResultDetailed(checklist.result, {
			answerBody: checklist.answer,
			candidates: checklist.candidates,
		});
		expect(entities).toHaveLength(1);
		expect(entities[0].category).toBe("positive");
		expect(entities[0].aspects).toEqual([]);
		expect(filteredClaims).toEqual([
			{ entityKey: brand.key, aspectKey: "price", code: "aspect-ungrounded", anchorIds: ["s0003", "s0004"] },
		]);
	});
});

describe("V5-RED-003 runs 996deaca / 24fda1eb — a defective mandatory overall stays terminal", () => {
	const swap = GOLDEN_V4_CASES.find((c) => c.id === "v4-swap-de");
	const foreign = GOLDEN_V4_CASES.find((c) => c.id === "v4-foreign-only-en");
	if (!swap || !foreign) throw new Error("golden cases missing");

	it("entity swap: terminal evidence-entity-unbound, nothing validated", () => {
		const error = rejection(() =>
			validateSentimentResultDetailed(swap.result, { answerBody: swap.answer, candidates: swap.candidates }),
		);
		expect(error.code).toBe("evidence-entity-unbound");
		expect(error.diagnostic?.aspectKey).toBeNull();
	});

	it("entity swap with aspects attached cannot be rescued by aspect filtering", () => {
		const anchors = segmentAnswer(swap.answer);
		const result = swap.result as { entities: Array<Record<string, unknown>> };
		const withAspects = {
			entities: result.entities.map((entity) => ({
				...entity,
				aspects: [{ key: "price", ...positive(80, anchors[0].id) }],
			})),
		};
		const error = rejection(() =>
			validateSentimentResultDetailed(withAspects, { answerBody: swap.answer, candidates: swap.candidates }),
		);
		expect(error.code).toBe("evidence-entity-unbound");
	});

	it("foreign-only overall evidence: terminal", () => {
		const error = rejection(() =>
			validateSentimentResultDetailed(foreign.result, { answerBody: foreign.answer, candidates: foreign.candidates }),
		);
		expect(error.code).toBe("evidence-entity-unbound");
	});
});

describe("V5-RED-004 the same validation code is filtered on an aspect and terminal on the overall", () => {
	const answer = "Arvo offers a solid service.\n\nBeltra is cheap.";
	const arvo: SentimentCandidate = { ...brand, name: "Arvo" };
	const both = [arvo, beltra];

	it("evidence-entity-unbound on an aspect → filtered", () => {
		const { entities, filteredClaims } = validateClassificationDetailed(
			{
				entities: [
					{ key: arvo.key, ...positive(75, "s0001"), aspects: [{ key: "price", ...positive(70, "s0002") }] },
					{ key: BELTRA, ...positive(75, "s0002"), aspects: [] },
				],
			},
			{ answerBody: answer, candidates: both },
		);
		expect(entities.map((e) => e.aspects.length)).toEqual([0, 0]);
		expect(filteredClaims).toEqual([
			{ entityKey: arvo.key, aspectKey: "price", code: "evidence-entity-unbound", anchorIds: ["s0002"] },
		]);
	});

	it("evidence-entity-unbound on the overall → terminal", () => {
		const error = rejection(() =>
			validateClassificationDetailed(
				{
					entities: [
						{ key: arvo.key, ...positive(75, "s0002"), aspects: [] },
						{ key: BELTRA, ...positive(75, "s0002"), aspects: [] },
					],
				},
				{ answerBody: answer, candidates: both },
			),
		);
		expect(error.code).toBe("evidence-entity-unbound");
	});

	it.each([
		[
			"polarity-category-mismatch",
			{ key: "service", category: "positive", score: 70, confidence: 0.9, evidence: cite("negative", "s0001") },
		],
		[
			"mixed-needs-dual-evidence",
			{ key: "service", category: "mixed", score: 50, confidence: 0.9, evidence: cite("positive", "s0001") },
		],
		[
			"evidence-anchor-polarity-conflict",
			{
				key: "service",
				category: "positive",
				score: 70,
				confidence: 0.9,
				evidence: [...cite("positive", "s0001"), ...cite("negative", "s0001")],
			},
		],
	])("%s on an aspect → filtered; the overall stays", (code, aspect) => {
		const { entities, filteredClaims } = validateClassificationDetailed(
			{ entities: [{ key: arvo.key, ...positive(75, "s0001"), aspects: [aspect] }] },
			{ answerBody: "Arvo offers a solid service.", candidates: [arvo] },
		);
		expect(entities[0].aspects).toEqual([]);
		expect(filteredClaims.map((c) => c.code)).toEqual([code]);
	});

	it.each([
		["polarity-category-mismatch", { category: "positive", score: 70, evidence: cite("negative", "s0001") }],
		["mixed-needs-dual-evidence", { category: "mixed", score: 50, evidence: cite("positive", "s0001") }],
		[
			"evidence-anchor-polarity-conflict",
			{ category: "positive", score: 70, evidence: [...cite("positive", "s0001"), ...cite("negative", "s0001")] },
		],
	])("%s on the overall → terminal", (code, overall) => {
		const error = rejection(() =>
			validateClassificationDetailed(
				{ entities: [{ key: arvo.key, confidence: 0.9, ...overall, aspects: [] }] },
				{ answerBody: "Arvo offers a solid service.", candidates: [arvo] },
			),
		);
		expect(error.code).toBe(code);
	});
});

describe("V5-RED-005 the aspect-local allow-list is closed and fails closed", () => {
	it("contains exactly the five aspect-local grounding/consistency codes", () => {
		expect([...ASPECT_LOCAL_VALIDATION_CODES].sort()).toEqual(
			[
				"aspect-ungrounded",
				"evidence-entity-unbound",
				"polarity-category-mismatch",
				"mixed-needs-dual-evidence",
				"evidence-anchor-polarity-conflict",
			].sort(),
		);
		expect(Object.isFrozen(ASPECT_LOCAL_VALIDATION_CODES)).toBe(true);
	});

	it.each([
		["evidence-unknown-anchor", [{ key: "price", ...positive(70, "s0042") }]],
		[
			"duplicate-aspect",
			[
				{ key: "price", ...positive(70, "s0001") },
				{ key: "price", ...positive(70, "s0001") },
			],
		],
		[
			"score-category",
			[{ key: "price", category: "positive", score: 20, confidence: 0.9, evidence: cite("positive", "s0001") }],
		],
	])("a code outside the allow-list on an aspect (%s) stays terminal", (code, aspects) => {
		const error = rejection(() =>
			validateClassificationDetailed(
				{ entities: [{ key: brand.key, ...positive(75, "s0001"), aspects }] },
				{ answerBody: "ARAG bietet einen guten Schutz.", candidates: [brand] },
			),
		);
		expect(error.code).toBe(code);
	});
});

describe("V5-RED-006 completeness without aspects", () => {
	const answer = "ARAG bietet einen guten Schutz.\n\nDer Beitrag hängt vom Tarif ab.";

	it("all aspect claims filtered → completed with zero aspect rows, no synthetic neutral", () => {
		const { entities, filteredClaims } = validateClassificationDetailed(
			{
				entities: [
					{
						key: brand.key,
						...positive(75, "s0001"),
						aspects: [
							{ key: "price", ...negative(30, "s0002") },
							{ key: "coverage", ...positive(80, "s0002") },
						],
					},
				],
			},
			{ answerBody: answer, candidates: [brand] },
		);
		expect(entities[0].aspects).toEqual([]);
		expect(filteredClaims.map((c) => c.aspectKey)).toEqual(["price", "coverage"]);
		expect(entities[0].aspects.some((a) => a.category === "neutral" || a.score === 50)).toBe(false);
	});

	it("no aspect claim at all → completed, no filtered claim", () => {
		const { entities, filteredClaims } = validateClassificationDetailed(
			{ entities: [{ key: brand.key, ...positive(75, "s0001"), aspects: [] }] },
			{ answerBody: answer, candidates: [brand] },
		);
		expect(entities[0].aspects).toEqual([]);
		expect(filteredClaims).toEqual([]);
	});
});

describe("V5-RED-007 versions and read order", () => {
	it("the classifier is sent-classifier-v5 and reads v5 → v4 → v3", () => {
		expect(SENTIMENT_CLASSIFIER_VERSION).toBe("sent-classifier-v5");
		expect([...SENTIMENT_READABLE_CLASSIFIER_VERSIONS]).toEqual([
			"sent-classifier-v5",
			"sent-classifier-v4",
			"sent-classifier-v3",
		]);
	});
});

describe("V5-RED-008 job semantics of a completed analysis with a filtered claim", () => {
	const run = {
		id: "2da20f88-0000-4000-8000-000000000001",
		promptId: "p1",
		brandId: "arag",
		provider: "openrouter",
		model: "chatgpt",
		answerBody: caveatAnswer,
		organizationId: "org",
	};
	const mentions = [{ id: "m1", key: "brand", entityType: "brand" as const, competitorId: null, entityName: "ARAG" }];
	const classification: SentimentClassification = {
		entities: [
			{
				key: "brand",
				score: 70,
				category: "positive",
				confidence: 0.9,
				evidence: [{ quote: "x", start: 0, end: 1, polarity: "positive" }],
				aspects: [
					{
						key: "coverage",
						score: 80,
						category: "positive",
						confidence: 0.9,
						evidence: [{ quote: "y", start: 2, end: 3, polarity: "positive" }],
					},
				],
			},
		],
		filteredClaims: [{ entityKey: "brand", aspectKey: "price", code: "aspect-ungrounded", anchorIds: ["s0007"] }],
		unresolvedTargets: [],
		contractDefect: null,
		// The internal candidate the workflow re-assesses: the same claims by anchor id (price on the generic caveat s0007).
		candidate: {
			entities: [
				{
					key: "brand",
					score: 70,
					category: "positive",
					confidence: 0.9,
					evidence: [
						{ anchorId: "s0001", polarity: "positive" },
						{ anchorId: "s0009", polarity: "positive" },
					],
					aspects: [
						{
							key: "coverage",
							score: 80,
							category: "positive",
							confidence: 0.9,
							evidence: [{ anchorId: "s0003", polarity: "positive" }],
						},
						{
							key: "price",
							score: 30,
							category: "negative",
							confidence: 0.9,
							evidence: [{ anchorId: "s0007", polarity: "negative" }],
						},
					],
				},
			],
		},
		provider: "openrouter",
		model: "openai/gpt-5-mini",
		webSearch: true,
		classifierVersion: SENTIMENT_CLASSIFIER_VERSION,
		taxonomyVersion: SENTIMENT_TAXONOMY_VERSION,
		inputHash: "deadbeef",
		usage: { costUsd: 0.019128 } as never,
		generationId: "gen-v5-red-008",
	};

	it("completes the job as classified with the filtered-claim summary, one paid success, no failure mark", async () => {
		const marks: unknown[] = [];
		const usage: unknown[] = [];
		const persisted: unknown[] = [];
		const resolution = resolutionFakes();
		const deps: SentimentJobDeps = {
			...resolution.deps,
			resolveProvider: () => resolution.phasesProvider(),
			loadRun: vi.fn(async () => run),
			loadEntities: vi.fn(
				async () =>
					[{ key: "brand", entityType: "brand", competitorId: null, name: "ARAG", aliases: [], terms: [] }] as never,
			),
			loadDetection: vi.fn(async () => ({ status: "mentions", mentionCount: 1 }) as never),
			loadMentions: vi.fn(async () => mentions),
			ensureAnalysis: vi.fn(
				async () =>
					({
						id: "a1",
						status: "pending",
						classifierVersion: SENTIMENT_CLASSIFIER_VERSION,
						taxonomyVersion: SENTIMENT_TAXONOMY_VERSION,
						inputHash: null,
					}) as never,
			),
			claimAnalysis: vi.fn(async () => ({
				claimed: true as const,
				attempts: 1,
				claim: { analysisId: "a1", generation: 1 },
			})),
			markAnalysis: vi.fn(async (_claim: unknown, patch: unknown) => {
				marks.push(patch);
				return true;
			}),
			classify: vi.fn(async () => classification),
			persist: vi.fn(async (args: unknown) => {
				persisted.push(args);
			}),
			recordUsage: vi.fn(async (event: unknown) => {
				usage.push(event);
			}),
		};
		const outcome = await runSentimentJob(
			{
				promptRunId: run.id,
				classifierVersion: SENTIMENT_CLASSIFIER_VERSION,
				taxonomyVersion: SENTIMENT_TAXONOMY_VERSION,
			},
			deps,
		);
		expect(outcome).toMatchObject({
			status: "classified",
			entities: 1,
			entityKeys: ["brand"],
			usage: classification.usage,
			generationId: "gen-v5-red-008",
			filteredClaimCount: 1,
			filteredClaimCodes: { "aspect-ungrounded": 1 },
			verified: true,
			paidCalls: 2,
			repairs: 0,
		});
		expect(marks).toEqual([]);
		// The initial classification and the verification: one paid success each; the dropped aspect never costs a repair.
		expect(usage).toEqual([
			expect.objectContaining({ succeeded: true, actualCostUsd: 0.019128 }),
			expect.objectContaining({ succeeded: true }),
		]);
		expect(resolution.calls.map((c) => c.phase)).toEqual(["verify"]);
		expect(persisted).toHaveLength(1);
		expect((persisted[0] as { classification: SentimentClassification }).classification.filteredClaims).toEqual(
			classification.filteredClaims,
		);
	});
});
