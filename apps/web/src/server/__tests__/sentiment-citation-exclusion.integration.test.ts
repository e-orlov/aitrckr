/**
 * IT-SNT-CIT-001 — citation exclusion and classifier reliability on real
 * Postgres (`pnpm -C apps/web test:integration`, DATABASE_URL at the seeded
 * disposable stack): a detector-v1 citation-only mention is reprojected away
 * (deleted when unreferenced, superseded when an observation still points at
 * it), prose mentions keep their row ids, receipts and inventories name the
 * stale detector version, a second apply writes nothing, an interrupted batch
 * resumes without duplicates, digests are reproducible and independent of
 * citation URLs, a stale classifier-version analysis is kept but never counted,
 * no job is enqueued by the reprojection, the outbound request binds the exact
 * candidate keys, and the three live failure shapes end as attributed terminal
 * failures — with the charged cost, never the estimate — while a canary
 * preflight refusal records nothing.
 */
import { createHash } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { z } from "zod";
import { withResolutionPhases } from "./sentiment-test-provider";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must point at the seeded test stack");

const {
	buildSentimentPrompt,
	candidatesFromMentions,
	dereferenceSchema,
	inspectSentimentCanaryRun,
	loadDetectableEntities,
	loadMentions,
	parseSentimentCanaryContract,
	runMentionBackfill,
	runSentimentCanary,
	runSentimentEnqueue,
	runSentimentJob,
	SENTIMENT_CLASSIFIER_VERSION,
	SENTIMENT_DETECTOR_VERSION,
	SENTIMENT_MODEL,
	SENTIMENT_TAXONOMY_VERSION,
	sentimentInputHash,
} = await import("@workspace/lib/sentiment");
const { StructuredResearchResponseError } = await import("@workspace/lib/providers/types");
const { toStructuredOutputJsonSchema } = await import("@workspace/lib/providers");
const { loadSentimentOverview } = await import("@/server/sentiment-load");
type Provider = import("@workspace/lib/providers/types").Provider;
type StructuredResearchRequestSummary = import("@workspace/lib/providers/types").StructuredResearchRequestSummary;

const ORG = "default";
const BRAND = "sent-cite-brand";
const ALPHA = "5e970007-0000-4000-8000-00000000000a";
const BETA = "5e970007-0000-4000-8000-00000000000b";
const PROMPT = "5e970007-0000-4000-8000-000000000101";
const RUN_REFERENCED = "5e970007-0000-4000-8000-000000000201";
const RUN_UNREFERENCED = "5e970007-0000-4000-8000-000000000202";
const RUN_URL_A = "5e970007-0000-4000-8000-000000000203";
const RUN_URL_B = "5e970007-0000-4000-8000-000000000204";
const RUN_ENUM = "5e970007-0000-4000-8000-000000000205";
const RUN_LIVE_KEY = "5e970007-0000-4000-8000-000000000206";
const RUN_LIVE_BYPASS = "5e970007-0000-4000-8000-000000000207";
const RUN_LIVE_POLARITY = "5e970007-0000-4000-8000-000000000208";
const RUN_CANARY = "5e970007-0000-4000-8000-000000000209";
const RUN_LIVE_BYPASS_POLARITY = "5e970007-0000-4000-8000-00000000020a";
const OLD_DETECTOR = "sent-detector-v1";
const OLD_CLASSIFIER = "sent-classifier-v2";

/** Beta appears only as a citation domain; Alpha in prose. Under detector v1 both were mentions. */
const CITED_ANSWER =
	"Alpha handles claims quickly. ([beta.example.test](https://beta.example.test/claims?utm_source=openai))";
const PROSE_ANSWER = "Alpha handles claims quickly. Beta is slower but cheaper. Citebrand is fine.";

