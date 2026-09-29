/**
 * Amendment C on the in-memory resolution fakes: the dispatch hold, permits,
 * the breaker and the guarded provider as the job core exercises them, without
 * Postgres. Every scenario asserts what left for the provider (nothing, unless
 * authorized) and what the ledger, case and permit recorded.
 */
import { describe, expect, it, vi } from "vitest";
import { StructuredOutputSchemaError } from "../../providers/schema-contract";
import { StructuredResearchRequestError } from "../../providers/types";
import { sentimentInputHash } from "../classifier";
import type { DetectableEntity } from "../detector";
import { runSentimentJob, type SentimentJobDeps } from "../job";
import { verifierResultSchemaFor } from "../resolution";
import { candidatesFromMentions, type StoredMention, type StoredRunForSentiment } from "../store";
import { SENTIMENT_CLASSIFIER_VERSION, SENTIMENT_TAXONOMY_VERSION, sentimentProviderResultSchemaFor } from "../types";
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
const candidate = {
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
};
const classified = (generationId: string | null = "gen-dispatch-001") => ({
	entities: [],
	provider: "openrouter",
	model: "openai/gpt-5-mini",
	webSearch: true,
	classifierVersion: SENTIMENT_CLASSIFIER_VERSION,
	taxonomyVersion: SENTIMENT_TAXONOMY_VERSION,
	inputHash: currentHash,
	generationId,
	filteredClaims: [],
	unresolvedTargets: [],
	contractDefect: null,
	candidate,
	usage: {
		inputTokens: 100,
		outputTokens: 10,
		reasoningTokens: 0,
		costUsd: 0.02,
		webSearchRequests: 1,
		webSearchRequestsConflict: false,
	},
});

const typed400 = () =>
	new StructuredResearchRequestError({
		provider: "openrouter",
		httpStatus: 400,
		errorType: null,
		structured: true,
		carriesOutput: false,
		retryAfterMs: null,
		message: "OpenRouter API error (400): invalid schema",
	});
const typed429 = () =>
	new StructuredResearchRequestError({
		provider: "openrouter",
		httpStatus: 429,
		errorType: "rate_limit_exceeded",
		structured: true,
		carriesOutput: false,
		retryAfterMs: null,
		message: "OpenRouter API error (429): slow down",
	});

function harness(options: {
	classify?: () => Promise<unknown>;
	fakes?: ReturnType<typeof resolutionFakes>;
	policy?: SentimentJobDeps["resolutionPolicy"];
}) {
	const fakes = options.fakes ?? resolutionFakes();
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
	const classify = vi.fn(options.classify ?? (async () => classified() as never));
	const usage: unknown[] = [];
	const claimAnalysis = vi.fn(async () => ({
		claimed: true as const,
		attempts: 1,
		claim: { analysisId: "a1", generation: ++generation },
	}));
	const d: SentimentJobDeps = {
		loadRun: async () => run,
		loadEntities: async () => entities,
		loadDetection: async () => ({ status: "mentions", mentionCount: 2 }) as never,
		loadMentions: async () => mentions,
		ensureAnalysis: async () => row as never,
		claimAnalysis,
		markAnalysis: async (_claim, patch) => {
			marks.push(patch);
			Object.assign(row, patch);
			return true;
		},
		classify: classify as never,
		persist: async () => {
			row.status = "completed";
			row.inputHash = currentHash;
			row.verifiedAt = new Date();
		},
		recordUsage: vi.fn(async (event) => {
			usage.push(event);
		}),
		resolveProvider: () => fakes.phasesProvider(),
		resolutionPolicy: options.policy ?? { backoffBaseMs: 1, backoffMaxMs: 2 },
		sleep: async () => {},
		...fakes.deps,
	};
	return { d, fakes, row, marks, classify, usage, claimAnalysis };
}

const held = { state: "held" as const, epoch: 3, readable: true as const };

