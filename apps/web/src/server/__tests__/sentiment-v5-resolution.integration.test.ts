/**
 * Runs against the disposable test database: `pnpm -C apps/web
 * test:integration` with DATABASE_URL pointing at it.
 *
 * V5-ERC scenarios 1–18 (ADR-SENT-01-GROUNDED-COMPLETION, Amendment B) on real
 * Postgres: every eligible run resolves to one verified completed analysis
 * through classify → deterministic assessment → targeted repair → independent
 * verifier → atomic persistence; failures are routing states with a durable
 * resolution case and an attempt ledger; the automatic policy is bounded and
 * hands over to `awaiting_review`; crashes and concurrency never buy a hidden
 * duplicate call; the read selector never mixes versions.
 */
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must point at the seeded test stack");

const {
	RESOLUTION_POLICY,
	SENTIMENT_CLASSIFIER_VERSION,
	SENTIMENT_DETECTOR_VERSION,
	SENTIMENT_MODEL,
	SENTIMENT_TAXONOMY_VERSION,
	SENTIMENT_VERIFIER_VERSION,
	applyAdjudication,
	adjudicationTemplate,
	listUnresolvedCases,
	persistClassification,
	runSentimentJob,
	selectedSentimentAnalyses,
	sentimentInputHash,
	sentimentProviderResultSchema,
} = await import("@workspace/lib/sentiment");
const { loadSentimentEvidence, loadSentimentOverview } = await import("@/server/sentiment-load");
const { StructuredResearchRequestError } = await import("@workspace/lib/providers/types");
type Provider = import("@workspace/lib/providers/types").Provider;
type JobDeps = import("@workspace/lib/sentiment").SentimentJobDeps;

const ORG = "default";
const BRAND = "sent-v5-erc-brand";
const ALPHA = "5e970007-0000-4000-8000-00000000000a";
const PROMPT = "5e970007-0000-4000-8000-000000000101";
const run = (i: number) => `5e970007-0000-4000-8000-0000000002${String(i).padStart(2, "0")}`;

/** s0001 brand · s0002 label · s0003 brand · s0004 generic · s0005 label · s0006/s0007 generic caveats · s0008 label · s0009 brand. */
const BRAND_ANSWER = `Wenn du die **Sent V5 ERC-Rechtsschutzversicherung** meinst: **Ja, sie kann gut sein – besonders beim Leistungsumfang –, aber sie ist nicht automatisch die beste Wahl für jeden.**

**Dafür spricht:**
- Vergleichstests bewerten den Leistungsumfang der Sent V5 ERC positiv.
- Es gibt umfangreiche Leistungen, etwa weltweiten Schutz – je nach Tarif.

**Worauf du achten solltest:**
- Tarife unterscheiden sich stark bei Wartezeit, Selbstbeteiligung und Ausschlüssen.
- Ein Premium-Tarif kann deutlich teurer sein als ein ausreichender Basistarif.

**Kurz gesagt:**
Für Rechtsschutz ist die Sent V5 ERC grundsätzlich ein seriöser und leistungsstarker Anbieter.`;
/** s0001 names the brand only; s0002 names Alpha only. */
const TWO_ANSWER = "Sent V5 ERC offers a solid service.\n\nAlpha is cheap.";

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
		await client.query<{
			id: string;
			status: string;
			attempts: number;
			error_code: string | null;
			verifier_version: string | null;
			verified_at: string | null;
		}>(
			"SELECT id, status, attempts, error_code, verifier_version, verified_at::text FROM sentiment_analyses WHERE prompt_run_id = $1 AND classifier_version = $2",
			[runId, SENTIMENT_CLASSIFIER_VERSION],
		)
	).rows[0];
const caseOf = async (runId: string) =>
	(
		await client.query<{
			status: string;
			automated_provider_calls: number;
			total_actual_cost_usd: string;
			unresolved_targets: unknown[];
			provisional_result: unknown;
			next_attempt_at: string | null;
		}>(
			`SELECT c.status, c.automated_provider_calls, c.total_actual_cost_usd::text, c.unresolved_targets, c.provisional_result, c.next_attempt_at::text
			 FROM sentiment_resolution_cases c JOIN sentiment_analyses a ON a.id = c.analysis_id WHERE a.prompt_run_id = $1`,
			[runId],
		)
	).rows[0];
const attemptsOf = async (runId: string) =>
	(
		await client.query<{
			ordinal: number;
			phase: string;
			outcome: string;
			generation_id: string | null;
			actual_cost_usd: string | null;
		}>(
			`SELECT t.ordinal, t.phase, t.outcome, t.generation_id, t.actual_cost_usd::text FROM sentiment_provider_attempts t JOIN sentiment_analyses a ON a.id = t.analysis_id WHERE a.prompt_run_id = $1 ORDER BY t.ordinal`,
			[runId],
		)
	).rows;
