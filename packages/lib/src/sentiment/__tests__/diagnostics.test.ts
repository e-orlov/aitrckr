/**
 * The bounded diagnostic is the only structured detail a rejected provider
 * answer may leave behind — on the analysis row, in the job outcome, in the
 * canary report and in the worker log. These tests pin its bounds and prove
 * that no answer text, completion, prompt, header or credential can travel
 * through any of those channels.
 */
import { describe, expect, it, vi } from "vitest";
import type { Provider } from "../../providers/types";
import { SENTIMENT_EVIDENCE_VERSION } from "../anchors";
import {
	runSentimentCanary,
	type SentimentCanaryContract,
	sentimentCanaryBodyDigest,
	sentimentCanaryInputDigests,
} from "../canary";
import type { DetectableEntity } from "../detector";
import {
	DIAGNOSTIC_MAX_BYTES,
	DIAGNOSTIC_REASONS,
	DIAGNOSTIC_STAGES,
	diagnostic,
	safeGenerationId,
	sentimentDiagnosticSchema,
	serializeDiagnostic,
} from "../diagnostics";
import { SentimentJobError, sanitizeSentimentError, storedErrorMessage } from "../errors";
import { SentimentValidationError } from "../errors-validation";
import { runSentimentJob, type SentimentJobDeps } from "../job";
import { candidatesFromMentions, type StoredMention, type StoredRunForSentiment } from "../store";
import {
	EVIDENCE_MAX_ITEMS,
	SENTIMENT_ASPECT_KEYS,
	SENTIMENT_CLASSIFIER_VERSION,
	SENTIMENT_DETECTOR_VERSION,
	SENTIMENT_TAXONOMY_VERSION,
	type SentimentAnalysisStatus,
} from "../types";
import { resolutionFakes } from "./resolution-fakes";

const SECRET = "sk-or-v1-THIS-MUST-NEVER-LEAK";
const ANSWER = "Zentaur Rechtsschutz ist hervorragend und PRIVATE-ANSWER-TOKEN steht hier. Bolt ist teuer.";
const PROMPT_MARKER = "You are an analyst";
const LEAKY =
	/Zentaur|hervorragend|PRIVATE-ANSWER-TOKEN|Bolt ist teuer|sk-or-|Bearer|Authorization|You are an analyst|prompt_tokens|choices/;

describe("UT-SNT-DIAG bounded diagnostic", () => {
	it("the largest instance the schema admits stays under the byte cap", () => {
		const longestReason = [...DIAGNOSTIC_REASONS].sort((a, b) => b.length - a.length)[0];
		const longestStage = [...DIAGNOSTIC_STAGES].sort((a, b) => b.length - a.length)[0];
		const longestAspect = [...SENTIMENT_ASPECT_KEYS].sort((a, b) => b.length - a.length)[0];
		const maximal = diagnostic(longestStage, longestReason, {
			entityKey: "a".repeat(64),
			aspectKey: longestAspect,
			evidenceIndex: EVIDENCE_MAX_ITEMS - 1,
			anchorId: `sha256:${"f".repeat(16)}`,
			quoteLength: 100_000,
			rawLength: 100_000,
			normalizedLength: 100_000,
			generationId: "g".repeat(64),
		});
		const serialized = serializeDiagnostic(maximal);
		expect(serialized).not.toBeNull();
		expect(Buffer.byteLength(serialized as string, "utf8")).toBeLessThanOrEqual(DIAGNOSTIC_MAX_BYTES);
	});

	it("refuses free text in every field: an answer excerpt, a prompt line or a key can never be a diagnostic value", () => {
		const base = diagnostic("evidence", "evidence-unknown-anchor");
		for (const poisoned of [
			{ ...base, entityKey: ANSWER },
			{ ...base, entityKey: "brand name with spaces" },
			{ ...base, aspectKey: "reputation" },
			{ ...base, anchorId: "Zentaur ist hervorragend" },
			{ ...base, anchorId: "s00001" },
			{ ...base, generationId: SECRET.repeat(3) },
			{ ...base, generationId: "gen id with space" },
			{ ...base, reason: "the provider said something" },
			{ ...base, stage: "answer" },
			{ ...base, evidenceIndex: EVIDENCE_MAX_ITEMS },
			{ ...base, quoteLength: -1 },
			{ ...base, quoteLength: 1.5 },
			{ ...base, excerpt: "extra field" },
		]) {
			expect(sentimentDiagnosticSchema.safeParse(poisoned).success, JSON.stringify(poisoned)).toBe(false);
			expect(serializeDiagnostic(poisoned)).toBeNull();
		}
		expect(safeGenerationId("gen-abc_123")).toBe("gen-abc_123");
		expect(safeGenerationId(`gen ${SECRET}`)).toBeNull();
		expect(safeGenerationId("x".repeat(65))).toBeNull();
		expect(safeGenerationId(42)).toBeNull();
	});

	it("sanitizing a validation error keeps only the bounded diagnostic and the numeric envelope", () => {
		const error = new SentimentValidationError(
			"evidence-unknown-anchor",
			`entity "brand": anchor "${ANSWER}" is not part of the answer`,
			diagnostic("evidence", "evidence-unknown-anchor", { entityKey: "brand", evidenceIndex: 0, anchorId: "s0007" }),
		).withEnvelope({
			generationId: "gen-1",
			request: {
				model: "openai/gpt-5-mini",
				webSearch: true,
				maxToolCalls: 1,
				maxOutputTokens: 8000,
				strictJsonSchema: true,
				requireParameters: true,
			},
			usage: {
				inputTokens: 10,
				outputTokens: 5,
				reasoningTokens: null,
				costUsd: 0.01,
				webSearchRequests: 1,
				webSearchRequestsConflict: false,
			},
		});
		// A hostile envelope: strings where numbers belong, extra keys everywhere.
		(error as { envelope: unknown }).envelope = {
			generationId: `gen ${SECRET}`,
			request: { model: SECRET, webSearch: "yes", maxToolCalls: "1", headers: { Authorization: SECRET } },
			usage: { costUsd: "0.01", inputTokens: 10, raw: { choices: [ANSWER] } },
		};
		const safe = sanitizeSentimentError(error);
		expect(safe.diagnostic).toEqual({
			stage: "evidence",
			reason: "evidence-unknown-anchor",
			entityKey: "brand",
			aspectKey: null,
			evidenceIndex: 0,
			anchorId: "s0007",
			quoteLength: null,
			rawLength: null,
			normalizedLength: null,
			generationId: "gen-1",
		});
		expect(safe.envelope).toEqual({
			generationId: null,
			// A request summary whose model is not the locked one is dropped whole: no input string is ever copied.
			request: null,
			usage: {
				inputTokens: 10,
				outputTokens: null,
				reasoningTokens: null,
				costUsd: null,
				webSearchRequests: null,
				webSearchRequestsConflict: false,
			},
		});
		const jobError = new SentimentJobError(safe);
		const everywhere = `${storedErrorMessage(safe)} ${jobError.message} ${JSON.stringify(jobError)} ${JSON.stringify(safe.diagnostic)}`;
		expect(everywhere).not.toMatch(/Zentaur|hervorragend|PRIVATE-ANSWER-TOKEN|Authorization|choices/);
		// A malformed diagnostic on the error is dropped rather than stored.
		(error as { diagnostic: unknown }).diagnostic = {
			stage: "evidence",
			reason: "evidence-unknown-anchor",
			note: ANSWER,
		};
		expect(sanitizeSentimentError(error).diagnostic).toBeNull();
	});
});

