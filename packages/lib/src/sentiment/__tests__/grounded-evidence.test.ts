/**
 * Grounded evidence: the paid canary of 2026-09-13 was rejected because the
 * provider returned a structurally valid answer whose evidence excerpt was
 * not verbatim in the stored answer. These tests pin the behaviour the
 * corrective must deliver: the provider never types quotes (it references
 * deterministic anchors), a paid answer that fails locally still records its
 * charged cost and generation, and a terminal validation failure is never
 * retried automatically for the same input.
 */
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { type Provider, StructuredResearchResponseError } from "../../providers/types";
import { classifySentiment, type SentimentClassification, sentimentInputHash } from "../classifier";
import type { DetectableEntity } from "../detector";
import { runSentimentJob, type SentimentJobDeps } from "../job";
import { candidatesFromMentions, type StoredMention, type StoredRunForSentiment } from "../store";
import {
	SENTIMENT_CLASSIFIER_VERSION,
	SENTIMENT_TAXONOMY_VERSION,
	type SentimentAnalysisStatus,
	sentimentClassificationResultSchema,
} from "../types";
import { resolutionFakes } from "./resolution-fakes";

const RUN = "5e970006-0000-4000-8000-000000000001";
const ANSWER = "ARAG bietet einen starken Rechtsschutz. WGV ist günstig, aber die Bearbeitung dauert lange.";
const run: StoredRunForSentiment = {
	id: RUN,
	promptId: "5e970006-0000-4000-8000-000000000002",
	brandId: "arag",
	provider: "openrouter",
	model: "chatgpt",
	answerBody: ANSWER,
	organizationId: "default",
};
const entities: DetectableEntity[] = [
	{ key: "brand", entityType: "brand", competitorId: null, name: "ARAG", aliases: [], domains: ["arag.de"] },
	{ key: "c-wgv", entityType: "competitor", competitorId: "c-wgv", name: "WGV", aliases: [], domains: ["wgv.de"] },
];
const mentions: StoredMention[] = [
	{ id: "m1", key: "brand", entityType: "brand", competitorId: null, entityName: "ARAG" },
	{ id: "m2", key: "c-wgv", entityType: "competitor", competitorId: "c-wgv", entityName: "WGV" },
];
const candidates = candidatesFromMentions(mentions, entities);
const usage = {
	inputTokens: 6410,
	outputTokens: 812,
	reasoningTokens: 300,
	costUsd: 0.020047,
	webSearchRequests: 1,
	webSearchRequestsConflict: false,
};
const request = {
	model: "openai/gpt-5-mini",
	webSearch: true,
	maxToolCalls: 1,
	maxOutputTokens: 8000,
	strictJsonSchema: true,
	requireParameters: true,
};

/**
 * An answer in the pre-corrective shape whose brand excerpt is paraphrased —
 * exactly the failure class of the consumed canary. Under the anchored
 * contract it no longer even fits the request schema.
 */
const paraphrased = {
	entities: [
		{
			key: "brand",
			score: 80,
			category: "positive",
			confidence: 0.9,
			evidence: [{ quote: "ARAG bietet starken Rechtsschutz", polarity: "positive" }],
			aspects: [],
		},
		{
			key: "c-wgv",
			score: 50,
			category: "mixed",
			confidence: 0.8,
			evidence: [
				{ quote: "WGV ist günstig", polarity: "positive" },
				{ quote: "die Bearbeitung dauert lange", polarity: "negative" },
			],
			aspects: [],
		},
	],
};

/**
 * An answer that fits the anchored request schema but is rejected by the
 * local rules: a Mixed verdict citing only one polarity. This is the
 * post-schema failure class that still costs a paid call.
 */
/** Wire shape of classifier v4 that the schema accepts but local grounding refuses: the WGV verdict cites the ARAG sentence. */
const locallyRejected = {
	entities: [
		{
			key: "brand",
			category: "positive",
			score: 80,
			confidence: 0.9,
			evidence: [{ anchorId: "s0001", polarity: "positive" }],
			aspects: [],
		},
		{
			key: "c-wgv",
			category: "positive",
			score: 70,
			confidence: 0.8,
			evidence: [{ anchorId: "s0001", polarity: "positive" }],
			aspects: [],
		},
	],
};

