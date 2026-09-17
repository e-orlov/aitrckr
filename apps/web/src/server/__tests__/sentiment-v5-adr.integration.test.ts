/**
 * Runs against the disposable test database: `pnpm -C apps/web
 * test:integration` with DATABASE_URL pointing at it.
 *
 * IT-V5-ADR-001…005 — ADR-SENT-01-GROUNDED-COMPLETION on real Postgres: one
 * or every optional aspect claim dropped still completes the analysis with one
 * paid success and no retry; the same code on the overall is terminal; an
 * unknown or ambiguous defect is terminal; a persistence failure after the
 * audit rows were prepared rolls everything back. Plus the no-version-mixing
 * proof (a zero-aspect v5 analysis never shows an older analysis's aspects;
 * removing the v5 fixture restores the old selection byte-identically) and the
 * audit-table safety invariants enforced by the database.
 */
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withResolutionPhases } from "./sentiment-test-provider";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must point at the seeded test stack");

const {
	SENTIMENT_CLASSIFIER_VERSION,
	SENTIMENT_DETECTOR_VERSION,
	SENTIMENT_MODEL,
	SENTIMENT_TAXONOMY_VERSION,
	persistClassification,
	runSentimentJob,
	selectedSentimentAnalyses,
	sentimentProviderResultSchema,
} = await import("@workspace/lib/sentiment");
const { loadSentimentEvidence, loadSentimentOverview } = await import("@/server/sentiment-load");
type Provider = import("@workspace/lib/providers/types").Provider;
type Classification = import("@workspace/lib/sentiment").SentimentClassification;

const ORG = "default";
const BRAND = "sent-v5-adr-brand";
const ALPHA = "5e970006-0000-4000-8000-00000000000a";
const PROMPT = "5e970006-0000-4000-8000-000000000101";
const RUN_ONE_INVALID = "5e970006-0000-4000-8000-000000000201";
const RUN_ALL_INVALID = "5e970006-0000-4000-8000-000000000202";
const RUN_OVERALL_UNBOUND = "5e970006-0000-4000-8000-000000000203";
const RUN_DUPLICATE_ASPECT = "5e970006-0000-4000-8000-000000000204";
const RUN_UNKNOWN_ANCHOR = "5e970006-0000-4000-8000-000000000205";
const RUN_ROLLBACK = "5e970006-0000-4000-8000-000000000206";
const RUN_MIX = "5e970006-0000-4000-8000-000000000207";
const RUN_FAILED_V5 = "5e970006-0000-4000-8000-000000000208";
const RUN_PENDING_V5 = "5e970006-0000-4000-8000-000000000209";

/** s0001 brand · s0002 generic label · s0003 brand · s0004 generic · s0005 label · s0006/s0007 generic caveats · s0008 label · s0009 brand. */
const BRAND_ANSWER = `Wenn du die **Sent V5 ADR-Rechtsschutzversicherung** meinst: **Ja, sie kann gut sein – besonders beim Leistungsumfang –, aber sie ist nicht automatisch die beste Wahl für jeden.**

**Dafür spricht:**
- Vergleichstests bewerten den Leistungsumfang der Sent V5 ADR positiv.
- Es gibt umfangreiche Leistungen, etwa weltweiten Schutz – je nach Tarif.

**Worauf du achten solltest:**
- Tarife unterscheiden sich stark bei Wartezeit, Selbstbeteiligung und Ausschlüssen.
- Ein Premium-Tarif kann deutlich teurer sein als ein ausreichender Basistarif.

**Kurz gesagt:**
Für Rechtsschutz ist die Sent V5 ADR grundsätzlich ein seriöser und leistungsstarker Anbieter.`;
/** s0001 names the brand only; s0002 names Alpha only. */
const TWO_ANSWER = "Sent V5 ADR offers a solid service.\n\nAlpha is cheap.";