const rowsOf = async (runId: string) => ({
	observations: await count("sentiment_observations WHERE prompt_run_id = $1", [runId]),
	aspects: await count(
		"sentiment_aspect_observations a JOIN sentiment_observations o ON o.id = a.observation_id WHERE o.prompt_run_id = $1",
		[runId],
	),
	filtered: await count(
		"sentiment_filtered_claims c JOIN sentiment_analyses s ON s.id = c.analysis_id WHERE s.prompt_run_id = $1",
		[runId],
	),
});

const cite = (anchorId: string, polarity: "positive" | "negative" | "neutral") => ({ anchorId, polarity });
const positive = (score: number, ...ids: string[]) => ({
	category: "positive",
	score,
	confidence: 0.9,
	evidence: ids.map((i) => cite(i, "positive")),
});
const negative = (score: number, ...ids: string[]) => ({
	category: "negative",
	score,
	confidence: 0.8,
	evidence: ids.map((i) => cite(i, "negative")),
});
const brandOk = (aspects: unknown[] = []) => ({ key: "brand", ...positive(70, "s0001", "s0009"), aspects });
const brandUnbound = { key: "brand", ...positive(70, "s0004", "s0007"), aspects: [] };
const ACCEPT = { verdict: "accept", issues: [] };

type Step = {
	phase: "classify" | "repair" | "verify";
	answer?: unknown;
	error?: Error;
	costUsd?: number;
	hold?: Promise<void>;
};
type Script = { steps: Step[]; calls: { phase: string; prompt: string }[] };

/** A provider double that serves a fixed script, asserting each call's phase from the prompt; any deviation throws. */
function scripted(steps: Step[]): { provider: Provider; script: Script } {
	const script: Script = { steps: [...steps], calls: [] };
	const provider = {
		id: "fake-openrouter",
		name: "Fake",
		access: "api",
		isConfigured: () => true,
		async runStructuredResearch<T>({
			prompt,
			schema,
			webSearch,
		}: {
			prompt: string;
			schema: { parse: (v: unknown) => T };
			webSearch?: boolean;
		}) {
			const phase = prompt.startsWith("You are an independent verifier")
				? "verify"
				: prompt.startsWith("You are repairing")
					? "repair"
					: "classify";
			script.calls.push({ phase, prompt });
			const step = script.steps.shift();
			if (!step) throw new Error(`unscripted ${phase} call`);
			if (step.phase !== phase) throw new Error(`expected ${step.phase}, got ${phase}`);
			if (phase !== "classify" && webSearch !== false) throw new Error(`${phase} must not use web search`);
			if (step.hold) await step.hold;
			if (step.error) throw step.error;
			return {
				object: schema.parse(step.answer),
				modelVersion: SENTIMENT_MODEL,
				generationId: `gen-erc-${script.calls.length}-${Math.random().toString(36).slice(2, 8)}`,
				usage: {
					inputTokens: 5000,
					outputTokens: 800,
					reasoningTokens: 200,
					costUsd: step.costUsd ?? 0.02,
					webSearchRequests: phase === "classify" ? 1 : 0,
					webSearchRequestsConflict: false,
				},
			};
		},
	} as unknown as Provider;
	return { provider, script };
}

const fast: JobDeps["resolutionPolicy"] = { backoffBaseMs: 50, backoffMaxMs: 200 };

async function insertRun(id: string, answer: string, minutesAgo: number) {
	await client.query(
		`INSERT INTO prompt_runs (id, prompt_id, brand_id, model, provider, version, web_search_enabled, raw_output, brand_mentioned, competitors_mentioned, created_at)
		 VALUES ($1, $2, $3, 'chatgpt', 'openrouter', 'v', true, $4, true, '{}', now() - ($5 || ' minutes')::interval)`,
		[id, PROMPT, BRAND, JSON.stringify({ choices: [{ message: { content: answer } }] }), String(minutesAgo)],
	);
}

