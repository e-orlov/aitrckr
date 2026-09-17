/**
 * Runs against the disposable test database: `pnpm -C apps/web
 * test:integration` with DATABASE_URL pointing at it.
 *
 * V5-RED-010…V5-RED-016 — grounded-claim completion on real Postgres: a
 * provider answer with a valid overall and an ungrounded aspect claim ends as a
 * completed `sent-classifier-v5` analysis with the grounded rows only, the
 * dropped claim is recorded once in the structured audit table (ids and codes,
 * never text), the paid call is attributed exactly once with its actual cost,
 * a repeat job makes no provider call, a persistence failure rolls observations,
 * aspects and audit back together, and the read selection prefers v5 over v4
 * over v3 without ever counting a run twice or letting a failed/pending v5 hide
 * an older completed analysis.
 */
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must point at the seeded test stack");

const {
	SENTIMENT_CLASSIFIER_VERSION,
	SENTIMENT_DETECTOR_VERSION,
	SENTIMENT_MODEL,
	SENTIMENT_READABLE_CLASSIFIER_VERSIONS,
	SENTIMENT_TAXONOMY_VERSION,
	runSentimentJob,
	selectedSentimentAnalyses,
	sentimentProviderResultSchema,
} = await import("@workspace/lib/sentiment");
const { loadSentimentOverview } = await import("@/server/sentiment-load");
type Provider = import("@workspace/lib/providers/types").Provider;

const ORG = "default";
const BRAND = "sent-v5-brand";
const PROMPT = "5e970005-0000-4000-8000-000000000101";
const RUN_CAVEAT = "5e970005-0000-4000-8000-000000000201";
const RUN_PERSIST_FAIL = "5e970005-0000-4000-8000-000000000202";
const runId = (i: number) => `5e970005-0000-4000-8000-0000000003${String(i).padStart(2, "0")}`;

/** Structure of production run 2da20f88: candidate named in s0001/s0003/s0009; s0006/s0007 generic caveat bullets. */
const CAVEAT_ANSWER = `Wenn du die **Sent V5-Rechtsschutzversicherung** meinst: **Ja, sie kann gut sein – besonders beim Leistungsumfang –, aber sie ist nicht automatisch die beste Wahl für jeden.**

**Dafür spricht:**
- Vergleichstests bewerten den Leistungsumfang der Sent V5 positiv.
- Es gibt umfangreiche Leistungen, etwa weltweiten Schutz – je nach Tarif.

**Worauf du achten solltest:**
- Tarife unterscheiden sich stark bei Wartezeit, Selbstbeteiligung und Ausschlüssen.
- Ein Premium-Tarif kann deutlich teurer sein als ein ausreichender Basistarif.

**Kurz gesagt:**
Für Rechtsschutz ist die Sent V5 grundsätzlich ein seriöser und leistungsstarker Anbieter.`;

const client = new pg.Client({ connectionString: DATABASE_URL });
const payload = (promptRunId: string) => ({
	promptRunId,
	classifierVersion: SENTIMENT_CLASSIFIER_VERSION,
	taxonomyVersion: SENTIMENT_TAXONOMY_VERSION,
});