const client = new pg.Client({ connectionString: DATABASE_URL });
const payload = (promptRunId: string) => ({
	promptRunId,
	classifierVersion: SENTIMENT_CLASSIFIER_VERSION,
	taxonomyVersion: SENTIMENT_TAXONOMY_VERSION,
});
const count = async (sqlText: string, params: unknown[] = []) =>
	(await client.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${sqlText}`, params)).rows[0].n;
const rowsOfRun = (table: string) =>
	table === "sentiment_filtered_claims"
		? "sentiment_filtered_claims c JOIN sentiment_analyses s ON s.id = c.analysis_id WHERE s.prompt_run_id = $1"
		: table === "sentiment_aspect_observations"
			? "sentiment_aspect_observations a JOIN sentiment_observations o ON o.id = a.observation_id WHERE o.prompt_run_id = $1"
			: `${table} WHERE prompt_run_id = $1`;
const usageOf = async (type: string) =>
	client.query<{ estimated_cost_usd: string }>(
		"SELECT estimated_cost_usd::text FROM usage_events WHERE brand_id = $1 AND event_type = $2",
		[BRAND, type],
	);

const cite = (anchorId: string, polarity: "positive" | "negative" | "neutral") => ({ anchorId, polarity });
const positive = (score: number, ...ids: string[]) => ({
	category: "positive",
	score,
	confidence: 0.9,
	evidence: ids.map((id) => cite(id, "positive")),
});
const negative = (score: number, ...ids: string[]) => ({
	category: "negative",
	score,
	confidence: 0.8,
	evidence: ids.map((id) => cite(id, "negative")),
});

function provider(answer: unknown, calls: { n: number }, costUsd = 0.02): Provider {
	return {
		id: "fake-openrouter",
		name: "Fake",
		access: "api",
		isConfigured: () => true,
		async runStructuredResearch<T>() {
			calls.n += 1;
			return {
				object: sentimentProviderResultSchema.parse(answer) as T,
				modelVersion: SENTIMENT_MODEL,
				generationId: `gen-adr-${calls.n}-${Math.random().toString(36).slice(2, 10)}`,
				usage: {
					inputTokens: 9000,
					outputTokens: 1200,
					reasoningTokens: 500,
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

/** A completed older-version analysis with an overall and several aspect rows, via the detector's own mention row. */
async function seedOld(runId: string, version: string, status: "completed" | "failed" | "pending", aspects: string[], verified = true) {
	await client.query(
		`INSERT INTO sentiment_detections (prompt_run_id, brand_id, detector_version, status, mention_count) VALUES ($1, $2, $3, 'mentions', 1) ON CONFLICT DO NOTHING`,
		[runId, BRAND, SENTIMENT_DETECTOR_VERSION],
	);
	const mention = await client.query<{ id: string }>(
		`INSERT INTO prompt_run_entity_mentions (prompt_run_id, brand_id, entity_type, competitor_id, entity_key, entity_name, detector_version, matched_terms)
		 VALUES ($1, $2, 'brand', NULL, 'brand', 'Sent V5 ADR', $3, '{"sent v5 adr"}') ON CONFLICT (prompt_run_id, entity_key) DO UPDATE SET entity_name = EXCLUDED.entity_name RETURNING id`,
		[runId, BRAND, SENTIMENT_DETECTOR_VERSION],
	);
	const analysis = await client.query<{ id: string }>(
		`INSERT INTO sentiment_analyses (prompt_run_id, brand_id, classifier_version, taxonomy_version, status, completed_at, verifier_version, verified_at)
		 VALUES ($1, $2, $3, $4, $5, CASE WHEN $5 IN ('completed','failed') THEN now() ELSE NULL END,
		         CASE WHEN $5 = 'completed' AND $3 = 'sent-classifier-v5' AND $6 THEN 'sent-verifier-v1' END,
		         CASE WHEN $5 = 'completed' AND $3 = 'sent-classifier-v5' AND $6 THEN now() END) RETURNING id`,
		[runId, BRAND, version, SENTIMENT_TAXONOMY_VERSION, status, verified],
	);
	if (status !== "completed") return analysis.rows[0].id;
	const observation = await client.query<{ id: string }>(
		`INSERT INTO sentiment_observations (analysis_id, mention_id, prompt_run_id, brand_id, entity_type, competitor_id, entity_key, score, category, confidence, evidence)
		 VALUES ($1, $2, $3, $4, 'brand', NULL, 'brand', 30, 'negative', 0.9, $5::jsonb) RETURNING id`,
		[
			analysis.rows[0].id,
			mention.rows[0].id,
			runId,
			BRAND,
			JSON.stringify([{ quote: "Sent V5 ADR", start: 0, end: 11, polarity: "negative" }]),
		],
	);
	for (const key of aspects) {
		await client.query(
			`INSERT INTO sentiment_aspect_observations (observation_id, taxonomy_version, aspect_key, aspect_label, score, category, confidence, evidence)
			 VALUES ($1, $2, $3, $3, 25, 'negative', 0.8, $4::jsonb)`,
			[
				observation.rows[0].id,
				SENTIMENT_TAXONOMY_VERSION,
				key,
				JSON.stringify([{ quote: "Sent V5 ADR", start: 0, end: 11, polarity: "negative" }]),
			],
		);
	}
	return analysis.rows[0].id;
}

async function cleanup() {
	await client.query("DELETE FROM usage_events WHERE brand_id = $1", [BRAND]);
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
		 VALUES ($1, $2, $1, 'Sent V5 ADR', 'https://sent-v5-adr.example.test/', true, true, now(), now())`,
		[BRAND, org.rows[0].id],
	);
	await client.query(
		`INSERT INTO competitors (id, brand_id, name, domains, aliases, active, removed_at, created_at, updated_at)
		 VALUES ($1, $2, 'Alpha', '{alpha.example.test}', '{}', true, NULL, now(), now())`,
		[ALPHA, BRAND],
	);
	await client.query(
		`INSERT INTO prompts (id, brand_id, value, enabled, tags, system_tags, created_at, updated_at)
		 VALUES ($1, $2, 'ADR prompt', false, '{}', '{unbranded}', now(), now())`,
		[PROMPT, BRAND],
	);
	for (const [id, answer, minutes] of [
		[RUN_ONE_INVALID, BRAND_ANSWER, 90],
		[RUN_ALL_INVALID, BRAND_ANSWER, 80],
		[RUN_OVERALL_UNBOUND, TWO_ANSWER, 70],
		[RUN_DUPLICATE_ASPECT, BRAND_ANSWER, 60],
		[RUN_UNKNOWN_ANCHOR, BRAND_ANSWER, 50],
		[RUN_ROLLBACK, BRAND_ANSWER, 40],
		[RUN_MIX, BRAND_ANSWER, 30],
		[RUN_FAILED_V5, BRAND_ANSWER, 20],
		[RUN_PENDING_V5, BRAND_ANSWER, 10],
	] as const) {
		await insertRun(id, answer, minutes);
	}
});

