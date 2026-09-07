/**
 * F-08 — Competitive AI Visibility Overview: the Visibility page opens with an
 * AI Visibility radial comparison, Visibility Trends and a Visibility
 * Leaderboard above the existing per-prompt cards.
 *
 * The spec seeds its own brand in the shared test organization (enabled prompts
 * on staggered days incl. one with no eligible run, a disabled prompt, two
 * models, tagged / untagged prompts, eight competitors incl. one never
 * mentioned, a run naming one competitor twice) and compares every rendered
 * number with an independent oracle: SQL over the same rows plus a plain
 * re-derivation of the per-prompt carry-forward, without importing the
 * application helper. Visibility here is run-based and per-entity independent —
 * the oracle checks the values do NOT behave like a share.
 */
import { expect, type Locator, type Page, test } from "@playwright/test";
import pg from "pg";
import { brandUrl, DATABASE_URL, TEST_ORG_SLUG } from "../../fixtures";

const BRAND_ID = "f08-vis";
const BRAND_NAME = "F08 Visible";
const BRAND_URL = brandUrl(BRAND_ID, TEST_ORG_SLUG);

const PROMPTS = {
	tagged: "6f08a001-0000-4000-8000-000000000001",
	untagged: "6f08a001-0000-4000-8000-000000000002",
	anwalt: "6f08a001-0000-4000-8000-000000000003",
	norun: "6f08a001-0000-4000-8000-000000000004",
	disabled: "6f08a001-0000-4000-8000-000000000005",
};

const COMPETITORS = ["Advocard", "Allianz", "Roland", "Deurag", "DAS", "WGV", "HUK", "Ergo"] as const;
const [ADVOCARD, ALLIANZ, ROLAND, DEURAG, DAS, WGV, HUK] = COMPETITORS;

function noonDaysAgo(days: number): Date {
	const d = new Date();
	d.setUTCHours(12, 0, 0, 0);
	d.setUTCDate(d.getUTCDate() - days);
	return d;
}
const isoDay = (d: Date) => d.toISOString().slice(0, 10);

const RUNS: { id: string; promptId: string; model: string; createdAt: Date; brand: boolean; competitors: string[] }[] = [
	// tagged: day -6 two runs (brand in one; Advocard twice in one array — counts once), day -2 one run (brand, Roland, Allianz).
	{ id: "6f08b001-0000-4000-8000-000000000001", promptId: PROMPTS.tagged, model: "chatgpt", createdAt: noonDaysAgo(6), brand: true, competitors: [ADVOCARD, ADVOCARD, ALLIANZ] },
	{ id: "6f08b001-0000-4000-8000-000000000002", promptId: PROMPTS.tagged, model: "chatgpt", createdAt: noonDaysAgo(6), brand: false, competitors: [ADVOCARD, DEURAG] },
	{ id: "6f08b001-0000-4000-8000-000000000003", promptId: PROMPTS.tagged, model: "chatgpt", createdAt: noonDaysAgo(2), brand: true, competitors: [ROLAND, ALLIANZ] },
	// untagged: day -4 (brand, Allianz, DAS, WGV, HUK) on claude; day -1 (no brand, Allianz) on chatgpt.
	{ id: "6f08b001-0000-4000-8000-000000000004", promptId: PROMPTS.untagged, model: "claude", createdAt: noonDaysAgo(4), brand: true, competitors: [ALLIANZ, DAS, WGV, HUK] },
	{ id: "6f08b001-0000-4000-8000-000000000005", promptId: PROMPTS.untagged, model: "chatgpt", createdAt: noonDaysAgo(1), brand: false, competitors: [ALLIANZ] },
	// anwalt (matched by the search box): day -3, brand + Deurag, two runs.
	{ id: "6f08b001-0000-4000-8000-000000000006", promptId: PROMPTS.anwalt, model: "chatgpt", createdAt: noonDaysAgo(3), brand: true, competitors: [DEURAG] },
	{ id: "6f08b001-0000-4000-8000-000000000007", promptId: PROMPTS.anwalt, model: "chatgpt", createdAt: noonDaysAgo(3), brand: true, competitors: [] },
	// disabled prompt: would dominate if it leaked in.
	{ id: "6f08b001-0000-4000-8000-000000000008", promptId: PROMPTS.disabled, model: "chatgpt", createdAt: noonDaysAgo(1), brand: true, competitors: ["Leak", "Leak", "Leak"] },
];

