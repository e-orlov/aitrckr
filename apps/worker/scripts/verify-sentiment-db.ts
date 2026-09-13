/**
 * SENT-01 real-Postgres verification (CT-SNT-001 / IT-SNT-002), run in CI's
 * Deployment Smoke Tests against the disposable service database after
 * migrations. Proves on a REAL PostgreSQL what mocked adapters cannot:
 *
 *   1. the detection, mention, analysis, observation and aspect tables
 *      reject inconsistent rows (score/category, entity identity, aspect
 *      key, receipt status/count) and enforce one receipt per run+detector
 *      version, one mention per run+entity, one analysis per run+version and
 *      one observation per analysis+entity;
 *   2. concurrent `persistDetection` calls for one run leave exactly one
 *      receipt and one row per entity, `ensureAnalysis` is idempotent under
 *      concurrency, and exactly one of many concurrent `claimAnalysis` calls
 *      wins the row;
 *   3. deleting a prompt run cascades to every sentiment row, while a
 *      competitor with sentiment history cannot be deleted;
 *   4. the classify-sentiment queue's effective policy is `exclusive` and
 *      concurrent `boss.send()` with one singleton key yields exactly one
 *      non-null job id.
 *
 * Deliberately NOT exercised: the worker handler, the classifier, any LLM
 * call. Guard: refuses non-loopback databases unless ALLOW_REMOTE_DB=1.
 * Cleanup removes only the rows/jobs this script created.
 *
 * Usage:
 *   DATABASE_URL=postgres://... pnpm -C apps/worker exec tsx scripts/verify-sentiment-db.ts
 */
import {
	claimAnalysis,
	ensureAnalysis,
	ensureSentimentQueue,
	markAnalysis,
	persistDetection,
	SENTIMENT_CLASSIFIER_VERSION,
	SENTIMENT_DETECTOR_VERSION,
	SENTIMENT_QUEUE,
	SENTIMENT_TAXONOMY_VERSION,
	sentimentSingletonKey,
} from "@workspace/lib/sentiment";
import { Client } from "pg";
import { PgBoss } from "pg-boss";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
	console.error("DATABASE_URL is required");
	process.exit(2);
}
if (!/localhost|127\.0\.0\.1/.test(DATABASE_URL) && process.env.ALLOW_REMOTE_DB !== "1") {
	console.error("Refusing to run against a non-local database (set ALLOW_REMOTE_DB=1 to override)");
	process.exit(2);
}

const CONCURRENCY = 8;
const ORG = "sent01-verify-org";
const BRAND = "sent01-verify-brand";
const PROMPT = "5e970002-0000-4000-8000-000000000001";
const RUN = "5e970002-0000-4000-8000-000000000002";
const COMPETITOR = "5e970002-0000-4000-8000-000000000003";

function assert(condition: boolean, message: string): void {
	if (!condition) {
		console.error(`✗ ${message}`);
		process.exit(1);
	}
	console.log(`✓ ${message}`);
}

async function expectRejected(client: Client, label: string, sql: string, params: unknown[]): Promise<void> {
	try {
		await client.query(sql, params);
	} catch (error) {
		const code = (error as { code?: string }).code;
		// check_violation, unique_violation, foreign_key_violation
		assert(code === "23514" || code === "23505" || code === "23503", `${label} is rejected (${code})`);
		return;
	}
	assert(false, `${label} is rejected`);
}

