/**
 * Runs against the disposable test database: `pnpm -C apps/web
 * test:integration` with DATABASE_URL pointing at it.
 *
 * V4-RED-007 / V4-RED-008 — transitional read policy across classifier
 * versions: every Sentiment read prefers a completed `sent-classifier-v4`
 * analysis per run, falls back to the completed `sent-classifier-v3` analysis
 * when v4 has none, never counts both, never lets a failed or pending v4 hide
 * v3, and keeps v2 and older excluded. Coverage, metrics, series, leaderboard
 * and Top/Bottom evidence all derive from the same selection.
 */
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must point at the seeded test stack");

const { loadSentimentEvidence, loadSentimentOverview } = await import("@/server/sentiment-load");
const { SENTIMENT_DETECTOR_VERSION, SENTIMENT_TAXONOMY_VERSION, SENTIMENT_READABLE_CLASSIFIER_VERSIONS } = await import(
	"@workspace/lib/sentiment/types"
);

const V4 = "sent-classifier-v4";
const V3 = "sent-classifier-v3";
const V2 = "sent-classifier-v2";

const ORG = "default";
const BRAND = "sent-v4-brand";
const A = "5e970004-0000-4000-8000-00000000000a";
const PROMPT = "5e970004-0000-4000-8000-000000000101";
const runId = (i: number) => `5e970004-0000-4000-8000-0000000002${String(i).padStart(2, "0")}`;
const client = new pg.Client({ connectionString: DATABASE_URL });

const analysisRows: Record<string, string> = {};

async function seedRun(i: number): Promise<string> {
	await client.query(
		`INSERT INTO prompt_runs (id, prompt_id, brand_id, model, provider, version, web_search_enabled, raw_output, brand_mentioned, competitors_mentioned, created_at)
		 VALUES ($1, $2, $3, 'chatgpt', 'openrouter', 'v', true, $4, true, '{}', now() - interval '2 days' + ($5 || ' minutes')::interval)`,
		[
			runId(i),
			PROMPT,
			BRAND,
			JSON.stringify({ choices: [{ message: { content: `Answer ${i}: Alpha is mentioned here. Sent V4 too.` } }] }),
			String(i),
		],
	);
	await client.query(
		`INSERT INTO sentiment_detections (prompt_run_id, brand_id, detector_version, status, mention_count) VALUES ($1, $2, $3, 'mentions', 1)`,
		[runId(i), BRAND, SENTIMENT_DETECTOR_VERSION],
	);
	const { rows } = await client.query<{ id: string }>(
		`INSERT INTO prompt_run_entity_mentions (prompt_run_id, brand_id, entity_type, competitor_id, entity_key, entity_name, detector_version)
		 VALUES ($1, $2, 'competitor', $3::uuid, $3::text, 'Alpha', $4) RETURNING id`,
		[runId(i), BRAND, A, SENTIMENT_DETECTOR_VERSION],
	);
	return rows[0].id;
}

async function analysis(i: number, version: string, status: string, taxonomy = SENTIMENT_TAXONOMY_VERSION) {
	const { rows } = await client.query<{ id: string }>(
		`INSERT INTO sentiment_analyses (prompt_run_id, brand_id, classifier_version, taxonomy_version, status, completed_at)
		 VALUES ($1, $2, $3, $4, $5, CASE WHEN $5 IN ('completed','failed') THEN now() ELSE NULL END) RETURNING id`,
		[runId(i), BRAND, version, taxonomy, status],
	);
	analysisRows[`${i}:${version}`] = rows[0].id;
	return rows[0].id;
}

