/**
 * Runs against the disposable E2E test database: `pnpm -C apps/web
 * test:integration` with DATABASE_URL pointing at the seeded test stack.
 *
 * IT-SNT-006 / IT-SNT-007 — the overview and evidence loaders reproduce the
 * canonical fixture from SQL, exclude inactive competitors, honour tags and
 * aspects, return bounded non-overlapping extremes with the run's own
 * citations, and write nothing.
 */
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must point at the seeded test stack");

const { loadSentimentEvidence, loadSentimentOverview } = await import("@/server/sentiment-load");
const { SENTIMENT_CLASSIFIER_VERSION, SENTIMENT_DETECTOR_VERSION, SENTIMENT_TAXONOMY_VERSION } = await import(
	"@workspace/lib/sentiment/types"
);

const ORG = "default";
const BRAND = "sent-it-brand";
const A = "5e970003-0000-4000-8000-00000000000a";
const B = "5e970003-0000-4000-8000-00000000000b";
const GONE = "5e970003-0000-4000-8000-00000000000c";
const P_TAGGED = "5e970003-0000-4000-8000-000000000101";
const P_PLAIN = "5e970003-0000-4000-8000-000000000102";
const runId = (i: number) => `5e970003-0000-4000-8000-0000000002${String(i).padStart(2, "0")}`;

const client = new pg.Client({ connectionString: DATABASE_URL });

