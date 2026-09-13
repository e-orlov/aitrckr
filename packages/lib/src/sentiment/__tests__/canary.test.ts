/**
 * The one-shot paid canary core: a frozen contract checked before any request
 * (preflight) and enforced after the one call (verdict), exactly one
 * invocation of the production job core, one owned abort signal that the
 * deadline and the watchdog both fire, no queue, no retry. Everything here
 * runs against fakes — no network.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Provider, StructuredResearchRequestSummary, StructuredResearchUsage } from "../../providers/types";
import {
	acceptCanaryRunId,
	evaluateSentimentCanary,
	inspectSentimentCanaryRun,
	parseSentimentCanaryContract,
	preflightSentimentCanary,
	runSentimentCanary,
	SENTIMENT_CANARY_LIMITS,
	type SentimentCanaryContract,
	SentimentCanaryError,
	type SentimentCanaryReport,
	sentimentCanaryBodyDigest,
	sentimentCanaryInputDigests,
} from "../canary";
import type { DetectableEntity } from "../detector";
import type { SentimentJobDeps } from "../job";
import { candidatesFromMentions, type StoredMention, type StoredRunForSentiment } from "../store";
import { SENTIMENT_CLASSIFIER_VERSION, SENTIMENT_TAXONOMY_VERSION } from "../types";

const FROZEN = "bf1347c3-7161-457c-91d6-0173d601659e";
const PROMPT = "e32b0973-3b13-46c2-84dc-f29a6e5c41a2";
const WGV = "b64b96f5-3bbd-4e42-a5ea-f30821cb9f8c";
const ANSWER = "ARAG Aktiv Komfort ist sehr leistungsstark. WGV PBV Optimal hat das beste Preis-Leistungs-Verhältnis.";
const run: StoredRunForSentiment = {
	id: FROZEN,
	promptId: PROMPT,
	brandId: "arag",
	provider: "openrouter",
	model: "chatgpt",
	answerBody: ANSWER,
	organizationId: "default",
};
const entities: DetectableEntity[] = [
	{ key: "brand", entityType: "brand", competitorId: null, name: "ARAG", aliases: [], domains: ["arag.de"] },
	{ key: WGV, entityType: "competitor", competitorId: WGV, name: "WGV", aliases: [], domains: ["wgv.de"] },
	{ key: "c-huk", entityType: "competitor", competitorId: "c-huk", name: "HUK-COBURG", aliases: [], domains: [] },
];
const mentions: StoredMention[] = [
	{ id: "m1", key: "brand", entityType: "brand", competitorId: null, entityName: "ARAG" },
	{ id: "m2", key: WGV, entityType: "competitor", competitorId: WGV, entityName: "WGV" },
];
const frozenDigests = sentimentCanaryInputDigests({
	answerBody: ANSWER,
	candidates: candidatesFromMentions(mentions, entities),
});
const contract: SentimentCanaryContract = {
	runId: FROZEN,
	promptId: PROMPT,
	brandId: "arag",
	answerBodySha256: sentimentCanaryBodyDigest(ANSWER),
	entities: [
		{ key: "brand", entityType: "brand" },
		{ key: WGV, entityType: "competitor" },
	],
	...frozenDigests,
	classifierVersion: SENTIMENT_CLASSIFIER_VERSION,
	taxonomyVersion: SENTIMENT_TAXONOMY_VERSION,
	provider: "openrouter",
	model: "openai/gpt-5-mini",
};
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
			key: WGV,
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
const goodUsage: StructuredResearchUsage = {
	inputTokens: 6410,
	outputTokens: 812,
	reasoningTokens: 300,
	costUsd: 0.0234,
	webSearchRequests: 1,
	webSearchRequestsConflict: false,
};
const goodRequest: StructuredResearchRequestSummary = {
	model: "openai/gpt-5-mini",
	webSearch: true,
	maxToolCalls: 1,
	maxOutputTokens: 8000,
};

/** Real job core over fakes: only the provider is swapped. */
function storeFakes(provider: Provider, overrides: Partial<SentimentJobDeps> = {}) {
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
		...overrides,
	};
	return { deps, marks, usage };
}

