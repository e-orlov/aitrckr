import { describe, expect, it, vi } from "vitest";
import { StructuredOutputSchemaError } from "../../providers/schema-contract";
import { StructuredResearchRequestError, StructuredResearchResponseError } from "../../providers/types";
import { breakerBackoffMs, classifyDispatchFailure, decideBreaker } from "../breaker";
import {
	isHeld,
	isPermitEffective,
	isResumeVerifyBudget,
	issuePermit,
	permitPurposeAllowsPhase,
	permitSettlementFor,
	readDispatchState,
} from "../controls";
import { enqueueSentimentBestEffort } from "../enqueue";
import { sanitizeSentimentError } from "../errors";
import type { Executor } from "../store";

const fakeExecutor = (findFirst: () => unknown) =>
	({ query: { sentimentControls: { findFirst: async () => findFirst() } } }) as unknown as Executor;

describe("dispatch control state is fail-closed", () => {
	it("an absent row is held", async () => {
		const state = await readDispatchState(fakeExecutor(() => undefined));
		expect(isHeld(state)).toBe(true);
		expect(state.readable).toBe(false);
	});

	it("an unreadable row is held and the failure is reported, not thrown", async () => {
		const state = await readDispatchState(
			fakeExecutor(() => {
				throw new Error("connection refused");
			}),
		);
		expect(isHeld(state)).toBe(true);
		expect(state.readable).toBe(false);
	});

	it("a row in an unknown state is held", async () => {
		const state = await readDispatchState(fakeExecutor(() => ({ key: "dispatch", state: "maybe", epoch: 4 })));
		expect(isHeld(state)).toBe(true);
	});

	it("only an explicit open row opens dispatch", async () => {
		const state = await readDispatchState(fakeExecutor(() => ({ key: "dispatch", state: "open", epoch: 4 })));
		expect(isHeld(state)).toBe(false);
		expect(state).toMatchObject({ state: "open", epoch: 4, readable: true });
	});
});

describe("natural enqueue under a held dispatch", () => {
	const stored = [{ id: "m1", key: "brand", entityType: "brand" as const, competitorId: null, entityName: "Alpha" }];
	const entities = [
		{ key: "brand", entityType: "brand" as const, competitorId: null, name: "Alpha", aliases: [], domains: [] },
	];

	it("creates the analysis row before reading the hold and then sends nothing", async () => {
		const calls: string[] = [];
		const send = vi.fn(async () => "job-1");
		const outcome = await enqueueSentimentBestEffort({
			promptRunId: "5e970007-0000-4000-8000-000000000001",
			brandId: "b",
			answerBody: "Alpha is fast.",
			entities,
			sender: { send },
			persist: async () => {
				calls.push("persistDetection");
				return stored;
			},
			ensureAnalysis: async () => {
				calls.push("ensureAnalysis");
				return { id: "a1" } as never;
			},
			readDispatchState: async () => {
				calls.push("readDispatchState");
				return { state: "held", epoch: 1, readable: true };
			},
		});
		expect(outcome).toEqual({ status: "held", mentions: 1 });
		expect(send).not.toHaveBeenCalled();
		expect(calls).toEqual(["persistDetection", "ensureAnalysis", "readDispatchState"]);
	});

	it("an unreadable hold is treated as held", async () => {
		const send = vi.fn(async () => "job-1");
		const outcome = await enqueueSentimentBestEffort({
			promptRunId: "5e970007-0000-4000-8000-000000000001",
			brandId: "b",
			answerBody: "Alpha is fast.",
			entities,
			sender: { send },
			persist: async () => stored,
			ensureAnalysis: async () => ({ id: "a1" }) as never,
			readDispatchState: async () => ({ state: "held", epoch: null, readable: false, error: "boom" }),
		});
		expect(outcome.status).toBe("held");
		expect(send).not.toHaveBeenCalled();
	});

	it("open dispatch sends exactly as before", async () => {
		const send = vi.fn(async () => "job-1");
		const outcome = await enqueueSentimentBestEffort({
			promptRunId: "5e970007-0000-4000-8000-000000000001",
			brandId: "b",
			answerBody: "Alpha is fast.",
			entities,
			sender: { send },
			persist: async () => stored,
			ensureAnalysis: async () => ({ id: "a1" }) as never,
			readDispatchState: async () => ({ state: "open", epoch: 2, readable: true }),
		});
		expect(outcome).toEqual({ status: "accepted", jobId: "job-1", mentions: 1 });
		expect(send).toHaveBeenCalledTimes(1);
	});
});

