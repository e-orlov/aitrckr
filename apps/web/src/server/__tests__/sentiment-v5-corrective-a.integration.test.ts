/**
 * Runs against the disposable test database: `pnpm -C apps/web
 * test:integration` with DATABASE_URL pointing at it.
 *
 * Corrective Slice A of the eventual-resolution workflow on real Postgres:
 * parked work is `pending_resolution` (never `failed`) and only the owning
 * resolution instance or adjudication may move it; a resolution instance
 * (run, input hash, classifier version) is immutable once resolved and a
 * changed input opens a new one with its own budget; only a proven
 * non-billable rejection is repeated automatically; the attempt ledger is the
 * source of truth for calls and cost; a paid answer is settled in one
 * transaction and never bought twice; a completed current-version row without
 * `verified_at` is not current.
 */
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must point at the seeded test stack");

const {
	SENTIMENT_CLASSIFIER_VERSION,
	SENTIMENT_DETECTOR_VERSION,
	SENTIMENT_MODEL,
	SENTIMENT_TAXONOMY_VERSION,
	SENTIMENT_VERIFIER_VERSION,
	applyAdjudication,
	adjudicationTemplate,
	candidatesFromMentions,
	chargeResolutionCase,
	claimAnalysis,
	ensureResolutionCase,
	isAnalysisCurrent,
	listUnresolvedCases,
	loadDetectableEntities,
	loadMentions,
	openProviderAttempt,
	recordSentimentUsageEvent,
	runSentimentEnqueue,
	runSentimentJob,
	selectedSentimentAnalyses,
	sentimentInputHash,
	updateResolutionCase,
} = await import("@workspace/lib/sentiment");
const { loadSentimentOverview } = await import("@/server/sentiment-load");
type Provider = import("@workspace/lib/providers/types").Provider;
type JobDeps = import("@workspace/lib/sentiment").SentimentJobDeps;

const ORG = "default";
const BRAND = "sent-v5-csa-brand";
const ALPHA = "5e97000a-0000-4000-8000-00000000000a";
const PROMPT = "5e97000a-0000-4000-8000-000000000101";
const run = (i: number) => `5e97000a-0000-4000-8000-0000000002${String(i).padStart(2, "0")}`;

/** s0001 brand · s0002 label · s0003 brand · s0004 generic · s0005 label · s0006/s0007 generic caveats · s0008 label · s0009 brand. */
const BRAND_ANSWER = `Wenn du die **Sent V5 CSA-Rechtsschutzversicherung** meinst: **Ja, sie kann gut sein – besonders beim Leistungsumfang –, aber sie ist nicht automatisch die beste Wahl für jeden.**

**Dafür spricht:**
- Vergleichstests bewerten den Leistungsumfang der Sent V5 CSA positiv.
- Es gibt umfangreiche Leistungen, etwa weltweiten Schutz – je nach Tarif.

**Worauf du achten solltest:**
- Tarife unterscheiden sich stark bei Wartezeit, Selbstbeteiligung und Ausschlüssen.
- Ein Premium-Tarif kann deutlich teurer sein als ein ausreichender Basistarif.

**Kurz gesagt:**
Für Rechtsschutz ist die Sent V5 CSA grundsätzlich ein seriöser und leistungsstarker Anbieter.`;
/** s0001 names the brand only; s0002 names Alpha only. */
const TWO_ANSWER = "Sent V5 CSA offers a solid service.\n\nAlpha is cheap.";

