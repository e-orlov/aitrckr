/**
 * Runs against the disposable test database: `pnpm -C apps/web
 * test:integration` with DATABASE_URL pointing at it.
 *
 * Corrective Slice A2A on real Postgres: a dispatched provider request's
 * result belongs to its immutable attempt row. When the worker loses its claim
 * before the answer returns, the answer's evidence (outcome, generation id,
 * cost, normalized candidate, usage event) still commits exactly once, while
 * the current case, analysis and projection stay exactly as the new owner
 * left them. Replays are no-ops, conflicting replays fail safely, and the
 * ordinary fenced path is unchanged.
 */
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must point at the seeded test stack");

const {
	SENTIMENT_CLASSIFIER_VERSION,
	SENTIMENT_MODEL,
	SENTIMENT_TAXONOMY_VERSION,
	finishProviderAttempt,
	runSentimentJob,
} = await import("@workspace/lib/sentiment");
type Provider = import("@workspace/lib/providers/types").Provider;
type JobDeps = import("@workspace/lib/sentiment").SentimentJobDeps;

const ORG = "default";
const BRAND = "sent-v5-lcs-brand";
const ALPHA = "5e97000b-0000-4000-8000-00000000000a";
const PROMPT = "5e97000b-0000-4000-8000-000000000101";
const run = (i: number) => `5e97000b-0000-4000-8000-0000000002${String(i).padStart(2, "0")}`;

/** s0001 brand · s0009 brand (see the sibling files for the anchor map). */
const BRAND_ANSWER = `Wenn du die **Sent V5 LCS-Rechtsschutzversicherung** meinst: **Ja, sie kann gut sein – besonders beim Leistungsumfang –, aber sie ist nicht automatisch die beste Wahl für jeden.**

**Dafür spricht:**
- Vergleichstests bewerten den Leistungsumfang der Sent V5 LCS positiv.
- Es gibt umfangreiche Leistungen, etwa weltweiten Schutz – je nach Tarif.

**Worauf du achten solltest:**
- Tarife unterscheiden sich stark bei Wartezeit, Selbstbeteiligung und Ausschlüssen.
- Ein Premium-Tarif kann deutlich teurer sein als ein ausreichender Basistarif.

**Kurz gesagt:**
Für Rechtsschutz ist die Sent V5 LCS grundsätzlich ein seriöser und leistungsstarker Anbieter.`;
/** s0001 names the brand only; s0002 names Alpha only. */
const TWO_ANSWER = "Sent V5 LCS offers a solid service.\n\nAlpha is cheap.";

