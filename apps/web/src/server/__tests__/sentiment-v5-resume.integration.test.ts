/**
 * Runs against the disposable test database: `pnpm -C apps/web
 * test:integration` with DATABASE_URL pointing at it.
 *
 * Corrective Slice A2B on real Postgres: a case parked for an unknown
 * provider outcome resumes automatically once its own instance holds durable
 * evidence that the unknown call produced a valid candidate. The resumed
 * worker acquires a new claim, catches the case budget up from the attempt
 * ledger, reuses the stored candidate and continues with the verifier only.
 * Anything short of exact evidence keeps the case parked without a call.
 */
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must point at the seeded test stack");

const { SENTIMENT_CLASSIFIER_VERSION, SENTIMENT_MODEL, SENTIMENT_TAXONOMY_VERSION, runSentimentJob } = await import(
	"@workspace/lib/sentiment"
);
type Provider = import("@workspace/lib/providers/types").Provider;
type JobDeps = import("@workspace/lib/sentiment").SentimentJobDeps;

const ORG = "default";
const BRAND = "sent-v5-rsm-brand";
const PROMPT = "5e97000c-0000-4000-8000-000000000101";
const run = (i: number) => `5e97000c-0000-4000-8000-0000000002${String(i).padStart(2, "0")}`;

/** s0001 brand · s0003 brand · s0004/s0007 generic · s0009 brand. */
const BRAND_ANSWER = `Wenn du die **Sent V5 RSM-Rechtsschutzversicherung** meinst: **Ja, sie kann gut sein – besonders beim Leistungsumfang –, aber sie ist nicht automatisch die beste Wahl für jeden.**

**Dafür spricht:**
- Vergleichstests bewerten den Leistungsumfang der Sent V5 RSM positiv.
- Es gibt umfangreiche Leistungen, etwa weltweiten Schutz – je nach Tarif.

**Worauf du achten solltest:**
- Tarife unterscheiden sich stark bei Wartezeit, Selbstbeteiligung und Ausschlüssen.
- Ein Premium-Tarif kann deutlich teurer sein als ein ausreichender Basistarif.

**Kurz gesagt:**
Für Rechtsschutz ist die Sent V5 RSM grundsätzlich ein seriöser und leistungsstarker Anbieter.`;

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
		await client.query(
			"SELECT id, status, claim_generation, error_code, verifier_version, verified_at::text FROM sentiment_analyses WHERE prompt_run_id = $1 AND classifier_version = $2",
			[runId, SENTIMENT_CLASSIFIER_VERSION],
		)
	).rows[0];
const caseOf = async (runId: string) =>
	(
		await client.query(
			`SELECT c.instance_id, c.status, c.review_reason, c.provisional_result, c.automated_provider_calls, c.total_actual_cost_usd::text
			 FROM sentiment_resolution_cases c JOIN sentiment_analyses a ON a.id = c.analysis_id WHERE a.prompt_run_id = $1`,
			[runId],
		)
	).rows[0];
const attemptsOf = async (runId: string) =>
	(
		await client.query(
			"SELECT t.id, t.ordinal, t.phase, t.outcome, t.generation_id, t.instance_id, t.input_hash, t.candidate FROM sentiment_provider_attempts t JOIN sentiment_analyses a ON a.id = t.analysis_id WHERE a.prompt_run_id = $1 ORDER BY t.ordinal",
			[runId],
		)
	).rows;
const observations = (runId: string) => count("sentiment_observations WHERE prompt_run_id = $1", [runId]);

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

type Step = { phase: "classify" | "repair" | "verify"; answer?: unknown; hold?: Promise<void> };
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
			return {
				object: schema.parse(step.answer),
				modelVersion: SENTIMENT_MODEL,
				generationId: `gen-rsm-${Math.random().toString(36).slice(2, 10)}`,
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

async function insertRun(id: string, minutesAgo: number) {
	await client.query(
		`INSERT INTO prompt_runs (id, prompt_id, brand_id, model, provider, version, web_search_enabled, raw_output, brand_mentioned, competitors_mentioned, created_at)
		 VALUES ($1, $2, $3, 'chatgpt', 'openrouter', 'v', true, $4, true, '{}', now() - ($5 || ' minutes')::interval)`,
		[id, PROMPT, BRAND, JSON.stringify({ choices: [{ message: { content: BRAND_ANSWER } }] }), String(minutesAgo)],
	);
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
		`INSERT INTO brands (id, organization_id, slug, name, website, enabled, onboarded, created_at, updated_at) VALUES ($1, $2, $1, 'Sent V5 RSM', 'https://sent-v5-rsm.example.test/', true, true, now(), now())`,
		[BRAND, org.rows[0].id],
	);
	await client.query(
		`INSERT INTO prompts (id, brand_id, value, enabled, tags, system_tags, created_at, updated_at) VALUES ($1, $2, 'RSM prompt', false, '{}', '{unbranded}', now(), now())`,
		[PROMPT, BRAND],
	);
	for (let i = 1; i <= 14; i++) await insertRun(run(i), 100 - i);
});