const count = async (sqlText: string, params: unknown[] = []) =>
	(await client.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${sqlText}`, params)).rows[0].n;

/** The 2da20f88-shaped answer: valid overall + coverage, a price aspect resting on the generic caveat bullet. */
function caveatProvider(onCall: () => void, costUsd = 0.019128): Provider {
	return {
		id: "fake-openrouter",
		name: "Fake",
		access: "api",
		isConfigured: () => true,
		async runStructuredResearch<T>() {
			onCall();
			const object = sentimentProviderResultSchema.parse({
				entities: [
					{
						key: "brand",
						category: "positive",
						score: 70,
						confidence: 0.9,
						evidence: [
							{ anchorId: "s0001", polarity: "positive" },
							{ anchorId: "s0009", polarity: "positive" },
						],
						aspects: [
							{
								key: "coverage",
								category: "positive",
								score: 80,
								confidence: 0.9,
								evidence: [{ anchorId: "s0003", polarity: "positive" }],
							},
							{
								key: "price",
								category: "negative",
								score: 30,
								confidence: 0.8,
								evidence: [{ anchorId: "s0007", polarity: "negative" }],
							},
						],
					},
				],
			});
			return {
				object: object as T,
				modelVersion: SENTIMENT_MODEL,
				generationId: "gen-v5-it-001",
				usage: {
					inputTokens: 10360,
					outputTokens: 3269,
					reasoningTokens: 2752,
					costUsd,
					webSearchRequests: 1,
					webSearchRequestsConflict: false,
				},
			};
		},
	} as unknown as Provider;
}

async function insertRun(id: string, answer: string, minutesAgo: number) {
	await client.query(
		`INSERT INTO prompt_runs (id, prompt_id, brand_id, model, provider, version, web_search_enabled, raw_output, brand_mentioned, competitors_mentioned, created_at)
		 VALUES ($1, $2, $3, 'chatgpt', 'openrouter', 'v', true, $4, true, '{}', now() - ($5 || ' minutes')::interval)`,
		[id, PROMPT, BRAND, JSON.stringify({ choices: [{ message: { content: answer } }] }), String(minutesAgo)],
	);
}

async function seedAnalysis(i: number, version: string, status: string, score?: number) {
	await client.query(
		`INSERT INTO sentiment_detections (prompt_run_id, brand_id, detector_version, status, mention_count) VALUES ($1, $2, $3, 'mentions', 1) ON CONFLICT DO NOTHING`,
		[runId(i), BRAND, SENTIMENT_DETECTOR_VERSION],
	);
	const mention = await client.query<{ id: string }>(
		`INSERT INTO prompt_run_entity_mentions (prompt_run_id, brand_id, entity_type, competitor_id, entity_key, entity_name, detector_version)
		 VALUES ($1, $2, 'brand', NULL, 'brand', 'Sent V5', $3) ON CONFLICT (prompt_run_id, entity_key) DO UPDATE SET entity_name = EXCLUDED.entity_name RETURNING id`,
		[runId(i), BRAND, SENTIMENT_DETECTOR_VERSION],
	);
	const analysis = await client.query<{ id: string }>(
		`INSERT INTO sentiment_analyses (prompt_run_id, brand_id, classifier_version, taxonomy_version, status, completed_at)
		 VALUES ($1, $2, $3, $4, $5, CASE WHEN $5 IN ('completed','failed') THEN now() ELSE NULL END) RETURNING id`,
		[runId(i), BRAND, version, SENTIMENT_TAXONOMY_VERSION, status],
	);
	if (score !== undefined) {
		await client.query(
			`INSERT INTO sentiment_observations (analysis_id, mention_id, prompt_run_id, brand_id, entity_type, competitor_id, entity_key, score, category, confidence, evidence)
			 VALUES ($1, $2, $3, $4, 'brand', NULL, 'brand', $5, $6, 0.9, $7::jsonb)`,
			[
				analysis.rows[0].id,
				mention.rows[0].id,
				runId(i),
				BRAND,
				score,
				score > 50 ? "positive" : "negative",
				JSON.stringify([{ quote: "Sent V5", start: 0, end: 7, polarity: score > 50 ? "positive" : "negative" }]),
			],
		);
	}
	return analysis.rows[0].id;
}

async function cleanup() {
	await client.query("DELETE FROM usage_events WHERE brand_id = $1", [BRAND]);
	await client.query("DELETE FROM prompt_runs WHERE brand_id = $1", [BRAND]);
	await client.query("DELETE FROM prompts WHERE brand_id = $1", [BRAND]);
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
		 VALUES ($1, $2, $1, 'Sent V5', 'https://sent-v5.example.test/', true, true, now(), now())`,
		[BRAND, org.rows[0].id],
	);
	await client.query(
		`INSERT INTO prompts (id, brand_id, value, enabled, tags, system_tags, created_at, updated_at)
		 VALUES ($1, $2, 'V5 prompt', false, '{}', '{unbranded}', now(), now())`,
		[PROMPT, BRAND],
	);
	await insertRun(RUN_CAVEAT, CAVEAT_ANSWER, 30);
	await insertRun(RUN_PERSIST_FAIL, CAVEAT_ANSWER, 25);
	for (let i = 1; i <= 5; i++) await insertRun(runId(i), `Sent V5 is mentioned in run ${i}.`, 60 + i);
});

afterAll(async () => {
	await cleanup();
	await client.end();
});