/** A provider answering the frozen run correctly, with configurable usage/request metadata. */
function goodProvider(
	meta: { usage?: StructuredResearchUsage | undefined; request?: typeof goodRequest | undefined } = {
		usage: goodUsage,
		request: goodRequest,
	},
	answer: unknown = goodAnswer,
): Provider {
	return {
		id: "openrouter",
		runStructuredResearch: vi.fn(async ({ schema }: { schema: { parse: (v: unknown) => unknown } }) => ({
			object: schema.parse(answer),
			modelVersion: "openai/gpt-5-mini",
			...("usage" in meta ? { usage: meta.usage } : {}),
			...("request" in meta ? { request: meta.request } : {}),
		})),
	} as unknown as Provider;
}

const codes = (report: SentimentCanaryReport) =>
	report.verdict.status === "reject" ? report.verdict.reasons.map((r) => r.code) : [];

const fast = { deadlineMs: 1000, watchdogMs: 2000 };

afterEach(() => vi.restoreAllMocks());

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

describe("canary contract", () => {
	it("parses a complete contract and normalizes ids", () => {
		const parsed = parseSentimentCanaryContract({ ...contract, runId: FROZEN.toUpperCase() });
		expect(parsed).toEqual(contract);
	});

	it.each([
		["an unknown field", { ...contract, answerBody: ANSWER }],
		["a missing digest", { ...contract, answerBodySha256: undefined }],
		["a missing input hash", { ...contract, classifierInputHash: undefined }],
		["a malformed prompt hash", { ...contract, providerPromptSha256: "nope" }],
		["a malformed digest", { ...contract, answerBodySha256: "abc" }],
		["no entities", { ...contract, entities: [] }],
		["an entity of unknown type", { ...contract, entities: [{ key: "brand", entityType: "person" }] }],
		["a non-uuid run id", { ...contract, runId: "run-1" }],
		["a non-object", "contract"],
	])("refuses %s", (_label, raw) => {
		expect(() => parseSentimentCanaryContract(raw)).toThrow(expect.objectContaining({ code: "invalid-contract" }));
	});

	it("describes a stored run in contract form without any answer text", async () => {
		const { deps } = storeFakes(goodProvider());
		const description = await inspectSentimentCanaryRun(FROZEN, deps);
		expect(description).toEqual({
			runId: FROZEN,
			promptId: PROMPT,
			brandId: "arag",
			answerBodySha256: sentimentCanaryBodyDigest(ANSWER),
			entities: contract.entities,
			...frozenDigests,
			classifierVersion: SENTIMENT_CLASSIFIER_VERSION,
			taxonomyVersion: SENTIMENT_TAXONOMY_VERSION,
			provider: "openrouter",
			model: "openai/gpt-5-mini",
		});
		expect(JSON.stringify(description)).not.toContain("ARAG Aktiv");
		expect(parseSentimentCanaryContract(description)).toEqual(contract);
		expect(await inspectSentimentCanaryRun(FROZEN, { ...deps, loadRun: vi.fn(async () => null) })).toBeNull();
	});

	it("falls back to a deterministic scan for a run without a detection receipt, still without writing", async () => {
		const persistDetection = vi.fn(async () => mentions);
		const { deps } = storeFakes(goodProvider(), { loadDetection: vi.fn(async () => null), persistDetection });
		expect(await preflightSentimentCanary(contract, deps)).toEqual([]);
		expect(persistDetection).not.toHaveBeenCalled();
	});
});

