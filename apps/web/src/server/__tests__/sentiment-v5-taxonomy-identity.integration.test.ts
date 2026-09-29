/**
 * Runs against the disposable test database: `pnpm -C apps/web
 * test:integration` with DATABASE_URL pointing at it.
 *
 * Corrective Slice A3: inventory, currentness and the worker agree on what is
 * actionable. A taxonomy change ships with a classifier-version bump (one new
 * resolution instance, one reclassification, history kept); a taxonomy
 * mismatch under an unchanged classifier version is configuration drift that
 * both sides report the same way and neither acts on.
 */
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must point at the seeded test stack");

const { SENTIMENT_CLASSIFIER_TAXONOMIES } = await import("@workspace/lib/sentiment/types");
const {
	SENTIMENT_CLASSIFIER_VERSION,
	SENTIMENT_MODEL,
	SENTIMENT_READABLE_CLASSIFIER_VERSIONS,
	SENTIMENT_TAXONOMY_VERSION,
	SENTIMENT_DETECTOR_VERSION,
	candidatesFromMentions,
	loadDetectableEntities,
	loadMentions,
	runSentimentEnqueue,
	runSentimentJob,
	selectedSentimentAnalyses,
	sentimentInputHash,
} = await import("@workspace/lib/sentiment");
type Provider = import("@workspace/lib/providers/types").Provider;
type JobDeps = import("@workspace/lib/sentiment").SentimentJobDeps;

const ORG = "default";
const BRAND = "sent-v5-txn-brand";
const PROMPT = "5e97000e-0000-4000-8000-000000000101";
const run = (i: number) => `5e97000e-0000-4000-8000-0000000002${String(i).padStart(2, "0")}`;
const OLD_TAXONOMY = "sent-aspects-v0";
const OLD_CLASSIFIER = "sent-classifier-v4";

const BRAND_ANSWER = `Wenn du die **Sent V5 TXN-Rechtsschutzversicherung** meinst: **Ja, sie kann gut sein – besonders beim Leistungsumfang –, aber sie ist nicht automatisch die beste Wahl für jeden.**

**Dafür spricht:**
- Vergleichstests bewerten den Leistungsumfang der Sent V5 TXN positiv.
- Es gibt umfangreiche Leistungen, etwa weltweiten Schutz – je nach Tarif.

**Worauf du achten solltest:**
- Tarife unterscheiden sich stark bei Wartezeit, Selbstbeteiligung und Ausschlüssen.
- Ein Premium-Tarif kann deutlich teurer sein als ein ausreichender Basistarif.

**Kurz gesagt:**
Für Rechtsschutz ist die Sent V5 TXN grundsätzlich ein seriöser und leistungsstarker Anbieter.`;

const client = new pg.Client({ connectionString: DATABASE_URL });
const payload = (promptRunId: string) => ({
	promptRunId,
	classifierVersion: SENTIMENT_CLASSIFIER_VERSION,
	taxonomyVersion: SENTIMENT_TAXONOMY_VERSION,
});
const analysesOf = async (runId: string) =>
	(
		await client.query<{
			classifier_version: string;
			taxonomy_version: string;
			status: string;
			verified_at: string | null;
		}>(
			"SELECT classifier_version, taxonomy_version, status, verified_at::text FROM sentiment_analyses WHERE prompt_run_id = $1 ORDER BY created_at",
			[runId],
		)
	).rows;
const casesOf = async (runId: string) =>
	(
		await client.query<{ instance_id: string; status: string }>(
			"SELECT c.instance_id, c.status FROM sentiment_resolution_cases c JOIN sentiment_analyses a ON a.id = c.analysis_id WHERE a.prompt_run_id = $1",
			[runId],
		)
	).rows;

const cite = (anchorId: string, polarity: "positive" | "negative" | "neutral") => ({ anchorId, polarity });
const brandOk = {
	key: "brand",
	category: "positive" as const,
	score: 70,
	confidence: 0.9,
	evidence: [cite("s0001", "positive"), cite("s0009", "positive")],
	aspects: [],
};
const ACCEPT = { verdict: "accept", issues: [] };