afterAll(async () => {
	await cleanup();
	await client.end();
});

const brandEntity = (aspects: unknown[]) => ({ key: "brand", ...positive(70, "s0001", "s0009"), aspects });

describe("IT-V5-ADR-001 one locally invalid aspect", () => {
	it("completes with the overall and the valid aspect; the invalid aspect is one audit row; one paid success; no retry", async () => {
		const calls = { n: 0 };
		const answer = {
			entities: [
				brandEntity([
					{ key: "coverage", ...positive(80, "s0003") },
					{ key: "price", ...negative(30, "s0007") },
				]),
			],
		};
		const outcome = await runSentimentJob(payload(RUN_ONE_INVALID), { resolveProvider: () => withResolutionPhases(provider(answer, calls)), resolutionPolicy: { backoffBaseMs: 1, backoffMaxMs: 2 } });
		expect(outcome).toMatchObject({
			status: "classified",
			entities: 1,
			filteredClaimCount: 1,
			filteredClaimCodes: { "aspect-ungrounded": 1 },
		});
		expect(calls.n).toBe(1);
		const analysis = await client.query<{ status: string; attempts: number; error_code: string | null }>(
			"SELECT status, attempts, error_code FROM sentiment_analyses WHERE prompt_run_id = $1",
			[RUN_ONE_INVALID],
		);
		expect(analysis.rows).toEqual([{ status: "completed", attempts: 1, error_code: null }]);
		expect(await count(rowsOfRun("sentiment_observations"), [RUN_ONE_INVALID])).toBe(1);
		const aspects = await client.query<{ aspect_key: string }>(
			`SELECT a.aspect_key FROM ${rowsOfRun("sentiment_aspect_observations")}`,
			[RUN_ONE_INVALID],
		);
		expect(aspects.rows.map((r) => r.aspect_key)).toEqual(["coverage"]);
		const audit = await client.query<Record<string, unknown>>(
			`SELECT c.entity_type, c.entity_key, c.aspect_key, c.validation_code, c.anchor_ids FROM ${rowsOfRun("sentiment_filtered_claims")}`,
			[RUN_ONE_INVALID],
		);
		expect(audit.rows).toEqual([
			{
				entity_type: "brand",
				entity_key: "brand",
				aspect_key: "price",
				validation_code: "aspect-ungrounded",
				anchor_ids: ["s0007"],
			},
		]);
		expect((await usageOf("sentiment_classification")).rows).toEqual([{ estimated_cost_usd: "0.020000" }]);
		expect((await usageOf("sentiment_classification_failed")).rows).toEqual([]);

		// A second job for the same input: no provider call, no new rows.
		expect(await runSentimentJob(payload(RUN_ONE_INVALID), { resolveProvider: () => withResolutionPhases(provider(answer, calls)), resolutionPolicy: { backoffBaseMs: 1, backoffMaxMs: 2 } })).toEqual(
			{
				status: "already-completed",
			},
		);
		expect(calls.n).toBe(1);
		expect(await count("usage_events WHERE brand_id = $1", [BRAND])).toBe(1);
	});
});