async function seedOld(runId: string, version: string, status: "completed" | "failed" | "pending", aspects: string[]) {
	await client.query(
		`INSERT INTO sentiment_detections (prompt_run_id, brand_id, detector_version, status, mention_count) VALUES ($1, $2, $3, 'mentions', 1) ON CONFLICT DO NOTHING`,
		[runId, BRAND, SENTIMENT_DETECTOR_VERSION],
	);
	const mention = await client.query<{ id: string }>(
		`INSERT INTO prompt_run_entity_mentions (prompt_run_id, brand_id, entity_type, competitor_id, entity_key, entity_name, detector_version, matched_terms)
		 VALUES ($1, $2, 'brand', NULL, 'brand', 'Sent V5 ERC', $3, '{"sent v5 erc"}') ON CONFLICT (prompt_run_id, entity_key) DO UPDATE SET entity_name = EXCLUDED.entity_name RETURNING id`,
		[runId, BRAND, SENTIMENT_DETECTOR_VERSION],
	);
	const analysis = await client.query<{ id: string }>(
		// Directly seeded v5 rows stay unverified on purpose: only the job's verified path may make a v5 row readable.
		`INSERT INTO sentiment_analyses (prompt_run_id, brand_id, classifier_version, taxonomy_version, status, completed_at) VALUES ($1, $2, $3, $4, $5, CASE WHEN $5 IN ('completed','failed') THEN now() ELSE NULL END) RETURNING id`,
		[runId, BRAND, version, SENTIMENT_TAXONOMY_VERSION, status],
	);
	if (status !== "completed") return analysis.rows[0].id;
	const observation = await client.query<{ id: string }>(
		`INSERT INTO sentiment_observations (analysis_id, mention_id, prompt_run_id, brand_id, entity_type, competitor_id, entity_key, score, category, confidence, evidence)
		 VALUES ($1, $2, $3, $4, 'brand', NULL, 'brand', 30, 'negative', 0.9, $5::jsonb) RETURNING id`,
		[
			analysis.rows[0].id,
			mention.rows[0].id,
			runId,
			BRAND,
			JSON.stringify([{ quote: "Sent V5 ERC", start: 0, end: 11, polarity: "negative" }]),
		],
	);
	for (const key of aspects) {
		await client.query(
			`INSERT INTO sentiment_aspect_observations (observation_id, taxonomy_version, aspect_key, aspect_label, score, category, confidence, evidence) VALUES ($1, $2, $3, $3, 25, 'negative', 0.8, $4::jsonb)`,
			[
				observation.rows[0].id,
				SENTIMENT_TAXONOMY_VERSION,
				key,
				JSON.stringify([{ quote: "Sent V5 ERC", start: 0, end: 11, polarity: "negative" }]),
			],
		);
	}
	return analysis.rows[0].id;
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
		`INSERT INTO brands (id, organization_id, slug, name, website, enabled, onboarded, created_at, updated_at) VALUES ($1, $2, $1, 'Sent V5 ERC', 'https://sent-v5-erc.example.test/', true, true, now(), now())`,
		[BRAND, org.rows[0].id],
	);
	await client.query(
		`INSERT INTO competitors (id, brand_id, name, domains, aliases, active, removed_at, created_at, updated_at) VALUES ($1, $2, 'Alpha', '{alpha.example.test}', '{}', true, NULL, now(), now())`,
		[ALPHA, BRAND],
	);
	await client.query(
		`INSERT INTO prompts (id, brand_id, value, enabled, tags, system_tags, created_at, updated_at) VALUES ($1, $2, 'ERC prompt', false, '{}', '{unbranded}', now(), now())`,
		[PROMPT, BRAND],
	);
	for (let i = 1; i <= 20; i++) await insertRun(run(i), i === 3 || i === 13 ? TWO_ANSWER : BRAND_ANSWER, 200 - i);
});

afterAll(async () => {
	await cleanup();
	await client.end();
});

async function expectVerifiedCompleted(
	runId: string,
	expected: { aspects: number; filtered: number; paidCalls: number },
) {
	const analysis = await analysisOf(runId);
	expect(analysis).toMatchObject({
		status: "completed",
		error_code: null,
		verifier_version: SENTIMENT_VERIFIER_VERSION,
	});
	expect(analysis.verified_at).not.toBeNull();
	expect(await rowsOf(runId)).toEqual({
		observations: expect.any(Number),
		aspects: expected.aspects,
		filtered: expected.filtered,
	});
	const c = await caseOf(runId);
	expect(c).toMatchObject({ status: "resolved", automated_provider_calls: expected.paidCalls });
	const attempts = await attemptsOf(runId);
	expect(attempts.filter((a) => a.generation_id !== null)).toHaveLength(expected.paidCalls);
}

describe("S1 initial valid → verifier accept → completed_verified", () => {
	it("two paid calls, one attempt-ledger row each, one usage event each, observations persisted only after ACCEPT", async () => {
		const { provider, script } = scripted([
			{ phase: "classify", answer: { entities: [brandOk([{ key: "coverage", ...positive(80, "s0003") }])] } },
			{ phase: "verify", answer: ACCEPT },
		]);
		const outcome = await runSentimentJob(payload(run(1)), { resolveProvider: () => provider, resolutionPolicy: fast });
		expect(outcome).toMatchObject({
			status: "classified",
			verified: true,
			verifierVersion: SENTIMENT_VERIFIER_VERSION,
			paidCalls: 2,
			repairs: 0,
			verifierRejections: 0,
			filteredClaimCount: 0,
		});
		expect(script.calls.map((c) => c.phase)).toEqual(["classify", "verify"]);
		await expectVerifiedCompleted(run(1), { aspects: 1, filtered: 0, paidCalls: 2 });
		expect((await attemptsOf(run(1))).map((a) => `${a.ordinal}:${a.phase}:${a.outcome}`)).toEqual([
			"1:classify:accepted",
			"2:verify:accepted",
		]);
		expect(
			await count("usage_events WHERE brand_id = $1 AND prompt_id = $2 AND event_type = 'sentiment_classification'", [
				BRAND,
				PROMPT,
			]),
		).toBe(2);
		expect(await runSentimentJob(payload(run(1)), { resolveProvider: () => provider })).toEqual({
			status: "already-completed",
		});
	});
});

