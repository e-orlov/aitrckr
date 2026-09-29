/**
 * Runs against the disposable test database: `pnpm -C apps/web
 * test:integration` with DATABASE_URL pointing at it.
 *
 * IT-SNT-VF — ADR Amendment E: aspect claims are independent findings. A
 * reject verdict that objects only to aspect claims drops those claims and
 * persists the rest as verified (live loop, and the offline settlement of
 * already-parked cases). An HTTP 402 refusal is transient, not a contract
 * defect. A verifier-rejected case whose permitted repair was refused unpaid,
 * and the deterministic call-limit parity path, each get one permitted
 * repair+verify pair; an operator may admit exactly one further pair.
 */
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must point at the seeded test stack");

const {
	SENTIMENT_CLASSIFIER_VERSION,
	SENTIMENT_MODEL,
	SENTIMENT_TAXONOMY_VERSION,
	SENTIMENT_VERIFIER_VERSION,
	applyResumeForVerify,
	applyVerifierFilteredSettlements,
	manifestSha256,
	readDispatchState,
	runSentimentJob,
	selectResumableForVerify,
	selectVerifierFilteredSettlements,
	transitionDispatch,
} = await import("@workspace/lib/sentiment");
const { StructuredResearchRequestError } = await import("@workspace/lib/providers/types");
type Provider = import("@workspace/lib/providers/types").Provider;

const ORG = "default";
const BRAND = "sent-vf-brand";
const PROMPT = "5e970011-0000-4000-8000-000000000101";
const run = (i: number) => `5e970011-0000-4000-8000-0000000002${String(i).padStart(2, "0")}`;
const ACTOR = { actor: "it:verifier-filtered", reason: "integration test", correlationId: "IT-SNT-VF" };
/** s0001 brand · s0003 brand · s0006 brand; s0004 is a generic bullet naming no entity. */
const ANSWER = `Wenn du die **Sent VF-Rechtsschutzversicherung** meinst: **Ja, sie kann gut sein – besonders beim Leistungsumfang –, aber sie ist nicht automatisch die beste Wahl für jeden.**
**Dafür spricht:**
- Vergleichstests bewerten den Leistungsumfang der Sent VF positiv.
- Es gibt umfangreiche Leistungen, etwa weltweiten Schutz – je nach Tarif.
**Kurz gesagt:**
Für Rechtsschutz ist die Sent VF grundsätzlich ein seriöser und leistungsstarker Anbieter.`;

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
const coverageAspect = {
	key: "coverage",
	category: "positive" as const,
	score: 75,
	confidence: 0.9,
	evidence: [cite("s0003", "positive")],
};
const serviceAspect = {
	key: "service",
	category: "positive" as const,
	score: 70,
	confidence: 0.8,
	evidence: [cite("s0006", "positive")],
};
const brandWithAspects = { ...brandOk, aspects: [coverageAspect, serviceAspect] };
const brandUnbound = { ...brandOk, evidence: [cite("s0004", "positive")] };
const ACCEPT = { verdict: "accept", issues: [] };
const REJECT_OVERALL = {
	verdict: "reject",
	issues: [{ entityKey: "brand", target: "overall", code: "polarity-mismatch", anchorId: "s0001" }],
};
const REJECT_SERVICE_ASPECT = {
	verdict: "reject",
	issues: [{ entityKey: "brand", target: "service", code: "aspect-misrouted", anchorId: "s0006" }],
};
const refusal = (httpStatus: number) =>
	new StructuredResearchRequestError({
		provider: "openrouter",
		httpStatus,
		errorType: null,
		structured: true,
		carriesOutput: false,
		retryAfterMs: null,
		message: `OpenRouter API error (${httpStatus}): {}`,
	});

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
				generationId: `gen-vf-${Math.random().toString(36).slice(2, 10)}`,
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

const caseOf = async (runId: string) =>
	(
		await client.query<{
			analysis_id: string;
			instance_id: string;
			input_hash: string;
			status: string;
			review_reason: string | null;
			automated_provider_calls: number;
			unresolved_targets: { source: string; reason: string; aspectKey: string | null }[];
			next_attempt_at: string | null;
		}>(
			`SELECT c.analysis_id, c.instance_id, c.input_hash, c.status, c.review_reason, c.automated_provider_calls, c.unresolved_targets, c.next_attempt_at::text
			 FROM sentiment_resolution_cases c JOIN sentiment_analyses a ON a.id = c.analysis_id WHERE a.prompt_run_id = $1`,
			[runId],
		)
	).rows[0];
