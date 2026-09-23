/**
 * Runs against the disposable test database: `pnpm -C apps/web
 * test:integration` with DATABASE_URL pointing at it.
 *
 * IT-SNT-CL — the repair+verify pair rule and the call-limit verify-only
 * resume: a repair the verifier asked for is only paid when its
 * re-verification still fits the automatic budget, otherwise the rejected
 * candidate is parked as `verifier-rejected` with the verifier's issues; the
 * deterministic-target parity path keeps its `call-limit` exit; legacy
 * call-limit cases (parked unverified repair) are selected by the exact
 * invariant and may spend exactly one permit-bound verification.
 */
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must point at the seeded test stack");

const {
	RESOLUTION_POLICY,
	SENTIMENT_CLASSIFIER_VERSION,
	SENTIMENT_MODEL,
	SENTIMENT_TAXONOMY_VERSION,
	applyResumeForVerify,
	listResumableSentimentRuns,
	manifestSha256,
	readDispatchState,
	runSentimentJob,
	selectResumableForVerify,
	transitionDispatch,
} = await import("@workspace/lib/sentiment");
type Provider = import("@workspace/lib/providers/types").Provider;

const ORG = "default";
const BRAND = "sent-cl-pair-brand";
const PROMPT = "5e97000f-0000-4000-8000-000000000101";
const run = (i: number) => `5e97000f-0000-4000-8000-0000000002${String(i).padStart(2, "0")}`;
const ACTOR = { actor: "it:call-limit", reason: "integration test", correlationId: "IT-SNT-CL" };
/** s0001 brand · s0003 brand · s0006 brand; s0004 is a generic bullet naming no entity. */
const ANSWER = `Wenn du die **Sent CL Pair-Rechtsschutzversicherung** meinst: **Ja, sie kann gut sein – besonders beim Leistungsumfang –, aber sie ist nicht automatisch die beste Wahl für jeden.**
**Dafür spricht:**
- Vergleichstests bewerten den Leistungsumfang der Sent CL Pair positiv.
- Es gibt umfangreiche Leistungen, etwa weltweiten Schutz – je nach Tarif.
**Kurz gesagt:**
Für Rechtsschutz ist die Sent CL Pair grundsätzlich ein seriöser und leistungsstarker Anbieter.`;

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
/** Evidence only on the generic bullet s0004 (no entity named): a deterministic unresolved target, never a verifier matter. */
const brandUnbound = { ...brandOk, evidence: [cite("s0004", "positive")] };
const ACCEPT = { verdict: "accept", issues: [] };
const REJECT = {
	verdict: "reject",
	issues: [{ entityKey: "brand", target: "overall", code: "polarity-mismatch", anchorId: "s0001" }],
};

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
				generationId: `gen-cl-${Math.random().toString(36).slice(2, 10)}`,
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
		await client.query<{
			ordinal: number;
			phase: string;
			outcome: string;
			generation_id: string | null;
			cost: string | null;
		}>(
			`SELECT t.ordinal, t.phase, t.outcome, t.generation_id, t.actual_cost_usd::text AS cost FROM sentiment_provider_attempts t JOIN sentiment_analyses a ON a.id = t.analysis_id WHERE a.prompt_run_id = $1 ORDER BY t.ordinal`,
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
			total_actual_cost_usd: string;
			unresolved_targets: unknown[];
			provisional_result: { entities: { key: string; evidence: unknown[] }[] } | null;
			next_attempt_at: string | null;
		}>(
			`SELECT c.analysis_id, c.instance_id, c.input_hash, c.status, c.review_reason, c.automated_provider_calls, c.total_actual_cost_usd::text, c.unresolved_targets, c.provisional_result, c.next_attempt_at::text
			 FROM sentiment_resolution_cases c JOIN sentiment_analyses a ON a.id = c.analysis_id WHERE a.prompt_run_id = $1`,
			[runId],
		)
	).rows[0];
