/**
 * Runs against the disposable test database: `pnpm -C apps/web
 * test:integration` with DATABASE_URL pointing at it.
 *
 * Amendment C: held-work selection from existing rows (A ∪ B) and the
 * verifier-only resumption of cases parked for review — selected by
 * invariant, frozen into a manifest, applied one bounded batch at a time with
 * verify-only permits, and proven to make exactly one verify call per case
 * and never a classify or repair call. Synthetic fixtures only.
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
	listHeldWork,
	releaseHeldWork,
	selectResumableForVerify,
	applyResumeForVerify,
	listResumableSentimentRuns,
	listControlEvents,
	listPermits,
	manifestSha256,
} = await import("@workspace/lib/sentiment");
const shaOf = (manifest: unknown) => manifestSha256(JSON.stringify(manifest, null, 2));
const { StructuredResearchRequestError } = await import("@workspace/lib/providers/types");
type Provider = import("@workspace/lib/providers/types").Provider;

const ORG = "default";
const BRAND = "sent-c-resume-brand";
const PROMPT = "5e97000e-0000-4000-8000-000000000101";
const run = (i: number) => `5e97000e-0000-4000-8000-0000000002${String(i).padStart(2, "0")}`;
const ACTOR = { actor: "it:resume", reason: "integration test", correlationId: "IT-SNT-C-RESUME" };

/** s0001 brand · s0003 brand · s0006 brand. */
const ANSWER = `Wenn du die **Sent C Resume-Rechtsschutzversicherung** meinst: **Ja, sie kann gut sein – besonders beim Leistungsumfang –, aber sie ist nicht automatisch die beste Wahl für jeden.**

**Dafür spricht:**
- Vergleichstests bewerten den Leistungsumfang der Sent C Resume positiv.
- Es gibt umfangreiche Leistungen, etwa weltweiten Schutz – je nach Tarif.

**Kurz gesagt:**
Für Rechtsschutz ist die Sent C Resume grundsätzlich ein seriöser und leistungsstarker Anbieter.`;

const client = new pg.Client({ connectionString: DATABASE_URL });
const payload = (promptRunId: string) => ({
	promptRunId,
	classifierVersion: SENTIMENT_CLASSIFIER_VERSION,
	taxonomyVersion: SENTIMENT_TAXONOMY_VERSION,
});
const cite = (anchorId: string, polarity: "positive" | "negative" | "neutral") => ({ anchorId, polarity });
const brandOk = {
	key: "brand",
	category: "positive" as const,
	score: 70,
	confidence: 0.9,
	evidence: [cite("s0001", "positive"), cite("s0006", "positive")],
	aspects: [],
};
const brandUnbound = { ...brandOk, evidence: [cite("s0002", "positive"), cite("s0005", "positive")] };
const ACCEPT = { verdict: "accept", issues: [] };
const refusal400 = () =>
	new StructuredResearchRequestError({
		provider: "openrouter",
		httpStatus: 400,
		errorType: null,
		structured: true,
		carriesOutput: false,
		retryAfterMs: null,
		message: "OpenRouter API error (400): {}",
	});

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
				generationId: `gen-r-${Math.random().toString(36).slice(2, 10)}`,
				usage: {
					inputTokens: 5000,
					outputTokens: 800,
					reasoningTokens: 200,
					costUsd: phase === "verify" ? 0.001 : 0.02,
					webSearchRequests: phase === "classify" ? 1 : 0,
					webSearchRequestsConflict: false,
				},
			};
		},
	} as unknown as Provider;
	return { provider, script };
}
const attemptsOf = async (runId: string) =>
	(
		await client.query(
			`SELECT t.ordinal, t.phase, t.outcome, t.generation_id, t.permit_id, t.actual_cost_usd::text FROM sentiment_provider_attempts t
			 JOIN sentiment_analyses a ON a.id = t.analysis_id WHERE a.prompt_run_id = $1 ORDER BY t.ordinal`,
			[runId],
		)
	).rows;