describe("IT-V5-ADR-002 every optional aspect dropped", () => {
	it("completes with the overall, zero aspect rows, four audit rows, one paid success; the read loaders treat it as complete", async () => {
		const calls = { n: 0 };
		const answer = {
			entities: [
				brandEntity([
					{ key: "other", ...positive(70, "s0002") },
					{ key: "service", ...positive(70, "s0004") },
					{ key: "coverage", ...positive(80, "s0006") },
					{ key: "price", ...negative(30, "s0007") },
				]),
			],
		};
		const outcome = await runSentimentJob(payload(RUN_ALL_INVALID), { resolveProvider: () => withResolutionPhases(provider(answer, calls)), resolutionPolicy: { backoffBaseMs: 1, backoffMaxMs: 2 } });
		expect(outcome).toMatchObject({
			status: "classified",
			filteredClaimCount: 4,
			filteredClaimCodes: { "aspect-ungrounded": 4 },
		});
		expect(calls.n).toBe(1);
		expect(
			(
				await client.query("SELECT status, attempts FROM sentiment_analyses WHERE prompt_run_id = $1", [
					RUN_ALL_INVALID,
				])
			).rows,
		).toEqual([{ status: "completed", attempts: 1 }]);
		expect(await count(rowsOfRun("sentiment_observations"), [RUN_ALL_INVALID])).toBe(1);
		expect(await count(rowsOfRun("sentiment_aspect_observations"), [RUN_ALL_INVALID])).toBe(0);
		// Canonical read order: entity order, then the taxonomy's aspect order — independent of the provider's order.
		const audit = await client.query<{ aspect_key: string }>(
			`SELECT c.aspect_key FROM ${rowsOfRun("sentiment_filtered_claims")} ORDER BY c.entity_key, array_position(ARRAY['price','coverage','service','other'], c.aspect_key)`,
			[RUN_ALL_INVALID],
		);
		expect(audit.rows.map((r) => r.aspect_key)).toEqual(["price", "coverage", "service", "other"]);
		expect((await usageOf("sentiment_classification")).rows).toHaveLength(2);
		expect((await usageOf("sentiment_classification_failed")).rows).toEqual([]);

		const overview = await loadSentimentOverview({
			brandId: BRAND,
			lookback: "1m",
			aspect: "overall",
			timezone: "UTC",
		});
		expect(overview.coverage.analyses.completed).toBeGreaterThanOrEqual(2);
		expect(overview.coverage.analyses.failed).toBe(0);
		const brandRow = overview.entities.find((e) => e.entityType === "brand");
		expect(brandRow?.classified).toBeGreaterThanOrEqual(2);
		const evidence = await loadSentimentEvidence({
			brandId: BRAND,
			lookback: "1m",
			aspect: "overall",
			timezone: "UTC",
			entityKey: "brand",
			limit: 50,
		});
		const item = [...evidence.highest, ...evidence.lowest].find((i) => i.promptRunId === RUN_ALL_INVALID);
		expect(item).toMatchObject({ score: 70, category: "positive", aspects: [] });
	});
});