describe("S2 invalid overall → targeted repair → verifier accept", () => {
	it("the unbound overall becomes a repair target; the repair carries only that key; completed after 3 paid calls", async () => {
		const { provider, script } = scripted([
			{ phase: "classify", answer: { entities: [brandUnbound] } },
			{ phase: "repair", answer: { entities: [brandOk()] } },
			{ phase: "verify", answer: ACCEPT },
		]);
		const outcome = await runSentimentJob(payload(run(2)), { resolveProvider: () => provider, resolutionPolicy: fast });
		expect(outcome).toMatchObject({
			status: "classified",
			verified: true,
			paidCalls: 3,
			repairs: 1,
			verifierRejections: 0,
		});
		expect(script.calls[1].prompt).toContain("entity-ungrounded");
		await expectVerifiedCompleted(run(2), { aspects: 0, filtered: 0, paidCalls: 3 });
		expect((await attemptsOf(run(2))).map((a) => `${a.phase}:${a.outcome}`)).toEqual([
			"classify:rejected",
			"repair:accepted",
			"verify:accepted",
		]);
	});
});

describe("S3 entity swap → repair → completed", () => {
	it("both swapped entities are repaired in one targeted call; accepted entities are never re-requested", async () => {
		const { provider, script } = scripted([
			{
				phase: "classify",
				answer: {
					entities: [
						{ key: "brand", ...positive(75, "s0002"), aspects: [] },
						{ key: ALPHA, ...positive(75, "s0001"), aspects: [] },
					],
				},
			},
			{
				phase: "repair",
				answer: {
					entities: [
						{ key: "brand", ...positive(75, "s0001"), aspects: [] },
						{ key: ALPHA, ...positive(75, "s0002"), aspects: [] },
					],
				},
			},
			{ phase: "verify", answer: ACCEPT },
		]);
		const outcome = await runSentimentJob(payload(run(3)), { resolveProvider: () => provider, resolutionPolicy: fast });
		expect(outcome).toMatchObject({ status: "classified", entities: 2, paidCalls: 3, repairs: 1 });
		expect(script.calls[1].prompt).toContain(`key "${ALPHA}"`);
		await expectVerifiedCompleted(run(3), { aspects: 0, filtered: 0, paidCalls: 3 });
	});
});

describe("S4 structurally valid semantic misclassification → verifier rejects → repair → completed", () => {
	it("the verifier's issue routes the entity to repair; the second verification accepts", async () => {
		const { provider, script } = scripted([
			{ phase: "classify", answer: { entities: [brandOk()] } },
			{
				phase: "verify",
				answer: {
					verdict: "reject",
					issues: [{ entityKey: "brand", target: "overall", code: "polarity-mismatch", anchorId: "s0001" }],
				},
			},
			{
				phase: "repair",
				answer: {
					entities: [
						{
							key: "brand",
							category: "mixed",
							score: 50,
							confidence: 0.8,
							positiveEvidence: [cite("s0003", "positive")],
							negativeEvidence: [cite("s0001", "negative")],
							aspects: [],
						},
					],
				},
			},
			{ phase: "verify", answer: ACCEPT },
		]);
		const outcome = await runSentimentJob(payload(run(4)), { resolveProvider: () => provider, resolutionPolicy: fast });
		expect(outcome).toMatchObject({ status: "classified", paidCalls: 4, repairs: 1, verifierRejections: 1 });
		expect(script.calls[2].prompt).toContain("verifier:polarity-mismatch");
		await expectVerifiedCompleted(run(4), { aspects: 0, filtered: 0, paidCalls: 4 });
		expect(
			(await client.query("SELECT category FROM sentiment_observations WHERE prompt_run_id = $1", [run(4)])).rows,
		).toEqual([{ category: "mixed" }]);
	});
});

