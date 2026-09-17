/**
 * V5-ERC RED — eventual reliable completion (ADR Amendment B): a candidate is
 * assessed, never rejected as a product outcome; unresolved overall targets
 * route to repair, a verified candidate is the only thing persisted, and the
 * automatic policy is bounded. Offline; no provider call.
 */
import { describe, expect, it } from "vitest";
import { segmentAnswer } from "../anchors";
import { GOLDEN_V4_CASES } from "../golden/v4-cases";
import {
	assessCandidate,
	buildRepairPrompt,
	buildVerifierPrompt,
	mergeRepairedEntities,
	RESOLUTION_CASE_STATUSES,
	RESOLUTION_POLICY,
	repairResultSchemaFor,
	SENTIMENT_VERIFIER_VERSION,
	VERIFIER_ISSUE_CODES,
	verifierIssuesToTargets,
	verifierResultSchemaFor,
} from "../resolution";
import { type SentimentCandidate, type SentimentClassificationResult, toClassificationResult } from "../types";

const brand: SentimentCandidate = { key: "brand", entityType: "brand", competitorId: null, name: "Arvo", aliases: [] };
const BELTRA = "b64b96f5-3bbd-4e42-a5ea-f30821cb9f8c";
const beltra: SentimentCandidate = {
	key: BELTRA,
	entityType: "competitor",
	competitorId: BELTRA,
	name: "Beltra",
	aliases: [],
};
const answer = "Arvo offers a solid service.\n\nBeltra is cheap.";
const cite = (anchorId: string, polarity: "positive" | "negative" | "neutral") => ({ anchorId, polarity });
const aspectPositive = (key: "price" | "coverage" | "service" | "other", score: number, ...ids: string[]) => ({
	key,
	...positive(score, ...ids),
});
const positive = (score: number, ...ids: string[]) => ({
	category: "positive" as const,
	score,
	confidence: 0.9,
	evidence: ids.map((i) => cite(i, "positive")),
});

describe("V5-ERC-001 the automatic resolution policy is bounded and explicit", () => {
	it("five paid calls, $0.15, one initial classification, aspects never trigger repair", () => {
		expect(RESOLUTION_POLICY).toMatchObject({ maxPaidCalls: 5, maxCostUsd: 0.15, maxInitialClassifications: 1 });
		expect(Object.isFrozen(RESOLUTION_POLICY)).toBe(true);
		expect([...RESOLUTION_CASE_STATUSES]).toEqual([
			"open",
			"repairing",
			"verifying",
			"retry_wait",
			"awaiting_review",
			"awaiting_reconciliation",
			"resolved",
		]);
		expect(SENTIMENT_VERIFIER_VERSION).toBe("sent-verifier-v1");
	});
});

describe("V5-ERC-002 assessCandidate routes instead of rejecting", () => {
	it("valid overall + invalid optional aspect → accepted entity, filtered claim, no unresolved target", () => {
		const a = assessCandidate(
			{
				entities: [
					{ key: "brand", ...positive(75, "s0001"), aspects: [{ key: "price", ...positive(70, "s0002") }] },
					{ key: BELTRA, ...positive(75, "s0002"), aspects: [] },
				],
			},
			{ answerBody: answer, candidates: [brand, beltra] },
		);
		expect(a.contractDefect).toBeNull();
		expect(a.unresolved).toEqual([]);
		expect(a.entities.map((e) => e.key)).toEqual(["brand", BELTRA]);
		expect(a.filteredClaims).toEqual([
			{ entityKey: "brand", aspectKey: "price", code: "evidence-entity-unbound", anchorIds: ["s0002"] },
		]);
	});

	it("invalid overall (foreign-only) → that entity becomes an unresolved target; the other entity is accepted", () => {
		const a = assessCandidate(
			{
				entities: [
					{ key: "brand", ...positive(75, "s0002"), aspects: [] },
					{ key: BELTRA, ...positive(75, "s0002"), aspects: [] },
				],
			},
			{ answerBody: answer, candidates: [brand, beltra] },
		);
		expect(a.entities.map((e) => e.key)).toEqual([BELTRA]);
		expect(a.unresolved).toEqual([
			{
				entityKey: "brand",
				reason: "evidence-entity-unbound",
				aspectKey: null,
				anchorId: "s0002",
				source: "deterministic",
			},
		]);
	});

	it("missing entity → unresolved target `missing-entity`; nothing is invented for it", () => {
		const a = assessCandidate(
			{ entities: [{ key: BELTRA, ...positive(75, "s0002"), aspects: [] }] },
			{ answerBody: answer, candidates: [brand, beltra] },
		);
		expect(a.unresolved).toEqual([
			{ entityKey: "brand", reason: "missing-entity", aspectKey: null, anchorId: null, source: "deterministic" },
		]);
	});

	it("entity swap (996deaca stand-in) → both entities unresolved, none accepted", () => {
		const swap = GOLDEN_V4_CASES.find((c) => c.id === "v4-swap-de");
		if (!swap) throw new Error("golden missing");
		const a = assessCandidate(toClassificationResult(swap.result as never), {
			answerBody: swap.answer,
			candidates: swap.candidates,
		});
		expect(a.entities).toEqual([]);
		expect(a.unresolved.map((u) => u.reason)).toEqual(["evidence-entity-unbound", "evidence-entity-unbound"]);
	});

	it("contract corruption (unknown entity key, duplicate entity) → contractDefect, not a repair target", () => {
		expect(
			assessCandidate(
				{ entities: [{ key: "ARAG", ...positive(75, "s0001"), aspects: [] }] },
				{ answerBody: answer, candidates: [brand, beltra] },
			).contractDefect,
		).toEqual({ code: "unknown-entity" });
		expect(
			assessCandidate(
				{
					entities: [
						{ key: "brand", ...positive(75, "s0001"), aspects: [] },
						{ key: "brand", ...positive(75, "s0001"), aspects: [] },
						{ key: BELTRA, ...positive(75, "s0002"), aspects: [] },
					],
				},
				{ answerBody: answer, candidates: [brand, beltra] },
			).contractDefect,
		).toEqual({ code: "duplicate-entity" });
	});
});