async function seed(client: Client): Promise<void> {
	await cleanup(client);
	await client.query(
		`INSERT INTO organization (id, name, slug, created_at) VALUES ($1, 'SENT-01 verify', $1, now())
		 ON CONFLICT (id) DO NOTHING`,
		[ORG],
	);
	await client.query(
		`INSERT INTO brands (id, organization_id, name, website, enabled, onboarded, created_at, updated_at)
		 VALUES ($1, $2, 'Verify', 'https://verify.example.test/', true, true, now(), now())`,
		[BRAND, ORG],
	);
	await client.query(
		`INSERT INTO competitors (id, brand_id, name, domains, created_at, updated_at) VALUES ($1, $2, 'Rival', '{rival.example.test}', now(), now())`,
		[COMPETITOR, BRAND],
	);
	await client.query(
		`INSERT INTO prompts (id, brand_id, value, enabled, created_at, updated_at) VALUES ($1, $2, 'verify prompt', true, now(), now())`,
		[PROMPT, BRAND],
	);
	await client.query(
		`INSERT INTO prompt_runs (id, prompt_id, brand_id, model, provider, version, web_search_enabled, raw_output, brand_mentioned, competitors_mentioned, created_at)
		 VALUES ($1, $2, $3, 'chatgpt', 'stub', 'v', true, '{"choices":[{"message":{"content":"Verify and Rival."}}]}', true, '{Rival}', now())`,
		[RUN, PROMPT, BRAND],
	);
}

async function cleanup(client: Client): Promise<void> {
	await client
		.query("DELETE FROM pgboss.job WHERE name = $1 AND singleton_key = $2", [
			SENTIMENT_QUEUE,
			sentimentSingletonKey(RUN, SENTIMENT_CLASSIFIER_VERSION),
		])
		.catch(() => undefined);
	await client.query(
		`DELETE FROM sentiment_aspect_observations WHERE observation_id IN (SELECT id FROM sentiment_observations WHERE brand_id = $1)`,
		[BRAND],
	);
	await client.query("DELETE FROM sentiment_observations WHERE brand_id = $1", [BRAND]);
	await client.query("DELETE FROM sentiment_analyses WHERE brand_id = $1", [BRAND]);
	await client.query("DELETE FROM prompt_run_entity_mentions WHERE brand_id = $1", [BRAND]);
	await client.query("DELETE FROM sentiment_detections WHERE brand_id = $1", [BRAND]);
	await client.query("DELETE FROM usage_events WHERE brand_id = $1", [BRAND]);
	await client.query("DELETE FROM prompt_runs WHERE brand_id = $1", [BRAND]);
	await client.query("DELETE FROM prompts WHERE brand_id = $1", [BRAND]);
	await client.query("DELETE FROM competitors WHERE brand_id = $1", [BRAND]);
	await client.query("DELETE FROM brands WHERE id = $1", [BRAND]);
	await client.query("DELETE FROM organization WHERE id = $1", [ORG]);
}

