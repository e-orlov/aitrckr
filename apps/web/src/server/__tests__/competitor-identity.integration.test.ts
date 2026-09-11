/**
 * Runs against the disposable E2E test database (the one `e2e/seed.ts` owns):
 * `pnpm -C apps/web test:integration` with DATABASE_URL pointing at the seeded
 * test stack.
 *
 * SENT-R0 — a competitor keeps its UUID for its whole life. Saving the settings
 * roster updates rows in place, removal marks a row inactive, and nothing in
 * the product physically deletes a competitor.
 */
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must point at the seeded test stack");

const TEST_BRAND_ID = "default";
const NIKE_BRAND_ID = "nike";

const { saveCompetitorRoster } = await import("@/server/competitor-roster");

interface Row {
	id: string;
	brand_id: string;
	name: string;
	domains: string[];
	aliases: string[];
	active: boolean;
	removed_at: Date | null;
}

const client = new pg.Client({ connectionString: DATABASE_URL });
const stamp = Date.now();
let seeded: Row[] = [];

async function rosterRows(brandId: string, onlyActive = false): Promise<Row[]> {
	const { rows } = await client.query<Row>(
		`SELECT id, brand_id, name, domains, aliases, active, removed_at FROM competitors
		 WHERE brand_id = $1 ${onlyActive ? "AND active" : ""} ORDER BY created_at, id`,
		[brandId],
	);
	return rows;
}

function submitted(rows: Row[]) {
	return rows.map((r) => ({ id: r.id, name: r.name, domains: r.domains, aliases: r.aliases }));
}

beforeAll(async () => {
	const host = new URL(DATABASE_URL).hostname;
	if (!["localhost", "127.0.0.1", "::1"].includes(host)) throw new Error(`refusing non-loopback database ${host}`);
	await client.connect();
	const { rows } = await client.query("SELECT id FROM brands WHERE id = ANY($1::text[]) ORDER BY id", [
		[TEST_BRAND_ID, NIKE_BRAND_ID],
	]);
	if (rows.length !== 2) throw new Error("seeded fixtures missing — not the disposable test database");

	// Own fixtures, so the suite neither depends on nor disturbs the seeder's rows.
	await client.query(
		`INSERT INTO competitors (brand_id, name, domains, aliases) VALUES
		 ($1, $2, $3, $4), ($1, $5, $6, $7), ($1, $8, $9, $10)`,
		[
			TEST_BRAND_ID,
			`Alpha ${stamp}`,
			[`alpha-${stamp}.example`],
			["Alpha Insurance"],
			`Beta ${stamp}`,
			[`beta-${stamp}.example`, `beta-${stamp}.de`],
			[],
			`Gamma ${stamp}`,
			[`gamma-${stamp}.example`],
			["Gamma Co"],
		],
	);
	seeded = (await rosterRows(TEST_BRAND_ID)).filter((r) => r.name.endsWith(String(stamp)));
	if (seeded.length !== 3) throw new Error("fixture insert failed");
});

afterAll(async () => {
	await client.query("DELETE FROM competitors WHERE brand_id = $1 AND (name LIKE $2 OR domains::text LIKE $3)", [
		TEST_BRAND_ID,
		`%${stamp}%`,
		`%${stamp}%`,
	]);
	await client.end();
});