async function observe(
	analysisId: string,
	mentionId: string,
	i: number,
	score: number,
	category: string,
	aspectScore?: number,
) {
	const { rows } = await client.query<{ id: string }>(
		`INSERT INTO sentiment_observations (analysis_id, mention_id, prompt_run_id, brand_id, entity_type, competitor_id, entity_key, score, category, confidence, evidence)
		 VALUES ($1, $2, $3, $4, 'competitor', $5::uuid, $5::text, $6, $7, 0.9, $8::jsonb) RETURNING id`,
		[
			analysisId,
			mentionId,
			runId(i),
			BRAND,
			A,
			score,
			category,
			JSON.stringify([
				{
					quote: "Alpha is mentioned here",
					start: 10,
					end: 33,
					polarity: score > 50 ? "positive" : score < 50 ? "negative" : "neutral",
				},
			]),
		],
	);
	if (aspectScore !== undefined) {
		await client.query(
			`INSERT INTO sentiment_aspect_observations (observation_id, taxonomy_version, aspect_key, aspect_label, score, category, confidence, evidence)
			 VALUES ($1, $2, 'price', 'Price', $3, $4, 0.8, $5::jsonb)`,
			[
				rows[0].id,
				SENTIMENT_TAXONOMY_VERSION,
				aspectScore,
				aspectScore > 50 ? "positive" : "negative",
				JSON.stringify([
					{ quote: "Sent V4 too", start: 35, end: 46, polarity: aspectScore > 50 ? "positive" : "negative" },
				]),
			],
		);
	}
	return rows[0].id;
}