async function verifyConstraints(client: Client): Promise<void> {
	await expectRejected(
		client,
		"mention with a brand entity carrying a competitor id",
		`INSERT INTO prompt_run_entity_mentions (prompt_run_id, brand_id, entity_type, competitor_id, entity_key, entity_name, detector_version)
		 VALUES ($1, $2, 'brand', $3, 'brand', 'x', 'v')`,
		[RUN, BRAND, COMPETITOR],
	);
	await expectRejected(
		client,
		"mention whose entity_key differs from its competitor id",
		`INSERT INTO prompt_run_entity_mentions (prompt_run_id, brand_id, entity_type, competitor_id, entity_key, entity_name, detector_version)
		 VALUES ($1, $2, 'competitor', $3, 'other-key', 'x', 'v')`,
		[RUN, BRAND, COMPETITOR],
	);
	await expectRejected(
		client,
		"analysis with an unknown status",
		`INSERT INTO sentiment_analyses (prompt_run_id, brand_id, classifier_version, taxonomy_version, status) VALUES ($1, $2, 'v', 't', 'weird')`,
		[RUN, BRAND],
	);
	const { rows: analysisRows } = await client.query<{ id: string }>(
		`INSERT INTO sentiment_analyses (prompt_run_id, brand_id, classifier_version, taxonomy_version, status) VALUES ($1, $2, 'ct-v', 't', 'pending') RETURNING id`,
		[RUN, BRAND],
	);
	await expectRejected(
		client,
		"second analysis for the same run and version",
		`INSERT INTO sentiment_analyses (prompt_run_id, brand_id, classifier_version, taxonomy_version, status) VALUES ($1, $2, 'ct-v', 't', 'pending')`,
		[RUN, BRAND],
	);
	const { rows: mentionRows } = await client.query<{ id: string }>(
		`INSERT INTO prompt_run_entity_mentions (prompt_run_id, brand_id, entity_type, competitor_id, entity_key, entity_name, detector_version)
		 VALUES ($1, $2, 'brand', NULL, 'brand', 'Verify', 'ct-d') RETURNING id`,
		[RUN, BRAND],
	);
	const analysisId = analysisRows[0].id;
	const mentionId = mentionRows[0].id;
	const obs = (score: number, category: string) =>
		`INSERT INTO sentiment_observations (analysis_id, mention_id, prompt_run_id, brand_id, entity_type, competitor_id, entity_key, score, category, confidence, evidence)
		 VALUES ($1, $2, $3, $4, 'brand', NULL, 'brand', ${score}, '${category}', 0.9, '[]'::jsonb)`;
	await expectRejected(client, "positive observation with score 50", obs(50, "positive"), [
		analysisId,
		mentionId,
		RUN,
		BRAND,
	]);
	await expectRejected(client, "negative observation with score 50", obs(50, "negative"), [
		analysisId,
		mentionId,
		RUN,
		BRAND,
	]);
	await expectRejected(client, "mixed observation with score 60", obs(60, "mixed"), [
		analysisId,
		mentionId,
		RUN,
		BRAND,
	]);
	await expectRejected(client, "observation with score 101", obs(101, "positive"), [analysisId, mentionId, RUN, BRAND]);
	await expectRejected(client, "observation with an unknown category", obs(50, "meh"), [
		analysisId,
		mentionId,
		RUN,
		BRAND,
	]);
	const { rows: obsRows } = await client.query<{ id: string }>(`${obs(50, "mixed")} RETURNING id`, [
		analysisId,
		mentionId,
		RUN,
		BRAND,
	]);
	await expectRejected(client, "second observation for the same analysis and entity", obs(70, "positive"), [
		analysisId,
		mentionId,
		RUN,
		BRAND,
	]);
	await expectRejected(
		client,
		"aspect with an unknown key",
		`INSERT INTO sentiment_aspect_observations (observation_id, taxonomy_version, aspect_key, aspect_label, score, category, confidence, evidence)
		 VALUES ($1, 't', 'reputation', 'Reputation', 70, 'positive', 0.9, '[]'::jsonb)`,
		[obsRows[0].id],
	);
	await expectRejected(
		client,
		"aspect with confidence above 1",
		`INSERT INTO sentiment_aspect_observations (observation_id, taxonomy_version, aspect_key, aspect_label, score, category, confidence, evidence)
		 VALUES ($1, 't', 'price', 'Price', 70, 'positive', 1.5, '[]'::jsonb)`,
		[obsRows[0].id],
	);
	await client.query(
		`INSERT INTO sentiment_aspect_observations (observation_id, taxonomy_version, aspect_key, aspect_label, score, category, confidence, evidence)
		 VALUES ($1, 't', 'price', 'Price', 70, 'positive', 0.9, '[]'::jsonb)`,
		[obsRows[0].id],
	);
	await expectRejected(
		client,
		"second aspect row for the same observation, taxonomy and key",
		`INSERT INTO sentiment_aspect_observations (observation_id, taxonomy_version, aspect_key, aspect_label, score, category, confidence, evidence)
		 VALUES ($1, 't', 'price', 'Price', 60, 'positive', 0.9, '[]'::jsonb)`,
		[obsRows[0].id],
	);
	const { rows: rls } = await client.query<{ relname: string; relrowsecurity: boolean }>(
		`SELECT relname, relrowsecurity FROM pg_class WHERE relname IN ('prompt_run_entity_mentions','sentiment_analyses','sentiment_observations','sentiment_aspect_observations')`,
	);
	assert(rls.length === 4 && rls.every((row) => row.relrowsecurity), "RLS is enabled on all four sentiment tables");
	const { rows: idx } = await client.query<{ indexname: string }>(
		`SELECT indexname FROM pg_indexes WHERE indexname IN ('prompt_run_entity_mentions_run_entity_idx','prompt_run_entity_mentions_brand_entity_idx','sentiment_analyses_run_version_idx','sentiment_analyses_brand_status_idx','sentiment_observations_analysis_entity_idx','sentiment_observations_brand_entity_run_idx','sentiment_aspect_observations_observation_aspect_idx')`,
	);
	assert(idx.length === 7, `the seven query-shaped/unique indexes exist (got ${idx.length})`);
	// Reset for the concurrency checks.
	await client.query("DELETE FROM sentiment_aspect_observations WHERE observation_id = $1", [obsRows[0].id]);
	await client.query("DELETE FROM sentiment_observations WHERE analysis_id = $1", [analysisId]);
	await client.query("DELETE FROM sentiment_analyses WHERE id = $1", [analysisId]);
	await client.query("DELETE FROM prompt_run_entity_mentions WHERE id = $1", [mentionId]);
}