describe("canary preflight refuses before any request", () => {
	const refusal = async (overrides: Partial<SentimentJobDeps>, c: SentimentCanaryContract = contract) => {
		const provider = goodProvider();
		const { deps } = storeFakes(provider, overrides);
		const report = await runSentimentCanary({ contract: c, deps, ...fast });
		expect(provider.runStructuredResearch).not.toHaveBeenCalled();
		expect(deps.claimAnalysis).not.toHaveBeenCalled();
		expect(deps.persist).not.toHaveBeenCalled();
		expect(deps.recordUsage).not.toHaveBeenCalled();
		expect(report.attempts).toBe(0);
		expect(report.providerCalls).toBe(0);
		expect(report.outcome).toBeNull();
		expect(report.preflight.status).toBe("refused");
		expect(report.verdict.status).toBe("reject");
		return codes(report);
	};

	it("unknown run id", async () => {
		expect(await refusal({ loadRun: vi.fn(async () => null) })).toEqual(["run-not-found"]);
	});

	it("prompt mismatch", async () => {
		expect(await refusal({}, { ...contract, promptId: "11111111-1111-4111-8111-111111111111" })).toEqual([
			"prompt-mismatch",
		]);
	});

	it("brand mismatch", async () => {
		expect(await refusal({}, { ...contract, brandId: "other" })).toEqual(["brand-mismatch"]);
	});

	it("body hash mismatch (the stored answer changed)", async () => {
		// Trailing whitespace changes the raw body and the literal prompt; the canonical (normalized) input hash survives.
		expect(await refusal({ loadRun: vi.fn(async () => ({ ...run, answerBody: `${ANSWER} ` })) })).toEqual([
			"body-hash-mismatch",
			"contract-prompt-hash",
		]);
		expect(
			await refusal({ loadRun: vi.fn(async () => ({ ...run, answerBody: ANSWER.replace("beste", "gute") })) }),
		).toEqual(["body-hash-mismatch", "contract-input-hash", "contract-prompt-hash"]);
	});

	it("unextractable body", async () => {
		expect(await refusal({ loadRun: vi.fn(async () => ({ ...run, answerBody: null })) })).toEqual([
			"body-unextractable",
		]);
	});

	it("entity set mismatch: a frozen entity is missing from the run", async () => {
		expect(await refusal({ loadMentions: vi.fn(async () => mentions.slice(0, 1)) })).toEqual([
			"entity-set-mismatch",
			"contract-input-hash",
			"contract-prompt-hash",
		]);
	});

	it("entity set mismatch: the run carries an entity the contract does not", async () => {
		expect(
			await refusal({
				loadMentions: vi.fn(async () => [
					...mentions,
					{
						id: "m3",
						key: "c-huk",
						entityType: "competitor" as const,
						competitorId: "c-huk",
						entityName: "HUK-COBURG",
					},
				]),
			}),
		).toEqual(["entity-set-mismatch", "contract-input-hash", "contract-prompt-hash"]);
	});

	it("entity set mismatch: same key, different type", async () => {
		expect(
			await refusal({}, { ...contract, entities: [{ key: "brand", entityType: "competitor" }, contract.entities[1]] }),
		).toEqual(["entity-unknown", "entity-set-mismatch"]);
	});

	it("an entity the roster does not know", async () => {
		expect(
			await refusal({}, { ...contract, entities: [...contract.entities, { key: "ghost", entityType: "competitor" }] }),
		).toEqual(["entity-unknown", "entity-set-mismatch"]);
	});

	it("contract frozen against other classifier/taxonomy versions, provider or model", async () => {
		expect(
			await refusal(
				{},
				{
					...contract,
					classifierVersion: "sent-classifier-v0",
					taxonomyVersion: "sent-aspects-v0",
					provider: "openai-api",
					model: "openai/gpt-5.6-luna",
				},
			),
		).toEqual(["contract-classifier-version", "contract-taxonomy-version", "contract-provider", "contract-model"]);
	});

	it("input hash or prompt hash frozen against another candidate set or prompt template", async () => {
		expect(await refusal({}, { ...contract, classifierInputHash: "0".repeat(64) })).toEqual(["contract-input-hash"]);
		expect(await refusal({}, { ...contract, providerPromptSha256: "f".repeat(64) })).toEqual(["contract-prompt-hash"]);
		// A roster edit before preflight (alias added) changes both digests but not the entity set.
		const aliased = entities.map((e) => (e.key === WGV ? { ...e, aliases: ["Württembergische"] } : e));
		expect(await refusal({ loadEntities: vi.fn(async () => aliased) })).toEqual([
			"contract-input-hash",
			"contract-prompt-hash",
		]);
	});

	it("refuses a watchdog that does not outlast the request deadline", async () => {
		await expect(runSentimentCanary({ contract, deps: {}, deadlineMs: 100, watchdogMs: 100 })).rejects.toThrow(
			expect.objectContaining({ code: "watchdog" }),
		);
	});
});