const client = new pg.Client({ connectionString: DATABASE_URL });
const sha = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const payload = (promptRunId: string) => ({
	promptRunId,
	classifierVersion: SENTIMENT_CLASSIFIER_VERSION,
	taxonomyVersion: SENTIMENT_TAXONOMY_VERSION,
});
const count = async (table: string, where = "brand_id = $1", params: unknown[] = [BRAND]) =>
	(await client.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table} WHERE ${where}`, params)).rows[0].n;

const lockedRequest: StructuredResearchRequestSummary = {
	model: SENTIMENT_MODEL,
	webSearch: true,
	maxToolCalls: 1,
	maxOutputTokens: 8000,
	strictJsonSchema: true,
	requireParameters: true,
};

/**
 * A provider double that behaves like the real OpenRouter path: the answer is
 * parsed against the request schema and a mismatch is a typed, paid response
 * error. `answer` receives the candidate keys read from the prompt; `bypass`
 * skips the schema, standing in for a provider that ignored it.
 */
function fakeProvider(
	answer: (keys: string[]) => unknown,
	options: { costUsd?: number; bypass?: boolean; onSchema?: (schema: z.ZodType) => void } = {},
): Provider {
	return {
		id: "fake-openrouter",
		name: "Fake",
		access: "api",
		isConfigured: () => true,
		async runStructuredResearch<T>({ prompt, schema }: { prompt: string; schema: z.ZodType }) {
			options.onSchema?.(schema);
			const keys = [...prompt.matchAll(/^- key "([^"]+)"/gm)].map((m) => m[1]);
			const raw = answer(keys);
			const usage = {
				inputTokens: 7000,
				outputTokens: 900,
				reasoningTokens: 400,
				costUsd: options.costUsd ?? 0.0123,
				webSearchRequests: 1,
				webSearchRequestsConflict: false,
			};
			let object: unknown = raw;
			if (!options.bypass) {
				const parsed = schema.safeParse(raw);
				if (!parsed.success) {
					throw new StructuredResearchResponseError("schema", {
						provider: "openrouter",
						model: SENTIMENT_MODEL,
						generationId: `gen-it-cit-schema-${Math.random().toString(36).slice(2, 10)}`,
						request: lockedRequest,
						usage,
					});
				}
				object = parsed.data;
			}
			return {
				object: object as T,
				modelVersion: SENTIMENT_MODEL,
				generationId: `gen-it-cit-001-${Math.random().toString(36).slice(2, 10)}`,
				request: lockedRequest,
				usage,
			};
		},
	} as unknown as Provider;
}

/** The anchor of each candidate's own sentence in PROSE_ANSWER: s0001 Alpha, s0002 Beta, s0003 the brand. */
const ownAnchor = (key: string) => (key === ALPHA ? "s0001" : key === BETA ? "s0002" : "s0003");

const goodEntity = (key: string, anchorId: string) => ({
	key,
	score: 70,
	category: "positive",
	confidence: 0.9,
	evidence: [{ anchorId, polarity: "positive" }],
	aspects: [],
});

async function insertRun(id: string, answer: string, minutesAgo: number) {
	await client.query(
		`INSERT INTO prompt_runs (id, prompt_id, brand_id, model, provider, version, web_search_enabled, raw_output, brand_mentioned, competitors_mentioned, created_at)
		 VALUES ($1, $2, $3, 'chatgpt', 'openrouter', 'v', true, $4, true, '{}', now() - ($5 || ' minutes')::interval)`,
		[id, PROMPT, BRAND, JSON.stringify({ choices: [{ message: { content: answer } }] }), String(minutesAgo)],
	);
}

/** History as detector v1 / classifier v2 left it: receipt, mention rows (Beta from the citation only) and optionally a completed analysis over them. */
async function insertLegacyProjection(runId: string, withObservations: boolean) {
	await client.query(
		`INSERT INTO sentiment_detections (prompt_run_id, brand_id, detector_version, status, mention_count) VALUES ($1, $2, $3, 'mentions', 2)`,
		[runId, BRAND, OLD_DETECTOR],
	);
	const mentions = await client.query<{ id: string; entity_key: string }>(
		`INSERT INTO prompt_run_entity_mentions (prompt_run_id, brand_id, entity_type, competitor_id, entity_key, entity_name, detector_version, matched_terms)
		 VALUES ($1, $2, 'competitor', $3::uuid, $3::text, 'Alpha', $5, '{alpha}'),
		        ($1, $2, 'competitor', $4::uuid, $4::text, 'Beta', $5, '{beta.example.test}')
		 RETURNING id, entity_key`,
		[runId, BRAND, ALPHA, BETA, OLD_DETECTOR],
	);
	if (!withObservations) return;
	const analysis = await client.query<{ id: string }>(
		`INSERT INTO sentiment_analyses (prompt_run_id, brand_id, classifier_version, taxonomy_version, input_hash, status, provider, model, web_search, attempts, completed_at)
		 VALUES ($1, $2, $3, $4, 'legacy-hash', 'completed', 'openrouter', $5, true, 1, now()) RETURNING id`,
		[runId, BRAND, OLD_CLASSIFIER, SENTIMENT_TAXONOMY_VERSION, SENTIMENT_MODEL],
	);
	for (const row of mentions.rows) {
		await client.query(
			`INSERT INTO sentiment_observations (analysis_id, mention_id, prompt_run_id, brand_id, entity_type, competitor_id, entity_key, score, category, confidence, evidence)
			 VALUES ($1, $2, $3, $4, 'competitor', $5::uuid, $5::text, 50, 'neutral', 0.500, '[]'::jsonb)`,
			[analysis.rows[0].id, row.id, runId, BRAND, row.entity_key],
		);
	}
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
		 VALUES ($1, $2, $1, 'Citebrand', 'https://cite-brand.example.test/', true, true, now(), now())`,
		[BRAND, org.rows[0].id],
	);
	await client.query(
		`INSERT INTO competitors (id, brand_id, name, domains, aliases, active, removed_at, created_at, updated_at)
		 VALUES ($1, $3, 'Alpha', '{alpha.example.test}', '{}', true, NULL, now(), now()),
		        ($2, $3, 'Beta', '{beta.example.test}', '{}', true, NULL, now() + interval '1 second', now())`,
		[ALPHA, BETA, BRAND],
	);
	await client.query(
		`INSERT INTO prompts (id, brand_id, value, enabled, tags, system_tags, created_at, updated_at)
		 VALUES ($1, $2, 'Citation prompt', false, '{}', '{unbranded}', now(), now())`,
		[PROMPT, BRAND],
	);
	await insertRun(RUN_REFERENCED, CITED_ANSWER, 90);
	await insertRun(RUN_UNREFERENCED, CITED_ANSWER, 80);
	await insertRun(
		RUN_URL_A,
		"Alpha is fast. ([alpha.example.test](https://alpha.example.test/a?utm_source=openai))",
		70,
	);
	await insertRun(
		RUN_URL_B,
		"Alpha is fast. ([alpha.example.test](https://alpha.example.test/b?utm_source=other))",
		60,
	);
	await insertRun(RUN_ENUM, PROSE_ANSWER, 50);
	await insertRun(RUN_LIVE_KEY, PROSE_ANSWER, 40);
	await insertRun(RUN_LIVE_BYPASS, PROSE_ANSWER, 30);
	await insertRun(RUN_LIVE_POLARITY, PROSE_ANSWER, 20);
	await insertRun(RUN_LIVE_BYPASS_POLARITY, PROSE_ANSWER, 15);
	await insertRun(RUN_CANARY, PROSE_ANSWER, 10);
	await insertLegacyProjection(RUN_REFERENCED, true);
	await insertLegacyProjection(RUN_UNREFERENCED, false);
});

