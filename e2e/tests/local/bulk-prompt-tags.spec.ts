/**
 * Bulk prompt import with semicolon-separated tags, end to end through the
 * prompts settings editor: paste → stage (no write) → save → reload → filter,
 * with the database and the pg-boss queue checked at each step.
 *
 * Runs against the local test stack with the worker down, so the immediate
 * `process-prompt` job each new prompt gets stays in `created` and can be
 * counted. The prompts it adds are removed again through the public API at the
 * end so the seeded fixtures other specs assert on are left as they were.
 */
import { expect, type Page, test } from "@playwright/test";
import pg from "pg";
import { brandUrl, DATABASE_URL, TEST_API_KEY, TEST_BRAND_ID } from "../../fixtures";

const NEW_PROMPTS = {
  // Mentions the seeded brand's domain, so the server must compute `branded`
  // on its own while the pasted user tags stay user tags.
  branded: "Is example.com a good legal insurance provider?",
  compare: "What should I compare before buying legal insurance?",
  legacy: "Which legal insurance is best for a family?",
} as const;

// The paste also repeats a seeded prompt (case and spacing changed) and has a
// blank line, both of which are reported and never staged.
const PASTE = [
  `${NEW_PROMPTS.branded};Insurance;comparison;; INSURANCE ;family`,
  "",
  `${NEW_PROMPTS.compare};insurance;Buying Guide`,
  "COMPARE  AI VISIBILITY PLATFORMS and their features;dup-tag",
  NEW_PROMPTS.legacy,
].join("\n");

const EXPECTED_TAGS: Record<keyof typeof NEW_PROMPTS, string[]> = {
  branded: ["insurance", "comparison", "family"],
  compare: ["insurance", "buying guide"],
  legacy: [],
};

type PromptRow = { id: string; value: string; tags: string[]; system_tags: string[]; enabled: boolean };

async function promptRows(client: pg.Client): Promise<PromptRow[]> {
  const { rows } = await client.query<PromptRow>(
    "SELECT id, value, tags, system_tags, enabled FROM prompts WHERE brand_id = $1 AND value = ANY($2::text[]) ORDER BY value",
    [TEST_BRAND_ID, Object.values(NEW_PROMPTS)],
  );
  return rows;
}

async function brandPromptCount(client: pg.Client): Promise<number> {
  const { rows } = await client.query<{ n: number }>(
    "SELECT COUNT(*)::int AS n FROM prompts WHERE brand_id = $1",
    [TEST_BRAND_ID],
  );
  return rows[0].n;
}

/** Pending `process-prompt` jobs per prompt id — the canonical chain each enabled prompt owns. */
async function pendingChains(client: pg.Client, promptIds: string[]): Promise<Map<string, number>> {
  const { rows } = await client.query<{ prompt_id: string; n: number }>(
    `SELECT data->>'promptId' AS prompt_id, COUNT(*)::int AS n
       FROM pgboss.job
      WHERE name = 'process-prompt' AND state IN ('created', 'retry', 'active')
        AND data->>'promptId' = ANY($1::text[])
      GROUP BY 1`,
    [promptIds],
  );
  return new Map(rows.map((r) => [r.prompt_id, r.n]));
}

/**
 * The editor renders every row twice (stacked mobile block + desktop grid).
 * DOM-level counts see both; role queries only see the visible desktop copy.
 */
const LAYOUTS = 2;

const promptInputs = (page: Page) => page.getByPlaceholder("Enter prompt text...");

/** How many prompt inputs currently hold `value` (Playwright has no display-value query). */
const countPromptInputs = (page: Page, value: string) =>
  promptInputs(page).evaluateAll(
    (els, wanted) => els.filter((el) => (el as HTMLInputElement).value === wanted).length,
    value,
  );

async function expectPromptRows(page: Page, value: string, rows: number) {
  await expect.poll(() => countPromptInputs(page, value)).toBe(rows * LAYOUTS);
}

/** The visible prompt input holding `value`, for editing it. */
async function promptInput(page: Page, value: string) {
  const visible = promptInputs(page).filter({ visible: true });
  const index = await visible.evaluateAll(
    (els, wanted) => els.findIndex((el) => (el as HTMLInputElement).value === wanted),
    value,
  );
  expect(index, `no visible prompt input holds "${value}"`).toBeGreaterThanOrEqual(0);
  return visible.nth(index);
}

/**
 * Opens the bulk-paste box. The click is retried because under load the
 * settings page can still be hydrating when the button first renders, and a
 * click that lands before React attaches its handlers does nothing.
 */