afterAll(async () => {
	await cleanup();
	await client.end();
});

/**
 * The A2A race: worker A dispatches and blocks at `holdPhase`; its lease
 * expires; worker B claims, finds the `sending` attempt, makes no call and
 * parks the case; A's late answer settles its own attempt. Returns the
 * wake-up spy that A must have fired exactly once.
 */
async function lateAnswerRace(runId: string, stepsA: Step[], holdPhase: "classify" | "repair" | "verify") {
	const { hold, release } = deferred();
	const a = scripted(stepsA.map((s) => (s.phase === holdPhase ? { ...s, hold } : s)));
	const wakeups: string[] = [];
	const enqueueResume = async (promptRunId: string) => {
		wakeups.push(promptRunId);
		return "job-resume";
	};
	const attemptA = runSentimentJob(payload(runId), {
		resolveProvider: () => a.provider,
		resolutionPolicy: fast,
		enqueueResume,
	});
	await new Promise((r) => setTimeout(r, 300));
	expect((await attemptsOf(runId)).at(-1)).toMatchObject({ phase: holdPhase, outcome: "sending" });
	await expireLease(runId);
	const b = scripted([
		{ phase: "classify", answer: { entities: [brandOk] } },
		{ phase: "verify", answer: ACCEPT },
	]);
	expect(
		await runSentimentJob(payload(runId), { resolveProvider: () => b.provider, resolutionPolicy: fast }),
	).toMatchObject({
		status: "awaiting-reconciliation",
	});
	expect(b.script.calls).toEqual([]);
	release();
	expect(await attemptA).toMatchObject({ status: "claim-lost" });
	return { scriptA: a.script, wakeups };
}

const resumeWith = (runId: string, steps: Step[], policy: JobDeps["resolutionPolicy"] = fast) => {
	const s = scripted(steps);
	return {
		script: s.script,
		outcome: runSentimentJob(payload(runId), { resolveProvider: () => s.provider, resolutionPolicy: policy }),
	};
};

describe("A2B-1 a parked case resumes from its own late classification candidate", () => {
	it("the resumed worker catches the budget up, skips classification, verifies once and completes: two calls in total", async () => {
		const { scriptA, wakeups } = await lateAnswerRace(
			run(1),
			[{ phase: "classify", answer: { entities: [brandOk] } }],
			"classify",
		);
		expect(phases(scriptA)).toEqual(["classify"]);
		expect(wakeups).toEqual([run(1)]);
		// Before resume: the ledger holds the late accepted classification; the parked case still carries no fenced accounting.
		expect((await attemptsOf(run(1))).map((t) => `${t.phase}:${t.outcome}`)).toEqual(["classify:accepted"]);
		expect(await caseOf(run(1))).toMatchObject({
			status: "awaiting_reconciliation",
			review_reason: "unknown-provider-outcome",
			provisional_result: null,
			automated_provider_calls: 0,
			total_actual_cost_usd: "0.000000",
		});

		const resumed = resumeWith(run(1), [{ phase: "verify", answer: ACCEPT }]);
		expect(await resumed.outcome).toMatchObject({ status: "classified", paidCalls: 2, verified: true });
		expect(phases(resumed.script)).toEqual(["verify"]);
		expect((await attemptsOf(run(1))).map((t) => `${t.phase}:${t.outcome}`)).toEqual([
			"classify:accepted",
			"verify:accepted",
		]);
		expect(await caseOf(run(1))).toMatchObject({
			status: "resolved",
			automated_provider_calls: 2,
			total_actual_cost_usd: "0.040000",
		});
		const analysis = await analysisOf(run(1));
		expect(analysis).toMatchObject({ status: "completed", error_code: null });
		expect(analysis.verified_at).not.toBeNull();
		expect(await observations(run(1))).toBe(1);
	});

	it("A2B-3 a repeated invocation after completion makes no call and changes nothing", async () => {
		const before = {
			kase: await caseOf(run(1)),
			analysis: await analysisOf(run(1)),
			attempts: await attemptsOf(run(1)),
		};
		const again = resumeWith(run(1), [{ phase: "classify", answer: { entities: [brandOk] } }]);
		expect(await again.outcome).toEqual({ status: "already-completed" });
		expect(again.script.calls).toEqual([]);
		expect(await caseOf(run(1))).toEqual(before.kase);
		expect(await analysisOf(run(1))).toEqual(before.analysis);
		expect(await attemptsOf(run(1))).toEqual(before.attempts);
	});
});

