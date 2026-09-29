/**
 * One authorized canary attempt per run. Only a run that has never been
 * attempted — no analysis row, or a pending row with zero attempts and zero
 * observations — may reach the provider boundary; every other state refuses
 * before any request, and a second invocation under the same contract after
 * a provider failure never calls the provider again.
 */
import { describe, expect, it, vi } from "vitest";
import { type Provider, StructuredResearchRequestError } from "../../providers/types";
import { SENTIMENT_EVIDENCE_VERSION } from "../anchors";
import {
	inspectSentimentCanaryRunState,
	parseSentimentCanaryContract,
	runSentimentCanary,
	type SentimentCanaryReport,
	sentimentCanaryBodyDigest,
	sentimentCanaryInputDigests,
} from "../canary";
import type { DetectableEntity } from "../detector";
import type { SentimentJobDeps } from "../job";
import {
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
const fast = { deadlineMs: 1000, watchdogMs: 2000 };

/**
 * A stateful fake of the analysis row: claim increments attempts, terminal
 * marks change the status, persist counts observations — the way the store
 * behaves, so a second invocation sees what the first one left behind.
 */
function statefulStore(provider: Provider, initial: StoredAnalysisState | null) {
	let analysis = initial ? { ...initial } : null;
	let generation = 0;
	const persist = vi.fn(async (args: { classification: { entities: unknown[] } }) => {
		if (analysis) {
			analysis.status = "completed";
			analysis.observations = args.classification.entities.length;
		}
	});
	const recordUsage = vi.fn(async () => undefined);
	const resolution = resolutionFakes();
	const deps: SentimentJobDeps = {
		loadRun: vi.fn(async () => run),
		loadEntities: vi.fn(async () => roster),
		loadDetection: vi.fn(async () => ({ status: "mentions", mentionCount: 2 }) as never),
		loadMentions: vi.fn(async () => mentions),
		loadAnalysisState: vi.fn(async () => (analysis ? { ...analysis } : null)),
		ensureAnalysis: vi.fn(async () => {
			analysis ??= { status: "pending", attempts: 0, observations: 0 };
			return {
				id: "a1",
				status: analysis.status,
				classifierVersion: SENTIMENT_CLASSIFIER_VERSION,
				taxonomyVersion: SENTIMENT_TAXONOMY_VERSION,
				inputHash: null,
			} as never;
		}),
		claimAnalysis: vi.fn(async () => {
			if (!analysis) throw new Error("no analysis row");
			analysis.attempts += 1;
			analysis.status = "processing";
			generation += 1;
			return { claimed: true as const, attempts: analysis.attempts, claim: { analysisId: "a1", generation } };
		}),
		markAnalysis: vi.fn(async (_claim: unknown, patch: { status?: SentimentAnalysisStatus }) => {
			if (analysis && patch.status) analysis.status = patch.status;
			return true;
		}),
		persist,
		recordUsage,
		resolveProvider: () => resolution.phasesProvider(provider),
		resolutionPolicy: { backoffBaseMs: 1, backoffMaxMs: 2 },
		...resolution.deps,
	};
	return { deps, persist, recordUsage, state: () => (analysis ? { ...analysis } : null) };
}

const failingProvider = () =>
	({
		id: "openrouter",
		runStructuredResearch: vi.fn(async () => {
			throw new StructuredResearchRequestError({
				provider: "openrouter",
				httpStatus: 503,
				errorType: "provider_overloaded",
				structured: true,
				carriesOutput: false,
				retryAfterMs: null,
				message: "OpenRouter API error (503): upstream overloaded",
			});
		}),
	}) as unknown as Provider;

const codes = (report: SentimentCanaryReport) =>
	report.verdict.status === "reject" ? report.verdict.reasons.map((r) => r.code) : [];

describe("G1: only a never-attempted run is pristine", () => {
	it.each<[string, StoredAnalysisState | null, boolean]>([
		["no analysis row", null, true],
		["pending / 0 attempts / 0 observations", { status: "pending", attempts: 0, observations: 0 }, true],
		["pending with a prior attempt", { status: "pending", attempts: 1, observations: 0 }, false],
		["processing", { status: "processing", attempts: 1, observations: 0 }, false],
		["failed after one attempt", { status: "failed", attempts: 1, observations: 0 }, false],
		["failed without a counted attempt", { status: "failed", attempts: 0, observations: 0 }, false],
		["completed", { status: "completed", attempts: 1, observations: 2 }, false],
		["no_mentions", { status: "no_mentions", attempts: 0, observations: 0 }, false],
		["pending with observations", { status: "pending", attempts: 0, observations: 1 }, false],
	])("%s → pristine=%s", async (_label, state, pristine) => {
		const provider = failingProvider();
		const { deps, persist, recordUsage, state: stateAfter } = statefulStore(provider, state);
		expect(await inspectSentimentCanaryRunState(RUN, deps)).toEqual({ analysis: state, pristine });
		const report = await runSentimentCanary({ contract, deps, ...fast });
		if (pristine) {
			expect(report.attempts).toBe(1);
			expect(report.providerCalls).toBe(1);
			return;
		}
		expect(report.preflight.status).toBe("refused");
		expect(codes(report)).toEqual(["run-not-pristine"]);
		expect(report.verdict).toEqual({
			status: "reject",
			reasons: [
				{
					code: "run-not-pristine",
					detail: `${state?.status}/${state?.attempts}/${state?.observations}`,
				},
			],
		});
		expect(report.attempts).toBe(0);
		expect(report.providerCalls).toBe(0);
		expect(provider.runStructuredResearch).not.toHaveBeenCalled();
		expect(persist).not.toHaveBeenCalled();
		expect(recordUsage).not.toHaveBeenCalled();
		expect(deps.claimAnalysis).not.toHaveBeenCalled();
		expect(stateAfter()).toEqual(state);
	});

	it("a second invocation under the same contract after a provider failure never reaches the provider again", async () => {
		const first = failingProvider();
		const store = statefulStore(first, { status: "pending", attempts: 0, observations: 0 });
		const one = await runSentimentCanary({ contract, deps: store.deps, ...fast });
		expect(one.preflight).toEqual({ status: "passed" });
		expect(one.providerCalls).toBe(1);
		expect(first.runStructuredResearch).toHaveBeenCalledTimes(1);
		expect(codes(one)).toEqual(["provider-error"]);
		expect(store.state()).toEqual({ status: "pending_resolution", attempts: 1, observations: 0 });
		// The provider failure was unpaid: nothing attributed.
		expect(store.recordUsage).toHaveBeenCalledTimes(0);

		const second = failingProvider();
		const again = await runSentimentCanary({
			contract,
			deps: { ...store.deps, resolveProvider: () => second },
			...fast,
		});
		expect(again.preflight.status).toBe("refused");
		expect(codes(again)).toEqual(["run-not-pristine"]);
		expect(again.attempts).toBe(0);
		expect(again.providerCalls).toBe(0);
		expect(second.runStructuredResearch).not.toHaveBeenCalled();
		expect(store.persist).not.toHaveBeenCalled();
		expect(store.recordUsage).toHaveBeenCalledTimes(0);
		expect(store.state()).toEqual({ status: "pending_resolution", attempts: 1, observations: 0 });
		expect(await inspectSentimentCanaryRunState(RUN, store.deps)).toEqual({
			analysis: { status: "pending_resolution", attempts: 1, observations: 0 },
			pristine: false,
		});
	});

	it("the refusal detail carries only structural values", async () => {
		const { deps } = statefulStore(failingProvider(), { status: "failed", attempts: 1, observations: 0 });
		const report = await runSentimentCanary({ contract, deps, ...fast });
		expect(JSON.stringify(report)).not.toMatch(/ARAG|WGV|upstream|Bearer|sk-or-/);
	});
});
