/**
 * Real-Postgres proof of the alert evaluator, baselines, acknowledgement and
 * the maintenance heartbeat (ADR-SENT-01 Amendment D). Runs against the seeded
 * disposable stack (`pnpm --filter web test:integration` with DATABASE_URL);
 * every row it needs is inserted directly, no provider is ever reached, and
 * the fetch spy proves it.
 */
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must point at the seeded test stack");

const {
	SENTIMENT_CLASSIFIER_VERSION,
	SENTIMENT_MODEL,
	SENTIMENT_TAXONOMY_VERSION,
	acknowledgeSentimentAlert,
	buildSentimentStatusReport,
	evaluateSentimentAlerts,
	issuePermit,
	listAlertStates,
	listControlEvents,
	MAINTENANCE_HEARTBEAT_KEY,
	readDispatchState,
	readMaintenanceHeartbeat,
	requestScopeKey,
	runMaintenanceTick,
	sentimentRequestProfile,
	statusExitCode,
	transitionDispatch,
} = await import("@workspace/lib/sentiment");
type SentimentAlertRecord = import("@workspace/lib/sentiment").SentimentAlertRecord;
const { openBreaker } = await import("../../../../../packages/lib/src/sentiment/breaker");
const { db } = await import("@workspace/lib/db/db");

const ORG = "default";
const BRAND = "sent-d-alerts-brand";
const PROMPT = "5e97000f-0000-4000-8000-000000000101";
const run = (i: number) => `5e97000f-0000-4000-8000-0000000002${String(i).padStart(2, "0")}`;
const ACTOR = { actor: "it:alerts", reason: "integration test", correlationId: "IT-SNT-D" };
const client = new pg.Client({ connectionString: DATABASE_URL });

