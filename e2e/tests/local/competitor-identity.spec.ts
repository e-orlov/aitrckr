/**
 * SENT-R0 — the competitor settings page keeps competitor identity. Saving the
 * roster unchanged, editing an entry, and removing an entry all leave the
 * surviving rows' UUIDs intact; a removed competitor leaves every current
 * surface but its row stays in the database.
 *
 * The spec seeds its own brand and reconciles the UI against SQL directly.
 */
import { expect, type Page, test } from "@playwright/test";
import pg from "pg";
import { brandUrl, DATABASE_URL, TEST_ORG_SLUG } from "../../fixtures";

const BRAND_ID = "sent-r0-identity";
const BRAND_URL = brandUrl(BRAND_ID, TEST_ORG_SLUG);
const SETTINGS_URL = `${BRAND_URL}/settings/competitors`;

const ROSTER = [
	{ id: "5e970001-0000-4000-8000-000000000001", name: "Alpha Versicherung", domains: ["alpha-r0.example.test"], aliases: ["Alpha"] },
	{ id: "5e970001-0000-4000-8000-000000000002", name: "Bravo Schutz", domains: ["bravo-r0.example.test"], aliases: [] },
	{ id: "5e970001-0000-4000-8000-000000000003", name: "Charlie Recht", domains: ["charlie-r0.example.test"], aliases: [] },
];

interface Row {
	id: string;
	name: string;
	domains: string[];
	aliases: string[];
	active: boolean;
	previous_names: string[];
}

async function rows(client: pg.Client): Promise<Row[]> {
	const { rows } = await client.query<Row>(
		"SELECT id, name, domains, aliases, active, previous_names FROM competitors WHERE brand_id = $1 ORDER BY created_at, id",
		[BRAND_ID],
	);
	return rows;
}

/**
 * The editor's Domains/Aliases fields are tag comboboxes: click the field,
 * type into the popover's search box, pick the "Add …" item, then close it.
 */
async function addTag(page: Page, field: "Add domain..." | "Add alias...", value: string, entry = 0) {
	await page.getByRole("combobox").filter({ hasText: field }).nth(entry).click();
	await page.getByPlaceholder("Search...").fill(value);
	await page.getByRole("option", { name: `Add “${value}”` }).click();
	await page.keyboard.press("Escape");
}

async function openEditor(page: Page, index: number) {
	await page.getByRole("button").filter({ has: page.locator("svg.lucide-pencil") }).nth(index).click();
	await expect(page.getByPlaceholder("Competitor name")).toBeVisible();
}

async function saveAndReload(page: Page) {
	await page.getByRole("button", { name: /save changes/i }).click();
	await expect(page.getByRole("button", { name: /save changes/i })).toBeHidden();
	await page.reload();
	await expect(page.getByText(ROSTER[0].name)).toBeVisible();
}

