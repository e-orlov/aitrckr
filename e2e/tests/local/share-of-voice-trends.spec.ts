/**
 * F-07 — Competitor Share of Voice Trends: the Share of Voice page's Trends card
 * plots the brand, the six top competitors of the current standings and an
 * "Others" tail as lines, with one tooltip shared across the plot.
 *
 * The spec seeds its own brand in the shared test organization (two enabled
 * prompts on staggered days, a disabled prompt, two models, tagged and untagged
 * prompts, nine competitors, a run that drops earlier competitors, duplicate
 * array elements, a tie at the Top-6 boundary) and compares every tooltip row
 * with an independent oracle: SQL over the same rows plus a plain re-derivation
 * of the per-prompt snapshot carry, without importing the application helper.
 */
import { expect, type Locator, type Page, test } from "@playwright/test";
import pg from "pg";
import { brandUrl, DATABASE_URL, TEST_ORG_SLUG } from "../../fixtures";

const BRAND_ID = "f07-sov";
const BRAND_NAME = "F07 Voice";
const BRAND_URL = brandUrl(BRAND_ID, TEST_ORG_SLUG);

const PROMPTS = {
	tagged: "6f07a001-0000-4000-8000-000000000001",
	untagged: "6f07a001-0000-4000-8000-000000000002",
	disabled: "6f07a001-0000-4000-8000-000000000003",
};

const [ADVOCARD, ALLIANZ, ROLAND, DEURAG, DAS, WGV, HUK, ERGO, AUXILIA] = [
	"Advocard",
	"Allianz",
	"Roland",
	"Deurag",
	"DAS",
	"WGV",
	"HUK",
	"ERGO",
	"Auxilia",
];
const NINE = [ADVOCARD, ALLIANZ, ROLAND, DEURAG, DAS, WGV, HUK, ERGO, AUXILIA];

/** Noon UTC `days` days ago — one unambiguous UTC calendar day per run. */
function noonDaysAgo(days: number): Date {
	const d = new Date();
	d.setUTCHours(12, 0, 0, 0);
	d.setUTCDate(d.getUTCDate() - days);
	return d;
}
const isoDay = (d: Date) => d.toISOString().slice(0, 10);

const RUNS: { id: string; promptId: string; model: string; createdAt: Date; brand: boolean; competitors: string[] }[] = [
	// The tagged prompt names all nine competitors, then only four, then (on claude) drops
	// the brand and repeats Advocard — the earlier competitors must not be carried along.
	{ id: "6f07b001-0000-4000-8000-000000000001", promptId: PROMPTS.tagged, model: "chatgpt", createdAt: noonDaysAgo(5), brand: true, competitors: NINE },
	{ id: "6f07b001-0000-4000-8000-000000000002", promptId: PROMPTS.tagged, model: "chatgpt", createdAt: noonDaysAgo(3), brand: true, competitors: [ADVOCARD, ALLIANZ, ROLAND, ERGO] },
	{ id: "6f07b001-0000-4000-8000-000000000003", promptId: PROMPTS.tagged, model: "claude", createdAt: noonDaysAgo(1), brand: false, competitors: [ADVOCARD, ADVOCARD, ALLIANZ, AUXILIA] },
	// The untagged prompt starts later (pre-seeded backwards) and widens on the last day.
	{ id: "6f07b001-0000-4000-8000-000000000004", promptId: PROMPTS.untagged, model: "chatgpt", createdAt: noonDaysAgo(2), brand: true, competitors: [DEURAG, DAS] },
	{ id: "6f07b001-0000-4000-8000-000000000005", promptId: PROMPTS.untagged, model: "chatgpt", createdAt: noonDaysAgo(1), brand: true, competitors: [DEURAG, DAS, WGV, HUK] },
	// Disabled prompt: would dominate if it leaked in.
	{ id: "6f07b001-0000-4000-8000-000000000006", promptId: PROMPTS.disabled, model: "chatgpt", createdAt: noonDaysAgo(1), brand: true, competitors: ["Leak", "Leak", "Leak", "Leak", "Leak"] },
];