type Step = { phase: "classify" | "repair" | "verify"; answer?: unknown };
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
			return {
				object: schema.parse(step.answer),
				modelVersion: SENTIMENT_MODEL,
				generationId: `gen-txn-${Math.random().toString(36).slice(2, 10)}`,
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
const complete = () =>
	scripted([
		{ phase: "classify", answer: { entities: [brandOk] } },
		{ phase: "verify", answer: ACCEPT },
	]);

/** The inventory as the operator's enqueue would see it, with a recording sender. */
async function inventory() {
	const sent: string[] = [];
	const sender = {
		send: async (_q: string, data: { promptRunId: string }) => {
			sent.push(data.promptRunId);
			return `job-${sent.length}`;
		},
	};
	const result = await runSentimentEnqueue({ enqueue: { limit: 100 }, sender, brandId: BRAND });
	return { counts: result.counts, sent };
}

async function insertRun(id: string, minutesAgo: number) {
	await client.query(
		`INSERT INTO prompt_runs (id, prompt_id, brand_id, model, provider, version, web_search_enabled, raw_output, brand_mentioned, competitors_mentioned, created_at)
		 VALUES ($1, $2, $3, 'chatgpt', 'openrouter', 'v', true, $4, true, '{}', now() - ($5 || ' minutes')::interval)`,
		[id, PROMPT, BRAND, JSON.stringify({ choices: [{ message: { content: BRAND_ANSWER } }] }), String(minutesAgo)],
	);
}

/** A historical completed analysis of an older classifier under an older taxonomy, via the detector's own mention row. */
async function seedHistorical(runId: string, classifierVersion: string, taxonomyVersion: string) {
	await client.query(
		`INSERT INTO sentiment_detections (prompt_run_id, brand_id, detector_version, status, mention_count) VALUES ($1, $2, $3, 'mentions', 1) ON CONFLICT DO NOTHING`,
		[runId, BRAND, SENTIMENT_DETECTOR_VERSION],
	);
	const mention = await client.query<{ id: string }>(
		`INSERT INTO prompt_run_entity_mentions (prompt_run_id, brand_id, entity_type, competitor_id, entity_key, entity_name, detector_version, matched_terms)
		 VALUES ($1, $2, 'brand', NULL, 'brand', 'Sent V5 TXN', $3, '{"sent v5 txn"}') ON CONFLICT (prompt_run_id, entity_key) DO UPDATE SET entity_name = EXCLUDED.entity_name RETURNING id`,
		[runId, BRAND, SENTIMENT_DETECTOR_VERSION],
	);
	const analysis = await client.query<{ id: string }>(
		`INSERT INTO sentiment_analyses (prompt_run_id, brand_id, classifier_version, taxonomy_version, status, input_hash, completed_at) VALUES ($1, $2, $3, $4, 'completed', 'historical', now()) RETURNING id`,
		[runId, BRAND, classifierVersion, taxonomyVersion],
	);
	await client.query(
		`INSERT INTO sentiment_observations (analysis_id, mention_id, prompt_run_id, brand_id, entity_type, competitor_id, entity_key, score, category, confidence, evidence)
		 VALUES ($1, $2, $3, $4, 'brand', NULL, 'brand', 30, 'negative', 0.9, $5::jsonb)`,
		[
			analysis.rows[0].id,
			mention.rows[0].id,
			runId,
			BRAND,
			JSON.stringify([{ quote: "Sent V5 TXN", start: 0, end: 11, polarity: "negative" }]),
		],
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
		`INSERT INTO brands (id, organization_id, slug, name, website, enabled, onboarded, created_at, updated_at) VALUES ($1, $2, $1, 'Sent V5 TXN', 'https://sent-v5-txn.example.test/', true, true, now(), now())`,
		[BRAND, org.rows[0].id],
	);
	await client.query(
		`INSERT INTO prompts (id, brand_id, value, enabled, tags, system_tags, created_at, updated_at) VALUES ($1, $2, 'TXN prompt', false, '{}', '{unbranded}', now(), now())`,
		[PROMPT, BRAND],
	);
	for (let i = 1; i <= 3; i++) await insertRun(run(i), 100 - i);
});

afterAll(async () => {
	await cleanup();
	await client.end();
});

describe("A3-0 taxonomy is derived from the classifier version", () => {
	it("every readable classifier version names exactly one taxonomy and the current taxonomy is the current version's", () => {
		for (const version of SENTIMENT_READABLE_CLASSIFIER_VERSIONS) {
			expect(typeof SENTIMENT_CLASSIFIER_TAXONOMIES[version]).toBe("string");
		}
		expect(SENTIMENT_TAXONOMY_VERSION).toBe(SENTIMENT_CLASSIFIER_TAXONOMIES[SENTIMENT_CLASSIFIER_VERSION]);
		expect(SENTIMENT_TAXONOMY_VERSION).toBe("sent-aspects-v1");
	});
});

describe("A3-1 same taxonomy, same classifier version, resolved instance", () => {
	it("inventory counts it completed, the job answers already-completed, zero provider calls", async () => {
		const first = complete();
		expect(
			await runSentimentJob(payload(run(1)), { resolveProvider: () => first.provider, resolutionPolicy: fast }),
		).toMatchObject({
			status: "classified",
			paidCalls: 2,
		});
		const { counts, sent } = await inventory();
		expect(counts).toMatchObject({ completed: 1, eligibleStale: 0, taxonomyDrift: 0 });
		expect(sent).not.toContain(run(1));
		const again = complete();
		expect(
			await runSentimentJob(payload(run(1)), { resolveProvider: () => again.provider, resolutionPolicy: fast }),
		).toEqual({
			status: "already-completed",
		});
		expect(again.script.calls).toEqual([]);
	});
});