afterAll(async () => {
	await cleanup();
	await client.end();
});

describe("IT-SNT-CIT-001 mention reprojection under detector v2", () => {
	it("before the reprojection the citation-only Beta rows exist under the old detector and the page counts nothing", async () => {
		expect(await count("prompt_run_entity_mentions", "brand_id = $1 AND entity_key = $2", [BRAND, BETA])).toBe(2);
		const overview = await loadSentimentOverview({
			brandId: BRAND,
			lookback: "1m",
			aspect: "overall",
			timezone: "UTC",
		});
		expect(overview.coverage.responsesDetected).toBe(0);
		expect(overview.entities.find((e) => e.key === BETA)?.mentions ?? 0).toBe(0);
		const inventory = await runSentimentEnqueue({ enqueue: false, brandId: BRAND });
		expect(inventory.counts).toMatchObject({
			scanned: 10,
			notScanned: 10,
			staleDetector: 2,
			staleVersionOnly: 1,
			eligible: 0,
		});
	});

	it("dry run names the stale receipts; apply deletes the unreferenced citation-only row, supersedes the referenced one and keeps Alpha's ids", async () => {
		const before = await client.query<{ id: string; prompt_run_id: string }>(
			"SELECT id, prompt_run_id FROM prompt_run_entity_mentions WHERE brand_id = $1 AND entity_key = $2 ORDER BY prompt_run_id",
			[BRAND, ALPHA],
		);
		const dry = await runMentionBackfill({ apply: false, brandId: BRAND });
		expect(dry.counts).toMatchObject({ scanned: 10, staleDetectorVersion: 2, written: 10, alreadyCurrent: 0 });
		expect(
			await count("sentiment_detections", "brand_id = $1 AND detector_version = $2", [
				BRAND,
				SENTIMENT_DETECTOR_VERSION,
			]),
		).toBe(0);

		const apply = await runMentionBackfill({ apply: true, brandId: BRAND });
		expect(apply.counts).toMatchObject({ written: 10, alreadyCurrent: 0 });

		const beta = await client.query<{ prompt_run_id: string; superseded_at: Date | null; detector_version: string }>(
			"SELECT prompt_run_id, superseded_at, detector_version FROM prompt_run_entity_mentions WHERE brand_id = $1 AND entity_key = $2 AND prompt_run_id IN ($3, $4)",
			[BRAND, BETA, RUN_REFERENCED, RUN_UNREFERENCED],
		);
		// Unreferenced: gone. Referenced by a legacy observation: kept, superseded, invisible.
		expect(beta.rows.map((r) => r.prompt_run_id)).toEqual([RUN_REFERENCED]);
		expect(beta.rows[0].superseded_at).not.toBeNull();
		expect(beta.rows[0].detector_version).toBe(OLD_DETECTOR);
		expect(await loadMentions(RUN_REFERENCED)).toMatchObject([{ key: ALPHA }]);
		expect(await loadMentions(RUN_UNREFERENCED)).toMatchObject([{ key: ALPHA }]);

		const after = await client.query<{ id: string; prompt_run_id: string; detector_version: string }>(
			"SELECT id, prompt_run_id, detector_version FROM prompt_run_entity_mentions WHERE brand_id = $1 AND entity_key = $2 AND prompt_run_id IN ($3, $4) ORDER BY prompt_run_id",
			[BRAND, ALPHA, RUN_REFERENCED, RUN_UNREFERENCED],
		);
		expect(after.rows.map((r) => r.id)).toEqual(before.rows.map((r) => r.id));
		expect(after.rows.every((r) => r.detector_version === SENTIMENT_DETECTOR_VERSION)).toBe(true);
		const receipts = await client.query<{ status: string; mention_count: number }>(
			"SELECT status, mention_count FROM sentiment_detections WHERE prompt_run_id = $1 ORDER BY detector_version",
			[RUN_REFERENCED],
		);
		expect(receipts.rows).toEqual([
			{ status: "mentions", mention_count: 2 },
			{ status: "mentions", mention_count: 1 },
		]);
	});

	it("a second apply changes nothing and the stale analysis is physically kept but never counted", async () => {
		const snapshot = await client.query(
			"SELECT id, detector_version, superseded_at FROM prompt_run_entity_mentions WHERE brand_id = $1 ORDER BY id",
			[BRAND],
		);
		const again = await runMentionBackfill({ apply: true, brandId: BRAND });
		expect(again.counts).toMatchObject({ scanned: 10, written: 0, alreadyCurrent: 10, staleDetectorVersion: 0 });
		const after = await client.query(
			"SELECT id, detector_version, superseded_at FROM prompt_run_entity_mentions WHERE brand_id = $1 ORDER BY id",
			[BRAND],
		);
		expect(after.rows).toEqual(snapshot.rows);

		expect(
			await count("sentiment_analyses", "brand_id = $1 AND classifier_version = $2", [BRAND, OLD_CLASSIFIER]),
		).toBe(1);
		expect(await count("sentiment_observations", "brand_id = $1", [BRAND])).toBe(2);
		const overview = await loadSentimentOverview({
			brandId: BRAND,
			lookback: "1m",
			aspect: "overall",
			timezone: "UTC",
		});
		expect(overview.coverage).toMatchObject({ responsesDetected: 10, responsesWithMentions: 10 });
		expect(overview.coverage.analyses.completed).toBe(0);
		const alpha = overview.entities.find((e) => e.key === ALPHA);
		const beta = overview.entities.find((e) => e.key === BETA);
		expect(alpha?.mentions).toBe(10);
		expect(alpha?.classified).toBe(0);
		expect(beta?.mentions).toBe(6);
		expect(beta?.classified).toBe(0);
	});

	it("the reprojection enqueues nothing; the inventory now counts eligible runs and the stale version only", async () => {
		expect(
			await count("sentiment_analyses", "brand_id = $1 AND classifier_version = $2", [
				BRAND,
				SENTIMENT_CLASSIFIER_VERSION,
			]),
		).toBe(0);
		const inventory = await runSentimentEnqueue({ enqueue: false, brandId: BRAND });
		expect(inventory.counts).toMatchObject({
			scanned: 10,
			eligible: 10,
			notScanned: 0,
			staleDetector: 0,
			staleVersionOnly: 1,
			attempted: 0,
			accepted: 0,
		});
		expect(
			await count("sentiment_analyses", "brand_id = $1 AND classifier_version = $2", [
				BRAND,
				SENTIMENT_CLASSIFIER_VERSION,
			]),
		).toBe(0);
	});

	it("an interrupted batch resumes from its cursor without duplicates", async () => {
		await client.query("DELETE FROM sentiment_detections WHERE brand_id = $1 AND detector_version = $2", [
			BRAND,
			SENTIMENT_DETECTOR_VERSION,
		]);
		const first = await runMentionBackfill({ apply: true, brandId: BRAND, pageSize: 2, maxPages: 2 });
		expect(first.partial).toBe(true);
		expect(first.counts.scanned).toBe(4);
		const { decodeRunCursor } = await import("@workspace/lib/sentiment");
		const rest = await runMentionBackfill({ apply: true, brandId: BRAND, cursor: decodeRunCursor(first.nextCursor) });
		expect(rest.partial).toBe(false);
		expect(first.counts.scanned + rest.counts.scanned).toBe(10);
		expect(first.counts.alreadyCurrent + rest.counts.alreadyCurrent).toBe(0);
		expect(
			await count("sentiment_detections", "brand_id = $1 AND detector_version = $2", [
				BRAND,
				SENTIMENT_DETECTOR_VERSION,
			]),
		).toBe(10);
		const perRun = await client.query<{ n: number }>(
			"SELECT count(*)::int AS n FROM prompt_run_entity_mentions WHERE brand_id = $1 AND superseded_at IS NULL GROUP BY prompt_run_id, entity_key HAVING count(*) > 1",
			[BRAND],
		);
		expect(perRun.rows).toEqual([]);
	});
});

