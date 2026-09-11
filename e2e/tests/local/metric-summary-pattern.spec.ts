/**
 * UI-R1 — the Share of Voice and AI Visibility summary cards share one
 * presentation pattern: an `h2` title with an "About …" tip, headline and
 * explanation across the card width, then one visual group (chart left,
 * legend right; stacked when the card itself is narrow). This spec proves the
 * shared structure and responsive behaviour on both real routes with a seeded
 * brand, and that each metric keeps its own chart type,
 * values and request count.
 */
import { expect, type Locator, type Page, test } from "@playwright/test";
import pg from "pg";
import { brandUrl, DATABASE_URL, TEST_ORG_SLUG } from "../../fixtures";

const BRAND_ID = "ui-r1-metric";
const BRAND_NAME = "UI-R1";
const BRAND_URL = brandUrl(BRAND_ID, TEST_ORG_SLUG);
const WIDTHS = [1400, 1280, 1024, 768, 375] as const;
const PROMPT_ID = "6f0a0001-0000-4000-8000-000000000001";
const COMPETITORS = ["Alpha", "Bravo", "Charlie", "Delta", "Echo", "Foxtrot", "Golf", "Hotel"];

function noonDaysAgo(days: number): Date {
	const d = new Date();
	d.setUTCHours(12, 0, 0, 0);
	d.setUTCDate(d.getUTCDate() - days);
	return d;
}
// Three runs on one day: brand 3, Alpha 3, Bravo 2, Charlie 2, Delta..Golf 1 each, Hotel 0 (tracked, never mentioned).
const RUNS = [
	{ id: "6f0a0002-0000-4000-8000-000000000001", competitors: COMPETITORS.slice(0, 7) },
	{ id: "6f0a0002-0000-4000-8000-000000000002", competitors: ["Alpha", "Bravo", "Charlie"] },
	{ id: "6f0a0002-0000-4000-8000-000000000003", competitors: ["Alpha"] },
];

interface Card {
	name: string;
	url: string;
	card: (page: Page) => Locator;
	chart: string;
	otherChart: string;
	legendTestId: string;
	ready: (page: Page) => Promise<void>;
}

const CARDS: Card[] = [
	{
		name: "Share of Voice",
		url: `${BRAND_URL}/share-of-voice?lookback=1m`,
		card: (page) => page.getByTestId("share-of-voice-summary"),
		chart: ".recharts-pie-sector",
		otherChart: ".recharts-radial-bar",
		legendTestId: "share-of-voice-brand-list",
		ready: async (page) => {
			await expect(page.getByTestId("share-of-voice-summary")).toBeVisible({ timeout: 30_000 });
		},
	},
	{
		name: "AI Visibility",
		url: `${BRAND_URL}/visibility?lookback=1m`,
		card: (page) => page.getByTestId("competitive-visibility-summary"),
		chart: ".recharts-radial-bar-background-sector",
		otherChart: ".recharts-pie",
		legendTestId: "competitive-visibility-radial-legend",
		ready: async (page) => {
			await expect(page.getByTestId("competitive-visibility-summary")).toBeVisible({ timeout: 30_000 });
		},
	},
];

async function box(loc: Locator) {
	return (await loc.boundingBox()) as { x: number; y: number; width: number; height: number };
}

async function expectSharedStructure(page: Page, c: Card) {
	const card = c.card(page);
	const heading = card.getByRole("heading", { level: 2, name: new RegExp(`^${c.name}`) });
	await expect(heading).toBeVisible();
	await expect(card.getByRole("button", { name: `About ${c.name}` })).toBeVisible();
	const legend = card.getByTestId(c.legendTestId);
	await expect(legend).toHaveAttribute("aria-label", "Brands");
	await expect(legend.getByRole("listitem").first()).toBeVisible();
	// Value and description precede the visual group; the legend follows the chart.
	const order = await card.evaluate((el) =>
		Array.from(el.querySelectorAll("[data-slot]")).map((n) => n.getAttribute("data-slot")),
	);
	expect(order.indexOf("metric-summary-value")).toBeLessThan(order.indexOf("metric-visual-group"));
	expect(order.indexOf("metric-visual")).toBeLessThan(order.indexOf("metric-legend"));
	// Chart and list describe the same entities, in the same order.
	const rows = await legend.getByRole("listitem").count();
	await expect(card.locator(c.chart)).toHaveCount(rows, { timeout: 30_000 });
	await expect(card.locator(c.otherChart)).toHaveCount(0);
	await expect(card.locator(".recharts-legend-wrapper")).toHaveCount(0);
	await expect(legend.locator("button, a, [tabindex]")).toHaveCount(0);
	await expect(legend.getByText("You")).toHaveCount(1);
	// Description uses the card width: it never sits in a narrow side column.
	const content = await box(card.locator("[data-slot=card-content]"));
	const text = await box(card.locator("[data-slot=metric-summary-text]"));
	expect(text.width).toBeGreaterThanOrEqual(content.width - 50);
}