describe("S5 / S6 optional aspects are filtered locally and never trigger repair", () => {
	it("S5 one invalid aspect: filtered, no repair, verifier accepts the remaining result", async () => {
		const { provider, script } = scripted([
			{
				phase: "classify",
				answer: {
					entities: [
						brandOk([
							{ key: "coverage", ...positive(80, "s0003") },
							{ key: "price", ...negative(30, "s0007") },
						]),
					],
				},
			},
			{ phase: "verify", answer: ACCEPT },
		]);
		const outcome = await runSentimentJob(payload(run(5)), { resolveProvider: () => provider, resolutionPolicy: fast });
		expect(outcome).toMatchObject({ status: "classified", paidCalls: 2, repairs: 0, filteredClaimCount: 1 });
		expect(script.calls.map((c) => c.phase)).toEqual(["classify", "verify"]);
		expect(script.calls[1].prompt).not.toContain('"price"');
		await expectVerifiedCompleted(run(5), { aspects: 1, filtered: 1, paidCalls: 2 });
	});

	it("S6 every aspect invalid: completed overall-only, four audit rows, no repair", async () => {
		const { provider } = scripted([
			{
				phase: "classify",
				answer: {
					entities: [
						brandOk([
							{ key: "price", ...negative(30, "s0007") },
							{ key: "coverage", ...positive(80, "s0006") },
							{ key: "service", ...positive(70, "s0004") },
							{ key: "other", ...positive(70, "s0002") },
						]),
					],
				},
			},
			{ phase: "verify", answer: ACCEPT },
		]);
		expect(
			await runSentimentJob(payload(run(6)), { resolveProvider: () => provider, resolutionPolicy: fast }),
		).toMatchObject({ status: "classified", paidCalls: 2, filteredClaimCount: 4 });
		await expectVerifiedCompleted(run(6), { aspects: 0, filtered: 4, paidCalls: 2 });
	});
});

describe("S7 first repair invalid, second repair valid", () => {
	it("completed after classify + 2 repairs + verify = 4 paid calls; the ledger shows the rejected repair", async () => {
		const { provider } = scripted([
			{ phase: "classify", answer: { entities: [brandUnbound] } },
			{ phase: "repair", answer: { entities: [brandUnbound] } },
			{ phase: "repair", answer: { entities: [brandOk()] } },
			{ phase: "verify", answer: ACCEPT },
		]);
		expect(
			await runSentimentJob(payload(run(7)), { resolveProvider: () => provider, resolutionPolicy: fast }),
		).toMatchObject({ status: "classified", paidCalls: 4, repairs: 2 });
		expect((await attemptsOf(run(7))).map((a) => `${a.phase}:${a.outcome}`)).toEqual([
			"classify:rejected",
			"repair:rejected",
			"repair:accepted",
			"verify:accepted",
		]);
	});
});

describe("S8 transient provider error → bounded backoff → completed", () => {
	it("a typed 503 provider_overloaded refusal is an unpaid attempt, the case waits, the next job run completes; no duplicate charge", async () => {
		const { provider } = scripted([
			{
				phase: "classify",
				error: new StructuredResearchRequestError({
					provider: "openrouter",
					httpStatus: 503,
					errorType: "provider_overloaded",
					structured: true,
					carriesOutput: false,
					retryAfterMs: null,
					message: "OpenRouter API error (503): Provider returned error: overloaded",
				}),
			},
			{ phase: "classify", answer: { entities: [brandOk()] } },
			{ phase: "verify", answer: ACCEPT },
		]);
		expect(
			await runSentimentJob(payload(run(8)), { resolveProvider: () => provider, resolutionPolicy: fast }),
		).toMatchObject({ status: "retry-wait", consecutiveFailures: 1 });
		let c = await caseOf(run(8));
		expect(c).toMatchObject({ status: "retry_wait", automated_provider_calls: 0 });
		expect(c.next_attempt_at).not.toBeNull();
		expect((await attemptsOf(run(8))).map((a) => `${a.phase}:${a.outcome}:${a.generation_id}`)).toEqual([
			"classify:provider-error:null",
		]);
		expect(await count("usage_events WHERE brand_id = $1 AND prompt_id = $2", [BRAND, PROMPT])).toBeGreaterThan(0);
		const before = await count("usage_events WHERE brand_id = $1", [BRAND]);
		expect(
			await runSentimentJob(payload(run(8)), { resolveProvider: () => provider, resolutionPolicy: fast }),
		).toMatchObject({ status: "classified", paidCalls: 2 });
		c = await caseOf(run(8));
		expect(c.status).toBe("resolved");
		expect(await count("usage_events WHERE brand_id = $1", [BRAND])).toBe(before + 2);
	});
});

