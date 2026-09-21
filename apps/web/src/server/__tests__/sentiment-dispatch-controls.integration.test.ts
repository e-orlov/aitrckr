/**
 * Runs against the disposable test database: `pnpm -C apps/web
 * test:integration` with DATABASE_URL pointing at it.
 *
 * Amendment C on real Postgres: the dispatch control, its audit, permits,
 * the per-scope breaker and the retry-wait rediscovery as the database
 * enforces them — constraints, compare-and-swap, single-winner races under
 * Read Committed, and the job core making zero provider calls while held or
 * blocked. The suite leaves dispatch OPEN, as the rest of the matrix expects.
 */
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must point at the seeded test stack");

const {
	SENTIMENT_CLASSIFIER_VERSION,
	SENTIMENT_MODEL,
	SENTIMENT_TAXONOMY_VERSION,
	runSentimentJob,
	transitionDispatch,
	readDispatchState,
	issuePermit,
	consumePermitPhase,
	listControlEvents,
	enqueueSentimentBestEffort,
	enqueueResumableSentimentRuns,
	listResumableSentimentRuns,
	runSentimentEnqueue,
	acquireProbe,
	readBreaker,
	resetBreaker,
	brandEntity,
	ensureAnalysis,
	ensureResolutionCase,
	sentimentInputHash,
	candidatesFromMentions,
	loadMentions,
	loadDetectableEntities,
	analyzeAnswerRanges,
} = await import("@workspace/lib/sentiment");
const { StructuredResearchRequestError } = await import("@workspace/lib/providers/types");
const { db } = await import("@workspace/lib/db/db");
type Provider = import("@workspace/lib/providers/types").Provider;

const ORG = "default";
const BRAND = "sent-c-dispatch-brand";
const PROMPT = "5e97000d-0000-4000-8000-000000000101";
const run = (i: number) => `5e97000d-0000-4000-8000-0000000002${String(i).padStart(2, "0")}`;
const ACTOR = { actor: "it:dispatch", reason: "integration test", correlationId: "IT-SNT-C" };

/** s0001 brand · s0003 brand · s0006 brand. */
const ANSWER = `Wenn du die **Sent C Dispatch-Rechtsschutzversicherung** meinst: **Ja, sie kann gut sein – besonders beim Leistungsumfang –, aber sie ist nicht automatisch die beste Wahl für jeden.**

**Dafür spricht:**
- Vergleichstests bewerten den Leistungsumfang der Sent C Dispatch positiv.
- Es gibt umfangreiche Leistungen, etwa weltweiten Schutz – je nach Tarif.

**Kurz gesagt:**
Für Rechtsschutz ist die Sent C Dispatch grundsätzlich ein seriöser und leistungsstarker Anbieter.`;

const client = new pg.Client({ connectionString: DATABASE_URL });
const payload = (promptRunId: string) => ({
	promptRunId,
	classifierVersion: SENTIMENT_CLASSIFIER_VERSION,
	taxonomyVersion: SENTIMENT_TAXONOMY_VERSION,
});
const analysisOf = async (runId: string) =>
	(
		await client.query(
			"SELECT id, status, attempts, error_code FROM sentiment_analyses WHERE prompt_run_id = $1 AND classifier_version = $2",
			[runId, SENTIMENT_CLASSIFIER_VERSION],
		)
	).rows[0];
const caseOf = async (runId: string) =>
	(
		await client.query(
			`SELECT c.instance_id, c.input_hash, c.status, c.review_reason, c.next_attempt_at FROM sentiment_resolution_cases c
			 JOIN sentiment_analyses a ON a.id = c.analysis_id WHERE a.prompt_run_id = $1`,
			[runId],
		)
	).rows[0];
const attemptsOf = async (runId: string) =>
	(
		await client.query(
			`SELECT t.id, t.ordinal, t.phase, t.outcome, t.generation_id, t.permit_id, t.scope_key, t.schema_fp, t.reserved_estimate_usd::text
			 FROM sentiment_provider_attempts t JOIN sentiment_analyses a ON a.id = t.analysis_id WHERE a.prompt_run_id = $1 ORDER BY t.ordinal`,
			[runId],
		)
	).rows;
const controlRow = async () => (await client.query("SELECT key, state, epoch, actor FROM sentiment_controls")).rows;

