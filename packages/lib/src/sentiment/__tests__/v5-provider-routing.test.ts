/**
 * Corrective Slice A1 — exact provider-outcome routing. An automatic retry is
 * granted only to a closed allow-list of typed, structured, output-free
 * refusals; every other outcome parks the run (review or reconciliation) after
 * exactly one provider call. Offline, on the in-memory resolution fakes.
 */
import { describe, expect, it, vi } from "vitest";
import { StructuredResearchRequestError } from "../../providers/types";
import { sentimentInputHash } from "../classifier";
import type { DetectableEntity } from "../detector";
import { SentimentJobError } from "../errors";
import { runSentimentJob, type SentimentJobDeps } from "../job";
import { SentimentProviderError } from "../provider";
import { candidatesFromMentions, type StoredMention, type StoredRunForSentiment } from "../store";
import { SENTIMENT_CLASSIFIER_VERSION, SENTIMENT_TAXONOMY_VERSION } from "../types";
import { resolutionFakes } from "./resolution-fakes";

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
	{ key: "c-huk", entityType: "competitor", competitorId: "c-huk", name: "HUK-COBURG", aliases: ["HUK"], domains: [] },
];
const mentions: StoredMention[] = [
	{ id: "m1", key: "brand", entityType: "brand", competitorId: null, entityName: "ARAG" },
	{ id: "m2", key: "c-huk", entityType: "competitor", competitorId: "c-huk", entityName: "HUK-COBURG" },
];
const currentHash = sentimentInputHash(run.answerBody ?? "", candidatesFromMentions(mentions, entities));
const classified = {
	entities: [],
	provider: "openrouter",
	model: "openai/gpt-5-mini",
	webSearch: true,
	classifierVersion: SENTIMENT_CLASSIFIER_VERSION,
	taxonomyVersion: SENTIMENT_TAXONOMY_VERSION,
	inputHash: currentHash,
	generationId: "gen-routing-001",
	filteredClaims: [],
	unresolvedTargets: [],
	contractDefect: null,
	candidate: {
		entities: [
			{
				key: "brand",
				score: 85,
				category: "positive",
				confidence: 0.9,
				evidence: [{ anchorId: "s0001", polarity: "positive" }],
				aspects: [],
			},
			{
				key: "c-huk",
				score: 30,
				category: "negative",
				confidence: 0.8,
				evidence: [{ anchorId: "s0002", polarity: "negative" }],
				aspects: [],
			},
		],
	},
	usage: {
		inputTokens: 100,
		outputTokens: 10,
		reasoningTokens: 0,
		costUsd: 0.02,
		webSearchRequests: 1,
		webSearchRequestsConflict: false,
	},
};

/** One analysis row shared by successive job runs of a scenario, as the store would keep it. */
function harness(
	failure: unknown,
	options: { resolveProviderError?: Error; policy?: SentimentJobDeps["resolutionPolicy"] } = {},
) {
	const fakes = resolutionFakes();
	const row = {
		id: "a1",
		status: "pending",
		classifierVersion: SENTIMENT_CLASSIFIER_VERSION,
		taxonomyVersion: SENTIMENT_TAXONOMY_VERSION,
		inputHash: null as string | null,
		verifiedAt: null as Date | null,
	};
	const marks: { status?: string; errorCode?: string | null }[] = [];
	let generation = 0;
	let firstCall = true;
	const classify = vi.fn(async () => {
		if (firstCall) {
			firstCall = false;
			throw failure;
		}
		return classified as never;
	});
	const d: SentimentJobDeps = {
		loadRun: async () => run,
		loadEntities: async () => entities,
		loadDetection: async () => ({ status: "mentions", mentionCount: 2 }) as never,
		loadMentions: async () => mentions,
		ensureAnalysis: async () => row as never,
		claimAnalysis: vi.fn(async () => ({
			claimed: true as const,
			attempts: 1,
			claim: { analysisId: "a1", generation: ++generation },
		})),
		markAnalysis: async (_claim, patch) => {
			marks.push(patch);
			Object.assign(row, patch);
			return true;
		},
		classify,
		persist: async () => {
			row.status = "completed";
			row.inputHash = currentHash;
			row.verifiedAt = new Date();
		},
		recordUsage: vi.fn(async () => {}),
		resolveProvider: () => {
			if (options.resolveProviderError) throw options.resolveProviderError;
			return fakes.phasesProvider();
		},
		resolutionPolicy: options.policy ?? { backoffBaseMs: 1, backoffMaxMs: 2 },
		sleep: async () => {},
		...fakes.deps,
	};
	return { d, fakes, row, marks, classify };
}