describe("canary verdict after the one call", () => {
	it("accepts exactly the frozen contract: one attempt, one request with the locked shape, usage within limits, exact entities", async () => {
		const provider = goodProvider();
		const { deps, usage } = storeFakes(provider);
		const report = await runSentimentCanary({ contract, deps, ...fast });
		expect(provider.runStructuredResearch).toHaveBeenCalledTimes(1);
		const [{ maxOutputTokens, webSearch, signal }] = (provider.runStructuredResearch as ReturnType<typeof vi.fn>).mock
			.calls[0] as [{ maxOutputTokens: number; webSearch: boolean; signal: AbortSignal }];
		expect(maxOutputTokens).toBe(8000);
		expect(webSearch).toBe(true);
		expect(signal).toBeInstanceOf(AbortSignal);
		expect(signal.aborted).toBe(false);
		expect(report).toMatchObject({
			preflight: { status: "passed" },
			attempts: 1,
			providerCalls: 1,
			outcome: {
				status: "classified",
				entities: 2,
				entityKeys: ["brand", WGV],
				usage: goodUsage,
				request: goodRequest,
			},
			verdict: { status: "accept" },
			deadlineMs: 1000,
			watchdogMs: 2000,
			classifierVersion: SENTIMENT_CLASSIFIER_VERSION,
			taxonomyVersion: SENTIMENT_TAXONOMY_VERSION,
		});
		expect(usage).toEqual([expect.objectContaining({ succeeded: true, actualCostUsd: 0.0234 })]);
		expect(JSON.stringify(report)).not.toContain("ARAG Aktiv");
	});

	const rejected = async (provider: Provider, expected: string[]) => {
		const { deps, usage, marks } = storeFakes(provider);
		const report = await runSentimentCanary({ contract, deps, ...fast });
		expect(provider.runStructuredResearch).toHaveBeenCalledTimes(1);
		expect(report.attempts).toBe(1);
		expect(codes(report)).toEqual(expected);
		return { report, usage, marks, deps };
	};

	it("rejects when the provider reported no usage", async () => {
		await rejected(goodProvider({ usage: undefined, request: goodRequest }), ["usage-missing"]);
	});

	it("rejects an unknown (unreported) web-search count", async () => {
		await rejected(goodProvider({ usage: { ...goodUsage, webSearchRequests: null }, request: goodRequest }), [
			"web-search-count-unknown",
		]);
	});

	it("rejects a conflicting web-search count", async () => {
		await rejected(
			goodProvider({
				usage: { ...goodUsage, webSearchRequests: null, webSearchRequestsConflict: true },
				request: goodRequest,
			}),
			["web-search-count-conflict"],
		);
	});

	it("rejects zero web searches and more than one", async () => {
		const zero = await rejected(goodProvider({ usage: { ...goodUsage, webSearchRequests: 0 }, request: goodRequest }), [
			"web-search-count",
		]);
		expect(zero.report.verdict).toEqual({ status: "reject", reasons: [{ code: "web-search-count", detail: "0" }] });
		await rejected(goodProvider({ usage: { ...goodUsage, webSearchRequests: 2 }, request: goodRequest }), [
			"web-search-count",
		]);
	});

	it("rejects a missing, negative or over-limit cost", async () => {
		await rejected(goodProvider({ usage: { ...goodUsage, costUsd: null }, request: goodRequest }), ["cost-missing"]);
		await rejected(goodProvider({ usage: { ...goodUsage, costUsd: -0.01 }, request: goodRequest }), ["cost-missing"]);
		await rejected(goodProvider({ usage: { ...goodUsage, costUsd: 0.1001 }, request: goodRequest }), ["cost-exceeded"]);
		const atLimit = goodProvider({
			usage: { ...goodUsage, costUsd: SENTIMENT_CANARY_LIMITS.maxCostUsd },
			request: goodRequest,
		});
		const { deps } = storeFakes(atLimit);
		expect((await runSentimentCanary({ contract, deps, ...fast })).verdict).toEqual({ status: "accept" });
	});

	it("rejects missing or over-limit output tokens", async () => {
		await rejected(goodProvider({ usage: { ...goodUsage, outputTokens: null }, request: goodRequest }), [
			"output-tokens-missing",
		]);
		await rejected(goodProvider({ usage: { ...goodUsage, outputTokens: 8001 }, request: goodRequest }), [
			"output-tokens-exceeded",
		]);
	});

	it("rejects when the request shape cannot be verified or differs from the locked one", async () => {
		await rejected(goodProvider({ usage: goodUsage, request: undefined }), ["request-unverified"]);
		await rejected(
			goodProvider({
				usage: goodUsage,
				request: { model: "openai/gpt-5.6-luna", webSearch: false, maxToolCalls: null, maxOutputTokens: 4000 },
			}),
			["request-model", "request-web-search", "request-max-tool-calls", "request-max-tokens"],
		);
	});

	it("rejects an unexpected entity in the answer: the classifier refuses it, nothing is written, the attempt is one paid failure", async () => {
		const extra = {
			entities: [
				...goodAnswer.entities,
				{
					key: "c-huk",
					score: 50,
					category: "neutral",
					confidence: 0.5,
					evidence: [{ quote: "WGV PBV Optimal", polarity: "neutral" }],
					aspects: [],
				},
			],
		};
		const { report, marks, deps } = await rejected(goodProvider(undefined, extra), ["validation"]);
		expect(report.verdict).toEqual({ status: "reject", reasons: [{ code: "validation", detail: "unknown-entity" }] });
		expect(deps.persist).not.toHaveBeenCalled();
		expect(marks).toEqual([expect.objectContaining({ status: "failed", errorCode: "unknown-entity" })]);
	});

	it("rejects a missing entity in the answer", async () => {
		const missing = { entities: goodAnswer.entities.slice(0, 1) };
		const { report } = await rejected(goodProvider(undefined, missing), ["validation"]);
		expect(report.verdict).toEqual({ status: "reject", reasons: [{ code: "validation", detail: "missing-entity" }] });
	});

	it("rejects a classification whose entity keys drift from the contract even when the job reports success", async () => {
		const job = vi.fn(async () => ({
			status: "classified" as const,
			entities: 2,
			entityKeys: ["brand", "c-huk"],
			usage: goodUsage,
			request: goodRequest,
		}));
		const { deps } = storeFakes(goodProvider());
		const report = await runSentimentCanary({ contract, deps, job, ...fast });
		expect(codes(report)).toEqual(["provider-calls", "entities-mismatch"]);
	});

	it("a provider failure is one attempt: the real job core marks it failed once, nothing is retried or re-sent", async () => {
		const provider = {
			id: "openrouter",
			runStructuredResearch: vi.fn(async () => {
				throw new Error("OpenRouter API error (503): upstream unavailable; Authorization: Bearer sk-or-leak");
			}),
		} as unknown as Provider;
		const { report, marks, usage, deps } = await rejected(provider, ["provider-error"]);
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(provider.runStructuredResearch).toHaveBeenCalledTimes(1);
		expect(deps.claimAnalysis).toHaveBeenCalledTimes(1);
		expect(marks).toEqual([expect.objectContaining({ status: "failed", errorCode: "provider" })]);
		expect(usage).toEqual([expect.objectContaining({ succeeded: false })]);
		expect(report.outcome).toEqual({ status: "error", name: "SentimentJobError", code: "provider", httpStatus: 503 });
		expect(report.verdict).toEqual({ status: "reject", reasons: [{ code: "provider-error", detail: "503" }] });
		expect(JSON.stringify(report)).not.toMatch(/sk-or-|Authorization|upstream unavailable/);
	});

	it("an unconfigured provider fails closed without a request", async () => {
		const { deps } = storeFakes(goodProvider(), {
			resolveProvider: () => {
				const error = new Error("Sentiment classification requires OPENROUTER_API_KEY");
				error.name = "SentimentProviderError";
				throw error;
			},
		});
		const report = await runSentimentCanary({ contract, deps, ...fast });
		expect(report.providerCalls).toBe(0);
		expect(codes(report)).toEqual(["provider-calls", "provider-unconfigured"]);
	});

	it("a non-classifying job outcome is rejected with its status", async () => {
		const { deps } = storeFakes(goodProvider(), {
			claimAnalysis: vi.fn(async () => ({ claimed: false as const, status: "processing" as const })),
		});
		const report = await runSentimentCanary({ contract, deps, ...fast });
		expect(report.verdict).toEqual({
			status: "reject",
			reasons: [
				{ code: "provider-calls", detail: "0" },
				{ code: "job-outcome", detail: "claimed-elsewhere" },
			],
		});
	});

	it("evaluates an absent outcome and wrong attempt counts as rejections", () => {
		expect(evaluateSentimentCanary(contract, null, { attempts: 0, providerCalls: 0 })).toEqual({
			status: "reject",
			reasons: [
				{ code: "attempts", detail: "0" },
				{ code: "provider-calls", detail: "0" },
				{ code: "job-outcome", detail: "none" },
			],
		});
		expect(
			evaluateSentimentCanary(
				contract,
				{ status: "classified", entities: 2, entityKeys: ["brand", WGV], usage: goodUsage, request: goodRequest },
				{ attempts: 1, providerCalls: 2 },
			),
		).toEqual({ status: "reject", reasons: [{ code: "provider-calls", detail: "2" }] });
	});
});