async function cleanup() {
	await client.query(
		`DELETE FROM sentiment_aspect_observations WHERE observation_id IN (SELECT id FROM sentiment_observations WHERE brand_id = $1)`,
		[BRAND],
	);
	await client.query("DELETE FROM sentiment_observations WHERE brand_id = $1", [BRAND]);
	await client.query("DELETE FROM sentiment_analyses WHERE brand_id = $1", [BRAND]);
	await client.query("DELETE FROM prompt_run_entity_mentions WHERE brand_id = $1", [BRAND]);
	await client.query("DELETE FROM sentiment_detections WHERE brand_id = $1", [BRAND]);
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
		 VALUES ($1, $2, $1, 'Sent V4', 'https://sent-v4.example.test/', true, true, now(), now())`,
		[BRAND, org.rows[0].id],
	);
	await client.query(
		`INSERT INTO competitors (id, brand_id, name, domains, active, removed_at, created_at, updated_at) VALUES ($1, $2, 'Alpha', '{alpha.example.test}', true, NULL, now(), now())`,
		[A, BRAND],
	);
	await client.query(
		`INSERT INTO prompts (id, brand_id, value, enabled, tags, system_tags, created_at, updated_at) VALUES ($1, $2, 'Fallback prompt', true, '{}', '{unbranded}', now(), now())`,
		[PROMPT, BRAND],
	);
	// Run 1: v3 completed only (history)                       → counted, score 80
	// Run 2: v4 completed only (new)                            → counted, score 90
	// Run 3: v3 completed 20 + v4 completed 100                 → counted once, v4 wins (100)
	// Run 4: v3 completed 40 + v4 failed                        → counted, v3 stays (40)
	// Run 5: v2 completed only                                  → excluded
	// Run 6: v3 completed 60 + v4 pending                       → counted, v3 (60)
	// Run 7: v3 completed under an older taxonomy               → excluded (stale)
	const m: Record<number, string> = {};
	for (let i = 1; i <= 7; i++) m[i] = await seedRun(i);
	await observe(await analysis(1, V3, "completed"), m[1], 1, 80, "positive", 70);
	await observe(await analysis(2, V4, "completed"), m[2], 2, 90, "positive", 95);
	await observe(await analysis(3, V3, "completed"), m[3], 3, 20, "negative", 10);
	await observe(await analysis(3, V4, "completed"), m[3], 3, 100, "positive", 100);
	await observe(await analysis(4, V3, "completed"), m[4], 4, 40, "negative");
	await analysis(4, V4, "failed");
	await observe(await analysis(5, V2, "completed"), m[5], 5, 100, "positive");
	await observe(await analysis(6, V3, "completed"), m[6], 6, 60, "positive");
	await analysis(6, V4, "pending");
	await observe(await analysis(7, V3, "completed", "sent-aspects-v0"), m[7], 7, 100, "positive");
});

afterAll(async () => {
	await cleanup();
	await client.end();
});

const scope = { brandId: BRAND, lookback: "1m" as const, aspect: "overall" as const, timezone: "UTC" };

describe("V4-RED-007 / V4-RED-008 transitional version selection", () => {
	it("declares v4 preferred over v3 and nothing older as readable", () => {
		expect(SENTIMENT_READABLE_CLASSIFIER_VERSIONS).toEqual([V4, V3]);
	});

	it("counts exactly one analysis per run: v4 when completed, otherwise the completed v3, never v2 or a stale taxonomy", async () => {
		const overview = await loadSentimentOverview(scope);
		const a = overview.entities.find((e) => e.key === A)!;
		// runs 1 (80), 2 (90), 3 (100 from v4), 4 (40 from v3), 6 (60 from v3)
		expect(a.mentions).toBe(7);
		expect(a.classified).toBe(5);
		expect(a.sample).toBe(5);
		expect(a.counts).toEqual({ positive: 4, neutral: 0, mixed: 0, negative: 1 });
		expect(a.metrics.sentiment).toBe((80 + 90 + 100 + 40 + 60) / 5);
		expect(overview.coverage.analyses.completed).toBe(5);
		expect(overview.coverage.analyses.failed).toBe(0);
		expect(overview.coverage.analyses.pending).toBe(2);
		const point = overview.series.find((p) => p.values[A]?.sample > 0)!;
		expect(point.values[A]).toEqual({ sentiment: 74, sample: 5 });
	});

	it("selects the same analysis for aspect views", async () => {
		const overview = await loadSentimentOverview({ ...scope, aspect: "price" });
		const a = overview.entities.find((e) => e.key === A)!;
		// price rows: run 1 (70, v3), run 2 (95, v4), run 3 (100, v4 — the v3 row's 10 must not appear)
		expect(a.sample).toBe(3);
		expect(a.metrics.sentiment).toBe((70 + 95 + 100) / 3);
	});

	it("Top/Bottom evidence comes from the selected analyses only", async () => {
		const evidence = await loadSentimentEvidence({ ...scope, entityKey: A, limit: 5 });
		expect(evidence.totalObservations).toBe(5);
		const runs = [...evidence.highest, ...evidence.lowest].map((item) => [item.promptRunId, item.score]);
		expect(runs).toEqual(
			expect.arrayContaining([
				[runId(3), 100],
				[runId(2), 90],
				[runId(1), 80],
				[runId(6), 60],
				[runId(4), 40],
			]),
		);
		expect(runs.map(([id]) => id)).not.toContain(runId(5));
		expect(runs.map(([id]) => id)).not.toContain(runId(7));
		expect(evidence.highest.map((item) => item.observationId)).not.toContain(analysisRows["3:sent-classifier-v3"]);
	});

	it("a failed v4 attempt leaves the completed v3 analysis visible and does not count as failed coverage", async () => {
		const overview = await loadSentimentOverview(scope);
		expect(overview.coverage.analyses.failed).toBe(0);
		const evidence = await loadSentimentEvidence({ ...scope, entityKey: A, limit: 5 });
		expect(
			[...evidence.highest, ...evidence.lowest].some((item) => item.promptRunId === runId(4) && item.score === 40),
		).toBe(true);
	});

	it("removing the v4 rows restores the v3 fallback per run; adding them back replaces only those runs", async () => {
		await client.query(
			"DELETE FROM sentiment_aspect_observations WHERE observation_id IN (SELECT id FROM sentiment_observations WHERE analysis_id = $1)",
			[analysisRows["3:sent-classifier-v4"]],
		);
		await client.query("DELETE FROM sentiment_observations WHERE analysis_id = $1", [
			analysisRows["3:sent-classifier-v4"],
		]);
		await client.query("DELETE FROM sentiment_analyses WHERE id = $1", [analysisRows["3:sent-classifier-v4"]]);
		const withoutV4 = await loadSentimentOverview(scope);
		const a = withoutV4.entities.find((e) => e.key === A)!;
		expect(a.sample).toBe(5);
		expect(a.metrics.sentiment).toBe((80 + 90 + 20 + 40 + 60) / 5);
		expect(a.counts.negative).toBe(2);
	});
});