describe("A2B-2 two concurrent resume workers", () => {
	it("exactly one owner, one verifier call, one completion; the loser mutates nothing", async () => {
		await lateAnswerRace(run(2), [{ phase: "classify", answer: { entities: [brandOk] } }], "classify");
		const { hold, release } = deferred();
		const first = scripted([{ phase: "verify", answer: ACCEPT, hold }]);
		const second = scripted([{ phase: "verify", answer: ACCEPT }]);
		const p1 = runSentimentJob(payload(run(2)), { resolveProvider: () => first.provider, resolutionPolicy: fast });
		await new Promise((r) => setTimeout(r, 300));
		const o2 = await runSentimentJob(payload(run(2)), {
			resolveProvider: () => second.provider,
			resolutionPolicy: fast,
		});
		expect(o2).toMatchObject({ status: "claimed-elsewhere", analysisStatus: "processing" });
		expect(second.script.calls).toEqual([]);
		release();
		expect(await p1).toMatchObject({ status: "classified", paidCalls: 2 });
		expect(phases(first.script)).toEqual(["verify"]);
		expect((await attemptsOf(run(2))).map((t) => `${t.phase}:${t.outcome}`)).toEqual([
			"classify:accepted",
			"verify:accepted",
		]);
		expect(await caseOf(run(2))).toMatchObject({ status: "resolved", automated_provider_calls: 2 });
	});
});

describe("A2B-4 anything short of exact same-instance evidence keeps the case parked without a call", () => {
	const spoil = async (runId: string, mutate: (attemptId: string, instanceId: string) => Promise<void>) => {
		await lateAnswerRace(runId, [{ phase: "classify", answer: { entities: [brandOk] } }], "classify");
		const [attempt] = await attemptsOf(runId);
		await mutate(attempt.id, attempt.instance_id);
		const before = { kase: await caseOf(runId), analysis: await analysisOf(runId) };
		const attempted = resumeWith(runId, [
			{ phase: "classify", answer: { entities: [brandOk] } },
			{ phase: "verify", answer: ACCEPT },
		]);
		expect(await attempted.outcome).toMatchObject({ status: "awaiting-reconciliation" });
		expect(attempted.script.calls).toEqual([]);
		expect(await caseOf(runId)).toEqual(before.kase);
		expect(await analysisOf(runId)).toEqual(before.analysis);
	};
	const set = (column: string) => async (attemptId: string) => {
		await client.query(`UPDATE sentiment_provider_attempts SET ${column} WHERE id = $1`, [attemptId]);
	};

	it("wrong instance", () => spoil(run(3), set("instance_id = '00000000-0000-4000-8000-000000000000'")));
	it("wrong input hash", () => spoil(run(4), set(`input_hash = '${"f".repeat(64)}'`)));
	it("null candidate", () => spoil(run(5), set("candidate = NULL")));
	it("malformed candidate", () =>
		spoil(run(6), set(`candidate = '{"entities":[{"key":"brand","score":700}]}'::jsonb`)));
	it("non-accepted outcome", () => spoil(run(7), set("outcome = 'rejected'")));
	it("a later sending attempt", () =>
		spoil(run(8), async (attemptId, instanceId) => {
			await client.query(
				`INSERT INTO sentiment_provider_attempts (analysis_id, instance_id, ordinal, phase, provider, model, input_hash, outcome)
				 SELECT analysis_id, $2, 2, 'verify', provider, model, input_hash, 'sending' FROM sentiment_provider_attempts WHERE id = $1`,
				[attemptId, instanceId],
			);
		}));
});

