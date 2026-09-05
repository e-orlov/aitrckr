/**
 * F04-CORR-IT-001 — the editor's save is one transaction: when a later write
 * fails, an earlier write in the same save is rolled back too, and the user
 * is told the save failed.
 *
 * The failure is real. A BEFORE INSERT trigger, installed only in this
 * disposable test database for the duration of the spec, rejects exactly one
 * sentinel prompt value. The save then carries an update to a seeded prompt
 * (updates run first in the transaction), a valid new prompt, and the sentinel
 * prompt (inserts run last, as one statement).
 */
import { expect, type Page, test } from "@playwright/test";
import pg from "pg";
import { brandUrl, DATABASE_URL, PROMPT_IDS, TEST_BRAND_ID } from "../../fixtures";

const SENTINEL = `F04-CORR-IT-001 sentinel ${Date.now()}`;
const VALID_NEW = `F04-CORR-IT-001 valid ${Date.now()}`;
const TRIGGER = "f04_corr_it001_reject_sentinel";
const FUNCTION = "f04_corr_it001_reject_sentinel_fn";

async function openBulkPaste(page: Page) {
  const textarea = page.getByRole("textbox", { name: /prompts to add/i });
  await expect(async () => {
    await page.getByRole("button", { name: /add multiple/i }).click();
    await expect(textarea).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
  return textarea;
}

test.describe("Prompt save rolls back as a whole", () => {
  test.describe.configure({ mode: "serial" });

  let client: pg.Client;
  let baselineTags: string[];
  let baselineCount: number;
  let nikeBefore: unknown[];

  test.beforeAll(async () => {
    const host = new URL(DATABASE_URL).hostname;
    if (!["localhost", "127.0.0.1", "::1"].includes(host)) throw new Error(`refusing non-loopback database ${host}`);
    client = new pg.Client({ connectionString: DATABASE_URL });
    await client.connect();
    const fixture = await client.query("SELECT tags FROM prompts WHERE id = $1 AND brand_id = $2", [
      PROMPT_IDS.branded1,
      TEST_BRAND_ID,
    ]);
    if (fixture.rows.length !== 1) throw new Error("seeded fixture missing — not the disposable test database");
    baselineTags = fixture.rows[0].tags;
    baselineCount = (await client.query("SELECT count(*)::int AS n FROM prompts WHERE brand_id = $1", [TEST_BRAND_ID]))
      .rows[0].n;
    nikeBefore = (await client.query("SELECT id, value, tags FROM prompts WHERE brand_id = 'nike' ORDER BY id")).rows;

    await client.query(`
      CREATE FUNCTION ${FUNCTION}() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.value = '${SENTINEL}' THEN
          RAISE EXCEPTION 'F04-CORR-IT-001: injected failure for the sentinel prompt';
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER ${TRIGGER} BEFORE INSERT ON prompts FOR EACH ROW EXECUTE FUNCTION ${FUNCTION}();
    `);
  });

  test.afterAll(async () => {
    try {
      await client.query(`DROP TRIGGER IF EXISTS ${TRIGGER} ON prompts`);
      await client.query(`DROP FUNCTION IF EXISTS ${FUNCTION}()`);
      // Nothing should have been written; remove any leftover just in case.
      const leftovers = await client.query("SELECT id FROM prompts WHERE value = ANY($1::text[])", [[SENTINEL, VALID_NEW]]);
      if (leftovers.rows.length > 0) {
        const ids = leftovers.rows.map((r) => r.id);
        await client.query("DELETE FROM pgboss.job WHERE name = 'process-prompt' AND data->>'promptId' = ANY($1::text[])", [ids]);
        await client.query("DELETE FROM prompts WHERE id = ANY($1::uuid[])", [ids]);
      }
      await client.query("UPDATE prompts SET tags = $1 WHERE id = $2", [baselineTags, PROMPT_IDS.branded1]);
      const triggers = await client.query("SELECT 1 FROM pg_trigger WHERE tgname = $1", [TRIGGER]);
      expect(triggers.rows).toHaveLength(0);
      expect((await client.query("SELECT count(*)::int AS n FROM prompts WHERE brand_id = $1", [TEST_BRAND_ID])).rows[0].n).toBe(
        baselineCount,
      );
    } finally {
      await client.end();
    }
  });

  test("an earlier tag update is undone when a later insert in the same save fails", async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto(`${brandUrl()}/settings/prompts`);
    await expect(page.getByRole("textbox").first()).toBeVisible();

    // Earlier write: add a tag to the seeded prompt through its own tags combobox.
    const seeded = (await client.query("SELECT value FROM prompts WHERE id = $1", [PROMPT_IDS.branded1])).rows[0].value;
    const inputs = page.getByPlaceholder("Enter prompt text...").filter({ visible: true });
    const idx = await inputs.evaluateAll((els, w) => els.findIndex((el) => (el as HTMLInputElement).value === w), seeded);
    expect(idx).toBeGreaterThanOrEqual(0);
    const row = page.locator("div.md\\:grid").filter({ has: page.getByPlaceholder("Enter prompt text...") }).nth(idx);
    await row.getByRole("combobox").last().click();
    await page.getByPlaceholder("Search or create tag...").fill("rolled-back");
    await page.getByRole("option", { name: /add .*rolled-back/i }).click();
    await page.keyboard.press("Escape");
    await expect(row.getByRole("button", { name: "Remove rolled-back", exact: true })).toBeVisible();

    // Later writes: one valid new prompt and the sentinel, in the same save.
    const textarea = await openBulkPaste(page);
    await textarea.fill(`${VALID_NEW};ok\n${SENTINEL};boom`);
    await page.getByRole("button", { name: /^add 2 prompts$/i }).click();
    const unsavedBar = page.getByText("Unsaved changes", { exact: true });
    await expect(unsavedBar).toBeVisible();

    await page.getByRole("button", { name: /save changes/i }).click();
    const alert = page.getByRole("alert").filter({ hasText: /failed/i });
    await expect(alert).toBeVisible({ timeout: 60_000 });
    // The edits are still there for the user to fix or discard.
    await expect(unsavedBar).toBeVisible();
    await expect(page.getByRole("button", { name: /save changes/i })).toBeEnabled();

    // Nothing from the batch reached the database.
    const seededAfter = await client.query("SELECT tags FROM prompts WHERE id = $1", [PROMPT_IDS.branded1]);
    expect(seededAfter.rows[0].tags).toEqual(baselineTags);
    const batch = await client.query("SELECT value FROM prompts WHERE value = ANY($1::text[])", [[SENTINEL, VALID_NEW]]);
    expect(batch.rows).toEqual([]);
    expect((await client.query("SELECT count(*)::int AS n FROM prompts WHERE brand_id = $1", [TEST_BRAND_ID])).rows[0].n).toBe(
      baselineCount,
    );
    expect((await client.query("SELECT id, value, tags FROM prompts WHERE brand_id = 'nike' ORDER BY id")).rows).toEqual(
      nikeBefore,
    );
  });
});