describe("S9 cost/call ceiling → awaiting_review", () => {
	it("five paid calls exhaust the policy; the case stays open as awaiting_review with the provisional result; nothing persisted", async () => {
		const { provider, script } = scripted([
			{ phase: "classify", answer: { entities: [brandUnbound] } },
			{ phase: "repair", answer: { entities: [brandUnbound] } },
			{ phase: "repair", answer: { entities: [brandUnbound] } },
			{ phase: "repair", answer: { entities: [brandUnbound] } },
			{ phase: "repair", answer: { entities: [brandUnbound] } },
			{ phase: "repair", answer: { entities: [brandOk()] } },
		]);
		const outcome = await runSentimentJob(payload(run(9)), { resolveProvider: () => provider, resolutionPolicy: fast });
		expect(outcome).toMatchObject({
			status: "awaiting-review",
			paidCalls: RESOLUTION_POLICY.maxPaidCalls,
			unresolved: 1,
		});
		expect(script.steps).toHaveLength(1);
		const c = await caseOf(run(9));
		expect(c).toMatchObject({ status: "awaiting_review", automated_provider_calls: 5 });
		expect(Number(c.total_actual_cost_usd)).toBeCloseTo(0.1, 6);
		expect(c.unresolved_targets).toHaveLength(1);
		expect(c.provisional_result).not.toBeNull();
		expect(JSON.stringify(c.provisional_result)).not.toMatch(/Rechtsschutz|Premium-Tarif/);
		expect((await analysisOf(run(9))).status).not.toBe("completed");
		expect(await rowsOf(run(9))).toEqual({ observations: 0, aspects: 0, filtered: 0 });
		// A further automatic run makes no call and keeps the review item.
		expect(
			await runSentimentJob(payload(run(9)), { resolveProvider: () => provider, resolutionPolicy: fast }),
		).toMatchObject({ status: "awaiting-review" });
		expect(script.steps).toHaveLength(1);
		expect((await listUnresolvedCases()).some((u) => u.promptRunId === run(9) && u.status === "awaiting_review")).toBe(
			true,
		);
	});

	it("the cost ceiling alone also hands over", async () => {
		const { provider } = scripted([
			{ phase: "classify", answer: { entities: [brandUnbound] }, costUsd: 0.08 },
			{ phase: "repair", answer: { entities: [brandUnbound] }, costUsd: 0.08 },
			{ phase: "repair", answer: { entities: [brandOk()] } },
		]);
		expect(
			await runSentimentJob(payload(run(10)), { resolveProvider: () => provider, resolutionPolicy: fast }),
		).toMatchObject({ status: "awaiting-review", paidCalls: 2 });
		expect((await caseOf(run(10))).status).toBe("awaiting_review");
	});
});

describe("S10 / S11 human adjudication", () => {
	it("S11 an invalid decision (foreign-only overall) is refused by the same deterministic validators; the case stays unresolved", async () => {
		const template = await adjudicationTemplate(run(9));
		expect(JSON.stringify(template)).not.toMatch(/Rechtsschutz|Premium-Tarif/);
		expect(template).toMatchObject({
			promptRunId: run(9),
			status: "awaiting_review",
			unresolvedTargets: [expect.objectContaining({ entityKey: "brand" })],
		});
		const refused = await applyAdjudication({
			analysisId: template.analysisId,
			inputHash: template.inputHash,
			decidedBy: "operator-test",
			entities: [{ key: "brand", ...positive(70, "s0004"), aspects: [] }],
		});
		expect(refused).toMatchObject({ status: "refused", code: "entity-ungrounded" });
		expect((await caseOf(run(9))).status).toBe("awaiting_review");
		expect(await rowsOf(run(9))).toEqual({ observations: 0, aspects: 0, filtered: 0 });
		const stale = await applyAdjudication({
			analysisId: template.analysisId,
			inputHash: "0".repeat(64),
			decidedBy: "operator-test",
			entities: [brandOk()],
		});
		expect(stale).toMatchObject({ status: "refused", code: "input-hash-drift" });
	});

	it("S10 a valid decision passes the deterministic validators and lands through the same atomic persistence path", async () => {
		const template = await adjudicationTemplate(run(9));
		const applied = await applyAdjudication({
			analysisId: template.analysisId,
			inputHash: template.inputHash,
			decidedBy: "operator-test",
			entities: [
				{
					key: "brand",
					...positive(70, "s0001", "s0009"),
					aspects: [
						{ key: "coverage", ...positive(80, "s0003") },
						{ key: "price", ...negative(30, "s0007") },
					],
				},
			],
		});
		expect(applied).toMatchObject({ status: "applied", filteredClaimCount: 1 });
		const analysis = await analysisOf(run(9));
		expect(analysis).toMatchObject({ status: "completed", verifier_version: "human-adjudication-v1" });
		expect(await rowsOf(run(9))).toEqual({ observations: 1, aspects: 1, filtered: 1 });
		expect((await caseOf(run(9))).status).toBe("resolved");
		expect((await listUnresolvedCases()).some((u) => u.promptRunId === run(9))).toBe(false);
		// No provider call was made by adjudication.
		expect((await attemptsOf(run(9))).filter((a) => a.generation_id !== null)).toHaveLength(5);
	});
});