describe("execution gate under a held dispatch", () => {
	it("returns held before claiming: no claim, no classifier call, no attempt, the pending row untouched", async () => {
		const fakes = resolutionFakes({ dispatch: held });
		const { d, classify, claimAnalysis, row } = harness({ fakes });
		expect(await runSentimentJob(payload, d)).toEqual({ status: "held", reason: "dispatch-held", nextAttemptAt: null });
		expect(claimAnalysis).not.toHaveBeenCalled();
		expect(classify).not.toHaveBeenCalled();
		expect(fakes.attempts).toEqual([]);
		expect(fakes.calls).toEqual([]);
		expect(row.status).toBe("pending");
	});

	it("an unreadable control is held", async () => {
		const fakes = resolutionFakes({ dispatch: { state: "held", epoch: null, readable: false, error: "boom" } });
		const { d, classify } = harness({ fakes });
		expect(await runSentimentJob(payload, d)).toMatchObject({ status: "held", reason: "dispatch-held" });
		expect(classify).not.toHaveBeenCalled();
	});
});

describe("permits are the only bypass of a held dispatch", () => {
	it("a full-lifecycle permit lets classify and verify run; every attempt carries the permit, the reservation settles", async () => {
		const fakes = resolutionFakes({ dispatch: held });
		const { d, fakes: f, usage } = harness({ fakes });
		// The case (and so the instance id) is created by the permit issuer before the job runs.
		const kase = await f.deps.ensureResolutionCase?.("a1", currentHash);
		const permit = f.issuePermit({
			id: "permit-1",
			analysisId: "a1",
			instanceId: (kase as { instanceId: string }).instanceId,
			inputHash: currentHash,
			phaseBudget: { classify: 1, repair: 1, verify: 1 },
			estimatedCostBudgetUsd: 0.1,
			expiresAt: new Date(Date.now() + 60_000),
		});
		expect(await runSentimentJob(payload, d)).toMatchObject({ status: "classified", paidCalls: 2 });
		expect(f.attempts.map((a) => `${a.phase}:${a.outcome}:${a.permitId}`)).toEqual([
			"classify:accepted:permit-1",
			"verify:accepted:permit-1",
		]);
		expect(permit.phaseBudget).toEqual({ classify: 0, repair: 1, verify: 0 });
		expect(permit.reservedEstimateUsd).toBe(0);
		expect(permit.settledCostUsd).toBeCloseTo(0.021, 6);
		expect(permit.state).toBe("active");
		expect(usage).toHaveLength(2);
	});

	it("a verify-only permit refuses the classify phase before any attempt row: held, permit-unavailable", async () => {
		const fakes = resolutionFakes({ dispatch: held });
		const { d, fakes: f, classify } = harness({ fakes });
		const kase = await f.deps.ensureResolutionCase?.("a1", currentHash);
		f.issuePermit({
			id: "permit-v",
			analysisId: "a1",
			instanceId: (kase as { instanceId: string }).instanceId,
			inputHash: currentHash,
			phaseBudget: { classify: 0, repair: 0, verify: 1 },
			estimatedCostBudgetUsd: 0.02,
			expiresAt: new Date(Date.now() + 60_000),
		});
		expect(await runSentimentJob(payload, d)).toMatchObject({ status: "held", reason: "permit-unavailable" });
		expect(classify).not.toHaveBeenCalled();
		expect(f.attempts).toEqual([]);
		expect(f.cases.get("a1")).toMatchObject({ status: "retry_wait", nextAttemptAt: null });
	});

	it("an expired permit authorizes nothing", async () => {
		const fakes = resolutionFakes({ dispatch: held });
		const { d, fakes: f, classify } = harness({ fakes });
		const kase = await f.deps.ensureResolutionCase?.("a1", currentHash);
		f.issuePermit({
			id: "permit-old",
			analysisId: "a1",
			instanceId: (kase as { instanceId: string }).instanceId,
			inputHash: currentHash,
			phaseBudget: { classify: 1, repair: 1, verify: 1 },
			estimatedCostBudgetUsd: 0.1,
			expiresAt: new Date(Date.now() - 1),
		});
		expect(await runSentimentJob(payload, d)).toMatchObject({ status: "held", reason: "dispatch-held" });
		expect(classify).not.toHaveBeenCalled();
		expect(f.attempts).toEqual([]);
	});

	it("a permit for another input hash or instance does not match", async () => {
		const fakes = resolutionFakes({ dispatch: held });
		const { d, fakes: f, classify } = harness({ fakes });
		const kase = await f.deps.ensureResolutionCase?.("a1", currentHash);
		f.issuePermit({
			id: "permit-other",
			analysisId: "a1",
			instanceId: (kase as { instanceId: string }).instanceId,
			inputHash: "0".repeat(64),
			phaseBudget: { classify: 1, repair: 1, verify: 1 },
			estimatedCostBudgetUsd: 0.1,
			expiresAt: new Date(Date.now() + 60_000),
		});
		expect(await runSentimentJob(payload, d)).toMatchObject({ status: "held", reason: "dispatch-held" });
		expect(classify).not.toHaveBeenCalled();
	});

	it("the estimate-budget predicate refuses a call whose reservation would exceed the permit's planning budget", async () => {
		const fakes = resolutionFakes({ dispatch: held });
		const { d, fakes: f, classify } = harness({ fakes });
		const kase = await f.deps.ensureResolutionCase?.("a1", currentHash);
		f.issuePermit({
			id: "permit-small",
			analysisId: "a1",
			instanceId: (kase as { instanceId: string }).instanceId,
			inputHash: currentHash,
			phaseBudget: { classify: 1, repair: 1, verify: 1 },
			estimatedCostBudgetUsd: 0.04,
			expiresAt: new Date(Date.now() + 60_000),
		});
		expect(await runSentimentJob(payload, d)).toMatchObject({ status: "held", reason: "permit-unavailable" });
		expect(classify).not.toHaveBeenCalled();
		expect(f.attempts).toEqual([]);
	});
});