async function expectVisualGroup(page: Page, c: Card, viewportWidth: number) {
	const card = c.card(page);
	const chart = await box(card.locator(".recharts-wrapper").first());
	const legend = await box(card.getByTestId(c.legendTestId));
	const text = await box(card.locator("[data-slot=metric-summary-text]"));
	const content = await box(card.locator("[data-slot=card-content]"));
	const direction = await card
		.locator("[data-slot=metric-visual-group]")
		.evaluate((el) => getComputedStyle(el).flexDirection);
	expect(chart.y).toBeGreaterThanOrEqual(text.y + text.height);
	if (direction === "row") {
		expect(legend.x).toBeGreaterThanOrEqual(chart.x + chart.width);
		expect(legend.x - (chart.x + chart.width)).toBeLessThanOrEqual(16);
		expect(Math.abs(legend.y + legend.height / 2 - (chart.y + chart.height / 2))).toBeLessThan(12);
	} else {
		expect(legend.y).toBeGreaterThanOrEqual(chart.y + chart.height);
		expect(Math.abs(chart.x + chart.width / 2 - (content.x + content.width / 2))).toBeLessThan(30);
	}
	// The card's own width decides: wide cards get the row, narrow cards the column.
	expect(direction).toBe(content.width - 48 >= 384 ? "row" : "column");
	// Names readable, values inside the legend, nothing clipped or overflowing.
	const rows = card.getByTestId(c.legendTestId).getByRole("listitem");
	for (const li of await rows.all()) {
		expect(await li.locator("span").nth(1).evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
		const value = await box(li.locator("span").last());
		expect(value.x + value.width).toBeLessThanOrEqual(legend.x + legend.width + 1);
		expect(value.x + value.width).toBeLessThanOrEqual(viewportWidth);
	}
	const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
	expect(overflow).toBe(0);
	expect(await card.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(0);
}

test.describe("Shared metric summary pattern", () => {
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
			 VALUES ($1, $2, $1, $3, 'https://ui-r1.example.test/', true, true, NOW(), NOW())`,
			[BRAND_ID, org.rows[0].id, BRAND_NAME],
		);
		await client.query(
			`INSERT INTO prompts (id, brand_id, value, enabled, tags, system_tags, created_at, updated_at)
			 VALUES ($1, $2, 'Welche Rechtsschutzversicherung ist die beste?', true, '{}', $3, NOW(), NOW())`,
			[PROMPT_ID, BRAND_ID, ["unbranded"]],
		);
		for (const [i, name] of COMPETITORS.entries()) {
			await client.query(
				`INSERT INTO competitors (id, brand_id, name, domains, created_at, updated_at) VALUES ($1, $2, $3, $4, NOW(), NOW())`,
				[`6f0a0003-0000-4000-8000-00000000000${i + 1}`, BRAND_ID, name, [`${name.toLowerCase()}.example.test`]],
			);
		}
		for (const run of RUNS) {
			await client.query(
				`INSERT INTO prompt_runs (id, prompt_id, brand_id, model, provider, version, web_search_enabled, raw_output, web_queries, brand_mentioned, competitors_mentioned, created_at)
				 VALUES ($1, $2, $3, 'chatgpt', 'brightdata', 'ui-r1', true, '{}', '{}', true, $4, $5)`,
				[run.id, PROMPT_ID, BRAND_ID, run.competitors, noonDaysAgo(1)],
			);
		}
	});

	test.afterAll(async () => {
		try {
			await client.query("DELETE FROM prompt_runs WHERE brand_id = $1", [BRAND_ID]);
			await client
				.query("DELETE FROM pgboss.job WHERE name = 'process-prompt' AND data->>'promptId' = $1", [PROMPT_ID])
				.catch(() => undefined);
			await client.query("DELETE FROM prompts WHERE brand_id = $1", [BRAND_ID]);
			await client.query("DELETE FROM competitors WHERE brand_id = $1", [BRAND_ID]);
			await client.query("DELETE FROM brands WHERE id = $1", [BRAND_ID]);
		} finally {
			await client.end();
		}
	});

	for (const c of CARDS) {
		test(`${c.name}: shared structure, tip, and one visual group at every width`, async ({ page }) => {
			const consoleErrors: string[] = [];
			const pageErrors: string[] = [];
			const failed: string[] = [];
			page.on("pageerror", (e) => pageErrors.push(e.message));
			page.on("console", (m) => {
				if (m.type() === "error" && !m.text().startsWith("Failed to load resource")) consoleErrors.push(m.text());
			});
			page.on("response", (r) => {
				const u = new URL(r.url());
				if (u.origin === new URL(page.url() || r.url()).origin && r.status() >= 400) failed.push(`${r.status()} ${u.pathname}`);
			});
			for (const width of WIDTHS) {
				await page.setViewportSize({ width, height: width < 768 ? 900 : 1000 });
				await page.goto(c.url);
				await c.ready(page);
				await page.waitForTimeout(600);
				await expectSharedStructure(page, c);
				await expectVisualGroup(page, c, width);
			}
			// The info tip opens from the keyboard-reachable button and names the metric.
			await page.setViewportSize({ width: 1400, height: 1000 });
			await page.goto(c.url);
			await c.ready(page);
			const info = c.card(page).getByRole("button", { name: `About ${c.name}` });
			await info.hover();
			// The tip renders in a portal (base-ui popup) with the metric's explanation.
			const tip = page.locator("[data-slot=tooltip-content]");
			await expect(tip).toBeVisible();
			await expect(tip).toContainText(c.name === "Share of Voice" ? /share of all brand and competitor mentions/ : /measured independently/);
			await page.mouse.move(5, 5);
			// Dark theme: entity colours stay inline, text follows the theme.
			await page.evaluate(() => document.documentElement.classList.add("dark"));
			await expectSharedStructure(page, c);
			const first = c.card(page).getByTestId(c.legendTestId).getByRole("listitem").first();
			expect(await first.locator("span").first().evaluate((el) => getComputedStyle(el).backgroundColor)).toBe("rgb(37, 99, 235)");
			expect(await first.locator("span").nth(1).evaluate((el) => getComputedStyle(el).color)).not.toBe("rgb(0, 0, 0)");
			await page.evaluate(() => document.documentElement.classList.remove("dark"));
			expect(consoleErrors).toEqual([]);
			expect(pageErrors).toEqual([]);
			expect(failed).toEqual([]);
		});
	}

	test("both legends show the seeded roster in canonical order with You on the brand", async ({ page }) => {
		await page.goto(CARDS[0].url);
		await CARDS[0].ready(page);
		const sov = CARDS[0].card(page).getByTestId(CARDS[0].legendTestId).getByRole("listitem");
		// 14 mentions: brand 3, Alpha 3, Bravo 2, Charlie 2, Delta/Echo/Foxtrot/Golf 1 → Golf loses the boundary
		// tie by name and folds into Others. Independently rounded: 21/21/14/14/7/7/7 + 7 = 98 %, kept as is.
		await expect(sov).toHaveText([
			`${BRAND_NAME}You21%`,
			"Alpha21%",
			"Bravo14%",
			"Charlie14%",
			"Delta7%",
			"Echo7%",
			"Foxtrot7%",
			"Others7%",
		]);
		await page.goto(CARDS[1].url);
		await CARDS[1].ready(page);
		const vis = CARDS[1].card(page).getByTestId(CARDS[1].legendTestId).getByRole("listitem");
		// Independent percentages over 3 eligible runs; the brand is first, then the Top-6 by mentions.
		await expect(vis.first()).toHaveText(`${BRAND_NAME}You100%`);
		await expect(vis.nth(1)).toHaveText("Alpha100%");
		await expect(vis).toHaveCount(7);
	});

	test("each page still issues its own single summary request per load", async ({ page }) => {
		const bodies: string[] = [];
		page.on("response", async (r) => {
			if (!r.url().includes("/_serverFn/")) return;
			bodies.push(await r.text().catch(() => ""));
		});
		await page.goto(CARDS[0].url);
		await CARDS[0].ready(page);
		await page.waitForTimeout(800);
		expect(bodies.filter((b) => b.includes('"comparisonTrend"'))).toHaveLength(1);
		bodies.length = 0;
		await page.goto(CARDS[1].url);
		await CARDS[1].ready(page);
		await page.waitForTimeout(800);
		expect(bodies.filter((b) => b.includes('"snapshotRuns"'))).toHaveLength(1);
	});
});