describe("IT-V5-ADR-003 the same code on the overall is terminal", () => {
	it("evidence-entity-unbound on the brand's overall: failed, no observation, aspect or audit row; no salvage", async () => {
		const calls = { n: 0 };
		const answer = {
			entities: [
				{ key: "brand", ...positive(75, "s0002"), aspects: [{ key: "service", ...positive(70, "s0001") }] },
				{ key: ALPHA, ...positive(75, "s0002"), aspects: [] },
			],
		};
		const outcome = await runSentimentJob(payload(RUN_OVERALL_UNBOUND), {
			resolveProvider: () => withResolutionPhases(provider(answer, calls)), resolutionPolicy: { backoffBaseMs: 1, backoffMaxMs: 2 },
		});
		expect(outcome).toMatchObject({
			status: "terminal-validation-failure",
			code: "evidence-entity-unbound",
			requestSent: true,
		});
		expect(calls.n).toBe(1);
		expect(
			(
				await client.query("SELECT status, error_code, attempts FROM sentiment_analyses WHERE prompt_run_id = $1", [
					RUN_OVERALL_UNBOUND,
				])
			).rows,
		).toEqual([{ status: "failed", error_code: "evidence-entity-unbound", attempts: 1 }]);
		for (const table of ["sentiment_observations", "sentiment_aspect_observations", "sentiment_filtered_claims"]) {
			expect(await count(rowsOfRun(table), [RUN_OVERALL_UNBOUND]), table).toBe(0);
		}
		expect((await usageOf("sentiment_classification_failed")).rows).toEqual([{ estimated_cost_usd: "0.020000" }]);
	});
});

describe("IT-V5-ADR-004 unknown or ambiguous aspect defects are terminal", () => {
	it.each([
		[
			"duplicate aspect",
			RUN_DUPLICATE_ASPECT,
			[
				{ key: "coverage", ...positive(80, "s0003") },
				{ key: "coverage", ...positive(70, "s0009") },
			],
			"duplicate-aspect",
		],
		[
			"unknown anchor on an aspect",
			RUN_UNKNOWN_ANCHOR,
			[{ key: "coverage", ...positive(80, "s0042") }],
			"evidence-unknown-anchor",
		],
	])("%s → failed with no observation, aspect or audit row", async (_label, runId, aspects, code) => {
		const calls = { n: 0 };
		const outcome = await runSentimentJob(payload(runId), {
			resolveProvider: () => withResolutionPhases(provider({ entities: [brandEntity(aspects)] }, calls)),
			resolutionPolicy: { backoffBaseMs: 1, backoffMaxMs: 2 },
		});
		expect(outcome).toMatchObject({ status: "terminal-validation-failure", code });
		expect(
			(await client.query("SELECT status, error_code FROM sentiment_analyses WHERE prompt_run_id = $1", [runId])).rows,
		).toEqual([{ status: "failed", error_code: code }]);
		for (const table of ["sentiment_observations", "sentiment_aspect_observations", "sentiment_filtered_claims"]) {
			expect(await count(rowsOfRun(table), [runId]), table).toBe(0);
		}
	});
});

