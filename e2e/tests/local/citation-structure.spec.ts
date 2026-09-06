/**
 * F-06 — Citation Structure: the dedicated sidebar item opens a page whose
 * only analytical content is one Sankey of own-domain citation occurrences,
 * brand → configured owned domain → raw hostname → normalized path.
 *
 * The spec seeds its own brand in the shared test organization (apex, www,
 * prerelease and seven more hostnames under arag.de, one under arag.com,
 * lookalike hosts, a disabled prompt, two models, tagged and untagged prompts,
 * rows inside and outside the 7-day window) and compares every total the
 * diagram shows with an independent SQL count over the same rows.
 */
import { expect, type Page, test } from "@playwright/test";
import pg from "pg";
import { brandUrl, DATABASE_URL, SLUGGED_BRAND_SLUG, TEST_ORG_SLUG } from "../../fixtures";

const BRAND_ID = "f06-structure";
const BRAND_NAME = "F06 Structure";
const BRAND_URL = brandUrl(BRAND_ID, TEST_ORG_SLUG);
const OWNED = ["arag.de", "arag.com"];

const PROMPTS = {
	tagged: "6f06a001-0000-4000-8000-000000000001",
	untagged: "6f06a001-0000-4000-8000-000000000002",
	disabled: "6f06a001-0000-4000-8000-000000000003",
};

const daysAgo = (days: number) => new Date(Date.now() - days * 24 * 60 * 60 * 1000);

const RUNS: { id: string; promptId: string; model: string; createdAt: Date; urls: string[] }[] = [
	{
		id: "6f06b001-0000-4000-8000-000000000001",
		promptId: PROMPTS.tagged,
		model: "chatgpt",
		createdAt: daysAgo(1),
		urls: [
			"https://www.arag.de/service/",
			"https://www.arag.de/service?utm_source=chatgpt.com",
			"https://arag.de/",
			"https://notarag.de/x",
			"https://www.arag.com/about-us/",
		],
	},
	{
		id: "6f06b001-0000-4000-8000-000000000002",
		promptId: PROMPTS.tagged,
		model: "claude",
		createdAt: daysAgo(1),
		urls: ["https://www.arag.de/service#faq", "https://prerelease.arag.de/service", "https://arag.de.evil.test/x"],
	},
	{
		id: "6f06b001-0000-4000-8000-000000000003",
		promptId: PROMPTS.untagged,
		model: "chatgpt",
		createdAt: daysAgo(2),
		urls: ["http://www.arag.de/ratgeber/", "https://www.arag.de/ratgeber/mietrecht", "https://reddit.com/r/x"],
	},
	{
		id: "6f06b001-0000-4000-8000-000000000004",
		promptId: PROMPTS.disabled,
		model: "chatgpt",
		createdAt: daysAgo(1),
		urls: ["https://www.arag.de/disabled-1", "https://www.arag.de/disabled-2", "https://www.arag.de/disabled-3"],
	},
	{
		id: "6f06b001-0000-4000-8000-000000000005",
		promptId: PROMPTS.untagged,
		model: "chatgpt",
		createdAt: daysAgo(20),
		urls: ["https://www.arag.de/old-1", "https://www.arag.de/old-2"],
	},
	{
		id: "6f06b001-0000-4000-8000-000000000006",
		promptId: PROMPTS.untagged,
		model: "claude",
		createdAt: daysAgo(3),
		urls: [1, 2, 3, 4, 5, 6, 7].map((n) => `https://h${n}.arag.de/x`),
	},
];

/** What the diagram shows, read back from the SVG node titles. */
interface ShownNode {
	kind: string;
	label: string;
	value: number;
	depth: number;
}

const TITLE = /^(Brand|Owned domain|Hostname|Path|Grouped remainder) (.+): ([\d.,\s]+) occurrences?, /;

