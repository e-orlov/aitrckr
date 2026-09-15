/**
 * Runs against the disposable E2E test database server: `pnpm -C apps/web
 * test:integration` with DATABASE_URL pointing at the seeded test stack. Two
 * throwaway databases are created on that server, migrated through the full
 * chain and loaded with the same logical production-shaped data; only the
 * mention-row UUIDs differ. The committed `inspect` (run as a child process
 * with each DATABASE_URL, exactly as an operator would run it) must print
 * byte-identical contracts for both, before and after repeated backfills.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SENTIMENT_DETECTOR_VERSION } from "@workspace/lib/sentiment";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const DATABASE_URL = process.env.DATABASE_URL;
/** The seeded mention rows must be current for the detector under test, whatever its version. */
const detectorVersionLiteral = `'${SENTIMENT_DETECTOR_VERSION}'`;
if (!DATABASE_URL) throw new Error("DATABASE_URL must point at the seeded test stack");

const here = fileURLToPath(new URL(".", import.meta.url));
const MIGRATIONS = path.resolve(here, "../../../../../packages/lib/src/db/migrations");
// The scripts under test are the committed operator tools; pointing this at a checkout of an
// older revision reproduces the pre-fix behaviour against the very same databases.
const WORKER_DIR = process.env.SENTIMENT_ORDER_WORKER_DIR ?? path.resolve(here, "../../../../worker");
const CANARY = path.join(WORKER_DIR, "scripts", "sentiment-canary.ts");
const BACKFILL = path.join(WORKER_DIR, "scripts", "sentiment-backfill.ts");

const DB_A = "elmo_order_a";
const DB_B = "elmo_order_b";
const ORG = "ord-org";
const BRAND = "ord-brand";
const ALPHA = "a1a1a1a1-0000-4000-8000-000000000001";
const BETA = "b2b2b2b2-0000-4000-8000-000000000002";
const PROMPT = "5e970005-0000-4000-8000-000000000101";
const RUN = "5e970005-0000-4000-8000-000000000201";
const ANSWER = "Ordbrand handles claims fast. Alpha is cheaper but slower. Beta is well known.";
const DETECTED_AT = "2026-09-13 18:07:42.696099+00";

const admin = new pg.Client({ connectionString: DATABASE_URL });
const urlFor = (name: string) => {
	const url = new URL(DATABASE_URL);
	url.pathname = `/${name}`;
	return url.toString();
};