const analysisOf = async (runId: string) =>
	(
		await client.query<{ id: string; status: string; verified_at: string | null; verifier_version: string | null }>(
			"SELECT id, status, verified_at::text, verifier_version FROM sentiment_analyses WHERE prompt_run_id = $1 AND classifier_version = $2",
			[runId, SENTIMENT_CLASSIFIER_VERSION],
		)
	).rows[0];
const attemptsOf = async (runId: string) =>
	(
		await client.query<{ ordinal: number; phase: string; outcome: string; permit_id: string | null }>(
			`SELECT t.ordinal, t.phase, t.outcome, t.permit_id::text FROM sentiment_provider_attempts t JOIN sentiment_analyses a ON a.id = t.analysis_id WHERE a.prompt_run_id = $1 ORDER BY t.ordinal`,
			[runId],
		)
	).rows;
const aspectsOf = async (runId: string) =>
	(
		await client.query<{ aspect_key: string }>(
			"SELECT x.aspect_key FROM sentiment_aspect_observations x JOIN sentiment_observations o ON o.id = x.observation_id WHERE o.prompt_run_id = $1 ORDER BY 1",
			[runId],
		)
	).rows.map((r) => r.aspect_key);
const filteredOf = async (runId: string) =>
	(
		await client.query<{ aspect_key: string; validation_code: string }>(
			"SELECT f.aspect_key, f.validation_code FROM sentiment_filtered_claims f JOIN sentiment_analyses a ON a.id = f.analysis_id WHERE a.prompt_run_id = $1 ORDER BY 1",
			[runId],
		)
	).rows;
