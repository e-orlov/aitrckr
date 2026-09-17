/**
 * Runs against the disposable E2E test database: `pnpm -C apps/web
 * test:integration` with DATABASE_URL pointing at the seeded test stack.
 *
 * The sentiment pipeline on real Postgres, with an injected provider and no
 * network: detection receipts (IT-SNT-004), the atomic job-side claim under
 * concurrency (IT-SNT-002/IT-SNT-010), input-hash freshness (IT-SNT-011),
 * bounded evidence queries at high cardinality with EXPLAIN evidence
 * (IT-SNT-007), and cascade-safe prompt deletion (IT-SNT-012).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withResolutionPhases } from "./sentiment-test-provider";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must point at the seeded test stack");

const {
	candidatesFromMentions,
	ensureAnalysis,
	loadDetectableEntities,
	runMentionBackfill,
	runSentimentEnqueue,
	runSentimentJob,
	SENTIMENT_CLASSIFIER_VERSION,
	SENTIMENT_DETECTOR_VERSION,
	SENTIMENT_MODEL,
	SENTIMENT_TAXONOMY_VERSION,
	sentimentClassificationResultSchema,
	sentimentInputHash,
} = await import("@workspace/lib/sentiment");
const { explainSentimentEvidence, loadRunSources, loadSentimentEvidence, loadSentimentOverview } = await import(
	"@/server/sentiment-load"
);
const { loadMentions } = await import("@workspace/lib/sentiment");
const { StructuredResearchRequestError } = await import("@workspace/lib/providers/types");
type Provider = import("@workspace/lib/providers/types").Provider;
type StructuredResearchUsage = import("@workspace/lib/providers/types").StructuredResearchUsage;
type StructuredResearchRequestSummary = import("@workspace/lib/providers/types").StructuredResearchRequestSummary;

const ORG = "default";
const BRAND = "sent-pipe-brand";
const ALPHA = "5e970004-0000-4000-8000-00000000000a";
const NEWCO = "5e970004-0000-4000-8000-00000000000b";
const PROMPT = "5e970004-0000-4000-8000-000000000101";
const PROMPT_DELETE = "5e970004-0000-4000-8000-000000000102";
const RUN_MENTIONS = "5e970004-0000-4000-8000-000000000201";
const RUN_NONE = "5e970004-0000-4000-8000-000000000202";
const RUN_UNEXTRACTABLE = "5e970004-0000-4000-8000-000000000203";
const RUN_DELETE = "5e970004-0000-4000-8000-000000000204";
const RUN_ALIAS = "5e970004-0000-4000-8000-000000000205";
const RUN_SOURCES = "5e970004-0000-4000-8000-000000000206";
const RUN_OLD_TAXONOMY = "5e970004-0000-4000-8000-000000000207";
const RUN_PERSIST_FAIL = "5e970004-0000-4000-8000-000000000208";
const RUN_CANARY = "5e970004-0000-4000-8000-000000000209";
const RUN_CANARY_COST = "5e970004-0000-4000-8000-00000000020a";
const RUN_CANARY_CONFLICT = "5e970004-0000-4000-8000-00000000020b";
const RUN_CANARY_UNKNOWN = "5e970004-0000-4000-8000-00000000020c";
const RUN_CANARY_RETRY = "5e970004-0000-4000-8000-00000000020d";
const RUN_CANARY_RACE = "5e970004-0000-4000-8000-00000000020e";
const RUN_CANARY_RACE2 = "5e970004-0000-4000-8000-00000000020f";
const RUN_TERMINAL = "5e970004-0000-4000-8000-000000000210";
const ALIAS_ANSWER = "Only the alias Alphaline shows up in this answer, nothing else does.";
const ANSWER = "Alpha handles claims fast and fairly. Newco is also mentioned. Sent Pipe is fine.";

const client = new pg.Client({ connectionString: DATABASE_URL });
const payload = {
	promptRunId: RUN_MENTIONS,
	classifierVersion: SENTIMENT_CLASSIFIER_VERSION,
	taxonomyVersion: SENTIMENT_TAXONOMY_VERSION,
};

const count = async (table: string, where = "brand_id = $1", params: unknown[] = [BRAND]) =>
	(await client.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table} WHERE ${where}`, params)).rows[0].n;

/** A provider double answering every candidate key it is asked about, optionally holding at the provider boundary. */
function fakeProvider(
	options: {
		hold?: Promise<void>;
		onCall?: () => void;
		costUsd?: number;
		usage?: StructuredResearchUsage;
		request?: StructuredResearchRequestSummary;
	} = {},
): Provider {
	return {
		id: "fake-openrouter",
		name: "Fake",
		access: "api",
		isConfigured: () => true,
		async runStructuredResearch<T>({ prompt }: { prompt: string }) {
			options.onCall?.();
			if (options.hold) await options.hold;
			const keys = [...prompt.matchAll(/^- key "([^"]+)"/gm)].map((m) => m[1]);
			const object = sentimentClassificationResultSchema.parse({
				entities: keys.map((key) => ({
					key,
					score: key === "brand" ? 60 : 82,
					category: "positive",
					confidence: 0.9,
					// The answer segments into one anchor per sentence: Alpha, Newco, Sent Pipe.
					evidence: [{ anchorId: key === ALPHA ? "s0001" : key === NEWCO ? "s0002" : "s0003", polarity: "positive" }],
					aspects:
						key === ALPHA
							? [
									{
										key: "service",
										score: 85,
										category: "positive",
										confidence: 0.9,
										evidence: [{ anchorId: "s0001", polarity: "positive" }],
									},
								]
							: [],
				})),
			});
			return {
				object: object as T,
				modelVersion: SENTIMENT_MODEL,
				generationId: `gen-it-001-${Math.random().toString(36).slice(2, 10)}`,
				request: options.request,
				usage:
					options.usage ??
					(options.costUsd === undefined
						? undefined
						: {
								inputTokens: 7000,
								outputTokens: 900,
								reasoningTokens: 400,
								costUsd: options.costUsd,
								webSearchRequests: 1,
								webSearchRequestsConflict: false,
							}),
			};
		},
	} as unknown as Provider;
}

/**
 * Legacy state-machine scenarios poke the analysis row directly (`failed`,
 * `processing`). Under the resolution contract a resolved instance for the
 * same input is immutable and answers `already-completed` regardless of the
 * row, so the fixture removes the instance first: the row alone then drives
 * the scenario, as it did before resolution cases existed.
 */
async function dropResolutionInstance(runId: string) {
	await client.query(
		"DELETE FROM sentiment_resolution_cases WHERE analysis_id IN (SELECT id FROM sentiment_analyses WHERE prompt_run_id = $1)",
		[runId],
	);
}

/**
 * Stands in for the operator's reconciliation of a request whose outcome is
 * unknown (no automatic path exists by design): the dangling ledger row is
 * closed and the parked run is completed through adjudication — the same
 * deterministic validators and atomic persistence as the automatic path.
 */
async function reconcileAndAdjudicate(runId: string, entities: unknown[]) {
	const { adjudicationTemplate, applyAdjudication } = await import("@workspace/lib/sentiment");
	await client.query(
		"UPDATE sentiment_provider_attempts SET outcome = 'aborted', finished_at = now() WHERE outcome = 'sending' AND analysis_id IN (SELECT id FROM sentiment_analyses WHERE prompt_run_id = $1)",
		[runId],
	);
	const template = await adjudicationTemplate(runId);
	expect(template.status).toBe("awaiting_reconciliation");
	const applied = await applyAdjudication({
		analysisId: template.analysisId,
		inputHash: template.inputHash,
		decidedBy: "pipeline-fixture",
		entities,
	});
	expect(applied).toMatchObject({ status: "applied" });
}

/** The entities the fake provider answers for the ANSWER fixture, as an adjudication decision. */
const decisionFor = (keys: string[]) =>
	keys.map((key) => ({
		key,
		score: key === "brand" ? 60 : 82,
		category: "positive",
		confidence: 0.9,
		evidence: [{ anchorId: key === ALPHA ? "s0001" : key === NEWCO ? "s0002" : "s0003", polarity: "positive" }],
		aspects:
			key === ALPHA
				? [
						{
							key: "service",
							score: 85,
							category: "positive",
							confidence: 0.9,
							evidence: [{ anchorId: "s0001", polarity: "positive" }],
						},
					]
				: [],
	}));

async function insertRun(id: string, promptId: string, rawOutput: unknown, minutesAgo: number) {
	await client.query(
		`INSERT INTO prompt_runs (id, prompt_id, brand_id, model, provider, version, web_search_enabled, raw_output, brand_mentioned, competitors_mentioned, created_at)
		 VALUES ($1, $2, $3, 'chatgpt', 'openrouter', 'v', true, $4, true, '{}', now() - ($5 || ' minutes')::interval)`,
		[id, promptId, BRAND, JSON.stringify(rawOutput), String(minutesAgo)],
	);
}

async function cleanup() {
	await client.query("DELETE FROM usage_events WHERE brand_id = $1", [BRAND]);
	await client.query("DELETE FROM citations WHERE brand_id = $1", [BRAND]);
	await client.query("DELETE FROM prompt_runs WHERE brand_id = $1", [BRAND]);
	await client.query("DELETE FROM prompts WHERE brand_id = $1", [BRAND]);
	await client.query("DELETE FROM competitors WHERE brand_id = $1", [BRAND]);
	await client.query("DELETE FROM brands WHERE id = $1", [BRAND]);
}

beforeAll(async () => {
	const host = new URL(DATABASE_URL).hostname;
	if (!["localhost", "127.0.0.1", "::1"].includes(host)) throw new Error(`refusing non-loopback database ${host}`);
	await client.connect();
	const org = await client.query("SELECT id FROM organization WHERE slug = $1", [ORG]);
	if (org.rows.length !== 1) throw new Error("seeded organization missing — not the disposable test database");
	await cleanup();
	await client.query(
		`INSERT INTO brands (id, organization_id, slug, name, website, enabled, onboarded, created_at, updated_at)
		 VALUES ($1, $2, $1, 'Sent Pipe', 'https://sent-pipe.example.test/', true, true, now(), now())`,
		[BRAND, org.rows[0].id],
	);
	await client.query(
		`INSERT INTO competitors (id, brand_id, name, domains, aliases, active, removed_at, created_at, updated_at)
		 VALUES ($1, $2, 'Alpha', '{alpha.example.test}', '{}', true, NULL, now(), now())`,
		[ALPHA, BRAND],
	);
	// Disabled prompts: a worker sharing this database must never add runs of its own to the fixture.
	await client.query(
		`INSERT INTO prompts (id, brand_id, value, enabled, tags, system_tags, created_at, updated_at)
		 VALUES ($1, $3, 'Pipeline prompt', false, '{}', '{unbranded}', now(), now()),
		        ($2, $3, 'Prompt to delete', false, '{}', '{unbranded}', now(), now())`,
		[PROMPT, PROMPT_DELETE, BRAND],
	);
	await insertRun(RUN_MENTIONS, PROMPT, { choices: [{ message: { content: ANSWER } }] }, 30);
	await insertRun(RUN_NONE, PROMPT, { choices: [{ message: { content: "Nothing about any insurer at all." } }] }, 20);
	await insertRun(RUN_UNEXTRACTABLE, PROMPT, { choices: [] }, 10);
});

afterAll(async () => {
	await cleanup();
	await client.end();
});

