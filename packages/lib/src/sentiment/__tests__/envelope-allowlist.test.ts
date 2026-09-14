/**
 * The paid-response envelope that survives a rejected answer must be a
 * strict allowlist: fixed model name, safe integers, finite non-negative
 * cost, booleans, an opaque generation id — and nothing that came in as an
 * arbitrary string. Proven on the helper and on every real surface a
 * rejected answer reaches: the stored error message, the thrown job error,
 * the job outcome, the worker-facing console and the canary report.
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
import { diagnostic } from "../diagnostics";
import { SentimentJobError, sanitizeSentimentError, storedErrorMessage } from "../errors";
import { SentimentValidationError } from "../errors-validation";
import { runSentimentJob, type SentimentJobDeps } from "../job";
import { candidatesFromMentions, type StoredMention, type StoredRunForSentiment } from "../store";
import {
	SENTIMENT_CLASSIFIER_VERSION,
	SENTIMENT_MODEL,
	SENTIMENT_TAXONOMY_VERSION,
	type SentimentAnalysisStatus,
} from "../types";

const SECRET = "sk-or-v1-THIS-MUST-NEVER-LEAK";
const BEARER = "Bearer sk-or-v1-THIS-MUST-NEVER-LEAK";
const ANSWER = "Quorra Rechtsschutz ist hervorragend, PRIVATE-ANSWER-TOKEN. Vantis wird nur genannt.";
const PROMPT_LINE = "You are an analyst measuring how an AI assistant";
const LEAKY = new RegExp(
	[
		SECRET,
		"Bearer",
		"Authorization",
		"Quorra",
		"hervorragend",
		"PRIVATE-ANSWER-TOKEN",
		"Vantis wird",
		PROMPT_LINE,
		"choices",
		"prompt_tokens",
	]
		.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
		.join("|"),
);

/** Every string slot of an envelope poisoned, every number slot out of range. */
const hostileEnvelope = {
	generationId: `gen ${SECRET}`,
	request: {
		model: SECRET,
		webSearch: "yes",
		maxToolCalls: -1,
		maxOutputTokens: Number.POSITIVE_INFINITY,
		headers: { Authorization: BEARER },
		prompt: PROMPT_LINE,
	},
	usage: {
		inputTokens: -5,
		outputTokens: 1.5,
		reasoningTokens: Number.NaN,
		costUsd: -0.01,
		webSearchRequests: Number.NEGATIVE_INFINITY,
		webSearchRequestsConflict: "false",
		raw: { choices: [ANSWER], prompt_tokens: "x" },
	},
};