const client = new pg.Client({ connectionString: DATABASE_URL });
const payload = (promptRunId: string) => ({
	promptRunId,
	classifierVersion: SENTIMENT_CLASSIFIER_VERSION,
	taxonomyVersion: SENTIMENT_TAXONOMY_VERSION,
});
const count = async (sqlText: string, params: unknown[] = []) =>
	(await client.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${sqlText}`, params)).rows[0].n;
const analysisOf = async (runId: string) =>
	(
		await client.query<{
			id: string;
			status: string;
			attempts: number;
			claim_generation: number;
			error_code: string | null;
			input_hash: string | null;
			verifier_version: string | null;
			verified_at: string | null;
		}>(
			"SELECT id, status, attempts, claim_generation, error_code, input_hash, verifier_version, verified_at::text FROM sentiment_analyses WHERE prompt_run_id = $1 AND classifier_version = $2",
			[runId, SENTIMENT_CLASSIFIER_VERSION],
		)
	).rows[0];
const caseOf = async (runId: string) =>
	(
		await client.query<{
			instance_id: string;
			input_hash: string;
			status: string;
			review_reason: string | null;
			automated_provider_calls: number;
			total_actual_cost_usd: string;
			next_attempt_at: string | null;
			created_at: string;
		}>(
			`SELECT c.instance_id, c.input_hash, c.status, c.review_reason, c.automated_provider_calls, c.total_actual_cost_usd::text, c.next_attempt_at::text, c.created_at::text
			 FROM sentiment_resolution_cases c JOIN sentiment_analyses a ON a.id = c.analysis_id WHERE a.prompt_run_id = $1`,
			[runId],
		)
	).rows[0];
const attemptsOf = async (runId: string) =>
	(
		await client.query<{
			ordinal: number;
			phase: string;
			outcome: string;
			generation_id: string | null;
			instance_id: string;
			actual_cost_usd: string | null;
		}>(
			`SELECT t.ordinal, t.phase, t.outcome, t.generation_id, t.instance_id, t.actual_cost_usd::text FROM sentiment_provider_attempts t JOIN sentiment_analyses a ON a.id = t.analysis_id WHERE a.prompt_run_id = $1 ORDER BY t.ordinal`,
			[runId],
		)
	).rows;
const usageEvents = () => count("usage_events WHERE brand_id = $1 AND event_type LIKE 'sentiment%'", [BRAND]);

const cite = (anchorId: string, polarity: "positive" | "negative" | "neutral") => ({ anchorId, polarity });
const positive = (score: number, ...ids: string[]) => ({
	category: "positive",
	score,
	confidence: 0.9,
	evidence: ids.map((i) => cite(i, "positive")),
});
const brandOk = { key: "brand", ...positive(70, "s0001", "s0009"), aspects: [] };
const brandUnbound = { key: "brand", ...positive(70, "s0004", "s0007"), aspects: [] };
const twoOk = {
	entities: [
		{ key: "brand", ...positive(75, "s0001"), aspects: [] },
		{ key: ALPHA, ...positive(75, "s0002"), aspects: [] },
	],
};
const ACCEPT = { verdict: "accept", issues: [] };

type Step = { phase: "classify" | "repair" | "verify"; answer?: unknown; error?: Error; costUsd?: number };
type Script = { steps: Step[]; calls: { phase: string }[] };

/** A provider double that serves a fixed script, asserting each call's phase from the prompt; any deviation throws. */
function scripted(steps: Step[]): { provider: Provider; script: Script } {
	const script: Script = { steps: [...steps], calls: [] };
	const provider = {
		id: "fake-openrouter",
		name: "Fake",
		access: "api",
		isConfigured: () => true,
		async runStructuredResearch<T>({ prompt, schema }: { prompt: string; schema: { parse: (v: unknown) => T } }) {
			const phase = prompt.startsWith("You are an independent verifier")
				? "verify"
				: prompt.startsWith("You are repairing")
					? "repair"
					: "classify";
			script.calls.push({ phase });
			const step = script.steps.shift();
			if (!step) throw new Error(`unscripted ${phase} call`);
			if (step.phase !== phase) throw new Error(`expected ${step.phase}, got ${phase}`);
			if (step.error) throw step.error;
			return {
				object: schema.parse(step.answer),
				modelVersion: SENTIMENT_MODEL,
				generationId: `gen-csa-${script.calls.length}-${Math.random().toString(36).slice(2, 8)}`,
				usage: {
					inputTokens: 5000,
					outputTokens: 800,
					reasoningTokens: 200,
					costUsd: step.costUsd ?? 0.02,
					webSearchRequests: phase === "classify" ? 1 : 0,
					webSearchRequestsConflict: false,
				},
			};
		},
	} as unknown as Provider;
	return { provider, script };
}

const fast: JobDeps["resolutionPolicy"] = { backoffBaseMs: 50, backoffMaxMs: 200 };
const complete = () =>
	scripted([
		{ phase: "classify", answer: { entities: [brandOk] } },
		{ phase: "verify", answer: ACCEPT },
	]);

async function insertRun(id: string, answer: string, minutesAgo: number) {
	await client.query(
		`INSERT INTO prompt_runs (id, prompt_id, brand_id, model, provider, version, web_search_enabled, raw_output, brand_mentioned, competitors_mentioned, created_at)
		 VALUES ($1, $2, $3, 'chatgpt', 'openrouter', 'v', true, $4, true, '{}', now() - ($5 || ' minutes')::interval)`,
		[id, PROMPT, BRAND, JSON.stringify({ choices: [{ message: { content: answer } }] }), String(minutesAgo)],
	);
}

async function currentInputHash(runId: string, answer: string) {
	const entities = await loadDetectableEntities(BRAND, "historical");
	return sentimentInputHash(answer, candidatesFromMentions(await loadMentions(runId), entities));
}

/** A completed analysis row of `version` for the run, as an older deployment (or a direct write) would leave it. */
async function seedCompleted(runId: string, version: string, inputHash: string | null) {
	await client.query(
		`INSERT INTO sentiment_detections (prompt_run_id, brand_id, detector_version, status, mention_count) VALUES ($1, $2, $3, 'mentions', 1) ON CONFLICT DO NOTHING`,
		[runId, BRAND, SENTIMENT_DETECTOR_VERSION],
	);
	const mention = await client.query<{ id: string }>(
		`INSERT INTO prompt_run_entity_mentions (prompt_run_id, brand_id, entity_type, competitor_id, entity_key, entity_name, detector_version, matched_terms)
		 VALUES ($1, $2, 'brand', NULL, 'brand', 'Sent V5 CSA', $3, '{"sent v5 csa"}') ON CONFLICT (prompt_run_id, entity_key) DO UPDATE SET entity_name = EXCLUDED.entity_name RETURNING id`,
		[runId, BRAND, SENTIMENT_DETECTOR_VERSION],
	);
	const analysis = await client.query<{ id: string }>(
		`INSERT INTO sentiment_analyses (prompt_run_id, brand_id, classifier_version, taxonomy_version, status, input_hash, completed_at) VALUES ($1, $2, $3, $4, 'completed', $5, now()) RETURNING id`,
		[runId, BRAND, version, SENTIMENT_TAXONOMY_VERSION, inputHash],
	);
	await client.query(
		`INSERT INTO sentiment_observations (analysis_id, mention_id, prompt_run_id, brand_id, entity_type, competitor_id, entity_key, score, category, confidence, evidence)
		 VALUES ($1, $2, $3, $4, 'brand', NULL, 'brand', 30, 'negative', 0.9, $5::jsonb)`,
		[
			analysis.rows[0].id,
			mention.rows[0].id,
			runId,
			BRAND,
			JSON.stringify([{ quote: "Sent V5 CSA", start: 0, end: 11, polarity: "negative" }]),
		],
	);
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
		`INSERT INTO brands (id, organization_id, slug, name, website, enabled, onboarded, created_at, updated_at) VALUES ($1, $2, $1, 'Sent V5 CSA', 'https://sent-v5-csa.example.test/', true, true, now(), now())`,
		[BRAND, org.rows[0].id],
	);
	await client.query(
		`INSERT INTO competitors (id, brand_id, name, domains, aliases, active, removed_at, created_at, updated_at) VALUES ($1, $2, 'Alpha', '{alpha.example.test}', '{}', true, NULL, now(), now())`,
		[ALPHA, BRAND],
	);
	await client.query(
		`INSERT INTO prompts (id, brand_id, value, enabled, tags, system_tags, created_at, updated_at) VALUES ($1, $2, 'CSA prompt', false, '{}', '{unbranded}', now(), now())`,
		[PROMPT, BRAND],
	);
	for (let i = 1; i <= 14; i++) await insertRun(run(i), i === 2 ? TWO_ANSWER : BRAND_ANSWER, 200 - i);
});

afterAll(async () => {
	await cleanup();
	await client.end();
});

describe("A resolved instance re-entry is immutable", () => {
	it("the same run, input and classifier version returns already-completed without a claim, an attempt row or a budget change", async () => {
		const { provider } = complete();
		expect(
			await runSentimentJob(payload(run(1)), { resolveProvider: () => provider, resolutionPolicy: fast }),
		).toMatchObject({ status: "classified", paidCalls: 2 });
		const before = {
			analysis: await analysisOf(run(1)),
			kase: await caseOf(run(1)),
			attempts: await attemptsOf(run(1)),
		};
		expect(before.kase.status).toBe("resolved");
		// The analysis row is disturbed (an operator reset, a legacy write); the resolved instance still stands.
		await client.query("UPDATE sentiment_analyses SET status = 'pending' WHERE id = $1", [before.analysis.id]);
		const again = complete();
		expect(
			await runSentimentJob(payload(run(1)), { resolveProvider: () => again.provider, resolutionPolicy: fast }),
		).toEqual({ status: "already-completed" });
		expect(again.script.calls).toEqual([]);
		const after = {
			analysis: await analysisOf(run(1)),
			kase: await caseOf(run(1)),
			attempts: await attemptsOf(run(1)),
		};
		expect(after.analysis.claim_generation).toBe(before.analysis.claim_generation);
		expect(after.analysis.attempts).toBe(before.analysis.attempts);
		expect(after.kase).toEqual(before.kase);
		expect(after.attempts).toEqual(before.attempts);
	});
});

describe("B a changed input hash opens a new immutable instance", () => {
	it("fresh budget and fresh initial classification; the old instance's attempt rows are retained; ordinals never collide", async () => {
		const first = scripted([
			{ phase: "classify", answer: twoOk },
			{ phase: "verify", answer: ACCEPT },
		]);
		expect(
			await runSentimentJob(payload(run(2)), { resolveProvider: () => first.provider, resolutionPolicy: fast }),
		).toMatchObject({ status: "classified", paidCalls: 2 });
		const old = { kase: await caseOf(run(2)), attempts: await attemptsOf(run(2)) };
		expect(old.attempts).toHaveLength(2);
		// The competitor gains an alias: the classifier input of every run naming it changes.
		await client.query("UPDATE competitors SET aliases = '{\"Alpha Insurance\"}' WHERE id = $1", [ALPHA]);
		const second = scripted([
			{ phase: "classify", answer: twoOk },
			{ phase: "verify", answer: ACCEPT },
		]);
		expect(
			await runSentimentJob(payload(run(2)), { resolveProvider: () => second.provider, resolutionPolicy: fast }),
		).toMatchObject({ status: "classified", paidCalls: 2 });
		expect(second.script.calls.map((c) => c.phase)).toEqual(["classify", "verify"]);
		const fresh = await caseOf(run(2));
		expect(fresh.instance_id).not.toBe(old.kase.instance_id);
		expect(fresh.input_hash).not.toBe(old.kase.input_hash);
		expect(fresh).toMatchObject({ status: "resolved", automated_provider_calls: 2 });
		expect(Number(fresh.total_actual_cost_usd)).toBeCloseTo(0.04, 6);
		expect(new Date(fresh.created_at).getTime()).toBeGreaterThan(new Date(old.kase.created_at).getTime());
		const attempts = await attemptsOf(run(2));
		expect(attempts).toHaveLength(4);
		expect(attempts.slice(0, 2)).toEqual(old.attempts);
		expect(attempts.map((a) => a.ordinal)).toEqual([1, 2, 3, 4]);
		expect(attempts.slice(2).every((a) => a.instance_id === fresh.instance_id)).toBe(true);
		expect((await analysisOf(run(2))).input_hash).toBe(fresh.input_hash);
	});
});

describe("C parked work is pending_resolution, never failed", () => {
	const scope = { brandId: BRAND, lookback: "1m" as const, timezone: "UTC", aspect: "overall" as const };

	it("awaiting_review and awaiting_reconciliation leave the analysis pending_resolution; coverage counts them as pending", async () => {
		const before = (await loadSentimentOverview(scope)).coverage.analyses;
		const exhausted = scripted([
			{ phase: "classify", answer: { entities: [brandUnbound] } },
			{ phase: "repair", answer: { entities: [brandUnbound] } },
			{ phase: "repair", answer: { entities: [brandUnbound] } },
			{ phase: "repair", answer: { entities: [brandUnbound] } },
			{ phase: "repair", answer: { entities: [brandUnbound] } },
		]);
		expect(
			await runSentimentJob(payload(run(3)), { resolveProvider: () => exhausted.provider, resolutionPolicy: fast }),
		).toMatchObject({ status: "awaiting-review", paidCalls: 5 });
		expect(await analysisOf(run(3))).toMatchObject({ status: "pending_resolution" });
		expect((await caseOf(run(3))).status).toBe("awaiting_review");

		// A crashed worker left a request without an outcome.
		const { provider } = complete();
		const analysis = await analysisOf(run(4));
		expect(analysis).toBeUndefined();
		await client.query(
			`INSERT INTO sentiment_analyses (prompt_run_id, brand_id, classifier_version, taxonomy_version, status) VALUES ($1, $2, $3, $4, 'pending')`,
			[run(4), BRAND, SENTIMENT_CLASSIFIER_VERSION, SENTIMENT_TAXONOMY_VERSION],
		);
		const seeded = await analysisOf(run(4));
		const hash = "0".repeat(64);
		const kase = await ensureResolutionCase(seeded.id, hash);
		await client.query(
			`INSERT INTO sentiment_provider_attempts (analysis_id, instance_id, ordinal, phase, provider, model, input_hash, outcome) VALUES ($1, $2, 1, 'classify', 'openrouter', $3, $4, 'sending')`,
			[seeded.id, kase.instanceId, SENTIMENT_MODEL, hash],
		);
		expect(
			await runSentimentJob(payload(run(4)), { resolveProvider: () => provider, resolutionPolicy: fast }),
		).toMatchObject({ status: "awaiting-reconciliation", attemptOrdinal: 1 });
		expect(await analysisOf(run(4))).toMatchObject({ status: "pending_resolution" });
		expect((await caseOf(run(4))).status).toBe("awaiting_reconciliation");

		const after = (await loadSentimentOverview(scope)).coverage.analyses;
		expect(after.failed).toBe(before.failed);
		expect(after.pending).toBe(before.pending + 2);
		const listed = await listUnresolvedCases();
		expect(
			listed
				.filter((u) => [run(3), run(4)].includes(u.promptRunId))
				.map((u) => u.status)
				.sort(),
		).toEqual(["awaiting_reconciliation", "awaiting_review"]);
	});
});

describe("D pending_resolution is owned by the resolution workflow and adjudication only", () => {
	it("the normal claim refuses it, a job re-entry makes no call and no claim, the backfill inventory neither counts nor enqueues it; adjudication still resolves it", async () => {
		const parked = await analysisOf(run(3));
		expect(parked.status).toBe("pending_resolution");
		expect(await claimAnalysis(parked.id, { allowFinished: true })).toEqual({
			claimed: false,
			status: "pending_resolution",
		});
		const { provider, script } = complete();
		expect(
			await runSentimentJob(payload(run(3)), { resolveProvider: () => provider, resolutionPolicy: fast }),
		).toMatchObject({ status: "awaiting-review" });
		expect(script.calls).toEqual([]);
		const again = await analysisOf(run(3));
		expect(again.claim_generation).toBe(parked.claim_generation);
		expect(again.attempts).toBe(parked.attempts);

		const sent: string[] = [];
		const sender = {
			send: async (_q: string, data: { promptRunId: string }) => {
				sent.push(data.promptRunId);
				return "job";
			},
		};
		const inventory = await runSentimentEnqueue({ enqueue: { limit: 100 }, sender, brandId: BRAND });
		expect(sent).not.toContain(run(3));
		expect(sent).not.toContain(run(4));
		expect(inventory.counts.pendingResolution).toBe(2);

		const template = await adjudicationTemplate(run(3));
		expect(template.status).toBe("awaiting_review");
		const applied = await applyAdjudication({
			analysisId: template.analysisId,
			inputHash: template.inputHash,
			decidedBy: "operator-test",
			entities: [brandOk],
		});
		expect(applied).toMatchObject({ status: "applied" });
		expect(await analysisOf(run(3))).toMatchObject({ status: "completed", verifier_version: "human-adjudication-v1" });
		expect((await caseOf(run(3))).status).toBe("resolved");
	});
});

describe("E unknown provider outcomes are never repeated automatically", () => {
	const cases: { name: string; runIndex: number; error: Error; row: string }[] = [
		{
			name: "timeout",
			runIndex: 5,
			error: new DOMException("request deadline passed", "TimeoutError"),
			row: "aborted",
		},
		{ name: "abort", runIndex: 6, error: new DOMException("aborted", "AbortError"), row: "aborted" },
		{ name: "connection loss", runIndex: 7, error: new TypeError("fetch failed"), row: "sending" },
		{
			name: "ambiguous 502",
			runIndex: 8,
			error: new Error("OpenRouter request failed (502) Bad Gateway"),
			row: "sending",
		},
	];
	for (const c of cases) {
		it(`${c.name} → awaiting_reconciliation, the attempt row stays ${c.row}, zero further calls`, async () => {
			const { provider, script } = scripted([
				{ phase: "classify", error: c.error },
				{ phase: "classify", answer: { entities: [brandOk] } },
				{ phase: "verify", answer: ACCEPT },
			]);
			const outcome = await runSentimentJob(payload(run(c.runIndex)), {
				resolveProvider: () => provider,
				resolutionPolicy: fast,
			});
			expect(outcome).toMatchObject({ status: "awaiting-reconciliation", attemptOrdinal: 1 });
			expect(script.calls).toHaveLength(1);
			expect((await attemptsOf(run(c.runIndex))).map((a) => `${a.phase}:${a.outcome}:${a.generation_id}`)).toEqual([
				`classify:${c.row}:null`,
			]);
			expect(await caseOf(run(c.runIndex))).toMatchObject({
				status: "awaiting_reconciliation",
				review_reason: "unknown-provider-outcome",
				automated_provider_calls: 0,
			});
			expect((await analysisOf(run(c.runIndex))).status).toBe("pending_resolution");
			expect(
				await runSentimentJob(payload(run(c.runIndex)), { resolveProvider: () => provider, resolutionPolicy: fast }),
			).toMatchObject({ status: "awaiting-reconciliation" });
			expect(script.calls).toHaveLength(1);
		});
	}
});

describe("F a proven non-billable rejection is retried with bounded backoff", () => {
	it("a 429 response with no generation is an unpaid provider-error; the run waits as pending_resolution and the next job run completes", async () => {
		const { provider, script } = scripted([
			{ phase: "classify", error: new Error("OpenRouter request failed (429) Too Many Requests") },
			{ phase: "classify", answer: { entities: [brandOk] } },
			{ phase: "verify", answer: ACCEPT },
		]);
		await expect(
			runSentimentJob(payload(run(9)), { resolveProvider: () => provider, resolutionPolicy: fast }),
		).rejects.toMatchObject({ kind: "provider", httpStatus: 429 });
		expect(await caseOf(run(9))).toMatchObject({ status: "retry_wait", automated_provider_calls: 0 });
		expect((await analysisOf(run(9))).status).toBe("pending_resolution");
		expect((await attemptsOf(run(9))).map((a) => `${a.phase}:${a.outcome}`)).toEqual(["classify:provider-error"]);
		expect(
			await runSentimentJob(payload(run(9)), { resolveProvider: () => provider, resolutionPolicy: fast }),
		).toMatchObject({ status: "classified", paidCalls: 2 });
		expect(script.calls.map((c) => c.phase)).toEqual(["classify", "classify", "verify"]);
		expect((await analysisOf(run(9))).status).toBe("completed");
	});
});

describe("G a paid answer is settled in one transaction and never bought twice", () => {
	it("a usage-event failure after the paid verifier answer is retried DB-only: each phase called exactly once, ledger row present, case counters equal the ledger", async () => {
		const { provider, script } = complete();
		let failures = 0;
		const recordUsage: typeof recordSentimentUsageEvent = async (args, executor) => {
			if (!args.succeeded || script.calls.length < 2 || failures > 0) return recordSentimentUsageEvent(args, executor);
			failures += 1;
			throw new Error("usage_events unavailable");
		};
		const before = await usageEvents();
		expect(
			await runSentimentJob(payload(run(10)), { resolveProvider: () => provider, resolutionPolicy: fast, recordUsage }),
		).toMatchObject({ status: "classified", paidCalls: 2 });
		expect(failures).toBe(1);
		expect(script.calls.map((c) => c.phase)).toEqual(["classify", "verify"]);
		const attempts = await attemptsOf(run(10));
		expect(attempts.map((a) => `${a.phase}:${a.outcome}`)).toEqual(["classify:accepted", "verify:accepted"]);
		expect(await usageEvents()).toBe(before + 2);
		const kase = await caseOf(run(10));
		expect(kase.automated_provider_calls).toBe(attempts.filter((a) => a.generation_id !== null).length);
		expect(Number(kase.total_actual_cost_usd)).toBeCloseTo(
			attempts.reduce((sum, a) => sum + Number(a.actual_cost_usd ?? 0), 0),
			6,
		);
	});
});

describe("H a completed current-version row without verified_at is not current", () => {
	it("isAnalysisCurrent is false for the exact input hash; the run is reclassified; the read selector never picks it", async () => {
		await seedCompleted(run(11), "sent-classifier-v4", null);
		const hash = await currentInputHash(run(11), BRAND_ANSWER);
		const unverified = await seedCompleted(run(11), SENTIMENT_CLASSIFIER_VERSION, hash);
		const row = (await client.query("SELECT * FROM sentiment_analyses WHERE id = $1", [unverified])).rows[0];
		expect(row.verified_at).toBeNull();
		expect(
			isAnalysisCurrent(
				{
					...row,
					promptRunId: row.prompt_run_id,
					classifierVersion: row.classifier_version,
					taxonomyVersion: row.taxonomy_version,
					inputHash: row.input_hash,
					verifiedAt: null,
				},
				hash,
			),
		).toBe(false);
		expect((await selectedSentimentAnalyses()).filter((s) => s.promptRunId === run(11))).toMatchObject([
			{ classifierVersion: "sent-classifier-v4" },
		]);
		const { provider, script } = complete();
		expect(
			await runSentimentJob(payload(run(11)), { resolveProvider: () => provider, resolutionPolicy: fast }),
		).toMatchObject({ status: "classified", paidCalls: 2 });
		expect(script.calls.map((c) => c.phase)).toEqual(["classify", "verify"]);
		const verified = await analysisOf(run(11));
		expect(verified).toMatchObject({ status: "completed", verifier_version: SENTIMENT_VERIFIER_VERSION });
		expect(verified.verified_at).not.toBeNull();
		expect((await selectedSentimentAnalyses()).filter((s) => s.promptRunId === run(11))).toMatchObject([
			{ classifierVersion: SENTIMENT_CLASSIFIER_VERSION },
		]);
	});
});

describe("I a stale claimant cannot mutate, park or charge a newer instance", () => {
	it("case writes are fenced on the claim generation and the instance; a foreign instance id is refused even with the live generation", async () => {
		const { provider } = complete();
		expect(
			await runSentimentJob(payload(run(12)), { resolveProvider: () => provider, resolutionPolicy: fast }),
		).toMatchObject({ status: "classified" });
		const analysis = await analysisOf(run(12));
		const kase = await caseOf(run(12));
		const live = { analysisId: analysis.id, generation: analysis.claim_generation, instanceId: kase.instance_id };
		const stale = { ...live, generation: analysis.claim_generation - 1 };
		const foreign = { ...live, instanceId: "00000000-0000-4000-8000-000000000000" };

		await expect(updateResolutionCase(analysis.id, { status: "awaiting_review" }, stale)).rejects.toMatchObject({
			name: "ClaimLostError",
		});
		await expect(updateResolutionCase(analysis.id, { status: "awaiting_review" }, foreign)).rejects.toMatchObject({
			name: "ClaimLostError",
		});
		await expect(chargeResolutionCase(analysis.id, stale)).rejects.toMatchObject({ name: "ClaimLostError" });
		await expect(chargeResolutionCase(analysis.id, foreign)).rejects.toMatchObject({ name: "ClaimLostError" });
		await expect(
			openProviderAttempt({ analysisId: analysis.id, phase: "classify", inputHash: kase.input_hash, claim: stale }),
		).rejects.toMatchObject({ name: "ClaimLostError" });
		await expect(
			openProviderAttempt({ analysisId: analysis.id, phase: "classify", inputHash: kase.input_hash, claim: foreign }),
		).rejects.toMatchObject({ name: "ClaimLostError" });
		// A stale claimant cannot rotate the instance to its own (older) input either.
		await expect(ensureResolutionCase(analysis.id, "f".repeat(64), stale)).rejects.toMatchObject({
			name: "ClaimLostError",
		});
		expect(await caseOf(run(12))).toEqual(kase);
		expect(await attemptsOf(run(12))).toHaveLength(2);
	});
});