const cite = (anchorId: string, polarity: "positive" | "negative" | "neutral") => ({ anchorId, polarity });
const brandOk = {
	key: "brand",
	category: "positive" as const,
	score: 70,
	confidence: 0.9,
	evidence: [cite("s0001", "positive"), cite("s0006", "positive")],
	aspects: [],
};
const ACCEPT = { verdict: "accept", issues: [] };

type Step = { phase: "classify" | "repair" | "verify"; answer?: unknown; error?: unknown };
function scripted(steps: Step[]) {
	const script = { steps: [...steps], calls: [] as string[] };
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
			script.calls.push(phase);
			const step = script.steps.shift();
			if (!step) throw new Error(`unscripted ${phase} call`);
			if (step.phase !== phase) throw new Error(`expected ${step.phase}, got ${phase}`);
			if (step.error) throw step.error;
			return {
				object: schema.parse(step.answer),
				modelVersion: SENTIMENT_MODEL,
				generationId: `gen-c-${Math.random().toString(36).slice(2, 10)}`,
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
const refusal = (httpStatus: number, errorType: string | null, retryAfterMs: number | null = null) =>
	new StructuredResearchRequestError({
		provider: "openrouter",
		httpStatus,
		errorType,
		structured: true,
		carriesOutput: false,
		retryAfterMs,
		message: `OpenRouter API error (${httpStatus}): {}`,
	});

async function insertRun(id: string) {
	await client.query(
		`INSERT INTO prompt_runs (id, prompt_id, brand_id, model, provider, version, web_search_enabled, raw_output, brand_mentioned, competitors_mentioned, created_at)
		 VALUES ($1, $2, $3, 'chatgpt', 'openrouter', 'v', true, $4, true, '{}', now() - interval '1 hour')`,
		[id, PROMPT, BRAND, JSON.stringify({ choices: [{ message: { content: ANSWER } }] })],
	);
}
async function cleanup() {
	// Deleting the runs cascades to analyses, attempts and permits in one statement (the attempt → permit
	// reference is checked at statement end, so the ledger and its permits go together).
	await client.query("DELETE FROM usage_events WHERE brand_id = $1", [BRAND]);
	await client.query("DELETE FROM prompt_runs WHERE brand_id = $1", [BRAND]);
	await client.query("DELETE FROM prompts WHERE brand_id = $1", [BRAND]);
	await client.query("DELETE FROM brands WHERE id = $1", [BRAND]);
	await client.query("DELETE FROM sentiment_provider_breakers WHERE scope_key LIKE 'rp1:%'");
	await client.query("DELETE FROM sentiment_control_events WHERE subject_kind IN ('breaker','permit')");
}
async function setDispatch(to: "held" | "open") {
	const current = await readDispatchState();
	if (current.state === to) return;
	const moved = await transitionDispatch({ to, expected: current.state, ...ACTOR });
	if (!moved.ok) throw new Error(`could not move dispatch to ${to}`);
}
const expectRejected = async (sqlText: string, params: unknown[], codes: string[]) => {
	try {
		await client.query(sqlText, params);
	} catch (error) {
		expect(codes).toContain((error as { code?: string }).code);
		return;
	}
	throw new Error(`expected rejection: ${sqlText}`);
};

beforeAll(async () => {
	const host = new URL(DATABASE_URL).hostname;
	if (!["localhost", "127.0.0.1", "::1"].includes(host)) throw new Error(`refusing non-loopback database ${host}`);
	await client.connect();
	const org = await client.query("SELECT id FROM organization WHERE slug = $1", [ORG]);
	if (org.rows.length !== 1) throw new Error("seeded organization missing — not the disposable test database");
	await cleanup();
	await client.query(
		`INSERT INTO brands (id, organization_id, slug, name, website, enabled, onboarded, created_at, updated_at) VALUES ($1, $2, $1, 'Sent C Dispatch', 'https://sent-c-dispatch.example.test/', true, true, now(), now())`,
		[BRAND, org.rows[0].id],
	);
	await client.query(
		`INSERT INTO prompts (id, brand_id, value, enabled, tags, system_tags, created_at, updated_at) VALUES ($1, $2, 'dispatch prompt', false, '{}', '{unbranded}', now(), now())`,
		[PROMPT, BRAND],
	);
	for (let i = 1; i <= 12; i++) await insertRun(run(i));
	await setDispatch("open");
});

afterAll(async () => {
	await setDispatch("open");
	await cleanup();
	await client.end();
});

describe("IT-SNT-C-001 migration 0024: model, constraints and the seeded control", () => {
	it("the five control tables, the attempt columns and the retry-exhausted reason exist", async () => {
		const tables = (
			await client.query(
				"SELECT table_name FROM information_schema.tables WHERE table_name IN ('sentiment_controls','sentiment_control_events','sentiment_dispatch_permits','sentiment_provider_breakers','sentiment_alert_state') ORDER BY 1",
			)
		).rows.map((r) => r.table_name);
		expect(tables).toHaveLength(5);
		const columns = (
			await client.query(
				"SELECT column_name FROM information_schema.columns WHERE table_name = 'sentiment_provider_attempts' AND column_name IN ('permit_id','scope_key','schema_fp','reserved_estimate_usd') ORDER BY 1",
			)
		).rows.map((r) => r.column_name);
		expect(columns).toEqual(["permit_id", "reserved_estimate_usd", "schema_fp", "scope_key"]);
		const control = await controlRow();
		expect(control).toHaveLength(1);
		expect(control[0]).toMatchObject({ key: "dispatch" });
		expect(
			(
				await client.query(
					"SELECT seq, to_state FROM sentiment_control_events WHERE subject_kind = 'control' AND subject_key = 'dispatch' ORDER BY seq",
				)
			).rows[0],
		).toMatchObject({ seq: 1, to_state: "held" });
	});

	it("rejects an unknown control state, a permit over the planning budget, a malformed phase budget and a duplicate audit sequence", async () => {
		await expectRejected("UPDATE sentiment_controls SET state = 'maybe' WHERE key = 'dispatch'", [], ["23514"]);
		const analysisId = (await ensureAnalysis({ promptRunId: run(1), brandId: BRAND })).id;
		const base = `INSERT INTO sentiment_dispatch_permits (purpose, prompt_run_id, analysis_id, instance_id, input_hash, classifier_version, provider, model, phase_budget, estimated_cost_budget_usd, expires_at, issued_by, reason, correlation_id) VALUES ('canary', $1, $2, gen_random_uuid(), 'h', 'v5', 'openrouter', 'm', $3::jsonb, $4, now() + interval '1 hour', 'it', 'r', 'c')`;
		await expectRejected(base, [run(1), analysisId, '{"classify":1,"repair":0,"verify":1}', "0.11"], ["23514"]);
		await expectRejected(base, [run(1), analysisId, '{"classify":2,"repair":0,"verify":1}', "0.05"], ["23514"]);
		await expectRejected(base, [run(1), analysisId, '{"classify":1,"other":1}', "0.05"], ["23514"]);
		await expectRejected(
			"INSERT INTO sentiment_control_events (subject_kind, subject_key, seq, to_state, actor, reason, correlation_id) VALUES ('control', 'dispatch', 1, 'open', 'x', 'y', 'z')",
			[],
			["23505"],
		);
		await expectRejected(
			"INSERT INTO sentiment_resolution_cases (analysis_id, input_hash, status, review_reason) VALUES ($1, 'h', 'awaiting_review', 'bogus')",
			[analysisId],
			["23514"],
		);
		await client.query(
			"INSERT INTO sentiment_resolution_cases (analysis_id, input_hash, status, review_reason) VALUES ($1, 'h', 'awaiting_review', 'retry-exhausted')",
			[analysisId],
		);
		await client.query("DELETE FROM sentiment_resolution_cases WHERE analysis_id = $1", [analysisId]);
	});
});

describe("IT-SNT-C-002 compare-and-swap and append-only audit", () => {
	it("moves held → open once, refuses the repeat, and appends a dense audited sequence", async () => {
		await setDispatch("held");
		const before = (await readDispatchState()) as { epoch: number };
		const first = await transitionDispatch({ to: "open", expected: "held", ...ACTOR });
		expect(first).toMatchObject({ ok: true, epoch: before.epoch + 1 });
		const repeat = await transitionDispatch({ to: "open", expected: "held", ...ACTOR });
		expect(repeat).toEqual({ ok: false, current: "open" });
		const events = await listControlEvents("control", "dispatch");
		expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1));
		expect(events.at(-1)).toMatchObject({ fromState: "held", toState: "open", actor: ACTOR.actor });
	});

	it("eight concurrent operators opening a held dispatch: exactly one succeeds, one event", async () => {
		await setDispatch("held");
		const eventsBefore = (await listControlEvents("control", "dispatch")).length;
		const results = await Promise.all(
			Array.from({ length: 8 }, (_, i) =>
				transitionDispatch({ to: "open", expected: "held", ...ACTOR, correlationId: `race-${i}` }),
			),
		);
		expect(results.filter((r) => r.ok)).toHaveLength(1);
		expect((await listControlEvents("control", "dispatch")).length).toBe(eventsBefore + 1);
	});

	it("a mutating command without actor, reason or correlation is refused", async () => {
		await expect(
			transitionDispatch({ to: "held", expected: "open", actor: "", reason: "r", correlationId: "c" }),
		).rejects.toThrow(/actor/);
	});
});