describe("V5-ERC-003 repair and verifier contracts", () => {
	const anchors = segmentAnswer(answer).map((a) => a.id);

	it("the repair schema binds exactly the unresolved keys and the answer's anchors; web search is off by contract", () => {
		const schema = repairResultSchemaFor(anchors, ["brand"]);
		expect(schema.safeParse({ entities: [{ key: "brand", ...positive(75, "s0001"), aspects: [] }] }).success).toBe(
			true,
		);
		expect(schema.safeParse({ entities: [{ key: BELTRA, ...positive(75, "s0002"), aspects: [] }] }).success).toBe(
			false,
		);
		expect(schema.safeParse({ entities: [{ key: "brand", ...positive(75, "s0042"), aspects: [] }] }).success).toBe(
			false,
		);
		const prompt = buildRepairPrompt({
			answerBody: answer,
			candidates: [brand, beltra],
			targets: [
				{
					entityKey: "brand",
					reason: "evidence-entity-unbound",
					aspectKey: null,
					anchorId: "s0002",
					source: "deterministic",
				},
			],
		});
		expect(prompt).toMatch(/^You are repairing/);
		expect(prompt).toContain('key "brand"');
		expect(prompt).toContain("evidence-entity-unbound");
		expect(prompt).not.toContain("web search");
	});

	it("the verifier schema is accept-or-bounded-issues with enumerated codes, keys and targets", () => {
		expect([...VERIFIER_ISSUE_CODES].sort()).toEqual(
			[
				"aspect-misrouted",
				"category-mismatch",
				"entity-misattribution",
				"mixed-semantics",
				"polarity-mismatch",
				"unsupported-evaluation",
			].sort(),
		);
		const schema = verifierResultSchemaFor(anchors, ["brand", BELTRA]);
		expect(schema.safeParse({ verdict: "accept", issues: [] }).success).toBe(true);
		expect(
			schema.safeParse({
				verdict: "reject",
				issues: [{ entityKey: "brand", target: "overall", code: "entity-misattribution", anchorId: "s0002" }],
			}).success,
		).toBe(true);
		expect(
			schema.safeParse({
				verdict: "reject",
				issues: [{ entityKey: "ARAG", target: "overall", code: "entity-misattribution", anchorId: null }],
			}).success,
		).toBe(false);
		expect(
			schema.safeParse({
				verdict: "reject",
				issues: [{ entityKey: "brand", target: "overall", code: "hallucinated", anchorId: null }],
			}).success,
		).toBe(false);
		expect(
			schema.safeParse({
				verdict: "accept",
				issues: [{ entityKey: "brand", target: "overall", code: "polarity-mismatch", anchorId: null }],
			}).success,
		).toBe(false);
		const prompt = buildVerifierPrompt({
			answerBody: answer,
			candidates: [brand, beltra],
			candidate: {
				entities: [
					{ key: "brand", ...positive(75, "s0001"), aspects: [] },
					{ key: BELTRA, ...positive(75, "s0002"), aspects: [] },
				],
			},
		});
		expect(prompt).toMatch(/^You are an independent verifier/);
		expect(prompt).not.toContain("web search");
	});

	it("verifier issues map to entity repair targets; aspect issues target the entity, never a Neutral placeholder", () => {
		expect(
			verifierIssuesToTargets([
				{ entityKey: "brand", target: "price", code: "aspect-misrouted", anchorId: null },
				{ entityKey: "brand", target: "overall", code: "polarity-mismatch", anchorId: "s0001" },
				{ entityKey: BELTRA, target: "overall", code: "entity-misattribution", anchorId: "s0002" },
			]),
		).toEqual([
			{
				entityKey: "brand",
				reason: "verifier:aspect-misrouted",
				aspectKey: "price",
				anchorId: null,
				source: "verifier",
			},
			{
				entityKey: "brand",
				reason: "verifier:polarity-mismatch",
				aspectKey: null,
				anchorId: "s0001",
				source: "verifier",
			},
			{
				entityKey: BELTRA,
				reason: "verifier:entity-misattribution",
				aspectKey: null,
				anchorId: "s0002",
				source: "verifier",
			},
		]);
	});

	it("merging a repair replaces only the targeted entities and keeps accepted ones byte-identical", () => {
		const candidate: SentimentClassificationResult = {
			entities: [
				{ key: "brand", ...positive(75, "s0002"), aspects: [] },
				{ key: BELTRA, ...positive(75, "s0002"), aspects: [{ key: "price", ...positive(80, "s0002") }] },
			],
		};
		const merged = mergeRepairedEntities(
			candidate,
			{ entities: [{ key: "brand", ...positive(70, "s0001"), aspects: [] }] },
			["brand"],
		);
		expect(merged.entities[0]).toEqual({ key: "brand", ...positive(70, "s0001"), aspects: [] });
		expect(merged.entities[1]).toEqual(candidate.entities[1]);
		expect(() =>
			mergeRepairedEntities(candidate, { entities: [{ key: BELTRA, ...positive(70, "s0002"), aspects: [] }] }, [
				"brand",
			]),
		).toThrow(/not a repair target/);
	});
});