describe("breaker failure classification (typed fields only)", () => {
	const request = (
		httpStatus: number,
		extra: Partial<ConstructorParameters<typeof StructuredResearchRequestError>[0]> = {},
	) =>
		new StructuredResearchRequestError({
			provider: "openrouter",
			httpStatus,
			errorType: null,
			structured: true,
			carriesOutput: false,
			retryAfterMs: null,
			message: `OpenRouter API error (${httpStatus}): {}`,
			...extra,
		});
	const classOf = (error: unknown) => classifyDispatchFailure(error, sanitizeSentimentError(error));

	it("opens on a local strict-schema refusal and on a structured output-less 400 only", () => {
		expect(classOf(new StructuredOutputSchemaError([{ rule: "root-anyof", actual: true, limit: false }]))).toBe(
			"local-contract",
		);
		expect(classOf(request(400))).toBe("request-refused-400");
	});

	it("never opens on 429, 5xx, timeouts, ambiguous or paid failures", () => {
		expect(classOf(request(429, { errorType: "rate_limit_exceeded" }))).toBe("retryable");
		expect(classOf(request(503, { errorType: "provider_overloaded" }))).toBe("retryable");
		expect(classOf(request(502))).toBe("retryable");
		expect(classOf(request(408))).toBe("retryable");
		expect(classOf(request(400, { carriesOutput: true }))).toBe("response-lost");
		expect(classOf(request(400, { structured: false }))).toBe("response-lost");
		expect(classOf(new DOMException("timeout", "TimeoutError"))).toBe("response-lost");
		expect(classOf(new DOMException("aborted", "AbortError"))).toBe("response-lost");
		expect(classOf(new Error("socket hang up"))).toBe("response-lost");
		expect(
			classOf(
				new StructuredResearchResponseError("schema", {
					provider: "openrouter",
					model: "openai/gpt-5-mini",
					generationId: "gen-1",
					request: {
						model: "openai/gpt-5-mini",
						webSearch: false,
						maxToolCalls: null,
						maxOutputTokens: 8000,
						strictJsonSchema: true,
						requireParameters: true,
					},
					usage: undefined,
				}),
			),
		).toBe("paid-answer-invalid");
		for (const status of [401, 402, 403, 404, 409, 422]) expect(classOf(request(status))).toBe("other-refusal");
	});
});

describe("breaker decision and backoff", () => {
	const now = new Date("2026-09-21T12:00:00Z");
	const row = (over: Record<string, unknown>) =>
		({
			scopeKey: "rp1:x",
			state: "closed",
			openUntil: null,
			probeAttemptId: null,
			probeGeneration: 0,
			probeLeaseUntil: null,
			consecutiveFailures: 0,
			...over,
		}) as never;

	it("absent or closed rows allow; open rows block until open_until; an expired open row allows one probe", () => {
		expect(decideBreaker(null, now)).toEqual({ allow: true, probe: false });
		expect(decideBreaker(row({ state: "closed" }), now)).toEqual({ allow: true, probe: false });
		const until = new Date(now.getTime() + 60_000);
		expect(decideBreaker(row({ state: "open", openUntil: until }), now)).toEqual({
			allow: false,
			reason: "breaker-open",
			until,
		});
		expect(decideBreaker(row({ state: "open", openUntil: new Date(now.getTime() - 1) }), now)).toEqual({
			allow: true,
			probe: true,
		});
	});

	it("a half-open row with a live lease blocks everyone else; an expired lease may be taken over", () => {
		const lease = new Date(now.getTime() + 60_000);
		expect(decideBreaker(row({ state: "half_open", probeAttemptId: "a", probeLeaseUntil: lease }), now)).toEqual({
			allow: false,
			reason: "probe-in-progress",
			until: lease,
		});
		expect(
			decideBreaker(
				row({ state: "half_open", probeAttemptId: "a", probeLeaseUntil: new Date(now.getTime() - 1) }),
				now,
			),
		).toEqual({ allow: true, probe: true });
		expect(decideBreaker(row({ state: "half_open", probeAttemptId: null }), now)).toEqual({ allow: true, probe: true });
	});

	it("backs off 15 min × 2ⁿ capped at 6 h", () => {
		expect(breakerBackoffMs(1)).toBe(15 * 60_000);
		expect(breakerBackoffMs(2)).toBe(30 * 60_000);
		expect(breakerBackoffMs(3)).toBe(60 * 60_000);
		expect(breakerBackoffMs(6)).toBe(6 * 60 * 60_000);
		expect(breakerBackoffMs(40)).toBe(6 * 60 * 60_000);
	});
});