describe("IT-SNT-CIT-001 digests and request contract", () => {
	it("input hash and prompt digest are reproducible and independent of the citation URL", async () => {
		const a = await inspectSentimentCanaryRun(RUN_URL_A);
		const b = await inspectSentimentCanaryRun(RUN_URL_B);
		expect(a?.entities).toEqual([{ key: ALPHA, entityType: "competitor" }]);
		expect(a?.classifierInputHash).toBe(b?.classifierInputHash);
		expect(a?.providerPromptSha256).toBe(b?.providerPromptSha256);
		expect(a?.detectorVersion).toBe(SENTIMENT_DETECTOR_VERSION);
		expect(await inspectSentimentCanaryRun(RUN_URL_A)).toEqual(a);
		const entities = await loadDetectableEntities(BRAND, "historical");
		const candidates = candidatesFromMentions(await loadMentions(RUN_URL_A), entities);
		const body = "Alpha is fast. ([alpha.example.test](https://alpha.example.test/a?utm_source=openai))";
		expect(sentimentInputHash(body, candidates)).toBe(a?.classifierInputHash);
		expect(sha(buildSentimentPrompt({ answerBody: body, candidates }))).toBe(a?.providerPromptSha256);
	});

	it("the request schema sent through the job core binds the exact candidate keys; a conforming answer completes under the current version", async () => {
		let sent: z.ZodType | null = null;
		const outcome = await runSentimentJob(payload(RUN_ENUM), {
			resolveProvider: () =>
				fakeProvider((keys) => ({ entities: keys.map((key) => goodEntity(key, ownAnchor(key))) }), {
					onSchema: (schema) => {
						sent = schema;
					},
				}),
		});
		expect(outcome).toMatchObject({ status: "classified", entities: 3, entityKeys: ["brand", ALPHA, BETA] });
		// The schema as the provider sees it: per-request enums once under `$defs`, expanded here for the assertion.
		const raw = toStructuredOutputJsonSchema(sent as unknown as z.ZodType) as {
			$defs: Record<string, { enum?: string[] }>;
		};
		expect(raw.$defs.entityKey.enum).toEqual(["brand", ALPHA, BETA]);
		const json = dereferenceSchema(raw) as unknown as {
			properties: { entities: { items: { anyOf: { properties: { key: { enum?: string[] } } }[] } } };
		};
		expect(json.properties.entities.items.anyOf).toHaveLength(4);
		for (const branch of json.properties.entities.items.anyOf) {
			expect(branch.properties.key.enum).toEqual(["brand", ALPHA, BETA]);
		}
		const row = await client.query<{ status: string; classifier_version: string; input_hash: string | null }>(
			"SELECT status, classifier_version, input_hash FROM sentiment_analyses WHERE prompt_run_id = $1",
			[RUN_ENUM],
		);
		expect(row.rows).toEqual([
			{ status: "completed", classifier_version: SENTIMENT_CLASSIFIER_VERSION, input_hash: expect.any(String) },
		]);
		expect(await count("sentiment_observations", "prompt_run_id = $1", [RUN_ENUM])).toBe(3);
		const usage = await client.query<{ event_type: string; estimated_cost_usd: string }>(
			"SELECT event_type, estimated_cost_usd FROM usage_events WHERE brand_id = $1 ORDER BY created_at",
			[BRAND],
		);
		expect(usage.rows).toEqual([{ event_type: "sentiment_classification", estimated_cost_usd: "0.012300" }]);
	});
});