async function insertRun(id: string) {
	await client.query(
		`INSERT INTO prompt_runs (id, prompt_id, brand_id, model, provider, version, web_search_enabled, raw_output, brand_mentioned, competitors_mentioned, created_at)
		 VALUES ($1, $2, $3, 'chatgpt', 'openrouter', 'v', true, '{"choices":[{"message":{"content":"x"}}]}', true, '{}', now() - interval '1 hour')`,
		[id, PROMPT, BRAND],
	);
}
/** A v5 analysis parked for resolution with a case in the given status (inserted directly: no job, no provider). */
async function lifecycle(
	i: number,
	caseStatus: string,
	reviewReason: string | null = null,
	opts: { analysisStatus?: string; errorCode?: string | null; errorMessage?: string | null } = {},
) {
	const analysis = await client.query<{ id: string }>(
		`INSERT INTO sentiment_analyses (prompt_run_id, brand_id, classifier_version, taxonomy_version, input_hash, status, error_code, error_message)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
		[
			run(i),
			BRAND,
			SENTIMENT_CLASSIFIER_VERSION,
			SENTIMENT_TAXONOMY_VERSION,
			`h-${i}`,
			opts.analysisStatus ?? "pending_resolution",
			opts.errorCode ?? null,
			opts.errorMessage ?? null,
		],
	);
	const kase = await client.query<{ instance_id: string }>(
		`INSERT INTO sentiment_resolution_cases (analysis_id, input_hash, status, review_reason) VALUES ($1, $2, $3, $4) RETURNING instance_id`,
		[analysis.rows[0].id, `h-${i}`, caseStatus, reviewReason],
	);
	return {
		analysisId: analysis.rows[0].id,
		instanceId: kase.rows[0].instance_id,
		inputHash: `h-${i}`,
		promptRunId: run(i),
	};
}
async function attempt(
	analysisId: string,
	instanceId: string,
	inputHash: string,
	outcome: string,
	phase = "classify",
	ordinal = 1,
) {
	const row = await client.query<{ id: string }>(
		`INSERT INTO sentiment_provider_attempts (analysis_id, instance_id, ordinal, phase, provider, model, input_hash, outcome, finished_at)
		 VALUES ($1, $2, $3, $4, 'openrouter', $5, $6, $7, now()) RETURNING id`,
		[analysisId, instanceId, ordinal, phase, SENTIMENT_MODEL, inputHash, outcome],
	);
	return row.rows[0].id;
}
const alertRows = async () =>
	(
		await client.query(
			"SELECT signal, baseline, watermark, evaluated_at, last_alerted_at, cooldown_until FROM sentiment_alert_state ORDER BY signal",
		)
	).rows;
const alertRow = async (key: string) => (await alertRows()).find((r) => r.signal === key);
const eventsOf = async (key: string) =>
	(await listControlEvents("alert", key)).map((e) => `${e.fromState ?? "null"}->${e.toState}`);
async function resetAlertState() {
	await client.query("DELETE FROM sentiment_alert_state");
	await client.query("DELETE FROM sentiment_control_events WHERE subject_kind = 'alert'");
}
async function cleanup() {
	await client.query(
		"DELETE FROM sentiment_dispatch_permits WHERE analysis_id IN (SELECT id FROM sentiment_analyses WHERE brand_id = $1)",
		[BRAND],
	);
	await client.query("DELETE FROM prompt_runs WHERE brand_id = $1", [BRAND]);
	await client.query("DELETE FROM prompts WHERE brand_id = $1", [BRAND]);
	await client.query("DELETE FROM brands WHERE id = $1", [BRAND]);
	await client.query("DELETE FROM sentiment_provider_breakers WHERE scope_key LIKE 'rp1:%'");
	await client.query("DELETE FROM sentiment_control_events WHERE subject_kind IN ('breaker','permit','alert')");
	await client.query("DELETE FROM sentiment_alert_state");
}
async function setDispatch(to: "held" | "open") {
	const current = await readDispatchState();
	if (current.state === to) return;
	const moved = await transitionDispatch({ to, expected: current.state, ...ACTOR });
	if (!moved.ok) throw new Error(`could not move dispatch to ${to}`);
}
function sink() {
	const records: SentimentAlertRecord[] = [];
	return { records, notify: (r: SentimentAlertRecord) => void records.push(r) };
}
/** Digest of every dispatch-control row the evaluator must never touch. */
async function controlDigest(): Promise<string> {
	const { rows } = await client.query(
		`SELECT md5(string_agg(t, '|' ORDER BY t)) AS d FROM (
			SELECT 'c:' || key || ':' || state || ':' || epoch AS t FROM sentiment_controls
			UNION ALL SELECT 'b:' || scope_key || ':' || state || ':' || consecutive_failures || ':' || coalesce(open_until::text,'') FROM sentiment_provider_breakers
			UNION ALL SELECT 'p:' || id || ':' || state || ':' || phase_budget::text || ':' || reserved_estimate_usd::text || ':' || settled_cost_usd::text FROM sentiment_dispatch_permits
			UNION ALL SELECT 'a:' || id || ':' || outcome || ':' || coalesce(actual_cost_usd::text,'') FROM sentiment_provider_attempts
			UNION ALL SELECT 'k:' || analysis_id || ':' || status || ':' || coalesce(review_reason,'') || ':' || total_actual_cost_usd::text FROM sentiment_resolution_cases
			UNION ALL SELECT 'e:' || id::text FROM sentiment_control_events WHERE subject_kind <> 'alert') s`,
	);
	return rows[0].d ?? "empty";
}

beforeAll(async () => {
	const host = new URL(DATABASE_URL).hostname;
	if (!["localhost", "127.0.0.1", "::1"].includes(host)) throw new Error(`refusing non-loopback database ${host}`);
	await client.connect();
	const org = await client.query("SELECT id FROM organization WHERE slug = $1", [ORG]);
	if (org.rows.length !== 1) throw new Error("seeded organization missing — not the disposable test database");
	await cleanup();
	await client.query(
		`INSERT INTO brands (id, organization_id, slug, name, website, enabled, onboarded, created_at, updated_at) VALUES ($1, $2, $1, 'Sent D Alerts', 'https://sent-d-alerts.example.test/', true, true, now(), now())`,
		[BRAND, org.rows[0].id],
	);
	await client.query(
		`INSERT INTO prompts (id, brand_id, value, enabled, tags, system_tags, created_at, updated_at) VALUES ($1, $2, 'alerts prompt', false, '{}', '{unbranded}', now(), now())`,
		[PROMPT, BRAND],
	);
	for (let i = 1; i <= 60; i++) await insertRun(run(i));
	await setDispatch("held");
});

afterAll(async () => {
	await setDispatch("open");
	await cleanup();
	await client.end();
});

const fetchSpy = vi.fn(() => {
	throw new Error("the alert evaluator must never reach the network");
});
beforeEach(() => {
	vi.stubGlobal("fetch", fetchSpy);
	fetchSpy.mockClear();
});

describe("IT-SNT-D-001 baselines are derived from existing rows under a held dispatch (R9)", () => {
	it("a fresh database captures an empty exact baseline, audited once, and raises nothing", async () => {
		await resetAlertState();
		await client.query("DELETE FROM sentiment_analyses WHERE brand_id = $1", [BRAND]);
		const s = sink();
		const result = await evaluateSentimentAlerts({ notify: s.notify });
		expect(result.held).toBe(true);
		expect(result.baseline.captured.sort()).toEqual(["awaiting-review-growth", "first-contract-defect"]);
		expect(result.evaluatedSignals).toHaveLength(10);
		expect(result.raised).toEqual([]);
		expect(s.records).toEqual([]);
		expect((await alertRow("awaiting-review-growth"))?.baseline).toMatchObject({ mode: "exact", ids: [], count: 0 });
		expect(await eventsOf("awaiting-review-growth")).toEqual(["null->baseline-captured"]);
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("an open dispatch without a baseline skips the growth signals instead of inventing one", async () => {
		await resetAlertState();
		await setDispatch("open");
		try {
			const result = await evaluateSentimentAlerts({ notify: sink().notify });
			expect(result.held).toBe(false);
			expect(result.baseline.captured).toEqual([]);
			expect(result.baseline.missing.sort()).toEqual(["awaiting-review-growth", "first-contract-defect"]);
			expect(await alertRow("awaiting-review-growth")).toBeUndefined();
		} finally {
			await setDispatch("held");
		}
	});

	it("the first held tick captures the existing id sets transactionally — never a literal count", async () => {
		await resetAlertState();
		const parked = [];
		for (let i = 1; i <= 7; i++)
			parked.push(await lifecycle(i, "awaiting_review", i <= 3 ? "contract-defect" : "call-limit"));
		const result = await evaluateSentimentAlerts({ notify: sink().notify });
		expect(result.baseline.captured).toHaveLength(2);
		const growth = await alertRow("awaiting-review-growth");
		expect(growth?.baseline).toMatchObject({ mode: "exact", count: 7 });
		expect([...(growth?.baseline.ids ?? [])].sort()).toEqual(parked.map((p) => p.analysisId).sort());
		expect((await alertRow("first-contract-defect"))?.baseline).toMatchObject({ count: 3 });
		expect(result.raised).toEqual([]);
		// The second tick finds the baseline present and captures nothing again.
		const again = await evaluateSentimentAlerts({ notify: sink().notify });
		expect(again.baseline.captured).toEqual([]);
		expect(again.baseline.present.sort()).toEqual(["awaiting-review-growth", "first-contract-defect"]);
		expect(await eventsOf("awaiting-review-growth")).toEqual(["null->baseline-captured"]);
	});

	it("eight concurrent first ticks converge on one baseline with one audit event each", async () => {
		await resetAlertState();
		const results = await Promise.all(
			Array.from({ length: 8 }, () => evaluateSentimentAlerts({ notify: sink().notify })),
		);
		expect(results.filter((r) => r.baseline.captured.includes("awaiting-review-growth"))).toHaveLength(1);
		expect(results.filter((r) => r.baseline.captured.includes("first-contract-defect"))).toHaveLength(1);
		expect(await eventsOf("awaiting-review-growth")).toEqual(["null->baseline-captured"]);
		expect(await eventsOf("first-contract-defect")).toEqual(["null->baseline-captured"]);
		expect((await alertRow("awaiting-review-growth"))?.baseline.count).toBe(7);
		expect(fetchSpy).not.toHaveBeenCalled();
	});
});

describe("IT-SNT-D-002 growth, watermarks, cooldown and compare-and-set acknowledgement (D9)", () => {
	it("new unacknowledged ids fire at the D9 threshold, notify once, stay silent in cooldown, and acknowledge only the seen digest", async () => {
		// Baseline 7 → threshold min(5, ceil(0.25 x 7)) = 2.
		const before = await controlDigest();
		await lifecycle(8, "awaiting_review", "call-limit");
		let s = sink();
		let result = await evaluateSentimentAlerts({ notify: s.notify });
		expect(s.records).toEqual([]);
		expect(result.active).toBe(0);
		await lifecycle(9, "awaiting_review", "call-limit");
		s = sink();
		result = await evaluateSentimentAlerts({ notify: s.notify });
		expect(s.records.map((r) => r.signal)).toEqual(["awaiting-review-growth"]);
		const record = s.records[0];
		expect(record).toMatchObject({
			v: 1,
			kind: "sentiment-alert",
			severity: "informational",
			observed: 2,
			runbook: "RB-5",
			approximate: false,
			reason: "new-unacknowledged-cases",
		});
		expect(record.evidence).toMatchObject({ mode: "exact", newCount: 2, baselineCount: 7 });
		expect(await eventsOf("awaiting-review-growth")).toEqual(["null->baseline-captured", "quiet->raised"]);
		const row = await alertRow("awaiting-review-growth");
		expect(row.last_alerted_at).not.toBeNull();
		expect(new Date(row.cooldown_until).getTime() - new Date(row.last_alerted_at).getTime()).toBe(24 * 3600 * 1000);

		// Same state, next tick (a "restart" changes nothing: all state is in the row): persisted, active, silent.
		s = sink();
		result = await evaluateSentimentAlerts({ notify: s.notify });
		expect(s.records).toEqual([]);
		expect(result.suppressed).toBeGreaterThanOrEqual(1);
		expect(result.active).toBe(1);
		expect(await eventsOf("awaiting-review-growth")).toHaveLength(2);

		// Compare-and-set: a stale digest is refused without a write; the current one acknowledges once.
		const refused = await acknowledgeSentimentAlert({
			rowKey: "awaiting-review-growth",
			expectedDigest: "stale",
			...ACTOR,
		});
		expect(refused).toMatchObject({ acknowledged: false, reason: "digest-mismatch", currentDigest: record.digest });
		expect(await eventsOf("awaiting-review-growth")).toHaveLength(2);
		await expect(
			acknowledgeSentimentAlert({
				rowKey: "awaiting-review-growth",
				expectedDigest: record.digest,
				actor: "",
				reason: "",
				correlationId: "",
			}),
		).rejects.toThrow(/actor is required/);
		const acked = await acknowledgeSentimentAlert({
			rowKey: "awaiting-review-growth",
			expectedDigest: record.digest,
			...ACTOR,
		});
		expect(acked).toMatchObject({ acknowledged: true, mode: "exact" });
		expect(
			await acknowledgeSentimentAlert({ rowKey: "awaiting-review-growth", expectedDigest: record.digest, ...ACTOR }),
		).toMatchObject({ acknowledged: false, reason: "already-acknowledged" });
		expect(await eventsOf("awaiting-review-growth")).toEqual([
			"null->baseline-captured",
			"quiet->raised",
			"firing->acknowledged",
		]);
		expect((await alertRow("awaiting-review-growth")).watermark.ackedIds).toHaveLength(2);

		// After acknowledgement the alert is neither active nor notified; the incident rows were never touched.
		s = sink();
		result = await evaluateSentimentAlerts({ notify: s.notify });
		expect(s.records).toEqual([]);
		expect((await listAlertStates()).find((a) => a.rowKey === "awaiting-review-growth")).toMatchObject({
			active: false,
			firing: false,
			acknowledged: false,
			cooling: true,
		});
		expect(await controlDigest()).not.toBe(before); // the fixture inserts changed the incident rows …
		const afterAck = await controlDigest();
		await evaluateSentimentAlerts({ notify: sink().notify });
		expect(await controlDigest()).toBe(afterAck); // … but evaluation and acknowledgement changed none of them.
	});

	it("a new contract-defect case outside the baseline raises the urgent first-contract-defect once (6 h cooldown)", async () => {
		await lifecycle(10, "awaiting_review", "contract-defect");
		const s = sink();
		await evaluateSentimentAlerts({ notify: s.notify });
		const first = s.records.find((r) => r.signal === "first-contract-defect");
		expect(first).toMatchObject({ severity: "urgent", observed: 1, runbook: "RB-1" });
		expect(first?.evidence).toMatchObject({ newCount: 1, baselineCount: 3 });
		const row = await alertRow("first-contract-defect");
		expect(new Date(row.cooldown_until).getTime() - new Date(row.last_alerted_at).getTime()).toBe(6 * 3600 * 1000);
		const s2 = sink();
		await evaluateSentimentAlerts({ notify: s2.notify });
		expect(s2.records.map((r) => r.signal)).not.toContain("first-contract-defect");
	});
});

describe("IT-SNT-D-003 per-scope breaker and probe signals, and cross-shape refusals (D8, D11)", () => {
	const scopes: string[] = [];
	it("two breakers struck open in distinct scopes raise breaker-open per scope and one refusals-across-shapes", async () => {
		for (const fp of ["sfp1:aaaa", "sfp1:bbbb"]) {
			const profile = sentimentRequestProfile({ webSearch: true, schemaFp: fp });
			const scopeKey = requestScopeKey(profile);
			scopes.push(scopeKey);
			await db.transaction((tx) =>
				openBreaker(tx, {
					scopeKey,
					profile,
					schemaFp: fp,
					failureClass: "request-refused-400",
					phase: "classify",
					attemptId: null,
					httpStatus: 400,
					errorType: "invalid_request_error",
					rule: null,
				}),
			);
		}
		const s = sink();
		const result = await evaluateSentimentAlerts({ notify: s.notify });
		expect(
			s.records
				.filter((r) => r.signal === "breaker-open")
				.map((r) => r.scope)
				.sort(),
		).toEqual([...scopes].sort());
		const across = s.records.find((r) => r.signal === "refusals-across-shapes");
		expect(across).toMatchObject({ severity: "urgent", observed: 2, window: "86400s", runbook: "RB-4" });
		expect(across?.evidence).toMatchObject({ scopes: expect.arrayContaining(scopes), strikes: 2 });
		expect(result.raised.filter((r) => r.signal === "provider-refusal-config")).toEqual([]);
		// Per-scope cooldown: the same open scopes stay silent on the next tick; dispatch was never transitioned.
		const s2 = sink();
		await evaluateSentimentAlerts({ notify: s2.notify });
		expect(s2.records.filter((r) => r.signal === "breaker-open")).toEqual([]);
		expect(await readDispatchState()).toMatchObject({ state: "held" });
		for (const scope of scopes) {
			const row = await alertRow(`breaker-open|${scope}`);
			expect(new Date(row.cooldown_until).getTime() - new Date(row.last_alerted_at).getTime()).toBe(3600 * 1000);
		}
	});

	it("an expired probe lease and a refused probe raise probe-failed-or-expired per scope, with their reasons", async () => {
		await client.query(
			"UPDATE sentiment_provider_breakers SET state = 'half_open', probe_attempt_id = gen_random_uuid(), probe_generation = 1, probe_lease_until = now() - interval '1 second' WHERE scope_key = $1",
			[scopes[0]],
		);
		await client.query(
			`INSERT INTO sentiment_control_events (subject_kind, subject_key, seq, from_state, to_state, actor, reason, correlation_id, evidence)
			 VALUES ('breaker', $1, (SELECT coalesce(max(seq),0)+1 FROM sentiment_control_events WHERE subject_kind='breaker' AND subject_key=$1), 'half_open', 'open', 'system:dispatch-breaker', 'half-open probe refused deterministically', 'amendment-c', '{"attemptId":null,"generation":1,"consecutiveFailures":2}')`,
			[scopes[1]],
		);
		const s = sink();
		await evaluateSentimentAlerts({ notify: s.notify });
		const probes = s.records.filter((r) => r.signal === "probe-failed-or-expired");
		expect(probes.map((r) => [r.scope, r.reason]).sort()).toEqual(
			[
				[scopes[0], "probe-lease-expired"],
				[scopes[1], "probe-refused"],
			].sort(),
		);
		expect(probes.every((r) => r.severity === "urgent" && r.runbook === "RB-3")).toBe(true);
	});
});

describe("IT-SNT-D-004 provider configuration refusals and gate breaches", () => {
	it("a sanitized HTTP 401 refusal raises provider-refusal-config scoped by provider, model and status; a 400 does not", async () => {
		const a401 = await lifecycle(11, "awaiting_review", "contract-defect", {
			errorCode: "provider",
			errorMessage: `provider provider (StructuredResearchRequestError) via openrouter/${SENTIMENT_MODEL} HTTP 401`,
		});
		await attempt(a401.analysisId, a401.instanceId, a401.inputHash, "provider-error");
		const a400 = await lifecycle(12, "awaiting_review", "contract-defect", {
			errorCode: "provider",
			errorMessage: `provider provider (StructuredResearchRequestError) via openrouter/${SENTIMENT_MODEL} HTTP 400`,
		});
		await attempt(a400.analysisId, a400.instanceId, a400.inputHash, "provider-error");
		const s = sink();
		await evaluateSentimentAlerts({ notify: s.notify });
		const refusals = s.records.filter((r) => r.signal === "provider-refusal-config");
		expect(refusals).toHaveLength(1);
		expect(refusals[0]).toMatchObject({
			severity: "urgent",
			scope: `openrouter:${SENTIMENT_MODEL}:401`,
			reason: "http-401",
			runbook: "RB-10",
		});
		expect(refusals[0].evidence).toMatchObject({ provider: "openrouter", httpStatus: 401, count: 1 });
		expect(JSON.stringify(refusals[0])).not.toMatch(/StructuredResearchRequestError|Bearer|sk-/);
		const row = await alertRow(`provider-refusal-config|openrouter:${SENTIMENT_MODEL}:401`);
		expect(new Date(row.cooldown_until).getTime() - new Date(row.last_alerted_at).getTime()).toBe(6 * 3600 * 1000);
	});

	it("an analysis parked with a gate-breach code raises the urgent per-occurrence gate-breach", async () => {
		const g = await lifecycle(13, "retry_wait", null, { errorCode: "gate-breach:held-without-permit" });
		await attempt(g.analysisId, g.instanceId, g.inputHash, "aborted", "verify");
		const s = sink();
		await evaluateSentimentAlerts({ notify: s.notify });
		const breach = s.records.find((r) => r.signal === "gate-breach");
		expect(breach).toMatchObject({
			severity: "urgent",
			scope: g.analysisId,
			reason: "held-without-permit",
			runbook: "RB-8",
		});
		expect(breach?.evidence).toMatchObject({ analysisId: g.analysisId, code: "held-without-permit", phase: "verify" });
	});
});

describe("IT-SNT-D-005 permit-exhausted (Q2) and reserve-exceeded on real permit rows", () => {
	const permitFor = async (i: number, caseStatus = "open") => {
		const lc = await lifecycle(i, caseStatus);
		const permit = await issuePermit({
			purpose: "canary",
			promptRunId: lc.promptRunId,
			analysisId: lc.analysisId,
			instanceId: lc.instanceId,
			inputHash: lc.inputHash,
			classifierVersion: SENTIMENT_CLASSIFIER_VERSION,
			phaseBudget: { classify: 1, repair: 1, verify: 1 },
			estimatedCostBudgetUsd: 0.1,
			ttlSeconds: 600,
			...ACTOR,
		});
		return { lc, permit };
	};
	it("distinguishes the six Q2 cases and never fires both signals for the same cause", async () => {
		const exhaustedUnresolved = await permitFor(20);
		await client.query(
			`UPDATE sentiment_dispatch_permits SET state = 'exhausted', phase_budget = '{"classify":0,"repair":0,"verify":0}' WHERE id = $1`,
			[exhaustedUnresolved.permit.id],
		);
		const exhaustedResolved = await permitFor(21);
		await client.query(
			`UPDATE sentiment_dispatch_permits SET state = 'exhausted', phase_budget = '{"classify":0,"repair":0,"verify":0}' WHERE id = $1`,
			[exhaustedResolved.permit.id],
		);
		await client.query("UPDATE sentiment_analyses SET status = 'completed', verified_at = now() WHERE id = $1", [
			exhaustedResolved.lc.analysisId,
		]);
		const issuedExpired = await permitFor(22);
		await client.query("UPDATE sentiment_dispatch_permits SET expires_at = now() - interval '1 second' WHERE id = $1", [
			issuedExpired.permit.id,
		]);
		const activeExpired = await permitFor(23);
		await client.query(
			`UPDATE sentiment_dispatch_permits SET state = 'active', phase_budget = '{"classify":0,"repair":1,"verify":1}', expires_at = now() - interval '1 second' WHERE id = $1`,
			[activeExpired.permit.id],
		);
		const reserveOnly = await permitFor(24);
		await client.query(
			`UPDATE sentiment_dispatch_permits SET state = 'active', phase_budget = '{"classify":0,"repair":0,"verify":1}', settled_cost_usd = 0.05, reserved_estimate_usd = 0.04 WHERE id = $1`,
			[reserveOnly.permit.id],
		);
		const parkedForReview = await permitFor(25, "awaiting_review");
		await client.query(
			`UPDATE sentiment_dispatch_permits SET state = 'exhausted', phase_budget = '{"classify":0,"repair":0,"verify":0}' WHERE id = $1`,
			[parkedForReview.permit.id],
		);

		const s = sink();
		await evaluateSentimentAlerts({ notify: s.notify });
		const exhausted = s.records.filter((r) => r.signal === "permit-exhausted");
		expect(exhausted.map((r) => [r.scope, r.reason, r.severity]).sort()).toEqual(
			[
				[exhaustedUnresolved.permit.id, "phase-budget-exhausted", "urgent"],
				[activeExpired.permit.id, "active-expired-unresolved", "urgent"],
			].sort(),
		);
		const reserve = s.records.filter((r) => r.signal === "reserve-exceeded");
		expect(reserve.map((r) => r.scope)).toEqual([reserveOnly.permit.id]);
		expect(reserve[0]).toMatchObject({
			severity: "informational",
			reason: "reservation-predicate-unsatisfiable",
			runbook: "RB-11",
		});
		expect(reserve[0].note).toMatch(/planning estimates, not hard provider-price ceilings/);
		expect(reserve[0].evidence).toMatchObject({
			blockedPhases: ["verify"],
			settledCostUsd: 0.05,
			reservedEstimateUsd: 0.04,
			estimatedCostBudgetUsd: 0.1,
		});
		// The reserve-blocked permit is not exhausted; the review-parked and resolved lifecycles and the unused expired permit are silent.
		for (const silent of [reserveOnly, exhaustedResolved, issuedExpired, parkedForReview]) {
			expect(exhausted.map((r) => r.scope)).not.toContain(silent.permit.id);
		}
		// Unchanged blocking state: no second notification; a material change re-arms immediately.
		const s2 = sink();
		await evaluateSentimentAlerts({ notify: s2.notify });
		expect(s2.records.filter((r) => r.signal === "reserve-exceeded")).toEqual([]);
		await client.query("UPDATE sentiment_dispatch_permits SET settled_cost_usd = 0.06 WHERE id = $1", [
			reserveOnly.permit.id,
		]);
		const s3 = sink();
		await evaluateSentimentAlerts({ notify: s3.notify });
		expect(s3.records.filter((r) => r.signal === "reserve-exceeded").map((r) => r.scope)).toEqual([
			reserveOnly.permit.id,
		]);
	});
});

describe("IT-SNT-D-006 held-backlog-growth (D10) reads the release selector", () => {
	it("fires at 20 held items under a held dispatch only", async () => {
		for (let i = 30; i < 50; i++) {
			await client.query(
				`INSERT INTO sentiment_analyses (prompt_run_id, brand_id, classifier_version, taxonomy_version, status, attempts) VALUES ($1, $2, $3, $4, 'pending', 0)`,
				[run(i), BRAND, SENTIMENT_CLASSIFIER_VERSION, SENTIMENT_TAXONOMY_VERSION],
			);
		}
		// The selector counts every held v5 analysis in the database, so the expectation is read from the same rows.
		const { rows } = await client.query<{ n: number }>(
			"SELECT count(*)::int AS n FROM sentiment_analyses WHERE classifier_version = $1 AND status = 'pending' AND attempts = 0",
			[SENTIMENT_CLASSIFIER_VERSION],
		);
		expect(rows[0].n).toBeGreaterThanOrEqual(20);
		const s = sink();
		await evaluateSentimentAlerts({ notify: s.notify });
		const backlog = s.records.find((r) => r.signal === "held-backlog-growth");
		expect(backlog).toMatchObject({ severity: "informational", reason: "count", observed: rows[0].n, runbook: "RB-6" });
		expect(backlog?.evidence).toMatchObject({ pendingAnalyses: rows[0].n, held: true });
		await setDispatch("open");
		try {
			const s2 = sink();
			const result = await evaluateSentimentAlerts({ notify: s2.notify });
			expect(result.held).toBe(false);
			expect((await listAlertStates()).find((a) => a.rowKey === "held-backlog-growth")).toMatchObject({
				firing: false,
				active: false,
			});
		} finally {
			await setDispatch("held");
		}
	});
});

describe("IT-SNT-D-007 the maintenance heartbeat is written last and never on a partial tick", () => {
	it("a complete tick writes the heartbeat after the alert stage; a failing final stage leaves the previous heartbeat unchanged", async () => {
		await client.query("DELETE FROM sentiment_alert_state WHERE signal = $1", [MAINTENANCE_HEARTBEAT_KEY]);
		expect(await readMaintenanceHeartbeat()).toMatchObject({ present: false, stale: true });
		let alertsEvaluatedAt: string | null = null;
		const tick = (finalFails: boolean) =>
			runMaintenanceTick({
				heartbeat: { workerBootId: "boot-it", source: "it", alerts: null },
				stages: [
					{ name: "prompt-schedule", onError: "throw", run: async () => {} },
					{
						name: "sentiment-alerts",
						onError: "record",
						run: async () => {
							alertsEvaluatedAt = (await evaluateSentimentAlerts({ notify: sink().notify })).evaluatedAt;
						},
					},
					{
						name: "final",
						onError: "record",
						run: async () => {
							if (finalFails) throw new Error("deliberate final-stage failure");
						},
					},
				],
			});
		const first = await tick(false);
		expect(first.heartbeatWritten).toBe(true);
		const hb1 = await readMaintenanceHeartbeat();
		expect(hb1).toMatchObject({ present: true, stale: false });
		expect(hb1.heartbeat).toMatchObject({ v: 1, workerBootId: "boot-it", source: "it" });
		expect(hb1.heartbeat?.stages.map((s) => s.name)).toEqual(["prompt-schedule", "sentiment-alerts", "final"]);
		expect(new Date(hb1.evaluatedAt as string).getTime()).toBeGreaterThanOrEqual(
			new Date(alertsEvaluatedAt as unknown as string).getTime(),
		);

		const second = await tick(true);
		expect(second.heartbeatWritten).toBe(false);
		expect(second.stages.at(-1)).toMatchObject({ name: "final", ok: false, errorName: "Error" });
		expect((await readMaintenanceHeartbeat()).evaluatedAt).toBe(hb1.evaluatedAt);

		const third = await tick(false);
		expect(third.heartbeatWritten).toBe(true);
		expect(new Date((await readMaintenanceHeartbeat()).evaluatedAt as string).getTime()).toBeGreaterThan(
			new Date(hb1.evaluatedAt as string).getTime(),
		);
	});

	it("the status contract reports the heartbeat, the registry split and active alerts, and selects the exit code", async () => {
		const report = await buildSentimentStatusReport();
		expect(report.contractVersion).toBe(1);
		expect(report.alerts.registry).toEqual({ total: 11, evaluatorOwned: 10, hostOwned: 1 });
		expect(report.alerts.evaluatedHere).toHaveLength(10);
		expect(report.alerts.notEvaluatedHere).toEqual([
			{ signal: "alert-delivery-failure", owner: "host-watchdog", marker: "not-evaluated-here" },
		]);
		expect(report.heartbeat.present).toBe(true);
		expect(report.alerts.active.some((a) => a.severity === "urgent")).toBe(true);
		expect(statusExitCode(report)).toBe(20);
		await client.query(
			"UPDATE sentiment_alert_state SET evaluated_at = now() - interval '16 minutes' WHERE signal = $1",
			[MAINTENANCE_HEARTBEAT_KEY],
		);
		expect(statusExitCode(await buildSentimentStatusReport())).toBe(30);
	});
});

describe("IT-SNT-D-008 count-delta degradation above 5,000 open ids (Q4), both directions", () => {
	const FLOOD_BASE = 100000;
	const flood = async (n: number) => {
		await client.query(
			`INSERT INTO prompt_runs (id, prompt_id, brand_id, model, provider, version, web_search_enabled, raw_output, brand_mentioned, competitors_mentioned, created_at)
			 SELECT ('5e97000f-0000-4000-8000-' || lpad((${FLOOD_BASE} + g)::text, 12, '0'))::uuid, $1, $2, 'chatgpt', 'openrouter', 'v', true, '{}', true, '{}', now() FROM generate_series(1, ${n}) g`,
			[PROMPT, BRAND],
		);
		await client.query(
			`INSERT INTO sentiment_analyses (prompt_run_id, brand_id, classifier_version, taxonomy_version, input_hash, status)
			 SELECT ('5e97000f-0000-4000-8000-' || lpad((${FLOOD_BASE} + g)::text, 12, '0'))::uuid, $1, $2, $3, 'flood', 'pending_resolution' FROM generate_series(1, ${n}) g`,
			[BRAND, SENTIMENT_CLASSIFIER_VERSION, SENTIMENT_TAXONOMY_VERSION],
		);
		await client.query(
			`INSERT INTO sentiment_resolution_cases (analysis_id, input_hash, status, review_reason)
			 SELECT a.id, 'flood', 'awaiting_review', 'call-limit' FROM sentiment_analyses a WHERE a.input_hash = 'flood'`,
		);
	};
	it("enters count-delta mode with one separate degradation notice that does not consume the growth cooldown, acknowledges by count, and rebuilds the exact baseline once the population fits again", async () => {
		// An exact baseline must exist before the flood (in isolation this tick captures it from the small population).
		if (!(await alertRow("awaiting-review-growth"))) await evaluateSentimentAlerts({ notify: sink().notify });
		expect((await alertRow("awaiting-review-growth")).baseline).toMatchObject({ mode: "exact" });
		// Pretend the ordinary growth row notified a moment ago, so only a separate scope could notify now.
		await client.query(
			"UPDATE sentiment_alert_state SET cooldown_until = now() + interval '20 hours', last_alerted_at = now() WHERE signal = 'awaiting-review-growth'",
		);
		await flood(5001);
		let s = sink();
		let result = await evaluateSentimentAlerts({ notify: s.notify });
		const notices = s.records.filter((r) => r.signal === "awaiting-review-growth");
		expect(notices.map((r) => [r.scope, r.reason])).toEqual([["baseline-count-fallback", "baseline-count-fallback"]]);
		expect(notices[0].approximate).toBe(true);
		const growth = await alertRow("awaiting-review-growth");
		expect(growth.watermark).toMatchObject({ mode: "count-delta", precisionDegraded: true, firing: true });
		expect(growth.watermark.ackedIds).toBeUndefined();
		expect(growth.watermark.newIds).toBeUndefined();
		expect(result.suppressed).toBeGreaterThanOrEqual(1);
		const notice = await alertRow("awaiting-review-growth|baseline-count-fallback");
		expect(notice.cooldown_until).not.toBeNull();

		// Once its own cooldown passes the growth row notifies with approximate evidence.
		await client.query(
			"UPDATE sentiment_alert_state SET cooldown_until = now() - interval '1 second' WHERE signal = 'awaiting-review-growth'",
		);
		s = sink();
		result = await evaluateSentimentAlerts({ notify: s.notify });
		const approx = s.records.find((r) => r.signal === "awaiting-review-growth" && r.scope === null);
		expect(approx).toMatchObject({ approximate: true, reason: "count-delta" });
		expect(approx?.threshold).toMatch(/approximate/);
		expect(approx?.evidence).toMatchObject({ mode: "count-delta", precisionDegraded: true });

		// Acknowledgement advances the count watermark under compare-and-set and never claims exact ids.
		const acked = await acknowledgeSentimentAlert({
			rowKey: "awaiting-review-growth",
			expectedDigest: approx?.digest as string,
			...ACTOR,
		});
		expect(acked).toMatchObject({ acknowledged: true, mode: "count-delta" });
		expect((await alertRow("awaiting-review-growth")).watermark.watermarkCount).toBeGreaterThanOrEqual(5001);
		expect((await listControlEvents("alert", "awaiting-review-growth")).at(-1)?.evidence).toMatchObject({
			mode: "count-delta",
			approximate: true,
		});

		// Return path: the flood is resolved; the next held tick rebuilds the exact baseline and audits the mode transition.
		await client.query(
			"DELETE FROM prompt_runs WHERE id IN (SELECT prompt_run_id FROM sentiment_analyses WHERE input_hash = 'flood')",
		);
		s = sink();
		result = await evaluateSentimentAlerts({ notify: s.notify });
		expect(result.baseline.rebuilt).toEqual(["awaiting-review-growth"]);
		expect(await eventsOf("awaiting-review-growth")).toContain("count-delta->exact");
		const rebuilt = await alertRow("awaiting-review-growth");
		expect(rebuilt.baseline).toMatchObject({ mode: "exact" });
		expect(rebuilt.watermark).toMatchObject({ mode: "exact", firing: false, precisionDegraded: false });
		expect(s.records.filter((r) => r.signal === "awaiting-review-growth")).toEqual([]);
		expect(fetchSpy).not.toHaveBeenCalled();
	}, 60_000); // three 5,001-row fixture inserts dominate; the assertions are correctness, not latency
});