async function verifyIdempotentPersistence(client: Client): Promise<void> {
	const mentions = [
		{ key: "brand", entityType: "brand" as const, competitorId: null, entityName: "Verify", matchedTerms: ["verify"] },
		{
			key: COMPETITOR,
			entityType: "competitor" as const,
			competitorId: COMPETITOR,
			entityName: "Rival",
			matchedTerms: ["rival"],
		},
	];
	await Promise.all(
		Array.from({ length: CONCURRENCY }, () =>
			persistDetection({ promptRunId: RUN, brandId: BRAND, result: { status: "mentions", mentions } }),
		),
	);
	const { rows } = await client.query<{ entity_key: string; n: number }>(
		"SELECT entity_key, count(*)::int AS n FROM prompt_run_entity_mentions WHERE prompt_run_id = $1 GROUP BY entity_key ORDER BY entity_key",
		[RUN],
	);
	assert(
		rows.length === 2 && rows.every((row) => row.n === 1),
		`${CONCURRENCY} concurrent persistDetection calls leave one row per entity`,
	);
	const receipts = await client.query<{ status: string; mention_count: number; n: number }>(
		"SELECT status, mention_count, count(*)::int AS n FROM sentiment_detections WHERE prompt_run_id = $1 AND detector_version = $2 GROUP BY 1, 2",
		[RUN, SENTIMENT_DETECTOR_VERSION],
	);
	assert(
		receipts.rows.length === 1 &&
			receipts.rows[0].n === 1 &&
			receipts.rows[0].status === "mentions" &&
			receipts.rows[0].mention_count === 2,
		"they also leave exactly one current-version receipt with the detected count",
	);
	await expectRejected(
		client,
		"a receipt whose status disagrees with its mention count is rejected",
		`INSERT INTO sentiment_detections (prompt_run_id, brand_id, detector_version, status, mention_count) VALUES ($1, $2, 'other-version', 'mentions', 0)`,
		[RUN, BRAND],
	);
	await expectRejected(
		client,
		"a second receipt for the same run and detector version is rejected",
		`INSERT INTO sentiment_detections (prompt_run_id, brand_id, detector_version, status, mention_count) VALUES ($1, $2, $3, 'no_mentions', 0)`,
		[RUN, BRAND, SENTIMENT_DETECTOR_VERSION],
	);
	const analyses = await Promise.all(
		Array.from({ length: CONCURRENCY }, () => ensureAnalysis({ promptRunId: RUN, brandId: BRAND })),
	);
	assert(
		new Set(analyses.map((a) => a.id)).size === 1,
		`${CONCURRENCY} concurrent ensureAnalysis calls yield one analysis row`,
	);
	assert(
		analyses[0].classifierVersion === SENTIMENT_CLASSIFIER_VERSION &&
			analyses[0].taxonomyVersion === SENTIMENT_TAXONOMY_VERSION,
		"the analysis row carries the current classifier and taxonomy versions",
	);
	const claims = await Promise.all(
		Array.from({ length: CONCURRENCY }, () => claimAnalysis(analyses[0].id, { allowFinished: false })),
	);
	const winners = claims.filter((c) => c.claimed);
	assert(
		winners.length === 1 && claims.filter((c) => !c.claimed && c.status === "processing").length === CONCURRENCY - 1,
		`exactly one of ${CONCURRENCY} concurrent claimAnalysis calls wins; the rest see "processing"`,
	);
	const [attempt] = (
		await client.query<{ attempts: number; provider: string; model: string; claim_generation: number }>(
			"SELECT attempts, provider, model, claim_generation FROM sentiment_analyses WHERE id = $1",
			[analyses[0].id],
		)
	).rows;
	assert(
		attempt.attempts === 1 && attempt.provider === "openrouter" && attempt.model === "openai/gpt-5-mini",
		"the winning claim records one attempt attributed to openrouter / openai/gpt-5-mini",
	);
	const winner = winners[0];
	assert(
		winner.claimed && winner.claim.generation === 1 && attempt.claim_generation === 1,
		"the winning claim carries generation 1 and the row records it",
	);
	// Fence: a write with a stale generation is refused, the current one succeeds.
	const stale = { analysisId: analyses[0].id, generation: 0 };
	const current = { analysisId: analyses[0].id, generation: 1 };
	assert(
		(await markAnalysis(stale, { status: "failed", errorCode: "provider", errorMessage: "stale" })) === false,
		"a terminal write with a stale claim generation is refused",
	);
	assert(
		(await markAnalysis(current, { status: "failed", errorCode: "provider", errorMessage: "fenced" })) === true,
		"the same write with the current claim generation succeeds",
	);
	const [afterFence] = (
		await client.query<{ status: string; error_message: string }>(
			"SELECT status, error_message FROM sentiment_analyses WHERE id = $1",
			[analyses[0].id],
		)
	).rows;
	assert(afterFence.status === "failed" && afterFence.error_message === "fenced", "only the fenced write landed");
	// Superseded lifecycle: a mention the next pass no longer finds is superseded when referenced, deleted otherwise.
	await persistDetection({ promptRunId: RUN, brandId: BRAND, result: { status: "mentions", mentions: [mentions[0]] } });
	const [{ n: remaining }] = (
		await client.query<{ n: number }>(
			"SELECT count(*)::int AS n FROM prompt_run_entity_mentions WHERE prompt_run_id = $1 AND superseded_at IS NULL",
			[RUN],
		)
	).rows;
	assert(remaining === 1, "an unreferenced mention the newest pass no longer finds is removed from the projection");
	await persistDetection({ promptRunId: RUN, brandId: BRAND, result: { status: "mentions", mentions } });
}