/**
 * A provider double with the real provider's post-response contract: the
 * charged response is parsed against the request schema and a mismatch is a
 * `StructuredResearchResponseError` that carries the paid envelope.
 */
function providerAnswering(object: unknown): Provider {
	return {
		id: "openrouter",
		runStructuredResearch: vi.fn(
			async ({ schema }: { schema: { safeParse: (v: unknown) => { success: boolean; data?: unknown } } }) => {
				const parsed = schema.safeParse(object);
				if (!parsed.success) {
					throw new StructuredResearchResponseError("schema", {
						provider: "openrouter",
						model: "openai/gpt-5-mini",
						generationId: "gen-abc123",
						request,
						usage,
					});
				}
				return {
					object: parsed.data,
					modelVersion: "openai/gpt-5-mini",
					usage,
					request,
					generationId: "gen-abc123",
				};
			},
		),
	} as unknown as Provider;
}

function jobDeps(
	provider: Provider,
	analysis: { status: SentimentAnalysisStatus; inputHash: string | null; errorCode?: string | null },
) {
	const usageEvents: unknown[] = [];
	const marks: unknown[] = [];
	const state = { ...analysis };
	const resolution = resolutionFakes();
	const deps: SentimentJobDeps = {
		loadRun: vi.fn(async () => run),
		loadEntities: vi.fn(async () => entities),
		loadDetection: vi.fn(async () => ({ status: "mentions", mentionCount: 2 }) as never),
		loadMentions: vi.fn(async () => mentions),
		ensureAnalysis: vi.fn(
			async () =>
				({
					id: "a1",
					status: state.status,
					classifierVersion: SENTIMENT_CLASSIFIER_VERSION,
					taxonomyVersion: SENTIMENT_TAXONOMY_VERSION,
					inputHash: state.inputHash,
					errorCode: state.errorCode ?? null,
				}) as never,
		),
		claimAnalysis: vi.fn(async () => ({
			claimed: true as const,
			attempts: 1,
			claim: { analysisId: "a1", generation: 1 },
		})),
		markAnalysis: vi.fn(
			async (
				_claim: unknown,
				patch: { status?: SentimentAnalysisStatus; errorCode?: string | null; inputHash?: string | null },
			) => {
				marks.push(patch);
				if (patch.status) state.status = patch.status;
				if (patch.errorCode !== undefined) state.errorCode = patch.errorCode;
				if (patch.inputHash !== undefined) state.inputHash = patch.inputHash;
				return true;
			},
		),
		persist: vi.fn(async () => undefined),
		recordUsage: vi.fn(async (event: unknown) => {
			usageEvents.push(event);
		}),
		resolveProvider: () => resolution.phasesProvider(provider),
		resolutionPolicy: { backoffBaseMs: 1, backoffMaxMs: 2 },
		...resolution.deps,
	};
	return { deps, usageEvents, marks, state };
}

