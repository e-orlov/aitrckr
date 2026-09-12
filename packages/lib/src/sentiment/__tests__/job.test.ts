import { describe, expect, it, vi } from "vitest";
import type { SentimentClassification } from "../classifier";
import { SentimentValidationError, sentimentInputHash } from "../classifier";
import type { DetectableEntity } from "../detector";
import { enqueueSentimentBestEffort } from "../enqueue";
import { runSentimentJob, type SentimentJobDeps } from "../job";
import { ensureSentimentQueue, SENTIMENT_QUEUE_OPTIONS } from "../queue-setup";
import { candidatesFromMentions, type StoredMention, type StoredRunForSentiment } from "../store";
import {
	SENTIMENT_CLASSIFIER_VERSION,
	SENTIMENT_MODEL,
	SENTIMENT_PROVIDER_ID,
	SENTIMENT_QUEUE,
	SENTIMENT_TAXONOMY_VERSION,
	sentimentSingletonKey,
} from "../types";

const RUN_ID = "11111111-1111-4111-8111-111111111111";
const payload = {
	promptRunId: RUN_ID,
	classifierVersion: SENTIMENT_CLASSIFIER_VERSION,
	taxonomyVersion: SENTIMENT_TAXONOMY_VERSION,
};

const run: StoredRunForSentiment = {
	id: RUN_ID,
	promptId: "22222222-2222-4222-8222-222222222222",
	brandId: "arag",
	provider: "openrouter",
	model: "chatgpt",
	answerBody: "ARAG ist sehr gut. HUK ist teuer.",
	organizationId: "default",
};
const entities: DetectableEntity[] = [
	{ key: "brand", entityType: "brand", competitorId: null, name: "ARAG", aliases: [], domains: ["arag.de"] },
	{
		key: "c-huk",
		entityType: "competitor",
		competitorId: "c-huk",
		name: "HUK-COBURG",
		aliases: ["HUK"],
		domains: ["huk.de"],
	},
];
const mentions: StoredMention[] = [
	{ id: "m1", key: "brand", entityType: "brand", competitorId: null, entityName: "ARAG" },
	{ id: "m2", key: "c-huk", entityType: "competitor", competitorId: "c-huk", entityName: "HUK-COBURG" },
];
const currentHash = sentimentInputHash(run.answerBody ?? "", candidatesFromMentions(mentions, entities));
const classification: SentimentClassification = {
	entities: [
		{
			key: "brand",
			score: 85,
			category: "positive",
			confidence: 0.9,
			evidence: [{ quote: "ARAG ist sehr gut.", start: 0, end: 18, polarity: "positive" }],
			aspects: [],
		},
		{
			key: "c-huk",
			score: 30,
			category: "negative",
			confidence: 0.8,
			evidence: [{ quote: "HUK ist teuer.", start: 19, end: 33, polarity: "negative" }],
			aspects: [],
		},
	],
	provider: "fake",
	model: "fake-model",
	webSearch: true,
	classifierVersion: SENTIMENT_CLASSIFIER_VERSION,
	taxonomyVersion: SENTIMENT_TAXONOMY_VERSION,
	inputHash: currentHash,
};

type AnalysisStub = {
	id: string;
	status: string;
	classifierVersion: string;
	taxonomyVersion: string;
	inputHash: string | null;
};