async function screenshot(page: Page, name: string) {
	const dir = process.env.F08_SCREENSHOT_DIR;
	if (dir) await page.screenshot({ path: `${dir}/${name}.png`, fullPage: true });
}

// ---------------------------------------------------------------------------
// Independent oracle
// ---------------------------------------------------------------------------

interface Observation {
	runs: number;
	brand: number;
	competitors: Map<string, number>;
}
interface OracleDay {
	runs: number;
	brand: number;
	competitors: Map<string, number>;
	prompts: Map<string, Observation>;
}
interface OracleEntity {
	name: string;
	isBrand: boolean;
	mentioned: number;
	visibility: number | null;
	visiblePrompts: number;
}
interface Oracle {
	dates: string[];
	days: Map<string, OracleDay>;
	asOf: string | null;
	snapshotRuns: number;
	evaluated: number;
	/** Brand + every competitor, in leaderboard order. */
	entities: OracleEntity[];
	/** Brand + Top 6 names in trend order. */
	series: string[];
	rows(date: string): Array<[string, string]>;
}
const TOP_N = 6;
const pct = (n: number, total: number) => `${Math.round((n / total) * 100)}%`;

async function oracle(
	client: pg.Client,
	opts: { fromDate: string; toDate: string; model?: string; tags?: string[]; search?: string },
): Promise<Oracle> {
	const params: unknown[] = [BRAND_ID];
	let promptClause = "";
	if (opts.tags) {
		params.push(opts.tags);
		promptClause += ` AND (p.tags && $${params.length}::text[] OR p.system_tags && $${params.length}::text[])`;
	}
	if (opts.search) {
		params.push(`%${opts.search}%`);
		promptClause += ` AND p.value ILIKE $${params.length}`;
	}
	const prompts = await client.query<{ id: string }>(
		`SELECT p.id FROM prompts p WHERE p.brand_id = $1 AND p.enabled${promptClause}`,
		params,
	);
	const promptIds = prompts.rows.map((r) => r.id);
	const roster = (
		await client.query<{ name: string }>("SELECT name FROM competitors WHERE brand_id = $1 ORDER BY name", [BRAND_ID])
	).rows.map((r) => r.name);

	const runParams: unknown[] = [BRAND_ID, promptIds, opts.fromDate, opts.toDate];
	let modelClause = "";
	if (opts.model) {
		runParams.push(opts.model);
		modelClause = ` AND r.model = $${runParams.length}`;
	}
	const where = `r.brand_id = $1 AND r.prompt_id = ANY($2::uuid[])
		AND r.created_at >= ($3::date AT TIME ZONE 'UTC') AND r.created_at < (($4::date + 1) AT TIME ZONE 'UTC')${modelClause}`;
	const runRows = await client.query<{ prompt_id: string; day: string; runs: number; brand: number }>(
		`SELECT r.prompt_id, (r.created_at AT TIME ZONE 'UTC')::date::text AS day,
		        count(*)::int AS runs, count(*) FILTER (WHERE r.brand_mentioned)::int AS brand
		 FROM prompt_runs r WHERE ${where} GROUP BY 1, 2`,
		runParams,
	);
	// Distinct runs per competitor: a name repeated inside one array is one observation.
	const competitorRows = await client.query<{ prompt_id: string; day: string; name: string; n: number }>(
		`SELECT r.prompt_id, (r.created_at AT TIME ZONE 'UTC')::date::text AS day, c AS name, count(DISTINCT r.id)::int AS n
		 FROM prompt_runs r, unnest(r.competitors_mentioned) AS c WHERE ${where} GROUP BY 1, 2, 3`,
		runParams,
	);

	const observations = new Map<string, Map<string, Observation>>();
	const at = (promptId: string, day: string) => {
		let byDay = observations.get(promptId);
		if (!byDay) observations.set(promptId, (byDay = new Map()));
		let o = byDay.get(day);
		if (!o) byDay.set(day, (o = { runs: 0, brand: 0, competitors: new Map() }));
		return o;
	};
	for (const r of runRows.rows) {
		const o = at(r.prompt_id, r.day);
		o.runs = r.runs;
		o.brand = r.brand;
	}
	for (const r of competitorRows.rows) at(r.prompt_id, r.day).competitors.set(r.name, r.n);

	const dates: string[] = [];
	for (let d = new Date(`${opts.fromDate}T00:00:00Z`); isoDay(d) <= opts.toDate; d.setUTCDate(d.getUTCDate() + 1)) {
		dates.push(isoDay(d));
	}
	const days = new Map<string, OracleDay>();
	for (const date of dates) {
		const day: OracleDay = { runs: 0, brand: 0, competitors: new Map(), prompts: new Map() };
		for (const [promptId, byDay] of observations) {
			const observed = [...byDay.keys()].sort();
			const onOrBefore = observed.filter((d) => d <= date);
			const pick = onOrBefore.length ? onOrBefore[onOrBefore.length - 1] : observed[0];
			const o = byDay.get(pick) as Observation;
			day.runs += o.runs;
			day.brand += o.brand;
			for (const [name, n] of o.competitors) day.competitors.set(name, (day.competitors.get(name) ?? 0) + n);
			day.prompts.set(promptId, o);
		}
		if (day.prompts.size > 0) days.set(date, day);
	}

	let asOf: string | null = null;
	for (let i = dates.length - 1; i >= 0; i--) {
		if ((days.get(dates[i])?.runs ?? 0) > 0) {
			asOf = dates[i];
			break;
		}
	}
	const snapshot = asOf ? (days.get(asOf) as OracleDay) : null;
	const snapshotRuns = snapshot?.runs ?? 0;
	const evaluated = snapshot?.prompts.size ?? 0;
	const mk = (name: string, isBrand: boolean): OracleEntity => {
		const mentioned = isBrand ? (snapshot?.brand ?? 0) : (snapshot?.competitors.get(name) ?? 0);
		const visiblePrompts = snapshot
			? [...snapshot.prompts.values()].filter((o) => (isBrand ? o.brand : (o.competitors.get(name) ?? 0)) > 0).length
			: 0;
		return { name, isBrand, mentioned, visibility: snapshotRuns ? (mentioned / snapshotRuns) * 100 : null, visiblePrompts };
	};
	const entities = [mk(BRAND_NAME, true), ...roster.map((n) => mk(n, false))].sort(
		(a, b) => b.mentioned - a.mentioned || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
	);
	const series = [BRAND_NAME, ...entities.filter((e) => !e.isBrand).slice(0, TOP_N).map((e) => e.name)];

	return {
		dates,
		days,
		asOf,
		snapshotRuns,
		evaluated,
		entities,
		series,
		rows(date) {
			const day = days.get(date);
			if (!day || day.runs === 0) return [];
			return series.map((name) => [
				name,
				pct(name === BRAND_NAME ? day.brand : (day.competitors.get(name) ?? 0), day.runs),
			]);
		},
	};
}

