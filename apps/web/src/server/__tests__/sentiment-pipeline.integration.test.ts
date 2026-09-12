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

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must point at the seeded test stack");

const {
	ensureAnalysis,
	runMentionBackfill,
	runSentimentEnqueue,
	runSentimentJob,
	SENTIMENT_CLASSIFIER_VERSION,
	SENTIMENT_DETECTOR_VERSION,
	SENTIMENT_MODEL,
	SENTIMENT_TAXONOMY_VERSION,
	sentimentClassificationResultSchema,
} = await import("@workspace/lib/sentiment");
const { explainSentimentEvidence, loadSentimentEvidence, loadSentimentOverview } = await import(
	"@/server/sentiment-load"
);
type Provider = import("@workspace/lib/providers/types").Provider;

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
function fakeProvider(options: { hold?: Promise<void>; onCall?: () => void } = {}): Provider {
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
					evidence: [
						{
							quote:
								key === ALPHA
									? "Alpha handles claims fast and fairly"
									: key === NEWCO
										? "Newco is also mentioned"
										: "Sent Pipe is fine",
							polarity: "positive",
						},
					],
					aspects:
						key === ALPHA
							? [
									{
										key: "service",
										score: 85,
										category: "positive",
										confidence: 0.9,
										evidence: [{ quote: "handles claims fast", polarity: "positive" }],
									},
								]
							: [],
				})),
			});
			return { object: object as T, modelVersion: SENTIMENT_MODEL };
		},
	} as unknown as Provider;
}

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
	await client.query(
		`INSERT INTO prompts (id, brand_id, value, enabled, tags, system_tags, created_at, updated_at)
		 VALUES ($1, $3, 'Pipeline prompt', true, '{}', '{unbranded}', now(), now()),
		        ($2, $3, 'Prompt to delete', true, '{}', '{unbranded}', now(), now())`,
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
		const provider = fakeProvider({ hold: barrier, onCall: () => calls++ });
		const outcomes = await Promise.all(
			Array.from({ length: N }, () =>
				runSentimentJob(payload, { resolveProvider: () => provider }).then((outcome) => {
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
		expect(await count("usage_events", "brand_id = $1 AND event_type = 'sentiment_classification'", [BRAND])).toBe(1);
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
		expect(ANSWER.slice(span.start, span.end)).toBe("Alpha handles claims fast and fairly");
		expect(span.polarity).toBe("positive");
	});

	it("a live processing claim is not stolen; an abandoned one (older than the claim timeout) is recovered", async () => {
		let calls = 0;
		const provider = fakeProvider({ onCall: () => calls++ });
		await client.query(
			"UPDATE sentiment_analyses SET status = 'processing', started_at = now() WHERE prompt_run_id = $1",
			[RUN_MENTIONS],
		);
		expect(await runSentimentJob(payload, { resolveProvider: () => provider })).toEqual({
			status: "claimed-elsewhere",
			analysisStatus: "processing",
		});
		expect(calls).toBe(0);
		await client.query(
			"UPDATE sentiment_analyses SET status = 'processing', started_at = now() - interval '16 minutes' WHERE prompt_run_id = $1",
			[RUN_MENTIONS],
		);
		expect(await runSentimentJob(payload, { resolveProvider: () => provider })).toEqual({
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
		await client.query("UPDATE sentiment_analyses SET status = 'failed' WHERE prompt_run_id = $1", [RUN_MENTIONS]);
		const failing = {
			...fakeProvider(),
			id: "openrouter",
			runStructuredResearch: async () => {
				throw new Error("OpenRouter API error (429): rate limited; key sk-or-should-not-leak");
			},
		} as unknown as Provider;
		await expect(runSentimentJob(payload, { resolveProvider: () => failing })).rejects.toThrow(/429/);
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
		expect(row).toMatchObject({
			status: "failed",
			provider: "openrouter",
			model: SENTIMENT_MODEL,
			error_code: "provider",
		});
		const [event] = (
			await client.query<{ provider: string; model: string; web_search_enabled: boolean }>(
				"SELECT provider, model, web_search_enabled FROM usage_events WHERE brand_id = $1 AND event_type = 'sentiment_classification_failed'",
				[BRAND],
			)
		).rows;
		expect(event).toEqual({ provider: "openrouter", model: SENTIMENT_MODEL, web_search_enabled: true });
		// Recover for the following tests.
		expect(await runSentimentJob(payload, { resolveProvider: () => fakeProvider() })).toEqual({
			status: "classified",
			entities: 2,
		});
	});
});

describe("IT-SNT-011 input hash and freshness (B8)", () => {
	it("a current completed analysis is skipped without a call", async () => {
		let calls = 0;
		const inventory = await runSentimentEnqueue({ enqueue: false, brandId: BRAND });
		expect(inventory.counts).toMatchObject({ completed: 1, eligible: 0, eligibleStale: 0 });
		expect(await runSentimentJob(payload, { resolveProvider: () => fakeProvider({ onCall: () => calls++ }) })).toEqual({
			status: "already-completed",
		});
		expect(calls).toBe(0);
	});

	it("an alias edit changes the classifier input: the run becomes eligible and is reclassified once", async () => {
		await client.query("UPDATE competitors SET aliases = '{Alpha Legal}' WHERE id = $1", [ALPHA]);
		const inventory = await runSentimentEnqueue({ enqueue: false, brandId: BRAND });
		expect(inventory.counts).toMatchObject({ completed: 0, eligible: 1, eligibleStale: 1 });
		let calls = 0;
		expect(await runSentimentJob(payload, { resolveProvider: () => fakeProvider({ onCall: () => calls++ }) })).toEqual({
			status: "classified",
			entities: 2,
		});
		expect(calls).toBe(1);
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
		expect(await runSentimentJob(payload, { resolveProvider: () => fakeProvider() })).toEqual({
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
		expect(await runSentimentJob(payload, { resolveProvider: () => fakeProvider() })).toEqual({
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
		expect(await runSentimentJob(payload, { resolveProvider: () => fakeProvider() })).toEqual({
			status: "classified",
			entities: 3,
		});
		expect((await runSentimentEnqueue({ enqueue: false, brandId: BRAND })).counts).toMatchObject({ completed: 1 });
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
			   INSERT INTO sentiment_analyses (prompt_run_id, brand_id, classifier_version, taxonomy_version, status, input_hash, completed_at)
			   SELECT id, $2, $6, $7, 'completed', 'bulk', now() FROM r RETURNING id AS analysis_id, prompt_run_id
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
		const total = await count("sentiment_observations", "brand_id = $1 AND entity_key = $2", [BRAND, ALPHA]);
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
			 WHERE o.brand_id = $1 AND o.entity_key = $2 ORDER BY o.score DESC, r.created_at DESC, r.prompt_id DESC, o.prompt_run_id DESC, o.id DESC LIMIT 10`,
			[BRAND, ALPHA],
		);
		expect(evidence.highest.map((i) => i.observationId)).toEqual(oracle.rows.map((r) => r.id));
		const lowOracle = await client.query<{ id: string }>(
			`SELECT o.id FROM sentiment_observations o JOIN prompt_runs r ON r.id = o.prompt_run_id
			 WHERE o.brand_id = $1 AND o.entity_key = $2 ORDER BY o.score ASC, r.created_at ASC, r.prompt_id ASC, o.prompt_run_id ASC, o.id ASC LIMIT 10`,
			[BRAND, ALPHA],
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
			await runSentimentJob({ ...payload, promptRunId: RUN_DELETE }, { resolveProvider: () => fakeProvider() }),
		).toEqual({ status: "classified", entities: 3 });
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
		expect(runs.rowCount).toBe(1);
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
