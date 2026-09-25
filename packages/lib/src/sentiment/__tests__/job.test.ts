import { describe, expect, it, vi } from "vitest";
import { type StructuredResearchOptions, StructuredResearchRequestError } from "../../providers/types";
import type { SentimentClassification } from "../classifier";
import { SentimentValidationError, sentimentInputHash } from "../classifier";
import type { DetectableEntity } from "../detector";
import { diagnostic } from "../diagnostics";
import { enqueueSentimentBestEffort } from "../enqueue";
import { ClaimLostError, SentimentJobError } from "../errors";
import { runSentimentJob, type SentimentJobDeps } from "../job";
import { ensureSentimentQueue, SENTIMENT_QUEUE_OPTIONS } from "../queue-setup";
import { SENTIMENT_VERIFIER_VERSION } from "../resolution";
import { candidatesFromMentions, type StoredMention, type StoredRunForSentiment } from "../store";
import {
	SENTIMENT_CLASSIFIER_VERSION,
	SENTIMENT_MODEL,
	SENTIMENT_PROVIDER_ID,
	SENTIMENT_QUEUE,
	SENTIMENT_TAXONOMY_VERSION,
	sentimentSingletonKey,
} from "../types";
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
	generationId: "gen-job-001",
	filteredClaims: [],
	unresolvedTargets: [],
	contractDefect: null,
	candidate: null,
};

type AnalysisStub = {
	id: string;
	status: string;
	classifierVersion: string;
	taxonomyVersion: string;
	inputHash: string | null;
	errorCode?: string | null;
};

/** The classification stub carries the internal candidate the workflow re-assesses and verifies. */
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
} as const;

const classified = {
	...classification,
	unresolvedTargets: [],
	contractDefect: null,
	candidate: candidate as never,
	usage: {
		inputTokens: 100,
		outputTokens: 10,
		reasoningTokens: 0,
		costUsd: 0.02,
		webSearchRequests: 1,
		webSearchRequestsConflict: false,
	},
};

function deps(
	overrides: Partial<SentimentJobDeps> & {
		analysis?: Partial<AnalysisStub>;
		fakes?: ReturnType<typeof resolutionFakes>;
	} = {},
) {
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
	const fakes = overrides.fakes ?? resolutionFakes();
	const { analysis: _ignored, fakes: _fakes, ...depOverrides } = overrides;
	const base: SentimentJobDeps = {
		loadRun: vi.fn(async () => run),
		loadEntities: vi.fn(async () => entities),
		loadDetection: vi.fn(async () => ({ status: "mentions", mentionCount: mentions.length }) as never),
		loadMentions: vi.fn(async () => mentions),
		persistDetection: vi.fn(async () => mentions),
		ensureAnalysis: vi.fn(async () => analysis as never),
		claimAnalysis: vi.fn(async () => ({
			claimed: true as const,
			attempts: 1,
			claim: { analysisId: "a1", generation: 7 },
		})),
		markAnalysis: vi.fn(async (_claim: unknown, patch: unknown) => {
			marks.push(patch);
			return true;
		}),
		classify: vi.fn(async () => classified),
		persist: vi.fn(async () => undefined),
		recordUsage: vi.fn(async (event: unknown) => {
			usage.push(event);
		}),
		resolveProvider: () => fakes.phasesProvider(),
		resolutionPolicy: { backoffBaseMs: 1, backoffMaxMs: 2 },
		...fakes.deps,
	};
	return { d: { ...base, ...depOverrides }, marks, usage, fakes };
}

const verifiedOutcome = {
	status: "classified",
	entities: 2,
	entityKeys: ["brand", "c-huk"],
	generationId: "gen-job-001",
	filteredClaimCount: 0,
	filteredClaimCodes: {},
	verified: true,
	verifierVersion: SENTIMENT_VERIFIER_VERSION,
	paidCalls: 2,
	repairs: 0,
	verifierRejections: 0,
};