describe("H2 the paid-response envelope is a strict allowlist", () => {
	it("a request summary whose model is not the locked one is dropped entirely, never stored as a string", () => {
		const error = new SentimentValidationError("schema", "rejected", diagnostic("provider-schema", "schema"));
		(error as { envelope: unknown }).envelope = hostileEnvelope;
		const safe = sanitizeSentimentError(error);
		expect(JSON.stringify(safe)).not.toMatch(LEAKY);
		expect(safe.envelope?.request).toBeNull();
		expect(safe.envelope?.generationId).toBeNull();
		const jobError = new SentimentJobError(safe);
		expect(`${storedErrorMessage(safe)} ${jobError.message} ${JSON.stringify(jobError)}`).not.toMatch(LEAKY);
	});

	it("the locked model keeps its summary; every other value or type for it drops the summary", () => {
		const attempt = (model: unknown) => {
			const error = new SentimentValidationError("schema", "rejected");
			(error as { envelope: unknown }).envelope = {
				generationId: "gen-1",
				request: { model, webSearch: true, maxToolCalls: 1, maxOutputTokens: 8000 },
				usage: null,
			};
			return sanitizeSentimentError(error).envelope?.request ?? null;
		};
		expect(attempt(SENTIMENT_MODEL)).toEqual({
			model: SENTIMENT_MODEL,
			webSearch: true,
			maxToolCalls: 1,
			maxOutputTokens: 8000,
		});
		for (const model of [
			SECRET,
			`${SENTIMENT_MODEL} `,
			SENTIMENT_MODEL.toUpperCase(),
			"",
			7,
			null,
			undefined,
			{ name: SENTIMENT_MODEL },
		]) {
			expect(attempt(model), JSON.stringify(model)).toBeNull();
		}
	});

	it("numeric validation matrix: counters are finite non-negative safe integers, cost a finite non-negative number, flags booleans", () => {
		const usageOf = (usage: Record<string, unknown>) => {
			const error = new SentimentValidationError("schema", "rejected");
			(error as { envelope: unknown }).envelope = {
				generationId: "gen-1",
				request: { model: SENTIMENT_MODEL, webSearch: true, maxToolCalls: 1, maxOutputTokens: 8000 },
				usage,
			};
			return sanitizeSentimentError(error).envelope?.usage ?? null;
		};
		const requestOf = (fields: Record<string, unknown>) => {
			const error = new SentimentValidationError("schema", "rejected");
			(error as { envelope: unknown }).envelope = {
				generationId: "gen-1",
				request: { model: SENTIMENT_MODEL, webSearch: true, maxToolCalls: 1, maxOutputTokens: 8000, ...fields },
				usage: null,
			};
			return sanitizeSentimentError(error).envelope?.request ?? null;
		};
		const invalidCounters = [
			-1,
			1.5,
			Number.NaN,
			Number.POSITIVE_INFINITY,
			Number.NEGATIVE_INFINITY,
			2 ** 53,
			"12",
			true,
			null,
			undefined,
			{},
		];
		for (const bad of invalidCounters) {
			expect(usageOf({ inputTokens: bad })?.inputTokens, `inputTokens ${String(bad)}`).toBeNull();
			expect(usageOf({ outputTokens: bad })?.outputTokens, `outputTokens ${String(bad)}`).toBeNull();
			expect(usageOf({ reasoningTokens: bad })?.reasoningTokens, `reasoningTokens ${String(bad)}`).toBeNull();
			expect(usageOf({ webSearchRequests: bad })?.webSearchRequests, `webSearchRequests ${String(bad)}`).toBeNull();
			expect(requestOf({ maxToolCalls: bad })?.maxToolCalls, `maxToolCalls ${String(bad)}`).toBeNull();
			expect(requestOf({ maxOutputTokens: bad })?.maxOutputTokens, `maxOutputTokens ${String(bad)}`).toBeNull();
		}
		for (const good of [0, 1, 8000, 2 ** 53 - 1]) {
			expect(usageOf({ inputTokens: good })?.inputTokens).toBe(good);
			expect(requestOf({ maxOutputTokens: good })?.maxOutputTokens).toBe(good);
		}
		for (const bad of [-0.01, Number.NaN, Number.POSITIVE_INFINITY, "0.02", null, undefined]) {
			expect(usageOf({ costUsd: bad })?.costUsd, `costUsd ${String(bad)}`).toBeNull();
		}
		for (const good of [0, 0.020047, 1.5]) expect(usageOf({ costUsd: good })?.costUsd).toBe(good);
		expect(usageOf({ webSearchRequestsConflict: "true" })?.webSearchRequestsConflict).toBe(false);
		expect(usageOf({ webSearchRequestsConflict: 1 })?.webSearchRequestsConflict).toBe(false);
		expect(usageOf({ webSearchRequestsConflict: true })?.webSearchRequestsConflict).toBe(true);
		expect(requestOf({ webSearch: "true" })?.webSearch).toBe(false);
		expect(requestOf({ webSearch: 1 })?.webSearch).toBe(false);
		// Unknown fields never survive.
		expect(Object.keys(usageOf({ raw: { choices: [ANSWER] } }) ?? {}).sort()).toEqual(
			[
				"costUsd",
				"inputTokens",
				"outputTokens",
				"reasoningTokens",
				"webSearchRequests",
				"webSearchRequestsConflict",
			].sort(),
		);
		expect(Object.keys(requestOf({ headers: { Authorization: BEARER } }) ?? {}).sort()).toEqual(
			["maxOutputTokens", "maxToolCalls", "model", "webSearch"].sort(),
		);
	});
});

const RUN = "5e970009-0000-4000-8000-000000000001";
const run: StoredRunForSentiment = {
	id: RUN,
	promptId: "5e970009-0000-4000-8000-000000000002",
	brandId: "quorra",
	provider: "openrouter",
	model: "chatgpt",
	answerBody: ANSWER,
	organizationId: "default",
};
const entities: DetectableEntity[] = [
	{ key: "brand", entityType: "brand", competitorId: null, name: "Quorra", aliases: [], domains: [] },
	{ key: "c-vantis", entityType: "competitor", competitorId: "c-vantis", name: "Vantis", aliases: [], domains: [] },
];
const mentions: StoredMention[] = [
	{ id: "m1", key: "brand", entityType: "brand", competitorId: null, entityName: "Quorra" },
	{ id: "m2", key: "c-vantis", entityType: "competitor", competitorId: "c-vantis", entityName: "Vantis" },
];
const candidates = candidatesFromMentions(mentions, entities);