async function countAll(): Promise<Record<string, number>> {
	const tables = [
		"prompt_run_entity_mentions",
		"sentiment_analyses",
		"sentiment_observations",
		"sentiment_aspect_observations",
		"pgboss.job",
		"usage_events",
	];
	const out: Record<string, number> = {};
	for (const table of tables) {
		const { rows } = await client.query(`SELECT count(*)::int AS n FROM ${table}`).catch(() => ({ rows: [{ n: -1 }] }));
		out[table] = rows[0].n;
	}
	return out;
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
		 VALUES ($1, $2, $1, 'Sent IT', 'https://sent-it.example.test/', true, true, now(), now())`,
		[BRAND, org.rows[0].id],
	);
	await client.query(
		`INSERT INTO competitors (id, brand_id, name, domains, active, removed_at, created_at, updated_at) VALUES
		 ($1, $4, 'Alpha', '{alpha.example.test}', true, NULL, now(), now()),
		 ($2, $4, 'Bravo', '{bravo.example.test}', true, NULL, now() + interval '1 second', now()),
		 ($3, $4, 'Gone', '{gone.example.test}', false, now(), now() + interval '2 seconds', now())`,
		[A, B, GONE, BRAND],
	);
	await client.query(
		`INSERT INTO prompts (id, brand_id, value, enabled, tags, system_tags, created_at, updated_at) VALUES
		 ($1, $3, 'Tagged prompt about legal cover', true, '{insurance}', '{unbranded}', now(), now()),
		 ($2, $3, 'Plain prompt', false, '{}', '{unbranded}', now(), now())`,
		[P_TAGGED, P_PLAIN, BRAND],
	);
	// T = 10 runs, 2 days ago (well inside every lookback); runs 1–5 on the tagged prompt.
	for (let i = 1; i <= 10; i++) {
		await client.query(
			`INSERT INTO prompt_runs (id, prompt_id, brand_id, model, provider, version, web_search_enabled, raw_output, brand_mentioned, competitors_mentioned, created_at)
			 VALUES ($1, $2, $3, 'chatgpt', 'openrouter', 'v', true, $4, true, '{}', now() - interval '2 days' + ($5 || ' minutes')::interval)`,
			[
				runId(i),
				i <= 5 ? P_TAGGED : P_PLAIN,
				BRAND,
				JSON.stringify({ choices: [{ message: { content: `Answer ${i}: Alpha is mentioned here. Sent IT too.` } }] }),
				String(i),
			],
		);
	}
	// Entity A mentioned in runs 1–5 (M = C = 5); entity B in run 6 (M = C = 1); brand in runs 1–10 but never classified (M = 10, C = 0);
	// inactive GONE mentioned in run 7 (must be excluded everywhere current).
	const mention = async (run: string, key: string, type: "brand" | "competitor") =>
		(
			await client.query<{ id: string }>(
				`INSERT INTO prompt_run_entity_mentions (prompt_run_id, brand_id, entity_type, competitor_id, entity_key, entity_name, detector_version)
				 VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
				[
					run,
					BRAND,
					type,
					type === "brand" ? null : key,
					key,
					key === "brand" ? "Sent IT" : key,
					SENTIMENT_DETECTOR_VERSION,
				],
			)
		).rows[0].id;
	const analysis = async (run: string, status = "completed") =>
		(
			await client.query<{ id: string }>(
				`INSERT INTO sentiment_analyses (prompt_run_id, brand_id, classifier_version, taxonomy_version, status, completed_at)
				 VALUES ($1, $2, $3, $4, $5, now()) RETURNING id`,
				[run, BRAND, SENTIMENT_CLASSIFIER_VERSION, SENTIMENT_TAXONOMY_VERSION, status],
			)
		).rows[0].id;
	const observe = async (
		analysisId: string,
		mentionId: string,
		run: string,
		key: string,
		score: number,
		category: string,
	) =>
		(
			await client.query<{ id: string }>(
				`INSERT INTO sentiment_observations (analysis_id, mention_id, prompt_run_id, brand_id, entity_type, competitor_id, entity_key, score, category, confidence, evidence)
				 VALUES ($1, $2, $3, $4, 'competitor', $5::uuid, $5::text, $6, $7, 0.9, $8::jsonb) RETURNING id`,
				[
					analysisId,
					mentionId,
					run,
					BRAND,
					key,
					score,
					category,
					JSON.stringify([{ quote: "Alpha is mentioned here", start: 10, end: 33, polarity: "positive" }]),
				],
			)
		).rows[0].id;

	const scoresA: [number, string][] = [
		[100, "positive"],
		[80, "positive"],
		[50, "mixed"],
		[40, "negative"],
		[30, "negative"],
	];
	for (let i = 1; i <= 10; i++) {
		await mention(runId(i), "brand", "brand");
		await client.query(
			`INSERT INTO sentiment_detections (prompt_run_id, brand_id, detector_version, status, mention_count)
			 VALUES ($1, $2, $3, 'mentions', 1)`,
			[runId(i), BRAND, SENTIMENT_DETECTOR_VERSION],
		);
	}
	for (let i = 1; i <= 5; i++) {
		const m = await mention(runId(i), A, "competitor");
		const an = await analysis(runId(i));
		const [score, category] = scoresA[i - 1];
		const obs = await observe(an, m, runId(i), A, score, category);
		if (i === 1) {
			await client.query(
				`INSERT INTO sentiment_aspect_observations (observation_id, taxonomy_version, aspect_key, aspect_label, score, category, confidence, evidence)
				 VALUES ($1, $2, 'price', 'Price', 20, 'negative', 0.8, $3::jsonb)`,
				[
					obs,
					SENTIMENT_TAXONOMY_VERSION,
					JSON.stringify([{ quote: "Sent IT too", start: 35, end: 46, polarity: "negative" }]),
				],
			);
		}
	}
	const mB = await mention(runId(6), B, "competitor");
	await observe(await analysis(runId(6)), mB, runId(6), B, 90, "positive");
	const mGone = await mention(runId(7), GONE, "competitor");
	await observe(await analysis(runId(7)), mGone, runId(7), GONE, 10, "negative");
	await analysis(runId(8), "failed");
	await client.query(
		`INSERT INTO citations (prompt_run_id, prompt_id, brand_id, model, url, domain, title, citation_index, created_at)
		 VALUES ($1, $2, $3, 'chatgpt', 'https://source.example.test/a', 'source.example.test', 'Source A', 0, now() - interval '2 days')`,
		[runId(1), P_TAGGED, BRAND],
	);
});

async function cleanup() {
	await client.query(
		`DELETE FROM sentiment_aspect_observations WHERE observation_id IN (SELECT id FROM sentiment_observations WHERE brand_id = $1)`,
		[BRAND],
	);
	await client.query("DELETE FROM sentiment_observations WHERE brand_id = $1", [BRAND]);
	await client.query("DELETE FROM sentiment_analyses WHERE brand_id = $1", [BRAND]);
	await client.query("DELETE FROM prompt_run_entity_mentions WHERE brand_id = $1", [BRAND]);
	await client.query("DELETE FROM sentiment_detections WHERE brand_id = $1", [BRAND]);
	await client.query("DELETE FROM citations WHERE brand_id = $1", [BRAND]);
	await client.query("DELETE FROM prompt_runs WHERE brand_id = $1", [BRAND]);
	await client.query("DELETE FROM prompts WHERE brand_id = $1", [BRAND]);
	await client.query("DELETE FROM competitors WHERE brand_id = $1", [BRAND]);
	await client.query("DELETE FROM brands WHERE id = $1", [BRAND]);
}