/** Optional evidence capture: set F07_SCREENSHOT_DIR to save the states the PR shows. */
async function screenshot(page: Page, name: string) {
	const dir = process.env.F07_SCREENSHOT_DIR;
	if (dir) await page.screenshot({ path: `${dir}/${name}.png`, fullPage: true });
}

// ---------------------------------------------------------------------------
// Independent oracle
// ---------------------------------------------------------------------------

type Snapshot = { brand: number; competitors: Map<string, number> };
interface OracleDay {
	date: string;
	brand: number;
	counts: Map<string, number>;
	total: number;
}
interface Oracle {
	dates: string[];
	shown: string[];
	othersExists: boolean;
	days: Map<string, OracleDay>;
	/** Once-rounded tooltip rows for a date: [label, "N%"]. */
	rows(date: string): Array<[string, string]>;
}

const TOP_N = 6;

async function oracle(
	client: pg.Client,
	opts: { fromDate: string; toDate: string; model?: string; tags?: string[] },
): Promise<Oracle> {
	const params: unknown[] = [BRAND_ID];
	let promptClause = "";
	if (opts.tags) {
		params.push(opts.tags);
		promptClause = ` AND (p.tags && $${params.length}::text[] OR p.system_tags && $${params.length}::text[])`;
	}
	const prompts = await client.query<{ id: string }>(
		`SELECT p.id FROM prompts p WHERE p.brand_id = $1 AND p.enabled${promptClause}`,
		params,
	);
	const promptIds = prompts.rows.map((r) => r.id);

	const runParams: unknown[] = [BRAND_ID, promptIds, opts.fromDate, opts.toDate];
	let modelClause = "";
	if (opts.model) {
		runParams.push(opts.model);
		modelClause = ` AND r.model = $${runParams.length}`;
	}
	const where = `r.brand_id = $1 AND r.prompt_id = ANY($2::uuid[])
		AND r.created_at >= ($3::date AT TIME ZONE 'UTC') AND r.created_at < (($4::date + 1) AT TIME ZONE 'UTC')${modelClause}`;
	const brandRows = await client.query<{ prompt_id: string; day: string; brand: number }>(
		`SELECT r.prompt_id, (r.created_at AT TIME ZONE 'UTC')::date::text AS day,
		        count(*) FILTER (WHERE r.brand_mentioned)::int AS brand
		 FROM prompt_runs r WHERE ${where} GROUP BY 1, 2`,
		runParams,
	);
	const competitorRows = await client.query<{ prompt_id: string; day: string; name: string; n: number }>(
		`SELECT r.prompt_id, (r.created_at AT TIME ZONE 'UTC')::date::text AS day, c AS name, count(*)::int AS n
		 FROM prompt_runs r, unnest(r.competitors_mentioned) AS c WHERE ${where} GROUP BY 1, 2, 3`,
		runParams,
	);

	// One complete snapshot per prompt and observed day.
	const snapshots = new Map<string, Map<string, Snapshot>>();
	const at = (promptId: string, day: string) => {
		let byDay = snapshots.get(promptId);
		if (!byDay) snapshots.set(promptId, (byDay = new Map()));
		let s = byDay.get(day);
		if (!s) byDay.set(day, (s = { brand: 0, competitors: new Map() }));
		return s;
	};
	for (const r of brandRows.rows) at(r.prompt_id, r.day).brand = r.brand;
	for (const r of competitorRows.rows) at(r.prompt_id, r.day).competitors.set(r.name, r.n);

	// Calendar days of the window, then carry each prompt's latest snapshot on or
	// before the day (earliest snapshot before its first observation).
	const dates: string[] = [];
	for (let d = new Date(`${opts.fromDate}T00:00:00Z`); isoDay(d) <= opts.toDate; d.setUTCDate(d.getUTCDate() + 1)) {
		dates.push(isoDay(d));
	}
	const days = new Map<string, OracleDay>();
	for (const date of dates) {
		const day: OracleDay = { date, brand: 0, counts: new Map(), total: 0 };
		let anyPrompt = false;
		for (const [, byDay] of snapshots) {
			const observed = [...byDay.keys()].sort();
			const onOrBefore = observed.filter((d) => d <= date);
			const pick = onOrBefore.length ? onOrBefore[onOrBefore.length - 1] : observed[0];
			const s = byDay.get(pick) as Snapshot;
			anyPrompt = true;
			day.brand += s.brand;
			for (const [name, n] of s.competitors) day.counts.set(name, (day.counts.get(name) ?? 0) + n);
		}
		if (!anyPrompt) continue;
		day.total = day.brand + [...day.counts.values()].reduce((a, b) => a + b, 0);
		days.set(date, day);
	}

	const last = days.get(dates[dates.length - 1]);
	const shown = [...(last?.counts ?? new Map<string, number>()).entries()]
		.filter(([, n]) => n > 0)
		.sort(([an, a], [bn, b]) => b - a || (an < bn ? -1 : an > bn ? 1 : 0))
		.slice(0, TOP_N)
		.map(([name]) => name);
	const shownSet = new Set(shown);
	const othersCount = (day: OracleDay) =>
		[...day.counts.entries()].filter(([name]) => !shownSet.has(name)).reduce((s, [, n]) => s + n, 0);
	const othersExists = [...days.values()].some((day) => othersCount(day) > 0);

	const pct = (n: number, total: number) => `${Math.round((n / total) * 100)}%`;
	return {
		dates,
		shown,
		othersExists,
		days,
		rows(date) {
			const day = days.get(date);
			if (!day || day.total === 0) return [];
			const rows: Array<[string, string]> = [[BRAND_NAME, pct(day.brand, day.total)]];
			for (const name of shown) rows.push([name, pct(day.counts.get(name) ?? 0, day.total)]);
			if (othersExists) rows.push(["Others", pct(othersCount(day), day.total)]);
			return rows;
		},
	};
}