describe("IT-V5-ADR-005 persistence failure after the audit rows were prepared", () => {
	it("rolls observations, aspects and audit back together; the analysis is failed/persistence; the paid call stays attributed once", async () => {
		const calls = { n: 0 };
		const answer = { entities: [brandEntity([{ key: "price", ...negative(30, "s0007") }])] };
		// The audit insert is the last write of the transaction: a code outside the
		// database CHECK makes exactly that write fail after the observation went in.
		const persist: typeof persistClassification = (args) =>
			persistClassification({
				...args,
				classification: {
					...args.classification,
					filteredClaims: args.classification.filteredClaims.map((c) => ({ ...c, code: "not-a-code" as never })),
				} as Classification,
			});
		const failedBefore = (await usageOf("sentiment_classification_failed")).rows.length;
		const successBefore = (await usageOf("sentiment_classification")).rows.length;
		await expect(
			runSentimentJob(payload(RUN_ROLLBACK), { resolveProvider: () => withResolutionPhases(provider(answer, calls)), resolutionPolicy: { backoffBaseMs: 1, backoffMaxMs: 2 }, persist }),
		).rejects.toMatchObject({
			kind: "store",
			code: "persistence",
		});
		expect(
			(await client.query("SELECT status, error_code FROM sentiment_analyses WHERE prompt_run_id = $1", [RUN_ROLLBACK]))
				.rows,
		).toEqual([{ status: "failed", error_code: "persistence" }]);
		for (const table of ["sentiment_observations", "sentiment_aspect_observations", "sentiment_filtered_claims"]) {
			expect(await count(rowsOfRun(table), [RUN_ROLLBACK]), table).toBe(0);
		}
		expect((await usageOf("sentiment_classification")).rows.length).toBe(successBefore + 1);
		expect((await usageOf("sentiment_classification_failed")).rows.length).toBe(failedBefore);
	});
});