/** The window the page requests for a lookback, computed the way the app does (UTC browser). */
function window(lookback: "1m" | "1w"): { fromDate: string; toDate: string } {
	const toDate = isoDay(new Date());
	const from = new Date(`${toDate}T00:00:00Z`);
	if (lookback === "1w") from.setUTCDate(from.getUTCDate() - 6);
	else from.setUTCMonth(from.getUTCMonth() - 1);
	return { fromDate: isoDay(from), toDate };
}

// ---------------------------------------------------------------------------
// Page access
// ---------------------------------------------------------------------------

const section = (page: Page) => page.getByTestId("competitive-visibility-section");
const headline = (page: Page) => page.getByTestId("competitive-visibility-headline");
const radial = (page: Page) => page.getByTestId("competitive-visibility-radial");
const trend = (page: Page) => page.getByTestId("competitive-visibility-trend");
const trendTooltip = (page: Page) => page.getByTestId("competitive-visibility-trend-tooltip");
const leaderboard = (page: Page) => page.getByTestId("competitive-visibility-leaderboard");

async function waitForLines(page: Page, count: number) {
	await expect(trend(page).locator("path.recharts-line-curve")).toHaveCount(count, { timeout: 30_000 });
	await expect
		.poll(
			() =>
				trend(page)
					.locator("path.recharts-line-curve")
					.evaluateAll((paths) => paths.every((p) => !p.getAttribute("stroke-dasharray"))),
			{ timeout: 10_000 },
		)
		.toBe(true);
}

