/**
 * Runs against the disposable test database: `pnpm -C apps/web
 * test:integration` with DATABASE_URL pointing at it. Uses the database's real
 * pg-boss schema and the installed `classify-sentiment` exclusive queue.
 *
 * Corrective Slice A2B1: a parked case with durable resumable evidence is
 * guaranteed a future invocation. The immediate singleton-keyed send is an
 * optimization whose `null` proves nothing; the durable guarantee is the
 * maintenance inventory, which rediscovers exactly the safely resumable cases
 * and enqueues them through the same deduplicated send.
 */

import pg from "pg";
import { PgBoss } from "pg-boss";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must point at the seeded test stack");

const {
	SENTIMENT_CLASSIFIER_VERSION,
	SENTIMENT_MODEL,
	SENTIMENT_QUEUE,
	SENTIMENT_TAXONOMY_VERSION,
	enqueueResumableSentimentRuns,
	listResumableSentimentRuns,
	runSentimentJob,
	sendSentimentJob,
	sentimentSingletonKey,
} = await import("@workspace/lib/sentiment");
const { StructuredResearchRequestError } = await import("@workspace/lib/providers/types");
type Provider = import("@workspace/lib/providers/types").Provider;
type JobDeps = import("@workspace/lib/sentiment").SentimentJobDeps;

const ORG = "default";
const BRAND = "sent-v5-wku-brand";
const PROMPT = "5e97000d-0000-4000-8000-000000000101";
const run = (i: number) => `5e97000d-0000-4000-8000-0000000002${String(i).padStart(2, "0")}`;

const BRAND_ANSWER = `Wenn du die **Sent V5 WKU-Rechtsschutzversicherung** meinst: **Ja, sie kann gut sein – besonders beim Leistungsumfang –, aber sie ist nicht automatisch die beste Wahl für jeden.**

**Dafür spricht:**
- Vergleichstests bewerten den Leistungsumfang der Sent V5 WKU positiv.
- Es gibt umfangreiche Leistungen, etwa weltweiten Schutz – je nach Tarif.

**Worauf du achten solltest:**
- Tarife unterscheiden sich stark bei Wartezeit, Selbstbeteiligung und Ausschlüssen.
- Ein Premium-Tarif kann deutlich teurer sein als ein ausreichender Basistarif.

**Kurz gesagt:**
Für Rechtsschutz ist die Sent V5 WKU grundsätzlich ein seriöser und leistungsstarker Anbieter.`;