describe("S12 / S13 crash safety", () => {
	it("S12 a crash before any request leaves an open case with no attempt row; the next run completes normally", async () => {
		const boom = () => {
			throw new Error("process died before the request");
		};
		await expect(
			runSentimentJob(payload(run(12)), { resolveProvider: boom as never, resolutionPolicy: fast }),
		).rejects.toBeDefined();
		expect((await caseOf(run(12))).status).not.toBe("resolved");
		expect(await attemptsOf(run(12))).toEqual([]);
		const { provider } = scripted([
			{ phase: "classify", answer: { entities: [brandOk()] } },
			{ phase: "verify", answer: ACCEPT },
		]);
		expect(
			await runSentimentJob(payload(run(12)), { resolveProvider: () => provider, resolutionPolicy: fast }),
		).toMatchObject({ status: "classified", paidCalls: 2 });
	});

	it("S13 an attempt left in `sending` (unknown provider outcome) blocks automatic calls: awaiting_reconciliation, zero calls", async () => {
		const { provider, script } = scripted([
			{
				phase: "classify",
				answer: {
					entities: [
						{ key: "brand", ...positive(75, "s0001"), aspects: [] },
						{ key: ALPHA, ...positive(75, "s0002"), aspects: [] },
					],
				},
			},
		]);
		// Prepare the analysis + case + a dangling intent row as a crashed worker would leave them.
		const first = await runSentimentJob(
			payload(run(13)),
			{
				resolveProvider: () =>
					({
						...provider,
						runStructuredResearch: ({ signal }: { signal?: AbortSignal }) =>
							new Promise<never>((_resolve, reject) => {
								signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
							}),
					}) as never,
				resolutionPolicy: fast,
			},
			{ signal: AbortSignal.timeout(300) },
		).catch((e: unknown) => e);
		expect(first).toBeDefined();
		const analysis = await analysisOf(run(13));
		await client.query(
			"UPDATE sentiment_provider_attempts SET outcome = 'sending', finished_at = NULL WHERE analysis_id = $1",
			[analysis.id],
		);
		const outcome = await runSentimentJob(payload(run(13)), {
			resolveProvider: () => provider,
			resolutionPolicy: fast,
		});
		expect(outcome).toMatchObject({ status: "awaiting-reconciliation" });
		expect(script.calls).toEqual([]);
		expect((await caseOf(run(13))).status).toBe("awaiting_reconciliation");
		expect(
			(await listUnresolvedCases()).some((u) => u.promptRunId === run(13) && u.status === "awaiting_reconciliation"),
		).toBe(true);
	});
});

describe("S14 concurrent workers → one active resolution owner", () => {
	it("two simultaneous jobs: exactly one classifies and verifies; the other returns claimed-elsewhere; two paid calls in total", async () => {
		let release!: () => void;
		const hold = new Promise<void>((r) => {
			release = r;
		});
		const { provider, script } = scripted([
			{ phase: "classify", answer: { entities: [brandOk()] }, hold },
			{ phase: "verify", answer: ACCEPT },
		]);
		const a = runSentimentJob(payload(run(14)), { resolveProvider: () => provider, resolutionPolicy: fast });
		await new Promise((r) => setTimeout(r, 300));
		const b = await runSentimentJob(payload(run(14)), { resolveProvider: () => provider, resolutionPolicy: fast });
		expect(b).toMatchObject({ status: "claimed-elsewhere" });
		release();
		expect(await a).toMatchObject({ status: "classified", paidCalls: 2 });
		expect(script.calls.map((c) => c.phase)).toEqual(["classify", "verify"]);
		expect((await attemptsOf(run(14))).filter((t) => t.generation_id !== null)).toHaveLength(2);
	});
});

describe("S15 persistence failure → no partial rows, case unresolved", () => {
	it("a failing audit write rolls everything back; the analysis is not completed; the case is not resolved; the paid calls stay attributed once", async () => {
		const { provider } = scripted([
			{ phase: "classify", answer: { entities: [brandOk([{ key: "price", ...negative(30, "s0007") }])] } },
			{ phase: "verify", answer: ACCEPT },
		]);
		const persist: typeof persistClassification = (args) =>
			persistClassification({
				...args,
				classification: {
					...args.classification,
					filteredClaims: args.classification.filteredClaims.map((c) => ({ ...c, code: "not-a-code" as never })),
				},
			});
		const before = await count("usage_events WHERE brand_id = $1", [BRAND]);
		await expect(
			runSentimentJob(payload(run(15)), { resolveProvider: () => provider, resolutionPolicy: fast, persist }),
		).rejects.toMatchObject({ kind: "store", code: "persistence" });
		expect((await analysisOf(run(15))).status).not.toBe("completed");
		expect(await rowsOf(run(15))).toEqual({ observations: 0, aspects: 0, filtered: 0 });
		expect((await caseOf(run(15))).status).not.toBe("resolved");
		expect(await count("usage_events WHERE brand_id = $1", [BRAND])).toBe(before + 2);
	});
});

