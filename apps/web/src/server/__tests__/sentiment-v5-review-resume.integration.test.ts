/**
 * Runs against the disposable test database: `pnpm -C apps/web
 * test:integration` with DATABASE_URL pointing at it.
 *
 * IT-SNT-RR — a verifier-rejected case is a terminal review state, not work in
 * progress: the coverage read reports it as `review`; it may be resumed only
 * under an explicit repair+verify permit that pays exactly the pair the
 * automatic budget could not afford, starting from the verifier's own targets;
 * an accepted verdict persists, a rejected one returns the case to review.
 */
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must point at the seeded test stack");

const {
	SENTIMENT_CLASSIFIER_VERSION,
	SENTIMENT_MODEL,
	SENTIMENT_TAXONOMY_VERSION,
	applyResumeForVerify,
	issuePermit,
	listResumableSentimentRuns,
	manifestSha256,
	readDispatchState,
	runSentimentJob,
	selectResumableForVerify,
	transitionDispatch,
} = await import("@workspace/lib/sentiment");
const { loadSentimentOverview } = await import("@/server/sentiment-load");
type Provider = import("@workspace/lib/providers/types").Provider;

const ORG = "default";
const BRAND = "sent-rr-brand";
const PROMPT = "5e970010-0000-4000-8000-000000000101";
const run = (i: number) => `5e970010-0000-4000-8000-0000000002${String(i).padStart(2, "0")}`;
const ACTOR = { actor: "it:review-resume", reason: "integration test", correlationId: "IT-SNT-RR" };
/** s0001 brand · s0003 brand · s0006 brand; s0004 is a generic bullet naming no entity. */
const ANSWER = `Wenn du die **Sent RR-Rechtsschutzversicherung** meinst: **Ja, sie kann gut sein – besonders beim Leistungsumfang –, aber sie ist nicht automatisch die beste Wahl für jeden.**
**Dafür spricht:**
- Vergleichstests bewerten den Leistungsumfang der Sent RR positiv.
- Es gibt umfangreiche Leistungen, etwa weltweiten Schutz – je nach Tarif.
**Kurz gesagt:**
Für Rechtsschutz ist die Sent RR grundsätzlich ein seriöser und leistungsstarker Anbieter.`;

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
const brandUnbound = { ...brandOk, evidence: [cite("s0004", "positive")] };
const ACCEPT = { verdict: "accept", issues: [] };
const REJECT = {
	verdict: "reject",
	issues: [{ entityKey: "brand", target: "overall", code: "polarity-mismatch", anchorId: "s0001" }],
};

