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
	listPermits,
	permitAllowsVerify,
	revokePermit,
} = await import("@workspace/lib/sentiment");
const { loadAttemptDispatch } = await import("../../../../../packages/lib/src/sentiment/store");
const { openBreaker } = await import("../../../../../packages/lib/src/sentiment/breaker");
const { prepareStructuredOutputSchema } = await import("../../../../../packages/lib/src/providers/schema-contract");
const { sentimentProviderResultSchemaFor, schemaShapeFingerprint, sentimentRequestProfile, requestScopeKey } =
	await import("@workspace/lib/sentiment");
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

type Step = { phase: "classify" | "repair" | "verify"; answer?: unknown; error?: unknown; costUsd?: number | null };
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
				// The locked request summary the canary's post-call gate compares against its contract.
				request: {
					model: SENTIMENT_MODEL,
					webSearch: phase === "classify",
					maxToolCalls: phase === "classify" ? 1 : 0,
					maxOutputTokens: 8000,
					strictJsonSchema: true,
					requireParameters: true,
				},
				usage: {
					inputTokens: 5000,
					outputTokens: 800,
					reasoningTokens: 200,
					// `null` models a provider answer that reports no cost at all.
					...(step.costUsd === null ? {} : { costUsd: step.costUsd ?? 0.02 }),
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
	for (let i = 1; i <= 40; i++) await insertRun(run(i));
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

/** The analysis, its exact current input and the case instance a permit binds to, created the way the operator surface does. */
async function lifecycleOf(runId: string) {
	await runSentimentJob(payload(runId), { resolveProvider: () => scripted([]).provider });
	const analysis = await analysisOf(runId);
	const candidates = candidatesFromMentions(
		await loadMentions(runId),
		await loadDetectableEntities(BRAND, "historical"),
	);
	const inputHash = sentimentInputHash(ANSWER, candidates, analyzeAnswerRanges(ANSWER));
	const kase = await ensureResolutionCase(analysis.id, inputHash);
	return { analysisId: analysis.id as string, inputHash, instanceId: kase.instanceId as string };
}
const canaryPermit = (
	runId: string,
	lc: { analysisId: string; inputHash: string; instanceId: string },
	extra: Partial<Parameters<typeof issuePermit>[0]> = {},
) =>
	issuePermit({
		purpose: "canary",
		promptRunId: runId,
		analysisId: lc.analysisId,
		instanceId: lc.instanceId,
		inputHash: lc.inputHash,
		classifierVersion: SENTIMENT_CLASSIFIER_VERSION,
		phaseBudget: { classify: 1, repair: 1, verify: 1 },
		estimatedCostBudgetUsd: 0.1,
		ttlSeconds: 600,
		...ACTOR,
		...extra,
	});
const permitRow = async (id: string) =>
	(
		await client.query(
			"SELECT state, phase_budget, settled_cost_usd::text, reserved_estimate_usd::text FROM sentiment_dispatch_permits WHERE id = $1",
			[id],
		)
	).rows[0];
const classifyScope = () => {
	const fp = schemaShapeFingerprint(
		prepareStructuredOutputSchema(sentimentProviderResultSchemaFor(["s0001"], ["brand"])),
	);
	return { schemaFp: fp, scopeKey: requestScopeKey(sentimentRequestProfile({ webSearch: true, schemaFp: fp })) };
};
const strike = (scopeKey: string, schemaFp: string) =>
	db.transaction((tx) =>
		openBreaker(tx, {
			scopeKey,
			profile: sentimentRequestProfile({ webSearch: true, schemaFp }),
			schemaFp,
			failureClass: "request-refused-400",
			phase: "classify",
			attemptId: null,
			httpStatus: 400,
			errorType: null,
			rule: null,
		}),
	);

describe("IT-SNT-C-010 resume permits are structurally verify-only (F-2)", () => {
	it("library, direct SQL and the manifest binding refuse a resume permit with classify or repair enabled or without its manifest", async () => {
		const lc = await lifecycleOf(run(13));
		const resume = (budget: { classify: 0 | 1; repair: 0 | 1; verify: 0 | 1 }, contractSha256: string | null) =>
			issuePermit({
				purpose: "resume-verify",
				promptRunId: run(13),
				analysisId: lc.analysisId,
				instanceId: lc.instanceId,
				inputHash: lc.inputHash,
				classifierVersion: SENTIMENT_CLASSIFIER_VERSION,
				phaseBudget: budget,
				estimatedCostBudgetUsd: 0.02,
				ttlSeconds: 600,
				contractSha256,
				...ACTOR,
			});
		await expect(resume({ classify: 1, repair: 1, verify: 1 }, "a".repeat(64))).rejects.toThrow(/verify-only|exactly/);
		await expect(resume({ classify: 0, repair: 1, verify: 1 }, "a".repeat(64))).rejects.toThrow(/exactly/);
		await expect(resume({ classify: 0, repair: 0, verify: 1 }, null)).rejects.toThrow(/manifest/);
		const sqlInsert = `INSERT INTO sentiment_dispatch_permits (purpose, prompt_run_id, analysis_id, instance_id, input_hash, classifier_version, provider, model, phase_budget, estimated_cost_budget_usd, expires_at, issued_by, reason, correlation_id, contract_sha256)
			VALUES ('resume-verify', $1, $2, gen_random_uuid(), 'h', 'v5', 'openrouter', 'm', $3::jsonb, 0.02, now() + interval '1 hour', 'it', 'r', 'c', $4)`;
		await expectRejected(
			sqlInsert,
			[run(13), lc.analysisId, '{"classify":1,"repair":0,"verify":1}', "a".repeat(64)],
			["23514"],
		);
		await expectRejected(
			sqlInsert,
			[run(13), lc.analysisId, '{"classify":0,"repair":1,"verify":1}', "a".repeat(64)],
			["23514"],
		);
		await expectRejected(sqlInsert, [run(13), lc.analysisId, '{"classify":0,"repair":0,"verify":1}', null], ["23514"]);
		// The exact verify-only contract with its manifest hash is accepted by the CHECK (and stays valid once consumed to 0).
		await client.query(sqlInsert, [run(13), lc.analysisId, '{"classify":0,"repair":0,"verify":1}', "a".repeat(64)]);
		await client.query(
			'UPDATE sentiment_dispatch_permits SET phase_budget = \'{"classify":0,"repair":0,"verify":0}\' WHERE analysis_id = $1',
			[lc.analysisId],
		);
		await client.query("DELETE FROM sentiment_dispatch_permits WHERE analysis_id = $1", [lc.analysisId]);
	});
});

describe("IT-SNT-C-011 unknown paid cost keeps its reservation counted (F-3)", () => {
	it("a priced $0.05 classify and an unpriced classify both leave exactly one verify's worth of planning budget refused", async () => {
		await setDispatch("held");
		// Known cost 0.05 against a 0.06 budget: the verify reservation (0.02) is refused.
		const a = await lifecycleOf(run(14));
		const pa = await canaryPermit(run(14), a, { estimatedCostBudgetUsd: 0.06 });
		const sa = scripted([
			{ phase: "classify", answer: { entities: [brandOk] }, costUsd: 0.05 },
			{ phase: "verify", answer: ACCEPT },
		]);
		expect(await runSentimentJob(payload(run(14)), { resolveProvider: () => sa.provider })).toMatchObject({
			status: "held",
			reason: "permit-unavailable",
		});
		expect(sa.script.calls).toEqual(["classify"]);
		expect(await permitRow(pa.id)).toMatchObject({ settled_cost_usd: "0.050000", reserved_estimate_usd: "0.000000" });
		// Unknown cost against the same budget: the 0.05 classify reservation stays counted, so the verify is refused too.
		const b = await lifecycleOf(run(15));
		const pb = await canaryPermit(run(15), b, { estimatedCostBudgetUsd: 0.06 });
		const sb = scripted([
			{ phase: "classify", answer: { entities: [brandOk] }, costUsd: null },
			{ phase: "verify", answer: ACCEPT },
		]);
		expect(await runSentimentJob(payload(run(15)), { resolveProvider: () => sb.provider })).toMatchObject({
			status: "held",
			reason: "permit-unavailable",
		});
		expect(sb.script.calls).toEqual(["classify"]);
		expect(await permitRow(pb.id)).toMatchObject({ settled_cost_usd: "0.000000", reserved_estimate_usd: "0.050000" });
		expect((await attemptsOf(run(15)))[0]).toMatchObject({ phase: "classify", outcome: "accepted" });
		// A known-unpaid refusal releases its reservation (known $0), so the next phase is not blocked by it.
		const c = await lifecycleOf(run(16));
		const pc = await canaryPermit(run(16), c, { estimatedCostBudgetUsd: 0.06 });
		const sc = scripted([{ phase: "classify", error: refusal(422, "invalid") }]);
		await runSentimentJob(payload(run(16)), { resolveProvider: () => sc.provider });
		expect(await permitRow(pc.id)).toMatchObject({ settled_cost_usd: "0.000000", reserved_estimate_usd: "0.000000" });
	});
});

describe("IT-SNT-C-012 concurrent breaker strikes are never lost (F-4)", () => {
	it("two strikes from zero → 2 and ~30 min; eight racers → 8; one strike → 15 min; the cap holds at 6 h", async () => {
		const { scopeKey, schemaFp } = classifyScope();
		const row = async () =>
			(
				await client.query(
					"SELECT state, consecutive_failures, round(extract(epoch from (open_until - now())) / 60) AS open_minutes FROM sentiment_provider_breakers WHERE scope_key = $1",
					[scopeKey],
				)
			).rows[0];
		await client.query("DELETE FROM sentiment_provider_breakers WHERE scope_key = $1", [scopeKey]);
		await client.query("DELETE FROM sentiment_control_events WHERE subject_kind = 'breaker' AND subject_key = $1", [
			scopeKey,
		]);
		await Promise.all([strike(scopeKey, schemaFp), strike(scopeKey, schemaFp)]);
		let r = await row();
		expect(r).toMatchObject({ state: "open", consecutive_failures: 2 });
		expect(Number(r.open_minutes)).toBeGreaterThanOrEqual(29);
		expect(Number(r.open_minutes)).toBeLessThanOrEqual(31);
		let events = await listControlEvents("breaker", scopeKey);
		expect(events.map((e) => e.seq)).toEqual([1, 2]);
		expect(events.map((e) => (e.evidence as { consecutiveFailures: number }).consecutiveFailures).sort()).toEqual([
			1, 2,
		]);

		await client.query("DELETE FROM sentiment_provider_breakers WHERE scope_key = $1", [scopeKey]);
		await client.query("DELETE FROM sentiment_control_events WHERE subject_kind = 'breaker' AND subject_key = $1", [
			scopeKey,
		]);
		await Promise.all(Array.from({ length: 8 }, () => strike(scopeKey, schemaFp)));
		r = await row();
		expect(r.consecutive_failures).toBe(8);
		events = await listControlEvents("breaker", scopeKey);
		expect(events.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);

		await client.query("DELETE FROM sentiment_provider_breakers WHERE scope_key = $1", [scopeKey]);
		await strike(scopeKey, schemaFp);
		r = await row();
		expect(r).toMatchObject({ state: "open", consecutive_failures: 1 });
		expect(Number(r.open_minutes)).toBeGreaterThanOrEqual(14);
		expect(Number(r.open_minutes)).toBeLessThanOrEqual(15);

		await client.query("UPDATE sentiment_provider_breakers SET consecutive_failures = 30 WHERE scope_key = $1", [
			scopeKey,
		]);
		await strike(scopeKey, schemaFp);
		r = await row();
		expect(r.consecutive_failures).toBe(31);
		expect(Number(r.open_minutes)).toBeGreaterThanOrEqual(359);
		expect(Number(r.open_minutes)).toBeLessThanOrEqual(360);
		await client.query("DELETE FROM sentiment_provider_breakers WHERE scope_key = $1", [scopeKey]);
	});
});

describe("IT-SNT-C-013 the provider boundary re-authorizes from the database (F-5)", () => {
	const pauseAfterT1 = (fn: () => Promise<void>) => {
		let once = false;
		const hook: typeof loadAttemptDispatch = async (id, ex) => {
			if (!once) {
				once = true;
				await fn();
			}
			return loadAttemptDispatch(id, ex);
		};
		return { loadAttemptDispatch: hook };
	};

	it("a breaker committed open between T1 and the guard: zero calls, the attempt is a known-unpaid abort, the case parks until open_until", async () => {
		await setDispatch("open");
		const { scopeKey, schemaFp } = classifyScope();
		await client.query("DELETE FROM sentiment_provider_breakers WHERE scope_key = $1", [scopeKey]);
		const { provider, script } = scripted([
			{ phase: "classify", answer: { entities: [brandOk] } },
			{ phase: "verify", answer: ACCEPT },
		]);
		const outcome = await runSentimentJob(payload(run(17)), {
			resolveProvider: () => provider,
			dispatch: pauseAfterT1(async () => {
				await strike(scopeKey, schemaFp);
			}),
		});
		expect(script.calls).toEqual([]);
		expect(outcome).toMatchObject({ status: "held", reason: "breaker-open" });
		expect((outcome as { nextAttemptAt: Date | null }).nextAttemptAt).toBeInstanceOf(Date);
		const attempts = await attemptsOf(run(17));
		expect(attempts.map((a) => `${a.phase}:${a.outcome}`)).toEqual(["classify:aborted"]);
		const kase = await caseOf(run(17));
		expect(kase).toMatchObject({ status: "retry_wait" });
		expect(new Date(kase.next_attempt_at).getTime()).toBeGreaterThan(Date.now() + 10 * 60_000);
		expect((await analysisOf(run(17))).error_code).toBe("breaker-open");
		await client.query("DELETE FROM sentiment_provider_breakers WHERE scope_key = $1", [scopeKey]);
	});

	it("a permit revoked or expired between T1 and the guard is refused with zero calls, the reservation released", async () => {
		await setDispatch("held");
		for (const mode of ["revoke", "expire"] as const) {
			const i = mode === "revoke" ? 18 : 19;
			const lc = await lifecycleOf(run(i));
			const permit = await canaryPermit(run(i), lc);
			const { provider, script } = scripted([{ phase: "classify", answer: { entities: [brandOk] } }]);
			const outcome = await runSentimentJob(payload(run(i)), {
				resolveProvider: () => provider,
				dispatch: pauseAfterT1(async () => {
					if (mode === "revoke") await revokePermit({ permitId: permit.id, ...ACTOR });
					else
						await client.query(
							"UPDATE sentiment_dispatch_permits SET expires_at = now() - interval '1 second' WHERE id = $1",
							[permit.id],
						);
				}),
			});
			expect(script.calls, mode).toEqual([]);
			expect(outcome).toMatchObject({ status: "held", reason: "dispatch-held" });
			expect((await attemptsOf(run(i))).map((a) => `${a.phase}:${a.outcome}`)).toEqual(["classify:aborted"]);
			// The consumed phase stays consumed (never refunded), the reservation of the aborted call is released.
			expect(await permitRow(permit.id)).toMatchObject({
				reserved_estimate_usd: "0.000000",
				phase_budget: { classify: 0, repair: 1, verify: 1 },
			});
			expect((await analysisOf(run(i))).error_code).toBe("gate-breach:permit-ineligible");
		}
	});

	it("dispatch held between T1 and the guard without a permit is refused (the last-line hold check)", async () => {
		await setDispatch("open");
		const { provider, script } = scripted([{ phase: "classify", answer: { entities: [brandOk] } }]);
		const outcome = await runSentimentJob(payload(run(20)), {
			resolveProvider: () => provider,
			dispatch: pauseAfterT1(async () => {
				await setDispatch("held");
			}),
		});
		expect(script.calls).toEqual([]);
		expect(outcome).toMatchObject({ status: "held", reason: "dispatch-held" });
		expect((await attemptsOf(run(20))).map((a) => `${a.phase}:${a.outcome}`)).toEqual(["classify:aborted"]);
		expect((await analysisOf(run(20))).error_code).toBe("gate-breach:held-without-permit");
		await setDispatch("open");
	});

	it("durable attempt evidence that no longer matches the request is refused", async () => {
		await setDispatch("open");
		for (const column of ["scope_key", "schema_fp"] as const) {
			const i = column === "scope_key" ? 21 : 22;
			const { provider, script } = scripted([{ phase: "classify", answer: { entities: [brandOk] } }]);
			let attemptId = "";
			const outcome = await runSentimentJob(payload(run(i)), {
				resolveProvider: () => provider,
				dispatch: {
					loadAttemptDispatch: (async (id: string, ex?: Parameters<typeof loadAttemptDispatch>[1]) => {
						if (!attemptId) {
							attemptId = id;
							await client.query(`UPDATE sentiment_provider_attempts SET ${column} = $2 WHERE id = $1`, [
								id,
								`${column === "scope_key" ? "rp1" : "sfp1"}:${"0".repeat(64)}`,
							]);
						}
						return loadAttemptDispatch(id, ex);
					}) as typeof loadAttemptDispatch,
				},
			});
			expect(script.calls, column).toEqual([]);
			expect(outcome).toMatchObject({ status: "held", reason: "dispatch-held" });
			expect((await analysisOf(run(i))).error_code).toBe("gate-breach:attempt-evidence-mismatch");
		}
	});

	it("a permit that expires by the database clock between two phases is refused before any attempt row exists", async () => {
		await setDispatch("held");
		const lc = await lifecycleOf(run(23));
		const permit = await canaryPermit(run(23), lc);
		const { provider, script } = scripted([
			{ phase: "classify", answer: { entities: [brandOk] } },
			{ phase: "verify", answer: ACCEPT },
		]);
		const outcome = await runSentimentJob(payload(run(23)), {
			resolveProvider: () => provider,
			// Between classify and verify (the second dispatch), the permit's expiry passes.
			dispatch: {
				readBreaker: async (scopeKey, ex) => {
					if (script.calls.length === 1) {
						await client.query(
							"UPDATE sentiment_dispatch_permits SET expires_at = now() - interval '1 second' WHERE id = $1",
							[permit.id],
						);
					}
					return readBreaker(scopeKey, ex);
				},
			},
		});
		expect(script.calls).toEqual(["classify"]);
		expect(outcome).toMatchObject({ status: "held", reason: "permit-unavailable" });
		// T1 refused: no verify attempt row at all (a guard refusal would have left an aborted row).
		expect((await attemptsOf(run(23))).map((a) => `${a.phase}:${a.outcome}`)).toEqual(["classify:accepted"]);
		expect((await analysisOf(run(23))).error_code).toBe("permit-expired");
	});
});

describe("IT-SNT-C-014 live means live by the database clock (F-7)", () => {
	it("an expired permit is not listed live, is reported with its stored state and effective=false, and is expired durably by the next mutating path", async () => {
		await setDispatch("held");
		const lc = await lifecycleOf(run(24));
		const permit = await canaryPermit(run(24), lc);
		expect((await listPermits({ analysisId: lc.analysisId, live: true })).map((p) => p.id)).toEqual([permit.id]);
		await client.query("UPDATE sentiment_dispatch_permits SET expires_at = now() - interval '1 second' WHERE id = $1", [
			permit.id,
		]);
		expect(await listPermits({ analysisId: lc.analysisId, live: true })).toEqual([]);
		const listed = await listPermits({ analysisId: lc.analysisId });
		expect(listed.map((p) => `${p.state}:${p.effective}`)).toEqual(["issued:false"]);
		// The reads did not rewrite the row. The job observes the expired permit at the execution gate, authorizes zero
		// calls and writes nothing: the stored row stays `issued` (ineffective by the database clock, one `issued` event),
		// because the only paths that transition it durably are the committed issue, replacement and resume-apply paths.
		const { provider, script } = scripted([{ phase: "classify", answer: { entities: [brandOk] } }]);
		expect(await runSentimentJob(payload(run(24)), { resolveProvider: () => provider })).toMatchObject({
			status: "held",
			reason: "dispatch-held",
		});
		expect(script.calls).toEqual([]);
		expect(await attemptsOf(run(24))).toEqual([]);
		expect(await permitRow(permit.id)).toMatchObject({ state: "issued" });
		expect((await listPermits({ analysisId: lc.analysisId })).map((p) => `${p.state}:${p.effective}`)).toEqual([
			"issued:false",
		]);
		expect((await listControlEvents("permit", permit.id)).map((e) => e.toState)).toEqual(["issued"]);
		// A replacement can be issued: the stale permit is expired in the same transaction, one event, and the index is free.
		const next = await canaryPermit(run(24), lc);
		expect((await permitRow(permit.id)).state).toBe("expired");
		expect((await listControlEvents("permit", permit.id)).map((e) => `${e.fromState}->${e.toState}`)).toEqual([
			"null->issued",
			"issued->expired",
		]);
		expect((await listPermits({ analysisId: lc.analysisId, live: true })).map((p) => p.id)).toEqual([next.id]);
	});

	it("a permit whose verify budget is spent does not qualify a review case for rediscovery", async () => {
		await setDispatch("held");
		const lc = await lifecycleOf(run(25));
		await client.query(
			"UPDATE sentiment_resolution_cases SET status = 'awaiting_review', review_reason = 'contract-defect' WHERE analysis_id = $1",
			[lc.analysisId],
		);
		await client.query("UPDATE sentiment_analyses SET status = 'pending_resolution' WHERE id = $1", [lc.analysisId]);
		const permit = await canaryPermit(run(25), lc, { phaseBudget: { classify: 1, repair: 0, verify: 0 } });
		expect(permitAllowsVerify(permit)).toBe(false);
		expect(permitAllowsVerify({ phaseBudget: { classify: 0, repair: 0, verify: 1 } })).toBe(true);
		expect(permitAllowsVerify({ phaseBudget: {} })).toBe(false);
		await setDispatch("open");
		expect((await listResumableSentimentRuns(1000)).map((r) => r.promptRunId)).not.toContain(run(25));
		await setDispatch("held");
	});
});

describe("IT-SNT-C-016 an expired permit with an unresolved attempt is never replaced (CR-N1)", () => {
	it("issuing again is refused as permit-unresolved-attempt: no replacement, no expiry transition, no expiry event; without the attempt the same row is expired once, audited once and replaced once", async () => {
		await setDispatch("held");
		const lc = await lifecycleOf(run(28));
		const permit = await canaryPermit(run(28), lc);
		// Production never leaves an `issued` permit with an attempt (consumption sets `active` in the same transaction);
		// the row is constructed by hand so the lookup itself is what refuses, not the consumed-phase branch.
		const attempt = await client.query<{ id: string }>(
			`INSERT INTO sentiment_provider_attempts (analysis_id, instance_id, ordinal, phase, provider, model, input_hash, outcome, permit_id)
			 VALUES ($1, $2, 1, 'classify', 'openrouter', $3, $4, 'sending', $5) RETURNING id`,
			[lc.analysisId, lc.instanceId, SENTIMENT_MODEL, lc.inputHash, permit.id],
		);
		await client.query("UPDATE sentiment_dispatch_permits SET expires_at = now() - interval '1 second' WHERE id = $1", [
			permit.id,
		]);
		await expect(canaryPermit(run(28), lc)).rejects.toMatchObject({
			name: "PermitConflictError",
			code: "permit-unresolved-attempt",
			permitId: permit.id,
		});
		expect((await listPermits({ analysisId: lc.analysisId })).map((p) => `${p.state}:${p.effective}`)).toEqual([
			"issued:false",
		]);
		expect((await listControlEvents("permit", permit.id)).map((e) => e.toState)).toEqual(["issued"]);
		// The adjacent behaviour is unchanged: once the attempt is resolved, the expired unconsumed permit is expired
		// exactly once, audited exactly once and replaced exactly once.
		await client.query("DELETE FROM sentiment_provider_attempts WHERE id = $1", [attempt.rows[0].id]);
		const next = await canaryPermit(run(28), lc);
		expect(await permitRow(permit.id)).toMatchObject({ state: "expired" });
		expect((await listControlEvents("permit", permit.id)).map((e) => `${e.fromState}->${e.toState}`)).toEqual([
			"null->issued",
			"issued->expired",
		]);
		expect((await listPermits({ analysisId: lc.analysisId })).map((p) => `${p.state}:${p.effective}`).sort()).toEqual([
			"expired:false",
			"issued:true",
		]);
		expect((await listPermits({ analysisId: lc.analysisId, live: true })).map((p) => p.id)).toEqual([next.id]);
		await expect(canaryPermit(run(28), lc)).rejects.toMatchObject({ code: "permit-live", permitId: next.id });
		expect(await listControlEvents("permit", permit.id)).toHaveLength(2);
	});
});

describe("IT-SNT-C-015 the canary entry point under a held dispatch (Amendment C)", () => {
	const fast = { deadlineMs: 5_000, watchdogMs: 10_000 };
	it("with a valid canary permit the canary reaches exactly its allowed phases; without one it makes zero calls; phase, call, estimate and expiry evidence reconcile", async () => {
		const {
			inspectSentimentCanaryRun,
			inspectSentimentCanaryRunState,
			parseSentimentCanaryContract,
			runSentimentCanary,
		} = await import("@workspace/lib/sentiment");
		await setDispatch("held");
		// Permitted: the operator surface creates the pending analysis and the case instance, then issues the permit.
		const lc = await lifecycleOf(run(26));
		expect(await inspectSentimentCanaryRunState(run(26))).toMatchObject({ pristine: true });
		const contract = parseSentimentCanaryContract(await inspectSentimentCanaryRun(run(26)));
		const permit = await canaryPermit(run(26), lc, { contractSha256: "c".repeat(64), ttlSeconds: 1800 });
		const { provider, script } = scripted([
			{ phase: "classify", answer: { entities: [brandOk] } },
			{ phase: "verify", answer: ACCEPT },
		]);
		const report = await runSentimentCanary({ contract, deps: { resolveProvider: () => provider }, ...fast });
		expect(script.calls).toEqual(["classify", "verify"]);
		expect(report.outcome).toMatchObject({ status: "classified", paidCalls: 2 });
		expect(report.verdict).toEqual({ status: "accept" });
		expect(report.providerCalls).toBe(2);
		const attempts = await attemptsOf(run(26));
		expect(attempts.map((a) => `${a.phase}:${a.outcome}:${a.permit_id === permit.id}`)).toEqual([
			"classify:accepted:true",
			"verify:accepted:true",
		]);
		const settled = await permitRow(permit.id);
		expect(settled).toMatchObject({ state: "active", phase_budget: { classify: 0, repair: 1, verify: 0 } });
		expect(Number(settled.settled_cost_usd)).toBeCloseTo(0.04, 6);
		expect(Number(settled.reserved_estimate_usd)).toBe(0);
		expect((await listPermits({ analysisId: lc.analysisId, live: true })).map((p) => p.id)).toEqual([permit.id]);
		expect(await analysisOf(run(26))).toMatchObject({ status: "completed" });

		// Unpermitted: the same entry point under HELD makes no request and leaves the run pristine.
		await runSentimentJob(payload(run(27)), { resolveProvider: () => scripted([]).provider });
		const bare = parseSentimentCanaryContract(await inspectSentimentCanaryRun(run(27)));
		const unpermitted = scripted([{ phase: "classify", answer: { entities: [brandOk] } }]);
		const refused = await runSentimentCanary({
			contract: bare,
			deps: { resolveProvider: () => unpermitted.provider },
			...fast,
		});
		expect(unpermitted.script.calls).toEqual([]);
		expect(refused.outcome).toMatchObject({ status: "held" });
		expect(refused.verdict).toMatchObject({ status: "reject" });
		expect(refused.providerCalls).toBe(0);
		expect(await attemptsOf(run(27))).toEqual([]);
		expect(await inspectSentimentCanaryRunState(run(27))).toMatchObject({ pristine: true });
	});
});