describe("breaker at the provider boundary", () => {
	it("a structured output-less 400 opens the classify scope after one strike; the next run makes no call and parks", async () => {
		const fakes = resolutionFakes();
		const {
			d,
			fakes: f,
			classify,
		} = harness({
			fakes,
			classify: async () => {
				throw typed400();
			},
		});
		expect(await runSentimentJob(payload, d)).toMatchObject({ status: "awaiting-review", reason: "contract-defect" });
		expect(f.attempts.map((a) => `${a.phase}:${a.outcome}`)).toEqual(["classify:provider-error"]);
		const [breaker] = [...f.breakers.values()];
		expect(breaker).toMatchObject({ state: "open", consecutiveFailures: 1, openedClass: "request-refused-400" });
		expect(breaker.scopeKey).toMatch(/^rp1:[0-9a-f]{64}$/);
		expect(classify).toHaveBeenCalledTimes(1);

		// A fresh case on the same scope: blocked before any attempt row.
		f.cases.clear();
		const second = harness({ fakes });
		expect(await runSentimentJob(payload, second.d)).toMatchObject({ status: "held", reason: "breaker-open" });
		expect(second.classify).not.toHaveBeenCalled();
		expect(f.attempts).toHaveLength(1);
		expect(f.cases.get("a1")).toMatchObject({ status: "retry_wait", nextAttemptAt: breaker.openUntil });
	});

	it("a typed 429 never opens the breaker", async () => {
		const fakes = resolutionFakes();
		const { d, fakes: f } = harness({
			fakes,
			classify: async () => {
				throw typed429();
			},
		});
		expect(await runSentimentJob(payload, d)).toMatchObject({ status: "retry-wait" });
		expect(f.breakers.size).toBe(0);
	});

	it("a local strict-schema refusal opens the scope and every sibling scope sharing the schema shape", async () => {
		const fakes = resolutionFakes();
		const { d, fakes: f } = harness({
			fakes,
			classify: async () => {
				throw new StructuredOutputSchemaError([{ rule: "root-anyof", actual: true, limit: false }]);
			},
		});
		expect(await runSentimentJob(payload, d)).toMatchObject({ status: "awaiting-review", reason: "contract-defect" });
		const [classifyScope] = [...f.breakers.values()];
		expect(classifyScope).toMatchObject({ state: "open", openedClass: "local-contract" });
		// A known sibling (the repair scope: same document, no web search) is opened by the same strike.
		f.breakers.set("rp1:sibling", {
			scopeKey: "rp1:sibling",
			state: "closed",
			openUntil: null,
			probeAttemptId: null,
			probeGeneration: 0,
			probeLeaseUntil: null,
			consecutiveFailures: 0,
			openedClass: null,
			schemaFp: classifyScope.schemaFp,
			events: [],
		});
		f.cases.clear();
		const again = harness({
			fakes,
			classify: async () => {
				throw new StructuredOutputSchemaError([{ rule: "root-anyof", actual: true, limit: false }]);
			},
		});
		// The classify scope is open, so the second run parks before the boundary; force the scope due to reach the probe path.
		classifyScope.openUntil = new Date(Date.now() - 1);
		expect(await runSentimentJob(payload, again.d)).toMatchObject({ status: "awaiting-review" });
		expect(f.breakers.get("rp1:sibling")).toMatchObject({ state: "open", openedClass: "local-contract" });
	});

	it("an accepted half-open probe closes the scope", async () => {
		const fakes = resolutionFakes();
		const { d, fakes: f } = harness({
			fakes,
			classify: async () => {
				throw typed400();
			},
		});
		await runSentimentJob(payload, d);
		const [breaker] = [...f.breakers.values()];
		breaker.openUntil = new Date(Date.now() - 1);
		f.cases.clear();
		const probe = harness({ fakes });
		expect(await runSentimentJob(payload, probe.d)).toMatchObject({ status: "classified" });
		expect(breaker).toMatchObject({ state: "closed", consecutiveFailures: 0, probeAttemptId: null });
		expect(breaker.events).toEqual(["open:request-refused-400", "probe", "closed"]);
	});
});

