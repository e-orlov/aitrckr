/**
 * The right to make the one canary call must be decided by an atomic claim,
 * not by the read-only preflight. Two invocations that both pass preflight on
 * a pristine run race for the claim; exactly one may reach the provider, and
 * the loser must write nothing — not even an attempt — before refusing.
 * Barriers make the interleaving deterministic: A claims and fails at the
 * provider before B is allowed to claim.
 */
import { describe, expect, it, vi } from "vitest";
import type { Provider } from "../../providers/types";
import { SENTIMENT_EVIDENCE_VERSION } from "../anchors";
import {
	parseSentimentCanaryContract,
	runSentimentCanary,
	type SentimentCanaryReport,
	sentimentCanaryBodyDigest,
	sentimentCanaryInputDigests,
} from "../canary";
import type { DetectableEntity } from "../detector";
import type { SentimentJobDeps } from "../job";
import {
	type ClaimOutcome,
	candidatesFromMentions,
	type StoredAnalysisState,
	type StoredMention,
	type StoredRunForSentiment,
} from "../store";
import {
	SENTIMENT_CLASSIFIER_VERSION,
	SENTIMENT_DETECTOR_VERSION,
	SENTIMENT_TAXONOMY_VERSION,
	type SentimentAnalysisStatus,
} from "../types";
import { resolutionFakes } from "./resolution-fakes";

const RUN = "bf1347c3-7161-457c-91d6-0173d601659e";
const WGV = "b64b96f5-3bbd-4e42-a5ea-f30821cb9f8c";
const ANSWER = "ARAG Aktiv Komfort ist stark. WGV ist günstig.";
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
	{ key: WGV, entityType: "competitor", competitorId: WGV, name: "WGV", aliases: [], domains: ["wgv.de"] },
];
const mentions: StoredMention[] = [
	{ id: "m1", key: "brand", entityType: "brand", competitorId: null, entityName: "ARAG" },
	{ id: "m2", key: WGV, entityType: "competitor", competitorId: WGV, entityName: "WGV" },
];
const contract = parseSentimentCanaryContract({
	runId: RUN,
	promptId: run.promptId,
	brandId: "arag",
	answerBodySha256: sentimentCanaryBodyDigest(ANSWER),
	entities: [
		{ key: "brand", entityType: "brand" },
		{ key: WGV, entityType: "competitor" },
	],
	...sentimentCanaryInputDigests({ answerBody: ANSWER, candidates: candidatesFromMentions(mentions, roster) }),
	classifierVersion: SENTIMENT_CLASSIFIER_VERSION,
	taxonomyVersion: SENTIMENT_TAXONOMY_VERSION,
	evidenceVersion: SENTIMENT_EVIDENCE_VERSION,
	detectorVersion: SENTIMENT_DETECTOR_VERSION,
	provider: "openrouter",
	model: "openai/gpt-5-mini",
});
const fast = { deadlineMs: 5000, watchdogMs: 10_000 };

function barrier() {
	let release: () => void = () => {};
	const wait = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { wait, release };
}

/**
 * One shared analysis row with the real claim semantics: the worker claim
 * (`allowFinished`) accepts pending/failed/finished rows and bumps attempts;
 * the canary-only pristine claim accepts exactly pending/0/0 with no
 * observations and writes nothing when it loses.
 */