const client = new pg.Client({ connectionString: DATABASE_URL });
const payload = (promptRunId: string) => ({
	promptRunId,
	classifierVersion: SENTIMENT_CLASSIFIER_VERSION,
	taxonomyVersion: SENTIMENT_TAXONOMY_VERSION,
});
const count = async (sqlText: string, params: unknown[] = []) =>
	(await client.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${sqlText}`, params)).rows[0].n;
const usageEvents = () => count("usage_events WHERE brand_id = $1 AND event_type LIKE 'sentiment%'", [BRAND]);
const analysisOf = async (runId: string) =>
	(
		await client.query(
			"SELECT id, status, attempts, claim_generation, error_code, input_hash, verifier_version, verified_at::text FROM sentiment_analyses WHERE prompt_run_id = $1 AND classifier_version = $2",
			[runId, SENTIMENT_CLASSIFIER_VERSION],
		)
	).rows[0];
const caseOf = async (runId: string) =>
	(
		await client.query(
			`SELECT c.instance_id, c.input_hash, c.status, c.review_reason, c.provisional_result, c.unresolved_targets, c.automated_provider_calls, c.total_actual_cost_usd::text, c.next_attempt_at::text, c.created_at::text, c.updated_at::text
			 FROM sentiment_resolution_cases c JOIN sentiment_analyses a ON a.id = c.analysis_id WHERE a.prompt_run_id = $1`,
			[runId],
		)
	).rows[0];
type AttemptRow = {
	id: string;
	ordinal: number;
	phase: string;
	outcome: string;
	generation_id: string | null;
	instance_id: string;
	actual_cost_usd: string | null;
	finished_at: string | null;
	candidate: unknown;
};
const attemptsOf = async (runId: string): Promise<AttemptRow[]> =>
	(
		await client.query(
			"SELECT t.*, t.actual_cost_usd::text AS actual_cost_usd, t.finished_at::text AS finished_at FROM sentiment_provider_attempts t JOIN sentiment_analyses a ON a.id = t.analysis_id WHERE a.prompt_run_id = $1 ORDER BY t.ordinal",
			[runId],
		)
	).rows as AttemptRow[];
const observations = (runId: string) => count("sentiment_observations WHERE prompt_run_id = $1", [runId]);

const cite = (anchorId: string, polarity: "positive" | "negative" | "neutral") => ({ anchorId, polarity });
const positive = (score: number, ...ids: string[]) => ({
	category: "positive" as const,
	score,
	confidence: 0.9,
	evidence: ids.map((i) => cite(i, "positive")),
});
const brandOk = { key: "brand", ...positive(70, "s0001", "s0009"), aspects: [] };
const twoOk = {
	entities: [
		{ key: "brand", ...positive(75, "s0001"), aspects: [] },
		{ key: ALPHA, ...positive(75, "s0002"), aspects: [] },
	],
};
const ACCEPT = { verdict: "accept", issues: [] };

type Step = { phase: "classify" | "repair" | "verify"; answer?: unknown; hold?: Promise<void>; generationId?: string };
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
				generationId: step.generationId ?? `gen-lcs-${script.calls.length}-${Math.random().toString(36).slice(2, 8)}`,
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

async function insertRun(id: string, answer: string, minutesAgo: number) {
	await client.query(
		`INSERT INTO prompt_runs (id, prompt_id, brand_id, model, provider, version, web_search_enabled, raw_output, brand_mentioned, competitors_mentioned, created_at)
		 VALUES ($1, $2, $3, 'chatgpt', 'openrouter', 'v', true, $4, true, '{}', now() - ($5 || ' minutes')::interval)`,
		[id, PROMPT, BRAND, JSON.stringify({ choices: [{ message: { content: answer } }] }), String(minutesAgo)],
	);
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
		`INSERT INTO brands (id, organization_id, slug, name, website, enabled, onboarded, created_at, updated_at) VALUES ($1, $2, $1, 'Sent V5 LCS', 'https://sent-v5-lcs.example.test/', true, true, now(), now())`,
		[BRAND, org.rows[0].id],
	);
	await client.query(
		`INSERT INTO competitors (id, brand_id, name, domains, aliases, active, removed_at, created_at, updated_at) VALUES ($1, $2, 'Alpha', '{alpha.example.test}', '{}', true, NULL, now(), now())`,
		[ALPHA, BRAND],
	);
	await client.query(
		`INSERT INTO prompts (id, brand_id, value, enabled, tags, system_tags, created_at, updated_at) VALUES ($1, $2, 'LCS prompt', false, '{}', '{unbranded}', now(), now())`,
		[PROMPT, BRAND],
	);
	for (let i = 1; i <= 4; i++) await insertRun(run(i), i === 2 ? TWO_ANSWER : BRAND_ANSWER, 100 - i);
});

afterAll(async () => {
	await cleanup();
	await client.end();
});

/** Worker A dispatches and blocks at the provider; its lease expires; worker B claims and parks the run for reconciliation. */
async function raceToParked(runId: string, answer: unknown, generationId: string) {
	const { hold, release } = deferred();
	const a = scripted([{ phase: "classify", answer, hold, generationId }]);
	const attemptA = runSentimentJob(payload(runId), { resolveProvider: () => a.provider, resolutionPolicy: fast });
	await new Promise((r) => setTimeout(r, 300));
	expect((await attemptsOf(runId)).map((t) => `${t.phase}:${t.outcome}`)).toEqual(["classify:sending"]);
	const generationA = (await analysisOf(runId)).claim_generation;
	await expireLease(runId);
	const b = scripted([
		{ phase: "classify", answer },
		{ phase: "verify", answer: ACCEPT },
	]);
	const outcomeB = await runSentimentJob(payload(runId), { resolveProvider: () => b.provider, resolutionPolicy: fast });
	expect(outcomeB).toEqual({ status: "awaiting-reconciliation", attemptOrdinal: 1 });
	expect(b.script.calls).toEqual([]);
	return { attemptA, release, generationA, callsA: a.script };
}

describe("A2A-1 a late valid answer is attempt-owned evidence, never a stale case mutation", () => {
	it("A loses its claim, B parks without a call, A's answer settles its own attempt; B's case, analysis and projection stay byte-identical; one provider call in total", async () => {
		const { attemptA, release, generationA, callsA } = await raceToParked(
			run(1),
			{ entities: [brandOk] },
			"gen-lcs-late-001",
		);
		const before = { kase: await caseOf(run(1)), analysis: await analysisOf(run(1)), usage: await usageEvents() };
		expect(before.kase).toMatchObject({
			status: "awaiting_reconciliation",
			review_reason: "unknown-provider-outcome",
			provisional_result: null,
		});
		expect(before.analysis).toMatchObject({ status: "pending_resolution", claim_generation: generationA + 1 });

		release();
		expect(await attemptA).toEqual({ status: "claim-lost", generation: generationA });
		expect(callsA.calls).toHaveLength(1);

		const [attempt] = await attemptsOf(run(1));
		expect(attempt).toMatchObject({
			phase: "classify",
			outcome: "accepted",
			generation_id: "gen-lcs-late-001",
			actual_cost_usd: "0.020000",
		});
		expect(attempt.finished_at).not.toBeNull();
		expect(attempt.candidate).toEqual({ entities: [brandOk] });
		expect(await usageEvents()).toBe(before.usage + 1);
		expect(await caseOf(run(1))).toEqual(before.kase);
		expect(await analysisOf(run(1))).toEqual(before.analysis);
		expect(await observations(run(1))).toBe(0);
	});

	it("A2A-2 replaying the identical late settlement is a no-op: no duplicate attempt, usage event, cost or candidate; the case is untouched", async () => {
		const [attempt] = await attemptsOf(run(1));
		const before = { kase: await caseOf(run(1)), attempts: await attemptsOf(run(1)), usage: await usageEvents() };
		expect(
			await finishProviderAttempt(attempt.id, {
				outcome: "accepted",
				generationId: "gen-lcs-late-001",
				actualCostUsd: 0.02,
				candidate: { entities: [brandOk] },
			}),
		).toBe("already-settled");
		expect(await attemptsOf(run(1))).toEqual(before.attempts);
		expect(await usageEvents()).toBe(before.usage);
		expect(await caseOf(run(1))).toEqual(before.kase);
	});

	it("A2A-3 a conflicting replay cannot replace the original terminal evidence", async () => {
		const [attempt] = await attemptsOf(run(1));
		const before = await attemptsOf(run(1));
		await expect(
			finishProviderAttempt(attempt.id, {
				outcome: "accepted",
				generationId: "gen-lcs-late-other",
				actualCostUsd: 0.02,
			}),
		).rejects.toMatchObject({ name: "AttemptSettlementConflictError" });
		await expect(
			finishProviderAttempt(attempt.id, { outcome: "rejected", generationId: "gen-lcs-late-001", actualCostUsd: 0.02 }),
		).rejects.toMatchObject({ name: "AttemptSettlementConflictError" });
		await expect(finishProviderAttempt(attempt.id, { outcome: "provider-error" })).rejects.toMatchObject({
			name: "AttemptSettlementConflictError",
		});
		expect(await attemptsOf(run(1))).toEqual(before);
	});
});

describe("A2A-4 a late answer of an obsolete resolution instance is historical evidence only", () => {
	it("the input changes while A is in flight; B opens a new instance and parks; A's evidence lands on its own (old-instance) row and the new instance is untouched", async () => {
		const { hold, release } = deferred();
		const a = scripted([{ phase: "classify", answer: twoOk, hold, generationId: "gen-lcs-late-002" }]);
		const attemptA = runSentimentJob(payload(run(2)), { resolveProvider: () => a.provider, resolutionPolicy: fast });
		await new Promise((r) => setTimeout(r, 300));
		const oldInstance = (await caseOf(run(2))).instance_id;
		const generationA = (await analysisOf(run(2))).claim_generation;
		// The competitor gains an alias: a new classifier input, hence a new resolution instance for the next owner.
		await client.query("UPDATE competitors SET aliases = '{\"Alpha Insurance\"}' WHERE id = $1", [ALPHA]);
		await expireLease(run(2));
		const b = scripted([
			{ phase: "classify", answer: twoOk },
			{ phase: "verify", answer: ACCEPT },
		]);
		expect(
			await runSentimentJob(payload(run(2)), { resolveProvider: () => b.provider, resolutionPolicy: fast }),
		).toEqual({
			status: "awaiting-reconciliation",
			attemptOrdinal: 1,
		});
		expect(b.script.calls).toEqual([]);
		const before = { kase: await caseOf(run(2)), analysis: await analysisOf(run(2)), usage: await usageEvents() };
		expect(before.kase.instance_id).not.toBe(oldInstance);
		expect(before.kase).toMatchObject({ status: "awaiting_reconciliation", automated_provider_calls: 0 });

		release();
		expect(await attemptA).toEqual({ status: "claim-lost", generation: generationA });
		const [attempt] = await attemptsOf(run(2));
		expect(attempt).toMatchObject({
			instance_id: oldInstance,
			outcome: "accepted",
			generation_id: "gen-lcs-late-002",
			actual_cost_usd: "0.020000",
		});
		expect(attempt.candidate).toEqual(twoOk);
		expect(await usageEvents()).toBe(before.usage + 1);
		expect(await caseOf(run(2))).toEqual(before.kase);
		expect(await analysisOf(run(2))).toEqual(before.analysis);
		expect(await observations(run(2))).toBe(0);
	});
});

describe("A2A-5 the ordinary fenced path is unchanged", () => {
	it("classify and verify settle their attempts (candidate stored for the classification, none for the verdict), the case is charged and resolved, two usage events", async () => {
		const before = await usageEvents();
		const { provider, script } = scripted([
			{ phase: "classify", answer: { entities: [brandOk] }, generationId: "gen-lcs-ok-003a" },
			{ phase: "verify", answer: ACCEPT, generationId: "gen-lcs-ok-003b" },
		]);
		expect(
			await runSentimentJob(payload(run(3)), { resolveProvider: () => provider, resolutionPolicy: fast }),
		).toMatchObject({
			status: "classified",
			paidCalls: 2,
		});
		expect(script.calls.map((c) => c.phase)).toEqual(["classify", "verify"]);
		const attempts = await attemptsOf(run(3));
		expect(attempts.map((t) => `${t.phase}:${t.outcome}:${t.generation_id}`)).toEqual([
			"classify:accepted:gen-lcs-ok-003a",
			"verify:accepted:gen-lcs-ok-003b",
		]);
		expect(attempts[0].candidate).toEqual({ entities: [brandOk] });
		expect(attempts[1].candidate).toBeNull();
		expect(await caseOf(run(3))).toMatchObject({
			status: "resolved",
			automated_provider_calls: 2,
			total_actual_cost_usd: "0.040000",
		});
		expect(await usageEvents()).toBe(before + 2);
		expect(await analysisOf(run(3))).toMatchObject({ status: "completed" });
		expect(await observations(run(3))).toBe(1);
	});
});