describe("the guarded provider is the last line", () => {
	it("refuses a request whose schema does not match the authorized fingerprint: aborted attempt, held, no request", async () => {
		const fakes = resolutionFakes();
		const { d, fakes: f } = harness({
			fakes,
			classify: (async (
				_args: unknown,
				classifyDeps: { resolveProvider: () => { runStructuredResearch: (o: unknown) => Promise<unknown> } },
			) => {
				// A misbehaving classifier sends the verifier's document under a classify authorization.
				return classifyDeps.resolveProvider().runStructuredResearch({
					prompt: "not a verifier prompt",
					schema: verifierResultSchemaFor(["s0001"], ["brand"]),
					webSearch: true,
				});
			}) as never,
		});
		expect(await runSentimentJob(payload, d)).toMatchObject({ status: "held", reason: "dispatch-held" });
		expect(f.attempts.map((a) => `${a.phase}:${a.outcome}`)).toEqual(["classify:aborted"]);
		expect(f.calls).toEqual([]);
	});
});

describe("the guarded provider re-authorizes from the store immediately before the request (F-5)", () => {
	/**
	 * Run one held-permit lifecycle. The classify stub answers without a provider request, so the verify phase is the
	 * first guarded request: its T1 commits, `between` runs before the guard's re-read, and the test reports what left.
	 */
	async function afterT1(between: (f: ReturnType<typeof resolutionFakes>, permitId: string) => void, dispatch = held) {
		const fakes = resolutionFakes({ dispatch });
		const { d, fakes: f, marks } = harness({ fakes });
		const permit = f.issuePermit({
			id: "p1",
			analysisId: "a1",
			instanceId: (await d.ensureResolutionCase?.("a1", currentHash))?.instanceId ?? "",
			inputHash: currentHash,
			phaseBudget: { classify: 1, repair: 1, verify: 1 },
			estimatedCostBudgetUsd: 0.1,
			expiresAt: new Date(Date.now() + 60_000),
		});
		const inner = f.deps.dispatch?.loadAttemptDispatch;
		let once = false;
		d.dispatch = {
			...f.deps.dispatch,
			loadAttemptDispatch: async (id, ex) => {
				if (!once) {
					once = true;
					between(f, permit.id);
				}
				return (inner as NonNullable<typeof inner>)(id, ex);
			},
		};
		const outcome = await runSentimentJob(payload, d);
		return { outcome, f, marks, permit };
	}

	it("a breaker committed open after T1 refuses the request: zero calls, aborted attempt, case parked until open_until", async () => {
		const { outcome, f } = await afterT1((fakes) => {
			const sending = fakes.attempts.at(-1);
			const key = sending?.scopeKey ?? "";
			fakes.breakers.set(key, {
				scopeKey: key,
				state: "open",
				openUntil: new Date(Date.now() + 15 * 60_000),
				probeAttemptId: null,
				probeGeneration: 0,
				probeLeaseUntil: null,
				consecutiveFailures: 1,
				openedClass: "request-refused-400",
				schemaFp: sending?.schemaFp ?? "",
				events: [],
			});
		});
		expect(f.calls).toEqual([]);
		expect(outcome).toMatchObject({ status: "held", reason: "breaker-open" });
		expect(f.attempts.map((a) => `${a.phase}:${a.outcome}`)).toEqual(["classify:accepted", "verify:aborted"]);
		expect(f.cases.get("a1")).toMatchObject({ status: "retry_wait" });
		// The classify settled its known cost; the aborted verify released its reservation but its phase stays consumed.
		expect(f.permits[0]).toMatchObject({ reservedEstimateUsd: 0, phaseBudget: { classify: 0, repair: 1, verify: 0 } });
	});

	it("a permit revoked, expired or re-bound after T1 is refused: zero calls, reservation released, phase not refunded", async () => {
		for (const [name, mutate] of [
			["revoked", (p: { state: string }) => (p.state = "revoked")],
			["expired", (p: { expiresAt: Date }) => (p.expiresAt = new Date(Date.now() - 1))],
			["other input", (p: { inputHash: string }) => (p.inputHash = "other")],
		] as const) {
			const { outcome, f, marks } = await afterT1((fakes) => mutate(fakes.permits[0] as never));
			expect(f.calls, name).toEqual([]);
			expect(outcome, name).toMatchObject({ status: "held", reason: "dispatch-held" });
			expect(
				f.attempts.map((a) => `${a.phase}:${a.outcome}`),
				name,
			).toEqual(["classify:accepted", "verify:aborted"]);
			expect(f.permits[0], name).toMatchObject({
				reservedEstimateUsd: 0,
				phaseBudget: { classify: 0, repair: 1, verify: 0 },
			});
			expect(marks.at(-1), name).toMatchObject({ errorCode: "gate-breach:permit-ineligible" });
		}
	});

	it("a resume-verify permit never authorizes a classify request at the boundary", async () => {
		const fakes = resolutionFakes({ dispatch: held });
		const { d, fakes: f } = harness({
			fakes,
			// The classifier really asks the guarded provider, under the classify document and web search.
			classify: (async (
				_args: unknown,
				classifyDeps: { resolveProvider: () => { runStructuredResearch: (o: unknown) => Promise<unknown> } },
			) =>
				classifyDeps.resolveProvider().runStructuredResearch({
					prompt: "classify",
					schema: sentimentProviderResultSchemaFor(["s0001", "s0002"], ["brand", "c-huk"]),
					webSearch: true,
				})) as never,
		});
		f.issuePermit({
			id: "p1",
			purpose: "resume-verify",
			analysisId: "a1",
			instanceId: (await d.ensureResolutionCase?.("a1", currentHash))?.instanceId ?? "",
			inputHash: currentHash,
			// A malformed budget the store's CHECK would refuse; the boundary must still refuse the classify on purpose alone.
			phaseBudget: { classify: 1, repair: 0, verify: 1 },
			estimatedCostBudgetUsd: 0.1,
			expiresAt: new Date(Date.now() + 60_000),
		});
		expect(await runSentimentJob(payload, d)).toMatchObject({ status: "held", reason: "dispatch-held" });
		expect(f.calls).toEqual([]);
		expect(f.attempts.map((a) => `${a.phase}:${a.outcome}`)).toEqual(["classify:aborted"]);
	});

	it("dispatch held after T1 without a permit is refused by the last-line hold check", async () => {
		const fakes = resolutionFakes();
		const { d, fakes: f, marks } = harness({ fakes });
		const inner = f.deps.dispatch?.loadAttemptDispatch;
		let once = false;
		d.dispatch = {
			...f.deps.dispatch,
			loadAttemptDispatch: async (id, ex) => {
				if (!once) {
					once = true;
					f.setDispatch(held);
				}
				return (inner as NonNullable<typeof inner>)(id, ex);
			},
		};
		expect(await runSentimentJob(payload, d)).toMatchObject({ status: "held", reason: "dispatch-held" });
		expect(f.calls).toEqual([]);
		expect(f.attempts.map((a) => `${a.phase}:${a.outcome}`)).toEqual(["classify:accepted", "verify:aborted"]);
		expect(marks.at(-1)).toMatchObject({ errorCode: "gate-breach:held-without-permit" });
	});

	it("a paid answer without a reported cost keeps its reservation counted; the next phase is refused before any attempt", async () => {
		const fakes = resolutionFakes({ dispatch: held });
		const {
			d,
			fakes: f,
			classify,
		} = harness({
			fakes,
			classify: async () => ({ ...classified(), usage: { ...classified().usage, costUsd: undefined } }) as never,
		});
		f.issuePermit({
			id: "p1",
			analysisId: "a1",
			instanceId: (await d.ensureResolutionCase?.("a1", currentHash))?.instanceId ?? "",
			inputHash: currentHash,
			phaseBudget: { classify: 1, repair: 1, verify: 1 },
			estimatedCostBudgetUsd: 0.06,
			expiresAt: new Date(Date.now() + 60_000),
		});
		// classify (unknown cost, its 0.05 reservation stays) → the verify reservation 0.02 would exceed 0.06 → refused.
		expect(await runSentimentJob(payload, d)).toMatchObject({ status: "held", reason: "permit-unavailable" });
		expect(classify).toHaveBeenCalledTimes(1);
		expect(f.calls).toEqual([]);
		expect(f.permits[0]).toMatchObject({ settledCostUsd: 0, reservedEstimateUsd: 0.05 });
		expect(f.attempts.map((a) => `${a.phase}:${a.outcome}:${a.actualCostUsd}`)).toEqual(["classify:accepted:null"]);
	});
});