type Step = { phase: "classify" | "repair" | "verify"; answer?: unknown; error?: unknown };
function scripted(steps: Step[]) {
	const script = { steps: [...steps], calls: [] as string[], prompts: [] as string[] };
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
			script.prompts.push(prompt);
			const step = script.steps.shift();
			if (!step) throw new Error(`unscripted ${phase} call`);
			if (step.phase !== phase) throw new Error(`expected ${step.phase}, got ${phase}`);
			if (step.error) throw step.error;
			return {
				object: schema.parse(step.answer),
				modelVersion: SENTIMENT_MODEL,
				generationId: `gen-rr-${Math.random().toString(36).slice(2, 10)}`,
				usage: {
					inputTokens: 5000,
					outputTokens: 800,
					reasoningTokens: 200,
					costUsd: phase === "verify" ? 0.003 : phase === "repair" ? 0.005 : 0.018,
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
		await client.query<{ ordinal: number; phase: string; outcome: string; permit_id: string | null }>(
			`SELECT t.ordinal, t.phase, t.outcome, t.permit_id::text FROM sentiment_provider_attempts t JOIN sentiment_analyses a ON a.id = t.analysis_id WHERE a.prompt_run_id = $1 ORDER BY t.ordinal`,
			[runId],
		)
	).rows;
const caseOf = async (runId: string) =>
	(
		await client.query<{
			analysis_id: string;
			instance_id: string;
			input_hash: string;
			status: string;
			review_reason: string | null;
			automated_provider_calls: number;
			unresolved_targets: { source: string; reason: string }[];
			provisional_result: unknown;
		}>(
			`SELECT c.analysis_id, c.instance_id, c.input_hash, c.status, c.review_reason, c.automated_provider_calls, c.unresolved_targets, c.provisional_result
			 FROM sentiment_resolution_cases c JOIN sentiment_analyses a ON a.id = c.analysis_id WHERE a.prompt_run_id = $1`,
			[runId],
		)
	).rows[0];
const usageCount = async () =>
	(
		await client.query<{ n: number }>(
			"SELECT count(*)::int AS n FROM usage_events WHERE brand_id = $1 AND event_type LIKE 'sentiment%'",
			[BRAND],
		)
	).rows[0].n;
const observations = async (runId: string) =>
	(
		await client.query<{ n: number }>(
			"SELECT count(*)::int AS n FROM sentiment_observations WHERE prompt_run_id = $1",
			[runId],
		)
	).rows[0].n;

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
}
async function setDispatch(to: "held" | "open") {
	const current = await readDispatchState();
	if (current.state === to) return;
	const moved = await transitionDispatch({ to, expected: current.state, ...ACTOR });
	if (!moved.ok) throw new Error(`could not move dispatch to ${to}`);
}
/** The pair rule's own product: classify → verify(reject) → repair → verify(reject) → awaiting_review/verifier-rejected at four calls. */
async function parkVerifierRejected(runId: string) {
	const { provider } = scripted([
		{ phase: "classify", answer: { entities: [brandOk] } },
		{ phase: "verify", answer: REJECT },
		{ phase: "repair", answer: { entities: [brandOk] } },
		{ phase: "verify", answer: REJECT },
	]);
	expect(await runSentimentJob(payload(runId), { resolveProvider: () => provider })).toMatchObject({
		status: "awaiting-review",
		reason: "verifier-rejected",
		paidCalls: 4,
	});
	return caseOf(runId);
}
const selectRR = () => selectResumableForVerify(undefined, { reviewReason: "verifier-rejected" });
async function applyRR() {
	const manifest = await selectRR();
	const applied = await applyResumeForVerify({
		manifest,
		manifestSha256: manifestSha256(JSON.stringify(manifest, null, 2)),
		limit: 50,
		sender: { send: async () => "job" },
		...ACTOR,
	});
	expect(applied.drift).toBeNull();
	return applied;
}

beforeAll(async () => {
	const host = new URL(DATABASE_URL).hostname;
	if (!["localhost", "127.0.0.1", "::1"].includes(host)) throw new Error(`refusing non-loopback database ${host}`);
	await client.connect();
	const org = await client.query("SELECT id FROM organization WHERE slug = $1", [ORG]);
	if (org.rows.length !== 1) throw new Error("seeded organization missing — not the disposable test database");
	await cleanup();
	await client.query(
		`INSERT INTO brands (id, organization_id, slug, name, website, enabled, onboarded, created_at, updated_at) VALUES ($1, $2, $1, 'Sent RR', 'https://sent-rr.example.test/', true, true, now(), now())`,
		[BRAND, org.rows[0].id],
	);
	await client.query(
		`INSERT INTO prompts (id, brand_id, value, enabled, tags, system_tags, created_at, updated_at) VALUES ($1, $2, 'review-resume prompt', false, '{}', '{unbranded}', now(), now())`,
		[PROMPT, BRAND],
	);
	for (let i = 1; i <= 8; i++) await insertRun(run(i));
	await setDispatch("open");
});

afterAll(async () => {
	await setDispatch("open");
	await cleanup();
	await client.end();
});

describe("IT-SNT-RR-001 coverage reads a parked review case as review, never as in progress", () => {
	it("verifier-rejected and call-limit runs count as review; nothing is pending; the resolved run is completed", async () => {
		await parkVerifierRejected(run(1));
		const { provider: parity } = scripted([
			{ phase: "classify", answer: { entities: [brandUnbound] } },
			{ phase: "repair", answer: { entities: [brandUnbound] } },
			{ phase: "repair", answer: { entities: [brandUnbound] } },
			{ phase: "repair", answer: { entities: [brandUnbound] } },
			{ phase: "repair", answer: { entities: [brandUnbound] } },
		]);
		expect(await runSentimentJob(payload(run(2)), { resolveProvider: () => parity })).toMatchObject({
			status: "awaiting-review",
			reason: "call-limit",
		});
		const { provider: ok } = scripted([
			{ phase: "classify", answer: { entities: [brandOk] } },
			{ phase: "verify", answer: ACCEPT },
		]);
		expect(await runSentimentJob(payload(run(3)), { resolveProvider: () => ok })).toMatchObject({
			status: "classified",
		});
		const overview = await loadSentimentOverview({
			brandId: BRAND,
			lookback: "1m",
			aspect: "overall",
			timezone: "UTC",
		});
		expect(overview.coverage.analyses).toMatchObject({ completed: 1, review: 2, pending: 0, failed: 0 });
	});
});

describe("IT-SNT-RR-002 selection of verifier-rejected cases by invariant", () => {
	it("selects the pair-rule product, excludes deterministic call-limit targets, a later refused verify and a sending attempt; other selectors ignore it", async () => {
		const rr = await caseOf(run(1));
		const laterVerify = await parkVerifierRejected(run(4));
		await client.query(
			`INSERT INTO sentiment_provider_attempts (id, analysis_id, instance_id, ordinal, phase, provider, model, generation_id, input_hash, outcome, actual_cost_usd, started_at, finished_at, candidate)
			 VALUES (gen_random_uuid(), $1, $2, 5, 'verify', 'openrouter', $3, NULL, $4, 'provider-error', NULL, now(), now(), NULL)`,
			[laterVerify.analysis_id, laterVerify.instance_id, SENTIMENT_MODEL, laterVerify.input_hash],
		);
		const sending = await parkVerifierRejected(run(5));
		await client.query(
			`INSERT INTO sentiment_provider_attempts (id, analysis_id, instance_id, ordinal, phase, provider, model, generation_id, input_hash, outcome, actual_cost_usd, started_at, finished_at, candidate)
			 VALUES (gen_random_uuid(), $1, $2, 5, 'repair', 'openrouter', $3, NULL, $4, 'sending', NULL, now(), NULL, NULL)`,
			[sending.analysis_id, sending.instance_id, SENTIMENT_MODEL, sending.input_hash],
		);
		const manifest = await selectRR();
		expect(manifest.reviewReason).toBe("verifier-rejected");
		expect(manifest.eligible.map((e) => e.analysisId)).toContain(rr.analysis_id);
		const reasons = Object.fromEntries(manifest.excluded.map((e) => [e.analysisId, e.reason]));
		expect(reasons[laterVerify.analysis_id]).toBe("no-rejecting-verify");
		expect(reasons[sending.analysis_id]).toBe("sending-or-unknown-attempt");
		const callLimit = await caseOf(run(2));
		expect(manifest.eligible.map((e) => e.analysisId)).not.toContain(callLimit.analysis_id);
		expect(manifest.projected.hardLimits).toMatch(/one repair and one verify/);
		// The verify-only selectors never see it and the maintenance inventory never wakes it without a permit.
		expect((await selectResumableForVerify()).eligible.map((e) => e.analysisId)).not.toContain(rr.analysis_id);
		expect(
			(await selectResumableForVerify(undefined, { reviewReason: "call-limit" })).eligible.map((e) => e.analysisId),
		).not.toContain(rr.analysis_id);
		expect((await listResumableSentimentRuns(1000)).map((r) => r.promptRunId)).not.toContain(run(1));
	});

	it("a verify-only permit does not resume a verifier-rejected case, and the pair permit is refused for the verify-only purpose", async () => {
		const rr = await caseOf(run(1));
		await expect(
			issuePermit({
				purpose: "resume-verify",
				promptRunId: run(1),
				analysisId: rr.analysis_id,
				instanceId: rr.instance_id,
				inputHash: rr.input_hash,
				classifierVersion: SENTIMENT_CLASSIFIER_VERSION,
				phaseBudget: { classify: 0, repair: 1, verify: 1 },
				estimatedCostBudgetUsd: 0.04,
				ttlSeconds: 600,
				contractSha256: "a".repeat(64),
				...ACTOR,
			}),
		).rejects.toThrow(/resume-verify permit must carry exactly/);
		const verifyOnly = await issuePermit({
			purpose: "resume-verify",
			promptRunId: run(1),
			analysisId: rr.analysis_id,
			instanceId: rr.instance_id,
			inputHash: rr.input_hash,
			classifierVersion: SENTIMENT_CLASSIFIER_VERSION,
			phaseBudget: { classify: 0, repair: 0, verify: 1 },
			estimatedCostBudgetUsd: 0.02,
			ttlSeconds: 600,
			contractSha256: "a".repeat(64),
			...ACTOR,
		});
		const { provider, script } = scripted([{ phase: "verify", answer: ACCEPT }]);
		expect(await runSentimentJob(payload(run(1)), { resolveProvider: () => provider })).toMatchObject({
			status: "awaiting-review",
			reason: "verifier-rejected",
			paidCalls: 4,
		});
		expect(script.calls).toEqual([]);
		await client.query("UPDATE sentiment_dispatch_permits SET state = 'revoked' WHERE id = $1", [verifyOnly.id]);
	});
});

describe("IT-SNT-RR-003 exactly one repair+verify pair under the permit", () => {
	it("accepted verdict: repair of the verifier's targets, one verify, resolved at six calls, permit exhausted with dispatch open", async () => {
		const rr = await caseOf(run(1));
		expect(rr.unresolved_targets.map((t) => t.source)).toEqual(["verifier"]);
		const applied = await applyRR();
		const mine = applied.applied.find((a) => a.analysisId === rr.analysis_id);
		expect(mine).toBeDefined();
		const permitBefore = (
			await client.query("SELECT purpose, phase_budget FROM sentiment_dispatch_permits WHERE id = $1", [mine?.permitId])
		).rows[0];
		expect(permitBefore).toMatchObject({
			purpose: "resume-repair",
			phase_budget: { classify: 0, repair: 1, verify: 1 },
		});
		expect((await listResumableSentimentRuns(1000)).map((r) => r.promptRunId)).toContain(run(1));
		const before = await usageCount();
		const { provider, script } = scripted([
			{ phase: "repair", answer: { entities: [brandOk] } },
			{ phase: "verify", answer: ACCEPT },
		]);
		expect(await runSentimentJob(payload(run(1)), { resolveProvider: () => provider })).toMatchObject({
			status: "classified",
			paidCalls: 6,
		});
		expect(script.calls).toEqual(["repair", "verify"]);
		// The repair prompt targets exactly the verifier's issue, not a fresh classification.
		expect(script.prompts[0]).toMatch(/polarity-mismatch/);
		expect(await caseOf(run(1))).toMatchObject({ status: "resolved", automated_provider_calls: 6 });
		expect(await observations(run(1))).toBeGreaterThan(0);
		const attempts = await attemptsOf(run(1));
		expect(attempts.map((a) => `${a.ordinal}:${a.phase}:${a.outcome}:${a.permit_id === mine?.permitId}`)).toEqual([
			"1:classify:accepted:false",
			"2:verify:accepted:false",
			"3:repair:accepted:false",
			"4:verify:accepted:false",
			"5:repair:accepted:true",
			"6:verify:accepted:true",
		]);
		expect(await usageCount()).toBe(before + 2);
		const permit = (
			await client.query(
				"SELECT state, phase_budget, settled_cost_usd::text FROM sentiment_dispatch_permits WHERE id = $1",
				[mine?.permitId],
			)
		).rows[0];
		expect(permit).toMatchObject({ state: "exhausted", phase_budget: { classify: 0, repair: 0, verify: 0 } });
		expect(Number(permit.settled_cost_usd)).toBeCloseTo(0.008, 6);
		const overview = await loadSentimentOverview({
			brandId: BRAND,
			lookback: "1m",
			aspect: "overall",
			timezone: "UTC",
		});
		expect(overview.coverage.analyses.completed).toBe(2);
	});

	it("rejected verdict: one repair, one verify, back to verifier-rejected with the new issues, no further repair; re-run spends nothing", async () => {
		const rr = await parkVerifierRejected(run(6));
		const applied = await applyRR();
		const mine = applied.applied.find((a) => a.analysisId === rr.analysis_id);
		expect(mine).toBeDefined();
		const before = await usageCount();
		const { provider, script } = scripted([
			{ phase: "repair", answer: { entities: [brandOk] } },
			{ phase: "verify", answer: REJECT },
			{ phase: "repair", answer: { entities: [brandOk] } },
		]);
		expect(await runSentimentJob(payload(run(6)), { resolveProvider: () => provider })).toMatchObject({
			status: "awaiting-review",
			reason: "verifier-rejected",
			paidCalls: 6,
		});
		expect(script.calls).toEqual(["repair", "verify"]);
		const kase = await caseOf(run(6));
		expect(kase).toMatchObject({
			status: "awaiting_review",
			review_reason: "verifier-rejected",
			automated_provider_calls: 6,
		});
		expect(kase.unresolved_targets).toEqual([expect.objectContaining({ source: "verifier" })]);
		expect(kase.provisional_result).not.toBeNull();
		expect(await observations(run(6))).toBe(0);
		expect(await usageCount()).toBe(before + 2);
		expect(
			(await client.query("SELECT state FROM sentiment_dispatch_permits WHERE id = $1", [mine?.permitId])).rows[0]
				.state,
		).toBe("exhausted");
		// The pair was spent: neither the maintenance inventory nor a fresh manifest selects the instance again.
		expect((await listResumableSentimentRuns(1000)).map((r) => r.promptRunId)).not.toContain(run(6));
		const fresh = await selectRR();
		expect(fresh.eligible.map((e) => e.analysisId)).not.toContain(rr.analysis_id);
		expect(fresh.excluded).toContainEqual({ analysisId: rr.analysis_id, reason: "pair-already-spent" });
		const again = scripted([{ phase: "repair", answer: { entities: [brandOk] } }]);
		expect(await runSentimentJob(payload(run(6)), { resolveProvider: () => again.provider })).toMatchObject({
			status: "awaiting-review",
			reason: "verifier-rejected",
		});
		expect(again.script.calls).toEqual([]);
	});

	it("the repair-resume permit never lets the workflow classify or exceed the pair: a consumed permit leaves the case parked", async () => {
		const rr = await parkVerifierRejected(run(7));
		const applied = await applyRR();
		const mine = applied.applied.find((a) => a.analysisId === rr.analysis_id);
		expect(mine).toBeDefined();
		await client.query(
			`UPDATE sentiment_dispatch_permits SET phase_budget = '{"classify":0,"repair":0,"verify":0}'::jsonb, state = 'exhausted' WHERE id = $1`,
			[mine?.permitId],
		);
		const { provider, script } = scripted([{ phase: "repair", answer: { entities: [brandOk] } }]);
		expect(await runSentimentJob(payload(run(7)), { resolveProvider: () => provider })).toMatchObject({
			status: "awaiting-review",
			reason: "verifier-rejected",
			paidCalls: 4,
		});
		expect(script.calls).toEqual([]);
		expect((await attemptsOf(run(7))).filter((a) => a.ordinal > 4)).toEqual([]);
	});
});