describe("V5-RED-010 the 2da20f88 shape completes on real Postgres", () => {
	let calls = 0;

	it("classified: overall + coverage persisted, price dropped, one filtered claim, one paid success", async () => {
		const outcome = await runSentimentJob(payload(RUN_CAVEAT), {
			resolveProvider: () => caveatProvider(() => calls++),
		});
		expect(outcome).toMatchObject({
			status: "classified",
			entities: 1,
			generationId: "gen-v5-it-001",
			filteredClaimCount: 1,
			filteredClaimCodes: { "aspect-ungrounded": 1 },
		});
		expect(calls).toBe(1);

		const analysis = await client.query<{
			status: string;
			attempts: number;
			classifier_version: string;
			error_code: string | null;
			error_message: string | null;
		}>(
			"SELECT status, attempts, classifier_version, error_code, error_message FROM sentiment_analyses WHERE prompt_run_id = $1",
			[RUN_CAVEAT],
		);
		expect(analysis.rows).toEqual([
			{
				status: "completed",
				attempts: 1,
				classifier_version: "sent-classifier-v5",
				error_code: null,
				error_message: null,
			},
		]);
		const aspects = await client.query<{ aspect_key: string; category: string; score: number }>(
			`SELECT a.aspect_key, a.category, a.score FROM sentiment_aspect_observations a JOIN sentiment_observations o ON o.id = a.observation_id WHERE o.prompt_run_id = $1 ORDER BY a.aspect_key`,
			[RUN_CAVEAT],
		);
		expect(aspects.rows).toEqual([{ aspect_key: "coverage", category: "positive", score: 80 }]);

		const audit = await client.query<Record<string, unknown>>(
			`SELECT c.entity_type, c.entity_key, c.aspect_key, c.validation_code, c.classifier_version, c.anchor_ids
			 FROM sentiment_filtered_claims c JOIN sentiment_analyses s ON s.id = c.analysis_id WHERE s.prompt_run_id = $1`,
			[RUN_CAVEAT],
		);
		expect(audit.rows).toEqual([
			{
				entity_type: "brand",
				entity_key: "brand",
				aspect_key: "price",
				validation_code: "aspect-ungrounded",
				classifier_version: "sent-classifier-v5",
				anchor_ids: ["s0007"],
			},
		]);

		const usage = await client.query<{ event_type: string; estimated_cost_usd: string }>(
			"SELECT event_type, estimated_cost_usd::text FROM usage_events WHERE brand_id = $1 AND event_type LIKE 'sentiment%'",
			[BRAND],
		);
		expect(usage.rows).toEqual([{ event_type: "sentiment_classification", estimated_cost_usd: "0.019128" }]);
	});

	it("the audit table has no column that could hold answer text, a prompt or a payload", async () => {
		const columns = await client.query<{ column_name: string; data_type: string }>(
			"SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'sentiment_filtered_claims' ORDER BY ordinal_position",
		);
		expect(columns.rows.map((c) => c.column_name).sort()).toEqual(
			[
				"id",
				"analysis_id",
				"entity_type",
				"entity_key",
				"aspect_key",
				"validation_code",
				"classifier_version",
				"anchor_ids",
				"created_at",
			].sort(),
		);
		const textual = columns.rows
			.filter((c) => c.data_type === "text")
			.map((c) => c.column_name)
			.sort();
		expect(textual).toEqual(["aspect_key", "classifier_version", "entity_key", "entity_type", "validation_code"]);
	});

	it("a repeat job makes no provider call and changes nothing", async () => {
		const outcome = await runSentimentJob(payload(RUN_CAVEAT), {
			resolveProvider: () => caveatProvider(() => calls++),
		});
		expect(outcome).toEqual({ status: "already-completed" });
		expect(calls).toBe(1);
		expect(
			await count(
				"sentiment_filtered_claims c JOIN sentiment_analyses s ON s.id = c.analysis_id WHERE s.prompt_run_id = $1",
				[RUN_CAVEAT],
			),
		).toBe(1);
		expect(await count("usage_events WHERE brand_id = $1 AND event_type LIKE 'sentiment%'", [BRAND])).toBe(1);
	});

	it("re-persisting the same classification does not duplicate audit rows", async () => {
		const { persistClassification, validateClassificationDetailed, loadMentions, sentimentInputHash } = await import(
			"@workspace/lib/sentiment"
		);
		const { rows } = await client.query<{ id: string; claim_generation: number }>(
			"SELECT id, claim_generation FROM sentiment_analyses WHERE prompt_run_id = $1",
			[RUN_CAVEAT],
		);
		const mentions = await loadMentions(RUN_CAVEAT);
		const candidates = [
			{ key: "brand", entityType: "brand" as const, competitorId: null, name: "Sent V5", aliases: [] },
		];
		const provider = caveatProvider(() => undefined);
		const { object } = await provider.runStructuredResearch!({
			prompt: "",
			schema: sentimentProviderResultSchema,
		} as never);
		const detailed = validateClassificationDetailed(object, { answerBody: CAVEAT_ANSWER, candidates });
		const classification = {
			...detailed,
			provider: "openrouter",
			model: SENTIMENT_MODEL,
			webSearch: true,
			classifierVersion: SENTIMENT_CLASSIFIER_VERSION,
			taxonomyVersion: SENTIMENT_TAXONOMY_VERSION,
			inputHash: sentimentInputHash(CAVEAT_ANSWER, candidates),
		};
		for (let i = 0; i < 2; i++) {
			await persistClassification({
				claim: { analysisId: rows[0].id, generation: rows[0].claim_generation },
				promptRunId: RUN_CAVEAT,
				brandId: BRAND,
				mentions,
				classification,
			});
		}
		expect(await count("sentiment_filtered_claims WHERE analysis_id = $1", [rows[0].id])).toBe(1);
		expect(await count("sentiment_observations WHERE analysis_id = $1", [rows[0].id])).toBe(1);
	});
});