async function plotRect(page: Page) {
	const box = (await trend(page).locator("svg.recharts-surface").boundingBox()) as { x: number; y: number };
	const lines = await trend(page)
		.locator(".recharts-cartesian-grid-horizontal line")
		.evaluateAll((els) =>
			els.map((el) => ({ x1: Number(el.getAttribute("x1")), x2: Number(el.getAttribute("x2")), y: Number(el.getAttribute("y1")) })),
		);
	return { left: box.x + lines[0].x1, right: box.x + lines[0].x2, top: box.y + Math.min(...lines.map((l) => l.y)) };
}
async function hoverAt(page: Page, fraction: number) {
	const plot = await plotRect(page);
	await page.mouse.move(plot.left + (plot.right - plot.left) * fraction, plot.top + 3);
	await expect(trendTooltip(page)).toBeVisible();
}
async function tooltipRows(page: Page): Promise<Array<[string, string]>> {
	return trendTooltip(page)
		.locator("[data-series]")
		.evaluateAll((rows) =>
			rows.map((row) => {
				const spans = row.querySelectorAll("span");
				return [spans[1].textContent ?? "", spans[2].textContent ?? ""] as [string, string];
			}),
		);
}
async function tooltipDate(page: Page): Promise<string> {
	const text = await trendTooltip(page).locator("> div").first().textContent();
	return isoDay(new Date(`${text} 12:00:00 UTC`));
}

interface Row {
	rank: string;
	name: string;
	you: boolean;
	visibility: string;
	barWidth: number;
	visiblePrompts: string;
	evaluated: string;
}
async function leaderboardRows(page: Page): Promise<Row[]> {
	return leaderboard(page)
		.locator("tbody tr")
		.evaluateAll((trs) =>
			trs.map((tr) => {
				const cells = [...tr.querySelectorAll("td")];
				return {
					rank: cells[0].textContent ?? "",
					name: (cells[1].querySelector("span[title]") as HTMLElement).textContent ?? "",
					you: cells[1].textContent?.includes("You") ?? false,
					visibility: (cells[2].querySelector("span") as HTMLElement).textContent ?? "",
					barWidth: Number.parseFloat((cells[2].querySelector("[data-testid=visibility-bar-fill]") as HTMLElement).style.width),
					visiblePrompts: (cells[3].textContent ?? "").replace(/\s+/g, " ").trim(),
					evaluated: cells[4].textContent ?? "",
				};
			}),
		);
}
async function radialLegend(page: Page): Promise<Array<[string, string]>> {
	return page
		.getByTestId("competitive-visibility-radial-legend")
		.getByRole("listitem")
		.evaluateAll((lis) =>
			lis.map((li) => {
				const spans = li.querySelectorAll("span");
				return [spans[1].textContent ?? "", spans[spans.length - 1].textContent ?? ""] as [string, string];
			}),
		);
}

const fmt = (v: number | null) => (v === null ? "—" : `${Math.round(v)}%`);