const mentionsBrandOnly = {
	key: "brand",
	entityType: "brand" as const,
	competitorId: null,
	entityName: "Verify",
	matchedTerms: ["verify"],
};

async function verifyCascade(client: Client): Promise<void> {
	const [analysis] = (
		await client.query<{ id: string }>("SELECT id FROM sentiment_analyses WHERE prompt_run_id = $1", [RUN])
	).rows;
	const [mention] = (
		await client.query<{ id: string }>(
			"SELECT id FROM prompt_run_entity_mentions WHERE prompt_run_id = $1 AND entity_key = $2",
			[RUN, COMPETITOR],
		)
	).rows;
	const [observation] = (
		await client.query<{ id: string }>(
			`INSERT INTO sentiment_observations (analysis_id, mention_id, prompt_run_id, brand_id, entity_type, competitor_id, entity_key, score, category, confidence, evidence)
			 VALUES ($1, $2, $3, $4, 'competitor', $5::uuid, $5::text, 70, 'positive', 0.9, '[]'::jsonb) RETURNING id`,
			[analysis.id, mention.id, RUN, BRAND, COMPETITOR],
		)
	).rows;
	await client.query(
		`INSERT INTO sentiment_aspect_observations (observation_id, taxonomy_version, aspect_key, aspect_label, score, category, confidence, evidence)
		 VALUES ($1, $2, 'price', 'Price', 70, 'positive', 0.9, '[]'::jsonb)`,
		[observation.id, SENTIMENT_TAXONOMY_VERSION],
	);
	await expectRejected(
		client,
		"a competitor with sentiment history cannot be hard-deleted",
		"DELETE FROM competitors WHERE id = $1",
		[COMPETITOR],
	);
	// A referenced mention the newest pass no longer finds is superseded, not deleted, and leaves the projection.
	await persistDetection({
		promptRunId: RUN,
		brandId: BRAND,
		result: { status: "mentions", mentions: [mentionsBrandOnly] },
	});
	const [{ n: superseded }] = (
		await client.query<{ n: number }>(
			"SELECT count(*)::int AS n FROM prompt_run_entity_mentions WHERE id = $1 AND superseded_at IS NOT NULL",
			[mention.id],
		)
	).rows;
	assert(
		superseded === 1,
		"a mention with observations that the newest pass no longer finds is superseded, not deleted",
	);
	await client.query("DELETE FROM prompt_runs WHERE id = $1", [RUN]);
	const leftovers = await client.query<{ n: number }>(
		`SELECT (SELECT count(*) FROM sentiment_detections WHERE prompt_run_id = $1)
		      + (SELECT count(*) FROM prompt_run_entity_mentions WHERE prompt_run_id = $1)
		      + (SELECT count(*) FROM sentiment_analyses WHERE prompt_run_id = $1)
		      + (SELECT count(*) FROM sentiment_observations WHERE prompt_run_id = $1)
		      + (SELECT count(*) FROM sentiment_aspect_observations WHERE observation_id = $2) AS n`,
		[RUN, observation.id],
	);
	assert(
		Number(leftovers.rows[0].n) === 0,
		"deleting the prompt run cascades to receipt, mentions, analysis, observation and aspects",
	);
}