describe("E2: the exact classifier input is re-checked at the provider boundary", () => {
	/** Preflight sees the frozen roster/mentions; the job's own reload sees the changed ones. */
	const drifting = <T>(first: T, later: T) => {
		let calls = 0;
		return vi.fn(async () => (++calls === 1 ? first : later));
	};
	const refusedAtBoundary = async (overrides: Partial<SentimentJobDeps>, expected: string[]) => {
		const provider = goodProvider();
		const { deps, usage, marks } = storeFakes(provider, overrides);
		const report = await runSentimentCanary({ contract, deps, ...fast });
		expect(report.preflight).toEqual({ status: "passed" });
		expect(provider.runStructuredResearch).not.toHaveBeenCalled();
		expect(report.providerCalls).toBe(0);
		expect(deps.persist).not.toHaveBeenCalled();
		expect(usage).toEqual([]);
		expect(marks).toEqual([expect.objectContaining({ status: "failed", errorCode: "canary-input-drift" })]);
		expect(report.outcome).toMatchObject({ status: "error", name: "SentimentJobError", code: "canary-input-drift" });
		expect(codes(report)).toEqual(expected);
	};

	it("a competitor renamed between preflight and the call: no request", async () => {
		const renamed = entities.map((e) => (e.key === WGV ? { ...e, name: "WGV Versicherung" } : e));
		await refusedAtBoundary({ loadEntities: drifting(entities, renamed) }, ["input-hash-drift", "prompt-hash-drift"]);
	});

	it("an alias added between preflight and the call: no request", async () => {
		const aliased = entities.map((e) => (e.key === "brand" ? { ...e, aliases: ["ARAG SE"] } : e));
		await refusedAtBoundary({ loadEntities: drifting(entities, aliased) }, ["input-hash-drift", "prompt-hash-drift"]);
	});

	it("a different storage order of the same mentions between preflight and the call is not drift: one call, accepted", async () => {
		const provider = goodProvider();
		const { deps } = storeFakes(provider, { loadMentions: drifting(mentions, [...mentions].reverse()) });
		const report = await runSentimentCanary({ contract, deps, ...fast });
		expect(report.preflight).toEqual({ status: "passed" });
		expect(provider.runStructuredResearch).toHaveBeenCalledTimes(1);
		expect(report.verdict).toEqual({ status: "accept" });
	});

	it("the digests the job computes are exactly the ones inspect froze", () => {
		expect(frozenDigests.classifierInputHash).toMatch(/^[0-9a-f]{64}$/);
		expect(frozenDigests.providerPromptSha256).toMatch(/^[0-9a-f]{64}$/);
		expect(frozenDigests.classifierInputHash).not.toBe(frozenDigests.providerPromptSha256);
		// Storage order is not part of the input: reordered mentions give the same canonical hash and the same prompt digest.
		const reordered = sentimentCanaryInputDigests({
			answerBody: ANSWER,
			candidates: candidatesFromMentions([...mentions].reverse(), entities),
		});
		expect(reordered).toEqual(frozenDigests);
	});
});