async function expectSectionMatchesOracle(page: Page, o: Oracle) {
	expect(o.asOf).not.toBeNull();
	const own = o.entities.find((e) => e.isBrand) as OracleEntity;
	await expect(headline(page)).toHaveText(fmt(own.visibility), { timeout: 30_000 });
	await expect(section(page)).toContainText(
		`${BRAND_NAME} is mentioned in ${own.mentioned} of ${o.snapshotRuns} eligible runs across ${o.evaluated} evaluated prompt`,
	);

	// Leaderboard: order, values, coverage, brand row.
	const rows = await leaderboardRows(page);
	expect(rows.map((r) => r.name)).toEqual(o.entities.map((e) => e.name));
	for (const [i, row] of rows.entries()) {
		const e = o.entities[i];
		expect(row.rank).toBe(String(i + 1));
		expect(row.you).toBe(e.isBrand);
		expect(row.visibility).toBe(fmt(e.visibility));
		expect(row.barWidth).toBeCloseTo(e.visibility ?? 0, 1);
		expect(row.visiblePrompts).toBe(`${e.visiblePrompts} (${pct(e.visiblePrompts, o.evaluated)})`);
		expect(row.evaluated).toBe(String(o.evaluated));
		expect(e.visiblePrompts).toBeLessThanOrEqual(o.evaluated);
	}

	// Radial legend: brand + Top 6, same values as the leaderboard.
	const legend = await radialLegend(page);
	expect(legend.map(([name]) => name)).toEqual(o.series);
	for (const [name, value] of legend) expect(value).toBe(fmt(o.entities.find((e) => e.name === name)?.visibility ?? null));
	await expect(radial(page).locator(".recharts-radial-bar-background-sector")).toHaveCount(o.series.length);

	// Trend: same roster, last non-null point == leaderboard.
	await waitForLines(page, o.series.length);
	const legendButtons = trend(page).getByRole("list", { name: "Series" }).getByRole("button");
	await expect(legendButtons).toHaveText([`${BRAND_NAME} (You)`, ...o.series.slice(1)]);
	await hoverAt(page, 1);
	expect(await tooltipDate(page)).toBe(o.asOf);
	expect(await tooltipRows(page)).toEqual(o.rows(o.asOf as string));
	expect(await tooltipRows(page)).toEqual(o.series.map((name) => [name, fmt(o.entities.find((e) => e.name === name)?.visibility ?? null)]));
	await page.mouse.move(0, 0);
}

async function noHorizontalOverflow(page: Page) {
	const m = await page.evaluate(() => ({ s: document.documentElement.scrollWidth, c: document.documentElement.clientWidth }));
	expect(m.s).toBeLessThanOrEqual(m.c);
}
async function withinViewport(locator: Locator, page: Page) {
	const box = (await locator.boundingBox()) as { x: number; width: number };
	const viewport = page.viewportSize() as { width: number };
	expect(box.x).toBeGreaterThanOrEqual(0);
	expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
}

// ---------------------------------------------------------------------------