describe("no version mixing inside a selected analysis", () => {
	const scope = { brandId: BRAND, lookback: "1m" as const, timezone: "UTC" };
	const snapshot = async () => {
		const overall = await loadSentimentOverview({ ...scope, aspect: "overall" });
		const price = await loadSentimentOverview({ ...scope, aspect: "price" });
		const evidence = await loadSentimentEvidence({ ...scope, aspect: "overall", entityKey: "brand", limit: 50 });
		const selected = (await selectedSentimentAnalyses()).filter((s) => s.promptRunId === RUN_MIX);
		return JSON.stringify({
			entities: overall.entities,
			coverage: overall.coverage,
			availableAspects: overall.availableAspects,
			price: price.entities,
			mix: [...evidence.highest, ...evidence.lowest].find((i) => i.promptRunId === RUN_MIX) ?? null,
			selected,
		});
	};
	let before = "";

	it("a zero-aspect completed v5 replaces a v3 analysis with three aspects; none of the v3 aspects surfaces", async () => {
		await seedOld(RUN_MIX, "sent-classifier-v3", "completed", ["price", "coverage", "service"]);
		before = await snapshot();
		expect(JSON.parse(before).selected).toMatchObject([{ classifierVersion: "sent-classifier-v3" }]);
		expect(JSON.parse(before).mix.aspects).toHaveLength(3);

		const calls = { n: 0 };
		const outcome = await runSentimentJob(payload(RUN_MIX), {
			resolveProvider: () => withResolutionPhases(provider({ entities: [brandEntity([{ key: "price", ...negative(30, "s0007") }])] }, calls)),
			resolutionPolicy: { backoffBaseMs: 1, backoffMaxMs: 2 },
		});
		expect(outcome).toMatchObject({ status: "classified", filteredClaimCount: 1 });

		const selected = (await selectedSentimentAnalyses()).filter((s) => s.promptRunId === RUN_MIX);
		expect(selected).toMatchObject([{ classifierVersion: "sent-classifier-v5" }]);
		const evidence = await loadSentimentEvidence({ ...scope, aspect: "overall", entityKey: "brand", limit: 50 });
		const item = [...evidence.highest, ...evidence.lowest].find((i) => i.promptRunId === RUN_MIX);
		expect(item).toMatchObject({ score: 70, category: "positive", aspects: [] });
		const price = await loadSentimentOverview({ ...scope, aspect: "price" });
		const priceEvidence = await loadSentimentEvidence({ ...scope, aspect: "price", entityKey: "brand", limit: 50 });
		expect([...priceEvidence.highest, ...priceEvidence.lowest].some((i) => i.promptRunId === RUN_MIX)).toBe(false);
		expect(price.entities.find((e) => e.entityType === "brand")?.sample ?? 0).toBe(0);
		// The v3 rows still exist untouched; they are simply not selected.
		expect(
			await count(
				"sentiment_aspect_observations a JOIN sentiment_observations o ON o.id = a.observation_id JOIN sentiment_analyses s ON s.id = o.analysis_id WHERE s.prompt_run_id = $1 AND s.classifier_version = 'sent-classifier-v3'",
				[RUN_MIX],
			),
		).toBe(3);
	});

	it("removing only the v5 fixture restores the v3 selection byte-identically", async () => {
		await client.query("DELETE FROM sentiment_analyses WHERE prompt_run_id = $1 AND classifier_version = $2", [
			RUN_MIX,
			"sent-classifier-v5",
		]);
		expect(await count(rowsOfRun("sentiment_filtered_claims"), [RUN_MIX])).toBe(0);
		expect(await snapshot()).toBe(before);
	});

	it("a failed or pending v5 leaves the completed v4/v3 analysis selected in full, once", async () => {
		await seedOld(RUN_FAILED_V5, "sent-classifier-v4", "completed", ["price", "coverage"]);
		await seedOld(RUN_FAILED_V5, "sent-classifier-v5", "failed", []);
		await seedOld(RUN_PENDING_V5, "sent-classifier-v3", "completed", ["service"]);
		await seedOld(RUN_PENDING_V5, "sent-classifier-v5", "pending", []);
		const selected = await selectedSentimentAnalyses();
		expect(selected.filter((s) => s.promptRunId === RUN_FAILED_V5)).toMatchObject([
			{ classifierVersion: "sent-classifier-v4" },
		]);
		expect(selected.filter((s) => s.promptRunId === RUN_PENDING_V5)).toMatchObject([
			{ classifierVersion: "sent-classifier-v3" },
		]);
		const evidence = await loadSentimentEvidence({ ...scope, aspect: "overall", entityKey: "brand", limit: 50 });
		const items = [...evidence.highest, ...evidence.lowest];
		expect(items.filter((i) => i.promptRunId === RUN_FAILED_V5)).toHaveLength(1);
		expect(
			items
				.find((i) => i.promptRunId === RUN_FAILED_V5)
				?.aspects.map((a) => a.key)
				.sort(),
		).toEqual(["coverage", "price"]);
		expect(items.filter((i) => i.promptRunId === RUN_PENDING_V5)).toHaveLength(1);
		const overview = await loadSentimentOverview({ ...scope, aspect: "overall" });
		const brandRow = overview.entities.find((e) => e.entityType === "brand");
		// Mentions: every seeded run once; classified: the completed ones once each — never a double count.
		expect(brandRow?.mentions).toBe(9);
		expect(brandRow?.classified).toBe(brandRow?.sample);
		expect(overview.coverage.analyses.pending).toBe(0);
	});
});