describe("IT-SNT-004 detection receipts (B2)", () => {
	it("dry run → apply → dry run for mention, zero-mention and unextractable runs", async () => {
		const dry = await runMentionBackfill({ apply: false, brandId: BRAND });
		expect(dry.counts).toMatchObject({
			scanned: 3,
			withMentions: 1,
			withoutMentions: 1,
			unextractable: 1,
			written: 3,
			alreadyCurrent: 0,
		});
		expect(await count("sentiment_detections")).toBe(0);
		expect(await count("prompt_run_entity_mentions")).toBe(0);

		const apply = await runMentionBackfill({ apply: true, brandId: BRAND });
		expect(apply.counts).toMatchObject({ written: 3, alreadyCurrent: 0 });
		const receipts = await client.query<{ prompt_run_id: string; status: string; mention_count: number }>(
			"SELECT prompt_run_id, status, mention_count FROM sentiment_detections WHERE brand_id = $1 AND detector_version = $2 ORDER BY prompt_run_id",
			[BRAND, SENTIMENT_DETECTOR_VERSION],
		);
		expect(receipts.rows).toEqual([
			{ prompt_run_id: RUN_MENTIONS, status: "mentions", mention_count: 2 },
			{ prompt_run_id: RUN_NONE, status: "no_mentions", mention_count: 0 },
			{ prompt_run_id: RUN_UNEXTRACTABLE, status: "unextractable", mention_count: 0 },
		]);
		expect(await count("prompt_run_entity_mentions")).toBe(2);

		const again = await runMentionBackfill({ apply: false, brandId: BRAND });
		expect(again.counts).toMatchObject({ scanned: 3, written: 0, alreadyCurrent: 3 });
	});

	it("coverage counts current-version receipts, not runs with mention rows; eligibility follows the receipt", async () => {
		const overview = await loadSentimentOverview({
			brandId: BRAND,
			lookback: "1m",
			aspect: "overall",
			timezone: "UTC",
		});
		expect(overview.eligibleResponses).toBe(3);
		expect(overview.coverage).toMatchObject({
			responsesDetected: 3,
			responsesWithMentions: 1,
			responsesUnextractable: 1,
		});

		const inventory = await runSentimentEnqueue({ enqueue: false, brandId: BRAND });
		expect(inventory.counts).toMatchObject({ scanned: 3, eligible: 1, noMentions: 2, notScanned: 0, completed: 0 });
	});

	it("a detector-version change makes old receipts stop counting as current", async () => {
		await client.query("UPDATE sentiment_detections SET detector_version = 'sent-detector-v0' WHERE brand_id = $1", [
			BRAND,
		]);
		await client.query(
			"UPDATE prompt_run_entity_mentions SET detector_version = 'sent-detector-v0' WHERE brand_id = $1",
			[BRAND],
		);
		const overview = await loadSentimentOverview({
			brandId: BRAND,
			lookback: "1m",
			aspect: "overall",
			timezone: "UTC",
		});
		expect(overview.coverage).toMatchObject({ responsesDetected: 0, responsesWithMentions: 0 });
		const inventory = await runSentimentEnqueue({ enqueue: false, brandId: BRAND });
		expect(inventory.counts).toMatchObject({ notScanned: 3, eligible: 0, noMentions: 0 });
		const dry = await runMentionBackfill({ apply: false, brandId: BRAND });
		expect(dry.counts).toMatchObject({ written: 3, alreadyCurrent: 0 });
		// Re-apply at the current version: the old rows are refreshed in place, ids preserved.
		const before = await client.query<{ id: string }>(
			"SELECT id FROM prompt_run_entity_mentions WHERE brand_id = $1 ORDER BY id",
			[BRAND],
		);
		await runMentionBackfill({ apply: true, brandId: BRAND });
		const after = await client.query<{ id: string }>(
			"SELECT id FROM prompt_run_entity_mentions WHERE brand_id = $1 ORDER BY id",
			[BRAND],
		);
		expect(after.rows).toEqual(before.rows);
		expect(
			await count("sentiment_detections", "brand_id = $1 AND detector_version = $2", [
				BRAND,
				SENTIMENT_DETECTOR_VERSION,
			]),
		).toBe(3);
		// Receipts of the older detector stay as an audit trail; only current-version receipts are ever read.
		expect(
			await count("sentiment_detections", "brand_id = $1 AND detector_version = 'sent-detector-v0'", [BRAND]),
		).toBe(3);
		const restored = await loadSentimentOverview({
			brandId: BRAND,
			lookback: "1m",
			aspect: "overall",
			timezone: "UTC",
		});
		expect(restored.coverage).toMatchObject({
			responsesDetected: 3,
			responsesWithMentions: 1,
			responsesUnextractable: 1,
		});
	});
});