async function readNodes(page: Page): Promise<ShownNode[]> {
	const sankey = page.getByTestId("citation-structure-sankey");
	await expect(sankey).toBeVisible({ timeout: 30_000 });
	await expect(sankey.locator("g.recharts-sankey-node").first()).toBeAttached({ timeout: 15_000 });
	return sankey.locator("g.recharts-sankey-node").evaluateAll((groups) =>
		groups.map((g) => {
			const title = g.querySelector("title")?.textContent ?? "";
			const match = title.match(/^(Brand|Owned domain|Hostname|Path|Grouped remainder) (.+): ([\d.,\s]+) occurrences?, /);
			return {
				kind: match?.[1] ?? "?",
				label: match?.[2] ?? title,
				value: Number((match?.[3] ?? "NaN").replace(/[^\d]/g, "")),
				depth: Number(g.getAttribute("data-depth")),
			};
		}),
	);
}

/** Optional evidence capture: set F06_SCREENSHOT_DIR to save the states the PR shows. */
async function screenshot(page: Page, name: string) {
	const dir = process.env.F06_SCREENSHOT_DIR;
	if (dir) await page.screenshot({ path: `${dir}/${name}.png`, fullPage: true });
}

const sumAt = (nodes: ShownNode[], depth: number) =>
	nodes.filter((n) => n.depth === depth).reduce((sum, n) => sum + n.value, 0);

/**
 * Root = Σ domains = Σ hosts = Σ terminals, and the root equals the oracle.
 * Polls, because a filter change keeps the previous diagram on screen until
 * the refetch lands.
 */
async function expectDiagramTotal(page: Page, expected: number) {
	await expect
		.poll(async () => (await readNodes(page)).find((n) => n.depth === 0)?.value, { timeout: 30_000 })
		.toBe(expected);
	const nodes = await readNodes(page);
	expect(nodes.every((n) => TITLE.test(`${n.kind} ${n.label}: ${n.value} occurrences, `))).toBe(true);
	expect(sumAt(nodes, 1)).toBe(expected);
	expect(sumAt(nodes, 2)).toBe(expected);
	expect(sumAt(nodes, 3)).toBe(expected);
	return nodes;
}