async function openBulkPaste(page: Page) {
  const textarea = page.getByRole("textbox", { name: /prompts to add/i });
  await expect(async () => {
    await page.getByRole("button", { name: /add multiple/i }).click();
    await expect(textarea).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
  return textarea;
}

async function expectStagedTags(page: Page, expectedCounts: Record<string, number>) {
  for (const [tag, rows] of Object.entries(expectedCounts)) {
    await expect(page.getByRole("button", { name: `Remove ${tag}`, exact: true })).toHaveCount(rows);
  }
}

test.describe("Bulk prompt import with tags", () => {
  test.describe.configure({ mode: "serial" });

  let client: pg.Client;
  let countBefore: number;
  const createdIds: string[] = [];

  test.beforeAll(async () => {
    client = new pg.Client({ connectionString: DATABASE_URL });
    await client.connect();
    countBefore = await brandPromptCount(client);
  });

  test.afterAll(async ({ request }) => {
    for (const id of createdIds) {
      const res = await request.delete(`/api/v1/prompts/${id}`, {
        headers: { Authorization: `Bearer ${TEST_API_KEY}` },
      });
      expect(res.ok(), `cleanup of ${id}: ${res.status()}`).toBeTruthy();
    }
    // The API delete unschedules but leaves the already-enqueued first job; drop
    // it so the worker phase never picks up a prompt that no longer exists.
    if (createdIds.length > 0) {
      await client.query("DELETE FROM pgboss.job WHERE name = 'process-prompt' AND data->>'promptId' = ANY($1::text[])", [
        createdIds,
      ]);
    }
    expect(await brandPromptCount(client)).toBe(countBefore);
    await client.end();
  });

  test("paste, stage, save, reload and filter tagged prompts", async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto(`${brandUrl()}/settings/prompts`);
    await expect(page.getByRole("textbox").first()).toBeVisible();

    // F04-UI-001 — the syntax is discoverable and the textarea has an accessible name.
    const textarea = await openBulkPaste(page);
    await expect(textarea).toHaveAccessibleName(/prompts to add, one per line.*semicolons/i);
    await expect(textarea).toHaveAccessibleDescription(/Prompt text;tag1;tag2/);
    await expect(page.getByText(/semicolons separate fields/i)).toBeVisible();

    // F04-UI-002 / F04-UI-008 — three valid records, one duplicate and one blank reported.
    await textarea.fill(PASTE);
    const addButton = page.getByRole("button", { name: /^add 3 prompts$/i });
    await expect(addButton).toBeEnabled();
    await expect(page.getByText("Skipped 1 duplicate and 1 blank line.")).toBeVisible();

    // F04-UI-004 — nothing is written by pasting.
    expect(await brandPromptCount(client)).toBe(countBefore);
    expect(await promptRows(client)).toEqual([]);

    // F04-UI-003 — staged rows carry their own normalized tags.
    await addButton.click();
    for (const value of Object.values(NEW_PROMPTS)) {
      await expectPromptRows(page, value, 1);
    }
    await expectStagedTags(page, { insurance: 2, comparison: 2, family: 1, "buying guide": 1 });
    await expect(page.getByRole("button", { name: /Remove INSURANCE/ })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Remove dup-tag", exact: true })).toHaveCount(0);
    const saveButton = page.getByRole("button", { name: /save changes/i });
    const unsavedBar = page.getByText("Unsaved changes", { exact: true });
    await expect(saveButton).toBeVisible();
    await expect(unsavedBar).toBeVisible();

    // F04-UI-004 — staging is still not a write.
    expect(await brandPromptCount(client)).toBe(countBefore);

    // F04-UI-005 / F04-IT-001 / F04-IT-003 — one save persists all three, tags
    // normalized on the right rows, system tags computed by the server.
    await saveButton.click();
    await expect(unsavedBar).toBeHidden({ timeout: 30_000 });
    const rows = await promptRows(client);
    expect(rows).toHaveLength(3);
    expect(await brandPromptCount(client)).toBe(countBefore + 3);
    const byValue = new Map(rows.map((r) => [r.value, r]));
    for (const [key, value] of Object.entries(NEW_PROMPTS) as [keyof typeof NEW_PROMPTS, string][]) {
      const row = byValue.get(value);
      expect(row, value).toBeDefined();
      expect(row!.tags).toEqual(EXPECTED_TAGS[key]);
      expect(row!.enabled).toBe(true);
      createdIds.push(row!.id);
    }
    expect(byValue.get(NEW_PROMPTS.branded)!.system_tags).toEqual(["branded"]);
    expect(byValue.get(NEW_PROMPTS.compare)!.system_tags).toEqual(["unbranded"]);
    expect(byValue.get(NEW_PROMPTS.legacy)!.system_tags).toEqual(["unbranded"]);

    // F04-IT-006 / F04-IT-007 — each new prompt owns exactly one pending chain.
    await expect
      .poll(async () => [...(await pendingChains(client, createdIds)).values()], { timeout: 15_000 })
      .toEqual([1, 1, 1]);

    // F04-UI-005 — a full reload shows the same rows and chips.
    await page.reload();
    for (const value of Object.values(NEW_PROMPTS)) {
      await expectPromptRows(page, value, 1);
    }
    await expectStagedTags(page, { insurance: 2, comparison: 2, family: 1, "buying guide": 1 });

    // F04-UI-011 / F04-IT-007 — a later save updates the adopted rows instead
    // of inserting them again, and does not multiply their chains.
    const legacyInput = await promptInput(page, NEW_PROMPTS.legacy);
    await legacyInput.fill(`${NEW_PROMPTS.legacy} today`);
    await legacyInput.blur();
    await saveButton.click();
    await expect(unsavedBar).toBeHidden({ timeout: 30_000 });
    expect(await brandPromptCount(client)).toBe(countBefore + 3);
    const { rows: renamed } = await client.query<{ id: string; tags: string[] }>(
      "SELECT id, tags FROM prompts WHERE brand_id = $1 AND value = $2",
      [TEST_BRAND_ID, `${NEW_PROMPTS.legacy} today`],
    );
    expect(renamed).toHaveLength(1);
    expect(createdIds).toContain(renamed[0].id);
    expect([...(await pendingChains(client, createdIds)).values()]).toEqual([1, 1, 1]);

    // F04-UI-006 — the imported tags drive the existing tag filter.
    await page.goto(`${brandUrl()}/visibility`);
    await page.getByRole("button", { name: /^tags/i }).click();
    await page.getByRole("button", { name: /^buying guide$/i }).click();
    await expect(page).toHaveURL(/tags=buying(\+|%20)guide/);
    await expect(page.getByText(NEW_PROMPTS.compare)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(NEW_PROMPTS.branded)).toHaveCount(0);
    await page.getByRole("button", { name: /^insurance$/i }).click();
    await expect(page.getByText(NEW_PROMPTS.branded)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(NEW_PROMPTS.compare)).toBeVisible();
    await expect(page.getByText(`${NEW_PROMPTS.legacy} today`)).toHaveCount(0);
  });

  test("a line with tags but no prompt blocks the whole paste and names the line", async ({ page }) => {
    // F04-UI-007 / F04-UI-009 — errors are announced and nothing is staged.
    await page.goto(`${brandUrl()}/settings/prompts`);
    const textarea = await openBulkPaste(page);
    await textarea.fill("fine prompt;tag\n;orphan\n  ;a;b");
    await expect(page.getByRole("alert")).toHaveText(
      "Lines 2 and 3 have no prompt text before their first semicolon. Fix or remove them to continue.",
    );
    await expect(page.getByRole("button", { name: /^add 1 prompt$/i })).toBeDisabled();
    await expectPromptRows(page, "fine prompt", 0);
    expect(await brandPromptCount(client)).toBe(countBefore + 3);
  });

  test("legacy untagged paste and manual tag editing still work without saving", async ({ page }) => {
    // F04-UI-010 — the pre-existing formats are unchanged; nothing is saved here.
    await page.goto(`${brandUrl()}/settings/prompts`);
    await (await openBulkPaste(page)).fill("plain line one\nplain line two");
    await page.getByRole("button", { name: /^add 2 prompts$/i }).click();
    await expectPromptRows(page, "plain line one", 1);
    await expectPromptRows(page, "plain line two", 1);

    // "Add Prompt" appends a blank row; both layouts render it, the desktop one last.
    await page.getByRole("button", { name: /^add prompt$/i }).click();
    await promptInputs(page).filter({ visible: true }).last().fill("typed by hand");
    await expectPromptRows(page, "typed by hand", 1);

    // Manual tag editing through the tags combobox on that same row.
    await page.getByRole("combobox").filter({ hasText: "Add tag..." }).last().click();
    await page.getByPlaceholder("Search or create tag...").fill("Handmade");
    await page.getByRole("option", { name: /add .*handmade/i }).click();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("button", { name: "Remove handmade", exact: true })).toHaveCount(1);
    await expect(page.getByRole("button", { name: /save changes/i })).toBeVisible();
    // Leave without saving — fixtures stay untouched.
    expect(await brandPromptCount(client)).toBe(countBefore + 3);
  });
});