describe("IT-SNT-010 atomic job-side claim under concurrency (B3)", () => {
	it("six simultaneous runs make exactly one provider call, one observation set and one usage event", async () => {
		await ensureAnalysis({ promptRunId: RUN_MENTIONS, brandId: BRAND });
		const N = 6;
		let calls = 0;
		let settled = 0;
		let release: () => void = () => {};
		const barrier = new Promise<void>((resolve) => {
			release = resolve;
		});
		// Safety valve: a second winner would deadlock on the barrier; release after 5 s so the assertions fail instead.
		const valve = setTimeout(release, 5000);
		const provider = fakeProvider({ hold: barrier, onCall: () => calls++, costUsd: 0.0312 });
		const outcomes = await Promise.all(
			Array.from({ length: N }, () =>
				runSentimentJob(payload, {
					resolveProvider: () => withResolutionPhases(provider),
					resolutionPolicy: { backoffBaseMs: 1, backoffMaxMs: 2 },
				}).then((outcome) => {
					settled++;
					if (settled === N - 1) release();
					return outcome;
				}),
			),
		);
		clearTimeout(valve);

		expect(calls).toBe(1);
		expect(outcomes.filter((o) => o.status === "classified")).toHaveLength(1);
		expect(outcomes.filter((o) => o.status === "claimed-elsewhere")).toHaveLength(N - 1);
		for (const o of outcomes) if (o.status === "claimed-elsewhere") expect(o.analysisStatus).toBe("processing");
		const analyses = await client.query<{
			status: string;
			attempts: number;
			provider: string;
			model: string;
			input_hash: string | null;
		}>("SELECT status, attempts, provider, model, input_hash FROM sentiment_analyses WHERE prompt_run_id = $1", [
			RUN_MENTIONS,
		]);
		expect(analyses.rows).toHaveLength(1);
		expect(analyses.rows[0]).toMatchObject({
			status: "completed",
			attempts: 1,
			provider: "fake-openrouter",
			model: SENTIMENT_MODEL,
		});
		expect(analyses.rows[0].input_hash).toMatch(/^[a-f0-9]{64}$/);
		expect(await count("sentiment_observations", "prompt_run_id = $1", [RUN_MENTIONS])).toBe(2);
		expect(
			await count(
				"sentiment_aspect_observations",
				"observation_id IN (SELECT id FROM sentiment_observations WHERE prompt_run_id = $1)",
				[RUN_MENTIONS],
			),
		).toBe(1);
		// Two paid answers per verified run: the initial classification and the independent verification.
		expect(await count("usage_events", "brand_id = $1 AND event_type = 'sentiment_classification'", [BRAND])).toBe(2);
		// The provider's charged cost is what the classification's success event records.
		const [chargedEvent] = (
			await client.query<{ estimated_cost_usd: string; provider: string; model: string }>(
				"SELECT estimated_cost_usd, provider, model FROM usage_events WHERE brand_id = $1 AND event_type = 'sentiment_classification' ORDER BY created_at LIMIT 1",
				[BRAND],
			)
		).rows;
		expect(chargedEvent).toEqual({
			estimated_cost_usd: "0.031200",
			provider: "fake-openrouter",
			model: SENTIMENT_MODEL,
		});
		expect(
			await count("usage_events", "brand_id = $1 AND event_type = 'sentiment_classification_failed'", [BRAND]),
		).toBe(0);
		// The stored evidence offsets resolve into the raw stored body.
		const evidence = await client.query<{
			evidence: { quote: string; start: number; end: number; polarity: string }[];
		}>("SELECT evidence FROM sentiment_observations WHERE prompt_run_id = $1 AND entity_key = $2", [
			RUN_MENTIONS,
			ALPHA,
		]);
		const span = evidence.rows[0].evidence[0];
		expect(ANSWER.slice(span.start, span.end)).toBe("Alpha handles claims fast and fairly.");
		expect(span.quote).toBe("Alpha handles claims fast and fairly.");
		expect(span.polarity).toBe("positive");
	});

	it("a live processing claim is not stolen; an abandoned one (older than the claim timeout) is recovered", async () => {
		let calls = 0;
		const provider = fakeProvider({ onCall: () => calls++ });
		await dropResolutionInstance(RUN_MENTIONS);
		await client.query(
			"UPDATE sentiment_analyses SET status = 'processing', started_at = now() WHERE prompt_run_id = $1",
			[RUN_MENTIONS],
		);
		expect(
			await runSentimentJob(payload, {
				resolveProvider: () => withResolutionPhases(provider),
				resolutionPolicy: { backoffBaseMs: 1, backoffMaxMs: 2 },
			}),
		).toEqual({
			status: "claimed-elsewhere",
			analysisStatus: "processing",
		});
		expect(calls).toBe(0);
		await client.query(
			"UPDATE sentiment_analyses SET status = 'processing', started_at = now() - interval '16 minutes' WHERE prompt_run_id = $1",
			[RUN_MENTIONS],
		);
		expect(
			await runSentimentJob(payload, {
				resolveProvider: () => withResolutionPhases(provider),
				resolutionPolicy: { backoffBaseMs: 1, backoffMaxMs: 2 },
			}),
		).toMatchObject({
			status: "classified",
			entities: 2,
		});
		expect(calls).toBe(1);
		const [row] = (
			await client.query<{ status: string; attempts: number }>(
				"SELECT status, attempts FROM sentiment_analyses WHERE prompt_run_id = $1",
				[RUN_MENTIONS],
			)
		).rows;
		expect(row).toEqual({ status: "completed", attempts: 2 });
	});

	it("a failed attempt is attributed to the locked provider and model without exposing anything else", async () => {
		await dropResolutionInstance(RUN_MENTIONS);
		await client.query("UPDATE sentiment_analyses SET status = 'failed' WHERE prompt_run_id = $1", [RUN_MENTIONS]);
		const leaky = `OpenRouter API error (429): {"error":"rate limited"} Authorization: Bearer sk-or-should-not-leak while classifying "${ANSWER}"`;
		const failing = {
			...fakeProvider(),
			id: "openrouter",
			runStructuredResearch: async () => {
				// The provider's own structured rate-limit refusal: the one 429 the workflow may repeat.
				throw new StructuredResearchRequestError({
					provider: "openrouter",
					httpStatus: 429,
					errorType: "rate_limit_exceeded",
					structured: true,
					carriesOutput: false,
					retryAfterMs: null,
					message: leaky,
				});
			},
		} as unknown as Provider;
		let thrown: unknown;
		try {
			await runSentimentJob(payload, {
				resolveProvider: () => withResolutionPhases(failing),
				resolutionPolicy: { backoffBaseMs: 1, backoffMaxMs: 2 },
			});
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toMatchObject({
			name: "SentimentJobError",
			code: "provider",
			httpStatus: 429,
			provider: "openrouter",
		});
		const thrownText = JSON.stringify(thrown, Object.getOwnPropertyNames(thrown as object)) + String(thrown);
		for (const forbidden of ["sk-or-", "rate limited", "Authorization", ANSWER])
			expect(thrownText).not.toContain(forbidden);
		expect((thrown as Error).cause).toBeUndefined();
		const [row] = (
			await client.query<{
				status: string;
				provider: string;
				model: string;
				error_code: string;
				error_message: string;
			}>("SELECT status, provider, model, error_code, error_message FROM sentiment_analyses WHERE prompt_run_id = $1", [
				RUN_MENTIONS,
			])
		).rows;
		// Parked inside its resolution workflow, never `failed`; the safe code and status stay for the operator.
		expect(row).toMatchObject({
			status: "pending_resolution",
			provider: "openrouter",
			model: SENTIMENT_MODEL,
			error_code: "provider",
			error_message: `provider provider (StructuredResearchRequestError) via openrouter/${SENTIMENT_MODEL} HTTP 429`,
		});
		for (const forbidden of ["sk-or-", "rate limited", "Authorization", ANSWER])
			expect(JSON.stringify(row)).not.toContain(forbidden);
		// A transport failure never received an answer: nothing was paid, nothing is attributed; the case waits.
		expect(
			await count("usage_events", "brand_id = $1 AND event_type = 'sentiment_classification_failed'", [BRAND]),
		).toBe(0);
		expect(
			(
				await client.query<{ status: string }>(
					"SELECT c.status FROM sentiment_resolution_cases c JOIN sentiment_analyses a ON a.id = c.analysis_id WHERE a.prompt_run_id = $1",
					[RUN_MENTIONS],
				)
			).rows,
		).toEqual([{ status: "retry_wait" }]);
		// Recover for the following tests.
		expect(
			await runSentimentJob(payload, {
				resolveProvider: () => withResolutionPhases(fakeProvider()),
				resolutionPolicy: { backoffBaseMs: 1, backoffMaxMs: 2 },
			}),
		).toMatchObject({
			status: "classified",
			entities: 2,
		});
	});
});

describe("IT-SNT-013 claim generation fence (stale lease takeover)", () => {
	const staleLease = () =>
		client.query("UPDATE sentiment_analyses SET started_at = now() - interval '16 minutes' WHERE prompt_run_id = $1", [
			RUN_MENTIONS,
		]);
	const rowState = async () =>
		(
			await client.query<{
				status: string;
				claim_generation: number;
				attempts: number;
				input_hash: string | null;
				error_code: string | null;
			}>(
				"SELECT status, claim_generation, attempts, input_hash, error_code FROM sentiment_analyses WHERE prompt_run_id = $1",
				[RUN_MENTIONS],
			)
		).rows[0];
	const observationIds = async () =>
		(
			await client.query<{ id: string }>("SELECT id FROM sentiment_observations WHERE prompt_run_id = $1 ORDER BY id", [
				RUN_MENTIONS,
			])
		).rows.map((r) => r.id);

	async function takeoverScenario(aOutcome: "success" | "failure") {
		await dropResolutionInstance(RUN_MENTIONS);
		await client.query("UPDATE sentiment_analyses SET status = 'failed' WHERE prompt_run_id = $1", [RUN_MENTIONS]);
		let releaseA: () => void = () => {};
		const holdA = new Promise<void>((resolve) => {
			releaseA = resolve;
		});
		// Attempt A claims and blocks at the provider boundary.
		const providerA =
			aOutcome === "success"
				? fakeProvider({ hold: holdA })
				: ({
						...fakeProvider(),
						runStructuredResearch: async () => {
							await holdA;
							throw new StructuredResearchRequestError({
								provider: "openrouter",
								httpStatus: 503,
								errorType: "provider_overloaded",
								structured: true,
								carriesOutput: false,
								retryAfterMs: null,
								message: "OpenRouter API error (503): upstream overloaded",
							});
						},
					} as unknown as Provider);
		const attemptA = runSentimentJob(payload, {
			resolveProvider: () => withResolutionPhases(providerA),
			resolutionPolicy: { backoffBaseMs: 1, backoffMaxMs: 2 },
		});
		await new Promise((resolve) => setTimeout(resolve, 200));
		const afterA = await rowState();
		expect(afterA.status).toBe("processing");
		const generationA = afterA.claim_generation;
		// Its lease is made stale; attempt B claims. A's request is still in flight — its ledger row is `sending`,
		// its billing outcome unknown — so B must not buy another answer: it parks the run for reconciliation.
		await staleLease();
		const outcomeB = await runSentimentJob(payload, {
			resolveProvider: () => withResolutionPhases(fakeProvider()),
			resolutionPolicy: { backoffBaseMs: 1, backoffMaxMs: 2 },
		});
		expect(outcomeB).toEqual({ status: "awaiting-reconciliation", attemptOrdinal: expect.any(Number) });
		const afterB = await rowState();
		expect(afterB.claim_generation).toBe(generationA + 1);
		expect(afterB.status).toBe("pending_resolution");
		// The earlier verified result's observations stay untouched while the run is parked.
		const observationsB = await observationIds();
		expect(observationsB).toHaveLength(2);
		// A resolves late: it must not touch B's status, the case or the observations.
		releaseA();
		const outcomeA = await attemptA;
		expect(outcomeA).toEqual({ status: "claim-lost", generation: generationA });
		expect(await rowState()).toEqual(afterB);
		expect(await observationIds()).toEqual(observationsB);
		// The operator reconciles the unknown request and adjudicates; the run reaches its one verified result.
		await reconcileAndAdjudicate(RUN_MENTIONS, decisionFor(["brand", ALPHA]));
		expect(await rowState()).toMatchObject({ status: "completed", error_code: null });
		expect(await observationIds()).toHaveLength(2);
	}

	it("A claims, its lease goes stale, B completes, A then succeeds: B remains intact", async () => {
		await takeoverScenario("success");
	});

	it("A claims, its lease goes stale, B completes, A then fails: B remains intact and is not marked failed", async () => {
		await takeoverScenario("failure");
		expect((await rowState()).error_code).toBeNull();
	});

	it("a stale claimant cannot complete a no_mentions path over a newer attempt either", async () => {
		// Direct fence check on the store: the write with the old generation is refused.
		const { markAnalysis, persistClassification } = await import("@workspace/lib/sentiment");
		const state = await rowState();
		const [row] = (
			await client.query<{ id: string }>("SELECT id FROM sentiment_analyses WHERE prompt_run_id = $1", [RUN_MENTIONS])
		).rows;
		const stale = { analysisId: row.id, generation: state.claim_generation - 1 };
		expect(await markAnalysis(stale, { status: "no_mentions", completedAt: new Date() })).toBe(false);
		expect(await markAnalysis(stale, { status: "failed", errorCode: "provider", errorMessage: "x" })).toBe(false);
		await expect(
			persistClassification({
				claim: stale,
				promptRunId: RUN_MENTIONS,
				brandId: BRAND,
				mentions: [],
				classification: {
					entities: [],
					filteredClaims: [],
					unresolvedTargets: [],
					contractDefect: null,
					candidate: null,
					provider: "fake",
					model: SENTIMENT_MODEL,
					webSearch: true,
					classifierVersion: SENTIMENT_CLASSIFIER_VERSION,
					taxonomyVersion: SENTIMENT_TAXONOMY_VERSION,
					inputHash: "stale",
				},
				verifierVersion: "sent-verifier-v1",
			}),
		).rejects.toMatchObject({ name: "ClaimLostError" });
		expect(await rowState()).toEqual(state);
		expect(await observationIds()).toHaveLength(2);
	});
});

describe("IT-SNT-011 input hash and freshness (B8)", () => {
	it("a current completed analysis is skipped without a call", async () => {
		let calls = 0;
		const inventory = await runSentimentEnqueue({ enqueue: false, brandId: BRAND });
		expect(inventory.counts).toMatchObject({ completed: 1, eligible: 0, eligibleStale: 0 });
		expect(
			await runSentimentJob(payload, {
				resolveProvider: () => withResolutionPhases(fakeProvider({ onCall: () => calls++ })),
				resolutionPolicy: { backoffBaseMs: 1, backoffMaxMs: 2 },
			}),
		).toEqual({
			status: "already-completed",
		});
		expect(calls).toBe(0);
	});

	it("an alias edit changes the classifier input: the run becomes eligible and is reclassified once", async () => {
		await client.query("UPDATE competitors SET aliases = '{Alpha Legal}' WHERE id = $1", [ALPHA]);
		const inventory = await runSentimentEnqueue({ enqueue: false, brandId: BRAND });
		expect(inventory.counts).toMatchObject({ completed: 0, eligible: 1, eligibleStale: 1 });
		let calls = 0;
		expect(
			await runSentimentJob(payload, {
				resolveProvider: () => withResolutionPhases(fakeProvider({ onCall: () => calls++ })),
				resolutionPolicy: { backoffBaseMs: 1, backoffMaxMs: 2 },
			}),
		).toMatchObject({
			status: "classified",
			entities: 2,
		});
		expect(calls).toBe(1);
		// No usage reported by the classification double → the tunable estimate (null for an unknown provider id), never a
		// fabricated cost; the verifier's answer (newest) carries the cost its double reports.
		const events = (
			await client.query<{ estimated_cost_usd: string | null }>(
				"SELECT estimated_cost_usd FROM usage_events WHERE brand_id = $1 AND event_type = 'sentiment_classification' ORDER BY created_at DESC LIMIT 2",
				[BRAND],
			)
		).rows;
		expect(events.map((e) => e.estimated_cost_usd)).toEqual(["0.001000", null]);
		expect(await count("sentiment_analyses", "prompt_run_id = $1", [RUN_MENTIONS])).toBe(1);
		expect(await count("sentiment_observations", "prompt_run_id = $1", [RUN_MENTIONS])).toBe(2);
		expect((await runSentimentEnqueue({ enqueue: false, brandId: BRAND })).counts).toMatchObject({
			completed: 1,
			eligibleStale: 0,
		});
	});

	it("a competitor added later is detected by the mention backfill and classified instead of hidden by the old analysis", async () => {
		await client.query(
			`INSERT INTO competitors (id, brand_id, name, domains, aliases, active, removed_at, created_at, updated_at)
			 VALUES ($1, $2, 'Newco', '{newco.example.test}', '{}', true, NULL, now(), now())`,
			[NEWCO, BRAND],
		);
		// The job never re-scans a run with a receipt; the mention backfill does.
		expect(
			await runSentimentJob(payload, {
				resolveProvider: () => withResolutionPhases(fakeProvider()),
				resolutionPolicy: { backoffBaseMs: 1, backoffMaxMs: 2 },
			}),
		).toEqual({
			status: "already-completed",
		});
		const apply = await runMentionBackfill({ apply: true, brandId: BRAND });
		expect(apply.counts).toMatchObject({ written: 1, alreadyCurrent: 2 });
		expect(
			(
				await client.query(
					"SELECT mention_count FROM sentiment_detections WHERE prompt_run_id = $1 AND detector_version = $2",
					[RUN_MENTIONS, SENTIMENT_DETECTOR_VERSION],
				)
			).rows[0].mention_count,
		).toBe(3);
		expect((await runSentimentEnqueue({ enqueue: false, brandId: BRAND })).counts).toMatchObject({
			eligible: 1,
			eligibleStale: 1,
		});
		expect(
			await runSentimentJob(payload, {
				resolveProvider: () => withResolutionPhases(fakeProvider()),
				resolutionPolicy: { backoffBaseMs: 1, backoffMaxMs: 2 },
			}),
		).toMatchObject({
			status: "classified",
			entities: 3,
		});
		expect(await count("sentiment_observations", "prompt_run_id = $1 AND entity_key = $2", [RUN_MENTIONS, NEWCO])).toBe(
			1,
		);
	});

	it("a taxonomy mismatch on a completed analysis never counts as current", async () => {
		await client.query("UPDATE sentiment_analyses SET taxonomy_version = 'sent-aspects-v0' WHERE prompt_run_id = $1", [
			RUN_MENTIONS,
		]);
		expect((await runSentimentEnqueue({ enqueue: false, brandId: BRAND })).counts).toMatchObject({
			completed: 0,
			eligibleStale: 1,
		});
		const overview = await loadSentimentOverview({
			brandId: BRAND,
			lookback: "1m",
			aspect: "overall",
			timezone: "UTC",
		});
		expect(overview.entities.find((e) => e.key === ALPHA)?.classified).toBe(0);
		// A resolution instance is identified by run, input hash and classifier version: the resolved instance stands and
		// the job makes no call. A taxonomy change ships as a classifier version, which opens a new analysis row.
		let calls = 0;
		expect(
			await runSentimentJob(payload, {
				resolveProvider: () => withResolutionPhases(fakeProvider({ onCall: () => calls++ })),
				resolutionPolicy: { backoffBaseMs: 1, backoffMaxMs: 2 },
			}),
		).toEqual({
			status: "already-completed",
		});
		expect(calls).toBe(0);
		await client.query("UPDATE sentiment_analyses SET taxonomy_version = $2 WHERE prompt_run_id = $1", [
			RUN_MENTIONS,
			SENTIMENT_TAXONOMY_VERSION,
		]);
		expect((await runSentimentEnqueue({ enqueue: false, brandId: BRAND })).counts).toMatchObject({ completed: 1 });
	});
});

describe("IT-SNT-014 superseded mention lifecycle", () => {
	it("an alias-only mention that the next detector pass no longer finds leaves the current projection but keeps its history", async () => {
		await insertRun(RUN_ALIAS, PROMPT, { choices: [{ message: { content: ALIAS_ANSWER } }] }, 8);
		await client.query("UPDATE competitors SET aliases = '{Alphaline}' WHERE id = $1", [ALPHA]);
		// Detect through the alias only, then classify it.
		expect((await runMentionBackfill({ apply: true, brandId: BRAND })).counts).toMatchObject({ written: 1 });
		expect((await loadMentions(RUN_ALIAS)).map((m) => m.key)).toEqual([ALPHA]);
		await ensureAnalysis({ promptRunId: RUN_ALIAS, brandId: BRAND });
		const aliasProvider = {
			...fakeProvider(),
			runStructuredResearch: async <T>() => ({
				object: sentimentClassificationResultSchema.parse({
					entities: [
						{
							key: ALPHA,
							score: 75,
							category: "positive",
							confidence: 0.9,
							evidence: [{ anchorId: "s0001", polarity: "positive" }],
							aspects: [],
						},
					],
				}) as T,
				modelVersion: SENTIMENT_MODEL,
			}),
		} as unknown as Provider;
		expect(
			await runSentimentJob(
				{ ...payload, promptRunId: RUN_ALIAS },
				{
					resolveProvider: () => withResolutionPhases(aliasProvider),
					resolutionPolicy: { backoffBaseMs: 1, backoffMaxMs: 2 },
				},
			),
		).toMatchObject({ status: "classified", entities: 1 });
		const overviewBefore = await loadSentimentOverview({
			brandId: BRAND,
			lookback: "1m",
			aspect: "overall",
			timezone: "UTC",
		});
		const alphaBefore = overviewBefore.entities.find((e) => e.key === ALPHA);
		const mentionsBefore = alphaBefore?.mentions ?? 0;
		const classifiedBefore = alphaBefore?.classified ?? 0;

		// Remove the alias from the active definition and re-run the mention backfill.
		await client.query("UPDATE competitors SET aliases = '{}' WHERE id = $1", [ALPHA]);
		const apply = await runMentionBackfill({ apply: true, brandId: BRAND });
		expect(apply.counts.written).toBe(1);
		const receipt = (
			await client.query<{ status: string; mention_count: number }>(
				"SELECT status, mention_count FROM sentiment_detections WHERE prompt_run_id = $1 AND detector_version = $2",
				[RUN_ALIAS, SENTIMENT_DETECTOR_VERSION],
			)
		).rows[0];
		expect(receipt).toEqual({ status: "no_mentions", mention_count: 0 });
		expect(await loadMentions(RUN_ALIAS)).toEqual([]);
		const rows = await client.query<{ entity_key: string; superseded_at: Date | null }>(
			"SELECT entity_key, superseded_at FROM prompt_run_entity_mentions WHERE prompt_run_id = $1",
			[RUN_ALIAS],
		);
		expect(rows.rows).toHaveLength(1);
		expect(rows.rows[0].superseded_at).not.toBeNull();
		// Idempotent: a dry run finds nothing left to write.
		expect((await runMentionBackfill({ apply: false, brandId: BRAND })).counts).toMatchObject({ written: 0 });
		expect((await runMentionBackfill({ apply: false, brandId: BRAND })).counts.alreadyCurrent).toBeGreaterThan(0);
		// History retained, current analytics untouched by it.
		expect(await count("sentiment_observations", "prompt_run_id = $1", [RUN_ALIAS])).toBe(1);
		const overviewAfter = await loadSentimentOverview({
			brandId: BRAND,
			lookback: "1m",
			aspect: "overall",
			timezone: "UTC",
		});
		const alphaAfter = overviewAfter.entities.find((e) => e.key === ALPHA);
		expect(alphaAfter?.mentions).toBe(mentionsBefore - 1);
		expect(alphaAfter?.classified).toBe(classifiedBefore - 1);
		const evidence = await loadSentimentEvidence({
			brandId: BRAND,
			lookback: "1m",
			aspect: "overall",
			timezone: "UTC",
			entityKey: ALPHA,
			limit: 10,
		});
		expect([...evidence.highest, ...evidence.lowest].some((i) => i.promptRunId === RUN_ALIAS)).toBe(false);
		// Not eligible for another classification and no provider call when a job arrives anyway.
		expect((await runSentimentEnqueue({ enqueue: false, brandId: BRAND })).counts.noMentions).toBeGreaterThan(0);
		let calls = 0;
		const outcome = await runSentimentJob(
			{ ...payload, promptRunId: RUN_ALIAS },
			{
				resolveProvider: () => withResolutionPhases(fakeProvider({ onCall: () => calls++ })),
				resolutionPolicy: { backoffBaseMs: 1, backoffMaxMs: 2 },
			},
		);
		expect(["no-mentions", "already-completed"]).toContain(outcome.status);
		expect(calls).toBe(0);
		expect(await count("sentiment_observations", "prompt_run_id = $1", [RUN_ALIAS])).toBe(1);
		// The alias is detected again: the same row is reactivated, not duplicated.
		await client.query("UPDATE competitors SET aliases = '{Alphaline}' WHERE id = $1", [ALPHA]);
		await runMentionBackfill({ apply: true, brandId: BRAND });
		const reactivated = await client.query<{ id: string; superseded_at: Date | null }>(
			"SELECT id, superseded_at FROM prompt_run_entity_mentions WHERE prompt_run_id = $1",
			[RUN_ALIAS],
		);
		expect(reactivated.rows).toHaveLength(1);
		expect(reactivated.rows[0].superseded_at).toBeNull();
		await client.query("UPDATE competitors SET aliases = '{}' WHERE id = $1", [ALPHA]);
		await runMentionBackfill({ apply: true, brandId: BRAND });
	});
});

describe("IT-SNT-015 per-run source cap in SQL", () => {
	it("returns at most eight distinct sources per run from the database, in citation order", async () => {
		await insertRun(RUN_SOURCES, PROMPT, { choices: [{ message: { content: ANSWER } }] }, 7);
		await client.query(
			`INSERT INTO citations (prompt_run_id, prompt_id, brand_id, model, url, domain, title, citation_index, created_at)
			 SELECT $1, $2, $3, 'chatgpt', 'https://src' || lpad(g::text, 2, '0') || '.example.test/p', 'src' || lpad(g::text, 2, '0') || '.example.test', 'S' || g, g, now()
			 FROM generate_series(0, 24) g`,
			[RUN_SOURCES, PROMPT, BRAND],
		);
		// Duplicate URLs must collapse before the cap applies.
		await client.query(
			`INSERT INTO citations (prompt_run_id, prompt_id, brand_id, model, url, domain, title, citation_index, created_at)
			 VALUES ($1, $2, $3, 'chatgpt', 'https://src00.example.test/p', 'src00.example.test', 'dup', 40, now())`,
			[RUN_SOURCES, PROMPT, BRAND],
		);
		expect(await count("citations", "prompt_run_id = $1", [RUN_SOURCES])).toBe(26);
		const rows = await loadRunSources([RUN_SOURCES, RUN_MENTIONS]);
		const forRun = rows.filter((r) => r.promptRunId === RUN_SOURCES);
		expect(rows).toHaveLength(forRun.length);
		expect(forRun).toHaveLength(8);
		expect(forRun.map((r) => r.domain)).toEqual(
			Array.from({ length: 8 }, (_, i) => `src${String(i).padStart(2, "0")}.example.test`),
		);
	});
});

describe("IT-SNT-016 coverage follows the current taxonomy contract", () => {
	it("a completed analysis under an old taxonomy counts as neither coverage nor metrics; the current one counts as both", async () => {
		await insertRun(RUN_OLD_TAXONOMY, PROMPT, { choices: [{ message: { content: ANSWER } }] }, 6);
		await client.query(
			"INSERT INTO sentiment_detections (prompt_run_id, brand_id, detector_version, status, mention_count) VALUES ($1, $2, $3, 'mentions', 1)",
			[RUN_OLD_TAXONOMY, BRAND, SENTIMENT_DETECTOR_VERSION],
		);
		const { rows: m } = await client.query<{ id: string }>(
			`INSERT INTO prompt_run_entity_mentions (prompt_run_id, brand_id, entity_type, competitor_id, entity_key, entity_name, detector_version) VALUES ($1, $2, 'competitor', $3::uuid, $3::text, 'Alpha', $4) RETURNING id`,
			[RUN_OLD_TAXONOMY, BRAND, ALPHA, SENTIMENT_DETECTOR_VERSION],
		);
		const { rows: a } = await client.query<{ id: string }>(
			`INSERT INTO sentiment_analyses (prompt_run_id, brand_id, classifier_version, taxonomy_version, status, input_hash, completed_at, verifier_version, verified_at) VALUES ($1, $2, $3, 'sent-aspects-v0', 'completed', 'old', now(), 'sent-verifier-v1', now()) RETURNING id`,
			[RUN_OLD_TAXONOMY, BRAND, SENTIMENT_CLASSIFIER_VERSION],
		);
		await client.query(
			`INSERT INTO sentiment_observations (analysis_id, mention_id, prompt_run_id, brand_id, entity_type, competitor_id, entity_key, score, category, confidence, evidence) VALUES ($1, $2, $3, $4, 'competitor', $5::uuid, $5::text, 5, 'negative', 0.9, '[]'::jsonb)`,
			[a[0].id, m[0].id, RUN_OLD_TAXONOMY, BRAND, ALPHA],
		);
		const scope = { brandId: BRAND, lookback: "1m" as const, aspect: "overall" as const, timezone: "UTC" };
		const stale = await loadSentimentOverview(scope);
		const alphaStale = stale.entities.find((e) => e.key === ALPHA)!;
		const staleCompleted = stale.coverage.analyses.completed;
		const stalePending = stale.coverage.analyses.pending;
		const staleClassified = alphaStale.classified;
		const staleNegative = alphaStale.counts.negative;

		// Flip the same row to the current taxonomy: it now contributes to both.
		await client.query("UPDATE sentiment_analyses SET taxonomy_version = $2 WHERE id = $1", [
			a[0].id,
			SENTIMENT_TAXONOMY_VERSION,
		]);
		const current = await loadSentimentOverview(scope);
		const alphaCurrent = current.entities.find((e) => e.key === ALPHA)!;
		expect(current.coverage.analyses.completed).toBe(staleCompleted + 1);
		expect(current.coverage.analyses.pending).toBe(stalePending - 1);
		expect(alphaCurrent.classified).toBe(staleClassified + 1);
		expect(alphaCurrent.counts.negative).toBe(staleNegative + 1);
		expect(alphaStale.mentions).toBe(alphaCurrent.mentions);
	});
});

describe("IT-SNT-007 bounded evidence at high cardinality (B5)", () => {
	const RUNS = 3000;
	it("answers 10/10 non-overlapping extremes with LIMIT queries and records the plan", async () => {
		// Bulk graph for Alpha: 3,000 runs, receipts, mentions, completed analyses and observations (scores 0..100 cycling).
		await client.query(
			`WITH r AS (
			   INSERT INTO prompt_runs (id, prompt_id, brand_id, model, provider, version, web_search_enabled, raw_output, brand_mentioned, competitors_mentioned, created_at)
			   SELECT ('5e970004-0000-4000-8000-1' || lpad(to_hex(g), 11, '0'))::uuid, $1, $2, 'chatgpt', 'openrouter', 'v', true,
			          jsonb_build_object('choices', jsonb_build_array(jsonb_build_object('message', jsonb_build_object('content', 'Alpha handles claims fast and fairly. #' || g)))),
			          true, '{}', now() - interval '1 day' - (g || ' seconds')::interval
			   FROM generate_series(1, $3::int) g RETURNING id, created_at
			 ), d AS (
			   INSERT INTO sentiment_detections (prompt_run_id, brand_id, detector_version, status, mention_count) SELECT id, $2, $4, 'mentions', 1 FROM r
			 ), m AS (
			   INSERT INTO prompt_run_entity_mentions (prompt_run_id, brand_id, entity_type, competitor_id, entity_key, entity_name, detector_version)
			   SELECT id, $2, 'competitor', $5::uuid, $5::text, 'Alpha', $4 FROM r RETURNING id AS mention_id, prompt_run_id
			 ), a AS (
			   INSERT INTO sentiment_analyses (prompt_run_id, brand_id, classifier_version, taxonomy_version, status, input_hash, completed_at, verifier_version, verified_at)
			   SELECT id, $2, $6, $7, 'completed', 'bulk', now(), 'sent-verifier-v1', now() FROM r RETURNING id AS analysis_id, prompt_run_id
			 )
			 INSERT INTO sentiment_observations (analysis_id, mention_id, prompt_run_id, brand_id, entity_type, competitor_id, entity_key, score, category, confidence, evidence)
			 SELECT a.analysis_id, m.mention_id, a.prompt_run_id, $2, 'competitor', $5::uuid, $5::text,
			        s.score, CASE WHEN s.score >= 51 THEN 'positive' WHEN s.score <= 49 THEN 'negative' ELSE 'neutral' END, 0.9,
			        '[{"quote":"Alpha handles claims fast and fairly","start":0,"end":36,"polarity":"positive"}]'::jsonb
			 FROM a JOIN m USING (prompt_run_id)
			 CROSS JOIN LATERAL (SELECT (('x' || substr(md5(a.prompt_run_id::text), 1, 8))::bit(32)::int % 101 + 101) % 101 AS score) s`,
			[
				PROMPT,
				BRAND,
				RUNS,
				SENTIMENT_DETECTOR_VERSION,
				ALPHA,
				SENTIMENT_CLASSIFIER_VERSION,
				SENTIMENT_TAXONOMY_VERSION,
			],
		);
		const total = (
			await client.query<{ n: number }>(
				`SELECT count(*)::int AS n FROM sentiment_observations o JOIN prompt_run_entity_mentions m ON m.id = o.mention_id AND m.superseded_at IS NULL
				 JOIN sentiment_analyses a ON a.id = o.analysis_id AND a.status = 'completed' AND a.taxonomy_version = $3
				 WHERE o.brand_id = $1 AND o.entity_key = $2`,
				[BRAND, ALPHA, SENTIMENT_TAXONOMY_VERSION],
			)
		).rows[0].n;
		expect(total).toBeGreaterThanOrEqual(RUNS);

		const started = performance.now();
		const evidence = await loadSentimentEvidence({
			brandId: BRAND,
			lookback: "1m",
			aspect: "overall",
			timezone: "UTC",
			entityKey: ALPHA,
			limit: 10,
		});
		const elapsedMs = performance.now() - started;
		expect(evidence.totalObservations).toBe(total);
		expect(evidence.highest).toHaveLength(10);
		expect(evidence.lowest).toHaveLength(10);
		expect(new Set([...evidence.highest, ...evidence.lowest].map((i) => i.observationId)).size).toBe(20);
		// Oracle: the same total order in SQL.
		const oracle = await client.query<{ id: string }>(
			`SELECT o.id FROM sentiment_observations o JOIN prompt_runs r ON r.id = o.prompt_run_id
			 JOIN prompt_run_entity_mentions m ON m.id = o.mention_id AND m.superseded_at IS NULL
			 JOIN sentiment_analyses a ON a.id = o.analysis_id AND a.status = 'completed' AND a.taxonomy_version = $3
			 WHERE o.brand_id = $1 AND o.entity_key = $2 ORDER BY o.score DESC, r.created_at DESC, r.prompt_id DESC, o.prompt_run_id DESC, o.id DESC LIMIT 10`,
			[BRAND, ALPHA, SENTIMENT_TAXONOMY_VERSION],
		);
		expect(evidence.highest.map((i) => i.observationId)).toEqual(oracle.rows.map((r) => r.id));
		const lowOracle = await client.query<{ id: string }>(
			`SELECT o.id FROM sentiment_observations o JOIN prompt_runs r ON r.id = o.prompt_run_id
			 JOIN prompt_run_entity_mentions m ON m.id = o.mention_id AND m.superseded_at IS NULL
			 JOIN sentiment_analyses a ON a.id = o.analysis_id AND a.status = 'completed' AND a.taxonomy_version = $3
			 WHERE o.brand_id = $1 AND o.entity_key = $2 ORDER BY o.score ASC, r.created_at ASC, r.prompt_id ASC, o.prompt_run_id ASC, o.id ASC LIMIT 10`,
			[BRAND, ALPHA, SENTIMENT_TAXONOMY_VERSION],
		);
		expect(evidence.lowest.map((i) => i.observationId)).toEqual(lowOracle.rows.map((r) => r.id));

		const plan = await explainSentimentEvidence({
			brandId: BRAND,
			lookback: "1m",
			aspect: "overall",
			timezone: "UTC",
			entityKey: ALPHA,
			limit: 10,
		});
		expect(plan[0]).toMatch(/^Limit/);
		expect(plan.join("\n")).toMatch(/rows=10(\.00)? loops=1/);
		const dir = path.join(homedir(), ".elmo-task-evidence", "sent-01", "r1");
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			path.join(dir, "evidence-explain.txt"),
			[
				`# EXPLAIN (ANALYZE, BUFFERS) — highest-evidence query, ${total} observations for one entity, limit 10`,
				`# loadSentimentEvidence wall time: ${elapsedMs.toFixed(1)} ms`,
				"",
				...plan,
				"",
			].join("\n"),
		);
	});
});