/** The window the page requests for a lookback, computed the way the app does (UTC browser). */
function window(lookback: "1m" | "1w"): { fromDate: string; toDate: string } {
	const today = new Date();
	const toDate = isoDay(today);
	const from = new Date(`${toDate}T00:00:00Z`);
	if (lookback === "1w") from.setUTCDate(from.getUTCDate() - 6);
	else from.setUTCMonth(from.getUTCMonth() - 1);
	return { fromDate: isoDay(from), toDate };
}

// ---------------------------------------------------------------------------
// Chart access
// ---------------------------------------------------------------------------

const chart = (page: Page) => page.getByTestId("share-of-voice-trend-chart");
const legendItems = (page: Page) => page.getByTestId("share-of-voice-trend-legend").getByRole("listitem");
const tooltip = (page: Page) => page.getByTestId("share-of-voice-trend-tooltip");

async function waitForLines(page: Page, count: number) {
	await expect(chart(page).locator("path.recharts-line-curve")).toHaveCount(count, { timeout: 30_000 });
	// Recharts draws the entrance animation through a temporary stroke-dasharray.
	await expect
		.poll(
			() =>
				chart(page)
					.locator("path.recharts-line-curve")
					.evaluateAll((paths) =>
						paths.every((p) => [null, "", "5 4"].includes(p.getAttribute("stroke-dasharray"))),
					),
			{ timeout: 10_000 },
		)
		.toBe(true);
}

/** Plot area in page coordinates, from the horizontal grid lines. */
async function plotRect(page: Page) {
	const surface = chart(page).locator("svg.recharts-surface");
	const box = (await surface.boundingBox()) as { x: number; y: number; width: number; height: number };
	const lines = await chart(page)
		.locator(".recharts-cartesian-grid-horizontal line")
		.evaluateAll((els) =>
			els.map((el) => ({
				x1: Number(el.getAttribute("x1")),
				x2: Number(el.getAttribute("x2")),
				y: Number(el.getAttribute("y1")),
			})),
		);
	return {
		left: box.x + lines[0].x1,
		right: box.x + lines[0].x2,
		top: box.y + Math.min(...lines.map((l) => l.y)),
		bottom: box.y + Math.max(...lines.map((l) => l.y)),
	};
}

/** Real pointer move to a fraction of the plot width, just under the top grid line where no line runs. */
async function hoverAt(page: Page, fraction: number) {
	// Centre the plot: a minimal scroll can leave its top grid line under the sticky header.
	await chart(page).evaluate((el) => el.scrollIntoView({ block: "center" }));
	const plot = await plotRect(page);
	const x = plot.left + (plot.right - plot.left) * fraction;
	const y = plot.top + 3;
	await page.mouse.move(x, y);
	await expect(tooltip(page)).toBeVisible();
	return { x, y };
}