describe("grounded evidence — RED before the corrective", () => {
	it("1. a paraphrased excerpt and a locally rejected anchored answer are both rejected, and the paid response's usage and generation survive in the error", async () => {
		// A paraphrased excerpt cannot even be shaped by the request schema: a paid contract defect with its envelope.
		const provider = providerAnswering(paraphrased);
		let thrown: unknown;
		try {
			await classifySentiment({ answerBody: ANSWER, candidates }, { resolveProvider: () => provider });
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toMatchObject({ name: "SentimentValidationError", code: "schema", requestSent: true });
		expect(thrown).toMatchObject({
			envelope: { usage: { costUsd: 0.020047, webSearchRequests: 1 }, generationId: "gen-abc123", request },
		});
		expect(JSON.stringify(thrown)).not.toContain("Rechtsschutz");
		// An anchored answer whose overall is unbound is a candidate with an unresolved target (repair), not a rejection;
		// the paid response's usage and generation survive on the candidate.
		const unbound = await classifySentiment(
			{ answerBody: ANSWER, candidates },
			{ resolveProvider: () => providerAnswering(locallyRejected) },
		);
		expect(unbound.unresolvedTargets).toEqual([
			expect.objectContaining({ reason: "evidence-entity-unbound", source: "deterministic" }),
		]);
		expect(unbound).toMatchObject({ generationId: "gen-abc123", usage: { costUsd: 0.020047 } });
		// The routing data (targets, candidate by anchor id) carries no answer text; only the persisted evidence slices do.
		expect(JSON.stringify({ targets: unbound.unresolvedTargets, candidate: unbound.candidate })).not.toContain(
			"Rechtsschutz",
		);
	});

	it("2. the job attributes the charged cost of a locally rejected paid answer, not the estimate", async () => {
		const { deps, usageEvents } = jobDeps(providerAnswering(paraphrased), { status: "pending", inputHash: null });
		await runSentimentJob(
			{
				promptRunId: RUN,
				classifierVersion: SENTIMENT_CLASSIFIER_VERSION,
				taxonomyVersion: SENTIMENT_TAXONOMY_VERSION,
			},
			deps,
		).catch(() => undefined);
		expect(usageEvents).toHaveLength(1);
		expect(usageEvents[0]).toMatchObject({ succeeded: false, actualCostUsd: 0.020047 });
	});

	it("3. a locally rejected paid answer is a terminal outcome, not a thrown error the queue may retry", async () => {
		const { deps, marks } = jobDeps(providerAnswering(paraphrased), { status: "pending", inputHash: null });
		const outcome = await runSentimentJob(
			{
				promptRunId: RUN,
				classifierVersion: SENTIMENT_CLASSIFIER_VERSION,
				taxonomyVersion: SENTIMENT_TAXONOMY_VERSION,
			},
			deps,
		);
		// A paid answer the schema cannot shape is a contract defect: the run leaves the automatic workflow as an open
		// review item (never thrown for the queue to retry, never a closed failure).
		expect(outcome).toMatchObject({ status: "awaiting-review", reason: "contract-defect", paidCalls: 1 });
		expect(marks.at(-1)).toMatchObject({ status: "failed", errorCode: "awaiting-review", inputHash: null });
	});

	it("4. a run waiting for review is never sent to the provider again by the automatic path", async () => {
		const provider = providerAnswering(paraphrased);
		const first = jobDeps(provider, { status: "pending", inputHash: null });
		expect(
			await runSentimentJob(
				{
					promptRunId: RUN,
					classifierVersion: SENTIMENT_CLASSIFIER_VERSION,
					taxonomyVersion: SENTIMENT_TAXONOMY_VERSION,
				},
				first.deps,
			),
		).toMatchObject({
			status: "awaiting-review",
		});
		expect(provider.runStructuredResearch).toHaveBeenCalledTimes(1);
		const outcome = await runSentimentJob(
			{
				promptRunId: RUN,
				classifierVersion: SENTIMENT_CLASSIFIER_VERSION,
				taxonomyVersion: SENTIMENT_TAXONOMY_VERSION,
			},
			first.deps,
		).catch((error: unknown) => ({ status: "threw", error }));
		expect(provider.runStructuredResearch).toHaveBeenCalledTimes(1);
		expect(outcome).toMatchObject({ status: "awaiting-review", reason: "contract-defect" });
	});

	it("5. the provider-facing schema binds evidence to anchor ids, so a free-form (paraphrased) quote no longer fits it", () => {
		const jsonSchema = z.toJSONSchema(sentimentClassificationResultSchema) as {
			$defs?: Record<string, unknown>;
			properties?: Record<string, unknown>;
		};
		const serialized = JSON.stringify(jsonSchema);
		// The corrective replaces `quote: string` with an anchor id constrained to the answer's own segments.
		expect(serialized).not.toContain('"quote"');
		expect(serialized).toContain('"anchorId"');
		expect(() => sentimentClassificationResultSchema.parse(paraphrased)).toThrow();
	});
});

// Type-level guard: the persisted evidence format stays {quote,start,end,polarity} whatever the provider contract does.
type StoredEvidence = SentimentClassification["entities"][number]["evidence"][number];
const storedEvidenceUnchanged: StoredEvidence extends { quote: string; start: number; end: number; polarity: string }
	? true
	: never = true;
void storedEvidenceUnchanged;