describe("IT-SNT-C-003 every origin is held; permits are the only bypass", () => {
	it("natural enqueue under HELD leaves the pending analysis row and sends no job", async () => {
		await setDispatch("held");
		const sends: unknown[] = [];
		const outcome = await enqueueSentimentBestEffort({
			promptRunId: run(2),
			brandId: BRAND,
			answerBody: ANSWER,
			entities: [
				brandEntity({
					id: BRAND,
					name: "Sent C Dispatch",
					website: "sent-c-dispatch.example.test",
					aliases: [],
					additionalDomains: [],
				} as never),
			],
			sender: {
				send: async (...args: unknown[]) => {
					sends.push(args);
					return "job";
				},
			},
		});
		expect(outcome).toMatchObject({ status: "held" });
		expect(sends).toEqual([]);
		expect(await analysisOf(run(2))).toMatchObject({ status: "pending", attempts: 0 });
	});

	it("an already-queued job executed under HELD completes as held without a claim or a call", async () => {
		await setDispatch("held");
		const { provider, script } = scripted([{ phase: "classify", answer: { entities: [brandOk] } }]);
		const outcome = await runSentimentJob(payload(run(2)), { resolveProvider: () => provider });
		expect(outcome).toEqual({ status: "held", reason: "dispatch-held", nextAttemptAt: null });
		expect(script.calls).toEqual([]);
		expect(await analysisOf(run(2))).toMatchObject({ status: "pending", attempts: 0 });
		expect(await attemptsOf(run(2))).toEqual([]);
	});

	it("maintenance rediscovery and historical backfill are refused under HELD", async () => {
		await setDispatch("held");
		const sends: unknown[] = [];
		const sender = {
			send: async (...args: unknown[]) => {
				sends.push(args);
				return "job";
			},
		};
		expect(await enqueueResumableSentimentRuns(sender)).toMatchObject({ held: true, enqueued: 0 });
		await expect(runSentimentEnqueue({ enqueue: { limit: 1 }, sender, brandId: BRAND })).rejects.toThrow(/held/);
		expect(sends).toEqual([]);
		// The dry run still works: nothing is created.
		const inventory = await runSentimentEnqueue({ enqueue: false, brandId: BRAND });
		expect(inventory.counts.attempted).toBe(0);
	});

	it("a lifecycle permit lets the held run classify and verify; the attempts carry permit, scope and shape; the reservation settles", async () => {
		await setDispatch("held");
		const analysis = await analysisOf(run(2));
		const candidates = candidatesFromMentions(
			await loadMentions(run(2)),
			await loadDetectableEntities(BRAND, "historical"),
		);
		const inputHash = sentimentInputHash(ANSWER, candidates, analyzeAnswerRanges(ANSWER));
		const kase = await ensureResolutionCase(analysis.id, inputHash);
		const permit = await issuePermit({
			purpose: "canary",
			promptRunId: run(2),
			analysisId: analysis.id,
			instanceId: kase.instanceId,
			inputHash,
			classifierVersion: SENTIMENT_CLASSIFIER_VERSION,
			phaseBudget: { classify: 1, repair: 1, verify: 1 },
			estimatedCostBudgetUsd: 0.1,
			ttlSeconds: 600,
			...ACTOR,
		});
		// A second live permit for the same instance is refused by the partial unique index.
		await expect(
			issuePermit({
				purpose: "canary",
				promptRunId: run(2),
				analysisId: analysis.id,
				instanceId: kase.instanceId,
				inputHash,
				classifierVersion: SENTIMENT_CLASSIFIER_VERSION,
				phaseBudget: { classify: 1, repair: 0, verify: 1 },
				estimatedCostBudgetUsd: 0.1,
				ttlSeconds: 600,
				...ACTOR,
			}),
		).rejects.toThrow();
		const { provider, script } = scripted([
			{ phase: "classify", answer: { entities: [brandOk] } },
			{ phase: "verify", answer: ACCEPT },
		]);
		const outcome = await runSentimentJob(payload(run(2)), { resolveProvider: () => provider });
		expect(outcome).toMatchObject({ status: "classified", paidCalls: 2 });
		expect(script.calls).toEqual(["classify", "verify"]);
		const attempts = await attemptsOf(run(2));
		expect(attempts.map((a) => `${a.phase}:${a.outcome}`)).toEqual(["classify:accepted", "verify:accepted"]);
		for (const a of attempts) {
			expect(a.permit_id).toBe(permit.id);
			expect(a.scope_key).toMatch(/^rp1:[0-9a-f]{64}$/);
			expect(a.schema_fp).toMatch(/^sfp1:[0-9a-f]{64}$/);
		}
		expect(attempts[0].scope_key).not.toBe(attempts[1].scope_key);
		const settled = (
			await client.query(
				"SELECT state, phase_budget, settled_cost_usd::text, reserved_estimate_usd::text FROM sentiment_dispatch_permits WHERE id = $1",
				[permit.id],
			)
		).rows[0];
		expect(settled).toMatchObject({ state: "active", phase_budget: { classify: 0, repair: 1, verify: 0 } });
		expect(Number(settled.settled_cost_usd)).toBeCloseTo(0.04, 6);
		expect(Number(settled.reserved_estimate_usd)).toBe(0);
		expect((await listControlEvents("permit", permit.id))[0]).toMatchObject({ toState: "issued" });
	});

	it("eight workers consuming the same permitted phase: exactly one consumption", async () => {
		await setDispatch("held");
		await runSentimentJob(payload(run(3)), { resolveProvider: () => scripted([]).provider }); // creates the pending row
		const analysis = await analysisOf(run(3));
		const kase = await ensureResolutionCase(analysis.id, "a".repeat(64));
		await issuePermit({
			purpose: "canary",
			promptRunId: run(3),
			analysisId: analysis.id,
			instanceId: kase.instanceId,
			inputHash: "a".repeat(64),
			classifierVersion: SENTIMENT_CLASSIFIER_VERSION,
			phaseBudget: { classify: 1, repair: 0, verify: 0 },
			estimatedCostBudgetUsd: 0.1,
			ttlSeconds: 600,
			...ACTOR,
		});
		const results = await Promise.all(
			Array.from({ length: 8 }, () =>
				db.transaction((tx) =>
					consumePermitPhase(tx, {
						analysisId: analysis.id,
						instanceId: kase.instanceId,
						inputHash: "a".repeat(64),
						phase: "classify",
						reserveUsd: 0.05,
					}),
				),
			),
		);
		expect(results.filter((r: { consumed: boolean; reason?: string }) => r.consumed)).toHaveLength(1);
		expect(
			results.filter((r: { consumed: boolean; reason?: string }) => !r.consumed && r.reason === "phase-exhausted"),
		).toHaveLength(7);
	});
});