test.describe("Competitive AI Visibility Overview", () => {
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
			 VALUES ($1, $2, $1, $3, 'https://f08.example.test/', true, true, NOW(), NOW())`,
			[BRAND_ID, org.rows[0].id, BRAND_NAME],
		);
		await client.query(
			`INSERT INTO prompts (id, brand_id, value, enabled, tags, system_tags, created_at, updated_at) VALUES
			 ($1, $6, 'Welche Rechtsschutzversicherung ist die beste?', true, $7, $8, NOW(), NOW()),
			 ($2, $6, 'Was kostet Rechtsschutz?', true, '{}', $9, NOW(), NOW()),
			 ($3, $6, 'Brauche ich einen Anwalt fuer Mietrecht?', true, '{}', $9, NOW(), NOW()),
			 ($4, $6, 'Prompt without any run yet', true, $7, $9, NOW(), NOW()),
			 ($5, $6, 'Disabled prompt', false, $7, $8, NOW(), NOW())`,
			[PROMPTS.tagged, PROMPTS.untagged, PROMPTS.anwalt, PROMPTS.norun, PROMPTS.disabled, BRAND_ID, ["rechtsschutz"], ["branded"], ["unbranded"]],
		);
		for (const [i, name] of COMPETITORS.entries()) {
			await client.query(
				`INSERT INTO competitors (id, brand_id, name, domains, created_at, updated_at) VALUES ($1, $2, $3, $4, NOW(), NOW())`,
				[`6f08c001-0000-4000-8000-00000000000${i + 1}`, BRAND_ID, name, [`${name.toLowerCase()}.example.test`]],
			);
		}
		for (const run of RUNS) {
			await client.query(
				`INSERT INTO prompt_runs (id, prompt_id, brand_id, model, provider, version, web_search_enabled, raw_output, web_queries, brand_mentioned, competitors_mentioned, created_at)
				 VALUES ($1, $2, $3, $4, 'brightdata', 'f08', true, '{}', '{}', $5, $6, $7)`,
				[run.id, run.promptId, BRAND_ID, run.model, run.brand, run.competitors, run.createdAt],
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

	test("the Visibility page gains the three blocks above its prompt cards, matching the oracle", async ({ page }) => {
		const pageErrors: string[] = [];
		const consoleErrors: string[] = [];
		const failedRequests: string[] = [];
		page.on("pageerror", (error) => pageErrors.push(error.message));
		page.on("console", (message) => {
			if (message.type() === "error" && !message.text().startsWith("Failed to load resource")) consoleErrors.push(message.text());
		});
		const origin = new URL(process.env.BASE_URL || "http://localhost:1515").origin;
		page.on("response", (response) => {
			const url = new URL(response.url());
			if (url.origin === origin && response.status() >= 400) failedRequests.push(`${response.status()} ${url.pathname}`);
		});

		await page.goto(BRAND_URL);
		const item = page.locator(`a[href="${BRAND_URL}/visibility"][data-sidebar="menu-button"]`);
		await expect(item).toBeVisible({ timeout: 15_000 });
		const titles = (await page.locator('[data-sidebar="menu-button"]').allTextContents()).map((t) => t.trim());
		expect(titles.filter((t) => /competitive|leaderboard/i.test(t))).toEqual([]);
		await item.click();
		await page.waitForURL(/\/visibility/);
		await expect(page.getByRole("heading", { level: 1, name: /^visibility$/i })).toBeVisible({ timeout: 30_000 });

		// One header, one filter bar, the three new cards, then the per-prompt cards below.
		await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
		await expect(page.getByRole("button", { name: /^tags$/i })).toHaveCount(1);
		await expect(section(page)).toBeVisible({ timeout: 30_000 });
		await expect(section(page).getByText("AI Visibility", { exact: true })).toBeVisible();
		await expect(section(page).getByText("Visibility Trends", { exact: true })).toBeVisible();
		await expect(section(page).getByText("Visibility Leaderboard", { exact: true })).toBeVisible();
		// The old compact own-brand bar is gone; the headline lives in the AI Visibility card.
		await expect(page.getByText(/^\d+%\s*Visibility$/)).toHaveCount(0);
		const promptCards = page.locator("[data-slot=card]").filter({ hasText: "Welche Rechtsschutzversicherung ist die beste?" });
		await expect(promptCards.first()).toBeVisible({ timeout: 30_000 });
		const sectionBox = (await section(page).boundingBox()) as { y: number; height: number };
		const firstPrompt = (await promptCards.first().boundingBox()) as { y: number };
		expect(firstPrompt.y).toBeGreaterThanOrEqual(sectionBox.y + sectionBox.height);
		const filterBar = (await page.getByRole("button", { name: /^tags$/i }).boundingBox()) as { y: number };
		expect(sectionBox.y).toBeGreaterThan(filterBar.y);

		// Every number against the oracle (default 1m scope). No pie/donut, no Others.
		const o = await oracle(client, window("1m"));
		expect(o.evaluated).toBe(3); // the enabled prompt without a run is not evaluated
		expect(o.entities.reduce((s, e) => s + (e.visibility ?? 0), 0)).toBeGreaterThan(100);
		await expectSectionMatchesOracle(page, o);
		await expect(section(page).locator(".recharts-pie")).toHaveCount(0);
		await expect(section(page).getByText("Others")).toHaveCount(0);
		expect((await leaderboardRows(page)).find((r) => r.name === "Ergo")).toMatchObject({ visibility: "0%", barWidth: 0, visiblePrompts: "0 (0%)" });
		// Advocard named twice in one run still counts once: 2 runs on day -6 → carried away by day -2 (Roland/Allianz only).
		expect(o.entities.find((e) => e.name === ADVOCARD)?.mentioned).toBe(0);
		await screenshot(page, "01-default");

		// First / middle / last dates of the trend against the oracle, tooltip inside the viewport at the right edge.
		await hoverAt(page, 0);
		expect(o.dates).toContain(await tooltipDate(page));
		expect(await tooltipRows(page)).toEqual(o.rows(await tooltipDate(page)));
		await screenshot(page, "02-tooltip-first");
		await hoverAt(page, 0.5);
		expect(await tooltipRows(page)).toEqual(o.rows(await tooltipDate(page)));
		await hoverAt(page, 1);
		await withinViewport(trendTooltip(page), page);
		await screenshot(page, "03-tooltip-last");
		// Fixed 0–100 axis.
		await expect(trend(page).locator(".recharts-yAxis .recharts-cartesian-axis-tick-value")).toHaveText(["0%", "25%", "50%", "75%", "100%"]);

		// Legend toggle hides and restores a line and its tooltip row.
		const buttons = trend(page).getByRole("list", { name: "Series" }).getByRole("button");
		await buttons.nth(1).click();
		await expect(buttons.nth(1)).toHaveAttribute("aria-pressed", "false");
		await expect(trend(page).locator("path.recharts-line-curve")).toHaveCount(o.series.length - 1);
		await hoverAt(page, 1);
		expect((await tooltipRows(page)).map(([n]) => n)).not.toContain(o.series[1]);
		await buttons.nth(1).click();
		await expect(trend(page).locator("path.recharts-line-curve")).toHaveCount(o.series.length);

		// Radial tooltip shows the raw counts.
		await radial(page).locator(".recharts-radial-bar-sector").first().hover();
		await expect(page.getByTestId("competitive-visibility-radial-tooltip")).toContainText(/\d+ \/ \d+ eligible runs/);
		await expect(page.getByTestId("competitive-visibility-radial-tooltip")).toContainText(/Visible prompts/);
		await page.mouse.move(0, 0);

		expect(pageErrors).toEqual([]);
		expect(consoleErrors).toEqual([]);
		expect(failedRequests).toEqual([]);
	});

	test("every filter of the page scopes all three blocks and the prompt list together", async ({ page }) => {
		await page.goto(`${BRAND_URL}/visibility`);
		await expect(section(page)).toBeVisible({ timeout: 30_000 });
		const base = await oracle(client, window("1m"));
		await expectSectionMatchesOracle(page, base);

		// Model: only the claude run remains → one evaluated prompt.
		await page.goto(`${BRAND_URL}/visibility?model=claude`);
		const claude = await oracle(client, { ...window("1m"), model: "claude" });
		expect(claude.evaluated).toBe(1);
		await expectSectionMatchesOracle(page, claude);
		expect(claude.entities.find((e) => e.name === WGV)?.visibility).toBe(100);
		await screenshot(page, "04-model-claude");

		// Tags: the tagged prompt only (the no-run prompt carries the tag but has no eligible run).
		await page.goto(`${BRAND_URL}/visibility?tags=rechtsschutz`);
		const tagged = await oracle(client, { ...window("1m"), tags: ["rechtsschutz"] });
		expect(tagged.evaluated).toBe(1);
		await expectSectionMatchesOracle(page, tagged);
		await expect(page.locator("[data-slot=card]").filter({ hasText: "Was kostet Rechtsschutz?" })).toHaveCount(0);

		// Search (q) is part of the Visibility scope, unlike Share of Voice.
		await page.goto(`${BRAND_URL}/visibility?q=anwalt`);
		const anwalt = await oracle(client, { ...window("1m"), search: "anwalt" });
		expect(anwalt.evaluated).toBe(1);
		expect(anwalt.snapshotRuns).toBe(2);
		await expectSectionMatchesOracle(page, anwalt);
		await expect(page.locator("[data-slot=card]").filter({ hasText: "Anwalt fuer Mietrecht" })).toHaveCount(1);

		// Lookback 1w drops the day −6 runs from the window but not from the carry (tagged prompt keeps its day −2 state).
		await page.goto(`${BRAND_URL}/visibility?lookback=1w`);
		const week = await oracle(client, window("1w"));
		await expectSectionMatchesOracle(page, week);
		expect(week.dates).toHaveLength(7);

		// `order` reorders the prompt list only.
		await page.goto(`${BRAND_URL}/visibility?order=alphabetical`);
		await expectSectionMatchesOracle(page, base);

		// Empty resolution: the shell's no-match state, no stale numbers.
		await page.goto(`${BRAND_URL}/visibility?q=zzz-no-such-prompt`);
		await expect(page.getByText("No prompts match your filters.")).toBeVisible({ timeout: 30_000 });
		await expect(section(page)).toHaveCount(0);
		await expect(headline(page)).toHaveCount(0);
		// Reset restores the default numbers.
		await page.getByRole("button", { name: /clear filters/i }).click();
		await expect(section(page)).toBeVisible({ timeout: 30_000 });
		await expectSectionMatchesOracle(page, base);

		// Filter change via the UI (not a reload) refreshes the section as well.
		await page.getByRole("button", { name: /^tags$/i }).click();
		await page.getByRole("button", { name: /rechtsschutz/i }).click();
		await page.keyboard.press("Escape");
		await page.waitForURL(/tags=rechtsschutz/);
		await expectSectionMatchesOracle(page, tagged);
	});

	test("an error in the overview does not take the prompt list down", async ({ page }) => {
		// The server-function URL is a hash, so fail the call by its response shape instead.
		await page.route("**/_serverFn/**", async (route) => {
			const response = await route.fetch();
			const body = await response.text();
			if (body.includes('"snapshotRuns"')) return route.fulfill({ status: 500, body: "boom" });
			return route.fulfill({ response, body });
		});
		await page.goto(`${BRAND_URL}/visibility`);
		await expect(page.getByTestId("competitive-visibility-error")).toBeVisible({ timeout: 30_000 });
		await expect(page.locator("[data-slot=card]").filter({ hasText: "Welche Rechtsschutzversicherung ist die beste?" }).first()).toBeVisible({ timeout: 30_000 });
		await expect(headline(page)).toHaveCount(0);
	});

	test("narrow viewport and dark mode keep the layout inside the page", async ({ page }) => {
		const o = await oracle(client, window("1m"));
		await page.setViewportSize({ width: 375, height: 900 });
		await page.goto(`${BRAND_URL}/visibility`);
		await expect(section(page)).toBeVisible({ timeout: 30_000 });
		await waitForLines(page, o.series.length);
		await noHorizontalOverflow(page);
		const cards = section(page).locator("[data-slot=card]");
		const boxes = await cards.evaluateAll((els) => els.map((el) => el.getBoundingClientRect().top));
		expect([...boxes].sort((a, b) => a - b)).toEqual(boxes);
		await hoverAt(page, 1);
		await withinViewport(trendTooltip(page), page);
		await noHorizontalOverflow(page);
		await screenshot(page, "05-narrow-375");

		await page.setViewportSize({ width: 1400, height: 1000 });
		await page.emulateMedia({ colorScheme: "dark" });
		await page.goto(`${BRAND_URL}/visibility`);
		await page.evaluate(() => document.documentElement.classList.add("dark"));
		await expect(section(page)).toBeVisible({ timeout: 30_000 });
		await waitForLines(page, o.series.length);
		await hoverAt(page, 1);
		const surface = await trendTooltip(page).evaluate((el) => getComputedStyle(el).backgroundColor);
		expect(surface).not.toBe("rgb(255, 255, 255)");
		await screenshot(page, "06-dark");
	});

	test("Overview and Share of Voice are unchanged and the Overview hero equals the new headline", async ({ page }) => {
		const o = await oracle(client, window("1m"));
		const own = o.entities.find((e) => e.isBrand) as OracleEntity;
		await page.goto(BRAND_URL);
		const overviewSection = page.locator("section").filter({ has: page.getByRole("heading", { level: 2, name: /^AI Visibility$/ }) });
		await expect(overviewSection).toBeVisible({ timeout: 30_000 });
		await expect(overviewSection.locator(".tabular-nums").first()).toHaveText(fmt(own.visibility), { timeout: 30_000 });
		await expect(page.getByTestId("competitive-visibility-section")).toHaveCount(0);
		await expect(page.locator("[data-slot=chart]").filter({ has: page.locator(".recharts-area") })).toHaveCount(2);
		await screenshot(page, "07-overview-unchanged");

		await page.goto(`${BRAND_URL}/share-of-voice`);
		await expect(page.getByTestId("share-of-voice-trend-chart")).toBeVisible({ timeout: 30_000 });
		await expect(page.locator(".recharts-pie")).toHaveCount(1);
		await expect(page.getByTestId("competitive-visibility-section")).toHaveCount(0);
		// Share of Voice still reconciles to 100% across its leaderboard.
		const shares = await page
			.getByRole("table")
			.locator("tbody tr span.tabular-nums.text-sm")
			.evaluateAll((els) => els.map((el) => Number.parseInt(el.textContent ?? "0", 10)));
		const total = shares.reduce((s, v) => s + v, 0);
		expect(total).toBeGreaterThanOrEqual(97);
		expect(total).toBeLessThanOrEqual(103);

		await page.goto(`${BRAND_URL}/citations`);
		await expect(page.getByRole("heading", { level: 1, name: /^citations$/i })).toBeVisible({ timeout: 30_000 });
	});
});
