/**
 * Candidate order must be a property of the entities, never of how their
 * mention rows happen to be stored. Two environments holding the same
 * logical data (same body, same entity keys/names/aliases, same detected_at)
 * but different mention-row UUIDs must produce the same candidate order, the
 * same outbound prompt, the same digests and byte-identical contracts.
 */
import { describe, expect, it, vi } from "vitest";
import {
	inspectSentimentCanaryRun,
	parseSentimentCanaryContract,
	preflightSentimentCanary,
	runSentimentCanary,
	sentimentCanaryInputDigests,
} from "../canary";
import { sentimentInputHash } from "../classifier";
import { type DetectableEntity, detectEntityMentions } from "../detector";
import type { SentimentJobDeps } from "../job";
import { buildSentimentPrompt } from "../prompt";
import { candidatesFromMentions, type StoredMention, type StoredRunForSentiment } from "../store";
import type { SentimentCandidate } from "../types";

const RUN = "bf1347c3-7161-457c-91d6-0173d601659e";
const WGV = "b64b96f5-3bbd-4e42-a5ea-f30821cb9f8c";
const HUK = "c8c99a71-eaa9-46a5-9e48-ede16f090241";
const ANSWER = "ARAG Aktiv Komfort ist stark. WGV ist günstig. HUK-COBURG ist bekannt.";
const run: StoredRunForSentiment = {
	id: RUN,
	promptId: "e32b0973-3b13-46c2-84dc-f29a6e5c41a2",
	brandId: "arag",
	provider: "openrouter",
	model: "chatgpt",
	answerBody: ANSWER,
	organizationId: "default",
};
const roster: DetectableEntity[] = [
	{ key: "brand", entityType: "brand", competitorId: null, name: "ARAG", aliases: [], domains: ["arag.de"] },
	{ key: HUK, entityType: "competitor", competitorId: HUK, name: "HUK-COBURG", aliases: ["HUK"], domains: ["huk.de"] },
	{ key: WGV, entityType: "competitor", competitorId: WGV, name: "WGV", aliases: [], domains: ["wgv.de"] },
];
const logical = {
	brand: { key: "brand", entityType: "brand" as const, competitorId: null, entityName: "ARAG" },
	wgv: { key: WGV, entityType: "competitor" as const, competitorId: WGV, entityName: "WGV" },
	huk: { key: HUK, entityType: "competitor" as const, competitorId: HUK, entityName: "HUK-COBURG" },
};

/**
 * What `ORDER BY detected_at, id` yields for one backfill transaction: every
 * row shares detected_at, so the row UUID decides. The two environments
 * below store the same three logical mentions under UUIDs that sort in
 * opposite directions.
 */
const DETECTED_AT = "2026-09-13T18:07:42.696099Z";
function storedRows(ids: { brand: string; wgv: string; huk: string }): StoredMention[] {
	const rows = [
		{ id: ids.brand, detectedAt: DETECTED_AT, ...logical.brand },
		{ id: ids.wgv, detectedAt: DETECTED_AT, ...logical.wgv },
		{ id: ids.huk, detectedAt: DETECTED_AT, ...logical.huk },
	];
	rows.sort((a, b) => (a.detectedAt < b.detectedAt ? -1 : a.detectedAt > b.detectedAt ? 1 : a.id < b.id ? -1 : 1));
	return rows.map(({ detectedAt: _detectedAt, ...row }) => row);
}
const ENV_A = storedRows({
	brand: "00000000-0000-4000-8000-000000000001",
	wgv: "00000000-0000-4000-8000-000000000002",
	huk: "00000000-0000-4000-8000-000000000003",
});
const ENV_B = storedRows({
	brand: "00000000-0000-4000-8000-000000000003",
	wgv: "00000000-0000-4000-8000-000000000002",
	huk: "00000000-0000-4000-8000-000000000001",
});

function depsFor(mentions: StoredMention[], entities: DetectableEntity[] = roster): SentimentJobDeps {
	return {
		loadRun: vi.fn(async () => run),
		loadEntities: vi.fn(async () => entities),
		loadDetection: vi.fn(async () => ({ status: "mentions", mentionCount: mentions.length }) as never),
		loadMentions: vi.fn(async () => mentions),
		loadAnalysisState: vi.fn(async () => null),
	};
}

const keysOf = (candidates: SentimentCandidate[]) => candidates.map((c) => c.key);