async function verifyQueueDedupe(client: Client, boss: PgBoss): Promise<void> {
	await ensureSentimentQueue(boss);
	const { rows } = await client.query<{ policy: string }>("SELECT policy FROM pgboss.queue WHERE name = $1", [
		SENTIMENT_QUEUE,
	]);
	assert(rows[0]?.policy === "exclusive", `effective queue policy of ${SENTIMENT_QUEUE} is exclusive`);
	const singletonKey = sentimentSingletonKey(RUN, SENTIMENT_CLASSIFIER_VERSION);
	const payload = {
		promptRunId: RUN,
		classifierVersion: SENTIMENT_CLASSIFIER_VERSION,
		taxonomyVersion: SENTIMENT_TAXONOMY_VERSION,
	};
	const ids = await Promise.all(
		Array.from({ length: CONCURRENCY }, () => boss.send(SENTIMENT_QUEUE, payload, { singletonKey })),
	);
	const accepted = ids.filter((id): id is string => id !== null);
	assert(
		accepted.length === 1,
		`exactly one of ${CONCURRENCY} concurrent same-key sends is accepted (got ${accepted.length})`,
	);
	const followUp = await boss.send(SENTIMENT_QUEUE, payload, { singletonKey });
	assert(followUp === null, "a later send with the same key is deduplicated (null id)");
	await boss.deleteJob(SENTIMENT_QUEUE, accepted[0]);
}

async function main(): Promise<void> {
	const client = new Client({ connectionString: DATABASE_URL });
	await client.connect();
	const boss = new PgBoss({ connectionString: DATABASE_URL, schema: "pgboss", supervise: false });
	try {
		await seed(client);
		await verifyConstraints(client);
		await verifyIdempotentPersistence(client);
		await boss.start();
		await verifyQueueDedupe(client, boss);
		await verifyCascade(client);
	} finally {
		await boss.stop({ graceful: false, timeout: 5000 }).catch(() => {});
		await cleanup(client).catch(() => {});
		await client.end();
	}
	console.log("\nSentiment DB verification PASSED (no worker handler, classifier, or LLM involved)");
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