describe("IT-SNT-CIT-001 the three live failure shapes through the job core", () => {
	const failedRow = async (runId: string) =>
		(
			await client.query<{ status: string; error_code: string; input_hash: string | null; attempts: number }>(
				"SELECT status, error_code, input_hash, attempts FROM sentiment_analyses WHERE prompt_run_id = $1 AND classifier_version = $2",
				[runId, SENTIMENT_CLASSIFIER_VERSION],
			)
		).rows[0];

	it("a display name instead of the opaque key is refused by the request schema itself: paid, terminal, charged cost attributed", async () => {
		const outcome = await runSentimentJob(payload(RUN_LIVE_KEY), {
			resolveProvider: () =>
				fakeProvider(
					(keys) => ({
						entities: keys.map((key) => goodEntity(key === "brand" ? "Citebrand" : key, ownAnchor(key))),
					}),
					{ costUsd: 0.016477 },
				),
		});
		expect(outcome).toMatchObject({ status: "terminal-validation-failure", code: "schema", requestSent: true });
		expect(await failedRow(RUN_LIVE_KEY)).toMatchObject({
			status: "failed",
			error_code: "schema",
			attempts: 1,
			input_hash: expect.any(String),
		});
		expect(await count("sentiment_observations", "prompt_run_id = $1", [RUN_LIVE_KEY])).toBe(0);
		const usage = await client.query<{ event_type: string; estimated_cost_usd: string }>(
			"SELECT event_type, estimated_cost_usd FROM usage_events WHERE brand_id = $1 AND prompt_id = $2 ORDER BY created_at DESC LIMIT 1",
			[BRAND, PROMPT],
		);
		expect(usage.rows[0]).toEqual({ event_type: "sentiment_classification_failed", estimated_cost_usd: "0.016477" });
		// Terminal for this exact input: a second job makes no call.
		const again = await runSentimentJob(payload(RUN_LIVE_KEY), {
			resolveProvider: () => {
				throw new Error("must not be called");
			},
		});
		expect(again).toMatchObject({ status: "skipped" });
	});

	it("a provider that ignored the schema and still answered with the display name is refused locally as unknown-entity", async () => {
		const outcome = await runSentimentJob(payload(RUN_LIVE_BYPASS), {
			resolveProvider: () =>
				fakeProvider(
					(keys) => ({
						entities: keys.map((key) => goodEntity(key === "brand" ? "Citebrand" : key, ownAnchor(key))),
					}),
					{ bypass: true, costUsd: 0.016744 },
				),
		});
		expect(outcome).toMatchObject({
			status: "terminal-validation-failure",
			code: "unknown-entity",
			diagnostic: expect.objectContaining({ stage: "entity", reason: "unknown-entity" }),
		});
		expect(await failedRow(RUN_LIVE_BYPASS)).toMatchObject({ status: "failed", error_code: "unknown-entity" });
		const usage = await client.query<{ event_type: string; estimated_cost_usd: string }>(
			"SELECT event_type, estimated_cost_usd FROM usage_events WHERE brand_id = $1 ORDER BY created_at DESC LIMIT 1",
			[BRAND],
		);
		expect(usage.rows[0]).toEqual({ event_type: "sentiment_classification_failed", estimated_cost_usd: "0.016744" });
	});

	it("one anchor with two labels inside one non-Mixed overall list is structurally impossible: refused by the request schema, and locally when the provider ignored it", async () => {
		const twoLabels = (keys: string[]) => ({
			entities: keys.map((key) =>
				key === BETA
					? {
							...goodEntity(key, "s0002"),
							evidence: [
								{ anchorId: "s0002", polarity: "positive" },
								{ anchorId: "s0002", polarity: "negative" },
							],
						}
					: goodEntity(key, ownAnchor(key)),
			),
		});
		const outcome = await runSentimentJob(payload(RUN_LIVE_POLARITY), {
			resolveProvider: () => withResolutionPhases(fakeProvider(twoLabels, { costUsd: 0.01758 })),
			resolutionPolicy: { backoffBaseMs: 1, backoffMaxMs: 2 },
		});
		expect(outcome).toMatchObject({ status: "terminal-validation-failure", code: "schema", requestSent: true });
		expect(await failedRow(RUN_LIVE_POLARITY)).toMatchObject({ status: "failed", error_code: "schema" });
		expect(await count("sentiment_observations", "prompt_run_id = $1", [RUN_LIVE_POLARITY])).toBe(0);

		const bypassed = await runSentimentJob(payload(RUN_LIVE_BYPASS_POLARITY), {
			resolveProvider: () => withResolutionPhases(fakeProvider(twoLabels, { bypass: true, costUsd: 0.01758 })),
			resolutionPolicy: { backoffBaseMs: 1, backoffMaxMs: 2 },
		});
		expect(bypassed).toMatchObject({
			status: "terminal-validation-failure",
			code: "schema",
			diagnostic: expect.objectContaining({ stage: "provider-schema", reason: "schema" }),
		});
		expect(await failedRow(RUN_LIVE_BYPASS_POLARITY)).toMatchObject({ status: "failed", error_code: "schema" });
		expect(await count("sentiment_observations", "prompt_run_id = $1", [RUN_LIVE_BYPASS_POLARITY])).toBe(0);
	});
});