afterAll(async () => {
	await cleanup();
	await client.end();
});

const scope = { brandId: BRAND, lookback: "1m" as const, aspect: "overall" as const, timezone: "UTC" };

describe("IT-SNT-006 sentiment overview loader", () => {
	it("reproduces the canonical fixture and excludes the inactive competitor", async () => {
		const before = await countAll();
		const overview = await loadSentimentOverview(scope);
		expect(await countAll()).toEqual(before);

		expect(overview.eligibleResponses).toBe(10);
		expect(overview.entities.map((e) => e.key)).toEqual(["brand", A, B]);
		const a = overview.entities.find((e) => e.key === A)!;
		expect(a).toMatchObject({
			mentions: 5,
			classified: 5,
			sample: 5,
			counts: { positive: 2, neutral: 0, mixed: 1, negative: 2 },
		});
		expect(a.metrics.sentiment).toBe(60);
		expect(a.metrics.mentionVisibility).toBe(50);
		expect(a.metrics.positiveVisibility).toBe(20);
		expect(a.metrics.negativeVisibility).toBe(20);
		expect(a.metrics.positiveMix).toBe(40);
		expect(a.metrics.mixedMix).toBe(20);
		expect(a.metrics.analysisCoverage).toBe(100);
		expect(a.lowSample).toBe(false);
		const b = overview.entities.find((e) => e.key === B)!;
		expect(b.metrics.sentiment).toBe(90);
		expect(b.metrics.mentionVisibility).toBe(10);
		expect(b.lowSample).toBe(true);
		const brand = overview.entities.find((e) => e.key === "brand")!;
		expect(brand).toMatchObject({ mentions: 10, classified: 0 });
		expect(brand.metrics.sentiment).toBeNull();
		expect(brand.metrics.mentionVisibility).toBe(100);
		expect(brand.metrics.partial).toBe(true);
		expect(overview.chartRoster).toEqual(["brand", A, B]);
		expect(overview.coverage).toEqual({
			responsesDetected: 10,
			responsesWithMentions: 10,
			responsesUnextractable: 0,
			analyses: { completed: 7, pending: 0, failed: 1, noMentions: 0 },
		});
		expect(overview.aspectLabel).toBeNull();
		expect(overview.bucket).toBe("day");
		const point = overview.series.find((p) => Object.values(p.values).some((v) => v.sample > 0))!;
		expect(point.values[A]).toEqual({ sentiment: 60, sample: 5 });
		expect(point.values.brand).toEqual({ sentiment: null, sample: 0 });
		expect(overview.series.filter((p) => p.values[A].sample === 0).every((p) => p.values[A].sentiment === null)).toBe(
			true,
		);
		expect(JSON.stringify(overview)).not.toContain("Answer 1:");
		expect(JSON.stringify(overview)).not.toMatch(/openrouter|gpt-5/);
	});

	it("scopes T, mentions and classifications by tags", async () => {
		const overview = await loadSentimentOverview({ ...scope, tags: "insurance" });
		expect(overview.eligibleResponses).toBe(5);
		expect(overview.entities.find((e) => e.key === A)).toMatchObject({ mentions: 5, classified: 5 });
		expect(overview.entities.find((e) => e.key === B)).toMatchObject({ mentions: 0, classified: 0 });
		expect(overview.entities.find((e) => e.key === A)!.metrics.mentionVisibility).toBe(100);
		const none = await loadSentimentOverview({ ...scope, tags: "does-not-exist" });
		expect(none.eligibleResponses).toBe(0);
		expect(none.entities.every((e) => e.metrics.mentionVisibility === null && e.metrics.sentiment === null)).toBe(true);
	});

	it("B4: an aspect view scores the aspect sample while classifier coverage stays 5/5", async () => {
		// T = 10, A mentioned in 5, all 5 classified, exactly 1 Price observation.
		const overview = await loadSentimentOverview({ ...scope, aspect: "price" });
		expect(overview.aspectLabel).toBe("Price");
		const a = overview.entities.find((e) => e.key === A)!;
		expect(a).toMatchObject({
			mentions: 5,
			classified: 5,
			sample: 1,
			counts: { positive: 0, neutral: 0, mixed: 0, negative: 1 },
		});
		expect(a.metrics.sentiment).toBe(20);
		expect(a.metrics.sampleVisibility).toBe(10);
		expect(a.metrics.mentionVisibility).toBe(50);
		expect(a.metrics.negativeVisibility).toBe(10);
		expect(a.metrics.positiveVisibility).toBe(0);
		expect(a.metrics.analysisCoverage).toBe(100);
		expect(a.metrics.partial).toBe(false);
		expect(a.lowSample).toBe(true);
		// B is classified but never evaluated on Price: an empty sample, not a partial classification.
		const b = overview.entities.find((e) => e.key === B)!;
		expect(b).toMatchObject({ mentions: 1, classified: 1, sample: 0 });
		expect(b.metrics.sentiment).toBeNull();
		expect(b.metrics.partial).toBe(false);
		// Roster, series and evidence all rest on the same Price sample.
		expect(overview.chartRoster).toEqual(["brand", A, B]);
		const point = overview.series.find((p) => p.values[A].sample > 0)!;
		expect(point.values[A]).toEqual({ sentiment: 20, sample: 1 });
		const evidence = await loadSentimentEvidence({ ...scope, entityKey: A, aspect: "price", limit: 10 });
		expect(evidence.totalObservations).toBe(1);
		expect(overview.availableAspects.find((x) => x.key === "price")?.count).toBe(1);
		expect(overview.availableAspects.map((x) => x.key)).toEqual(["price", "coverage", "service", "other"]);
	});

	it("uses monthly buckets and the earliest run for All time", async () => {
		const overview = await loadSentimentOverview({ ...scope, lookback: "all" });
		expect(overview.eligibleResponses).toBe(10);
		expect(["day", "week", "month"]).toContain(overview.bucket);
		expect(overview.dateRange.fromDate <= overview.dateRange.toDate).toBe(true);
	});
});