function sharedRow(initial: StoredAnalysisState) {
	const row = { ...initial };
	let generation = 0;
	const usage: unknown[] = [];
	function claim(options: { allowFinished: boolean; pristineOnly?: boolean }): ClaimOutcome {
		const pristine = row.status === "pending" && row.attempts === 0 && row.observations === 0;
		const normal =
			row.status === "pending" ||
			row.status === "failed" ||
			(options.allowFinished && (row.status === "completed" || row.status === "no_mentions"));
		const eligible = options.pristineOnly ? pristine : normal;
		if (!eligible) return { claimed: false, status: row.status };
		row.attempts += 1;
		row.status = "processing";
		generation += 1;
		return { claimed: true, attempts: row.attempts, claim: { analysisId: "a1", generation } };
	}
	function deps(provider: Provider, gates: { beforeClaim?: Promise<void>; afterPreflight?: () => void } = {}) {
		const resolution = resolutionFakes();
		const d: SentimentJobDeps = {
			loadRun: vi.fn(async () => run),
			loadEntities: vi.fn(async () => roster),
			loadDetection: vi.fn(async () => ({ status: "mentions", mentionCount: 2 }) as never),
			loadMentions: vi.fn(async () => mentions),
			loadAnalysisState: vi.fn(async () => {
				const snapshot = { ...row };
				gates.afterPreflight?.();
				return snapshot;
			}),
			ensureAnalysis: vi.fn(
				async () =>
					({
						id: "a1",
						status: row.status,
						classifierVersion: SENTIMENT_CLASSIFIER_VERSION,
						taxonomyVersion: SENTIMENT_TAXONOMY_VERSION,
						inputHash: null,
					}) as never,
			),
			claimAnalysis: vi.fn(async (_id: string, options: { allowFinished: boolean; pristineOnly?: boolean }) => {
				await gates.beforeClaim;
				return claim(options);
			}),
			markAnalysis: vi.fn(async (_claim: unknown, patch: { status?: SentimentAnalysisStatus }) => {
				if (patch.status) row.status = patch.status;
				return true;
			}),
			persist: vi.fn(async () => {
				row.status = "completed";
				row.observations = 2;
			}),
			recordUsage: vi.fn(async (event: unknown) => {
				usage.push(event);
			}),
			resolveProvider: () => resolution.phasesProvider(provider),
			resolutionPolicy: { backoffBaseMs: 1, backoffMaxMs: 2 },
			...resolution.deps,
		};
		return d;
	}
	return { row, usage, deps };
}

const failingProvider = () =>
	({
		id: "openrouter",
		runStructuredResearch: vi.fn(async () => {
			throw new Error("OpenRouter API error (503): upstream unavailable");
		}),
	}) as unknown as Provider;

const codes = (report: SentimentCanaryReport) =>
	report.verdict.status === "reject" ? report.verdict.reasons.map((r) => r.code) : [];

describe("G3: the canary call is granted by an atomic pristine claim, not by preflight", () => {
	it("A and B both pass preflight on pending/0/0; A claims and fails at the provider; B must be refused at the claim without any write", async () => {
		const shared = sharedRow({ status: "pending", attempts: 0, observations: 0 });
		const bPreflightDone = barrier();
		const aFinished = barrier();

		const providerA = failingProvider();
		const providerB = failingProvider();
		const depsA = shared.deps(providerA, { beforeClaim: bPreflightDone.wait });
		const depsB = shared.deps(providerB, { beforeClaim: aFinished.wait, afterPreflight: bPreflightDone.release });

		const a = runSentimentCanary({ contract, deps: depsA, ...fast }).then((report) => {
			aFinished.release();
			return report;
		});
		const b = runSentimentCanary({ contract, deps: depsB, ...fast });
		const [reportA, reportB] = await Promise.all([a, b]);

		// Both invocations saw a pristine run before anyone claimed.
		expect(reportA.preflight).toEqual({ status: "passed" });
		expect(reportB.preflight).toEqual({ status: "passed" });

		// A: the one authorized attempt, spent on a provider failure.
		expect(providerA.runStructuredResearch).toHaveBeenCalledTimes(1);
		expect(reportA.providerCalls).toBe(1);
		expect(codes(reportA)).toEqual(["provider-error"]);

		// B: refused at the claim, nothing written, provider never touched.
		expect(providerB.runStructuredResearch).not.toHaveBeenCalled();
		expect(reportB.attempts).toBe(1);
		expect(reportB.providerCalls).toBe(0);
		expect(codes(reportB)).toEqual(["run-state-drift"]);
		expect(depsB.persist).not.toHaveBeenCalled();
		expect(depsB.markAnalysis).not.toHaveBeenCalled();
		expect(depsB.recordUsage).not.toHaveBeenCalled();

		// The row belongs to A's attempt only.
		expect(shared.row).toEqual({ status: "pending_resolution", attempts: 1, observations: 0 });
		// A's provider failure never received an answer: unpaid, nothing attributed.
		expect(shared.usage).toHaveLength(0);
		expect(JSON.stringify(reportB)).not.toMatch(/ARAG|WGV|upstream|Bearer|sk-or-/);
	});

	it("the canary claims in pristine-only mode; the worker's own claim semantics are not what grants the call", async () => {
		const shared = sharedRow({ status: "pending", attempts: 0, observations: 0 });
		const deps = shared.deps(failingProvider());
		await runSentimentCanary({ contract, deps, ...fast });
		expect(deps.claimAnalysis).toHaveBeenCalledWith("a1", expect.objectContaining({ pristineOnly: true }));
	});
});