async function tooltipRows(page: Page): Promise<Array<[string, string]>> {
	return tooltip(page)
		.locator("[data-series]")
		.evaluateAll((rows) =>
			rows.map((row) => {
				const spans = row.querySelectorAll("span");
				return [spans[1].textContent ?? "", spans[2].textContent ?? ""] as [string, string];
			}),
		);
}

/** The tooltip's header date, back as YYYY-MM-DD. */
async function tooltipDate(page: Page): Promise<string> {
	const text = await tooltip(page).locator("> div").first().textContent();
	return isoDay(new Date(`${text} 12:00:00 UTC`));
}

async function expectTooltipMatchesOracle(page: Page, o: Oracle, fraction: number) {
	await hoverAt(page, fraction);
	const date = await tooltipDate(page);
	expect(o.dates).toContain(date);
	const expected = o.rows(date);
	expect(expected.length).toBeGreaterThan(0);
	expect(await tooltipRows(page)).toEqual(expected);
	// Active dots on every non-null series and one vertical guide.
	await expect(chart(page).locator(".recharts-active-dot")).toHaveCount(expected.length);
	await expect(chart(page).locator(".recharts-tooltip-cursor")).toHaveCount(1);
	return date;
}

async function expectLegend(page: Page, o: Oracle) {
	const expected = [BRAND_NAME, ...o.shown, ...(o.othersExists ? ["Others"] : [])];
	await expect(legendItems(page)).toHaveText(expected, { timeout: 30_000 });
}

/** The headline number and the brand's leaderboard share cell. */
async function headlineAndBrandRow(page: Page): Promise<{ headline: string; brandRow: string }> {
	const headline = (await page.locator("div.text-3xl.font-bold.tabular-nums").textContent()) ?? "";
	const row = page.getByRole("row").filter({ has: page.getByText("You", { exact: true }) });
	const brandRow = (await row.locator("span.tabular-nums").last().textContent()) ?? "";
	return { headline: headline.trim(), brandRow: brandRow.trim() };
}

async function noHorizontalOverflow(page: Page) {
	const metrics = await page.evaluate(() => ({
		scrollWidth: document.documentElement.scrollWidth,
		clientWidth: document.documentElement.clientWidth,
	}));
	expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.clientWidth);
}

async function withinViewport(locator: Locator, page: Page) {
	const box = (await locator.boundingBox()) as { x: number; width: number };
	const viewport = page.viewportSize() as { width: number };
	expect(box.x).toBeGreaterThanOrEqual(0);
	expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
}

// ---------------------------------------------------------------------------