function deps(overrides: Partial<SentimentJobDeps> & { analysis?: Partial<AnalysisStub> } = {}) {
	const marks: unknown[] = [];
	const usage: unknown[] = [];
	const analysis: AnalysisStub = {
		id: "a1",
		status: "pending",
		classifierVersion: SENTIMENT_CLASSIFIER_VERSION,
		taxonomyVersion: SENTIMENT_TAXONOMY_VERSION,
		inputHash: null,
		...overrides.analysis,
	};
	const { analysis: _ignored, ...depOverrides } = overrides;
	const base: SentimentJobDeps = {
		loadRun: vi.fn(async () => run),
		loadEntities: vi.fn(async () => entities),
		loadDetection: vi.fn(async () => ({ status: "mentions", mentionCount: mentions.length }) as never),
		loadMentions: vi.fn(async () => mentions),
		persistDetection: vi.fn(async () => mentions),
		ensureAnalysis: vi.fn(async () => analysis as never),
		claimAnalysis: vi.fn(async () => ({ claimed: true as const, attempts: 1 })),
		markAnalysis: vi.fn(async (_id: string, patch: unknown) => {
			marks.push(patch);
		}),
		classify: vi.fn(async () => classification),
		persist: vi.fn(async () => undefined),
		recordUsage: vi.fn(async (event: unknown) => {
			usage.push(event);
		}),
	};
	return { d: { ...base, ...depOverrides }, marks, usage };
}

