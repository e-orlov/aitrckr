/**
 * The one-shot paid canary core: exactly one invocation of the production job
 * core for the frozen run, no queue, no retry, a request deadline that aborts
 * a hanging provider and an outer watchdog. Everything here runs against
 * fakes — no network.
 */
import { describe, expect, it, vi } from "vitest";
import type { Provider } from "../../providers/types";
import { acceptCanaryRunId, runSentimentCanary, SentimentCanaryError } from "../canary";
import type { DetectableEntity } from "../detector";
import type { SentimentJobDeps } from "../job";
import type { StoredMention, StoredRunForSentiment } from "../store";
import { SENTIMENT_CLASSIFIER_VERSION, SENTIMENT_TAXONOMY_VERSION } from "../types";

const FROZEN = "bf1347c3-7161-457c-91d6-0173d601659e";
const run: StoredRunForSentiment = {
	id: FROZEN,
	promptId: "e32b0973-3b13-46c2-84dc-f29a6e5c41a2",
	brandId: "arag",
	provider: "openrouter",
	model: "chatgpt",
	answerBody: "ARAG Aktiv Komfort ist sehr leistungsstark. WGV PBV Optimal hat das beste Preis-Leistungs-Verhältnis.",
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
const goodAnswer = {
	entities: [
		{
			key: "brand",
			score: 80,
			category: "positive",
			confidence: 0.9,
			evidence: [{ quote: "ARAG Aktiv Komfort ist sehr leistungsstark.", polarity: "positive" }],
			aspects: [],
		},
		{
			key: "c-wgv",
			score: 85,
			category: "positive",
			confidence: 0.9,
			evidence: [{ quote: "beste Preis-Leistungs-Verhältnis", polarity: "positive" }],
			aspects: [
				{
					key: "price",
					score: 85,
					category: "positive",
					confidence: 0.9,
					evidence: [{ quote: "beste Preis-Leistungs-Verhältnis", polarity: "positive" }],
				},
			],
		},
	],
};

/** Real job core over fakes: only the provider is swapped. */
function storeFakes(provider: Provider) {
	const marks: unknown[] = [];
	const usage: unknown[] = [];
	const deps: SentimentJobDeps = {
		loadRun: vi.fn(async () => run),
		loadEntities: vi.fn(async () => entities),
		loadDetection: vi.fn(async () => ({ status: "mentions", mentionCount: 2 }) as never),
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
		persist: vi.fn(async () => undefined),
		recordUsage: vi.fn(async (event: unknown) => {
			usage.push(event);
		}),
		resolveProvider: () => provider,
	};
	return { deps, marks, usage };
}

describe("canary run-id acceptance", () => {
	it("accepts exactly the frozen run id and nothing else", () => {
		expect(acceptCanaryRunId([FROZEN], FROZEN)).toBe(FROZEN);
		expect(acceptCanaryRunId([FROZEN.toUpperCase()], FROZEN)).toBe(FROZEN);
		expect(() => acceptCanaryRunId([], FROZEN)).toThrow(SentimentCanaryError);
		expect(() => acceptCanaryRunId([FROZEN, FROZEN], FROZEN)).toThrow(
			expect.objectContaining({ code: "invalid-run-id" }),
		);
		expect(() => acceptCanaryRunId([`${FROZEN},${FROZEN}`], FROZEN)).toThrow(
			expect.objectContaining({ code: "invalid-run-id" }),
		);
		expect(() => acceptCanaryRunId([`${FROZEN} ${FROZEN}`], FROZEN)).toThrow(
			expect.objectContaining({ code: "invalid-run-id" }),
		);
		expect(() => acceptCanaryRunId(["not-a-uuid"], FROZEN)).toThrow(
			expect.objectContaining({ code: "invalid-run-id" }),
		);
		expect(() => acceptCanaryRunId(["11111111-1111-4111-8111-111111111111"], FROZEN)).toThrow(
			expect.objectContaining({ code: "not-frozen-run" }),
		);
	});
});

describe("one-shot canary", () => {
	it("invokes the job core exactly once with the frozen payload and a timeout signal, and reports safe usage", async () => {
		const job = vi.fn(async () => ({
			status: "classified" as const,
			entities: 2,
			usage: { inputTokens: 7000, outputTokens: 900, reasoningTokens: 400, costUsd: 0.0312, webSearchRequests: 1 },
		}));
		const report = await runSentimentCanary({ runId: FROZEN, job, deadlineMs: 1000, watchdogMs: 2000 });
		expect(job).toHaveBeenCalledTimes(1);
		const [payload, , options] = job.mock.calls[0] as unknown as [unknown, unknown, { signal: AbortSignal }];
		expect(payload).toEqual({
			promptRunId: FROZEN,
			classifierVersion: SENTIMENT_CLASSIFIER_VERSION,
			taxonomyVersion: SENTIMENT_TAXONOMY_VERSION,
		});
		expect(options.signal).toBeInstanceOf(AbortSignal);
		expect(report.attempts).toBe(1);
		expect(report.outcome).toEqual({
			status: "classified",
			entities: 2,
			usage: { inputTokens: 7000, outputTokens: 900, reasoningTokens: 400, costUsd: 0.0312, webSearchRequests: 1 },
		});
		expect(report).toMatchObject({
			deadlineMs: 1000,
			watchdogMs: 2000,
			classifierVersion: SENTIMENT_CLASSIFIER_VERSION,
		});
	});

	it("a provider failure is one attempt: the real job core marks it failed once, nothing is retried or re-sent", async () => {
		const provider = {
			id: "openrouter",
			runStructuredResearch: vi.fn(async () => {
				throw new Error("OpenRouter API error (503): upstream unavailable; Authorization: Bearer sk-or-leak");
			}),
		} as unknown as Provider;
		const { deps, marks, usage } = storeFakes(provider);
		const report = await runSentimentCanary({ runId: FROZEN, deps, deadlineMs: 1000, watchdogMs: 2000 });
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(provider.runStructuredResearch).toHaveBeenCalledTimes(1);
		expect(deps.claimAnalysis).toHaveBeenCalledTimes(1);
		expect(marks).toEqual([expect.objectContaining({ status: "failed", errorCode: "provider" })]);
		expect(usage).toEqual([expect.objectContaining({ succeeded: false })]);
		expect(report.outcome).toEqual({ status: "error", name: "SentimentJobError", code: "provider", httpStatus: 503 });
		expect(JSON.stringify(report)).not.toMatch(/sk-or-|Authorization|upstream unavailable/);
	});

	it("a hanging provider request is aborted by the configured deadline through the real job core", async () => {
		const provider = {
			id: "openrouter",
			runStructuredResearch: vi.fn(
				({ signal }: { signal?: AbortSignal }) =>
					new Promise((_resolve, reject) => {
						signal?.addEventListener("abort", () => reject(signal.reason ?? new DOMException("aborted", "AbortError")));
					}),
			),
		} as unknown as Provider;
		const { deps, marks } = storeFakes(provider);
		const started = Date.now();
		const report = await runSentimentCanary({ runId: FROZEN, deps, deadlineMs: 60, watchdogMs: 1000 });
		const elapsed = Date.now() - started;
		expect(provider.runStructuredResearch).toHaveBeenCalledTimes(1);
		const [{ signal, maxOutputTokens }] = (provider.runStructuredResearch as ReturnType<typeof vi.fn>).mock
			.calls[0] as [{ signal: AbortSignal; maxOutputTokens: number }];
		expect(signal.aborted).toBe(true);
		expect(maxOutputTokens).toBe(8000);
		expect(elapsed).toBeLessThan(900);
		expect(report.outcome).toMatchObject({ status: "error", name: "SentimentJobError", code: "aborted" });
		expect(marks).toEqual([expect.objectContaining({ status: "failed", errorCode: "aborted" })]);
	});

	it("the outer watchdog ends an invocation that ignores the signal", async () => {
		const job = vi.fn(() => new Promise<never>(() => {}));
		const started = Date.now();
		const report = await runSentimentCanary({ runId: FROZEN, job, deadlineMs: 50, watchdogMs: 120 });
		expect(Date.now() - started).toBeLessThan(900);
		expect(report.outcome).toMatchObject({ status: "error", name: "SentimentCanaryError", code: "watchdog" });
		expect(job).toHaveBeenCalledTimes(1);
	});

	it("succeeds end to end through the real job core with a fake provider and the sentiment output cap", async () => {
		const provider = {
			id: "openrouter",
			runStructuredResearch: vi.fn(async ({ schema }: { schema: { parse: (v: unknown) => unknown } }) => ({
				object: schema.parse(goodAnswer),
				modelVersion: "openai/gpt-5-mini",
				usage: { inputTokens: 6410, outputTokens: 812, reasoningTokens: 300, costUsd: 0.0234, webSearchRequests: 1 },
			})),
		} as unknown as Provider;
		const { deps, usage } = storeFakes(provider);
		const report = await runSentimentCanary({ runId: FROZEN, deps, deadlineMs: 1000, watchdogMs: 2000 });
		expect(provider.runStructuredResearch).toHaveBeenCalledTimes(1);
		const [{ maxOutputTokens, webSearch }] = (provider.runStructuredResearch as ReturnType<typeof vi.fn>).mock
			.calls[0] as [{ maxOutputTokens: number; webSearch: boolean }];
		expect(maxOutputTokens).toBe(8000);
		expect(webSearch).toBe(true);
		expect(report.outcome).toMatchObject({
			status: "classified",
			entities: 2,
			usage: { costUsd: 0.0234, webSearchRequests: 1 },
		});
		expect(usage).toEqual([expect.objectContaining({ succeeded: true, actualCostUsd: 0.0234 })]);
	});
});