function run(script: string, args: string[], databaseUrl: string) {
	const result = spawnSync(process.execPath, ["--import", "tsx", script, ...args], {
		cwd: WORKER_DIR,
		env: { ...process.env, DATABASE_URL: databaseUrl, OPENROUTER_API_KEY: "" },
		encoding: "utf8",
		timeout: 180_000,
		windowsHide: true,
	});
	return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

/** Exactly what an operator freezes: the raw stdout bytes of `inspect`. */
function inspect(databaseUrl: string) {
	const out = run(CANARY, ["inspect", RUN], databaseUrl);
	expect(out.status, out.stderr).toBe(0);
	const raw = Buffer.from(out.stdout, "utf8");
	let state: { runState?: { pristine: boolean } } = {};
	try {
		state = JSON.parse(out.stderr.trim().split("\n").at(-1) ?? "{}");
	} catch {
		state = {};
	}
	return { raw, sha256: createHash("sha256").update(raw).digest("hex"), json: JSON.parse(out.stdout), state };
}

async function seedLogicalData(client: pg.Client) {
	await client.query(`INSERT INTO organization (id, name, slug, created_at) VALUES ($1, 'Ord Org', $1, now())`, [ORG]);
	await client.query(
		`INSERT INTO brands (id, organization_id, slug, name, website, enabled, onboarded, created_at, updated_at)
		 VALUES ($1, $2, $1, 'Ordbrand', 'https://ordbrand.example.test/', true, true, now(), now())`,
		[BRAND, ORG],
	);
	await client.query(
		`INSERT INTO competitors (id, brand_id, name, domains, aliases, active, removed_at, created_at, updated_at)
		 VALUES ($1, $3, 'Alpha', '{alpha.example.test}', '{}', true, NULL, now(), now()),
		        ($2, $3, 'Beta', '{beta.example.test}', '{}', true, NULL, now(), now())`,
		[ALPHA, BETA, BRAND],
	);
	await client.query(
		`INSERT INTO prompts (id, brand_id, value, enabled, tags, system_tags, created_at, updated_at)
		 VALUES ($1, $2, 'Order prompt', false, '{}', '{unbranded}', now(), now())`,
		[PROMPT, BRAND],
	);
	await client.query(
		`INSERT INTO prompt_runs (id, prompt_id, brand_id, model, provider, version, web_search_enabled, raw_output, brand_mentioned, competitors_mentioned, created_at)
		 VALUES ($1, $2, $3, 'chatgpt', 'openrouter', 'v', true, $4, true, '{}', now() - interval '1 day')`,
		[RUN, PROMPT, BRAND, JSON.stringify({ choices: [{ message: { content: ANSWER } }] })],
	);
}

/** Mention rows as one backfill transaction would leave them: one detected_at, ids chosen by the test. */
async function seedMentions(client: pg.Client, ids: { brand: string; alpha: string; beta: string }) {
	await client.query(
		`INSERT INTO sentiment_detections (prompt_run_id, brand_id, detector_version, status, mention_count, detected_at)
		 VALUES ($1, $2, ${detectorVersionLiteral}, 'mentions', 3, $3)`,
		[RUN, BRAND, DETECTED_AT],
	);
	const rows: [string, string, string, string | null, string][] = [
		[ids.brand, "brand", "brand", null, "Ordbrand"],
		[ids.alpha, "competitor", ALPHA, ALPHA, "Alpha"],
		[ids.beta, "competitor", BETA, BETA, "Beta"],
	];
	for (const [id, type, key, competitorId, name] of rows) {
		await client.query(
			`INSERT INTO prompt_run_entity_mentions (id, prompt_run_id, brand_id, entity_type, competitor_id, entity_key, entity_name, detector_version, matched_terms, detected_at)
			 VALUES ($1, $2, $3, $4, $5, $6, $7, ${detectorVersionLiteral}, '{}', $8)`,
			[id, RUN, BRAND, type, competitorId, key, name, DETECTED_AT],
		);
	}
}

const clients: Record<string, pg.Client> = {};

async function storedOrder(client: pg.Client) {
	return (
		await client.query<{ entity_key: string }>(
			"SELECT entity_key FROM prompt_run_entity_mentions WHERE prompt_run_id = $1 ORDER BY detected_at, id",
			[RUN],
		)
	).rows.map((r) => r.entity_key);
}

beforeAll(async () => {
	const host = new URL(DATABASE_URL).hostname;
	if (!["localhost", "127.0.0.1", "::1"].includes(host)) throw new Error(`refusing non-loopback database ${host}`);
	await admin.connect();
	for (const name of [DB_A, DB_B]) {
		await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
		await admin.query(`CREATE DATABASE ${name}`);
		const db = drizzle(urlFor(name));
		await migrate(db, { migrationsFolder: MIGRATIONS });
		await db.$client.end();
		const client = new pg.Client({ connectionString: urlFor(name) });
		await client.connect();
		clients[name] = client;
		await seedLogicalData(client);
	}
}, 300_000);

afterAll(async () => {
	for (const client of Object.values(clients)) await client.end().catch(() => undefined);
	for (const name of [DB_A, DB_B]) await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
	await admin.end();
});

describe("IT-SNT-022 canonical candidate order across independently prepared databases", () => {
	it("both databases carry the full migration chain and the same logical data", async () => {
		for (const name of [DB_A, DB_B]) {
			const client = clients[name];
			expect((await client.query("SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations")).rows[0].n).toBe(22);
			expect(
				(await client.query("SELECT count(*)::int AS n FROM competitors WHERE brand_id = $1", [BRAND])).rows[0].n,
			).toBe(2);
		}
	});

	it("mention rows whose ids sort in opposite directions still give byte-identical contracts (RED before the fix)", {
		timeout: 240_000,
	}, async () => {
		await seedMentions(clients[DB_A], {
			brand: "00000000-0000-4000-8000-000000000001",
			alpha: "00000000-0000-4000-8000-000000000002",
			beta: "00000000-0000-4000-8000-000000000003",
		});
		await seedMentions(clients[DB_B], {
			brand: "00000000-0000-4000-8000-000000000003",
			alpha: "00000000-0000-4000-8000-000000000002",
			beta: "00000000-0000-4000-8000-000000000001",
		});
		// The storage order really differs between the two databases.
		expect(await storedOrder(clients[DB_A])).toEqual(["brand", ALPHA, BETA]);
		expect(await storedOrder(clients[DB_B])).toEqual([BETA, ALPHA, "brand"]);

		const a = inspect(urlFor(DB_A));
		const b = inspect(urlFor(DB_B));
		expect(a.raw.equals(b.raw)).toBe(true);
		expect(a.sha256).toBe(b.sha256);
		expect(a.json.entities).toEqual([
			{ key: "brand", entityType: "brand" },
			{ key: ALPHA, entityType: "competitor" },
			{ key: BETA, entityType: "competitor" },
		]);
		expect(a.json.classifierInputHash).toMatch(/^[0-9a-f]{64}$/);
		expect(a.json.providerPromptSha256).toMatch(/^[0-9a-f]{64}$/);
		expect(a.state.runState?.pristine).toBe(true);
	});

	it("independent backfills (random mention ids) give the same contract, and repeating them changes nothing", {
		timeout: 300_000,
	}, async () => {
		for (const name of [DB_A, DB_B]) {
			await clients[name].query("DELETE FROM prompt_run_entity_mentions WHERE prompt_run_id = $1", [RUN]);
			await clients[name].query("DELETE FROM sentiment_detections WHERE prompt_run_id = $1", [RUN]);
			const apply = run(BACKFILL, ["mentions", "--apply", "--brand", BRAND], urlFor(name));
			expect(apply.status, apply.stderr).toBe(0);
			expect(
				(
					await clients[name].query(
						"SELECT count(*)::int AS n FROM prompt_run_entity_mentions WHERE prompt_run_id = $1",
						[RUN],
					)
				).rows[0].n,
			).toBe(3);
		}
		const idsA = (
			await clients[DB_A].query<{ id: string }>(
				"SELECT id FROM prompt_run_entity_mentions WHERE prompt_run_id = $1 ORDER BY id",
				[RUN],
			)
		).rows.map((r) => r.id);
		const idsB = (
			await clients[DB_B].query<{ id: string }>(
				"SELECT id FROM prompt_run_entity_mentions WHERE prompt_run_id = $1 ORDER BY id",
				[RUN],
			)
		).rows.map((r) => r.id);
		expect(idsA).not.toEqual(idsB);

		const first = { a: inspect(urlFor(DB_A)), b: inspect(urlFor(DB_B)) };
		expect(first.a.sha256).toBe(first.b.sha256);
		expect(first.a.raw.equals(first.b.raw)).toBe(true);

		// A second apply and a dry run leave every digest and the raw bytes untouched.
		for (const name of [DB_A, DB_B]) {
			expect(run(BACKFILL, ["mentions", "--apply", "--brand", BRAND], urlFor(name)).status).toBe(0);
			expect(run(BACKFILL, ["mentions", "--brand", BRAND], urlFor(name)).status).toBe(0);
		}
		const again = { a: inspect(urlFor(DB_A)), b: inspect(urlFor(DB_B)) };
		expect(again.a.sha256).toBe(first.a.sha256);
		expect(again.b.sha256).toBe(first.a.sha256);
		expect(again.a.json.classifierInputHash).toBe(first.a.json.classifierInputHash);
		expect(again.a.json.providerPromptSha256).toBe(first.a.json.providerPromptSha256);
		expect(again.a.state.runState?.pristine).toBe(true);
	});
});