describe("permit shape and settlement contract (F-2, F-3, F-7)", () => {
	const neverExecutes = {
		transaction: async () => {
			throw new Error("issuePermit must refuse before opening a transaction");
		},
	} as unknown as Executor;
	const base = {
		promptRunId: "r",
		analysisId: "a",
		instanceId: "i",
		inputHash: "h",
		classifierVersion: "v5",
		estimatedCostBudgetUsd: 0.02,
		ttlSeconds: 60,
		actor: "t",
		reason: "r",
		correlationId: "c",
	};

	it("a resume-verify permit is exactly verify-only and bound to its manifest", async () => {
		expect(isResumeVerifyBudget({ classify: 0, repair: 0, verify: 1 })).toBe(true);
		expect(isResumeVerifyBudget({ classify: 1, repair: 0, verify: 1 })).toBe(false);
		expect(isResumeVerifyBudget({ classify: 0, repair: 1, verify: 1 })).toBe(false);
		expect(isResumeVerifyBudget({ classify: 0, repair: 0, verify: 0 })).toBe(false);
		for (const phaseBudget of [
			{ classify: 1, repair: 1, verify: 1 },
			{ classify: 0, repair: 1, verify: 1 },
			{ classify: 1, repair: 0, verify: 0 },
		] as const) {
			await expect(
				issuePermit({ ...base, purpose: "resume-verify", phaseBudget, contractSha256: "a".repeat(64) }, neverExecutes),
			).rejects.toThrow(/exactly/);
		}
		await expect(
			issuePermit({ ...base, purpose: "resume-verify", phaseBudget: { classify: 0, repair: 0, verify: 1 } }, neverExecutes),
		).rejects.toThrow(/manifest/);
		await expect(
			issuePermit(
				{ ...base, purpose: "resume-verify", phaseBudget: { classify: 0, repair: 0, verify: 1 }, contractSha256: "nope" },
				neverExecutes,
			),
		).rejects.toThrow(/manifest/);
		// A canary keeps its approved per-phase {0,1} budgets: validation passes and the transaction is reached.
		await expect(
			issuePermit({ ...base, purpose: "canary", phaseBudget: { classify: 1, repair: 0, verify: 1 } }, neverExecutes),
		).rejects.toThrow(/must refuse before opening/);
	});

	it("a purpose authorizes only its phases", () => {
		expect(permitPurposeAllowsPhase("resume-verify", "verify")).toBe(true);
		expect(permitPurposeAllowsPhase("resume-verify", "classify")).toBe(false);
		expect(permitPurposeAllowsPhase("resume-verify", "repair")).toBe(false);
		expect(permitPurposeAllowsPhase("canary", "classify")).toBe(true);
		expect(permitPurposeAllowsPhase("other", "verify")).toBe(false);
	});

	it("settlement never turns an unknown cost into a known zero", () => {
		expect(permitSettlementFor(false, null)).toEqual({ kind: "unpaid" });
		expect(permitSettlementFor(true, 0.021)).toEqual({ kind: "paid", actualCostUsd: 0.021 });
		expect(permitSettlementFor(true, 0)).toEqual({ kind: "paid", actualCostUsd: 0 });
		expect(permitSettlementFor(true, null)).toEqual({ kind: "paid-unknown-cost" });
	});

	it("live means a live state and an expiry still ahead of the database clock", () => {
		const now = new Date("2026-09-21T12:00:00Z");
		const later = new Date("2026-09-21T12:00:01Z");
		const earlier = new Date("2026-09-21T11:59:59Z");
		expect(isPermitEffective({ state: "issued", expiresAt: later }, now)).toBe(true);
		expect(isPermitEffective({ state: "active", expiresAt: later }, now)).toBe(true);
		expect(isPermitEffective({ state: "issued", expiresAt: earlier }, now)).toBe(false);
		expect(isPermitEffective({ state: "issued", expiresAt: now }, now)).toBe(false);
		expect(isPermitEffective({ state: "exhausted", expiresAt: later }, now)).toBe(false);
		expect(isPermitEffective({ state: "revoked", expiresAt: later }, now)).toBe(false);
		expect(isPermitEffective({ state: "expired", expiresAt: later }, now)).toBe(false);
	});
});