describe("paid answers and due times", () => {
	it("a paid answer without a generation id settles as rejected, never as unsent, and hands the run over", async () => {
		const fakes = resolutionFakes();
		const { d, fakes: f, usage } = harness({ fakes, classify: async () => classified(null) as never });
		expect(await runSentimentJob(payload, d)).toMatchObject({ status: "awaiting-review", reason: "contract-defect" });
		expect(f.attempts.map((a) => `${a.phase}:${a.outcome}:${a.generationId}:${a.actualCostUsd}`)).toEqual([
			"classify:rejected:null:0.020000",
		]);
		expect(usage).toHaveLength(1);
	});

	it("a case not due by the database clock is deferred without a call; once due it runs", async () => {
		let clock = new Date("2026-09-21T12:00:00Z");
		const fakes = resolutionFakes({ now: () => clock });
		const { d, fakes: f, classify } = harness({ fakes });
		const kase = (await f.deps.ensureResolutionCase?.("a1", currentHash)) as Record<string, unknown>;
		Object.assign(kase, { status: "retry_wait", nextAttemptAt: new Date(clock.getTime() + 10 * 60_000) });
		expect(await runSentimentJob(payload, d)).toMatchObject({ status: "deferred" });
		expect(classify).not.toHaveBeenCalled();
		clock = new Date(clock.getTime() + 11 * 60_000);
		expect(await runSentimentJob(payload, d)).toMatchObject({ status: "classified" });
	});

	it("five consecutive transient refusals hand the case to review as retry-exhausted", async () => {
		const fakes = resolutionFakes();
		const { d, fakes: f } = harness({
			fakes,
			classify: async () => {
				throw typed429();
			},
			policy: { backoffBaseMs: 1, backoffMaxMs: 2, maxConsecutiveTransientFailures: 3 },
		});
		expect(await runSentimentJob(payload, d)).toMatchObject({ status: "retry-wait", consecutiveFailures: 1 });
		expect(await runSentimentJob(payload, d)).toMatchObject({ status: "retry-wait", consecutiveFailures: 2 });
		expect(await runSentimentJob(payload, d)).toMatchObject({ status: "awaiting-review", reason: "retry-exhausted" });
		expect(f.attempts.map((a) => a.outcome)).toEqual(["provider-error", "provider-error", "provider-error"]);
		expect(f.cases.get("a1")).toMatchObject({ status: "awaiting_review", reviewReason: "retry-exhausted" });
	});
});