test.describe("Citation Structure", () => {
	test.describe.configure({ mode: "serial" });

	let client: pg.Client;

	/** Independent oracle: enabled prompts, UTC calendar window, exact-or-dot-suffix owned host. */
	async function oracle(opts: { days: number; model?: string; tags?: string[] }): Promise<number> {
		const ownedClause = OWNED.map((_, i) => `(host = $${i + 3} OR host LIKE '%.' || $${i + 3})`).join(" OR ");
		const params: unknown[] = [BRAND_ID, opts.days - 1, ...OWNED];
		let tagClause = "";
		if (opts.model) {
			params.push(opts.model);
			tagClause += ` AND c.model = $${params.length}`;
		}
		if (opts.tags) {
			params.push(opts.tags);
			tagClause += ` AND (p.tags && $${params.length}::text[] OR p.system_tags && $${params.length}::text[])`;
		}
		const { rows } = await client.query(
			`WITH eligible AS (
			   SELECT lower(split_part(split_part(split_part(c.url, '://', 2), '/', 1), ':', 1)) AS host
			   FROM citations c JOIN prompts p ON p.id = c.prompt_id
			   WHERE c.brand_id = $1 AND p.enabled
			     AND c.created_at >= ((now() AT TIME ZONE 'utc')::date - $2::int)::timestamp AT TIME ZONE 'utc'
			     AND c.created_at < ((now() AT TIME ZONE 'utc')::date + 1)::timestamp AT TIME ZONE 'utc'
			     ${tagClause}
			 )
			 SELECT count(*)::int AS n FROM eligible WHERE ${ownedClause}`,
			params,
		);
		return rows[0].n;
	}

	test.beforeAll(async () => {
		const host = new URL(DATABASE_URL).hostname;
		if (!["localhost", "127.0.0.1", "::1"].includes(host)) throw new Error(`refusing non-loopback database ${host}`);
		client = new pg.Client({ connectionString: DATABASE_URL });
		await client.connect();
		const org = await client.query("SELECT id FROM organization WHERE slug = $1", [TEST_ORG_SLUG]);
		if (org.rows.length !== 1) throw new Error("seeded organization missing — not the disposable test database");

		await client.query(
			`INSERT INTO brands (id, organization_id, slug, name, website, additional_domains, enabled, onboarded, created_at, updated_at)
			 VALUES ($1, $2, $1, $3, 'https://arag.de/', $4, true, true, NOW(), NOW())`,
			[BRAND_ID, org.rows[0].id, BRAND_NAME, ["arag.com"]],
		);
		await client.query(
			`INSERT INTO prompts (id, brand_id, value, enabled, tags, system_tags, created_at, updated_at) VALUES
			 ($1, $4, 'Welche Rechtsschutzversicherung ist die beste?', true, $5, $6, NOW(), NOW()),
			 ($2, $4, 'Was kostet Rechtsschutz?', true, '{}', $7, NOW(), NOW()),
			 ($3, $4, 'Disabled prompt', false, '{}', $7, NOW(), NOW())`,
			[PROMPTS.tagged, PROMPTS.untagged, PROMPTS.disabled, BRAND_ID, ["rechtsschutz"], ["branded"], ["unbranded"]],
		);
		for (const run of RUNS) {
			await client.query(
				`INSERT INTO prompt_runs (id, prompt_id, brand_id, model, version, web_search_enabled, raw_output, web_queries, brand_mentioned, competitors_mentioned, created_at)
				 VALUES ($1, $2, $3, $4, 'f06', true, '{}', '{}', true, '{}', $5)`,
				[run.id, run.promptId, BRAND_ID, run.model, run.createdAt],
			);
			for (const [index, url] of run.urls.entries()) {
				const domain = new URL(url).hostname.replace(/^www\./, "");
				await client.query(
					`INSERT INTO citations (prompt_run_id, prompt_id, brand_id, model, url, domain, title, citation_index, created_at)
					 VALUES ($1, $2, $3, $4, $5, $6, NULL, $7, $8)`,
					[run.id, run.promptId, BRAND_ID, run.model, url, domain, index, run.createdAt],
				);
			}
		}
	});

	test.afterAll(async () => {
		try {
			const promptIds = Object.values(PROMPTS);
			await client.query("DELETE FROM citations WHERE brand_id = $1", [BRAND_ID]);
			await client.query("DELETE FROM prompt_runs WHERE brand_id = $1", [BRAND_ID]);
			await client
				.query("DELETE FROM pgboss.job WHERE name = 'process-prompt' AND data->>'promptId' = ANY($1::text[])", [promptIds])
				.catch(() => undefined);
			await client.query("DELETE FROM prompts WHERE brand_id = $1", [BRAND_ID]);
			await client.query("DELETE FROM brands WHERE id = $1", [BRAND_ID]);
		} finally {
			await client.end();
		}
	});

	test("the sidebar item leads to a page whose only analytical content is the Sankey", async ({ page }) => {
		const pageErrors: string[] = [];
		const consoleErrors: string[] = [];
		const failedRequests: string[] = [];
		page.on("pageerror", (error) => pageErrors.push(error.message));
		page.on("console", (message) => {
			// Third-party favicon 404s log as resource errors; same-origin failures are tracked below.
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
		const item = page.locator(`a[href="${BRAND_URL}/citation-structure"][data-sidebar="menu-button"]`);
		await expect(item).toBeVisible({ timeout: 15_000 });
		await expect(item).toHaveText("Citation Structure");

		// Citations → Citation Structure → Opportunities, in that order.
		const rail = page.locator('[data-sidebar="menu-button"]');
		const titles = (await rail.allTextContents()).map((t) => t.trim());
		const citations = titles.indexOf("Citations");
		expect(titles.slice(citations, citations + 3)).toEqual(["Citations", "Citation Structure", "Opportunities"]);

		await item.click();
		await page.waitForURL(/\/citation-structure/);
		await expect(page.getByRole("heading", { level: 1, name: /citation structure/i })).toBeVisible({ timeout: 30_000 });
		await expect(item).toHaveAttribute("data-active", "true");
		await expect(page.locator(`a[href="${BRAND_URL}/citations"][data-sidebar="menu-button"]`)).toHaveAttribute(
			"data-active",
			"false",
		);
		await expect(page).toHaveTitle(/Citation Structure/);

		// Exactly one visualization, none of the Citations widgets.
		await expect(page.getByTestId("citation-structure-sankey")).toHaveCount(1);
		await expect(page.locator("[data-slot=chart]")).toHaveCount(1);
		await expect(page.locator(".recharts-surface")).toHaveCount(1);
		await expect(page.locator("main table, [role=tablist]")).toHaveCount(0);
		await expect(page.getByText(/top (domains|urls)|content gaps|what's changed/i)).toHaveCount(0);
		await expect(page.getByRole("searchbox")).toHaveCount(0);
		await expect(page.getByRole("button", { name: /all models/i })).toBeVisible();
		await expect(page.getByRole("button", { name: /^tags$/i })).toBeVisible();

		await readNodes(page);
		expect(pageErrors).toEqual([]);
		expect(consoleErrors).toEqual([]);
		expect(failedRequests).toEqual([]);
	});

	test("the diagram's totals equal the SQL oracle and conserve at every depth", async ({ page }) => {
		await page.goto(`${BRAND_URL}/citation-structure?lookback=1m`);
		const expected = await oracle({ days: 30 });
		expect(expected).toBe(17);
		const nodes = await expectDiagramTotal(page, expected);

		const find = (kind: string, label: string) => nodes.find((n) => n.kind === kind && n.label === label);
		expect(find("Brand", BRAND_NAME)?.value).toBe(17);
		expect(find("Owned domain", "arag.de")?.value).toBe(16);
		expect(find("Owned domain", "arag.com")?.value).toBe(1);
		expect(find("Hostname", "www.arag.de")?.value).toBe(7);
		expect(find("Hostname", "arag.de")?.value).toBe(1);
		expect(find("Hostname", "www.arag.com")?.value).toBe(1);
		expect(find("Path", "www.arag.de/service")?.value).toBe(3);
		expect(find("Path", "www.arag.de/ratgeber")?.value).toBe(1);
		expect(find("Path", "www.arag.de/ratgeber/mietrecht")?.value).toBe(1);
		expect(find("Path", "arag.de/")?.value).toBe(1);
		expect(find("Path", "www.arag.com/about-us")?.value).toBe(1);
		expect(nodes.some((n) => n.label.includes("notarag") || n.label.includes("evil") || n.label.includes("disabled"))).toBe(false);

		// Six hosts stay visible under arag.de; the other four fold into Other hosts → Rest.
		expect(nodes.filter((n) => n.kind === "Hostname" && n.label.endsWith("arag.de"))).toHaveLength(6);
		expect(find("Grouped remainder", "Other hosts · arag.de")?.value).toBe(4);
		expect(find("Grouped remainder", "Rest · Other hosts · arag.de")?.value).toBe(4);

		const otherHosts = page.locator("g.recharts-sankey-node", { has: page.locator("title", { hasText: "Other hosts · arag.de" }) });
		await otherHosts.locator("path").first().hover();
		const tooltip = page.getByRole("status");
		await expect(tooltip).toContainText("Other hosts · arag.de");
		await expect(tooltip).toContainText("4 occurrences across 4 hostnames");

		const summary = page.getByTestId("citation-structure-summary");
		await expect(summary).toContainText(`Brand ${BRAND_NAME}: 17 occurrences, 100%`);
		await expect(summary).toContainText("Hostname www.arag.de: 7 occurrences");
		await screenshot(page, "01-diagram-with-rest-and-tooltip");

		// Dark theme: the chart's own colour variables switch with the `.dark` class.
		await page.evaluate(() => document.documentElement.classList.add("dark"));
		await expect(page.locator("g.recharts-sankey-node[data-depth='0'] path")).toHaveCSS("fill", "rgb(96, 165, 250)");
		await screenshot(page, "02-dark");
		await page.evaluate(() => document.documentElement.classList.remove("dark"));
	});

	test("model, tag and lookback filters narrow the diagram exactly like the citation query", async ({ page }) => {
		await page.goto(`${BRAND_URL}/citation-structure?lookback=1m&model=chatgpt`);
		expect(await oracle({ days: 30, model: "chatgpt" })).toBe(8);
		await expectDiagramTotal(page, 8);

		await page.goto(`${BRAND_URL}/citation-structure?lookback=1m&model=claude`);
		expect(await oracle({ days: 30, model: "claude" })).toBe(9);
		await expectDiagramTotal(page, 9);

		await page.goto(`${BRAND_URL}/citation-structure?lookback=1m&tags=rechtsschutz`);
		expect(await oracle({ days: 30, tags: ["rechtsschutz"] })).toBe(6);
		await expectDiagramTotal(page, 6);

		await page.goto(`${BRAND_URL}/citation-structure?lookback=1m&tags=unbranded`);
		expect(await oracle({ days: 30, tags: ["unbranded"] })).toBe(11);
		await expectDiagramTotal(page, 11);

		// Lookback through the UI, then a reload proves the URL carries the filter.
		await page.goto(`${BRAND_URL}/citation-structure?lookback=1m`);
		await expectDiagramTotal(page, 17);
		await page.getByRole("button", { name: /last 30 days/i }).click();
		await page.getByRole("menuitemradio", { name: /last 7 days/i }).click();
		await expect(page).toHaveURL(/lookback=1w/);
		expect(await oracle({ days: 7 })).toBe(15);
		await expectDiagramTotal(page, 15);
		await page.reload();
		await expect(page.getByRole("button", { name: /last 7 days/i })).toBeVisible();
		await expectDiagramTotal(page, 15);

		// A filter no prompt matches shows the no-match state with the clear-filters escape, never an empty chart.
		await page.goto(`${BRAND_URL}/citation-structure?lookback=1m&tags=no-such-tag`);
		await expect(page.getByText(/No citations of your own domains match the selected filters/)).toBeVisible({ timeout: 30_000 });
		await expect(page.getByTestId("citation-structure-sankey")).toHaveCount(0);
		await screenshot(page, "03-filtered-no-match");
		await page.getByRole("button", { name: "Clear filters" }).click();
		await expectDiagramTotal(page, 17);
	});

	test("a narrow viewport scrolls the canvas instead of crushing the four columns", async ({ page }) => {
		await page.setViewportSize({ width: 375, height: 812 });
		await page.goto(`${BRAND_URL}/citation-structure?lookback=1m`);
		await expectDiagramTotal(page, 17);
		const scroller = page.locator("[data-testid=citation-structure-sankey] .overflow-x-auto");
		const metrics = await scroller.evaluate((el) => ({ scrollWidth: el.scrollWidth, clientWidth: el.clientWidth }));
		expect(metrics.scrollWidth).toBeGreaterThan(metrics.clientWidth);
		expect(metrics.scrollWidth).toBeGreaterThanOrEqual(880);
		await screenshot(page, "04-narrow-375");
	});

	test("a brand whose own domains were never cited shows the empty state, not an empty chart", async ({ page }) => {
		await page.goto(`${brandUrl(SLUGGED_BRAND_SLUG, TEST_ORG_SLUG)}/citation-structure`);
		await expect(page.getByRole("heading", { level: 1, name: /citation structure/i })).toBeVisible({ timeout: 30_000 });
		await expect(page.getByText(/No citations of your own domains yet/)).toBeVisible({ timeout: 30_000 });
		await expect(page.getByTestId("citation-structure-sankey")).toHaveCount(0);
		await expect(page.locator("[data-slot=chart]")).toHaveCount(0);
		await screenshot(page, "05-empty");
	});
});