const usageCount = async () =>
	(
		await client.query<{ n: number }>(
			"SELECT count(*)::int AS n FROM usage_events WHERE brand_id = $1 AND event_type LIKE 'sentiment%'",
			[BRAND],
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
async function applyMode(reviewReason: "verifier-rejected" | "call-limit-repair", allowSecondPair = false) {
	const manifest = await selectResumableForVerify(undefined, { reviewReason, allowSecondPair });
	const applied = await applyResumeForVerify({
		manifest,
		manifestSha256: manifestSha256(JSON.stringify(manifest, null, 2)),
		limit: 50,
		sender: { send: async () => "job" },
		...ACTOR,
	});
	expect(applied.drift).toBeNull();
	return { manifest, applied };
}

beforeAll(async () => {
	const host = new URL(DATABASE_URL).hostname;
	if (!["localhost", "127.0.0.1", "::1"].includes(host)) throw new Error(`refusing non-loopback database ${host}`);
	await client.connect();
	const org = await client.query("SELECT id FROM organization WHERE slug = $1", [ORG]);
	if (org.rows.length !== 1) throw new Error("seeded organization missing — not the disposable test database");
	await cleanup();
	await client.query(
		`INSERT INTO brands (id, organization_id, slug, name, website, enabled, onboarded, created_at, updated_at) VALUES ($1, $2, $1, 'Sent VF', 'https://sent-vf.example.test/', true, true, now(), now())`,
		[BRAND, org.rows[0].id],
	);
	await client.query(
		`INSERT INTO prompts (id, brand_id, value, enabled, tags, system_tags, created_at, updated_at) VALUES ($1, $2, 'verifier-filtered prompt', false, '{}', '{unbranded}', now(), now())`,
		[PROMPT, BRAND],
	);
	for (let i = 1; i <= 9; i++) await insertRun(run(i));
	await setDispatch("open");
});

afterAll(async () => {
	await setDispatch("open");
	await cleanup();
	await client.end();
});

describe("IT-SNT-VF-001 verifier-filtered acceptance in the live loop", () => {
	it("a reject that names only an aspect claim drops that claim, records it, and persists the rest as verified — no further call", async () => {
		const { provider, script } = scripted([
			{ phase: "classify", answer: { entities: [brandWithAspects] } },
			{ phase: "verify", answer: REJECT_SERVICE_ASPECT },
		]);
		const before = await usageCount();
		expect(await runSentimentJob(payload(run(1)), { resolveProvider: () => provider })).toMatchObject({
			status: "classified",
			paidCalls: 2,
			filteredClaimCount: 1,
		});
		expect(script.calls).toEqual(["classify", "verify"]);
		expect(await caseOf(run(1))).toMatchObject({ status: "resolved", automated_provider_calls: 2 });
		expect(await analysisOf(run(1))).toMatchObject({
			status: "completed",
			verifier_version: SENTIMENT_VERIFIER_VERSION,
		});
		expect(await aspectsOf(run(1))).toEqual(["coverage"]);
		expect(await filteredOf(run(1))).toEqual([{ aspect_key: "service", validation_code: "verifier:aspect-misrouted" }]);
		expect(await usageCount()).toBe(before + 2);
	});

	it("an overall-level issue is still a rejection: the pair rule repairs and re-verifies as before", async () => {
		const { provider, script } = scripted([
			{ phase: "classify", answer: { entities: [brandWithAspects] } },
			{ phase: "verify", answer: REJECT_OVERALL },
			{ phase: "repair", answer: { entities: [brandWithAspects] } },
			{ phase: "verify", answer: ACCEPT },
		]);
		expect(await runSentimentJob(payload(run(2)), { resolveProvider: () => provider })).toMatchObject({
			status: "classified",
			paidCalls: 4,
		});
		expect(script.calls).toEqual(["classify", "verify", "repair", "verify"]);
		expect(await aspectsOf(run(2))).toEqual(["coverage", "service"]);
	});
});

describe("IT-SNT-VF-002 offline settlement of parked aspect-only rejections", () => {
	it("selects a parked case whose stored verdict objected only to an aspect claim, settles it without any provider request, and excludes overall-level cases", async () => {
		// Park run 3 the pre-Amendment-E way: the verdict's aspect-only issues become the stored targets.
		const parked = scripted([
			{ phase: "classify", answer: { entities: [brandWithAspects] } },
			{ phase: "verify", answer: REJECT_OVERALL },
			{ phase: "repair", answer: { entities: [brandWithAspects] } },
			{ phase: "verify", answer: REJECT_OVERALL },
		]);
		expect(await runSentimentJob(payload(run(3)), { resolveProvider: () => parked.provider })).toMatchObject({
			status: "awaiting-review",
			reason: "verifier-rejected",
		});
		const overallCase = await caseOf(run(3));
		await client.query(`UPDATE sentiment_resolution_cases SET unresolved_targets = $2::jsonb WHERE analysis_id = $1`, [
			overallCase.analysis_id,
			JSON.stringify([
				{
					entityKey: "brand",
					reason: "verifier:aspect-misrouted",
					aspectKey: "service",
					anchorId: "s0006",
					source: "verifier",
				},
			]),
		]);
		const stillOverall = await (async () => {
			const p = scripted([
				{ phase: "classify", answer: { entities: [brandWithAspects] } },
				{ phase: "verify", answer: REJECT_OVERALL },
				{ phase: "repair", answer: { entities: [brandWithAspects] } },
				{ phase: "verify", answer: REJECT_OVERALL },
			]);
			await runSentimentJob(payload(run(4)), { resolveProvider: () => p.provider });
			return caseOf(run(4));
		})();
		const manifest = await selectVerifierFilteredSettlements();
		expect(manifest.eligible.map((e) => e.analysisId)).toContain(overallCase.analysis_id);
		expect(manifest.eligible.find((e) => e.analysisId === overallCase.analysis_id)?.droppedAspects).toEqual([
			{ entityKey: "brand", aspectKey: "service", code: "verifier:aspect-misrouted" },
		]);
		expect(manifest.excluded).toContainEqual({
			analysisId: stillOverall.analysis_id,
			reason: "targets-not-aspect-only",
		});
		const before = await usageCount();
		const attemptsBefore = (await attemptsOf(run(3))).length;
		const result = await applyVerifierFilteredSettlements(manifest, { limit: 50 });
		expect(result.settled).toContainEqual({ analysisId: overallCase.analysis_id, entities: 1, droppedAspects: 1 });
		expect(await caseOf(run(3))).toMatchObject({ status: "resolved" });
		expect(await analysisOf(run(3))).toMatchObject({
			status: "completed",
			verifier_version: SENTIMENT_VERIFIER_VERSION,
		});
		expect(await aspectsOf(run(3))).toEqual(["coverage"]);
		expect(await filteredOf(run(3))).toEqual([{ aspect_key: "service", validation_code: "verifier:aspect-misrouted" }]);
		expect((await attemptsOf(run(3))).length).toBe(attemptsBefore);
		expect(await usageCount()).toBe(before);
		// Settled once; a second run finds nothing for it.
		expect((await selectVerifierFilteredSettlements()).eligible.map((e) => e.analysisId)).not.toContain(
			overallCase.analysis_id,
		);
	});
});

describe("IT-SNT-VF-003 HTTP 402 is a transient refusal", () => {
	it("routes to retry_wait, not contract-defect; the next run completes with no duplicate charge", async () => {
		const { provider } = scripted([
			{ phase: "classify", error: refusal(402) },
			{ phase: "classify", answer: { entities: [brandOk] } },
			{ phase: "verify", answer: ACCEPT },
		]);
		expect(
			await runSentimentJob(payload(run(5)), {
				resolveProvider: () => provider,
				resolutionPolicy: { backoffBaseMs: 50, backoffMaxMs: 200 },
			}),
		).toMatchObject({ status: "retry-wait", consecutiveFailures: 1 });
		expect(await caseOf(run(5))).toMatchObject({ status: "retry_wait", review_reason: null });
		expect(
			await runSentimentJob(payload(run(5)), {
				resolveProvider: () => provider,
				resolutionPolicy: { backoffBaseMs: 50, backoffMaxMs: 200 },
			}),
		).toMatchObject({ status: "classified", paidCalls: 2 });
	});

	it("a verifier-rejected case whose permitted repair was refused unpaid (parked contract-defect) is still selectable and gets its pair", async () => {
		const { provider } = scripted([
			{ phase: "classify", answer: { entities: [brandOk] } },
			{ phase: "verify", answer: REJECT_OVERALL },
			{ phase: "repair", answer: { entities: [brandOk] } },
			{ phase: "verify", answer: REJECT_OVERALL },
		]);
		expect(await runSentimentJob(payload(run(6)), { resolveProvider: () => provider })).toMatchObject({
			status: "awaiting-review",
			reason: "verifier-rejected",
		});
		const rr = await caseOf(run(6));
		// Reproduce the production shape: a permit-bound repair attempt that never answered, case parked as contract-defect.
		const permitId = (
			await client.query<{ id: string }>(
				`INSERT INTO sentiment_dispatch_permits (id, purpose, prompt_run_id, analysis_id, instance_id, input_hash, classifier_version, provider, model, phase_budget, estimated_cost_budget_usd, state, settled_cost_usd, reserved_estimate_usd, expires_at, contract_sha256, issued_by, reason, correlation_id, issued_at)
				 VALUES (gen_random_uuid(), 'resume-repair', $1, $2, $3, $4, $5, 'openrouter', $7, '{"classify":0,"repair":0,"verify":1}'::jsonb, 0.05, 'revoked', 0, 0, now() + interval '1 hour', $6, 'it', 'it', 'it', now()) RETURNING id`,
				[
					run(6),
					rr.analysis_id,
					rr.instance_id,
					rr.input_hash,
					SENTIMENT_CLASSIFIER_VERSION,
					"b".repeat(64),
					SENTIMENT_MODEL,
				],
			)
		).rows[0].id;
		await client.query(
			`INSERT INTO sentiment_provider_attempts (id, analysis_id, instance_id, ordinal, phase, provider, model, generation_id, input_hash, outcome, actual_cost_usd, started_at, finished_at, candidate, permit_id)
			 VALUES (gen_random_uuid(), $1, $2, 5, 'repair', 'openrouter', $3, NULL, $4, 'provider-error', NULL, now(), now(), NULL, $5)`,
			[rr.analysis_id, rr.instance_id, SENTIMENT_MODEL, rr.input_hash, permitId],
		);
		await client.query(
			"UPDATE sentiment_resolution_cases SET review_reason = 'contract-defect' WHERE analysis_id = $1",
			[rr.analysis_id],
		);
		const { manifest, applied } = await applyMode("verifier-rejected");
		expect(manifest.eligible.map((e) => e.analysisId)).toContain(rr.analysis_id);
		expect(applied.applied.map((a) => a.analysisId)).toContain(rr.analysis_id);
		const { provider: p2, script } = scripted([
			{ phase: "repair", answer: { entities: [brandOk] } },
			{ phase: "verify", answer: ACCEPT },
		]);
		expect(await runSentimentJob(payload(run(6)), { resolveProvider: () => p2 })).toMatchObject({
			status: "classified",
			paidCalls: 6,
		});
		expect(script.calls).toEqual(["repair", "verify"]);
	});
});

describe("IT-SNT-VF-004 call-limit-repair and the explicit second pair", () => {
	it("the deterministic parity path gets one permitted repair+verify pair from its latest (refused) candidate", async () => {
		const { provider } = scripted([
			{ phase: "classify", answer: { entities: [brandUnbound] } },
			{ phase: "repair", answer: { entities: [brandUnbound] } },
			{ phase: "repair", answer: { entities: [brandUnbound] } },
			{ phase: "repair", answer: { entities: [brandUnbound] } },
			{ phase: "repair", answer: { entities: [brandUnbound] } },
		]);
		expect(await runSentimentJob(payload(run(7)), { resolveProvider: () => provider })).toMatchObject({
			status: "awaiting-review",
			reason: "call-limit",
		});
		const cl = await caseOf(run(7));
		expect((await selectResumableForVerify(undefined, { reviewReason: "call-limit" })).excluded).toContainEqual({
			analysisId: cl.analysis_id,
			reason: "wrong-call-count",
		});
		const { manifest, applied } = await applyMode("call-limit-repair");
		expect(manifest.eligible.map((e) => e.analysisId)).toContain(cl.analysis_id);
		expect(applied.applied.find((a) => a.analysisId === cl.analysis_id)).toBeDefined();
		const { provider: p2, script } = scripted([
			{ phase: "repair", answer: { entities: [brandOk] } },
			{ phase: "verify", answer: ACCEPT },
		]);
		expect(await runSentimentJob(payload(run(7)), { resolveProvider: () => p2 })).toMatchObject({
			status: "classified",
			paidCalls: 6,
		});
		expect(script.calls).toEqual(["repair", "verify"]);
		expect(script.prompts[0]).toMatch(/does not name this candidate/);
		expect((await attemptsOf(run(7))).filter((a) => a.permit_id !== null).map((a) => a.phase)).toEqual([
			"repair",
			"verify",
		]);
	});

	it("a second pair is admitted only with the explicit operator option, and never a third", async () => {
		const park = scripted([
			{ phase: "classify", answer: { entities: [brandOk] } },
			{ phase: "verify", answer: REJECT_OVERALL },
			{ phase: "repair", answer: { entities: [brandOk] } },
			{ phase: "verify", answer: REJECT_OVERALL },
		]);
		await runSentimentJob(payload(run(8)), { resolveProvider: () => park.provider });
		const rr = await caseOf(run(8));
		await applyMode("verifier-rejected");
		const first = scripted([
			{ phase: "repair", answer: { entities: [brandOk] } },
			{ phase: "verify", answer: REJECT_OVERALL },
		]);
		expect(await runSentimentJob(payload(run(8)), { resolveProvider: () => first.provider })).toMatchObject({
			status: "awaiting-review",
			reason: "verifier-rejected",
			paidCalls: 6,
		});
		expect((await selectResumableForVerify(undefined, { reviewReason: "verifier-rejected" })).excluded).toContainEqual({
			analysisId: rr.analysis_id,
			reason: "pair-already-spent",
		});
		const second = await selectResumableForVerify(undefined, {
			reviewReason: "verifier-rejected",
			allowSecondPair: true,
		});
		expect(second.allowSecondPair).toBe(true);
		expect(second.eligible.map((e) => e.analysisId)).toContain(rr.analysis_id);
		const applied = await applyResumeForVerify({
			manifest: second,
			manifestSha256: manifestSha256(JSON.stringify(second, null, 2)),
			limit: 50,
			sender: { send: async () => "job" },
			...ACTOR,
		});
		expect(applied.applied.map((a) => a.analysisId)).toContain(rr.analysis_id);
		const again = scripted([
			{ phase: "repair", answer: { entities: [brandOk] } },
			{ phase: "verify", answer: REJECT_OVERALL },
		]);
		expect(await runSentimentJob(payload(run(8)), { resolveProvider: () => again.provider })).toMatchObject({
			status: "awaiting-review",
			reason: "verifier-rejected",
			paidCalls: 8,
		});
		const third = await selectResumableForVerify(undefined, {
			reviewReason: "verifier-rejected",
			allowSecondPair: true,
		});
		expect(third.excluded).toContainEqual({ analysisId: rr.analysis_id, reason: "pair-already-spent" });
	});
});