/** A provider whose every observable surface is poisoned with text that must not leak. */
function leakyProvider(): Provider & { logs: string[] } {
	const logs: string[] = [];
	return {
		id: "openrouter",
		logs,
		runStructuredResearch: vi.fn(
			async ({ schema, prompt }: { schema: { parse: (v: unknown) => unknown }; prompt: string }) => {
				expect(prompt).toContain(PROMPT_MARKER);
				return {
					// Wire shape of classifier v5; the brand's overall cites the Bolt sentence for Zentaur — grounded, terminal rejection.
					object: schema.parse({
						entities: [
							{
								key: "brand",
								category: "positive",
								score: 80,
								confidence: 0.9,
								evidence: [
									{ anchorId: "s0001", polarity: "positive" },
									{ anchorId: "s0002", polarity: "positive" },
								],
								aspects: [],
							},
							{
								key: "c-bolt",
								category: "negative",
								score: 20,
								confidence: 0.9,
								evidence: [{ anchorId: "s0002", polarity: "negative" }],
								aspects: [],
							},
						],
					}),
					modelVersion: "openai/gpt-5-mini",
					generationId: "gen-opaque-7",
					usage: {
						inputTokens: 100,
						outputTokens: 50,
						reasoningTokens: 0,
						costUsd: 0.02,
						webSearchRequests: 1,
						webSearchRequestsConflict: false,
					},
					request: {
						model: "openai/gpt-5-mini",
						webSearch: true,
						maxToolCalls: 1,
						maxOutputTokens: 8000,
						strictJsonSchema: true,
						requireParameters: true,
					},
				};
			},
		),
	} as unknown as Provider & { logs: string[] };
}

const RUN = "5e970007-0000-4000-8000-000000000001";
const run: StoredRunForSentiment = {
	id: RUN,
	promptId: "5e970007-0000-4000-8000-000000000002",
	brandId: "zentaur",
	provider: "openrouter",
	model: "chatgpt",
	answerBody: ANSWER,
	organizationId: "default",
};
const entities: DetectableEntity[] = [
	{ key: "brand", entityType: "brand", competitorId: null, name: "Zentaur", aliases: [], domains: [] },
	{ key: "c-bolt", entityType: "competitor", competitorId: "c-bolt", name: "Bolt", aliases: [], domains: [] },
];
const mentions: StoredMention[] = [
	{ id: "m1", key: "brand", entityType: "brand", competitorId: null, entityName: "Zentaur" },
	{ id: "m2", key: "c-bolt", entityType: "competitor", competitorId: "c-bolt", entityName: "Bolt" },
];