describe("IT-SNT-007 sentiment evidence loader", () => {
	it("returns deterministic, non-overlapping extremes with the run's own citations and no model label", async () => {
		const before = await countAll();
		const evidence = await loadSentimentEvidence({ ...scope, entityKey: A, limit: 10 });
		expect(await countAll()).toEqual(before);
		expect(evidence.totalObservations).toBe(5);
		expect(evidence.highest.map((i) => i.score)).toEqual([100, 80, 50]);
		expect(evidence.lowest.map((i) => i.score)).toEqual([30, 40]);
		const ids = new Set([...evidence.highest, ...evidence.lowest].map((i) => i.observationId));
		expect(ids.size).toBe(5);
		const top = evidence.highest[0];
		expect(top.sources).toEqual([
			{ url: "https://source.example.test/a", domain: "source.example.test", title: "Source A" },
		]);
		expect(top.promptText).toBe("Tagged prompt about legal cover");
		expect(top.tags).toEqual(["insurance"]);
		expect(top.aspects).toEqual([{ key: "price", label: "Price", score: 20, category: "negative" }]);
		expect(top.excerpt).toContain("Alpha is mentioned here");
		// B7: the stored raw offsets resolve to the cited characters inside the excerpt window.
		const span = top.evidence[0];
		expect(top.excerpt.slice(span.start - top.excerptStart, span.end - top.excerptStart)).toBe(
			"Alpha is mentioned here",
		);
		expect(span.polarity).toBe("positive");
		expect(evidence.lowest[0].sources).toEqual([]);
		expect(JSON.stringify(evidence)).not.toMatch(/openrouter|gpt-5|classifier/);
	});

	it("selects the aspect's own evidence and category when an aspect is chosen", async () => {
		const evidence = await loadSentimentEvidence({ ...scope, entityKey: A, aspect: "price", limit: 10 });
		expect(evidence.totalObservations).toBe(1);
		expect(evidence.highest.map((i) => `${i.score}:${i.category}`)).toEqual(["20:negative"]);
		expect(evidence.lowest).toEqual([]);
		const span = evidence.highest[0].evidence[0];
		expect(
			evidence.highest[0].excerpt.slice(
				span.start - evidence.highest[0].excerptStart,
				span.end - evidence.highest[0].excerptStart,
			),
		).toBe("Sent IT too");
	});

	it("rejects an entity that does not belong to the brand", async () => {
		await expect(loadSentimentEvidence({ ...scope, brandId: "default", entityKey: A, limit: 10 })).rejects.toThrow(
			/Entity not found/,
		);
	});
});