describe("IT-SNT-018 usage attribution when the write fails after a paid answer (C4)", () => {
	it("one provider call, a real write failure: one success usage event with the charged cost, analysis failed, no observation rows, recoverable", {
		timeout: 120_000,
	}, async () => {
		await insertRun(RUN_PERSIST_FAIL, PROMPT, { choices: [{ message: { content: ANSWER } }] }, 3);
		await runMentionBackfill({ apply: true, brandId: BRAND });
		const { persistClassification } = await import("@workspace/lib/sentiment");
		const eventsBefore = await count("usage_events");
		const failedBefore = await count(
			"usage_events",
			"brand_id = $1 AND event_type = 'sentiment_classification_failed'",
		);
		let calls = 0;
		const provider = fakeProvider({ onCall: () => calls++, costUsd: 0.0456 });
		// A mention row disappears between the provider's answer and the write: the
		// observation insert violates the FK on `mention_id` inside the real transaction.
		const persist: typeof persistClassification = async (args) => {
			await client.query("DELETE FROM prompt_run_entity_mentions WHERE prompt_run_id = $1 AND entity_key = $2", [
				RUN_PERSIST_FAIL,
				ALPHA,
			]);
			return persistClassification(args);
		};
		let thrown: unknown;
		try {
			await runSentimentJob(
				{ ...payload, promptRunId: RUN_PERSIST_FAIL },
				{
					resolveProvider: () => withResolutionPhases(provider),
					resolutionPolicy: { backoffBaseMs: 1, backoffMaxMs: 2 },
					persist,
				},
			);
		} catch (error) {
			thrown = error;
		}
		expect(calls).toBe(1);
		expect(thrown).toMatchObject({ name: "SentimentJobError", code: "persistence", kind: "store", httpStatus: null });
		const thrownText = JSON.stringify(thrown, Object.getOwnPropertyNames(thrown as object)) + String(thrown);
		for (const forbidden of ["violates", "foreign key", "23503", "mention_id", ANSWER])
			expect(thrownText).not.toContain(forbidden);

		// Two paid answers (classification, verification), each attributed exactly once with the cost its provider reported.
		expect(await count("usage_events")).toBe(eventsBefore + 2);
		expect(await count("usage_events", "brand_id = $1 AND event_type = 'sentiment_classification_failed'")).toBe(
			failedBefore,
		);
		const events = (
			await client.query<{ event_type: string; estimated_cost_usd: string; provider: string; model: string }>(
				"SELECT event_type, estimated_cost_usd, provider, model FROM usage_events WHERE brand_id = $1 ORDER BY created_at DESC LIMIT 2",
				[BRAND],
			)
		).rows;
		expect(events).toEqual([
			{
				event_type: "sentiment_classification",
				estimated_cost_usd: "0.001000",
				provider: "fake-openrouter",
				model: SENTIMENT_MODEL,
			},
			{
				event_type: "sentiment_classification",
				estimated_cost_usd: "0.045600",
				provider: "fake-openrouter",
				model: SENTIMENT_MODEL,
			},
		]);

		// The analysis is ours, parked with the persistence code; the rolled-back write left nothing behind.
		const [analysis] = (
			await client.query<{ status: string; error_code: string; error_message: string; attempts: number }>(
				"SELECT status, error_code, error_message, attempts FROM sentiment_analyses WHERE prompt_run_id = $1",
				[RUN_PERSIST_FAIL],
			)
		).rows;
		expect(analysis).toMatchObject({ status: "pending_resolution", error_code: "persistence", attempts: 1 });
		expect(analysis.error_message).toMatch(/^store persistence \(\w+\) via openrouter\/openai\/gpt-5-mini$/);
		expect(await count("sentiment_observations", "prompt_run_id = $1", [RUN_PERSIST_FAIL])).toBe(0);
		expect(
			await count(
				"sentiment_aspect_observations",
				"observation_id IN (SELECT id FROM sentiment_observations WHERE prompt_run_id = $1)",
				[RUN_PERSIST_FAIL],
			),
		).toBe(0);

		// Once the mention rows are repaired, the next attempt resumes from the stored candidate: no second paid
		// classification, one more verification, then the result persists.
		await runMentionBackfill({ apply: true, brandId: BRAND });
		expect(
			await runSentimentJob(
				{ ...payload, promptRunId: RUN_PERSIST_FAIL },
				{
					resolveProvider: () => withResolutionPhases(provider),
					resolutionPolicy: { backoffBaseMs: 1, backoffMaxMs: 2 },
				},
			),
		).toMatchObject({ status: "classified", entities: 3 });
		expect(calls).toBe(1);
		expect(await count("usage_events")).toBe(eventsBefore + 3);
		expect(await count("sentiment_observations", "prompt_run_id = $1", [RUN_PERSIST_FAIL])).toBe(3);
	});
});