describe("IT-SNT-001 job lifecycle (fakes)", () => {
	it("passes Flex through the guarded verifier without changing the classifier version", async () => {
		vi.stubEnv("SENTIMENT_OPENROUTER_SERVICE_TIER", "flex");
		try {
			const fakes = resolutionFakes();
			const provider = fakes.phasesProvider();
			const research = provider.runStructuredResearch!;
			const sent: unknown[] = [];
			provider.runStructuredResearch = <T>(options: StructuredResearchOptions<T>) => {
				sent.push(options);
				return research(options);
			};
			const { d } = deps({ fakes, resolveProvider: () => provider });
			expect(await runSentimentJob(payload, d)).toMatchObject({ status: "classified" });
			expect(sent).toContainEqual(expect.objectContaining({ serviceTier: "flex", webSearch: false }));
			expect(payload.classifierVersion).toBe(SENTIMENT_CLASSIFIER_VERSION);
		} finally {
			vi.unstubAllEnvs();
		}
	});
	it("claims, classifies, verifies, persists atomically and records one success usage event per paid answer", async () => {
		const { d, usage, fakes } = deps();
		const outcome = await runSentimentJob(payload, d);
		expect(outcome).toMatchObject(verifiedOutcome);
		expect(d.claimAnalysis).toHaveBeenCalledTimes(1);
		expect(d.claimAnalysis).toHaveBeenCalledWith("a1", { allowFinished: true, resumeResolution: true });
		expect(d.classify).toHaveBeenCalledTimes(1);
		expect(fakes.calls.map((c) => c.phase)).toEqual(["verify"]);
		expect(d.persist).toHaveBeenCalledWith(
			expect.objectContaining({
				claim: expect.objectContaining({ analysisId: "a1", generation: 7 }),
				promptRunId: RUN_ID,
				mentions,
				verifierVersion: SENTIMENT_VERIFIER_VERSION,
			}),
		);
		expect(usage).toEqual([
			expect.objectContaining({ succeeded: true, promptId: run.promptId, actualCostUsd: 0.02 }),
			expect.objectContaining({ succeeded: true, promptId: run.promptId, actualCostUsd: 0.001 }),
		]);
		expect(fakes.attempts.map((a) => `${a.ordinal}:${a.phase}:${a.outcome}`)).toEqual([
			"1:classify:accepted",
			"2:verify:accepted",
		]);
		expect(fakes.cases.get("a1")).toMatchObject({ automatedProviderCalls: 2 });
		expect(d.persist).toHaveBeenCalledTimes(1);
	});

	it("writes the provider's charged cost to the success usage event and falls back when usage is missing", async () => {
		const withUsage = deps();
		expect(await runSentimentJob(payload, withUsage.d)).toMatchObject({ status: "classified", costUsd: 0.021 });
		expect(withUsage.usage[0]).toMatchObject({ actualCostUsd: 0.02 });
		const withoutUsage = deps({ classify: vi.fn(async () => ({ ...classified, usage: undefined })) });
		await runSentimentJob(payload, withoutUsage.d);
		expect(withoutUsage.usage[0]).toMatchObject({ actualCostUsd: null });
	});

	it("forwards the job abort signal to the classifier", async () => {
		const controller = new AbortController();
		const { d } = deps();
		await runSentimentJob(payload, d, { signal: controller.signal });
		expect(d.classify).toHaveBeenCalledWith(expect.anything(), expect.anything(), controller.signal);
	});

	it("fence: a persist that finds the claim taken over ends as claim-lost and writes nothing else", async () => {
		const { d, marks } = deps({
			persist: vi.fn(async () => {
				throw new ClaimLostError({ analysisId: "a1", generation: 7 });
			}),
		});
		expect(await runSentimentJob(payload, d)).toEqual({ status: "claim-lost", generation: 7 });
		expect(marks).toEqual([]);
	});

	it("C4: a persistence failure after the paid answers parks the case as pending_resolution with the persistence code and never re-attributes", async () => {
		const { d, marks, usage, fakes } = deps({
			persist: vi.fn(async () => {
				throw new Error(`insert failed while writing "${run.answerBody}"`);
			}),
		});
		await expect(runSentimentJob(payload, d)).rejects.toMatchObject({ code: "persistence", kind: "store" });
		expect(usage).toHaveLength(2);
		expect(marks.at(-1)).toMatchObject({ status: "pending_resolution", errorCode: "persistence", inputHash: null });
		expect(fakes.cases.get("a1")).toMatchObject({ status: "retry_wait" });
		expect(JSON.stringify(marks)).not.toContain(run.answerBody ?? "");
	});

	it("C4: a failing usage write is retried DB-only from the recorded answer; the paid answer is never bought again", async () => {
		let failures = 0;
		const recordUsage = vi.fn(async () => {
			if (failures++ === 0) throw new Error("usage table unavailable");
		});
		const { d, fakes } = deps({ recordUsage, sleep: vi.fn(async () => {}) });
		expect(await runSentimentJob(payload, d)).toMatchObject({ status: "classified", paidCalls: 2 });
		expect(d.classify).toHaveBeenCalledTimes(1);
		expect(recordUsage).toHaveBeenCalledTimes(3);
		expect(fakes.attempts.map((a) => a.outcome)).toEqual(["accepted", "accepted"]);
	});

	it("C4: a usage write that keeps failing leaves the paid attempt for reconciliation instead of a second call", async () => {
		const recordUsage = vi.fn(async () => {
			throw new Error("usage table unavailable");
		});
		const { d, marks, fakes } = deps({ recordUsage, sleep: vi.fn(async () => {}) });
		expect(await runSentimentJob(payload, d)).toEqual({ status: "awaiting-reconciliation", attemptOrdinal: 1 });
		expect(d.classify).toHaveBeenCalledTimes(1);
		expect(fakes.attempts.map((a) => a.outcome)).toEqual(["sending"]);
		expect(fakes.cases.get("a1")).toMatchObject({ status: "awaiting_reconciliation" });
		expect(marks.at(-1)).toMatchObject({ status: "pending_resolution" });
	});

	it("C4: a persistence failure whose terminal write is refused ends claim-lost", async () => {
		const { d } = deps({
			persist: vi.fn(async () => {
				throw new Error("insert failed");
			}),
			markAnalysis: vi.fn(async () => false),
		});
		expect(await runSentimentJob(payload, d)).toEqual({ status: "claim-lost", generation: 7 });
	});

	it("fence: a provider failure whose routing write is refused ends as claim-lost, nothing more is written", async () => {
		const { d } = deps({
			classify: vi.fn(async () => {
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
			markAnalysis: vi.fn(async () => false),
		});
		expect(await runSentimentJob(payload, d)).toMatchObject({ status: "claim-lost" });
	});

	it("fence: a no-mentions completion whose write is refused ends as claim-lost", async () => {
		const { d } = deps({
			loadDetection: vi.fn(async () => ({ status: "no_mentions", mentionCount: 0 }) as never),
			markAnalysis: vi.fn(async () => false),
		});
		expect(await runSentimentJob(payload, d)).toEqual({ status: "claim-lost", generation: 7 });
	});

	it("B3: a lost claim returns a non-calling outcome — no classifier call, no write, no usage event", async () => {
		const { d, marks, usage } = deps({
			claimAnalysis: vi.fn(async () => ({ claimed: false as const, status: "processing" as const })),
		});
		expect(await runSentimentJob(payload, d)).toEqual({ status: "claimed-elsewhere", analysisStatus: "processing" });
		expect(d.classify).not.toHaveBeenCalled();
		expect(marks).toEqual([]);
		expect(usage).toEqual([]);
	});

	it("makes no provider call when the receipt says no mentions and records no_mentions", async () => {
		const { d, marks } = deps({
			loadDetection: vi.fn(async () => ({ status: "no_mentions", mentionCount: 0 }) as never),
		});
		expect(await runSentimentJob(payload, d)).toEqual({ status: "no-mentions" });
		expect(d.classify).not.toHaveBeenCalled();
		expect(marks.at(-1)).toMatchObject({ status: "no_mentions" });
	});

	it("B2: an unscanned run is detected once, receipt and rows written together, before classifying", async () => {
		const persistDetection = vi.fn(async () => mentions);
		const { d } = deps({ loadDetection: vi.fn(async () => null), persistDetection });
		expect(await runSentimentJob(payload, d)).toMatchObject(verifiedOutcome);
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
		const { d } = deps({
			loadRun: vi.fn(async () => ({ ...run, answerBody: null })),
			loadDetection: vi.fn(async () => null),
			persistDetection,
		});
		expect(await runSentimentJob(payload, d)).toEqual({ status: "no-mentions" });
		expect(persistDetection).toHaveBeenCalledWith(
			expect.objectContaining({ result: expect.objectContaining({ status: "unextractable", mentions: [] }) }),
		);
		expect(d.classify).not.toHaveBeenCalled();
	});

	it("skips a completed analysis whose input hash still matches, without any call or claim", async () => {
		const { d } = deps({ analysis: { status: "completed", inputHash: currentHash } });
		expect(await runSentimentJob(payload, d)).toEqual({ status: "already-completed" });
		expect(d.claimAnalysis).not.toHaveBeenCalled();
		expect(d.classify).not.toHaveBeenCalled();
	});

	it("B8: a completed analysis with a stale input hash (new entity after a roster edit) is reclassified", async () => {
		const { d } = deps({ analysis: { status: "completed", inputHash: "0".repeat(64) } });
		expect(await runSentimentJob(payload, d)).toMatchObject({ status: "classified", verified: true });
		expect(d.claimAnalysis).toHaveBeenCalledWith("a1", { allowFinished: true, resumeResolution: true });
	});

	it("B8: a completed analysis without a hash never counts as current; one under another taxonomy is version drift, not work", async () => {
		const stale = deps({
			analysis: { status: "completed", taxonomyVersion: "sent-aspects-v0", inputHash: currentHash },
		});
		expect(await runSentimentJob(payload, stale.d)).toMatchObject({
			status: "skipped",
			reason: expect.stringContaining("taxonomy drift"),
		});
		expect(stale.d.classify).not.toHaveBeenCalled();
		expect(stale.d.claimAnalysis).not.toHaveBeenCalled();
		const hashless = deps({ analysis: { status: "completed", inputHash: null } });
		expect(await runSentimentJob(payload, hashless.d)).toMatchObject({ status: "classified" });
	});

	it("a no_mentions analysis whose receipt still says no mentions is left alone", async () => {
		const { d } = deps({
			analysis: { status: "no_mentions" },
			loadDetection: vi.fn(async () => ({ status: "no_mentions", mentionCount: 0 }) as never),
		});
		expect(await runSentimentJob(payload, d)).toEqual({ status: "already-completed" });
		expect(d.claimAnalysis).not.toHaveBeenCalled();
	});

	it("an answer with an unresolved overall is routed to repair, never marked terminal; a valid repair completes the run", async () => {
		const fakes = resolutionFakes({
			repairAnswer: {
				entities: [
					{
						key: "c-huk",
						category: "negative",
						score: 30,
						confidence: 0.8,
						evidence: [{ anchorId: "s0002", polarity: "negative" }],
						aspects: [],
					},
				],
			},
		});
		const unresolved = {
			...classified,
			entities: classified.entities.slice(0, 1),
			unresolvedTargets: [
				{
					entityKey: "c-huk",
					reason: "evidence-entity-unbound",
					aspectKey: null,
					anchorId: "s0001",
					source: "deterministic" as const,
				},
			],
			candidate: {
				entities: [
					candidate.entities[0],
					{ ...candidate.entities[1], evidence: [{ anchorId: "s0001", polarity: "negative" }] },
				],
			} as never,
		};
		const { d, marks, usage } = deps({ fakes, classify: vi.fn(async () => unresolved) });
		expect(await runSentimentJob(payload, d)).toMatchObject({
			status: "classified",
			paidCalls: 3,
			repairs: 1,
			verifierRejections: 0,
		});
		expect(fakes.calls.map((c) => c.phase)).toEqual(["repair", "verify"]);
		expect(fakes.calls[0].prompt).toContain('key "c-huk"');
		expect(fakes.calls[0].prompt).toContain("evidence-entity-unbound");
		expect(fakes.attempts.map((a) => `${a.phase}:${a.outcome}`)).toEqual([
			"classify:rejected",
			"repair:accepted",
			"verify:accepted",
		]);
		expect(marks.filter((m) => (m as { status: string }).status === "failed")).toEqual([]);
		expect(usage).toHaveLength(3);
	});

	it("when repairs keep failing the automatic budget hands the run over as awaiting_review — an open case, not a failed result", async () => {
		const fakes = resolutionFakes({
			repairAnswer: {
				entities: [
					{
						key: "c-huk",
						category: "negative",
						score: 30,
						confidence: 0.8,
						evidence: [{ anchorId: "s0001", polarity: "negative" }],
						aspects: [],
					},
				],
			},
		});
		const unresolved = {
			...classified,
			entities: classified.entities.slice(0, 1),
			unresolvedTargets: [
				{
					entityKey: "c-huk",
					reason: "evidence-entity-unbound",
					aspectKey: null,
					anchorId: "s0001",
					source: "deterministic" as const,
				},
			],
			candidate: {
				entities: [
					candidate.entities[0],
					{ ...candidate.entities[1], evidence: [{ anchorId: "s0001", polarity: "negative" }] },
				],
			} as never,
		};
		const { d, marks, usage } = deps({ fakes, classify: vi.fn(async () => unresolved) });
		expect(await runSentimentJob(payload, d)).toMatchObject({
			status: "awaiting-review",
			reason: "call-limit",
			paidCalls: 4,
			unresolved: 1,
		});
		expect(d.persist).not.toHaveBeenCalled();
		// The fifth call would have been a repair no verification could follow; the pair rule stops one call earlier.
		expect(fakes.calls.map((c) => c.phase)).toEqual(["repair", "repair", "repair"]);
		expect(fakes.cases.get("a1")).toMatchObject({
			status: "awaiting_review",
			reviewReason: "call-limit",
			automatedProviderCalls: 4,
		});
		expect(marks.at(-1)).toMatchObject({ status: "pending_resolution", errorCode: null, inputHash: null });
		expect(usage).toHaveLength(4);
		// A further run makes no call and keeps the review item.
		const again = deps({ fakes, classify: vi.fn(async () => unresolved) });
		expect(await runSentimentJob(payload, again.d)).toMatchObject({ status: "awaiting-review" });
		expect(again.d.classify).not.toHaveBeenCalled();
	});

	it("an allow-listed typed refusal parks the case for the inventory: the job completes as retry-wait, the parked row carries no input hash, the case waits", async () => {
		const { d, marks, usage, fakes } = deps({
			classify: vi.fn(async () => {
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
		});
		expect(await runSentimentJob(payload, d)).toMatchObject({ status: "retry-wait", consecutiveFailures: 1 });
		expect(marks.at(-1)).toMatchObject({ status: "pending_resolution", errorCode: "provider", inputHash: null });
		expect(usage).toEqual([]);
		expect(fakes.attempts.map((a) => `${a.phase}:${a.outcome}:${a.generationId}`)).toEqual([
			"classify:provider-error:null",
		]);
		expect(fakes.cases.get("a1")).toMatchObject({ status: "retry_wait", automatedProviderCalls: 0 });
	});

	it("a paid answer the provider could not shape is attributed its charged cost and hands the run over as a contract defect", async () => {
		const { d, usage, fakes } = deps({
			classify: vi.fn(async () => {
				throw new SentimentValidationError(
					"invalid-json",
					"not json",
					diagnostic("provider-schema", "invalid-json"),
				).withEnvelope({
					generationId: "gen-broken-1",
					request: null,
					usage: {
						inputTokens: 1,
						outputTokens: 1,
						reasoningTokens: 0,
						costUsd: 0.007,
						webSearchRequests: 1,
						webSearchRequestsConflict: false,
					},
				});
			}),
		});
		expect(await runSentimentJob(payload, d)).toMatchObject({
			status: "awaiting-review",
			reason: "contract-defect",
			paidCalls: 1,
		});
		expect(usage).toEqual([expect.objectContaining({ succeeded: false, actualCostUsd: 0.007 })]);
		expect(fakes.attempts.map((a) => `${a.phase}:${a.outcome}:${a.generationId}`)).toEqual([
			"classify:rejected:gen-broken-1",
		]);
	});

	it("sanitizes provider errors: no key, answer text or response body reaches the row or the thrown error", async () => {
		const leaky =
			`OpenRouter API error (429): {"error":"rate limited","key":"sk-or-should-not-leak-1234567890"} ` +
			`while classifying "${run.answerBody}" Authorization: Bearer sk-or-should-not-leak-1234567890`;
		const { d, marks, fakes } = deps({
			classify: vi.fn(async () => {
				const error = new StructuredResearchRequestError({
					provider: "openrouter",
					httpStatus: 429,
					errorType: "rate_limit_exceeded",
					structured: true,
					carriesOutput: false,
					retryAfterMs: null,
					message: leaky,
				});
				(error as { cause?: unknown }).cause = { responseBody: leaky, answer: run.answerBody };
				throw error;
			}),
		});
		// Amendment C: the typed 429 parks the case as retry-wait; the outcome is the only thing the queue sees.
		const outcome = await runSentimentJob(payload, d);
		const failed = marks.at(-1) as { errorCode: string; errorMessage: string };
		const serializedRow = JSON.stringify(failed);
		const serializedOutcome = JSON.stringify(outcome);
		for (const forbidden of ["sk-or-", "rate limited", "Authorization", run.answerBody ?? "", "responseBody"]) {
			expect(serializedRow).not.toContain(forbidden);
			expect(serializedOutcome).not.toContain(forbidden);
			expect(JSON.stringify([...fakes.cases.values()])).not.toContain(forbidden);
			expect(JSON.stringify(fakes.attempts)).not.toContain(forbidden);
		}
		expect(failed.errorCode).toBe("provider");
		expect(failed.errorMessage).toBe(
			`provider provider (StructuredResearchRequestError) via ${SENTIMENT_PROVIDER_ID}/${SENTIMENT_MODEL} HTTP 429`,
		);
		expect(outcome).toMatchObject({ status: "retry-wait", consecutiveFailures: 1 });
	});

	it("an aborted request has an unknown outcome: the attempt is `aborted`, the case awaits reconciliation, nothing is retried", async () => {
		const { d, marks, fakes } = deps({
			classify: vi.fn(async () => {
				throw new DOMException("The operation was aborted", "AbortError");
			}),
		});
		expect(await runSentimentJob(payload, d)).toEqual({ status: "awaiting-reconciliation", attemptOrdinal: 1 });
		expect(marks.at(-1)).toMatchObject({ status: "pending_resolution" });
		expect(fakes.attempts.map((a) => a.outcome)).toEqual(["aborted"]);
		expect(fakes.cases.get("a1")).toMatchObject({ status: "awaiting_reconciliation" });
	});

	it("an ambiguous 5xx or a status-less transport error is never repeated automatically", async () => {
		for (const error of [new Error("OpenRouter API error (502)"), new TypeError("fetch failed")]) {
			const { d, fakes } = deps({
				classify: vi.fn(async () => {
					throw error;
				}),
			});
			expect(await runSentimentJob(payload, d)).toEqual({ status: "awaiting-reconciliation", attemptOrdinal: 1 });
			expect(fakes.attempts.map((a) => a.outcome)).toEqual(["sending"]);
			expect(d.classify).toHaveBeenCalledTimes(1);
		}
	});

	it("an attempt left in `sending` blocks every automatic call until reconciled", async () => {
		const fakes = resolutionFakes();
		const kase = await fakes.deps.ensureResolutionCase?.("a1", currentHash);
		await fakes.deps.openProviderAttempt?.({
			analysisId: "a1",
			phase: "classify",
			inputHash: currentHash,
			claim: { analysisId: "a1", generation: 1, instanceId: kase?.instanceId ?? "" },
		});
		const { d, marks } = deps({ fakes });
		expect(await runSentimentJob(payload, d)).toEqual({ status: "awaiting-reconciliation", attemptOrdinal: 1 });
		expect(d.classify).not.toHaveBeenCalled();
		expect(fakes.cases.get("a1")).toMatchObject({
			status: "awaiting_reconciliation",
			reviewReason: "unknown-provider-outcome",
		});
		expect(marks.at(-1)).toMatchObject({ status: "pending_resolution", errorCode: null });
	});

	it("skips invalid and stale payloads without touching the store", async () => {
		const { d } = deps();
		expect(await runSentimentJob({ nope: true }, d)).toMatchObject({ status: "skipped" });
		expect(await runSentimentJob({ ...payload, classifierVersion: "sent-classifier-v0" }, d)).toMatchObject({
			status: "skipped",
		});
		expect(await runSentimentJob({ ...payload, taxonomyVersion: "sent-aspects-v0" }, d)).toMatchObject({
			status: "skipped",
		});
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
		expect(SENTIMENT_QUEUE_OPTIONS).toMatchObject({
			policy: "exclusive",
			retryLimit: 3,
			retryDelay: 60,
			retryBackoff: true,
			expireInSeconds: 900,
		});
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