describe("E1: the post-call gate runs before persistence", () => {
	const gated = async (provider: Provider, expected: string[]) => {
		const { deps, usage, marks } = storeFakes(provider);
		const report = await runSentimentCanary({ contract, deps, ...fast });
		expect(provider.runStructuredResearch).toHaveBeenCalledTimes(1);
		expect(report.providerCalls).toBe(1);
		expect(codes(report)).toEqual(expected);
		// The provider answered and was paid: exactly one success attribution with the reported cost, no failed event.
		expect(usage).toEqual([expect.objectContaining({ succeeded: true })]);
		// Nothing was written: the analysis fails with the contract code, observations are never touched.
		expect(deps.persist).not.toHaveBeenCalled();
		expect(marks).toEqual([expect.objectContaining({ status: "failed", errorCode: "canary-contract" })]);
		expect(report.outcome).toMatchObject({ status: "error", name: "SentimentJobError", code: "canary-contract" });
		return { report, usage };
	};

	it("cost above the threshold: rejected without persisting, the paid call attributed once with its cost", async () => {
		const { usage } = await gated(goodProvider({ usage: { ...goodUsage, costUsd: 0.1001 }, request: goodRequest }), [
			"cost-exceeded",
		]);
		expect(usage).toEqual([expect.objectContaining({ succeeded: true, actualCostUsd: 0.1001 })]);
	});

	it("usage missing", async () => {
		const { usage } = await gated(goodProvider({ usage: undefined, request: goodRequest }), ["usage-missing"]);
		expect(usage).toEqual([expect.objectContaining({ succeeded: true, actualCostUsd: null })]);
	});

	it("web-search count unknown, conflicting, zero and more than one", async () => {
		await gated(goodProvider({ usage: { ...goodUsage, webSearchRequests: null }, request: goodRequest }), [
			"web-search-count-unknown",
		]);
		await gated(
			goodProvider({
				usage: { ...goodUsage, webSearchRequests: null, webSearchRequestsConflict: true },
				request: goodRequest,
			}),
			["web-search-count-conflict"],
		);
		await gated(goodProvider({ usage: { ...goodUsage, webSearchRequests: 0 }, request: goodRequest }), [
			"web-search-count",
		]);
		await gated(goodProvider({ usage: { ...goodUsage, webSearchRequests: 2 }, request: goodRequest }), [
			"web-search-count",
		]);
	});

	it("cost missing or invalid", async () => {
		await gated(goodProvider({ usage: { ...goodUsage, costUsd: null }, request: goodRequest }), ["cost-missing"]);
		await gated(goodProvider({ usage: { ...goodUsage, costUsd: -1 }, request: goodRequest }), ["cost-missing"]);
	});

	it("output tokens missing, invalid or above the cap", async () => {
		await gated(goodProvider({ usage: { ...goodUsage, outputTokens: null }, request: goodRequest }), [
			"output-tokens-missing",
		]);
		await gated(goodProvider({ usage: { ...goodUsage, outputTokens: -5 }, request: goodRequest }), [
			"output-tokens-missing",
		]);
		await gated(goodProvider({ usage: { ...goodUsage, outputTokens: 8001 }, request: goodRequest }), [
			"output-tokens-exceeded",
		]);
	});

	it("request summary missing or drifted", async () => {
		await gated(goodProvider({ usage: goodUsage, request: undefined }), ["request-unverified"]);
		await gated(
			goodProvider({
				usage: goodUsage,
				request: { model: "openai/gpt-5.6-luna", webSearch: false, maxToolCalls: 2, maxOutputTokens: 4000 },
			}),
			["request-model", "request-web-search", "request-max-tool-calls", "request-max-tokens"],
		);
	});

	it("a mention set that drifts after preflight is refused at the boundary before any request", async () => {
		const drifted: StoredMention[] = [
			mentions[0],
			{ id: "m3", key: "c-huk", entityType: "competitor", competitorId: "c-huk", entityName: "HUK-COBURG" },
		];
		let loads = 0;
		const provider = goodProvider();
		const { deps, usage } = storeFakes(provider, {
			loadMentions: vi.fn(async () => (++loads === 1 ? mentions : drifted)),
		});
		const report = await runSentimentCanary({ contract, deps, ...fast });
		expect(provider.runStructuredResearch).not.toHaveBeenCalled();
		expect(deps.persist).not.toHaveBeenCalled();
		expect(usage).toEqual([]);
		expect(codes(report)).toEqual(["input-hash-drift", "prompt-hash-drift"]);
	});

	it("entity keys that still differ after a validated answer are rejected before persistence", async () => {
		// Only reachable by bypassing the classifier's own candidate check; the gate must still hold.
		const { deps, usage, marks } = storeFakes(goodProvider(), {
			classify: vi.fn(async () => ({
				entities: [
					{ key: "brand", score: 80, category: "positive" as const, confidence: 0.9, evidence: [], aspects: [] },
					{ key: "c-huk", score: 50, category: "neutral" as const, confidence: 0.5, evidence: [], aspects: [] },
				],
				provider: "openrouter",
				model: "openai/gpt-5-mini",
				webSearch: true,
				classifierVersion: SENTIMENT_CLASSIFIER_VERSION,
				taxonomyVersion: SENTIMENT_TAXONOMY_VERSION,
				inputHash: frozenDigests.classifierInputHash,
				usage: goodUsage,
				request: goodRequest,
			})),
		});
		const report = await runSentimentCanary({ contract, deps, ...fast });
		expect(deps.persist).not.toHaveBeenCalled();
		expect(codes(report)).toEqual(["provider-calls", "entities-mismatch"]);
		expect(usage).toEqual([expect.objectContaining({ succeeded: true, actualCostUsd: 0.0234 })]);
		expect(marks).toEqual([expect.objectContaining({ status: "failed", errorCode: "canary-contract" })]);
	});

	it("accept path persists exactly once", async () => {
		const { deps } = storeFakes(goodProvider());
		const report = await runSentimentCanary({ contract, deps, ...fast });
		expect(report.verdict).toEqual({ status: "accept" });
		expect(deps.persist).toHaveBeenCalledTimes(1);
	});
});