describe("IT-SNT-021 canary post-call gate on real Postgres (E1)", () => {
	const lockedRequest: StructuredResearchRequestSummary = {
		model: SENTIMENT_MODEL,
		webSearch: true,
		maxToolCalls: 1,
		maxOutputTokens: 8000,
		strictJsonSchema: true,
		requireParameters: true,
	};
	const usageOf = (over: Partial<StructuredResearchUsage>): StructuredResearchUsage => ({
		inputTokens: 7000,
		outputTokens: 900,
		reasoningTokens: 400,
		costUsd: 0.02,
		webSearchRequests: 1,
		webSearchRequestsConflict: false,
		...over,
	});
	const analysisRow = async (runId: string) =>
		(
			await client.query<{ status: string; error_code: string | null; attempts: number }>(
				"SELECT status, error_code, attempts FROM sentiment_analyses WHERE prompt_run_id = $1",
				[runId],
			)
		).rows[0];
	const observations = (runId: string) => count("sentiment_observations", "prompt_run_id = $1", [runId]);
	const aspects = (runId: string) =>
		count(
			"sentiment_aspect_observations",
			"observation_id IN (SELECT id FROM sentiment_observations WHERE prompt_run_id = $1)",
			[runId],
		);
	/** The two newest usage events: the verifier's (0.001) and the classification's, newest first. */
	const newestEvents = async () =>
		(
			await client.query<{ event_type: string; estimated_cost_usd: string | null }>(
				"SELECT event_type, estimated_cost_usd FROM usage_events WHERE brand_id = $1 ORDER BY created_at DESC LIMIT 2",
				[BRAND],
			)
		).rows;

	/** Every scenario gets its own pristine run: the canary is one authorized attempt per run. */
	async function pristineContract(runId: string, minutesAgo: number) {
		const { inspectSentimentCanaryRun, inspectSentimentCanaryRunState, parseSentimentCanaryContract } = await import(
			"@workspace/lib/sentiment"
		);
		await insertRun(runId, PROMPT, { choices: [{ message: { content: ANSWER } }] }, minutesAgo);
		await runMentionBackfill({ apply: true, brandId: BRAND });
		const description = await inspectSentimentCanaryRun(runId);
		expect(description?.entities.map((e) => e.key)).toEqual(["brand", ALPHA, NEWCO]);
		expect(await inspectSentimentCanaryRunState(runId)).toEqual({ analysis: null, pristine: true });
		return parseSentimentCanaryContract(description);
	}
	const fast = { deadlineMs: 5_000, watchdogMs: 10_000 };

	it("a rejected answer never becomes a completed analysis: cost above the threshold, conflicting or unreported search count; a conforming answer persists", {
		timeout: 180_000,
	}, async () => {
		const { runSentimentCanary } = await import("@workspace/lib/sentiment");
		const eventsBefore = await count("usage_events");
		const failedBefore = await count(
			"usage_events",
			"brand_id = $1 AND event_type = 'sentiment_classification_failed'",
		);
		let calls = 0;

		// 1. Cost above the post-call threshold.
		const costContract = await pristineContract(RUN_CANARY_COST, 4);
		const expensive = fakeProvider({
			onCall: () => calls++,
			usage: usageOf({ costUsd: 0.1001 }),
			request: lockedRequest,
		});
		const rejected = await runSentimentCanary({
			contract: costContract,
			deps: {
				resolveProvider: () => withResolutionPhases(expensive),
				resolutionPolicy: { backoffBaseMs: 1, backoffMaxMs: 2 },
			},
			...fast,
		});
		expect(calls).toBe(1);
		// Two paid answers per canary attempt: the classification and the independent verification.
		expect(rejected.providerCalls).toBe(2);
		expect(rejected.verdict).toEqual({ status: "reject", reasons: [{ code: "cost-exceeded" }] });
		expect(rejected.outcome).toMatchObject({ status: "error", code: "canary-contract" });
		expect(await analysisRow(RUN_CANARY_COST)).toEqual({
			status: "pending_resolution",
			error_code: "canary-contract",
			attempts: 1,
		});
		expect(await observations(RUN_CANARY_COST)).toBe(0);
		expect(await aspects(RUN_CANARY_COST)).toBe(0);
		expect(await count("usage_events")).toBe(eventsBefore + 2);
		expect(await count("usage_events", "brand_id = $1 AND event_type = 'sentiment_classification_failed'")).toBe(
			failedBefore,
		);
		expect(await newestEvents()).toEqual([
			{ event_type: "sentiment_classification", estimated_cost_usd: "0.001000" },
			{ event_type: "sentiment_classification", estimated_cost_usd: "0.100100" },
		]);

		// 2. Conflicting web-search counters: rejected the same way, cost still attributed.
		const conflictContract = await pristineContract(RUN_CANARY_CONFLICT, 3);
		const conflicting = fakeProvider({
			onCall: () => calls++,
			usage: usageOf({ webSearchRequests: null, webSearchRequestsConflict: true, costUsd: 0.02 }),
			request: lockedRequest,
		});
		const conflict = await runSentimentCanary({
			contract: conflictContract,
			deps: {
				resolveProvider: () => withResolutionPhases(conflicting),
				resolutionPolicy: { backoffBaseMs: 1, backoffMaxMs: 2 },
			},
			...fast,
		});
		expect(calls).toBe(2);
		expect(conflict.providerCalls).toBe(2);
		expect(conflict.verdict).toEqual({ status: "reject", reasons: [{ code: "web-search-count-conflict" }] });
		expect(await analysisRow(RUN_CANARY_CONFLICT)).toEqual({
			status: "pending_resolution",
			error_code: "canary-contract",
			attempts: 1,
		});
		expect(await observations(RUN_CANARY_CONFLICT)).toBe(0);
		expect(await count("usage_events")).toBe(eventsBefore + 4);
		expect(await newestEvents()).toEqual([
			{ event_type: "sentiment_classification", estimated_cost_usd: "0.001000" },
			{ event_type: "sentiment_classification", estimated_cost_usd: "0.020000" },
		]);

		// 3. Unknown (unreported) count: same outcome with the cost the provider did report.
		const unknownContract = await pristineContract(RUN_CANARY_UNKNOWN, 2);
		const unknown = fakeProvider({
			onCall: () => calls++,
			usage: usageOf({ webSearchRequests: null, costUsd: 0.03 }),
			request: lockedRequest,
		});
		const unreported = await runSentimentCanary({
			contract: unknownContract,
			deps: {
				resolveProvider: () => withResolutionPhases(unknown),
				resolutionPolicy: { backoffBaseMs: 1, backoffMaxMs: 2 },
			},
			...fast,
		});
		expect(unreported.verdict).toEqual({ status: "reject", reasons: [{ code: "web-search-count-unknown" }] });
		expect(await observations(RUN_CANARY_UNKNOWN)).toBe(0);
		expect(await newestEvents()).toEqual([
			{ event_type: "sentiment_classification", estimated_cost_usd: "0.001000" },
			{ event_type: "sentiment_classification", estimated_cost_usd: "0.030000" },
		]);

		// 4. A conforming answer is the only thing that persists.
		const okContract = await pristineContract(RUN_CANARY, 1);
		const good = fakeProvider({ onCall: () => calls++, usage: usageOf({}), request: lockedRequest });
		const accepted = await runSentimentCanary({
			contract: okContract,
			deps: {
				resolveProvider: () => withResolutionPhases(good),
				resolutionPolicy: { backoffBaseMs: 1, backoffMaxMs: 2 },
			},
			...fast,
		});
		expect(accepted.verdict).toEqual({ status: "accept" });
		expect(calls).toBe(4);
		expect(await analysisRow(RUN_CANARY)).toEqual({ status: "completed", error_code: null, attempts: 1 });
		expect(await observations(RUN_CANARY)).toBe(3);
		expect(await count("usage_events")).toBe(eventsBefore + 8);
		expect(await count("usage_events", "brand_id = $1 AND event_type = 'sentiment_classification_failed'")).toBe(
			failedBefore,
		);
	});

	it("IT-SNT-023: one authorized attempt per run — after a provider failure the same contract is refused before the provider", {
		timeout: 180_000,
	}, async () => {
		const {
			ensureAnalysis: ensure,
			inspectSentimentCanaryRunState,
			runSentimentCanary,
		} = await import("@workspace/lib/sentiment");
		const contract = await pristineContract(RUN_CANARY_RETRY, 5);
		// A pending row with zero attempts is the pristine starting state of a queued-but-never-run analysis.
		await ensure({ promptRunId: RUN_CANARY_RETRY, brandId: BRAND });
		expect(await analysisRow(RUN_CANARY_RETRY)).toEqual({ status: "pending", error_code: null, attempts: 0 });
		expect(await inspectSentimentCanaryRunState(RUN_CANARY_RETRY)).toEqual({
			analysis: { status: "pending", attempts: 0, observations: 0 },
			pristine: true,
		});
		const eventsBefore = await count("usage_events");
		const failedBefore = await count(
			"usage_events",
			"brand_id = $1 AND event_type = 'sentiment_classification_failed'",
		);

		let firstCalls = 0;
		const failing = {
			...fakeProvider(),
			id: "openrouter",
			runStructuredResearch: async () => {
				firstCalls++;
				throw new StructuredResearchRequestError({
					provider: "openrouter",
					httpStatus: 503,
					errorType: "provider_overloaded",
					structured: true,
					carriesOutput: false,
					retryAfterMs: null,
					message: "OpenRouter API error (503): upstream overloaded",
				});
			},
		} as unknown as Provider;
		const first = await runSentimentCanary({
			contract,
			deps: {
				resolveProvider: () => withResolutionPhases(failing),
				resolutionPolicy: { backoffBaseMs: 1, backoffMaxMs: 2 },
			},
			...fast,
		});
		expect(first.preflight).toEqual({ status: "passed" });
		expect(firstCalls).toBe(1);
		expect(first.providerCalls).toBe(1);
		expect(first.verdict).toEqual({ status: "reject", reasons: [{ code: "provider-error", detail: "503" }] });
		expect(await analysisRow(RUN_CANARY_RETRY)).toEqual({
			status: "pending_resolution",
			error_code: "provider",
			attempts: 1,
		});
		expect(await observations(RUN_CANARY_RETRY)).toBe(0);
		expect(await aspects(RUN_CANARY_RETRY)).toBe(0);
		// A refusal without an answer was not paid: the ledger has the attempt, usage has nothing.
		expect(await count("usage_events")).toBe(eventsBefore);
		expect(await count("usage_events", "brand_id = $1 AND event_type = 'sentiment_classification_failed'")).toBe(
			failedBefore,
		);
		expect(await inspectSentimentCanaryRunState(RUN_CANARY_RETRY)).toEqual({
			analysis: { status: "pending_resolution", attempts: 1, observations: 0 },
			pristine: false,
		});

		// The same contract again: refused in preflight, the second provider is never touched, nothing changes.
		let secondCalls = 0;
		const second = fakeProvider({ onCall: () => secondCalls++, usage: usageOf({}), request: lockedRequest });
		const again = await runSentimentCanary({
			contract,
			deps: {
				resolveProvider: () => withResolutionPhases(second),
				resolutionPolicy: { backoffBaseMs: 1, backoffMaxMs: 2 },
			},
			...fast,
		});
		expect(again.preflight).toEqual({
			status: "refused",
			reasons: [{ code: "run-not-pristine", detail: "pending_resolution/1/0" }],
		});
		expect(again.attempts).toBe(0);
		expect(again.providerCalls).toBe(0);
		expect(secondCalls).toBe(0);
		expect(again.verdict).toEqual({
			status: "reject",
			reasons: [{ code: "run-not-pristine", detail: "pending_resolution/1/0" }],
		});
		expect(await analysisRow(RUN_CANARY_RETRY)).toEqual({
			status: "pending_resolution",
			error_code: "provider",
			attempts: 1,
		});
		expect(await observations(RUN_CANARY_RETRY)).toBe(0);
		expect(await aspects(RUN_CANARY_RETRY)).toBe(0);
		expect(await count("usage_events")).toBe(eventsBefore);
	});

	it("IT-SNT-024: two canaries that both pass preflight race for the atomic pristine claim — exactly one reaches the provider, the loser writes nothing", {
		timeout: 180_000,
	}, async () => {
		const {
			claimAnalysis: claim,
			ensureAnalysis: ensure,
			inspectSentimentCanaryRunState,
			runSentimentCanary,
		} = await import("@workspace/lib/sentiment");
		const contract = await pristineContract(RUN_CANARY_RACE, 6);
		await ensure({ promptRunId: RUN_CANARY_RACE, brandId: BRAND });
		expect(await analysisRow(RUN_CANARY_RACE)).toEqual({ status: "pending", error_code: null, attempts: 0 });
		const eventsBefore = await count("usage_events");

		// Barriers: B finishes preflight before A may claim; B may claim only after A has finished.
		let releaseAClaim: () => void = () => {};
		const aMayClaim = new Promise<void>((resolve) => {
			releaseAClaim = resolve;
		});
		let releaseBClaim: () => void = () => {};
		const bMayClaim = new Promise<void>((resolve) => {
			releaseBClaim = resolve;
		});
		let aCalls = 0;
		let bCalls = 0;
		const providerA = {
			...fakeProvider(),
			id: "openrouter",
			runStructuredResearch: async () => {
				aCalls++;
				throw new StructuredResearchRequestError({
					provider: "openrouter",
					httpStatus: 503,
					errorType: "provider_overloaded",
					structured: true,
					carriesOutput: false,
					retryAfterMs: null,
					message: "OpenRouter API error (503): upstream overloaded",
				});
			},
		} as unknown as Provider;
		const providerB = fakeProvider({ onCall: () => bCalls++, usage: usageOf({}), request: lockedRequest });
		const gatedClaim =
			(gate: Promise<void>): typeof claim =>
			async (analysisId, options, executor) => {
				await gate;
				return claim(analysisId, options, executor);
			};
		const { loadAnalysisState: loadState } = await import("@workspace/lib/sentiment");
		const bPreflightSeen: typeof loadState = async (runId, executor) => {
			const state = await loadState(runId, executor);
			releaseAClaim();
			return state;
		};

		const a = runSentimentCanary({
			contract,
			deps: {
				resolveProvider: () => withResolutionPhases(providerA),
				resolutionPolicy: { backoffBaseMs: 1, backoffMaxMs: 2 },
				claimAnalysis: gatedClaim(aMayClaim),
			},
			...fast,
		}).then((report) => {
			releaseBClaim();
			return report;
		});
		const b = runSentimentCanary({
			contract,
			deps: {
				resolveProvider: () => withResolutionPhases(providerB),
				resolutionPolicy: { backoffBaseMs: 1, backoffMaxMs: 2 },
				claimAnalysis: gatedClaim(bMayClaim),
				loadAnalysisState: bPreflightSeen,
			},
			...fast,
		});
		const [reportA, reportB] = await Promise.all([a, b]);

		expect(reportA.preflight).toEqual({ status: "passed" });
		expect(reportB.preflight).toEqual({ status: "passed" });
		expect(aCalls).toBe(1);
		expect(reportA.providerCalls).toBe(1);
		expect(reportA.verdict).toEqual({ status: "reject", reasons: [{ code: "provider-error", detail: "503" }] });

		expect(bCalls).toBe(0);
		expect(reportB.attempts).toBe(1);
		expect(reportB.providerCalls).toBe(0);
		expect(reportB.outcome).toEqual({ status: "claimed-elsewhere" });
		expect(reportB.verdict).toEqual({
			status: "reject",
			reasons: [{ code: "run-state-drift", detail: "pending_resolution" }],
		});

		expect(await analysisRow(RUN_CANARY_RACE)).toEqual({
			status: "pending_resolution",
			error_code: "provider",
			attempts: 1,
		});
		expect(await observations(RUN_CANARY_RACE)).toBe(0);
		expect(await aspects(RUN_CANARY_RACE)).toBe(0);
		expect(await count("usage_events")).toBe(eventsBefore);
		expect(await inspectSentimentCanaryRunState(RUN_CANARY_RACE)).toEqual({
			analysis: { status: "pending_resolution", attempts: 1, observations: 0 },
			pristine: false,
		});
	});

	it("IT-SNT-024b: simultaneous pristine-only claims on one pending/0/0 row — exactly one winner, attempts 1; the worker claim still recovers a failed row", {
		timeout: 180_000,
	}, async () => {
		const { claimAnalysis: claim, ensureAnalysis: ensure } = await import("@workspace/lib/sentiment");
		await insertRun(RUN_CANARY_RACE2, PROMPT, { choices: [{ message: { content: ANSWER } }] }, 7);
		const analysis = await ensure({ promptRunId: RUN_CANARY_RACE2, brandId: BRAND });
		const outcomes = await Promise.all(
			Array.from({ length: 8 }, () => claim(analysis.id, { allowFinished: true, pristineOnly: true })),
		);
		expect(outcomes.filter((o) => o.claimed)).toHaveLength(1);
		expect(outcomes.filter((o) => !o.claimed).every((o) => o.status === "processing")).toBe(true);
		expect(await analysisRow(RUN_CANARY_RACE2)).toEqual({ status: "processing", error_code: null, attempts: 1 });

		// The observation check is part of the same UPDATE: a pending/0 row that already has an
		// observation (for example a synthetic fixture) is not pristine either.
		await runMentionBackfill({ apply: true, brandId: BRAND });
		const [mention] = (
			await client.query<{ id: string }>(
				"SELECT id FROM prompt_run_entity_mentions WHERE prompt_run_id = $1 ORDER BY entity_key LIMIT 1",
				[RUN_CANARY_RACE2],
			)
		).rows;
		await client.query("UPDATE sentiment_analyses SET status = 'pending', attempts = 0 WHERE id = $1", [analysis.id]);
		await client.query(
			`INSERT INTO sentiment_observations (analysis_id, mention_id, prompt_run_id, brand_id, entity_type, competitor_id, entity_key, score, category, confidence, evidence)
			 VALUES ($1, $2, $3, $4, 'brand', NULL, 'brand', 60, 'positive', 0.9, '[]')`,
			[analysis.id, mention.id, RUN_CANARY_RACE2, BRAND],
		);
		expect((await claim(analysis.id, { allowFinished: true, pristineOnly: true })).claimed).toBe(false);
		expect(await analysisRow(RUN_CANARY_RACE2)).toEqual({ status: "pending", error_code: null, attempts: 0 });
		await client.query("DELETE FROM sentiment_observations WHERE analysis_id = $1", [analysis.id]);
		// A failed row is not pristine for the canary …
		await client.query("UPDATE sentiment_analyses SET status = 'failed', attempts = 1 WHERE id = $1", [analysis.id]);
		expect((await claim(analysis.id, { allowFinished: true, pristineOnly: true })).claimed).toBe(false);
		// … while the worker's own claim still retries it: normal semantics are untouched.
		const worker = await claim(analysis.id, { allowFinished: true });
		expect(worker.claimed).toBe(true);
		expect(await analysisRow(RUN_CANARY_RACE2)).toEqual({ status: "processing", error_code: null, attempts: 2 });
		await client.query("UPDATE sentiment_analyses SET status = 'failed' WHERE id = $1", [analysis.id]);
	});
});

