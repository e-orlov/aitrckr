/**
 * F-07R1 — the Share of Voice summary card lists the donut's slices beside the
 * donut, permanently visible: brand, the Top-6 competitors in canonical order
 * and a conditional Others row, each with its sector colour and once-rounded
 * share.
 *
 * The spec seeds its own brand (nine competitors, all runs on one day so the
 * standings are plain mention counts, a tie at the Top-6 boundary broken by
 * name, a model whose runs leave no tail) and reconciles the list with the
 * rendered sectors, the leaderboard, the trend's last point and an independent
 * SQL count — without importing the application helper.
 */
import { expect, type Page, test } from "@playwright/test";
import pg from "pg";
import { brandUrl, DATABASE_URL, TEST_ORG_SLUG } from "../../fixtures";

const BRAND_ID = "f07r1-sov";
const BRAND_NAME = "F07R1";
const BRAND_URL = brandUrl(BRAND_ID, TEST_ORG_SLUG);

const PROMPTS = {
	first: "6f07f001-0000-4000-8000-000000000001",
	second: "6f07f001-0000-4000-8000-000000000002",
};
const NINE = ["Alpha", "Bravo", "Charlie", "Delta", "Echo", "Foxtrot", "Golf", "Hotel", "India"];
const [ALPHA, BRAVO, CHARLIE, DELTA, ECHO, FOXTROT, GOLF] = NINE;

function noonDaysAgo(days: number): Date {
	const d = new Date();
	d.setUTCHours(12, 0, 0, 0);
	d.setUTCDate(d.getUTCDate() - days);
	return d;
}

// All on one day: standings = mention counts. Brand 6; Alpha 5, Bravo 4, Charlie 3,
// Delta/Echo/Foxtrot/Golf 2 (Golf loses the boundary tie by name), Hotel/India 1.
// Total 28 → 21/18/14/11/7/7/7 + Others 14 = 99% displayed. `claude` alone: brand 2,
// Alpha 2, Bravo 1 → 40/40/20, no Others.
const RUNS: { id: string; promptId: string; model: string; brand: boolean; competitors: string[] }[] = [
	{ id: "6f07f002-0000-4000-8000-000000000001", promptId: PROMPTS.first, model: "chatgpt", brand: true, competitors: NINE },
	{ id: "6f07f002-0000-4000-8000-000000000002", promptId: PROMPTS.first, model: "chatgpt", brand: true, competitors: [ALPHA, BRAVO, CHARLIE, DELTA, ECHO, FOXTROT, GOLF] },
	{ id: "6f07f002-0000-4000-8000-000000000003", promptId: PROMPTS.first, model: "claude", brand: true, competitors: [ALPHA, BRAVO] },
	{ id: "6f07f002-0000-4000-8000-000000000004", promptId: PROMPTS.second, model: "claude", brand: true, competitors: [ALPHA] },
	{ id: "6f07f002-0000-4000-8000-000000000005", promptId: PROMPTS.second, model: "chatgpt", brand: true, competitors: [] },
	{ id: "6f07f002-0000-4000-8000-000000000006", promptId: PROMPTS.second, model: "chatgpt", brand: true, competitors: [ALPHA, BRAVO, CHARLIE] },
];

const BRAND_COLOR = "#2563eb";
const OTHERS_COLOR = "#cbd5e1";
const PALETTE = ["#10b981", "#f59e0b", "#8b5cf6", "#ec4899", "#14b8a6", "#f97316"];

// ---------------------------------------------------------------------------
// Independent oracle: plain counts → brand, Top-6 (mentions desc, then name), Others.
// ---------------------------------------------------------------------------

interface OracleRow {
	name: string;
	kind: "brand" | "competitor" | "others";
	mentions: number;
	percent: number;
	color: string;
}