describe("canary deadline and watchdog share one abort signal", () => {
	it("a hanging provider request is aborted by the request deadline through the real job core", async () => {
		const provider = {
			id: "openrouter",
			runStructuredResearch: vi.fn(
				({ signal }: { signal?: AbortSignal }) =>
					new Promise((_resolve, reject) => {
						signal?.addEventListener("abort", () => reject(signal.reason ?? new DOMException("aborted", "AbortError")));
					}),
			),
		} as unknown as Provider;
		const { deps, marks, usage } = storeFakes(provider);
		const started = Date.now();
		const report = await runSentimentCanary({ contract, deps, deadlineMs: 60, watchdogMs: 1000 });
		const elapsed = Date.now() - started;
		expect(provider.runStructuredResearch).toHaveBeenCalledTimes(1);
		const [{ signal, maxOutputTokens }] = (provider.runStructuredResearch as ReturnType<typeof vi.fn>).mock
			.calls[0] as [{ signal: AbortSignal; maxOutputTokens: number }];
		expect(signal.aborted).toBe(true);
		expect((signal.reason as DOMException).name).toBe("TimeoutError");
		expect(maxOutputTokens).toBe(8000);
		expect(elapsed).toBeLessThan(900);
		expect(report.outcome).toMatchObject({ status: "error", name: "SentimentJobError", code: "aborted" });
		expect(report.verdict).toEqual({ status: "reject", reasons: [{ code: "request-deadline" }] });
		expect(marks).toEqual([expect.objectContaining({ status: "failed", errorCode: "aborted" })]);
		expect(usage).toEqual([expect.objectContaining({ succeeded: false })]);
	});

	it("a provider that ignores the abort is ended by the watchdog, which aborts the same signal; its late answer is attributed once but never written and never re-sent", async () => {
		let lateAnswer: (() => void) | undefined;
		let observedSignal: AbortSignal | undefined;
		const provider = {
			id: "openrouter",
			runStructuredResearch: vi.fn(
				({ signal, schema }: { signal: AbortSignal; schema: { parse: (v: unknown) => unknown } }) =>
					new Promise((resolve) => {
						observedSignal = signal;
						// Ignores `signal` on purpose and answers only when the test says so.
						lateAnswer = () =>
							resolve({ object: schema.parse(goodAnswer), modelVersion: "openai/gpt-5-mini", usage: goodUsage });
					}),
			),
		} as unknown as Provider;
		const { deps, marks, usage } = storeFakes(provider);
		const started = Date.now();
		const report = await runSentimentCanary({ contract, deps, deadlineMs: 50, watchdogMs: 120 });
		expect(Date.now() - started).toBeLessThan(900);
		expect(observedSignal?.aborted).toBe(true);
		expect(report.outcome).toMatchObject({ status: "error", name: "SentimentCanaryError", code: "watchdog" });
		expect(report.verdict).toEqual({ status: "reject", reasons: [{ code: "watchdog" }] });
		expect(report.providerCalls).toBe(1);
		expect(usage).toEqual([]);

		// The abandoned attempt answers late: the paid call is attributed exactly
		// once, the write is refused under the aborted signal, no second request.
		lateAnswer?.();
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(deps.persist).not.toHaveBeenCalled();
		expect(provider.runStructuredResearch).toHaveBeenCalledTimes(1);
		expect(usage).toEqual([expect.objectContaining({ succeeded: true, actualCostUsd: 0.0234 })]);
		expect(marks).toEqual([expect.objectContaining({ status: "failed", errorCode: "aborted" })]);
	});

	it("the watchdog ends a job invocation that never settles", async () => {
		const job = vi.fn(() => new Promise<never>(() => {}));
		const started = Date.now();
		const { deps } = storeFakes(goodProvider());
		const report = await runSentimentCanary({ contract, deps, job, deadlineMs: 50, watchdogMs: 120 });
		expect(Date.now() - started).toBeLessThan(900);
		expect(report.outcome).toMatchObject({ status: "error", name: "SentimentCanaryError", code: "watchdog" });
		expect(job).toHaveBeenCalledTimes(1);
		const [, , options] = job.mock.calls[0] as unknown as [unknown, unknown, { signal: AbortSignal }];
		expect(options.signal.aborted).toBe(true);
	});
});