/** A refusal as the adapter builds it: `errorType` is the canonical `error.metadata.error_type` or null; the message is free text. */
const typed = (
	httpStatus: number,
	errorType: string | null,
	over: Partial<{ structured: boolean; carriesOutput: boolean; retryAfterMs: number | null; message: string }> = {},
) =>
	new StructuredResearchRequestError({
		provider: "openrouter",
		httpStatus,
		errorType,
		structured: true,
		carriesOutput: false,
		retryAfterMs: null,
		message: `OpenRouter API error (${httpStatus}): ${errorType ?? "no canonical type"}`,
		...over,
	});

describe("A1 closed automatic-retry allow-list", () => {
	const retryable: [string, () => unknown][] = [
		["HTTP 429 + canonical rate_limit_exceeded", () => typed(429, "rate_limit_exceeded")],
		["HTTP 503 + canonical provider_overloaded", () => typed(503, "provider_overloaded")],
		[
			"HTTP 429 + canonical rate_limit_exceeded with an arbitrary message",
			() => typed(429, "rate_limit_exceeded", { message: "OpenRouter API error (429): Too many cats" }),
		],
		[
			"HTTP 503 + canonical provider_overloaded with an arbitrary message",
			() => typed(503, "provider_overloaded", { message: "OpenRouter API error (503): Provider returned error" }),
		],
	];
	for (const [name, make] of retryable) {
		it(`${name}: an unpaid provider-error attempt, retry_wait as a completed job, the next due run completes`, async () => {
			const { d, fakes, row, marks, classify } = harness(make());
			// Amendment C: the queue never retries a parked case; the job completes with the due time and the
			// maintenance inventory re-sends it when it is due.
			expect(await runSentimentJob(payload, d)).toMatchObject({ status: "retry-wait", consecutiveFailures: 1 });
			expect(classify).toHaveBeenCalledTimes(1);
			expect(fakes.attempts.map((a) => a.outcome)).toEqual(["provider-error"]);
			expect(fakes.cases.get("a1")).toMatchObject({ status: "retry_wait" });
			expect(marks.at(-1)).toMatchObject({ status: "pending_resolution", errorCode: "provider" });
			expect(row.status).toBe("pending_resolution");
			expect(await runSentimentJob(payload, d)).toMatchObject({ status: "classified" });
			expect(classify).toHaveBeenCalledTimes(2);
		});
	}

	it("Retry-After controls the wait when present", async () => {
		const { d, fakes } = harness(typed(429, "rate_limit_exceeded", { retryAfterMs: 45_000 }), {
			policy: { backoffBaseMs: 1_000, backoffMaxMs: 900_000 },
		});
		const before = Date.now();
		expect(await runSentimentJob(payload, d)).toMatchObject({ status: "retry-wait" });
		const next = (fakes.cases.get("a1") as { nextAttemptAt: Date }).nextAttemptAt.getTime();
		expect(next - before).toBeGreaterThanOrEqual(44_000);
		expect(next - before).toBeLessThan(60_000);
	});
});