describe("IT-SNT-001 job lifecycle (fakes)", () => {
	it("claims, classifies, persists atomically and records one success usage event", async () => {
		const { d, usage } = deps();
		const outcome = await runSentimentJob(payload, d);
		expect(outcome).toEqual({ status: "classified", entities: 2 });
		expect(d.claimAnalysis).toHaveBeenCalledTimes(1);
		expect(d.claimAnalysis).toHaveBeenCalledWith("a1", { allowFinished: true });
		expect(d.classify).toHaveBeenCalledTimes(1);
		expect(d.persist).toHaveBeenCalledWith(
			expect.objectContaining({ analysisId: "a1", promptRunId: RUN_ID, mentions }),
		);
		expect(usage).toEqual([
			expect.objectContaining({ succeeded: true, provider: "fake", model: "fake-model", promptId: run.promptId }),
		]);
	});

	it("B3: a lost claim returns a non-calling outcome — no classifier call, no write, no usage event", async () => {
		const { d, marks, usage } = deps({
			claimAnalysis: vi.fn(async () => ({ claimed: false as const, status: "processing" as const })),
		});
		expect(await runSentimentJob(payload, d)).toEqual({ status: "claimed-elsewhere", analysisStatus: "processing" });
		expect(d.classify).not.toHaveBeenCalled();
		expect(d.persist).not.toHaveBeenCalled();
		expect(marks).toEqual([]);
		expect(usage).toEqual([]);
	});

	it("makes no provider call when the receipt says no mentions and records no_mentions", async () => {
		const { d, marks } = deps({
			loadDetection: vi.fn(async () => ({ status: "no_mentions", mentionCount: 0 }) as never),
		});
		expect(await runSentimentJob(payload, d)).toEqual({ status: "no-mentions" });
		expect(d.classify).not.toHaveBeenCalled();
		expect(d.loadMentions).not.toHaveBeenCalled();
		expect(marks.at(-1)).toMatchObject({ status: "no_mentions" });
	});

	it("B2: an unscanned run is detected once, receipt and rows written together, before classifying", async () => {
		const persistDetection = vi.fn(async () => mentions);
		const { d } = deps({ loadDetection: vi.fn(async () => null), persistDetection });
		expect(await runSentimentJob(payload, d)).toEqual({ status: "classified", entities: 2 });
		expect(persistDetection).toHaveBeenCalledTimes(1);
		expect(persistDetection).toHaveBeenCalledWith(
			expect.objectContaining({
				promptRunId: RUN_ID,
				result: expect.objectContaining({
					status: "mentions",
					mentions: expect.arrayContaining([
						expect.objectContaining({ key: "brand" }),
						expect.objectContaining({ key: "c-huk" }),
					]),
				}),
			}),
		);
	});

	it("B2: an unscanned run without extractable text gets an unextractable receipt and no call", async () => {
		const persistDetection = vi.fn(async () => []);
		const { d, marks } = deps({
			loadRun: vi.fn(async () => ({ ...run, answerBody: null })),
			loadDetection: vi.fn(async () => null),
			persistDetection,
		});
		expect(await runSentimentJob(payload, d)).toEqual({ status: "no-mentions" });
		expect(persistDetection).toHaveBeenCalledWith(
			expect.objectContaining({ result: { status: "unextractable", mentions: [] } }),
		);
		expect(d.classify).not.toHaveBeenCalled();
		expect(marks.at(-1)).toMatchObject({ status: "no_mentions" });
	});

	it("skips a completed analysis whose input hash still matches, without any call or claim", async () => {
		const { d } = deps({ analysis: { status: "completed", inputHash: currentHash } });
		expect(await runSentimentJob(payload, d)).toEqual({ status: "already-completed" });
		expect(d.claimAnalysis).not.toHaveBeenCalled();
		expect(d.classify).not.toHaveBeenCalled();
		expect(d.markAnalysis).not.toHaveBeenCalled();
	});

	it("B8: a completed analysis with a stale input hash (new entity after a roster edit) is reclassified", async () => {
		const staleHash = sentimentInputHash(run.answerBody ?? "", candidatesFromMentions(mentions.slice(0, 1), entities));
		const { d } = deps({ analysis: { status: "completed", inputHash: staleHash } });
		expect(await runSentimentJob(payload, d)).toEqual({ status: "classified", entities: 2 });
		expect(d.claimAnalysis).toHaveBeenCalledWith("a1", { allowFinished: true });
		expect(d.classify).toHaveBeenCalledTimes(1);
	});

	it("B8: a completed analysis under another taxonomy or without a hash never counts as current", async () => {
		const taxonomy = deps({
			analysis: { status: "completed", inputHash: currentHash, taxonomyVersion: "sent-aspects-v0" },
		});
		expect(await runSentimentJob(payload, taxonomy.d)).toEqual({ status: "classified", entities: 2 });
		const hashless = deps({ analysis: { status: "completed", inputHash: null } });
		expect(await runSentimentJob(payload, hashless.d)).toEqual({ status: "classified", entities: 2 });
	});

	it("a no_mentions analysis whose receipt still says no mentions is left alone", async () => {
		const { d } = deps({
			analysis: { status: "no_mentions" },
			loadDetection: vi.fn(async () => ({ status: "no_mentions", mentionCount: 0 }) as never),
		});
		expect(await runSentimentJob(payload, d)).toEqual({ status: "already-completed" });
		expect(d.claimAnalysis).not.toHaveBeenCalled();
	});

	it("marks failed with a bounded code, attributes the failed attempt to the locked provider/model, writes nothing and rethrows", async () => {
		const { d, marks, usage } = deps({
			classify: vi.fn(async () => {
				throw new SentimentValidationError("evidence-not-in-answer", "x".repeat(2000));
			}),
		});
		await expect(runSentimentJob(payload, d)).rejects.toBeInstanceOf(SentimentValidationError);
		expect(d.persist).not.toHaveBeenCalled();
		const failed = marks.at(-1) as { status: string; errorCode: string; errorMessage: string };
		expect(failed.status).toBe("failed");
		expect(failed.errorCode).toBe("evidence-not-in-answer");
		expect(failed.errorMessage.length).toBeLessThanOrEqual(500);
		expect(usage).toEqual([
			expect.objectContaining({ succeeded: false, provider: SENTIMENT_PROVIDER_ID, model: SENTIMENT_MODEL }),
		]);
	});

	it("skips invalid and stale payloads without touching the store", async () => {
		const { d } = deps();
		expect(await runSentimentJob({ promptRunId: "nope" }, d)).toMatchObject({ status: "skipped" });
		expect(await runSentimentJob({ ...payload, classifierVersion: "sent-classifier-v0" }, d)).toMatchObject({
			status: "skipped",
		});
		expect(await runSentimentJob({ ...payload, taxonomyVersion: "old" }, d)).toMatchObject({ status: "skipped" });
		expect(await runSentimentJob({ ...payload, extra: 1 }, d)).toMatchObject({ status: "skipped" });
		expect(d.loadRun).not.toHaveBeenCalled();
	});

	it("skips a run that no longer exists", async () => {
		const { d } = deps({ loadRun: vi.fn(async () => null) });
		expect(await runSentimentJob(payload, d)).toEqual({ status: "skipped", reason: "prompt run not found" });
	});
});