describe("saveCompetitorRoster keeps competitor identity (SENT-R0)", () => {
	it("IT-ID-002: a no-op save preserves every UUID and business value", async () => {
		const before = await rosterRows(TEST_BRAND_ID, true);
		await saveCompetitorRoster(TEST_BRAND_ID, submitted(before));
		const after = await rosterRows(TEST_BRAND_ID, true);

		expect(after.map((r) => r.id)).toEqual(before.map((r) => r.id));
		expect(after.map(({ id, name, domains, aliases }) => ({ id, name, domains, aliases }))).toEqual(
			before.map(({ id, name, domains, aliases }) => ({ id, name, domains, aliases })),
		);
	});

	it("IT-ID-002: editing name, domains and aliases keeps the UUID", async () => {
		const before = await rosterRows(TEST_BRAND_ID, true);
		const beta = before.find((r) => r.name === `Beta ${stamp}`)!;
		const edited = submitted(before).map((c) =>
			c.id === beta.id
				? { ...c, name: `Beta Renamed ${stamp}`, domains: [...c.domains, `beta-${stamp}.at`], aliases: ["Beta AG"] }
				: c,
		);
		await saveCompetitorRoster(TEST_BRAND_ID, edited);

		const after = await rosterRows(TEST_BRAND_ID, true);
		expect(after.map((r) => r.id)).toEqual(before.map((r) => r.id));
		const renamed = after.find((r) => r.id === beta.id)!;
		expect(renamed).toMatchObject({
			name: `Beta Renamed ${stamp}`,
			domains: [`beta-${stamp}.example`, `beta-${stamp}.de`, `beta-${stamp}.at`],
			aliases: ["Beta AG"],
		});
		const { rows } = await client.query<{ previous_names: string[] }>(
			"SELECT previous_names FROM competitors WHERE id = $1",
			[beta.id],
		);
		expect(rows[0].previous_names).toEqual([`Beta ${stamp}`]);
	});

	it("IT-ID-003: removing one competitor marks only that row inactive and keeps the rest", async () => {
		const before = await rosterRows(TEST_BRAND_ID, true);
		const gamma = before.find((r) => r.name === `Gamma ${stamp}`)!;
		const others = before.filter((r) => r.id !== gamma.id);

		await saveCompetitorRoster(TEST_BRAND_ID, submitted(others));

		const activeAfter = await rosterRows(TEST_BRAND_ID, true);
		expect(activeAfter.map((r) => r.id)).toEqual(others.map((r) => r.id));

		const { rows } = await client.query<Row>("SELECT * FROM competitors WHERE id = $1", [gamma.id]);
		expect(rows, "the removed row is retained").toHaveLength(1);
		expect(rows[0].active).toBe(false);
		expect(rows[0].removed_at).toBeInstanceOf(Date);
		expect(rows[0]).toMatchObject({ name: gamma.name, domains: gamma.domains, aliases: gamma.aliases });

		const { rows: brandRows } = await client.query("SELECT id, name FROM brands WHERE id = $1", [TEST_BRAND_ID]);
		expect(brandRows).toHaveLength(1);
	});

	it("re-adding a removed competitor by id reactivates the same row", async () => {
		const all = await rosterRows(TEST_BRAND_ID);
		const gamma = all.find((r) => r.name === `Gamma ${stamp}`)!;
		expect(gamma.active).toBe(false);
		const active = all.filter((r) => r.active);

		await saveCompetitorRoster(TEST_BRAND_ID, submitted([...active, gamma]));

		const after = await rosterRows(TEST_BRAND_ID, true);
		expect(after.map((r) => r.id)).toEqual([...active.map((r) => r.id), gamma.id]);
		expect(after.find((r) => r.id === gamma.id)!.removed_at).toBeNull();
	});

	it("re-adding a removed competitor without an id reuses the row when the domain matches uniquely", async () => {
		const active = await rosterRows(TEST_BRAND_ID, true);
		const gamma = active.find((r) => r.name === `Gamma ${stamp}`)!;
		await saveCompetitorRoster(TEST_BRAND_ID, submitted(active.filter((r) => r.id !== gamma.id)));

		await saveCompetitorRoster(TEST_BRAND_ID, [
			...submitted(active.filter((r) => r.id !== gamma.id)),
			{ name: `Gamma Again ${stamp}`, domains: [`GAMMA-${stamp}.example`], aliases: [] },
		]);

		const after = await rosterRows(TEST_BRAND_ID, true);
		const reused = after.find((r) => r.id === gamma.id);
		expect(reused, "the original UUID is reused").toBeDefined();
		expect(reused).toMatchObject({ name: `Gamma Again ${stamp}`, domains: [`gamma-${stamp}.example`] });
		expect(after.filter((r) => r.domains.includes(`gamma-${stamp}.example`))).toHaveLength(1);
	});

	it("rejects an ambiguous reactivation atomically", async () => {
		const active = await rosterRows(TEST_BRAND_ID, true);
		// Two inactive rows sharing a domain make an id-less re-add ambiguous.
		await client.query(
			`INSERT INTO competitors (brand_id, name, domains, active, removed_at) VALUES
			 ($1, $2, $3, false, now()), ($1, $4, $3, false, now())`,
			[TEST_BRAND_ID, `Dup One ${stamp}`, [`dup-${stamp}.example`], `Dup Two ${stamp}`],
		);
		const snapshot = await rosterRows(TEST_BRAND_ID);

		await expect(
			saveCompetitorRoster(TEST_BRAND_ID, [
				...submitted(active),
				{ name: `Dup ${stamp}`, domains: [`dup-${stamp}.example`], aliases: [] },
			]),
		).rejects.toMatchObject({ code: "competitor-reactivation-ambiguous" });

		expect(await rosterRows(TEST_BRAND_ID)).toEqual(snapshot);
	});

	it("rejects an id that belongs to another brand without writing anything", async () => {
		const active = await rosterRows(TEST_BRAND_ID, true);
		const nike = await rosterRows(NIKE_BRAND_ID);
		const snapshot = await rosterRows(TEST_BRAND_ID);

		await expect(
			saveCompetitorRoster(TEST_BRAND_ID, [
				...submitted(active),
				{ id: nike[0].id, name: "Smuggled", domains: [`smuggled-${stamp}.example`], aliases: [] },
			]),
		).rejects.toMatchObject({ code: "competitor-unknown" });

		expect(await rosterRows(TEST_BRAND_ID)).toEqual(snapshot);
		expect(await rosterRows(NIKE_BRAND_ID)).toEqual(nike);
	});

	it("rejects the same domain on two submitted competitors", async () => {
		const active = await rosterRows(TEST_BRAND_ID, true);
		await expect(
			saveCompetitorRoster(TEST_BRAND_ID, [
				...submitted(active),
				{ name: `X ${stamp}`, domains: [`shared-${stamp}.example`], aliases: [] },
				{ name: `Y ${stamp}`, domains: [`shared-${stamp}.example`], aliases: [] },
			]),
		).rejects.toMatchObject({ code: "competitor-domains-duplicate" });
	});
});