describe("canonical candidate order", () => {
	it("the stored order of the two environments really differs (fixture sanity)", () => {
		expect(ENV_A.map((m) => m.key)).toEqual(["brand", WGV, HUK]);
		expect(ENV_B.map((m) => m.key)).toEqual([HUK, WGV, "brand"]);
	});

	it("two environments with the same logical mentions produce the same candidate order", () => {
		const a = candidatesFromMentions(ENV_A, roster);
		const b = candidatesFromMentions(ENV_B, roster);
		expect(keysOf(a)).toEqual(keysOf(b));
		expect(keysOf(a)[0]).toBe("brand");
	});

	it("own brand first, then competitors by immutable key ascending, whatever the input order", () => {
		const shuffled: StoredMention[] = [logical.wgv, logical.huk, logical.brand].map((m) => ({ id: "x", ...m }));
		const reversed: StoredMention[] = [...shuffled].reverse();
		for (const input of [shuffled, reversed, ENV_A, ENV_B]) {
			expect(keysOf(candidatesFromMentions(input, roster))).toEqual(["brand", WGV, HUK]);
		}
	});

	it("the same logical candidates render the same prompt and the same prompt digest", () => {
		const a = candidatesFromMentions(ENV_A, roster);
		const b = candidatesFromMentions(ENV_B, roster);
		expect(buildSentimentPrompt({ answerBody: ANSWER, candidates: a })).toBe(
			buildSentimentPrompt({ answerBody: ANSWER, candidates: b }),
		);
		expect(sentimentCanaryInputDigests({ answerBody: ANSWER, candidates: a })).toEqual(
			sentimentCanaryInputDigests({ answerBody: ANSWER, candidates: b }),
		);
		// The prompt itself is canonical even when a caller hands over candidates in another order.
		expect(buildSentimentPrompt({ answerBody: ANSWER, candidates: [...a].reverse() })).toBe(
			buildSentimentPrompt({ answerBody: ANSWER, candidates: a }),
		);
	});

	it("the direct detector path and the stored-mentions path agree", () => {
		const detected = detectEntityMentions(ANSWER, roster);
		const fromDetector = candidatesFromMentions(
			detected.map((m) => ({ id: "", ...m })),
			roster,
		);
		const fromStore = candidatesFromMentions(ENV_B, roster);
		expect(keysOf(fromDetector)).toEqual(keysOf(fromStore));
		expect(sentimentCanaryInputDigests({ answerBody: ANSWER, candidates: fromDetector })).toEqual(
			sentimentCanaryInputDigests({ answerBody: ANSWER, candidates: fromStore }),
		);
	});

	it("inspect yields byte-identical contracts for the two environments and canonical entities[]", async () => {
		const a = await inspectSentimentCanaryRun(RUN, depsFor(ENV_A));
		const b = await inspectSentimentCanaryRun(RUN, depsFor(ENV_B));
		expect(JSON.stringify(a, null, 2)).toBe(JSON.stringify(b, null, 2));
		expect(a?.entities).toEqual([
			{ key: "brand", entityType: "brand" },
			{ key: WGV, entityType: "competitor" },
			{ key: HUK, entityType: "competitor" },
		]);
		const contract = parseSentimentCanaryContract(a);
		// A contract frozen in one environment preflights cleanly in the other.
		expect(await preflightSentimentCanary(contract, depsFor(ENV_B))).toEqual([]);
		expect(await preflightSentimentCanary(contract, depsFor(ENV_A))).toEqual([]);
	});

	it("parsing a contract canonicalizes entities[] so the frozen bytes do not depend on the author's order", () => {
		const description = { ...JSON.parse(JSON.stringify(inspectFixture())) };
		const reordered = { ...description, entities: [...description.entities].reverse() };
		expect(parseSentimentCanaryContract(reordered)).toEqual(parseSentimentCanaryContract(description));
	});

	it("sentimentInputHash for the previous logical input is unchanged", () => {
		// Frozen on 2026-09-13 from the pre-fix code for exactly this input; the canonical hash never depended on order.
		const FROZEN = "5accd20a251c8d72595d5069f4c1082fa81bf7a0899800ea5ec63da9ff89ebcf";
		const candidates = candidatesFromMentions(ENV_A, roster);
		expect(sentimentInputHash(ANSWER, candidates)).toBe(FROZEN);
		expect(sentimentInputHash(ANSWER, candidatesFromMentions(ENV_B, roster))).toBe(FROZEN);
		expect(sentimentInputHash(ANSWER, [...candidates].reverse())).toBe(FROZEN);
	});

	it("a rename or an alias still changes both digests; a real entity-set change still blocks the call", async () => {
		const base = sentimentCanaryInputDigests({ answerBody: ANSWER, candidates: candidatesFromMentions(ENV_A, roster) });
		const renamed = roster.map((e) => (e.key === WGV ? { ...e, name: "WGV Versicherung" } : e));
		const aliased = roster.map((e) => (e.key === HUK ? { ...e, aliases: ["HUK", "HUK24"] } : e));
		for (const changed of [renamed, aliased]) {
			const digests = sentimentCanaryInputDigests({
				answerBody: ANSWER,
				candidates: candidatesFromMentions(ENV_A, changed),
			});
			expect(digests.classifierInputHash).not.toBe(base.classifierInputHash);
			expect(digests.providerPromptSha256).not.toBe(base.providerPromptSha256);
		}
		const contract = parseSentimentCanaryContract(await inspectSentimentCanaryRun(RUN, depsFor(ENV_A)));
		const provider = { id: "openrouter", runStructuredResearch: vi.fn() } as never;
		const report = await runSentimentCanary({
			contract,
			deps: { ...depsFor(ENV_A.slice(0, 2)), resolveProvider: () => provider },
			deadlineMs: 500,
			watchdogMs: 1000,
		});
		expect(report.attempts).toBe(0);
		expect(report.providerCalls).toBe(0);
		expect(report.verdict.status).toBe("reject");
	});
});

function inspectFixture() {
	return {
		runId: RUN,
		promptId: run.promptId,
		brandId: "arag",
		answerBodySha256: "0".repeat(64),
		entities: [
			{ key: "brand", entityType: "brand" },
			{ key: WGV, entityType: "competitor" },
			{ key: HUK, entityType: "competitor" },
		],
		classifierInputHash: "1".repeat(64),
		providerPromptSha256: "2".repeat(64),
		classifierVersion: "sent-classifier-v2",
		taxonomyVersion: "sent-aspects-v1",
		evidenceVersion: "sent-evidence-v1",
		provider: "openrouter",
		model: "openai/gpt-5-mini",
	};
}