describe("IT-SNT-C-004 breaker on real rows", () => {
	it("a structured output-less 400 opens the classify scope; the next run is blocked before any attempt; eight probes → one", async () => {
		await setDispatch("open");
		const first = await runSentimentJob(payload(run(4)), {
			resolveProvider: () => scripted([{ phase: "classify", error: refusal(400, null) }]).provider,
		});
		expect(first).toMatchObject({ status: "awaiting-review", reason: "contract-defect" });
		const [attempt] = await attemptsOf(run(4));
		expect(attempt).toMatchObject({ phase: "classify", outcome: "provider-error" });
		const breaker = await readBreaker(attempt.scope_key);
		expect(breaker).toMatchObject({ state: "open", consecutiveFailures: 1, openedClass: "request-refused-400" });
		expect((await listControlEvents("breaker", attempt.scope_key)).map((e) => e.toState)).toEqual(["open"]);

		const { provider, script } = scripted([{ phase: "classify", answer: { entities: [brandOk] } }]);
		const blocked = await runSentimentJob(payload(run(5)), { resolveProvider: () => provider });
		expect(blocked).toMatchObject({ status: "held", reason: "breaker-open" });
		expect(script.calls).toEqual([]);
		expect(await attemptsOf(run(5))).toEqual([]);
		expect(await caseOf(run(5))).toMatchObject({ status: "retry_wait" });

		await client.query(
			"UPDATE sentiment_provider_breakers SET open_until = now() - interval '1 second' WHERE scope_key = $1",
			[attempt.scope_key],
		);
		const probes = await Promise.all(
			Array.from({ length: 8 }, (_, i) =>
				db.transaction((tx) => acquireProbe(tx, attempt.scope_key, `00000000-0000-4000-8000-00000000000${i}`)),
			),
		);
		expect(probes.filter((p) => p !== null)).toHaveLength(1);
		expect(await readBreaker(attempt.scope_key)).toMatchObject({ state: "half_open", probeGeneration: 1 });

		// Operator reset moves only open → half_open; a half-open scope is not resettable and nothing goes to closed.
		expect(await resetBreaker({ scopeKey: attempt.scope_key, ...ACTOR })).toMatchObject({
			reset: false,
			state: "half_open",
		});
		await client.query(
			"UPDATE sentiment_provider_breakers SET probe_lease_until = now() - interval '1 second' WHERE scope_key = $1",
			[attempt.scope_key],
		);
		// The next run takes over the expired lease as the probe and, accepted, closes the scope.
		const { provider: ok, script: okScript } = scripted([
			{ phase: "classify", answer: { entities: [brandOk] } },
			{ phase: "verify", answer: ACCEPT },
		]);
		expect(await runSentimentJob(payload(run(6)), { resolveProvider: () => ok })).toMatchObject({
			status: "classified",
		});
		expect(okScript.calls).toEqual(["classify", "verify"]);
		expect(await readBreaker(attempt.scope_key)).toMatchObject({
			state: "closed",
			consecutiveFailures: 0,
			probeAttemptId: null,
		});
	});
});