describe("IT-SNT-025 a rejected overall claim is repaired, not terminal (grounded evidence)", () => {
	const TERMINAL_ANSWER = "Alpha settles claims slowly. Newco is fine. Sent Pipe is mentioned too.";
	const terminalPayload = { ...payload, promptRunId: RUN_TERMINAL };
	const usage = {
		inputTokens: 6410,
		outputTokens: 812,
		reasoningTokens: 300,
		costUsd: 0.020047,
		webSearchRequests: 1,
		webSearchRequestsConflict: false,
	};
	const request = {
		model: SENTIMENT_MODEL,
		webSearch: true,
		maxToolCalls: 1,
		maxOutputTokens: 8000,
		strictJsonSchema: true,
		requireParameters: true,
	};

	/** The anchor of each candidate's own sentence: s0001 Alpha, s0002 Newco, s0003 the brand. */
	const ownAnchor = (key: string) => (key === ALPHA ? "s0001" : key === NEWCO ? "s0002" : "s0003");

	/** Answers every candidate conformingly; the Alpha entity cites Newco's sentence, which the grounding guard refuses. */
	function rejectingProvider(calls: { n: number }): Provider {
		return {
			...fakeProvider(),
			id: "openrouter",
			async runStructuredResearch<T>({ prompt, schema }: { prompt: string; schema: { parse: (v: unknown) => T } }) {
				calls.n++;
				const keys = [...prompt.matchAll(/^- key "([^"]+)"/gm)].map((m) => m[1]);
				return {
					object: schema.parse({
						entities: keys.map((key) => ({
							key,
							score: 50,
							category: "neutral",
							confidence: 0.9,
							evidence: [{ anchorId: key === ALPHA ? "s0002" : ownAnchor(key), polarity: "neutral" }],
							aspects: [],
						})),
					}),
					modelVersion: SENTIMENT_MODEL,
					generationId: "gen-terminal-01",
					usage,
					request,
				};
			},
		} as unknown as Provider;
	}

	const failedEvents = () =>
		client.query<{ estimated_cost_usd: string | null; provider: string; model: string }>(
			`SELECT estimated_cost_usd, provider, model FROM usage_events
			 WHERE brand_id = $1 AND prompt_id = $2 AND event_type = 'sentiment_classification_failed' AND created_at > now() - interval '5 minutes'
			 ORDER BY created_at`,
			[BRAND, PROMPT],
		);
	const row = async () =>
		(
			await client.query<{
				status: string;
				input_hash: string | null;
				error_code: string | null;
				error_message: string | null;
				attempts: number;
			}>(
				"SELECT status, input_hash, error_code, error_message, attempts FROM sentiment_analyses WHERE prompt_run_id = $1 AND classifier_version = $2",
				[RUN_TERMINAL, SENTIMENT_CLASSIFIER_VERSION],
			)
		).rows[0];

	it("the misattributed overall becomes a repair target; the repaired candidate is verified and persisted; every paid answer is attributed once", {
		timeout: 120_000,
	}, async () => {
		await insertRun(RUN_TERMINAL, PROMPT, { choices: [{ message: { content: TERMINAL_ANSWER } }] }, 5);
		await runMentionBackfill({ apply: true, brandId: BRAND });
		const before = (await failedEvents()).rows.length;
		const calls = { n: 0 };
		const phases: string[] = [];
		const repair = {
			entities: [
				{
					key: ALPHA,
					score: 50,
					category: "neutral",
					confidence: 0.9,
					evidence: [{ anchorId: "s0001", polarity: "neutral" }],
					aspects: [],
				},
			],
		};
		const outcome = await runSentimentJob(terminalPayload, {
			resolveProvider: () =>
				withResolutionPhases(rejectingProvider(calls), { repair, onPhase: (phase) => phases.push(phase) }),
			resolutionPolicy: { backoffBaseMs: 1, backoffMaxMs: 2 },
		});
		expect(calls.n).toBe(1);
		expect(phases).toEqual(["classify", "repair", "verify"]);
		expect(outcome).toMatchObject({ status: "classified", entities: 3, paidCalls: 3, repairs: 1, verified: true });
		const entities = await loadDetectableEntities(BRAND, "historical");
		const expectedHash = sentimentInputHash(
			TERMINAL_ANSWER,
			candidatesFromMentions(await loadMentions(RUN_TERMINAL), entities),
		);
		const completed = await row();
		expect(completed).toMatchObject({ status: "completed", input_hash: expectedHash, error_code: null, attempts: 1 });
		for (const forbidden of ["settles claims slowly", TERMINAL_ANSWER, "sk-or-", "Bearer"]) {
			expect(JSON.stringify(completed)).not.toContain(forbidden);
		}
		expect(await count("sentiment_observations", "prompt_run_id = $1", [RUN_TERMINAL])).toBe(3);
		const ledger = await client.query<{ phase: string; outcome: string }>(
			"SELECT t.phase, t.outcome FROM sentiment_provider_attempts t JOIN sentiment_analyses a ON a.id = t.analysis_id WHERE a.prompt_run_id = $1 ORDER BY t.ordinal",
			[RUN_TERMINAL],
		);
		expect(ledger.rows).toEqual([
			{ phase: "classify", outcome: "rejected" },
			{ phase: "repair", outcome: "accepted" },
			{ phase: "verify", outcome: "accepted" },
		]);
		// The rejected classification was paid and is attributed as a success event (an answer arrived); nothing failed.
		expect((await failedEvents()).rows.slice(before)).toEqual([]);
	});

	it("the same input under the same versions is already complete: no claim, no request, not eligible for the enqueue inventory", {
		timeout: 120_000,
	}, async () => {
		const calls = { n: 0 };
		const before = await row();
		expect(
			await runSentimentJob(terminalPayload, {
				resolveProvider: () => withResolutionPhases(rejectingProvider(calls)),
				resolutionPolicy: { backoffBaseMs: 1, backoffMaxMs: 2 },
			}),
		).toEqual({
			status: "already-completed",
		});
		expect(calls.n).toBe(0);
		expect(await row()).toEqual(before);
		const sent: string[] = [];
		const sender = {
			send: async (_queue: string, data: { promptRunId: string }) => {
				sent.push(data.promptRunId);
				return `job-${sent.length}`;
			},
		};
		// The brand carries many eligible runs from earlier tests; the limit must not stop the scan before this run.
		const inventory = await runSentimentEnqueue({ enqueue: { limit: 100_000 }, sender, brandId: BRAND });
		expect(inventory.limitReached).toBe(false);
		expect(inventory.counts.terminalFailed).toBe(0);
		expect(sent.length).toBe(inventory.counts.accepted);
		expect(sent).not.toContain(RUN_TERMINAL);
		expect(await row()).toEqual(before);
	});

	it("an allow-listed typed refusal keeps the retry path: the job throws, the parked row carries no input hash and the next attempt classifies", {
		timeout: 120_000,
	}, async () => {
		// A changed answer is a new input and a new resolution instance.
		await client.query("UPDATE prompt_runs SET raw_output = $2 WHERE id = $1", [
			RUN_TERMINAL,
			JSON.stringify({ choices: [{ message: { content: `${TERMINAL_ANSWER} Updated.` } }] }),
		]);
		const flaky = {
			...fakeProvider(),
			id: "openrouter",
			runStructuredResearch: async () => {
				throw new StructuredResearchRequestError({
					provider: "openrouter",
					httpStatus: 503,
					errorType: "provider_overloaded",
					structured: true,
					carriesOutput: false,
					retryAfterMs: null,
					message: "OpenRouter API error (503): upstream overloaded",
				});
			},
		} as unknown as Provider;
		await expect(
			runSentimentJob(terminalPayload, {
				resolveProvider: () => withResolutionPhases(flaky),
				resolutionPolicy: { backoffBaseMs: 1, backoffMaxMs: 2 },
			}),
		).rejects.toMatchObject({
			name: "SentimentJobError",
			code: "provider",
			httpStatus: 503,
		});
		expect(await row()).toMatchObject({
			status: "pending_resolution",
			input_hash: null,
			error_code: "provider",
			attempts: 2,
		});
		const calls = { n: 0 };
		const good = {
			...fakeProvider(),
			async runStructuredResearch<T>({ prompt, schema }: { prompt: string; schema: { parse: (v: unknown) => T } }) {
				calls.n++;
				const keys = [...prompt.matchAll(/^- key "([^"]+)"/gm)].map((m) => m[1]);
				return {
					object: schema.parse({
						entities: keys.map((key) => ({
							key,
							score: 50,
							category: "neutral",
							confidence: 0.9,
							evidence: [{ anchorId: ownAnchor(key), polarity: "neutral" }],
							aspects: [],
						})),
					}),
					modelVersion: SENTIMENT_MODEL,
				};
			},
		} as unknown as Provider;
		expect(
			await runSentimentJob(terminalPayload, {
				resolveProvider: () => withResolutionPhases(good),
				resolutionPolicy: { backoffBaseMs: 1, backoffMaxMs: 2 },
			}),
		).toMatchObject({
			status: "classified",
		});
		expect(calls.n).toBe(1);
		expect(await row()).toMatchObject({ status: "completed", error_code: null, attempts: 3 });
		expect(
			await runSentimentJob(terminalPayload, {
				resolveProvider: () => withResolutionPhases(rejectingProvider(calls)),
				resolutionPolicy: { backoffBaseMs: 1, backoffMaxMs: 2 },
			}),
		).toEqual({
			status: "already-completed",
		});
	});
});

