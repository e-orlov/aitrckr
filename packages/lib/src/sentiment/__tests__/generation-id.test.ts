/**
 * The provider's opaque generation id is the only handle an operator has to
 * reconcile a paid call against the provider's own ledger. It must survive
 * the successful path end to end — classifier, job outcome, canary outcome
 * and report — and a canary must not accept a paid answer it cannot
 * reconcile. Nothing here is written to the database: the id lives in the
 * bounded runtime and canary audit trail.
 */
import { describe, expect, it, vi } from "vitest";
import type { Provider } from "../../providers/types";
import { SENTIMENT_EVIDENCE_VERSION } from "../anchors";
import {
	runSentimentCanary,
	type SentimentCanaryContract,
	type SentimentCanaryReport,
	sentimentCanaryBodyDigest,
	sentimentCanaryInputDigests,
} from "../canary";
import { classifySentiment } from "../classifier";
import type { DetectableEntity } from "../detector";
import { runSentimentJob, type SentimentJobDeps } from "../job";
import { candidatesFromMentions, type StoredMention, type StoredRunForSentiment } from "../store";
import {
	SENTIMENT_CLASSIFIER_VERSION,
	SENTIMENT_DETECTOR_VERSION,
	SENTIMENT_MODEL,
	SENTIMENT_TAXONOMY_VERSION,
	type SentimentAnalysisStatus,
} from "../types";
import { resolutionFakes } from "./resolution-fakes";

const RUN = "5e970008-0000-4000-8000-000000000001";
const ANSWER = "Arvo ist ein solider Rechtsschutzversicherer. Beltra wird nur genannt.";
const run: StoredRunForSentiment = {
	id: RUN,
	promptId: "5e970008-0000-4000-8000-000000000002",
	brandId: "arvo",
	provider: "openrouter",
	model: "chatgpt",
	answerBody: ANSWER,
	organizationId: "default",
};
const entities: DetectableEntity[] = [
	{ key: "brand", entityType: "brand", competitorId: null, name: "Arvo", aliases: [], domains: [] },
	{ key: "c-beltra", entityType: "competitor", competitorId: "c-beltra", name: "Beltra", aliases: [], domains: [] },
];
const mentions: StoredMention[] = [
	{ id: "m1", key: "brand", entityType: "brand", competitorId: null, entityName: "Arvo" },
	{ id: "m2", key: "c-beltra", entityType: "competitor", competitorId: "c-beltra", entityName: "Beltra" },
];
const candidates = candidatesFromMentions(mentions, entities);
const usage = {
	inputTokens: 6410,
	outputTokens: 812,
	reasoningTokens: 300,
	costUsd: 0.0234,
	webSearchRequests: 1,
	webSearchRequestsConflict: false,
};
const request = {
	model: SENTIMENT_MODEL,
	webSearch: true,
	maxToolCalls: 1,
	maxOutputTokens: 8000,
	strictJsonSchema: true,
	requireParameters: true,
};
const answered = {
	entities: [
		{
			key: "brand",
			score: 70,
			category: "positive",
			confidence: 0.9,
			evidence: [{ anchorId: "s0001", polarity: "positive" }],
			aspects: [],
		},
		{
			key: "c-beltra",
			score: 50,
			category: "neutral",
			confidence: 0.9,
			evidence: [{ anchorId: "s0002", polarity: "neutral" }],
			aspects: [],
		},
	],
};

/** A provider answering the valid anchored classification with the given generation id (or none). */
function providerWith(generationId: unknown): Provider {
	return {
		id: "openrouter",
		runStructuredResearch: vi.fn(async ({ schema }: { schema: { parse: (v: unknown) => unknown } }) => ({
			object: schema.parse(answered),
			modelVersion: SENTIMENT_MODEL,
			usage,
			request,
			...(generationId === undefined ? {} : { generationId }),
		})),
	} as unknown as Provider;
}