describe("S16 / S17 read selection", () => {
	const scope = { brandId: BRAND, lookback: "1m" as const, timezone: "UTC" };

	it("S16 failed, pending and unresolved (awaiting_review) v5 never hide a completed v4/v3 analysis", async () => {
		await seedOld(run(16), "sent-classifier-v4", "completed", ["price"]);
		await seedOld(run(16), "sent-classifier-v5", "failed", []);
		await seedOld(run(17), "sent-classifier-v3", "completed", ["service"]);
		await seedOld(run(17), "sent-classifier-v5", "pending", []);
		await seedOld(run(18), "sent-classifier-v3", "completed", []);
		const { provider } = scripted([
			{ phase: "classify", answer: { entities: [brandUnbound] } },
			{ phase: "repair", answer: { entities: [brandUnbound] }, costUsd: 0.13 },
		]);
		expect(
			await runSentimentJob(payload(run(18)), { resolveProvider: () => provider, resolutionPolicy: fast }),
		).toMatchObject({ status: "awaiting-review" });
		const selected = await selectedSentimentAnalyses();
		expect(selected.filter((s) => s.promptRunId === run(16))).toMatchObject([
			{ classifierVersion: "sent-classifier-v4" },
		]);
		expect(selected.filter((s) => s.promptRunId === run(17))).toMatchObject([
			{ classifierVersion: "sent-classifier-v3" },
		]);
		expect(selected.filter((s) => s.promptRunId === run(18))).toMatchObject([
			{ classifierVersion: "sent-classifier-v3" },
		]);
	});

	it("S17 a completed verified v5 with zero aspects fully replaces the older analysis; none of its aspects leak; an unverified completed v5 row is never read", async () => {
		await seedOld(run(19), "sent-classifier-v3", "completed", ["price", "coverage", "service"]);
		const { provider } = scripted([
			{ phase: "classify", answer: { entities: [brandOk()] } },
			{ phase: "verify", answer: ACCEPT },
		]);
		expect(
			await runSentimentJob(payload(run(19)), { resolveProvider: () => provider, resolutionPolicy: fast }),
		).toMatchObject({ status: "classified" });
		expect((await selectedSentimentAnalyses()).filter((s) => s.promptRunId === run(19))).toMatchObject([
			{ classifierVersion: "sent-classifier-v5" },
		]);
		const evidence = await loadSentimentEvidence({ ...scope, aspect: "overall", entityKey: "brand", limit: 50 });
		expect([...evidence.highest, ...evidence.lowest].find((i) => i.promptRunId === run(19))).toMatchObject({
			score: 70,
			aspects: [],
		});
		// An unverified completed v5 row (impossible through the job; simulated directly) is not readable.
		await seedOld(run(20), "sent-classifier-v4", "completed", ["price"]);
		await seedOld(run(20), "sent-classifier-v5", "completed", []);
		expect((await selectedSentimentAnalyses()).filter((s) => s.promptRunId === run(20))).toMatchObject([
			{ classifierVersion: "sent-classifier-v4" },
		]);
		const overview = await loadSentimentOverview({ ...scope, aspect: "overall" });
		const brandRow = overview.entities.find((e) => e.entityType === "brand");
		// Every run the scenarios touched (run 11 is never used): one mention each, never double-counted.
		expect(brandRow?.mentions).toBe(19);
		expect(brandRow?.classified).toBe(brandRow?.sample);
	});
});

describe("S18 every paid response is one attempt-ledger row and one usage event with the actual cost", () => {
	it("ledger rows with a generation id, usage events and case cost totals agree across every scenario", async () => {
		const ledger = await client.query<{ paid: number; cost: string }>(
			`SELECT count(*)::int AS paid, coalesce(sum(t.actual_cost_usd), 0)::text AS cost
			 FROM sentiment_provider_attempts t JOIN sentiment_analyses a ON a.id = t.analysis_id WHERE a.brand_id = $1 AND t.generation_id IS NOT NULL`,
			[BRAND],
		);
		const usage = await client.query<{ paid: number; cost: string }>(
			"SELECT count(*)::int AS paid, coalesce(sum(estimated_cost_usd), 0)::text AS cost FROM usage_events WHERE brand_id = $1 AND event_type LIKE 'sentiment%'",
			[BRAND],
		);
		expect(ledger.rows[0].paid).toBe(usage.rows[0].paid);
		expect(Number(ledger.rows[0].cost)).toBeCloseTo(Number(usage.rows[0].cost), 6);
		const cases = await client.query<{ calls: number; cost: string }>(
			`SELECT coalesce(sum(c.automated_provider_calls), 0)::int AS calls, coalesce(sum(c.total_actual_cost_usd), 0)::text AS cost
			 FROM sentiment_resolution_cases c JOIN sentiment_analyses a ON a.id = c.analysis_id WHERE a.brand_id = $1`,
			[BRAND],
		);
		expect(cases.rows[0].calls).toBe(ledger.rows[0].paid);
		expect(Number(cases.rows[0].cost)).toBeCloseTo(Number(ledger.rows[0].cost), 6);
		const unpaid = await count(
			"sentiment_provider_attempts t JOIN sentiment_analyses a ON a.id = t.analysis_id WHERE a.brand_id = $1 AND t.generation_id IS NULL",
			[BRAND],
		);
		expect(unpaid).toBeGreaterThanOrEqual(2);
		expect(
			await count(
				"sentiment_provider_attempts WHERE outcome NOT IN ('sending','accepted','rejected','provider-error','aborted')",
			),
		).toBe(0);
		expect(sentimentInputHash).toBeTypeOf("function");
	});
});