describe("IT-SNT-002 queue policy and singleton dedupe", () => {
	it("creates the exclusive queue and verifies the effective policy", async () => {
		const createQueue = vi.fn(async () => undefined);
		await ensureSentimentQueue({ createQueue, getQueue: async () => ({ policy: "exclusive" }) });
		expect(createQueue).toHaveBeenCalledWith(SENTIMENT_QUEUE, SENTIMENT_QUEUE_OPTIONS);
		expect(SENTIMENT_QUEUE_OPTIONS).toMatchObject({ policy: "exclusive", retryLimit: 3, retryBackoff: true });
		expect(SENTIMENT_QUEUE_OPTIONS.expireInSeconds).toBeGreaterThan(60);
		expect(SENTIMENT_QUEUE_OPTIONS.expireInSeconds).toBeLessThanOrEqual(3600);
	});

	it("fails fast when the existing queue carries another policy", async () => {
		await expect(
			ensureSentimentQueue({ createQueue: async () => undefined, getQueue: async () => ({ policy: "standard" }) }),
		).rejects.toThrow(/immutable/);
		await expect(
			ensureSentimentQueue({ createQueue: async () => undefined, getQueue: async () => null }),
		).rejects.toThrow(/missing/);
	});

	it("uses one singleton key per run and classifier version", () => {
		expect(sentimentSingletonKey(RUN_ID, "v1")).toBe(`sentiment:${RUN_ID}:v1`);
		expect(sentimentSingletonKey(RUN_ID, "v2")).not.toBe(sentimentSingletonKey(RUN_ID, "v1"));
	});
});

describe("IT-SNT-003 best-effort enqueue never fails the prompt run", () => {
	it("writes an unextractable receipt and reports no-answer without sending", async () => {
		const send = vi.fn(async () => "job");
		const persist = vi.fn(async () => []);
		expect(
			await enqueueSentimentBestEffort({
				promptRunId: RUN_ID,
				brandId: "arag",
				answerBody: null,
				entities,
				sender: { send },
				persist,
			}),
		).toEqual({ status: "no-answer" });
		expect(persist).toHaveBeenCalledWith(
			expect.objectContaining({ result: { status: "unextractable", mentions: [] } }),
		);
		expect(send).not.toHaveBeenCalled();
	});

	it("writes a no_mentions receipt and reports no-mentions without sending", async () => {
		const send = vi.fn(async () => "job");
		const persist = vi.fn(async () => []);
		expect(
			await enqueueSentimentBestEffort({
				promptRunId: RUN_ID,
				brandId: "arag",
				answerBody: "Nothing about anyone.",
				entities,
				sender: { send },
				persist,
			}),
		).toEqual({ status: "no-mentions" });
		expect(persist).toHaveBeenCalledWith(expect.objectContaining({ result: { status: "no_mentions", mentions: [] } }));
		expect(send).not.toHaveBeenCalled();
	});

	it("turns a thrown store error into a logged failure outcome", async () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		const send = vi.fn(async () => {
			throw new Error("queue down");
		});
		// persistDetection hits the real db module here; with no DATABASE_URL reachable it throws,
		// which is exactly the outage this contract must absorb.
		const outcome = await enqueueSentimentBestEffort({
			promptRunId: RUN_ID,
			brandId: "arag",
			answerBody: "ARAG ist gut.",
			entities,
			sender: { send },
		});
		expect(outcome.status).toBe("failed");
		expect(error).toHaveBeenCalled();
		error.mockRestore();
	});
});