const analysisOf = async (runId: string) =>
	(
		await client.query<{ id: string; status: string; verified_at: string | null }>(
			"SELECT id, status, verified_at::text FROM sentiment_analyses WHERE prompt_run_id = $1 AND classifier_version = $2",
			[runId, SENTIMENT_CLASSIFIER_VERSION],
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

/**
 * Reproduce a legacy production call-limit row (the shape the pair rule now prevents): the pair rule parks the
 * case at four calls, then the fifth paid call — an accepted repair that was never verified — is added the way
 * the old workflow left it: attempt row, counters, `call-limit`, no unresolved targets, parked candidate.
 */
async function seedLegacyCallLimit(runId: string) {
	const { provider } = scripted([
		{ phase: "classify", answer: { entities: [brandOk] } },
		{ phase: "verify", answer: REJECT },
		{ phase: "repair", answer: { entities: [brandOk] } },
		{ phase: "verify", answer: REJECT },
	]);
	const outcome = await runSentimentJob(payload(runId), { resolveProvider: () => provider });
	expect(outcome).toMatchObject({ status: "awaiting-review", reason: "verifier-rejected", paidCalls: 4 });
	const kase = await caseOf(runId);
	await client.query(
		`INSERT INTO sentiment_provider_attempts (id, analysis_id, instance_id, ordinal, phase, provider, model, generation_id, input_hash, outcome, actual_cost_usd, started_at, finished_at, candidate)
		 VALUES (gen_random_uuid(), $1, $2, 5, 'repair', 'openrouter', $3, $4, $5, 'accepted', 0.005, now(), now(), $6::jsonb)`,
		[
			kase.analysis_id,
			kase.instance_id,
			SENTIMENT_MODEL,
			`gen-legacy-${runId.slice(-2)}`,
			kase.input_hash,
			JSON.stringify({ entities: [brandOk] }),
		],
	);
	await client.query(
		`UPDATE sentiment_resolution_cases SET status = 'awaiting_review', review_reason = 'call-limit', automated_provider_calls = 5, total_actual_cost_usd = total_actual_cost_usd + 0.005, unresolved_targets = '[]'::jsonb, provisional_result = $2::jsonb WHERE analysis_id = $1`,
		[kase.analysis_id, JSON.stringify({ entities: [brandOk] })],
	);
	await client.query(
		`INSERT INTO usage_events (organization_id, brand_id, prompt_id, event_type, provider, model, web_search_enabled, units, estimated_cost_usd)
		 SELECT b.organization_id, $1, $2, 'sentiment_classification', 'openrouter', $3, false, 1, 0.005 FROM brands b WHERE b.id = $1`,
		[BRAND, PROMPT, SENTIMENT_MODEL],
	);
	return caseOf(runId);
}

beforeAll(async () => {
	const host = new URL(DATABASE_URL).hostname;
	if (!["localhost", "127.0.0.1", "::1"].includes(host)) throw new Error(`refusing non-loopback database ${host}`);
	await client.connect();
	const org = await client.query("SELECT id FROM organization WHERE slug = $1", [ORG]);
	if (org.rows.length !== 1) throw new Error("seeded organization missing — not the disposable test database");
	await cleanup();
	await client.query(
		`INSERT INTO brands (id, organization_id, slug, name, website, enabled, onboarded, created_at, updated_at) VALUES ($1, $2, $1, 'Sent CL Pair', 'https://sent-cl-pair.example.test/', true, true, now(), now())`,
		[BRAND, org.rows[0].id],
	);
	await client.query(
		`INSERT INTO prompts (id, brand_id, value, enabled, tags, system_tags, created_at, updated_at) VALUES ($1, $2, 'call-limit prompt', false, '{}', '{unbranded}', now(), now())`,
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

describe("IT-SNT-CL-001 the repair+verify pair rule", () => {
	it("a persistent verifier disagreement ends classify → verify → repair → verify as verifier-rejected; no fifth repair is paid", async () => {
		const { provider, script } = scripted([
			{ phase: "classify", answer: { entities: [brandOk] } },
			{ phase: "verify", answer: REJECT },
			{ phase: "repair", answer: { entities: [brandOk] } },
			{ phase: "verify", answer: REJECT },
			{ phase: "repair", answer: { entities: [brandOk] } },
		]);
		const before = await usageCount();
		const outcome = await runSentimentJob(payload(run(1)), { resolveProvider: () => provider });
		expect(outcome).toMatchObject({
			status: "awaiting-review",
			reason: "verifier-rejected",
			paidCalls: 4,
			unresolved: 1,
		});
		expect(script.calls).toEqual(["classify", "verify", "repair", "verify"]);
		expect(script.steps).toHaveLength(1);
		const kase = await caseOf(run(1));
		expect(kase).toMatchObject({
			status: "awaiting_review",
			review_reason: "verifier-rejected",
			automated_provider_calls: 4,
			next_attempt_at: null,
		});
		expect(Number(kase.total_actual_cost_usd)).toBeCloseTo(0.018 + 0.003 + 0.005 + 0.003, 6);
		// The candidate the verifier actually rejected is parked, with the verifier's issue as the retained target.
		expect(kase.provisional_result?.entities).toEqual([expect.objectContaining({ key: "brand" })]);
		expect(kase.unresolved_targets).toEqual([expect.objectContaining({ entityKey: "brand", aspectKey: null })]);
		expect((await attemptsOf(run(1))).map((a) => `${a.phase}:${a.outcome}`)).toEqual([
			"classify:accepted",
			"verify:accepted",
			"repair:accepted",
			"verify:accepted",
		]);
		expect(await usageCount()).toBe(before + 4);
		expect((await analysisOf(run(1))).status).toBe("pending_resolution");
		expect(await observations(run(1))).toBe(0);
		// A re-run without a permit makes no call and leaves the review item.
		const again = scripted([{ phase: "repair", answer: { entities: [brandOk] } }]);
		expect(await runSentimentJob(payload(run(1)), { resolveProvider: () => again.provider })).toMatchObject({
			status: "awaiting-review",
			reason: "verifier-rejected",
		});
		expect(again.script.calls).toEqual([]);
	});

	it("a rejection with room for the pair still repairs and re-verifies; acceptance resolves normally", async () => {
		const { provider, script } = scripted([
			{ phase: "classify", answer: { entities: [brandOk] } },
			{ phase: "verify", answer: REJECT },
			{ phase: "repair", answer: { entities: [brandOk] } },
			{ phase: "verify", answer: ACCEPT },
		]);
		expect(await runSentimentJob(payload(run(2)), { resolveProvider: () => provider })).toMatchObject({
			status: "classified",
			paidCalls: 4,
		});
		expect(script.calls).toEqual(["classify", "verify", "repair", "verify"]);
		expect((await caseOf(run(2))).status).toBe("resolved");
		expect(await observations(run(2))).toBeGreaterThan(0);
	});

	it("the deterministic-target parity path keeps its call-limit exit and never fabricates a verifier rejection", async () => {
		const { provider, script } = scripted([
			{ phase: "classify", answer: { entities: [brandUnbound] } },
			{ phase: "repair", answer: { entities: [brandUnbound] } },
			{ phase: "repair", answer: { entities: [brandUnbound] } },
			{ phase: "repair", answer: { entities: [brandUnbound] } },
			{ phase: "repair", answer: { entities: [brandUnbound] } },
			{ phase: "repair", answer: { entities: [brandOk] } },
		]);
		const outcome = await runSentimentJob(payload(run(3)), { resolveProvider: () => provider });
		expect(outcome).toMatchObject({
			status: "awaiting-review",
			reason: "call-limit",
			paidCalls: RESOLUTION_POLICY.maxPaidCalls,
			unresolved: 1,
		});
		expect(script.calls).toEqual(["classify", "repair", "repair", "repair", "repair"]);
		expect(await caseOf(run(3))).toMatchObject({ status: "awaiting_review", review_reason: "call-limit" });
		// Not the resumable call-limit shape: the selector excludes it with a typed reason instead of resuming it.
		const manifest = await selectResumableForVerify(undefined, { reviewReason: "call-limit" });
		const analysis = await analysisOf(run(3));
		expect(manifest.eligible.map((e) => e.analysisId)).not.toContain(analysis.id);
		expect(manifest.excluded).toContainEqual({ analysisId: analysis.id, reason: "wrong-path" });
	});
});

describe("IT-SNT-CL-002 legacy call-limit cases: selection by the exact invariant", () => {
	it("selects the exact path and excludes drifted, wrong-count, later-verify, sending and wrong-instance shapes; the contract-defect selector is unaffected", async () => {
		const good = await seedLegacyCallLimit(run(4));
		const wrongCount = await seedLegacyCallLimit(run(5));
		await client.query("DELETE FROM sentiment_provider_attempts WHERE analysis_id = $1 AND ordinal = 5", [
			wrongCount.analysis_id,
		]);
		const laterVerify = await seedLegacyCallLimit(run(6));
		await client.query(
			`INSERT INTO sentiment_provider_attempts (id, analysis_id, instance_id, ordinal, phase, provider, model, generation_id, input_hash, outcome, actual_cost_usd, started_at, finished_at, candidate)
			 VALUES (gen_random_uuid(), $1, $2, 6, 'verify', 'openrouter', $3, NULL, $4, 'provider-error', NULL, now(), now(), NULL)`,
			[laterVerify.analysis_id, laterVerify.instance_id, SENTIMENT_MODEL, laterVerify.input_hash],
		);
		const sending = await seedLegacyCallLimit(run(7));
		await client.query(
			`INSERT INTO sentiment_provider_attempts (id, analysis_id, instance_id, ordinal, phase, provider, model, generation_id, input_hash, outcome, actual_cost_usd, started_at, finished_at, candidate)
			 VALUES (gen_random_uuid(), $1, $2, 6, 'verify', 'openrouter', $3, NULL, $4, 'sending', NULL, now(), NULL, NULL)`,
			[sending.analysis_id, sending.instance_id, SENTIMENT_MODEL, sending.input_hash],
		);
		const wrongInstance = await seedLegacyCallLimit(run(8));
		await client.query(
			"UPDATE sentiment_provider_attempts SET instance_id = gen_random_uuid() WHERE analysis_id = $1",
			[wrongInstance.analysis_id],
		);
		const malformed = await seedLegacyCallLimit(run(9));
		await client.query(
			`UPDATE sentiment_provider_attempts SET candidate = '{"entities":[{"key":"brand"}]}'::jsonb WHERE analysis_id = $1 AND ordinal = 5`,
			[malformed.analysis_id],
		);

		const manifest = await selectResumableForVerify(undefined, { reviewReason: "call-limit" });
		expect(manifest.reviewReason).toBe("call-limit");
		expect(manifest.version).toBe(2);
		const eligibleIds = manifest.eligible.map((e) => e.analysisId);
		expect(eligibleIds).toContain(good.analysis_id);
		for (const bad of [wrongCount, laterVerify, sending, wrongInstance, malformed])
			expect(eligibleIds).not.toContain(bad.analysis_id);
		const reasons = Object.fromEntries(manifest.excluded.map((e) => [e.analysisId, e.reason]));
		expect(reasons[wrongCount.analysis_id]).toBe("wrong-call-count");
		expect(reasons[laterVerify.analysis_id]).toBe("later-attempt");
		expect(reasons[sending.analysis_id]).toBe("sending-or-unknown-attempt");
		expect(reasons[wrongInstance.analysis_id]).toBe("wrong-call-count");
		expect(reasons[malformed.analysis_id]).toBe("candidate-malformed");
		// The parked (fifth) repair is the attempt whose candidate the resumed workflow reuses.
		expect(manifest.eligible.find((e) => e.analysisId === good.analysis_id)?.latestOrdinal).toBe(5);
		// The old selector never sees call-limit cases and still refuses any case with a paid verify.
		const contractDefect = await selectResumableForVerify();
		expect(contractDefect.reviewReason).toBe("contract-defect");
		expect(contractDefect.eligible.map((e) => e.analysisId)).not.toContain(good.analysis_id);
		expect(contractDefect.excluded.map((e) => e.analysisId)).not.toContain(good.analysis_id);
		// Without a permit the maintenance inventory never wakes a call-limit case, open or held.
		expect((await listResumableSentimentRuns(1000)).map((r) => r.promptRunId)).not.toContain(run(4));
	});

	it("a manifest of the other review reason is refused as drift, never applied", async () => {
		const manifest = await selectResumableForVerify(undefined, { reviewReason: "call-limit" });
		const forged = { ...manifest, reviewReason: "contract-defect" as const };
		const result = await applyResumeForVerify({
			manifest: forged,
			manifestSha256: manifestSha256(JSON.stringify(forged, null, 2)),
			limit: 50,
			sender: { send: async () => "job" },
			...ACTOR,
		});
		expect(result.applied).toEqual([]);
		expect(result.drift).not.toBeNull();
	});
});

describe("IT-SNT-CL-003 exactly one permit-bound verification at five paid calls", () => {
	it("without a permit the case stays parked and no provider call is made", async () => {
		const { provider, script } = scripted([{ phase: "verify", answer: ACCEPT }]);
		expect(await runSentimentJob(payload(run(4)), { resolveProvider: () => provider })).toMatchObject({
			status: "awaiting-review",
			reason: "call-limit",
			paidCalls: 5,
		});
		expect(script.calls).toEqual([]);
		expect(await caseOf(run(4))).toMatchObject({ status: "awaiting_review", review_reason: "call-limit" });
	});

	it("accepted verdict under the permit: one verify at paidCalls 5, resolved, permit exhausted even with dispatch open", async () => {
		const good = await caseOf(run(4));
		const manifest = await selectResumableForVerify(undefined, { reviewReason: "call-limit" });
		const sha = manifestSha256(JSON.stringify(manifest, null, 2));
		const sends: string[] = [];
		const applied = await applyResumeForVerify({
			manifest,
			manifestSha256: sha,
			limit: 50,
			sender: { send: async (_q: string, data: { promptRunId: string }) => (sends.push(data.promptRunId), "job") },
			...ACTOR,
		});
		expect(applied.drift).toBeNull();
		const mine = applied.applied.find((a) => a.analysisId === good.analysis_id);
		expect(mine).toBeDefined();
		expect(sends).toContain(run(4));
		// The permitted case is now discoverable by the maintenance inventory, the others are not.
		expect((await listResumableSentimentRuns(1000)).map((r) => r.promptRunId)).toContain(run(4));

		const before = await usageCount();
		const { provider, script } = scripted([{ phase: "verify", answer: ACCEPT }]);
		const outcome = await runSentimentJob(payload(run(4)), { resolveProvider: () => provider });
		expect(outcome).toMatchObject({ status: "classified", paidCalls: 6 });
		expect(script.calls).toEqual(["verify"]);
		expect(await caseOf(run(4))).toMatchObject({ status: "resolved", automated_provider_calls: 6 });
		expect((await analysisOf(run(4))).status).toBe("completed");
		expect(await observations(run(4))).toBeGreaterThan(0);
		const attempts = await attemptsOf(run(4));
		expect(attempts.map((a) => `${a.ordinal}:${a.phase}:${a.outcome}`)).toEqual([
			"1:classify:accepted",
			"2:verify:accepted",
			"3:repair:accepted",
			"4:verify:accepted",
			"5:repair:accepted",
			"6:verify:accepted",
		]);
		expect(attempts[5].generation_id).toMatch(/^gen-cl-/);
		expect(Number(attempts[5].cost)).toBeCloseTo(0.003, 6);
		expect(await usageCount()).toBe(before + 1);
		const permit = (
			await client.query(
				"SELECT state, phase_budget, settled_cost_usd::text FROM sentiment_dispatch_permits WHERE id = $1",
				[mine?.permitId],
			)
		).rows[0];
		expect(permit).toMatchObject({ state: "exhausted", phase_budget: { classify: 0, repair: 0, verify: 0 } });
		expect(Number(permit.settled_cost_usd)).toBeCloseTo(0.003, 6);
	});

	it("rejected verdict under the permit: verifier-rejected at six calls, issues kept, no repair, permit exhausted; a re-run makes no call", async () => {
		const target = await seedLegacyCallLimit(run(10));
		const manifest = await selectResumableForVerify(undefined, { reviewReason: "call-limit" });
		expect(manifest.eligible.map((e) => e.analysisId)).toContain(target.analysis_id);
		const applied = await applyResumeForVerify({
			manifest,
			manifestSha256: manifestSha256(JSON.stringify(manifest, null, 2)),
			limit: 50,
			sender: { send: async () => "job" },
			...ACTOR,
		});
		const mine = applied.applied.find((a) => a.analysisId === target.analysis_id);
		expect(mine).toBeDefined();
		const before = await usageCount();
		const { provider, script } = scripted([
			{ phase: "verify", answer: REJECT },
			{ phase: "repair", answer: { entities: [brandOk] } },
		]);
		expect(await runSentimentJob(payload(run(10)), { resolveProvider: () => provider })).toMatchObject({
			status: "awaiting-review",
			reason: "verifier-rejected",
			paidCalls: 6,
		});
		expect(script.calls).toEqual(["verify"]);
		const kase = await caseOf(run(10));
		expect(kase).toMatchObject({
			status: "awaiting_review",
			review_reason: "verifier-rejected",
			automated_provider_calls: 6,
		});
		expect(kase.unresolved_targets).toEqual([expect.objectContaining({ entityKey: "brand" })]);
		expect(kase.provisional_result?.entities).toEqual([expect.objectContaining({ key: "brand" })]);
		expect(await usageCount()).toBe(before + 1);
		expect(
			(await client.query("SELECT state FROM sentiment_dispatch_permits WHERE id = $1", [mine?.permitId])).rows[0]
				.state,
		).toBe("exhausted");
		// Neither selector re-selects it and a further run spends nothing.
		expect(
			(await selectResumableForVerify(undefined, { reviewReason: "call-limit" })).eligible.map((e) => e.analysisId),
		).not.toContain(target.analysis_id);
		expect((await selectResumableForVerify()).eligible.map((e) => e.analysisId)).not.toContain(target.analysis_id);
		const again = scripted([{ phase: "verify", answer: ACCEPT }]);
		expect(await runSentimentJob(payload(run(10)), { resolveProvider: () => again.provider })).toMatchObject({
			status: "awaiting-review",
			reason: "verifier-rejected",
		});
		expect(again.script.calls).toEqual([]);
	});

	it("the permit never authorizes a second extra verify or a repair: an exhausted permit leaves a parked case parked", async () => {
		const target = await seedLegacyCallLimit(run(11));
		const manifest = await selectResumableForVerify(undefined, { reviewReason: "call-limit" });
		const applied = await applyResumeForVerify({
			manifest,
			manifestSha256: manifestSha256(JSON.stringify(manifest, null, 2)),
			limit: 50,
			sender: { send: async () => "job" },
			...ACTOR,
		});
		const mine = applied.applied.find((a) => a.analysisId === target.analysis_id);
		expect(mine).toBeDefined();
		// Exhaust the permit's verify budget by hand: the workflow must then refuse the over-cap verify and park.
		await client.query(
			`UPDATE sentiment_dispatch_permits SET phase_budget = '{"classify":0,"repair":0,"verify":0}'::jsonb, state = 'exhausted' WHERE id = $1`,
			[mine?.permitId],
		);
		const { provider, script } = scripted([{ phase: "verify", answer: ACCEPT }]);
		expect(await runSentimentJob(payload(run(11)), { resolveProvider: () => provider })).toMatchObject({
			status: "awaiting-review",
			reason: "call-limit",
			paidCalls: 5,
		});
		expect(script.calls).toEqual([]);
		expect((await attemptsOf(run(11))).filter((a) => a.ordinal > 5)).toEqual([]);
	});
});