describe("IT-SNT-CIT-001 canary preflight refusals spend nothing", () => {
	it("a legacy contract is refused at parse time; a contract naming the old detector is refused before any provider call", async () => {
		const described = await inspectSentimentCanaryRun(RUN_CANARY);
		if (!described?.classifierInputHash || !described.providerPromptSha256 || !described.answerBodySha256)
			throw new Error("inspect incomplete");
		const contract = parseSentimentCanaryContract({
			runId: described.runId,
			promptId: described.promptId,
			brandId: described.brandId,
			answerBodySha256: described.answerBodySha256,
			entities: described.entities,
			classifierInputHash: described.classifierInputHash,
			providerPromptSha256: described.providerPromptSha256,
			classifierVersion: described.classifierVersion,
			taxonomyVersion: described.taxonomyVersion,
			evidenceVersion: described.evidenceVersion,
			detectorVersion: described.detectorVersion,
			provider: described.provider,
			model: described.model,
		});
		const { detectorVersion: _omitted, ...legacy } = contract;
		expect(() => parseSentimentCanaryContract(legacy)).toThrow(expect.objectContaining({ code: "invalid-contract" }));

		const usageBefore = await count("usage_events");
		let calls = 0;
		const report = await runSentimentCanary({
			contract: { ...contract, detectorVersion: OLD_DETECTOR },
			deps: {
				resolveProvider: () => {
					calls += 1;
					return fakeProvider(() => ({ entities: [] }));
				},
			},
			deadlineMs: 1000,
			watchdogMs: 2000,
		});
		expect(report.preflight).toEqual({ status: "refused", reasons: [{ code: "contract-detector-version" }] });
		expect(report.attempts).toBe(0);
		expect(report.providerCalls).toBe(0);
		expect(calls).toBe(0);
		expect(await count("usage_events")).toBe(usageBefore);
		expect(await count("sentiment_analyses", "prompt_run_id = $1", [RUN_CANARY])).toBe(0);
	});
});