/** The repair the workflow requests for the unbound brand overall: grounded on the Zentaur sentence only. */
const REPAIR = {
	entities: [
		{
			key: "brand",
			category: "positive",
			score: 80,
			confidence: 0.9,
			evidence: [{ anchorId: "s0001", polarity: "positive" }],
			aspects: [],
		},
	],
};

function fakes(provider: Provider) {
	const marks: unknown[] = [];
	const usage: unknown[] = [];
	const resolution = resolutionFakes({ repairAnswer: REPAIR });
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
		markAnalysis: vi.fn(async (_claim: unknown, patch: unknown) => {
			marks.push(patch);
			return true;
		}),
		persist: vi.fn(async () => undefined),
		recordUsage: vi.fn(async (event: unknown) => {
			usage.push(event);
		}),
		resolveProvider: () => resolution.phasesProvider(provider),
		resolutionPolicy: { backoffBaseMs: 1, backoffMaxMs: 2 },
		...resolution.deps,
	};
	return { deps, marks, usage, resolution };
}

describe("UT-SNT-LEAK nothing but the bounded diagnostic leaves a rejected answer", () => {
	it("job outcome, ledger, case, usage and console carry codes, numbers and anchor ids only", async () => {
		const spies = (["log", "info", "warn", "error", "debug"] as const).map((level) =>
			vi.spyOn(console, level).mockImplementation(() => {}),
		);
		vi.stubEnv("OPENROUTER_API_KEY", SECRET);
		const provider = leakyProvider();
		const { deps, marks, usage, resolution } = fakes(provider);
		const outcome = await runSentimentJob(
			{
				promptRunId: RUN,
				classifierVersion: SENTIMENT_CLASSIFIER_VERSION,
				taxonomyVersion: SENTIMENT_TAXONOMY_VERSION,
			},
			deps,
		);
		const logged = spies.flatMap((spy) => spy.mock.calls.map((call) => call.map(String).join(" "))).join("\n");
		for (const spy of spies) spy.mockRestore();
		vi.unstubAllEnvs();

		// The unbound overall is a repair target, not a rejection: the ledger and the case carry the safe
		// diagnostic (entity key, code, anchor id), the repair fixes it, the verifier accepts, the run completes.
		expect(outcome).toMatchObject({ status: "classified", generationId: "gen-opaque-7", paidCalls: 3, repairs: 1 });
		expect(deps.persist).toHaveBeenCalledTimes(1);
		expect(usage).toEqual([
			expect.objectContaining({ succeeded: true, actualCostUsd: 0.02 }),
			expect.objectContaining({ succeeded: true }),
			expect.objectContaining({ succeeded: true }),
		]);
		expect(marks.filter((m) => (m as { status: string }).status === "failed")).toEqual([]);
		const repairPrompt = resolution.calls.find((c) => c.phase === "repair")?.prompt ?? "";
		expect(repairPrompt).toContain('key "brand" overall: evidence-entity-unbound (cited segment s0002)');
		const ledger = JSON.stringify(resolution.attempts);
		const cases = JSON.stringify([...resolution.cases.values()]);
		expect(ledger).toContain('"phase":"repair"');
		for (const surface of [
			JSON.stringify(outcome),
			JSON.stringify(marks),
			JSON.stringify(usage),
			logged,
			ledger,
			cases,
		]) {
			expect(surface).not.toMatch(LEAKY);
		}
		expect(
			Buffer.byteLength(JSON.stringify(resolution.cases.get("a1")?.unresolvedTargets ?? []), "utf8"),
		).toBeLessThanOrEqual(DIAGNOSTIC_MAX_BYTES);
		expect(sentimentDiagnosticSchema).toBeDefined();
	});

	it("the canary report of the same repaired answer is equally clean", async () => {
		const provider = leakyProvider();
		const { deps } = fakes(provider);
		const candidates = candidatesFromMentions(mentions, entities);
		const contract: SentimentCanaryContract = {
			runId: RUN,
			promptId: run.promptId,
			brandId: run.brandId,
			answerBodySha256: sentimentCanaryBodyDigest(ANSWER),
			entities: [
				{ key: "brand", entityType: "brand" },
				{ key: "c-bolt", entityType: "competitor" },
			],
			...sentimentCanaryInputDigests({ answerBody: ANSWER, candidates }),
			classifierVersion: SENTIMENT_CLASSIFIER_VERSION,
			taxonomyVersion: SENTIMENT_TAXONOMY_VERSION,
			evidenceVersion: SENTIMENT_EVIDENCE_VERSION,
			detectorVersion: SENTIMENT_DETECTOR_VERSION,
			provider: "openrouter",
			model: "openai/gpt-5-mini",
		};
		const report = await runSentimentCanary({ contract, deps, deadlineMs: 1000, watchdogMs: 2000 });
		expect(report.verdict).toEqual({ status: "accept" });
		expect(report.outcome).toMatchObject({ status: "classified", repairs: 1, paidCalls: 3, verified: true });
		expect(JSON.stringify(report)).not.toMatch(LEAKY);
	});
});