async function oracle(client: pg.Client, model?: string): Promise<OracleRow[]> {
	const params: unknown[] = [BRAND_ID];
	const modelClause = model ? " AND model = $2" : "";
	if (model) params.push(model);
	const brand = await client.query<{ n: string }>(
		`SELECT count(*)::text AS n FROM prompt_runs WHERE brand_id = $1 AND brand_mentioned${modelClause}`,
		params,
	);
	const comps = await client.query<{ name: string; n: string }>(
		`SELECT c AS name, count(*)::text AS n FROM prompt_runs r, unnest(r.competitors_mentioned) AS c
		 WHERE r.brand_id = $1${modelClause} GROUP BY c ORDER BY count(*) DESC, c ASC`,
		params,
	);
	const brandMentions = Number(brand.rows[0].n);
	const competitors = comps.rows.map((r) => ({ name: r.name, mentions: Number(r.n) }));
	const total = brandMentions + competitors.reduce((s, c) => s + c.mentions, 0);
	const shown = competitors.slice(0, 6);
	const tail = competitors.slice(6).reduce((s, c) => s + c.mentions, 0);
	// Server order: mentions desc, brand ahead on a tie, then name — the brand keeps its rank.
	const ranked = [
		{ name: BRAND_NAME, kind: "brand" as const, mentions: brandMentions, color: BRAND_COLOR },
		...shown.map((c, i) => ({ name: c.name, kind: "competitor" as const, mentions: c.mentions, color: PALETTE[i] })),
	].sort((a, b) => b.mentions - a.mentions || (a.kind === "brand" ? -1 : b.kind === "brand" ? 1 : a.name.localeCompare(b.name)));
	const rows: OracleRow[] = ranked.map((r) => ({ ...r, percent: Math.round((r.mentions / total) * 100) }));
	if (tail > 0) rows.push({ name: "Others", kind: "others", mentions: tail, percent: Math.round((tail / total) * 100), color: OTHERS_COLOR });
	return rows;
}

// ---------------------------------------------------------------------------
// Page access
// ---------------------------------------------------------------------------

const brandList = (page: Page) => page.getByTestId("share-of-voice-brand-list");
const listRows = (page: Page) => brandList(page).getByRole("listitem");
const sectors = (page: Page) => page.locator(".recharts-pie-sector path");

async function renderedRows(page: Page) {
	return listRows(page).evaluateAll((lis) =>
		lis.map((li) => {
			const spans = li.querySelectorAll("span");
			return {
				entity: li.getAttribute("data-entity"),
				name: spans[1].textContent ?? "",
				title: spans[1].getAttribute("title"),
				you: li.textContent?.includes("You") ?? false,
				percent: (li.lastElementChild as HTMLElement).textContent ?? "",
				dot: getComputedStyle(spans[0]).backgroundColor,
				dotHidden: spans[0].getAttribute("aria-hidden"),
			};
		}),
	);
}
const hexToRgb = (hex: string) => {
	const n = Number.parseInt(hex.slice(1), 16);
	return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
};

async function expectListMatches(page: Page, expected: OracleRow[]) {
	await expect(listRows(page)).toHaveCount(expected.length, { timeout: 30_000 });
	await expect(sectors(page)).toHaveCount(expected.length);
	const rows = await renderedRows(page);
	expect(rows.map((r) => r.name)).toEqual(expected.map((e) => e.name));
	expect(rows.map((r) => r.percent)).toEqual(expected.map((e) => `${e.percent}%`));
	expect(rows.map((r) => r.dot)).toEqual(expected.map((e) => hexToRgb(e.color)));
	expect(rows.map((r) => r.you)).toEqual(expected.map((e) => e.kind === "brand"));
	expect(rows.every((r) => r.dotHidden === "true" && r.title === r.name)).toBe(true);
	// Sector fills in DOM order are the list colours in list order.
	expect(await sectors(page).evaluateAll((ps) => ps.map((p) => p.getAttribute("fill")))).toEqual(expected.map((e) => e.color));
}

/** Names are rendered in full (no ellipsis) and the percentage sits inside the list box. */
async function expectNamesReadable(page: Page) {
	const listBox = (await brandList(page).boundingBox()) as { x: number; width: number };
	for (const li of await listRows(page).all()) {
		const name = li.locator("span").nth(1);
		expect(await name.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
		const pct = (await li.locator("span").last().boundingBox()) as { x: number; width: number };
		expect(pct.x + pct.width).toBeLessThanOrEqual(listBox.x + listBox.width + 1);
	}
}

async function noHorizontalOverflow(page: Page) {
	const metrics = await page.evaluate(() => ({
		scrollWidth: document.documentElement.scrollWidth,
		clientWidth: document.documentElement.clientWidth,
	}));
	expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.clientWidth);
}

async function screenshot(page: Page, name: string) {
	const dir = process.env.F07R1_SCREENSHOT_DIR;
	if (dir) await page.screenshot({ path: `${dir}/${name}.png`, fullPage: true });
}

/** Sweep the pointer around the ring (between inner and outer radius) until the tooltip names the entity. */
async function hoverUntilTooltip(page: Page, text: string) {
	const box = (await page.locator(".recharts-pie").first().boundingBox()) as { x: number; y: number; width: number; height: number };
	const cx = box.x + box.width / 2;
	const cy = box.y + box.height / 2;
	const r = 66;
	for (let deg = 0; deg < 360; deg += 6) {
		const a = (deg * Math.PI) / 180;
		await page.mouse.move(cx + r * Math.cos(a), cy + r * Math.sin(a));
		await page.waitForTimeout(40);
		const shown = await page
			.getByTestId("share-of-voice-donut")
			.locator(".recharts-tooltip-wrapper")
			.textContent()
			.catch(() => "");
		if (shown?.includes(text)) return;
	}
	throw new Error(`tooltip never showed "${text}"`);
}