describe("IT-SNT-C-005 retry-wait is durable and due by the database clock", () => {
	it("a typed 429 parks the case as a completed job; not due → deferred; due → rediscovered and completed", async () => {
		await setDispatch("open");
		const first = await runSentimentJob(payload(run(7)), {
			resolveProvider: () =>
				scripted([{ phase: "classify", error: refusal(429, "rate_limit_exceeded", 600_000) }]).provider,
			resolutionPolicy: { backoffMaxMs: 900_000 },
		});
		expect(first).toMatchObject({ status: "retry-wait", consecutiveFailures: 1 });
		const kase = await caseOf(run(7));
		expect(kase).toMatchObject({ status: "retry_wait" });
		expect(new Date(kase.next_attempt_at).getTime()).toBeGreaterThan(Date.now() + 500_000);
		// Not due: no call, the job completes as deferred.
		const { provider, script } = scripted([
			{ phase: "classify", answer: { entities: [brandOk] } },
			{ phase: "verify", answer: ACCEPT },
		]);
		expect(await runSentimentJob(payload(run(7)), { resolveProvider: () => provider })).toMatchObject({
			status: "deferred",
		});
		expect(script.calls).toEqual([]);
		expect((await listResumableSentimentRuns()).map((r) => r.promptRunId)).not.toContain(run(7));
		// Due by the database clock: rediscovered and completed.
		await client.query(
			"UPDATE sentiment_resolution_cases SET next_attempt_at = now() - interval '1 second' WHERE analysis_id = (SELECT id FROM sentiment_analyses WHERE prompt_run_id = $1 AND classifier_version = $2)",
			[run(7), SENTIMENT_CLASSIFIER_VERSION],
		);
		expect((await listResumableSentimentRuns()).map((r) => r.promptRunId)).toContain(run(7));
		expect(await runSentimentJob(payload(run(7)), { resolveProvider: () => provider })).toMatchObject({
			status: "classified",
		});
		expect(script.calls).toEqual(["classify", "verify"]);
	});
});