describe("A1 everything outside the allow-list makes exactly one call and parks the run", () => {
	const review: [string, () => unknown][] = [
		["400 bad_request", () => typed(400, "bad_request")],
		["401 unauthorized", () => typed(401, "unauthorized")],
		["402 insufficient_credits", () => typed(402, "insufficient_credits")],
		["403 forbidden", () => typed(403, "forbidden")],
		["404 not_found", () => typed(404, "not_found")],
		["409 conflict", () => typed(409, "conflict")],
		["422 unprocessable", () => typed(422, "unprocessable")],
	];
	for (const [name, make] of review) {
		it(`${name} → awaiting_review, provider-error row, zero automatic repeat`, async () => {
			const { d, fakes, row, classify } = harness(make());
			expect(await runSentimentJob(payload, d)).toMatchObject({ status: "awaiting-review", reason: "contract-defect" });
			expect(classify).toHaveBeenCalledTimes(1);
			expect(fakes.attempts.map((a) => a.outcome)).toEqual(["provider-error"]);
			expect(fakes.cases.get("a1")).toMatchObject({ status: "awaiting_review" });
			expect(row).toMatchObject({ status: "pending_resolution", errorCode: "provider" });
			expect(await runSentimentJob(payload, d)).toMatchObject({ status: "awaiting-review" });
			expect(classify).toHaveBeenCalledTimes(1);
		});
	}

	const reconcile: [string, () => unknown, string][] = [
		["408 request_timeout", () => typed(408, "request_timeout"), "sending"],
		["500 server", () => typed(500, "server"), "sending"],
		["502 server", () => typed(502, "server"), "sending"],
		["504 server", () => typed(504, "server"), "sending"],
		["524 timeout", () => typed(524, "timeout"), "sending"],
		["529 server", () => typed(529, "server"), "sending"],
		["generic 503 (unmapped)", () => typed(503, "unmapped"), "sending"],
		["503 provider_unavailable", () => typed(503, "provider_unavailable"), "sending"],
		["429 with an unknown error type", () => typed(429, "something_new"), "sending"],
		[
			"429 whose message says 'rate limit' but has no canonical error_type",
			() => typed(429, null, { message: "OpenRouter API error (429): Rate limit exceeded: 10 rpm" }),
			"sending",
		],
		[
			"503 whose message and raw payload say 'overloaded' but has no canonical error_type",
			() =>
				typed(503, null, { message: "OpenRouter API error (503): Provider is overloaded (raw: Engine overloaded)" }),
			"sending",
		],
		["mismatched pair 429 + provider_overloaded", () => typed(429, "provider_overloaded"), "sending"],
		["mismatched pair 503 + rate_limit_exceeded", () => typed(503, "rate_limit_exceeded"), "sending"],
		["mismatched pair 502 + provider_overloaded", () => typed(502, "provider_overloaded"), "sending"],
		[
			"typed 429 rate_limit_exceeded that carries output",
			() => typed(429, "rate_limit_exceeded", { carriesOutput: true }),
			"sending",
		],
		[
			"typed 503 provider_overloaded that carries output",
			() => typed(503, "provider_overloaded", { carriesOutput: true }),
			"sending",
		],
		[
			"429 whose body was not a structured OpenRouter error",
			() => typed(429, "rate_limit_exceeded", { structured: false }),
			"sending",
		],
		[
			"untyped 429 (plain Error with a status in the message)",
			() => new Error("OpenRouter API error (429): Too Many Requests"),
			"sending",
		],
		[
			"untyped 503 (plain Error with a status in the message)",
			() => new Error("OpenRouter API error (503): upstream unavailable"),
			"sending",
		],
		["abort", () => new DOMException("aborted", "AbortError"), "aborted"],
		["timeout", () => new DOMException("deadline passed", "TimeoutError"), "aborted"],
		["connection loss", () => new TypeError("fetch failed"), "sending"],
		["statusless error", () => new Error("socket hang up"), "sending"],
	];
	for (const [name, make, rowOutcome] of reconcile) {
		it(`${name} → awaiting_reconciliation, row ${rowOutcome}, zero automatic repeat`, async () => {
			const { d, fakes, row, classify } = harness(make());
			expect(await runSentimentJob(payload, d)).toEqual({ status: "awaiting-reconciliation", attemptOrdinal: 1 });
			expect(classify).toHaveBeenCalledTimes(1);
			expect(fakes.attempts.map((a) => a.outcome)).toEqual([rowOutcome]);
			expect(fakes.cases.get("a1")).toMatchObject({
				status: "awaiting_reconciliation",
				reviewReason: "unknown-provider-outcome",
			});
			expect(row.status).toBe("pending_resolution");
			expect(await runSentimentJob(payload, d)).toMatchObject({ status: "awaiting-reconciliation" });
			expect(classify).toHaveBeenCalledTimes(1);
		});
	}

	it("a provider that is not configured is a configuration defect: awaiting_review before any request, zero automatic repeat", async () => {
		const { d, fakes, row, classify } = harness(new Error("unused"), {
			resolveProviderError: new SentimentProviderError("OPENROUTER_API_KEY is not set"),
		});
		expect(await runSentimentJob(payload, d)).toMatchObject({ status: "awaiting-review", reason: "contract-defect" });
		expect(classify).not.toHaveBeenCalled();
		expect(fakes.attempts).toEqual([]);
		expect(fakes.cases.get("a1")).toMatchObject({ status: "awaiting_review" });
		expect(row).toMatchObject({ status: "pending_resolution", errorCode: "provider-unconfigured" });
		expect(await runSentimentJob(payload, d)).toMatchObject({ status: "awaiting-review" });
		expect(classify).not.toHaveBeenCalled();
	});
});