describe("audit table safety (database-enforced)", () => {
	let analysisId = "";
	beforeAll(async () => {
		const { rows } = await client.query<{ id: string }>(
			"SELECT id FROM sentiment_analyses WHERE prompt_run_id = $1 AND classifier_version = $2",
			[RUN_ALL_INVALID, SENTIMENT_CLASSIFIER_VERSION],
		);
		analysisId = rows[0].id;
	});

	it("at most one row per (analysis, entity, aspect), whatever the code", async () => {
		await expect(
			client.query(
				`INSERT INTO sentiment_filtered_claims (analysis_id, entity_type, entity_key, aspect_key, validation_code, classifier_version, anchor_ids)
				 VALUES ($1, 'brand', 'brand', 'price', 'evidence-entity-unbound', $2, '["s0001"]'::jsonb)`,
				[analysisId, SENTIMENT_CLASSIFIER_VERSION],
			),
		).rejects.toMatchObject({ constraint: "sentiment_filtered_claims_analysis_aspect_idx" });
	});

	it("only taxonomy aspect keys, entity types and the five allow-listed codes are storable", async () => {
		const attempt = (aspect: string, code: string, entityType = "brand") =>
			client.query(
				`INSERT INTO sentiment_filtered_claims (analysis_id, entity_type, entity_key, aspect_key, validation_code, classifier_version, anchor_ids)
				 VALUES ($1, $2, 'brand', $3, $4, $5, '[]'::jsonb)`,
				[analysisId, entityType, aspect, code, SENTIMENT_CLASSIFIER_VERSION],
			);
		await expect(attempt("quality", "aspect-ungrounded")).rejects.toMatchObject({
			constraint: "sentiment_filtered_claims_aspect_key_check",
		});
		await expect(attempt("price", "schema")).rejects.toMatchObject({
			constraint: "sentiment_filtered_claims_validation_code_check",
		});
		await expect(attempt("price", "aspect-ungrounded", "person")).rejects.toMatchObject({
			constraint: "sentiment_filtered_claims_entity_type_check",
		});
		expect(await count("sentiment_filtered_claims WHERE analysis_id = $1", [analysisId])).toBe(4);
	});

	it("no audit row without its analysis; deleting the analysis removes its rows", async () => {
		await expect(
			client.query(
				`INSERT INTO sentiment_filtered_claims (analysis_id, entity_type, entity_key, aspect_key, validation_code, classifier_version, anchor_ids)
				 VALUES ('5e970006-0000-4000-8000-0000000000ff', 'brand', 'brand', 'price', 'aspect-ungrounded', $1, '[]'::jsonb)`,
				[SENTIMENT_CLASSIFIER_VERSION],
			),
		).rejects.toMatchObject({ constraint: "sentiment_filtered_claims_analysis_id_sentiment_analyses_id_fk" });
		await client.query("BEGIN");
		await client.query("DELETE FROM sentiment_analyses WHERE id = $1", [analysisId]);
		expect(await count("sentiment_filtered_claims WHERE analysis_id = $1", [analysisId])).toBe(0);
		await client.query("ROLLBACK");
		expect(await count("sentiment_filtered_claims WHERE analysis_id = $1", [analysisId])).toBe(4);
	});

	it("the table holds identifiers, codes and anchor ids only, and audit rows exist for completed analyses only", async () => {
		const columns = await client.query<{ column_name: string; data_type: string }>(
			"SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'sentiment_filtered_claims' ORDER BY ordinal_position",
		);
		expect(columns.rows).toEqual([
			{ column_name: "id", data_type: "uuid" },
			{ column_name: "analysis_id", data_type: "uuid" },
			{ column_name: "entity_type", data_type: "text" },
			{ column_name: "entity_key", data_type: "text" },
			{ column_name: "aspect_key", data_type: "text" },
			{ column_name: "validation_code", data_type: "text" },
			{ column_name: "classifier_version", data_type: "text" },
			{ column_name: "anchor_ids", data_type: "jsonb" },
			{ column_name: "created_at", data_type: "timestamp with time zone" },
		]);
		const anchors = await client.query<{ ok: boolean }>(
			`SELECT bool_and(jsonb_typeof(anchor_ids) = 'array' AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements_text(anchor_ids) e WHERE e !~ '^s[0-9]{4}$')) AS ok
			 FROM sentiment_filtered_claims c JOIN sentiment_analyses s ON s.id = c.analysis_id WHERE s.brand_id = $1`,
			[BRAND],
		);
		expect(anchors.rows[0].ok).toBe(true);
		expect(
			await count(
				"sentiment_filtered_claims c JOIN sentiment_analyses s ON s.id = c.analysis_id WHERE s.brand_id = $1 AND s.status <> 'completed'",
				[BRAND],
			),
		).toBe(0);
	});
});