const caseOf = async (runId: string) =>
	(
		await client.query(
			`SELECT c.status, c.review_reason, c.next_attempt_at, c.provisional_result, c.unresolved_targets FROM sentiment_resolution_cases c JOIN sentiment_analyses a ON a.id = c.analysis_id WHERE a.prompt_run_id = $1`,
			[runId],
		)
	).rows[0];
const analysisOf = async (runId: string) =>
	(
		await client.query(
			"SELECT id, status, verified_at, verifier_version FROM sentiment_analyses WHERE prompt_run_id = $1 AND classifier_version = $2",
			[runId, SENTIMENT_CLASSIFIER_VERSION],
		)
	).rows[0];

async function insertRun(id: string) {
	await client.query(
		`INSERT INTO prompt_runs (id, prompt_id, brand_id, model, provider, version, web_search_enabled, raw_output, brand_mentioned, competitors_mentioned, created_at)
		 VALUES ($1, $2, $3, 'chatgpt', 'openrouter', 'v', true, $4, true, '{}', now() - interval '1 hour')`,
		[id, PROMPT, BRAND, JSON.stringify({ choices: [{ message: { content: ANSWER } }] })],
	);
}
async function cleanup() {
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
/** Reproduce the incident shape: an accepted classify, then a verifier request the provider refused with HTTP 400. */
async function parkForReview(runId: string, classifyAnswer: unknown = { entities: [brandOk] }) {
	await setDispatch("open");
	const { provider } = scripted([
		{ phase: "classify", answer: classifyAnswer },
		{ phase: "verify", error: refusal400() },
	]);
	const outcome = await runSentimentJob(payload(runId), { resolveProvider: () => provider });
	expect(outcome).toMatchObject({ status: "awaiting-review", reason: "contract-defect" });
	// The refusal opened the verify scope; clear it so the next scenario is not blocked by it.
	await client.query("DELETE FROM sentiment_provider_breakers WHERE scope_key LIKE 'rp1:%'");
}

beforeAll(async () => {
	const host = new URL(DATABASE_URL).hostname;
	if (!["localhost", "127.0.0.1", "::1"].includes(host)) throw new Error(`refusing non-loopback database ${host}`);
	await client.connect();
	const org = await client.query("SELECT id FROM organization WHERE slug = $1", [ORG]);
	if (org.rows.length !== 1) throw new Error("seeded organization missing — not the disposable test database");
	await cleanup();
	await client.query(
		`INSERT INTO brands (id, organization_id, slug, name, website, enabled, onboarded, created_at, updated_at) VALUES ($1, $2, $1, 'Sent C Resume', 'https://sent-c-resume.example.test/', true, true, now(), now())`,
		[BRAND, org.rows[0].id],
	);
	await client.query(
		`INSERT INTO prompts (id, brand_id, value, enabled, tags, system_tags, created_at, updated_at) VALUES ($1, $2, 'resume prompt', false, '{}', '{unbranded}', now(), now())`,
		[PROMPT, BRAND],
	);
	for (let i = 1; i <= 10; i++) await insertRun(run(i));
	await setDispatch("open");
});

afterAll(async () => {
	await setDispatch("open");
	await cleanup();
	await client.end();
});

describe("IT-SNT-C-006 held work is read from existing rows and released only explicitly", () => {
	it("A: a pending zero-attempt analysis; B: a mentions receipt without any analysis; historical rows are never selected", async () => {
		await setDispatch("held");
		const before = await listHeldWork(1000);
		// A — the execution gate leaves the pending row.
		expect(await runSentimentJob(payload(run(1)), { resolveProvider: () => scripted([]).provider })).toMatchObject({
			status: "held",
		});
		// B — a receipt persisted without an analysis row (crash between the two writes).
		await client.query(
			`INSERT INTO sentiment_detections (prompt_run_id, brand_id, detector_version, status, mention_count)
			 SELECT $1, $2, detector_version, 'mentions', 1 FROM sentiment_detections WHERE prompt_run_id = $3 LIMIT 1`,
			[run(2), BRAND, run(1)],
		);
		// Historical: a completed v3 analysis with a receipt is not held work.
		await client.query(
			`INSERT INTO sentiment_detections (prompt_run_id, brand_id, detector_version, status, mention_count)
			 SELECT $1, $2, detector_version, 'mentions', 1 FROM sentiment_detections WHERE prompt_run_id = $3 LIMIT 1`,
			[run(3), BRAND, run(1)],
		);
		await client.query(
			`INSERT INTO sentiment_analyses (prompt_run_id, brand_id, classifier_version, taxonomy_version, status, completed_at) VALUES ($1, $2, 'sent-classifier-v3', $3, 'completed', now())`,
			[run(3), BRAND, SENTIMENT_TAXONOMY_VERSION],
		);
		const after = await listHeldWork(1000);
		const mine = after.items.filter((i) => i.brandId === BRAND);
		expect(mine.map((i) => `${i.source}:${i.promptRunId}`).sort()).toEqual([`A:${run(1)}`, `B:${run(2)}`]);
		expect(after.counts.a - before.counts.a).toBe(1);
		expect(after.counts.b - before.counts.b).toBe(1);
		// Release is refused while held, dry-run reports, and the real release sends exactly the selected runs once.
		const dry = await releaseHeldWork({ limit: 1000, dryRun: true });
		expect(dry).toMatchObject({ held: true, dryRun: true });
		await expect(
			releaseHeldWork({ limit: 1000, dryRun: false, sender: { send: async () => "x" }, ...ACTOR }),
		).rejects.toThrow(/held/);
		await setDispatch("open");
		const sends: string[] = [];
		const released = await releaseHeldWork({
			limit: 1000,
			dryRun: false,
			sender: {
				send: async (_q, data: { promptRunId: string }) => {
					sends.push(data.promptRunId);
					return `job-${data.promptRunId}`;
				},
			},
			...ACTOR,
		});
		expect(sends.filter((s) => s.startsWith("5e97000e"))).toEqual(expect.arrayContaining([run(1), run(2)]));
		expect(released.failed).toBe(0);
		expect(await analysisOf(run(2))).toMatchObject({ status: "pending" }); // B got its analysis row
		await client.query("DELETE FROM sentiment_analyses WHERE prompt_run_id = $1", [run(3)]);
	});
});

describe("IT-SNT-C-007 verifier-only resume of cases parked for review", () => {
	it("selects by invariant, excludes every negative shape, freezes a manifest, applies verify-only, refuses on drift", async () => {
		await setDispatch("open");
		// Two incident-shaped cases: accepted classify → refused verify (unpaid).
		await parkForReview(run(4));
		await parkForReview(run(5));
		// Negative: an unbound classify (rejected, repair refused) leaves no accepted candidate → excluded.
		{
			const { provider } = scripted([
				{ phase: "classify", answer: { entities: [brandUnbound] } },
				{ phase: "repair", error: refusal400() },
			]);
			expect(await runSentimentJob(payload(run(6)), { resolveProvider: () => provider })).toMatchObject({
				status: "awaiting-review",
			});
			await client.query("DELETE FROM sentiment_provider_breakers WHERE scope_key LIKE 'rp1:%'");
		}
		// Negative: a paid verify (rejected verdict path) → excluded.
		{
			const { provider } = scripted([
				{ phase: "classify", answer: { entities: [brandOk] } },
				{
					phase: "verify",
					answer: {
						verdict: "reject",
						issues: [{ entityKey: "brand", target: "overall", code: "entity-misattribution", anchorId: null }],
					},
				},
				{ phase: "repair", error: refusal400() },
			]);
			await runSentimentJob(payload(run(7)), { resolveProvider: () => provider });
			await client.query("DELETE FROM sentiment_provider_breakers WHERE scope_key LIKE 'rp1:%'");
		}
		const before = (await listResumableSentimentRuns(1000)).map((r) => r.promptRunId);
		expect(before).not.toContain(run(4));

		const manifest = await selectResumableForVerify();
		const mine = manifest.eligible.filter((e) => e.promptRunId.startsWith("5e97000e"));
		expect(mine.map((e) => e.promptRunId)).toEqual([run(4), run(5)]);
		const reasons = Object.fromEntries(
			manifest.excluded
				.filter((x) => mine.every((e) => e.analysisId !== x.analysisId))
				.map((x) => [x.analysisId, x.reason]),
		);
		const a7 = await analysisOf(run(7));
		if (a7 && (await caseOf(run(7)))?.status === "awaiting_review")
			expect(reasons[a7.id]).toBe("paid-or-accepted-verify");
		expect(manifest.digest).toMatch(/^[0-9a-f]{64}$/);
		expect(manifest.projected.verifyCalls).toBe(manifest.count);

		// Apply refuses a stale manifest.
		const stale = { ...manifest, count: manifest.count + 1 };
		expect(
			await applyResumeForVerify({
				manifest: stale,
				manifestSha256: shaOf(stale),
				limit: 10,
				sender: { send: async () => "x" },
				...ACTOR,
			}),
		).toMatchObject({
			drift: expect.stringMatching(/count/),
			applied: [],
		});

		// Apply the frozen manifest under HELD: permits are issued for the batch and the jobs are sent.
		await setDispatch("held");
		const sends: string[] = [];
		const applied = await applyResumeForVerify({
			manifest,
			manifestSha256: shaOf(manifest),
			limit: 1,
			sender: {
				send: async (_q, data: { promptRunId: string }) => {
					sends.push(data.promptRunId);
					return "job";
				},
			},
			...ACTOR,
		});
		expect(applied.drift).toBeNull();
		expect(applied.applied).toHaveLength(1);
		expect(applied.applied[0].permit).toBe("issued");
		expect(
			(
				await client.query("SELECT contract_sha256 FROM sentiment_dispatch_permits WHERE id = $1", [
					applied.applied[0].permitId,
				])
			).rows[0].contract_sha256,
		).toBe(shaOf(manifest));
		expect(sends).toEqual([manifest.eligible[0].promptRunId]);
		const firstRun = manifest.eligible[0].promptRunId;
		// The resumed job makes exactly one verify call and no classify or repair.
		const { provider, script } = scripted([{ phase: "verify", answer: ACCEPT }]);
		const outcome = await runSentimentJob(payload(firstRun), { resolveProvider: () => provider });
		expect(outcome).toMatchObject({ status: "classified" });
		expect(script.calls).toEqual(["verify"]);
		const attempts = await attemptsOf(firstRun);
		expect(attempts.map((a) => `${a.phase}:${a.outcome}`)).toEqual([
			"classify:accepted",
			"verify:provider-error",
			"verify:accepted",
		]);
		expect(attempts[2].permit_id).toBe(applied.applied[0].permitId);
		expect(await analysisOf(firstRun)).toMatchObject({ status: "completed", verifier_version: "sent-verifier-v1" });
		const permit = (
			await client.query(
				"SELECT state, phase_budget, settled_cost_usd::text, reserved_estimate_usd::text FROM sentiment_dispatch_permits WHERE id = $1",
				[applied.applied[0].permitId],
			)
		).rows[0];
		expect(permit).toMatchObject({ state: "exhausted", phase_budget: { classify: 0, repair: 0, verify: 0 } });
		expect(Number(permit.settled_cost_usd)).toBeCloseTo(0.001, 6);
		// A second apply from the same manifest now drifts (the first case left the selection); nothing broadens.
		const again = await applyResumeForVerify({
			manifest,
			manifestSha256: shaOf(manifest),
			limit: 10,
			sender: { send: async () => "x" },
			...ACTOR,
		});
		expect(again.drift).toMatch(/count/);
		expect(again.applied).toEqual([]);
		// The not-yet-permitted case is still not touched by any automatic path.
		expect(await caseOf(manifest.eligible[1].promptRunId)).toMatchObject({
			status: "awaiting_review",
			review_reason: "contract-defect",
		});
		expect((await listResumableSentimentRuns(1000)).map((r) => r.promptRunId)).not.toContain(
			manifest.eligible[1].promptRunId,
		);
	});
});

describe("IT-SNT-C-008 a resume authorization survives a failed send and an expired permit (Amendment C, F-1)", () => {
	it("send failure is reported per case; the same manifest reuses the permit and retries the singleton send; an expired unconsumed permit is expired durably and replaced", async () => {
		await parkForReview(run(8));
		await setDispatch("held");
		const manifest = await selectResumableForVerify();
		const sha = shaOf(manifest);
		const target = manifest.eligible.find((e) => e.promptRunId === run(8));
		expect(target).toBeDefined();
		const failing = {
			send: async () => {
				throw new Error("queue unavailable");
			},
		};
		// 1. The permit transaction commits, the send fails: reported per case, nothing thrown, the permit stands.
		const first = await applyResumeForVerify({ manifest, manifestSha256: sha, limit: 50, sender: failing, ...ACTOR });
		expect(first.drift).toBeNull();
		const failed = first.failed.find((f) => f.analysisId === target?.analysisId);
		expect(failed).toMatchObject({ error: "Error" });
		expect(await listPermits({ analysisId: target?.analysisId, live: true })).toHaveLength(1);
		// 2. Repeating the same manifest reuses that permit and retries the send — no second authorization.
		const sends: string[] = [];
		const sender = {
			send: async (_q: string, data: { promptRunId: string }) => {
				sends.push(data.promptRunId);
				return `job-${sends.length}`;
			},
		};
		const second = await applyResumeForVerify({ manifest, manifestSha256: sha, limit: 50, sender, ...ACTOR });
		const reused = second.applied.find((a) => a.analysisId === target?.analysisId);
		expect(reused).toMatchObject({ permit: "reused", permitId: failed?.permitId });
		expect(sends).toContain(run(8));
		expect(await listPermits({ analysisId: target?.analysisId })).toHaveLength(1);
		// 3. A different manifest hash is not this permit's contract: refused, typed, no write.
		const other = await applyResumeForVerify({
			manifest,
			manifestSha256: "f".repeat(64),
			limit: 50,
			sender,
			...ACTOR,
		});
		expect(other.skipped.find((x) => x.analysisId === target?.analysisId)).toMatchObject({ reason: "permit-mismatch" });
		// 4. The unconsumed permit expires by the database clock: it is expired durably (one audit event) and replaced.
		await client.query("UPDATE sentiment_dispatch_permits SET expires_at = now() - interval '1 second' WHERE id = $1", [
			failed?.permitId,
		]);
		expect(await listPermits({ analysisId: target?.analysisId, live: true })).toHaveLength(0);
		const third = await applyResumeForVerify({ manifest, manifestSha256: sha, limit: 50, sender, ...ACTOR });
		const replaced = third.applied.find((a) => a.analysisId === target?.analysisId);
		expect(replaced).toMatchObject({ permit: "replaced-expired" });
		expect(replaced?.permitId).not.toBe(failed?.permitId);
		const rows = await listPermits({ analysisId: target?.analysisId });
		expect(rows.map((r) => `${r.state}:${r.effective}`).sort()).toEqual(["expired:false", "issued:true"]);
		expect(
			(await listControlEvents("permit", failed?.permitId ?? "")).map((e) => `${e.fromState}->${e.toState}`),
		).toEqual(["null->issued", "issued->expired"]);
		// 5. A consumed (active) permit is never replaced automatically: the case is refused with a typed reason.
		await client.query(
			"UPDATE sentiment_dispatch_permits SET state = 'active', expires_at = now() - interval '1 second' WHERE id = $1",
			[replaced?.permitId],
		);
		const fourth = await applyResumeForVerify({ manifest, manifestSha256: sha, limit: 50, sender, ...ACTOR });
		expect(fourth.skipped.find((x) => x.analysisId === target?.analysisId)).toMatchObject({
			reason: "permit-consumed",
		});
		expect(await listPermits({ analysisId: target?.analysisId })).toHaveLength(2);
	});
});

describe("IT-SNT-C-009 a verifier rejection under a resume permit returns the case to human review (Amendment C, F-6)", () => {
	it("no repair or classify, no retry wait: awaiting_review/verifier-rejected with the candidate and issues kept, excluded from rediscovery even when open, permit exhausted", async () => {
		await parkForReview(run(9));
		await setDispatch("held");
		const manifest = await selectResumableForVerify();
		const sha = shaOf(manifest);
		const sends: string[] = [];
		const applied = await applyResumeForVerify({
			manifest,
			manifestSha256: sha,
			limit: 50,
			sender: {
				send: async (_q: string, data: { promptRunId: string }) => {
					sends.push(data.promptRunId);
					return "job";
				},
			},
			...ACTOR,
		});
		const analysis9 = await analysisOf(run(9));
		const mine = applied.applied.find((a) => a.analysisId === analysis9.id);
		expect(mine).toBeDefined();
		const { provider, script } = scripted([
			{
				phase: "verify",
				answer: {
					verdict: "reject",
					issues: [{ entityKey: "brand", target: "overall", code: "polarity-mismatch", anchorId: "s0001" }],
				},
			},
		]);
		const outcome = await runSentimentJob(payload(run(9)), { resolveProvider: () => provider });
		expect(outcome).toMatchObject({ status: "awaiting-review", reason: "verifier-rejected", paidCalls: 2 });
		expect(script.calls).toEqual(["verify"]);
		const kase = await caseOf(run(9));
		expect(kase).toMatchObject({
			status: "awaiting_review",
			review_reason: "verifier-rejected",
			next_attempt_at: null,
		});
		expect(kase.provisional_result).toMatchObject({ entities: [expect.objectContaining({ key: "brand" })] });
		expect(kase.unresolved_targets).toEqual([expect.objectContaining({ entityKey: "brand", aspectKey: null })]);
		expect(await analysisOf(run(9))).toMatchObject({ status: "pending_resolution" });
		const attempts = await attemptsOf(run(9));
		expect(attempts.map((a) => `${a.phase}:${a.outcome}`)).toEqual([
			"classify:accepted",
			"verify:provider-error",
			// A valid reject verdict is an accepted (usable, paid) answer of the verify attempt; the verdict lives in the case.
			"verify:accepted",
		]);
		expect(attempts[2].generation_id).toMatch(/^gen-/);
		const permit = (
			await client.query(
				"SELECT state, phase_budget, settled_cost_usd::text FROM sentiment_dispatch_permits WHERE id = $1",
				[mine?.permitId],
			)
		).rows[0];
		expect(permit).toMatchObject({ state: "exhausted", phase_budget: { classify: 0, repair: 0, verify: 0 } });
		expect(Number(permit.settled_cost_usd)).toBeCloseTo(0.001, 6);
		// Not rediscovered by the inventory under OPEN, not re-selected by the resume selector, and a re-run makes no call.
		await setDispatch("open");
		expect((await listResumableSentimentRuns(1000)).map((r) => r.promptRunId)).not.toContain(run(9));
		expect((await selectResumableForVerify()).eligible.map((e) => e.promptRunId)).not.toContain(run(9));
		const again = scripted([
			{ phase: "repair", answer: { entities: [brandOk] } },
			{ phase: "verify", answer: ACCEPT },
		]);
		expect(await runSentimentJob(payload(run(9)), { resolveProvider: () => again.provider })).toMatchObject({
			status: "awaiting-review",
			reason: "verifier-rejected",
		});
		expect(again.script.calls).toEqual([]);
	});
});