describe("A3-2 taxonomy mismatch under an unchanged classifier version is configuration drift", () => {
	it("inventory and job give the same non-actionable disposition, nothing is enqueued or called, and repeated passes do not loop", async () => {
		// The resolved v5 instance of run 1 is disturbed: its row now claims a taxonomy the current version never shipped with.
		await client.query(
			"UPDATE sentiment_analyses SET taxonomy_version = $2 WHERE prompt_run_id = $1 AND classifier_version = $3",
			[run(1), OLD_TAXONOMY, SENTIMENT_CLASSIFIER_VERSION],
		);
		const casesBefore = await casesOf(run(1));
		for (let pass = 0; pass < 3; pass++) {
			const { counts, sent } = await inventory();
			expect(counts).toMatchObject({ taxonomyDrift: 1, eligible: 0, eligibleStale: 0, completed: 0, accepted: 0 });
			expect(sent).toEqual([]);
			const worker = complete();
			const outcome = await runSentimentJob(payload(run(1)), {
				resolveProvider: () => worker.provider,
				resolutionPolicy: fast,
			});
			expect(outcome).toMatchObject({ status: "skipped", reason: expect.stringContaining("taxonomy") });
			expect(outcome).not.toMatchObject({ status: "already-completed" });
			expect(worker.script.calls).toEqual([]);
		}
		// Nothing was rewritten: the row keeps its (drifted) taxonomy and the single resolved instance is unchanged.
		expect(await analysesOf(run(1))).toEqual([
			{
				classifier_version: SENTIMENT_CLASSIFIER_VERSION,
				taxonomy_version: OLD_TAXONOMY,
				status: "completed",
				verified_at: expect.any(String),
			},
		]);
		expect(await casesOf(run(1))).toEqual(casesBefore);
		await client.query(
			"UPDATE sentiment_analyses SET taxonomy_version = $2 WHERE prompt_run_id = $1 AND classifier_version = $3",
			[run(1), SENTIMENT_TAXONOMY_VERSION, SENTIMENT_CLASSIFIER_VERSION],
		);
	});
});

describe("A3-3/4/5 a taxonomy change ships with a classifier-version bump", () => {
	it("the older version's result stays in history, the new identity is actionable exactly once, reclassifies once, becomes current and readable", async () => {
		await seedHistorical(run(2), OLD_CLASSIFIER, OLD_TAXONOMY);
		const before = await inventory();
		expect(before.counts).toMatchObject({ eligible: 1, staleVersionOnly: 1, taxonomyDrift: 0, fallbackCompleted: 0 });
		expect(before.sent).toEqual([run(2)]);

		const worker = complete();
		expect(
			await runSentimentJob(payload(run(2)), { resolveProvider: () => worker.provider, resolutionPolicy: fast }),
		).toMatchObject({
			status: "classified",
			paidCalls: 2,
		});
		expect(worker.script.calls.map((c) => c.phase)).toEqual(["classify", "verify"]);
		expect(await analysesOf(run(2))).toEqual([
			{ classifier_version: OLD_CLASSIFIER, taxonomy_version: OLD_TAXONOMY, status: "completed", verified_at: null },
			{
				classifier_version: SENTIMENT_CLASSIFIER_VERSION,
				taxonomy_version: SENTIMENT_TAXONOMY_VERSION,
				status: "completed",
				verified_at: expect.any(String),
			},
		]);
		expect(await casesOf(run(2))).toHaveLength(1);

		// A3-4: nothing left to do, no call.
		// Brand-wide: run 1 (A3-1) and run 2 are now the completed ones.
		const after = await inventory();
		expect(after.counts).toMatchObject({ completed: 2, eligible: 0, taxonomyDrift: 0 });
		expect(after.sent).not.toContain(run(2));
		const again = complete();
		expect(
			await runSentimentJob(payload(run(2)), { resolveProvider: () => again.provider, resolutionPolicy: fast }),
		).toEqual({
			status: "already-completed",
		});
		expect(again.script.calls).toEqual([]);

		// A3-5: the read path selects the same winner the inventory calls complete.
		const selected = (await selectedSentimentAnalyses()).filter((s) => s.promptRunId === run(2));
		expect(selected).toMatchObject([{ classifierVersion: SENTIMENT_CLASSIFIER_VERSION }]);
		const entities = await loadDetectableEntities(BRAND, "historical");
		const hash = sentimentInputHash(BRAND_ANSWER, candidatesFromMentions(await loadMentions(run(2)), entities));
		expect(
			(
				await client.query(
					"SELECT input_hash FROM sentiment_analyses WHERE prompt_run_id = $1 AND classifier_version = $2",
					[run(2), SENTIMENT_CLASSIFIER_VERSION],
				)
			).rows[0].input_hash,
		).toBe(hash);
	});
});