const client = new pg.Client({ connectionString: DATABASE_URL });
const boss = new PgBoss({ connectionString: DATABASE_URL, supervise: false, schedule: false, migrate: false });
const payload = (promptRunId: string) => ({
	promptRunId,
	classifierVersion: SENTIMENT_CLASSIFIER_VERSION,
	taxonomyVersion: SENTIMENT_TAXONOMY_VERSION,
});
const count = async (sqlText: string, params: unknown[] = []) =>
	(await client.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${sqlText}`, params)).rows[0].n;
const keyOf = (runId: string) => sentimentSingletonKey(runId, SENTIMENT_CLASSIFIER_VERSION);
const jobsFor = async (runId: string) =>
	(
		await client.query<{ id: string; state: string }>(
			"SELECT id, state::text FROM pgboss.job WHERE name = $1 AND singleton_key = $2 ORDER BY created_on",
			[SENTIMENT_QUEUE, keyOf(runId)],
		)
	).rows;
const setJobState = (id: string, state: string) =>
	client.query(`UPDATE pgboss.job SET state = $2::pgboss.job_state, started_on = now() WHERE id = $1`, [id, state]);
const analysisOf = async (runId: string) =>
	(
		await client.query(
			"SELECT id, status, verified_at::text FROM sentiment_analyses WHERE prompt_run_id = $1 AND classifier_version = $2",
			[runId, SENTIMENT_CLASSIFIER_VERSION],
		)
	).rows[0];
const caseOf = async (runId: string) =>
	(
		await client.query(
			`SELECT c.status, c.review_reason, c.automated_provider_calls, c.total_actual_cost_usd::text
			 FROM sentiment_resolution_cases c JOIN sentiment_analyses a ON a.id = c.analysis_id WHERE a.prompt_run_id = $1`,
			[runId],
		)
	).rows[0];
const attemptsOf = async (runId: string) =>
	(
		await client.query(
			"SELECT t.id, t.phase, t.outcome, t.instance_id FROM sentiment_provider_attempts t JOIN sentiment_analyses a ON a.id = t.analysis_id WHERE a.prompt_run_id = $1 ORDER BY t.ordinal",
			[runId],
		)
	).rows;

const cite = (anchorId: string, polarity: "positive" | "negative" | "neutral") => ({ anchorId, polarity });
const positive = (score: number, ...ids: string[]) => ({
	category: "positive" as const,
	score,
	confidence: 0.9,
	evidence: ids.map((i) => cite(i, "positive")),
});
const brandOk = { key: "brand", ...positive(70, "s0001", "s0009"), aspects: [] };
const brandUnbound = { key: "brand", ...positive(70, "s0004", "s0007"), aspects: [] };
const ACCEPT = { verdict: "accept", issues: [] };

type Step = { phase: "classify" | "repair" | "verify"; answer?: unknown; error?: Error; hold?: Promise<void> };
type Script = { steps: Step[]; calls: { phase: string }[] };

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
			if (step.hold) await step.hold;
			if (step.error) throw step.error;
			return {
				object: schema.parse(step.answer),
				modelVersion: SENTIMENT_MODEL,
				generationId: `gen-wku-${Math.random().toString(36).slice(2, 10)}`,
				usage: {
					inputTokens: 5000,
					outputTokens: 800,
					reasoningTokens: 200,
					costUsd: 0.02,
					webSearchRequests: phase === "classify" ? 1 : 0,
					webSearchRequestsConflict: false,
				},
			};
		},
	} as unknown as Provider;
	return { provider, script };
}

const fast: JobDeps["resolutionPolicy"] = { backoffBaseMs: 50, backoffMaxMs: 200 };
const deferred = () => {
	let release!: () => void;
	const hold = new Promise<void>((r) => {
		release = r;
	});
	return { hold, release };
};
const expireLease = (runId: string) =>
	client.query(
		"UPDATE sentiment_analyses SET started_at = now() - interval '16 minutes' WHERE prompt_run_id = $1 AND classifier_version = $2",
		[runId, SENTIMENT_CLASSIFIER_VERSION],
	);
const phases = (script: Script) => script.calls.map((c) => c.phase);
/** Wait (bounded) until A's classification request has left: its ledger row is `sending`. */
async function untilSending(runId: string) {
	for (let i = 0; i < 50; i++) {
		const last = (await attemptsOf(runId)).at(-1);
		if (last?.phase === "classify" && last.outcome === "sending") return;
		await new Promise((r) => setTimeout(r, 100));
	}
	throw new Error(`no sending classify attempt for ${runId} within 5 s`);
}
const verifyOnly = () => scripted([{ phase: "verify", answer: ACCEPT }]);
const resumableRuns = async () => (await listResumableSentimentRuns()).map((r) => r.promptRunId);

async function insertRun(id: string, minutesAgo: number) {
	await client.query(
		`INSERT INTO prompt_runs (id, prompt_id, brand_id, model, provider, version, web_search_enabled, raw_output, brand_mentioned, competitors_mentioned, created_at)
		 VALUES ($1, $2, $3, 'chatgpt', 'openrouter', 'v', true, $4, true, '{}', now() - ($5 || ' minutes')::interval)`,
		[id, PROMPT, BRAND, JSON.stringify({ choices: [{ message: { content: BRAND_ANSWER } }] }), String(minutesAgo)],
	);
}

async function cleanup() {
	await client.query("DELETE FROM pgboss.job WHERE name = $1 AND singleton_key LIKE 'sentiment:5e97000d-%'", [
		SENTIMENT_QUEUE,
	]);
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
	const queue = await client.query<{ policy: string }>("SELECT policy FROM pgboss.queue WHERE name = $1", [
		SENTIMENT_QUEUE,
	]);
	if (queue.rows[0]?.policy !== "exclusive") throw new Error("the installed classify-sentiment queue is not exclusive");
	await boss.start();
	await cleanup();
	await client.query(
		`INSERT INTO brands (id, organization_id, slug, name, website, enabled, onboarded, created_at, updated_at) VALUES ($1, $2, $1, 'Sent V5 WKU', 'https://sent-v5-wku.example.test/', true, true, now(), now())`,
		[BRAND, org.rows[0].id],
	);
	await client.query(
		`INSERT INTO prompts (id, brand_id, value, enabled, tags, system_tags, created_at, updated_at) VALUES ($1, $2, 'WKU prompt', false, '{}', '{unbranded}', now(), now())`,
		[PROMPT, BRAND],
	);
	for (let i = 1; i <= 12; i++) await insertRun(run(i), 100 - i);
});

afterAll(async () => {
	await cleanup();
	await boss.stop({ graceful: false });
	await client.end();
});

/** The A2A race up to B parking the run; A is still blocked at the classifier. */
async function raceUntilParked(runId: string, deps: Partial<JobDeps> = {}) {
	const { hold, release } = deferred();
	const a = scripted([{ phase: "classify", answer: { entities: [brandOk] }, hold }]);
	const attemptA = runSentimentJob(payload(runId), {
		resolveProvider: () => a.provider,
		resolutionPolicy: fast,
		...deps,
	});
	await untilSending(runId);
	await expireLease(runId);
	const b = scripted([{ phase: "classify", answer: { entities: [brandOk] } }]);
	expect(
		await runSentimentJob(payload(runId), { resolveProvider: () => b.provider, resolutionPolicy: fast }),
	).toMatchObject({
		status: "awaiting-reconciliation",
	});
	expect(b.script.calls).toEqual([]);
	return { attemptA, release };
}

describe("A2B1-1 an active exclusive job swallows the immediate send; the inventory still guarantees a successor", () => {
	it("send returns null while the key is active; the case stays discoverable; once the active job is gone the inventory enqueues and the run completes", async () => {
		const sends: (string | null)[] = [];
		const { attemptA, release } = await raceUntilParked(run(1), {
			enqueueResume: async (id) => {
				const jobId = await sendSentimentJob(boss, id);
				sends.push(jobId);
				return jobId;
			},
		});
		// A real job holds the singleton key in the `active` state when A's late answer arrives.
		const occupant = await sendSentimentJob(boss, run(1));
		expect(occupant).not.toBeNull();
		await setJobState(occupant as string, "active");

		release();
		expect(await attemptA).toMatchObject({ status: "claim-lost" });
		expect(sends).toEqual([null]);
		expect((await jobsFor(run(1))).map((j) => j.state)).toEqual(["active"]);
		expect((await attemptsOf(run(1))).map((t) => `${t.phase}:${t.outcome}`)).toEqual(["classify:accepted"]);
		expect(await resumableRuns()).toContain(run(1));

		// The occupant finishes without consuming the evidence (it parked before the answer arrived).
		await setJobState(occupant as string, "completed");
		expect(await enqueueResumableSentimentRuns(boss)).toMatchObject({ discovered: 1, enqueued: 1, deduplicated: 0 });
		expect((await jobsFor(run(1))).map((j) => j.state)).toEqual(["completed", "created"]);

		// The worker runs the successor.
		const worker = verifyOnly();
		expect(
			await runSentimentJob(payload(run(1)), { resolveProvider: () => worker.provider, resolutionPolicy: fast }),
		).toMatchObject({
			status: "classified",
			paidCalls: 2,
		});
		expect(phases(worker.script)).toEqual(["verify"]);
		expect(await caseOf(run(1))).toMatchObject({
			status: "resolved",
			automated_provider_calls: 2,
			total_actual_cost_usd: "0.040000",
		});
		expect((await analysisOf(run(1))).verified_at).not.toBeNull();
		expect(await resumableRuns()).not.toContain(run(1));
	});
});

describe("A2B1-2 process loss between evidence commit and enqueue", () => {
	it("no immediate enqueue happens at all; the inventory later discovers the case, enqueues it once and the run completes", async () => {
		const { attemptA, release } = await raceUntilParked(run(2));
		release();
		expect(await attemptA).toMatchObject({ status: "claim-lost" });
		expect(await jobsFor(run(2))).toEqual([]);
		expect(await caseOf(run(2))).toMatchObject({ status: "awaiting_reconciliation", automated_provider_calls: 0 });
		expect(await resumableRuns()).toContain(run(2));

		expect(await enqueueResumableSentimentRuns(boss)).toMatchObject({ enqueued: 1 });
		expect((await jobsFor(run(2))).map((j) => j.state)).toEqual(["created"]);
		const worker = verifyOnly();
		expect(
			await runSentimentJob(payload(run(2)), { resolveProvider: () => worker.provider, resolutionPolicy: fast }),
		).toMatchObject({
			status: "classified",
			paidCalls: 2,
		});
		expect(phases(worker.script)).toEqual(["verify"]);
	});
});

describe("A2B1-3/4 immediate enqueue and inventory race; a queued successor is never duplicated", () => {
	it("the immediate send creates the job, the inventory's send deduplicates against it, and two workers still make exactly one verifier call", async () => {
		const sends: (string | null)[] = [];
		const { attemptA, release } = await raceUntilParked(run(3), {
			enqueueResume: async (id) => {
				const jobId = await sendSentimentJob(boss, id);
				sends.push(jobId);
				return jobId;
			},
		});
		release();
		expect(await attemptA).toMatchObject({ status: "claim-lost" });
		expect(sends).toHaveLength(1);
		expect(sends[0]).not.toBeNull();
		expect((await jobsFor(run(3))).map((j) => j.state)).toEqual(["created"]);

		expect(await enqueueResumableSentimentRuns(boss)).toMatchObject({ discovered: 1, enqueued: 0, deduplicated: 1 });
		expect((await jobsFor(run(3))).map((j) => j.state)).toEqual(["created"]);

		// Both the immediate and the scheduled invocation reach the run: one resumes, the other is refused at the claim.
		const { hold, release: releaseVerify } = deferred();
		const first = scripted([{ phase: "verify", answer: ACCEPT, hold }]);
		const second = verifyOnly();
		const p1 = runSentimentJob(payload(run(3)), { resolveProvider: () => first.provider, resolutionPolicy: fast });
		await new Promise((r) => setTimeout(r, 300));
		expect(
			await runSentimentJob(payload(run(3)), { resolveProvider: () => second.provider, resolutionPolicy: fast }),
		).toMatchObject({
			status: "claimed-elsewhere",
		});
		releaseVerify();
		expect(await p1).toMatchObject({ status: "classified", paidCalls: 2 });
		expect(phases(first.script)).toEqual(["verify"]);
		expect(second.script.calls).toEqual([]);
		expect(await caseOf(run(3))).toMatchObject({
			status: "resolved",
			automated_provider_calls: 2,
			total_actual_cost_usd: "0.040000",
		});
	});
});

describe("A2B1-5 the inventory selects only safely resumable cases", () => {
	it("awaiting_review, unresolved sending, retry-wait pending_resolution, wrong instance, malformed and candidate-less evidence are not selected", async () => {
		// (a) awaiting_review: the automatic budget exhausted.
		const exhausted = scripted([
			{ phase: "classify", answer: { entities: [brandUnbound] } },
			{ phase: "repair", answer: { entities: [brandUnbound] } },
			{ phase: "repair", answer: { entities: [brandUnbound] } },
			{ phase: "repair", answer: { entities: [brandUnbound] } },
			{ phase: "repair", answer: { entities: [brandUnbound] } },
		]);
		expect(
			await runSentimentJob(payload(run(4)), { resolveProvider: () => exhausted.provider, resolutionPolicy: fast }),
		).toMatchObject({
			status: "awaiting-review",
		});
		// (b) awaiting_reconciliation with the request still unresolved (A never answers).
		const stuck = await raceUntilParked(run(5));
		// (f) pending_resolution in retry_wait after a typed refusal.
		const refused = scripted([
			{
				phase: "classify",
				error: new StructuredResearchRequestError({
					provider: "openrouter",
					httpStatus: 429,
					errorType: "rate_limit_exceeded",
					structured: true,
					carriesOutput: false,
					retryAfterMs: null,
					message: "OpenRouter API error (429): Rate limit exceeded",
				}),
			},
		]);
		await expect(
			runSentimentJob(payload(run(6)), { resolveProvider: () => refused.provider, resolutionPolicy: fast }),
		).rejects.toBeDefined();
		expect(await caseOf(run(6))).toMatchObject({ status: "retry_wait" });
		// (c)(d)(e) settled late answers whose evidence is spoiled afterwards.
		for (const [i, spoil] of [
			[7, "instance_id = '00000000-0000-4000-8000-000000000000'"],
			[8, `candidate = '{"entities":[{"key":"brand","score":700}]}'::jsonb`],
			[9, "candidate = NULL"],
		] as [number, string][]) {
			const { attemptA, release } = await raceUntilParked(run(i));
			release();
			expect(await attemptA).toMatchObject({ status: "claim-lost" });
			const [attempt] = await attemptsOf(run(i));
			await client.query(`UPDATE sentiment_provider_attempts SET ${spoil} WHERE id = $1`, [attempt.id]);
		}

		const selected = await resumableRuns();
		for (const i of [4, 5, 6, 7, 8, 9]) expect(selected).not.toContain(run(i));
		const before = await count("pgboss.job WHERE name = $1 AND singleton_key LIKE 'sentiment:5e97000d-%'", [
			SENTIMENT_QUEUE,
		]);
		await enqueueResumableSentimentRuns(boss);
		expect(
			await count("pgboss.job WHERE name = $1 AND singleton_key LIKE 'sentiment:5e97000d-%'", [SENTIMENT_QUEUE]),
		).toBe(before);
		for (const i of [4, 5, 6, 7, 8, 9]) expect(await jobsFor(run(i))).toEqual([]);

		// Once the stuck request finally answers, the run becomes resumable like any other and is completed here.
		stuck.release();
		expect(await stuck.attemptA).toMatchObject({ status: "claim-lost" });
		expect(await resumableRuns()).toContain(run(5));
		const worker = verifyOnly();
		expect(
			await runSentimentJob(payload(run(5)), { resolveProvider: () => worker.provider, resolutionPolicy: fast }),
		).toMatchObject({
			status: "classified",
			paidCalls: 2,
		});
	});
});

describe("A2B1-6 repeated inventory passes after completion enqueue nothing", () => {
	it("completed runs are never rediscovered", async () => {
		for (const i of [1, 2, 3]) expect((await analysisOf(run(i))).status).toBe("completed");
		const before = await count("pgboss.job WHERE name = $1 AND singleton_key LIKE 'sentiment:5e97000d-%'", [
			SENTIMENT_QUEUE,
		]);
		expect(await enqueueResumableSentimentRuns(boss)).toMatchObject({ enqueued: 0 });
		expect(await enqueueResumableSentimentRuns(boss)).toMatchObject({ enqueued: 0 });
		expect(
			await count("pgboss.job WHERE name = $1 AND singleton_key LIKE 'sentiment:5e97000d-%'", [SENTIMENT_QUEUE]),
		).toBe(before);
	});
});