function fakes(provider: Provider) {
	const resolution = resolutionFakes();
	const deps: SentimentJobDeps = {
		loadRun: vi.fn(async () => run),
		loadEntities: vi.fn(async () => entities),
		loadDetection: vi.fn(async () => ({ status: "mentions", mentionCount: 2 }) as never),
		loadMentions: vi.fn(async () => mentions),
		loadAnalysisState: vi.fn(async () => null),
		ensureAnalysis: vi.fn(
			async () =>
				({
					id: "a1",
					status: "pending" as SentimentAnalysisStatus,
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
		markAnalysis: vi.fn(async () => true),
		persist: vi.fn(async () => undefined),
		recordUsage: vi.fn(async () => undefined),
		resolveProvider: () => resolution.phasesProvider(provider),
		resolutionPolicy: { backoffBaseMs: 1, backoffMaxMs: 2 },
		...resolution.deps,
	};
	return deps;
}

const contract: SentimentCanaryContract = {
	runId: RUN,
	promptId: run.promptId,
	brandId: run.brandId,
	answerBodySha256: sentimentCanaryBodyDigest(ANSWER),
	entities: [
		{ key: "brand", entityType: "brand" },
		{ key: "c-beltra", entityType: "competitor" },
	],
	...sentimentCanaryInputDigests({ answerBody: ANSWER, candidates }),
	classifierVersion: SENTIMENT_CLASSIFIER_VERSION,
	taxonomyVersion: SENTIMENT_TAXONOMY_VERSION,
	evidenceVersion: SENTIMENT_EVIDENCE_VERSION,
	detectorVersion: SENTIMENT_DETECTOR_VERSION,
	provider: "openrouter",
	model: SENTIMENT_MODEL,
};
const fast = { deadlineMs: 1000, watchdogMs: 2000 };
const codes = (report: SentimentCanaryReport) =>
	report.verdict.status === "reject" ? report.verdict.reasons.map((r) => r.code) : [];
const payload = {
	promptRunId: RUN,
	classifierVersion: SENTIMENT_CLASSIFIER_VERSION,
	taxonomyVersion: SENTIMENT_TAXONOMY_VERSION,
};

describe("H1 the generation id survives the successful path", () => {
	it("the classifier returns the provider's safe generation id", async () => {
		const result = await classifySentiment(
			{ answerBody: ANSWER, candidates },
			{ resolveProvider: () => providerWith("gen-success-001") },
		);
		expect(result.generationId).toBe("gen-success-001");
	});

	it("a classified job outcome carries the generation id", async () => {
		const outcome = await runSentimentJob(payload, fakes(providerWith("gen-success-001")));
		expect(outcome).toMatchObject({ status: "classified", entities: 2, generationId: "gen-success-001" });
	});

	it("an accepted canary report carries the generation id in its outcome", async () => {
		const report = await runSentimentCanary({ contract, deps: fakes(providerWith("gen-success-001")), ...fast });
		expect(report.verdict).toEqual({ status: "accept" });
		expect(report.outcome).toMatchObject({ status: "classified", generationId: "gen-success-001" });
		expect(JSON.stringify(report)).not.toContain("Rechtsschutzversicherer");
	});

	it("a canary never accepts a paid answer it cannot reconcile: no generation id or an unsafe one is a rejection", async () => {
		for (const generationId of [undefined, null, "", `gen ${"x".repeat(10)}`, "y".repeat(65), 42]) {
			const deps = fakes(providerWith(generationId));
			const report = await runSentimentCanary({ contract, deps, ...fast });
			expect(codes(report), JSON.stringify(generationId)).toEqual(["generation-id-missing"]);
			// Decided at the persistence boundary like every other post-call rejection: nothing is written.
			expect(report.outcome).toMatchObject({ status: "error", code: "canary-contract" });
			expect(deps.persist).not.toHaveBeenCalled();
			expect(deps.markAnalysis).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ status: "failed" }));
			expect(JSON.stringify(report)).not.toMatch(/gen x|yyyyy/);
		}
	});
});