describe("A2B-5 a stored repair candidate continues to verification without another repair", () => {
	it("classify (unbound) → repair answered late → resume verifies the merged candidate: three calls, no second repair", async () => {
		const { scriptA } = await lateAnswerRace(
			run(9),
			[
				{ phase: "classify", answer: { entities: [brandUnbound] } },
				{ phase: "repair", answer: { entities: [brandOk] } },
			],
			"repair",
		);
		expect(phases(scriptA)).toEqual(["classify", "repair"]);
		expect((await attemptsOf(run(9))).map((t) => `${t.phase}:${t.outcome}`)).toEqual([
			"classify:rejected",
			"repair:accepted",
		]);
		const resumed = resumeWith(run(9), [{ phase: "verify", answer: ACCEPT }]);
		expect(await resumed.outcome).toMatchObject({ status: "classified", paidCalls: 3 });
		expect(phases(resumed.script)).toEqual(["verify"]);
		expect(await caseOf(run(9))).toMatchObject({
			status: "resolved",
			automated_provider_calls: 3,
			total_actual_cost_usd: "0.060000",
		});
		expect(await analysisOf(run(9))).toMatchObject({ status: "completed" });
	});
});

describe("A2B-6 the late call counts against the budget before the next request", () => {
	it("a policy of one paid call is already exhausted by the late classification: awaiting_review, verifier never called", async () => {
		await lateAnswerRace(run(10), [{ phase: "classify", answer: { entities: [brandOk] } }], "classify");
		const resumed = resumeWith(run(10), [{ phase: "verify", answer: ACCEPT }], { ...fast, maxPaidCalls: 1 });
		expect(await resumed.outcome).toMatchObject({ status: "awaiting-review", reason: "call-limit", paidCalls: 1 });
		expect(resumed.script.calls).toEqual([]);
		expect(await caseOf(run(10))).toMatchObject({
			status: "awaiting_review",
			automated_provider_calls: 1,
			total_actual_cost_usd: "0.020000",
		});
		expect(await analysisOf(run(10))).toMatchObject({ status: "pending_resolution" });
	});
});

describe("A2B-7 a candidate-less late verify attempt is never a completed verification", () => {
	it("the late verdict is recorded but not trusted; the recoverable classification candidate is re-verified with one new call", async () => {
		const { scriptA } = await lateAnswerRace(
			run(11),
			[
				{ phase: "classify", answer: { entities: [brandOk] } },
				{ phase: "verify", answer: ACCEPT },
			],
			"verify",
		);
		expect(phases(scriptA)).toEqual(["classify", "verify"]);
		const attempts = await attemptsOf(run(11));
		expect(attempts.map((t) => `${t.phase}:${t.outcome}`)).toEqual(["classify:accepted", "verify:accepted"]);
		expect(attempts[1].candidate).toBeNull();
		expect(await analysisOf(run(11))).toMatchObject({ status: "pending_resolution", verified_at: null });
		const resumed = resumeWith(run(11), [{ phase: "verify", answer: ACCEPT }]);
		expect(await resumed.outcome).toMatchObject({ status: "classified", paidCalls: 3 });
		expect(phases(resumed.script)).toEqual(["verify"]);
		expect((await attemptsOf(run(11))).map((t) => `${t.phase}:${t.outcome}`)).toEqual([
			"classify:accepted",
			"verify:accepted",
			"verify:accepted",
		]);
		expect(await caseOf(run(11))).toMatchObject({ status: "resolved", automated_provider_calls: 3 });
		expect((await analysisOf(run(11))).verified_at).not.toBeNull();
	});
});

describe("A2B-8 the wake-up is idempotent", () => {
	it("A fires exactly one resume for its run; a duplicate wake-up finds the case already resolved and makes no call", async () => {
		const { wakeups } = await lateAnswerRace(
			run(12),
			[{ phase: "classify", answer: { entities: [brandOk] } }],
			"classify",
		);
		expect(wakeups).toEqual([run(12)]);
		const first = resumeWith(run(12), [{ phase: "verify", answer: ACCEPT }]);
		expect(await first.outcome).toMatchObject({ status: "classified", paidCalls: 2 });
		const duplicate = resumeWith(run(12), [{ phase: "verify", answer: ACCEPT }]);
		expect(await duplicate.outcome).toEqual({ status: "already-completed" });
		expect(duplicate.script.calls).toEqual([]);
		expect((await attemptsOf(run(12))).filter((t) => t.phase === "verify")).toHaveLength(1);
	});
});