test.describe("Competitor settings preserve identity", () => {
	test.describe.configure({ mode: "serial" });

	let client: pg.Client;

	test.beforeAll(async () => {
		const host = new URL(DATABASE_URL).hostname;
		if (!["localhost", "127.0.0.1", "::1"].includes(host)) throw new Error(`refusing non-loopback database ${host}`);
		client = new pg.Client({ connectionString: DATABASE_URL });
		await client.connect();
		const org = await client.query("SELECT id FROM organization WHERE slug = $1", [TEST_ORG_SLUG]);
		if (org.rows.length !== 1) throw new Error("seeded organization missing — not the disposable test database");

		await client.query(
			`INSERT INTO brands (id, organization_id, slug, name, website, enabled, onboarded, created_at, updated_at)
			 VALUES ($1, $2, $1, 'SENT R0', 'https://sent-r0.example.test/', true, true, NOW(), NOW())`,
			[BRAND_ID, org.rows[0].id],
		);
		for (const [i, c] of ROSTER.entries()) {
			await client.query(
				`INSERT INTO competitors (id, brand_id, name, domains, aliases, created_at, updated_at)
				 VALUES ($1, $2, $3, $4, $5, NOW() + ($6 || ' seconds')::interval, NOW())`,
				[c.id, BRAND_ID, c.name, c.domains, c.aliases, String(i)],
			);
		}
	});

	test.afterAll(async () => {
		try {
			await client.query("DELETE FROM competitors WHERE brand_id = $1", [BRAND_ID]);
			await client.query("DELETE FROM brands WHERE id = $1", [BRAND_ID]);
		} finally {
			await client.end();
		}
	});

	test("E2E-ID-001: saving through the UI keeps every UUID; a save that restores the roster is a no-op", async ({ page }) => {
		await page.goto(SETTINGS_URL);
		for (const c of ROSTER) await expect(page.getByText(c.name)).toBeVisible();
		await expect(page.getByRole("button", { name: /save changes/i })).toBeHidden();

		// The bar only offers a save when something changed, so a round trip is
		// two real saves: add an alias, then take it away again.
		await openEditor(page, 1);
		await addTag(page, "Add alias...", "Temp Alias");
		await saveAndReload(page);
		const midway = await rows(client);
		expect(midway.map((r) => r.id)).toEqual(ROSTER.map((c) => c.id));
		expect(midway[1].aliases).toEqual(["Temp Alias"]);

		await openEditor(page, 1);
		await page.getByRole("button", { name: "Remove Temp Alias" }).click();
		await saveAndReload(page);

		const after = await rows(client);
		expect(after.map(({ id, name, domains, aliases, active }) => ({ id, name, domains, aliases, active }))).toEqual(
			ROSTER.map((c) => ({ ...c, active: true })),
		);
		for (const c of ROSTER) await expect(page.getByText(c.name)).toBeVisible();
	});

	test("editing name and aliases keeps the UUID and records the previous name", async ({ page }) => {
		await page.goto(SETTINGS_URL);
		await openEditor(page, 1);
		await page.getByPlaceholder("Competitor name").fill("Bravo Rechtsschutz");
		await addTag(page, "Add alias...", "Bravo");
		await saveAndReload(page);

		await expect(page.getByText("Bravo Rechtsschutz")).toBeVisible();
		const after = await rows(client);
		expect(after.map((r) => r.id)).toEqual(ROSTER.map((c) => c.id));
		expect(after[1]).toMatchObject({
			name: "Bravo Rechtsschutz",
			aliases: ["Bravo"],
			active: true,
			previous_names: ["Bravo Schutz"],
		});
	});

	test("removing one competitor marks only that row inactive and hides it everywhere current", async ({ page }) => {
		await page.goto(SETTINGS_URL);
		await page.getByRole("button").filter({ has: page.locator("svg.lucide-trash-2") }).nth(2).click();
		await expect(page.getByText(ROSTER[2].name)).toBeHidden();
		await saveAndReload(page);
		await expect(page.getByText(ROSTER[2].name)).toBeHidden();
		await expect(page.getByText(/2\/\d+/)).toBeVisible();

		const all = await rows(client);
		expect(all.map((r) => r.id)).toEqual(ROSTER.map((c) => c.id));
		expect(all.map((r) => r.active)).toEqual([true, true, false]);

		// The roster read by the rest of the app (brand context) no longer lists it.
		await page.goto(`${BRAND_URL}/visibility`);
		await expect(page.getByRole("heading", { name: /visibility/i }).first()).toBeVisible();
		await expect(page.getByText(ROSTER[2].name)).toHaveCount(0);
	});

	test("re-adding the removed competitor's domain reuses its UUID", async ({ page }) => {
		await page.goto(SETTINGS_URL);
		await page.getByRole("button", { name: /add competitor/i }).click();
		await page.getByPlaceholder("Competitor name").last().fill("Charlie Again");
		await addTag(page, "Add domain...", ROSTER[2].domains[0]);
		await saveAndReload(page);

		await expect(page.getByText("Charlie Again")).toBeVisible();
		const all = await rows(client);
		expect(all.map((r) => r.id)).toEqual(ROSTER.map((c) => c.id));
		expect(all[2]).toMatchObject({ name: "Charlie Again", active: true, previous_names: ["Charlie Recht"] });
	});
});