describe("IT-SNT-012 prompt deletion with a full sentiment graph (B6)", () => {
	it("the existing deletion sequence succeeds and leaves no orphan sentiment rows", { timeout: 120_000 }, async () => {
		await insertRun(RUN_DELETE, PROMPT_DELETE, { choices: [{ message: { content: ANSWER } }] }, 5);
		await client.query(
			`INSERT INTO citations (prompt_run_id, prompt_id, brand_id, model, url, domain, title, citation_index, created_at)
			 VALUES ($1, $2, $3, 'chatgpt', 'https://source.example.test/d', 'source.example.test', 'D', 0, now())`,
			[RUN_DELETE, PROMPT_DELETE, BRAND],
		);
		await runMentionBackfill({ apply: true, brandId: BRAND });
		await ensureAnalysis({ promptRunId: RUN_DELETE, brandId: BRAND });
		expect(
			await runSentimentJob(
				{ ...payload, promptRunId: RUN_DELETE },
				{
					resolveProvider: () => withResolutionPhases(fakeProvider()),
					resolutionPolicy: { backoffBaseMs: 1, backoffMaxMs: 2 },
				},
			),
		).toMatchObject({ status: "classified", entities: 3 });
		expect(await count("sentiment_detections", "prompt_run_id = $1", [RUN_DELETE])).toBe(1);
		expect(await count("prompt_run_entity_mentions", "prompt_run_id = $1", [RUN_DELETE])).toBe(3);
		expect(await count("sentiment_analyses", "prompt_run_id = $1", [RUN_DELETE])).toBe(1);
		expect(await count("sentiment_observations", "prompt_run_id = $1", [RUN_DELETE])).toBe(3);
		expect(
			await count(
				"sentiment_aspect_observations",
				"observation_id IN (SELECT id FROM sentiment_observations WHERE prompt_run_id = $1)",
				[RUN_DELETE],
			),
		).toBe(1);

		// Exactly what the prompt DELETE handler (and any older image) executes.
		await client.query("BEGIN");
		let runs: pg.QueryResult;
		let prompt: pg.QueryResult;
		try {
			await client.query("DELETE FROM citations WHERE prompt_id = $1", [PROMPT_DELETE]);
			runs = await client.query("DELETE FROM prompt_runs WHERE prompt_id = $1 RETURNING id", [PROMPT_DELETE]);
			prompt = await client.query("DELETE FROM prompts WHERE id = $1 RETURNING id", [PROMPT_DELETE]);
			await client.query("COMMIT");
		} catch (error) {
			await client.query("ROLLBACK");
			throw error;
		}
		expect(runs.rows.map((r: { id: string }) => r.id)).toEqual([RUN_DELETE]);
		expect(prompt.rowCount).toBe(1);

		for (const table of [
			"sentiment_detections",
			"prompt_run_entity_mentions",
			"sentiment_analyses",
			"sentiment_observations",
		]) {
			expect(await count(table, "prompt_run_id = $1", [RUN_DELETE])).toBe(0);
		}
		const orphans = await client.query<{ n: number }>(
			`SELECT (SELECT count(*) FROM sentiment_observations o LEFT JOIN prompt_runs r ON r.id = o.prompt_run_id WHERE r.id IS NULL)
			      + (SELECT count(*) FROM sentiment_aspect_observations x LEFT JOIN sentiment_observations o ON o.id = x.observation_id WHERE o.id IS NULL)
			      + (SELECT count(*) FROM sentiment_analyses a LEFT JOIN prompt_runs r ON r.id = a.prompt_run_id WHERE r.id IS NULL)
			      + (SELECT count(*) FROM prompt_run_entity_mentions m LEFT JOIN prompt_runs r ON r.id = m.prompt_run_id WHERE r.id IS NULL)
			      + (SELECT count(*) FROM sentiment_detections d LEFT JOIN prompt_runs r ON r.id = d.prompt_run_id WHERE r.id IS NULL) AS n`,
		);
		expect(Number(orphans.rows[0].n)).toBe(0);
	});

	it("a competitor with sentiment history cannot be hard-deleted", async () => {
		await expect(client.query("DELETE FROM competitors WHERE id = $1", [ALPHA])).rejects.toMatchObject({
			code: "23503",
		});
	});
});