describe("V5-RED-012 persistence failure rolls observations, aspects and audit back together", () => {
	it("nothing of the attempt survives; the analysis is failed with the persistence code and the paid call attributed", async () => {
		const { persistClassification } = await import("@workspace/lib/sentiment");
		const persist: typeof persistClassification = async (args) => {
			// Fail after the row-level writes began: drop the mention the entity needs.
			await persistClassification({ ...args, mentions: [] }).catch((error) => {
				throw error;
			});
		};
		await expect(
			runSentimentJob(payload(RUN_PERSIST_FAIL), { resolveProvider: () => caveatProvider(() => undefined), persist }),
		).rejects.toMatchObject({ kind: "store" });
		const analysis = await client.query<{ status: string; error_code: string }>(
			"SELECT status, error_code FROM sentiment_analyses WHERE prompt_run_id = $1",
			[RUN_PERSIST_FAIL],
		);
		expect(analysis.rows).toEqual([{ status: "failed", error_code: "persistence" }]);
		expect(await count("sentiment_observations WHERE prompt_run_id = $1", [RUN_PERSIST_FAIL])).toBe(0);
		expect(
			await count(
				"sentiment_filtered_claims c JOIN sentiment_analyses s ON s.id = c.analysis_id WHERE s.prompt_run_id = $1",
				[RUN_PERSIST_FAIL],
			),
		).toBe(0);
		expect(await count("usage_events WHERE brand_id = $1 AND event_type = 'sentiment_classification'", [BRAND])).toBe(
			2,
		);
	});
});

describe("V5-RED-014 / V5-RED-015 read selection v5 → v4 → v3", () => {
	beforeAll(async () => {
		// Run 1: v3 only (80)                  → v3
		// Run 2: v4 only (90)                  → v4
		// Run 3: v3 20 + v4 30 + v5 100        → v5, counted once
		// Run 4: v4 40 + v5 failed             → v4 stays
		// Run 5: v3 60 + v5 pending            → v3 stays
		await seedAnalysis(1, "sent-classifier-v3", "completed", 80);
		await seedAnalysis(2, "sent-classifier-v4", "completed", 90);
		await seedAnalysis(3, "sent-classifier-v3", "completed", 20);
		await seedAnalysis(3, "sent-classifier-v4", "completed", 30);
		await seedAnalysis(3, "sent-classifier-v5", "completed", 100);
		await seedAnalysis(4, "sent-classifier-v4", "completed", 40);
		await seedAnalysis(4, "sent-classifier-v5", "failed");
		await seedAnalysis(5, "sent-classifier-v3", "completed", 60);
		await seedAnalysis(5, "sent-classifier-v5", "pending");
	});

	it("declares v5 → v4 → v3", () => {
		expect([...SENTIMENT_READABLE_CLASSIFIER_VERSIONS]).toEqual([
			"sent-classifier-v5",
			"sent-classifier-v4",
			"sent-classifier-v3",
		]);
	});

	it("selects exactly one analysis per run with the newest completed version", async () => {
		const selected = await selectedSentimentAnalyses();
		const byRun = new Map(
			selected
				.filter((s) => s.promptRunId.startsWith("5e970005-0000-4000-8000-0000000003"))
				.map((s) => [s.promptRunId, s.classifierVersion]),
		);
		expect(byRun.get(runId(1))).toBe("sent-classifier-v3");
		expect(byRun.get(runId(2))).toBe("sent-classifier-v4");
		expect(byRun.get(runId(3))).toBe("sent-classifier-v5");
		expect(byRun.get(runId(4))).toBe("sent-classifier-v4");
		expect(byRun.get(runId(5))).toBe("sent-classifier-v3");
		expect(selected.filter((s) => s.promptRunId === runId(3))).toHaveLength(1);
	});

	it("the overview counts each seeded run once and never marks a v4/v3-backed run as failed", async () => {
		const overview = await loadSentimentOverview({
			brandId: BRAND,
			lookback: "1m",
			aspect: "overall",
			timezone: "UTC",
		});
		// 5 seeded runs + the completed caveat run each select exactly one analysis; only the
		// persist-failure run (no completed analysis of any version) counts as failed.
		expect(overview.coverage.analyses).toMatchObject({ completed: 6, failed: 1, pending: 0 });
		const brandRow = overview.entities.find((e) => e.entityType === "brand");
		expect(brandRow?.mentions).toBe(7);
	});
});