/** Answers with a Mixed verdict citing one polarity only (rejected locally) and a hostile envelope on the result. */
function hostileProvider(): Provider {
	return {
		id: "openrouter",
		runStructuredResearch: vi.fn(async ({ schema }: { schema: { parse: (v: unknown) => unknown } }) => ({
			object: schema.parse({
				entities: [
					{
						key: "brand",
						score: 50,
						category: "mixed",
						confidence: 0.8,
						evidence: [{ anchorId: "s0001", polarity: "positive" }],
						aspects: [],
					},
					{
						key: "c-vantis",
						score: 50,
						category: "neutral",
						confidence: 0.9,
						evidence: [{ anchorId: "s0002", polarity: "neutral" }],
						aspects: [],
					},
				],
			}),
			modelVersion: SENTIMENT_MODEL,
			generationId: hostileEnvelope.generationId,
			request: hostileEnvelope.request,
			usage: hostileEnvelope.usage,
		})),
	} as unknown as Provider;
}

function fakes(provider: Provider) {
	const marks: unknown[] = [];
	const usage: unknown[] = [];
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
		resolveProvider: () => provider,
	};
	return { deps, marks, usage };
}

const payload = {
	promptRunId: RUN,
	classifierVersion: SENTIMENT_CLASSIFIER_VERSION,
	taxonomyVersion: SENTIMENT_TAXONOMY_VERSION,
};

describe("H2 no arbitrary string of a hostile envelope reaches any surface", () => {
	it("job outcome, analysis row, usage event and console stay clean; the request summary is dropped", async () => {
		vi.stubEnv("OPENROUTER_API_KEY", SECRET);
		const spies = (["log", "info", "warn", "error", "debug"] as const).map((level) =>
			vi.spyOn(console, level).mockImplementation(() => {}),
		);
		const { deps, marks, usage } = fakes(hostileProvider());
		const outcome = await runSentimentJob(payload, deps);
		const logged = spies.flatMap((spy) => spy.mock.calls.map((call) => call.map(String).join(" "))).join("\n");
		for (const spy of spies) spy.mockRestore();
		vi.unstubAllEnvs();
		expect(outcome).toMatchObject({
			status: "terminal-validation-failure",
			code: "mixed-needs-dual-evidence",
			envelope: {
				generationId: null,
				request: null,
				usage: { inputTokens: null, costUsd: null, webSearchRequestsConflict: false },
			},
		});
		for (const surface of [JSON.stringify(outcome), JSON.stringify(marks), JSON.stringify(usage), logged]) {
			expect(surface).not.toMatch(LEAKY);
		}
	});

	it("the canary report of the same answer is clean too", async () => {
		const { deps } = fakes(hostileProvider());
		const contract: SentimentCanaryContract = {
			runId: RUN,
			promptId: run.promptId,
			brandId: run.brandId,
			answerBodySha256: sentimentCanaryBodyDigest(ANSWER),
			entities: [
				{ key: "brand", entityType: "brand" },
				{ key: "c-vantis", entityType: "competitor" },
			],
			...sentimentCanaryInputDigests({ answerBody: ANSWER, candidates }),
			classifierVersion: SENTIMENT_CLASSIFIER_VERSION,
			taxonomyVersion: SENTIMENT_TAXONOMY_VERSION,
			evidenceVersion: SENTIMENT_EVIDENCE_VERSION,
			provider: "openrouter",
			model: SENTIMENT_MODEL,
		};
		const report = await runSentimentCanary({ contract, deps, deadlineMs: 1000, watchdogMs: 2000 });
		expect(report.verdict).toEqual({
			status: "reject",
			reasons: [{ code: "validation", detail: "mixed-needs-dual-evidence" }],
		});
		expect(report.outcome).toMatchObject({
			status: "terminal-validation-failure",
			envelope: { generationId: null, request: null },
		});
		expect(JSON.stringify(report)).not.toMatch(LEAKY);
	});
});