test.describe("Competitor Share of Voice Trends", () => {
	test.describe.configure({ mode: "serial" });
	// The page buckets days in the browser's timezone; pin it so the oracle can bucket in UTC too.
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
			 VALUES ($1, $2, $1, $3, 'https://f07.example.test/', true, true, NOW(), NOW())`,
			[BRAND_ID, org.rows[0].id, BRAND_NAME],
		);
		await client.query(
			`INSERT INTO prompts (id, brand_id, value, enabled, tags, system_tags, created_at, updated_at) VALUES
			 ($1, $4, 'Welche Rechtsschutzversicherung ist die beste?', true, $5, $6, NOW(), NOW()),
			 ($2, $4, 'Was kostet Rechtsschutz?', true, '{}', $7, NOW(), NOW()),
			 ($3, $4, 'Disabled prompt', false, '{}', $7, NOW(), NOW())`,
			[PROMPTS.tagged, PROMPTS.untagged, PROMPTS.disabled, BRAND_ID, ["rechtsschutz"], ["branded"], ["unbranded"]],
		);
		for (const [i, name] of NINE.entries()) {
			await client.query(
				`INSERT INTO competitors (id, brand_id, name, domains, created_at, updated_at)
				 VALUES ($1, $2, $3, $4, NOW(), NOW())`,
				[`6f07c001-0000-4000-8000-00000000000${i + 1}`, BRAND_ID, name, [`${name.toLowerCase()}.example.test`]],
			);
		}
		for (const run of RUNS) {
			await client.query(
				`INSERT INTO prompt_runs (id, prompt_id, brand_id, model, provider, version, web_search_enabled, raw_output, web_queries, brand_mentioned, competitors_mentioned, created_at)
				 VALUES ($1, $2, $3, $4, 'brightdata', 'f07', true, '{}', '{}', $5, $6, $7)`,
				[run.id, run.promptId, BRAND_ID, run.model, run.brand, run.competitors, run.createdAt],
			);
		}
	});

	test.afterAll(async () => {
		try {
			const promptIds = Object.values(PROMPTS);
			await client.query("DELETE FROM prompt_runs WHERE brand_id = $1", [BRAND_ID]);
			await client
				.query("DELETE FROM pgboss.job WHERE name = 'process-prompt' AND data->>'promptId' = ANY($1::text[])", [promptIds])
				.catch(() => undefined);
			await client.query("DELETE FROM prompts WHERE brand_id = $1", [BRAND_ID]);
			await client.query("DELETE FROM competitors WHERE brand_id = $1", [BRAND_ID]);
			await client.query("DELETE FROM brands WHERE id = $1", [BRAND_ID]);
		} finally {
			await client.end();
		}
	});

	test("the existing page gains a comparison chart and nothing else", async ({ page }) => {
		const pageErrors: string[] = [];
		const consoleErrors: string[] = [];
		const failedRequests: string[] = [];
		page.on("pageerror", (error) => pageErrors.push(error.message));
		page.on("console", (message) => {
			if (message.type() === "error" && !message.text().startsWith("Failed to load resource")) {
				consoleErrors.push(message.text());
			}
		});
		const origin = new URL(process.env.BASE_URL || "http://localhost:1515").origin;
		page.on("response", (response) => {
			const url = new URL(response.url());
			if (url.origin === origin && response.status() >= 400) failedRequests.push(`${response.status()} ${url.pathname}`);
		});

		await page.goto(BRAND_URL);
		const item = page.locator(`a[href="${BRAND_URL}/share-of-voice"][data-sidebar="menu-button"]`);
		await expect(item).toBeVisible({ timeout: 15_000 });
		// No new sidebar entry appeared for F-07.
		const titles = (await page.locator('[data-sidebar="menu-button"]').allTextContents()).map((t) => t.trim());
		expect(titles.filter((t) => /trend/i.test(t))).toEqual([]);
		expect(titles.filter((t) => /share of voice/i.test(t))).toEqual(["Share of Voice"]);
		await expect(page.locator('[data-sidebar="menu-button"][href*="trend"]')).toHaveCount(0);

		await item.click();
		await page.waitForURL(/\/share-of-voice/);
		await expect(page.getByRole("heading", { level: 1, name: /share of voice/i })).toBeVisible({ timeout: 30_000 });
		await expect(page).toHaveTitle(/Share of Voice/);

		// The three cards of the page are intact: headline + donut, trends, leaderboard.
		await expect(page.getByText("Share of Voice Trends")).toBeVisible();
		await expect(page.getByText("Share of Voice Leaderboard")).toBeVisible();
		await expect(page.locator(".recharts-pie")).toHaveCount(1, { timeout: 30_000 });
		await expect(page.getByRole("table")).toHaveCount(1);
		await expect(chart(page)).toHaveCount(1);
		await expect(page.locator("[data-slot=chart]")).toHaveCount(2);
		await expect(page.getByRole("button", { name: /all models/i })).toBeVisible();
		await expect(page.getByRole("button", { name: /^tags$/i })).toBeVisible();

		// Separate unfilled lines, no areas; the brand emphasised, Others dashed.
		await waitForLines(page, 8);
		await expect(chart(page).locator(".recharts-area")).toHaveCount(0);
		const strokes = await chart(page)
			.locator("path.recharts-line-curve")
			.evaluateAll((paths) =>
				paths.map((p) => ({
					stroke: p.getAttribute("stroke"),
					width: Number(p.getAttribute("stroke-width")),
					dash: p.getAttribute("stroke-dasharray"),
					fill: p.getAttribute("fill"),
				})),
			);
		expect(strokes.map((s) => s.fill)).toEqual(Array(8).fill("none"));
		expect(strokes[0].stroke).toBe("#2563eb");
		expect(strokes[0].width).toBeGreaterThan(strokes[1].width);
		expect(strokes.slice(1, 7).map((s) => s.stroke)).toEqual(["#10b981", "#f59e0b", "#8b5cf6", "#ec4899", "#14b8a6", "#f97316"]);
		expect(strokes[7]).toMatchObject({ stroke: "#cbd5e1", dash: "5 4" });
		expect(strokes.slice(0, 7).every((s) => !s.dash)).toBe(true);
		// The legend is static: no Recharts legend, no buttons, dashed cue on Others.
		await expect(page.locator(".recharts-legend-wrapper")).toHaveCount(0);
		await expect(page.getByTestId("share-of-voice-trend-legend").getByRole("button")).toHaveCount(0);
		await expect(legendItems(page).last().locator("line")).toHaveAttribute("stroke-dasharray", /.+/);
		// Accessibility layer intact.
		await expect(chart(page).locator(".recharts-surface")).toHaveAttribute("role", "application");
		await expect(chart(page).locator(".recharts-surface")).toHaveAttribute("tabindex", "0");

		expect(pageErrors).toEqual([]);
		expect(consoleErrors).toEqual([]);
		expect(failedRequests).toEqual([]);
	});

	test("every tooltip row equals the independent oracle, in fixed order, including zeros", async ({ page }) => {
		const o = await oracle(client, { ...window("1m") });
		// Fixture sanity: a tie at rank 6/7 (Allianz…WGV all at 1) puts WGV into Others by name order.
		expect(o.shown).toEqual([ADVOCARD, ALLIANZ, AUXILIA, DAS, DEURAG, HUK]);
		expect(o.othersExists).toBe(true);

		await page.goto(`${BRAND_URL}/share-of-voice?lookback=1m`);
		await waitForLines(page, 8);
		await expectLegend(page, o);

		// First date (pre-seeded from the earliest runs), a middle date, the last date.
		const first = await expectTooltipMatchesOracle(page, o, 0);
		expect(first).toBe(o.dates[0]);
		expect(o.rows(first)).toEqual([
			[BRAND_NAME, "15%"],
			[ADVOCARD, "8%"],
			[ALLIANZ, "8%"],
			[AUXILIA, "8%"],
			[DAS, "15%"],
			[DEURAG, "15%"],
			[HUK, "8%"],
			["Others", "23%"],
		]);
		await screenshot(page, "01-tooltip-first-date");

		const n = o.dates.length;
		const middle = await expectTooltipMatchesOracle(page, o, (n - 4) / (n - 1));
		expect(middle).toBe(o.dates[n - 4]);
		// Three days ago the tagged prompt dropped five competitors: Auxilia and HUK are actual zeros, not missing rows.
		expect(o.rows(middle)).toEqual([
			[BRAND_NAME, "25%"],
			[ADVOCARD, "13%"],
			[ALLIANZ, "13%"],
			[AUXILIA, "0%"],
			[DAS, "13%"],
			[DEURAG, "13%"],
			[HUK, "0%"],
			["Others", "25%"],
		]);
		await screenshot(page, "02-tooltip-middle-date");

		const last = await expectTooltipMatchesOracle(page, o, 1);
		expect(last).toBe(o.dates[n - 1]);
		expect(o.rows(last)).toEqual([
			[BRAND_NAME, "11%"],
			[ADVOCARD, "22%"],
			[ALLIANZ, "11%"],
			[AUXILIA, "11%"],
			[DAS, "11%"],
			[DEURAG, "11%"],
			[HUK, "11%"],
			["Others", "11%"],
		]);
		// Right edge: readable, inside the viewport, no page overflow.
		await withinViewport(tooltip(page), page);
		await noHorizontalOverflow(page);
		await screenshot(page, "03-tooltip-last-date-right-edge");

		// Moving horizontally selects the nearest date: one step left is the day before.
		const plot = await plotRect(page);
		const step = (plot.right - plot.left) / (n - 1);
		await page.mouse.move(plot.right - step, plot.top + 3);
		await expect.poll(() => tooltipDate(page)).toBe(o.dates[n - 2]);

		// Last-date reconciliation with the headline, the brand's leaderboard cell and the competitor rows.
		const { headline, brandRow } = await headlineAndBrandRow(page);
		expect(headline).toBe("11%");
		expect(brandRow).toBe("11%");
		for (const [name, pct] of o.rows(last).slice(1, -1)) {
			const row = page.getByRole("row").filter({ hasText: name });
			await expect(row.locator("span.tabular-nums").last()).toHaveText(pct);
		}
		// Nothing from the disabled prompt.
		await expect(page.getByText("Leak")).toHaveCount(0);

		// Leaving the plot hides the tooltip.
		await page.mouse.move(5, 5);
		await expect(tooltip(page)).toHaveCount(0);
	});

	test("model, tag and lookback filters recompute the Top 6, Others and values together", async ({ page }) => {
		// Model: only chatgpt runs → all eight competitors tie at 1, six shown by name, Roland and WGV in Others.
		const chatgpt = await oracle(client, { ...window("1m"), model: "chatgpt" });
		expect(chatgpt.shown).toEqual([ADVOCARD, ALLIANZ, DAS, DEURAG, ERGO, HUK]);
		await page.goto(`${BRAND_URL}/share-of-voice?lookback=1m&model=chatgpt`);
		await waitForLines(page, 8);
		await expectLegend(page, chatgpt);
		const last = await expectTooltipMatchesOracle(page, chatgpt, 1);
		expect(chatgpt.rows(last)).toEqual([
			[BRAND_NAME, "20%"],
			[ADVOCARD, "10%"],
			[ALLIANZ, "10%"],
			[DAS, "10%"],
			[DEURAG, "10%"],
			[ERGO, "10%"],
			[HUK, "10%"],
			["Others", "20%"],
		]);
		await screenshot(page, "04-model-chatgpt");

		// Tag: the tagged prompt alone → the brand ends at an actual 0% and only three competitors remain.
		const tagged = await oracle(client, { ...window("1m"), tags: ["rechtsschutz"] });
		expect(tagged.shown).toEqual([ADVOCARD, ALLIANZ, AUXILIA]);
		await page.goto(`${BRAND_URL}/share-of-voice?lookback=1m&tags=rechtsschutz`);
		await waitForLines(page, 5);
		await expectLegend(page, tagged);
		const taggedLast = await expectTooltipMatchesOracle(page, tagged, 1);
		expect(tagged.rows(taggedLast)).toEqual([
			[BRAND_NAME, "0%"],
			[ADVOCARD, "50%"],
			[ALLIANZ, "25%"],
			[AUXILIA, "25%"],
			["Others", "0%"],
		]);
		const { headline, brandRow } = await headlineAndBrandRow(page);
		expect(headline).toBe("0%");
		expect(brandRow).toBe("0%");

		// System tag scope behaves like the existing page: unbranded = the untagged prompt only.
		const unbranded = await oracle(client, { ...window("1m"), tags: ["unbranded"] });
		expect(unbranded.shown).toEqual([DAS, DEURAG, HUK, WGV]);
		expect(unbranded.othersExists).toBe(false);
		await page.goto(`${BRAND_URL}/share-of-voice?lookback=1m&tags=unbranded`);
		await waitForLines(page, 5);
		await expectLegend(page, unbranded);
		await expectTooltipMatchesOracle(page, unbranded, 0.5);

		// Lookback through the UI: fewer dates, same last-day state; the URL carries the filter across a reload.
		await page.goto(`${BRAND_URL}/share-of-voice?lookback=1m`);
		await waitForLines(page, 8);
		const monthly = await oracle(client, { ...window("1m") });
		await page.getByRole("button", { name: /last 30 days/i }).click();
		await page.getByRole("menuitemradio", { name: /last 7 days/i }).click();
		await expect(page).toHaveURL(/lookback=1w/);
		const weekly = await oracle(client, { ...window("1w") });
		expect(weekly.dates).toHaveLength(7);
		expect(weekly.shown).toEqual(monthly.shown);
		await expectLegend(page, weekly);
		await expect.poll(async () => (await hoverAt(page, 0), tooltipDate(page))).toBe(weekly.dates[0]);
		expect(await tooltipRows(page)).toEqual(weekly.rows(weekly.dates[0]));
		await page.reload();
		await expect(page.getByRole("button", { name: /last 7 days/i })).toBeVisible();
		await waitForLines(page, 8);
		await expectTooltipMatchesOracle(page, weekly, 1);

		// A tag no prompt carries keeps the page's existing no-data state, with no chart.
		await page.goto(`${BRAND_URL}/share-of-voice?lookback=1m&tags=no-such-tag`);
		await expect(page.getByText(/No mention data yet for the selected filters/)).toBeVisible({ timeout: 30_000 });
		await expect(chart(page)).toHaveCount(0);
	});

	test("narrow, dark and reduced-motion layouts keep the legend below the plot and the tooltip readable", async ({
		page,
	}) => {
		await page.setViewportSize({ width: 375, height: 812 });
		await page.goto(`${BRAND_URL}/share-of-voice?lookback=1m`);
		await waitForLines(page, 8);
		const legend = page.getByTestId("share-of-voice-trend-legend");
		const wrapper = chart(page).locator(".recharts-wrapper");
		const legendBox = (await legend.boundingBox()) as { y: number; height: number; width: number };
		const wrapperBox = (await wrapper.boundingBox()) as { y: number; height: number };
		// Eight entries wrap onto several rows under the plot without covering it or widening the page.
		expect(legendBox.y).toBeGreaterThanOrEqual(wrapperBox.y + wrapperBox.height);
		expect(legendBox.height).toBeGreaterThan(30);
		expect(await legend.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
		await noHorizontalOverflow(page);
		await hoverAt(page, 1);
		await expect(tooltip(page).locator("[data-series]")).toHaveCount(8);
		await withinViewport(tooltip(page), page);
		await noHorizontalOverflow(page);
		await screenshot(page, "05-narrow-375");

		// Dark theme: the tooltip surface follows the theme while the series keep their colours.
		await page.setViewportSize({ width: 1280, height: 800 });
		await page.evaluate(() => document.documentElement.classList.add("dark"));
		await hoverAt(page, 0.5);
		const tooltipBackground = await tooltip(page).evaluate((el) => getComputedStyle(el).backgroundColor);
		expect(tooltipBackground).not.toBe("rgb(255, 255, 255)");
		await expect(chart(page).locator("path.recharts-line-curve").first()).toHaveAttribute("stroke", "#2563eb");
		await screenshot(page, "06-dark");
		await page.evaluate(() => document.documentElement.classList.remove("dark"));
	});

	test("with reduced motion the lines render without animation and the tooltip still follows the pointer", async ({
		browser,
	}) => {
		const context = await browser.newContext({
			storageState: test.info().project.use.storageState,
			reducedMotion: "reduce",
			timezoneId: "UTC",
		});
		const page = await context.newPage();
		try {
			await page.goto(`${BRAND_URL}/share-of-voice?lookback=1m`);
			await expect(chart(page).locator("path.recharts-line-curve")).toHaveCount(8, { timeout: 30_000 });
			expect(
				await chart(page)
					.locator("path.recharts-line-curve")
					.evaluateAll((paths) => paths.every((p) => [null, "", "5 4"].includes(p.getAttribute("stroke-dasharray")))),
			).toBe(true);
			const o = await oracle(client, { ...window("1m") });
			await expectTooltipMatchesOracle(page, o, 1);
		} finally {
			await context.close();
		}
	});

	test("the overview keeps its own-brand-only share of voice trend", async ({ page }) => {
		await page.goto(BRAND_URL);
		const overviewChart = page.locator("[data-slot=chart]").filter({ has: page.locator(".recharts-area") }).last();
		await expect(overviewChart).toBeVisible({ timeout: 30_000 });
		await expect(overviewChart.locator(".recharts-area")).toHaveCount(1);
		await expect(overviewChart.locator("path.recharts-line-curve")).toHaveCount(0);
		await expect(page.getByTestId("share-of-voice-trend-chart")).toHaveCount(0);
		await expect(page.getByTestId("share-of-voice-trend-legend")).toHaveCount(0);
		await screenshot(page, "07-overview-unchanged");
	});
});