// ---------------------------------------------------------------------------

test.describe("Share of Voice visible brand list", () => {
	test.describe.configure({ mode: "serial" });
	test.use({ timezoneId: "UTC" });

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
			 VALUES ($1, $2, $1, $3, 'https://f07r1.example.test/', true, true, NOW(), NOW())`,
			[BRAND_ID, org.rows[0].id, BRAND_NAME],
		);
		await client.query(
			`INSERT INTO prompts (id, brand_id, value, enabled, tags, system_tags, created_at, updated_at) VALUES
			 ($1, $3, 'Welche Rechtsschutzversicherung ist die beste?', true, '{}', $4, NOW(), NOW()),
			 ($2, $3, 'Was kostet Rechtsschutz?', true, '{}', $4, NOW(), NOW())`,
			[PROMPTS.first, PROMPTS.second, BRAND_ID, ["unbranded"]],
		);
		for (const [i, name] of NINE.entries()) {
			await client.query(
				`INSERT INTO competitors (id, brand_id, name, domains, created_at, updated_at)
				 VALUES ($1, $2, $3, $4, NOW(), NOW())`,
				[`6f07f003-0000-4000-8000-00000000000${i + 1}`, BRAND_ID, name, [`${name.toLowerCase()}.example.test`]],
			);
		}
		const createdAt = noonDaysAgo(1);
		for (const run of RUNS) {
			await client.query(
				`INSERT INTO prompt_runs (id, prompt_id, brand_id, model, provider, version, web_search_enabled, raw_output, web_queries, brand_mentioned, competitors_mentioned, created_at)
				 VALUES ($1, $2, $3, $4, 'brightdata', 'f07r1', true, '{}', '{}', $5, $6, $7)`,
				[run.id, run.promptId, BRAND_ID, run.model, run.brand, run.competitors, createdAt],
			);
		}
	});

	test.afterAll(async () => {
		try {
			await client.query("DELETE FROM prompt_runs WHERE brand_id = $1", [BRAND_ID]);
			await client
				.query("DELETE FROM pgboss.job WHERE name = 'process-prompt' AND data->>'promptId' = ANY($1::text[])", [Object.values(PROMPTS)])
				.catch(() => undefined);
			await client.query("DELETE FROM prompts WHERE brand_id = $1", [BRAND_ID]);
			await client.query("DELETE FROM competitors WHERE brand_id = $1", [BRAND_ID]);
			await client.query("DELETE FROM brands WHERE id = $1", [BRAND_ID]);
		} finally {
			await client.end();
		}
	});

	test("the list is permanently visible beside the donut and mirrors its slices, the leaderboard and the trend (FR-001…FR-008)", async ({
		page,
	}) => {
		const consoleErrors: string[] = [];
		const pageErrors: string[] = [];
		const failedRequests: string[] = [];
		const shareOfVoiceCalls: string[] = [];
		page.on("pageerror", (e) => pageErrors.push(e.message));
		page.on("console", (m) => {
			if (m.type() === "error" && !m.text().startsWith("Failed to load resource")) consoleErrors.push(m.text());
		});
		page.on("response", async (r) => {
			const url = new URL(r.url());
			if (url.origin !== new URL(page.url()).origin) return;
			if (r.status() >= 400) failedRequests.push(`${r.status()} ${url.pathname}`);
			if (url.pathname.includes("/_serverFn/")) {
				const text = await r.text().catch(() => "");
				if (text.includes('"comparisonTrend"')) shareOfVoiceCalls.push(url.pathname);
			}
		});

		await page.setViewportSize({ width: 1400, height: 1000 });
		await page.goto(`${BRAND_URL}/share-of-voice?lookback=1m`);
		const expected = await oracle(client);
		expect(expected.map((e) => [e.name, e.percent])).toEqual([
			[BRAND_NAME, 21],
			[ALPHA, 18],
			[BRAVO, 14],
			[CHARLIE, 11],
			[DELTA, 7],
			[ECHO, 7],
			[FOXTROT, 7],
			["Others", 14],
		]);
		await expectListMatches(page, expected);
		await expect(brandList(page)).toBeVisible();
		await expect(brandList(page)).toHaveAttribute("aria-label", "Brands");
		// No Recharts legend, no interactive elements, no extra tab stops.
		await expect(page.locator(".recharts-legend-wrapper")).toHaveCount(0);
		await expect(brandList(page).locator("button, a, [tabindex]")).toHaveCount(0);
		await expect(page.locator(".recharts-pie")).toHaveCount(1);

		// Independently rounded shares: 99% displayed, nothing redistributed.
		const shown = (await renderedRows(page)).map((r) => Number(r.percent.replace("%", "")));
		expect(shown.reduce((s, v) => s + v, 0)).toBe(99);

		// Leaderboard: the same share for every listed entity; the tail rows stay individual there.
		for (const e of expected.filter((e) => e.kind !== "others")) {
			const row = page.getByRole("row").filter({ hasText: e.name });
			await expect(row).toHaveCount(1);
			await expect(row.locator("td").nth(3)).toHaveText(`${e.percent}%`);
		}
		await expect(page.getByRole("row").filter({ hasText: GOLF }).locator("td").nth(3)).toHaveText("7%");
		await expect(page.getByRole("row").filter({ hasText: "Others" })).toHaveCount(0);

		// Trend legend and last point: the same roster in the same order, the same colours.
		await expect(page.getByTestId("share-of-voice-trend-legend").getByRole("listitem")).toHaveText(expected.map((e) => e.name));
		await expect(page.getByTestId("share-of-voice-trend-chart").locator("path.recharts-line-curve")).toHaveCount(expected.length, {
			timeout: 30_000,
		});
		expect(
			await page
				.getByTestId("share-of-voice-trend-chart")
				.locator("path.recharts-line-curve")
				.evaluateAll((ps) => ps.map((p) => p.getAttribute("stroke"))),
		).toEqual(expected.map((e) => e.color));
		// Headline == brand row of the list.
		const headline = page.locator("[data-slot=card]").filter({ has: brandList(page) }).locator(".tabular-nums").first();
		await expect(headline).toHaveText(`${expected[0].percent}%`);

		// One Share of Voice server call for the page; the list added none.
		await page.waitForTimeout(500);
		expect(shareOfVoiceCalls).toHaveLength(1);

		// Shared summary composition (UI-R1): summary text full width above; donut then list to its
		// right in one vertically centred group; the group starts at the content's left edge.
		const donutBox = (await page.locator(".recharts-wrapper").first().boundingBox()) as { x: number; y: number; width: number; height: number };
		const listBox = (await brandList(page).boundingBox()) as { x: number; y: number; width: number; height: number };
		const summaryBox = (await headline.boundingBox()) as { x: number; y: number; width: number; height: number };
		expect(listBox.x).toBeGreaterThanOrEqual(donutBox.x + donutBox.width);
		expect(listBox.x - (donutBox.x + donutBox.width)).toBeLessThanOrEqual(16);
		expect(donutBox.y).toBeGreaterThanOrEqual(summaryBox.y + summaryBox.height);
		expect(Math.abs(donutBox.x - summaryBox.x)).toBeLessThanOrEqual(1);
		expect(Math.abs(listBox.y + listBox.height / 2 - (donutBox.y + donutBox.height / 2))).toBeLessThan(12);
		const cardBox = (await page.locator("[data-slot=card]").filter({ has: brandList(page) }).boundingBox()) as { height: number; x: number; width: number };
		expect(listBox.x + listBox.width).toBeLessThanOrEqual(cardBox.x + cardBox.width);
		await expectNamesReadable(page);
		await screenshot(page, "01-desktop");

		// Narrower desktop (half-width card): the group keeps its row while the card is wide enough.
		await page.setViewportSize({ width: 1280, height: 800 });
		await expectListMatches(page, expected);
		await expectNamesReadable(page);
		await noHorizontalOverflow(page);
		await screenshot(page, "01b-desktop-1280");
		await page.setViewportSize({ width: 1400, height: 1000 });

		// The donut tooltip still answers hover with the same once-rounded share.
		await hoverUntilTooltip(page, `${BRAND_NAME}: ${expected[0].percent}%`);
		await hoverUntilTooltip(page, `Others: ${expected.at(-1)?.percent}%`);
		await screenshot(page, "02-tooltip");

		expect(consoleErrors).toEqual([]);
		expect(pageErrors).toEqual([]);
		expect(failedRequests).toEqual([]);
	});

	test("filters replace donut and list together, and Others disappears when no competitor is hidden (FR-007, FR-009)", async ({ page }) => {
		await page.goto(`${BRAND_URL}/share-of-voice?lookback=1m&model=claude`);
		const claude = await oracle(client, "claude");
		expect(claude.map((e) => [e.name, e.percent])).toEqual([
			[BRAND_NAME, 40],
			[ALPHA, 40],
			[BRAVO, 20],
		]);
		await expectListMatches(page, claude);
		await expect(brandList(page).getByText("Others")).toHaveCount(0);
		await expect(page.getByTestId("share-of-voice-trend-legend").getByRole("listitem")).toHaveText(claude.map((e) => e.name));
		await screenshot(page, "03-model-claude-no-others");

		await page.goto(`${BRAND_URL}/share-of-voice?lookback=1m&model=chatgpt`);
		const chatgpt = await oracle(client, "chatgpt");
		expect(chatgpt).toHaveLength(8);
		await expectListMatches(page, chatgpt);

		// Switching the lookback in the UI re-renders both from one response.
		await page.goto(`${BRAND_URL}/share-of-voice?lookback=1m`);
		await expectListMatches(page, await oracle(client));
	});

	test("narrow, dark and zoomed layouts stack safely without horizontal overflow (NFR-005, NFR-006)", async ({ page }) => {
		await page.setViewportSize({ width: 375, height: 812 });
		await page.goto(`${BRAND_URL}/share-of-voice?lookback=1m`);
		const expected = await oracle(client);
		await expectListMatches(page, expected);
		await noHorizontalOverflow(page);
		const donutBox = (await page.locator(".recharts-wrapper").first().boundingBox()) as { x: number; y: number; width: number; height: number };
		const listBox = (await brandList(page).boundingBox()) as { x: number; y: number; width: number; height: number };
		const summary = page.locator("[data-slot=card]").filter({ has: brandList(page) }).locator(".tabular-nums").first();
		const summaryBox = (await summary.boundingBox()) as { y: number; height: number };
		// Summary first, donut centred below it, list below the donut; every percentage inside the viewport.
		expect(donutBox.y).toBeGreaterThanOrEqual(summaryBox.y + summaryBox.height);
		expect(listBox.y).toBeGreaterThanOrEqual(donutBox.y + donutBox.height);
		expect(Math.abs(donutBox.x + donutBox.width / 2 - 375 / 2)).toBeLessThan(24);
		for (const li of await listRows(page).all()) {
			const box = (await li.locator("span").last().boundingBox()) as { x: number; width: number };
			expect(box.x + box.width).toBeLessThanOrEqual(375);
		}
		await expectNamesReadable(page);
		await screenshot(page, "04-narrow-375");

		// 200% zoom ≈ a 640-px-wide layout: still no page overflow, list still complete.
		await page.setViewportSize({ width: 640, height: 900 });
		await expectListMatches(page, expected);
		await noHorizontalOverflow(page);

		await page.setViewportSize({ width: 1280, height: 800 });
		await page.evaluate(() => document.documentElement.classList.add("dark"));
		await expectListMatches(page, expected);
		const rows = await renderedRows(page);
		expect(rows[0].dot).toBe(hexToRgb(BRAND_COLOR));
		const nameColor = await listRows(page).nth(1).locator("span").nth(1).evaluate((el) => getComputedStyle(el).color);
		const brandColor = await listRows(page).nth(0).locator("span").nth(1).evaluate((el) => getComputedStyle(el).color);
		expect(nameColor).not.toBe(brandColor);
		expect(brandColor).not.toBe("rgb(0, 0, 0)");
		await screenshot(page, "05-dark");
		await page.evaluate(() => document.documentElement.classList.remove("dark"));
	});

	test("AI Visibility, the Overview and Citations are untouched (FR-010, NFR-009)", async ({ page }) => {
		await page.goto(`${BRAND_URL}/visibility`);
		const section = page.getByTestId("competitive-visibility-section");
		await expect(section).toBeVisible({ timeout: 30_000 });
		await expect(section.locator(".recharts-pie")).toHaveCount(0);
		await expect(page.getByTestId("share-of-voice-brand-list")).toHaveCount(0);
		await expect(page.getByTestId("competitive-visibility-radial-legend")).toBeVisible();
		await expect(page.getByTestId("competitive-visibility-radial-legend").getByRole("listitem").first()).toContainText("You");

		await page.goto(BRAND_URL);
		await expect(page.locator("[data-slot=chart]").first()).toBeVisible({ timeout: 30_000 });
		await expect(page.getByTestId("share-of-voice-brand-list")).toHaveCount(0);
		await expect(page.locator(".recharts-pie")).toHaveCount(0);

		await page.goto(`${BRAND_URL}/citations`);
		await expect(page.getByRole("heading", { level: 1 })).toBeVisible({ timeout: 30_000 });
		await expect(page.getByTestId("share-of-voice-brand-list")).toHaveCount(0);
	});
});
