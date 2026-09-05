/**
 * Runs against the disposable E2E test database (the one `e2e/seed.ts` owns),
 * not in the unit project: `pnpm -C apps/web test:integration` with
 * DATABASE_URL pointing at the seeded test stack.
 *
 * F04-CORR-IT-002 — a scheduler that rejects after the commit must not undo,
 * hide, or misreport a save that already reached the database.
 */
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must point at the seeded test stack");

// The fixtures the seeder creates; their presence (and a loopback host) is
// what tells this suite it is looking at the disposable database.
const TEST_BRAND_ID = "default";
const NIKE_BRAND_ID = "nike";

const { savePromptsForBrand } = await import("@/server/save-prompts");
const { db } = await import("@workspace/lib/db/db");
const { brands } = await import("@workspace/lib/db/schema");
const { eq } = await import("drizzle-orm");

const client = new pg.Client({ connectionString: DATABASE_URL });
const marker = `F04-CORR-IT-002 ${Date.now()}`;
const createdIds: string[] = [];
const unhandled: unknown[] = [];
const onUnhandled = (reason: unknown) => unhandled.push(reason);

beforeAll(async () => {
	const host = new URL(DATABASE_URL).hostname;
	if (!["localhost", "127.0.0.1", "::1"].includes(host)) throw new Error(`refusing non-loopback database ${host}`);
	await client.connect();
	const { rows } = await client.query("SELECT id FROM brands WHERE id = ANY($1::text[]) ORDER BY id", [
		[TEST_BRAND_ID, NIKE_BRAND_ID],
	]);
	if (rows.length !== 2) throw new Error("seeded fixtures missing — not the disposable test database");
	process.on("unhandledRejection", onUnhandled);
});

afterAll(async () => {
	process.off("unhandledRejection", onUnhandled);
	if (createdIds.length > 0) {
		await client.query("DELETE FROM pgboss.job WHERE name = 'process-prompt' AND data->>'promptId' = ANY($1::text[])", [
			createdIds,
		]);
		await client.query("DELETE FROM prompts WHERE id = ANY($1::uuid[])", [createdIds]);
	}
	await client.end();
});

describe("savePromptsForBrand when the scheduler rejects after the commit", () => {
	it("keeps the committed rows, reports success, and logs the rejection exactly once", async () => {
		const brand = await db.query.brands.findFirst({ where: eq(brands.id, TEST_BRAND_ID) });
		if (!brand) throw new Error("brand fixture missing");
		const existing = (
			await client.query<{ id: string; value: string; enabled: boolean; tags: string[] }>(
				"SELECT id, value, enabled, tags FROM prompts WHERE brand_id = $1 ORDER BY id",
				[brand.id],
			)
		).rows;

		const scheduleNewPrompts = vi.fn().mockRejectedValueOnce(new Error("scheduler unavailable (injected)"));
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

		let saved: Awaited<ReturnType<typeof savePromptsForBrand>>;
		let errorCalls: unknown[][];
		try {
			// The existing rows are re-submitted unchanged; one new prompt with
			// dirty tags is added, exactly as the editor would send it.
			saved = await savePromptsForBrand(
				brand,
				[...existing, { value: marker, enabled: true, tags: [" Insurance ", "COMPARISON", "insurance", ""] }],
				{ scheduleNewPrompts },
			);
			// The rejection is delivered on a later tick; give it room before checking.
			await new Promise((resolve) => setTimeout(resolve, 50));
			errorCalls = consoleError.mock.calls.map((call) => [...call]);
		} finally {
			consoleError.mockRestore();
		}

		const created = saved.find((p) => p.value === marker);
		expect(created, "the save must report the new prompt as saved").toBeDefined();
		createdIds.push(created!.id);

		expect(scheduleNewPrompts).toHaveBeenCalledTimes(1);
		expect(scheduleNewPrompts).toHaveBeenCalledWith([created!.id]);
		expect(errorCalls).toHaveLength(1);
		expect(String(errorCalls[0][0])).toMatch(/Failed to create job schedulers/);
		expect(unhandled).toEqual([]);

		const { rows } = await client.query("SELECT id, brand_id, tags, system_tags, enabled FROM prompts WHERE id = $1", [
			created!.id,
		]);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			brand_id: brand.id,
			tags: ["insurance", "comparison"],
			enabled: true,
		});
		expect(rows[0].system_tags).toHaveLength(1);

		const after = (
			await client.query("SELECT id, value, enabled, tags FROM prompts WHERE brand_id = $1 AND id <> $2 ORDER BY id", [
				brand.id,
				created!.id,
			])
		).rows;
		expect(after).toEqual(existing);
	});
});
