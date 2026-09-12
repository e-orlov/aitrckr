/**
 * SENT-01 — the Sentiment page: route/sidebar/filter parity (no Search, no
 * model selector, no model labels), route-local aspect/sort URL state that a
 * stale `q`/`model` cannot influence, lazy row expansion with non-overlapping
 * 10/10 evidence and the run deep link, responsive/dark/focus behaviour, and
 * rendered values reconciled with an independent SQL oracle.
 *
 * The spec seeds its own brand with synthetic answers (never production text):
 * eight competitors so the chart roster is Top-6, one zero-mention competitor,
 * an inactive competitor that must stay invisible, 24 classified observations
 * for Alpha (10/10 evidence with four left over), a failed and a pending
 * analysis, aspect rows and citations on some runs.
 */
import { expect, type Page, test } from "@playwright/test";
import pg from "pg";
import { brandUrl, DATABASE_URL, TEST_API_KEY, TEST_ORG_SLUG } from "../../fixtures";

const BRAND_ID = "sent-e2e";
const BRAND_NAME = "Sentiment E2E";
const BRAND_URL = brandUrl(BRAND_ID, TEST_ORG_SLUG);
const PAGE_URL = `${BRAND_URL}/sentiment`;
const DETECTOR = "sent-detector-v1";
const CLASSIFIER = "sent-classifier-v1";
const TAXONOMY = "sent-aspects-v1";

const uuid = (block: string, n: number) => `5e970004-0000-4000-8000-${block}${String(n).padStart(12 - block.length, "0")}`;
const COMPETITORS = ["Alpha", "Bravo", "Charlie", "Delta", "Echo", "Foxtrot", "Golf", "Zero"].map((name, i) => ({
	id: uuid("1", i + 1),
	name,
}));
const GONE = { id: uuid("1", 99), name: "Gone" };
const PROMPTS = { tagged: uuid("2", 1), plain: uuid("2", 2) };
const RUN_COUNT = 30;
const runId = (i: number) => uuid("3", i);

// Alpha: 24 classified observations with distinct scores 10..100 plus repeats — enough for 10 highest + 10 lowest with 4 unused.
const ALPHA_SCORES = [100, 96, 92, 88, 84, 80, 76, 72, 68, 64, 60, 56, 52, 50, 50, 48, 44, 40, 36, 32, 28, 24, 20, 10];
const categoryFor = (score: number, mixed = false) => (score > 50 ? "positive" : score < 50 ? "negative" : mixed ? "mixed" : "neutral");
const answerFor = (i: number) => `Synthetic answer ${i}. Alpha delivers a solid tariff while ${BRAND_NAME} keeps growing. Bravo is also named.`;
// `uuid("3", i)` puts the block digit before the zero-padded index; the index is the last eleven digits.
const runIndex = (run: string) => Number.parseInt(run.slice(-11), 10);
/** An exact evidence span with raw offsets into the seeded answer body. */
const evidenceSpan = (run: string, quote: string, polarity: "positive" | "negative" | "neutral") => {
	const start = answerFor(runIndex(run)).indexOf(quote);
	if (start < 0) throw new Error(`quote "${quote}" is not in the seeded answer`);
	return { quote, start, end: start + quote.length, polarity };
};

test.describe("Sentiment page", () => {
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
		await cleanup(client);

		await client.query(
			`INSERT INTO brands (id, organization_id, slug, name, website, enabled, onboarded, created_at, updated_at)
			 VALUES ($1, $2, $1, $3, 'https://sent-e2e.example.test/', true, true, NOW(), NOW())`,
			[BRAND_ID, org.rows[0].id, BRAND_NAME],
		);
		for (const [i, c] of [...COMPETITORS, GONE].entries()) {
			await client.query(
				`INSERT INTO competitors (id, brand_id, name, domains, active, removed_at, created_at, updated_at)
				 VALUES ($1, $2, $3, $4, $5, $6, NOW() + ($7 || ' seconds')::interval, NOW())`,
				[c.id, BRAND_ID, c.name, [`${c.name.toLowerCase()}.example.test`], c !== GONE, c === GONE ? new Date() : null, String(i)],
			);
		}
		await client.query(
			`INSERT INTO prompts (id, brand_id, value, enabled, tags, system_tags, created_at, updated_at) VALUES
			 ($1, $3, 'Welche Rechtsschutzversicherung ist die beste?', true, '{insurance}', '{unbranded}', NOW(), NOW()),
			 ($2, $3, 'Was kostet Rechtsschutz?', true, '{}', '{unbranded}', NOW(), NOW())`,
			[PROMPTS.tagged, PROMPTS.plain, BRAND_ID],
		);
		// 30 runs spread over the last 12 days (well inside the 1m default), alternating prompts.
		for (let i = 1; i <= RUN_COUNT; i++) {
			await client.query(
				`INSERT INTO prompt_runs (id, prompt_id, brand_id, model, provider, version, web_search_enabled, raw_output, web_queries, brand_mentioned, competitors_mentioned, created_at)
				 VALUES ($1, $2, $3, 'chatgpt', 'openrouter', 'e2e', true, $4, '{}', true, '{}', NOW() - ($5 || ' days')::interval + ($6 || ' minutes')::interval)`,
				[
					runId(i),
					i % 2 === 0 ? PROMPTS.tagged : PROMPTS.plain,
					BRAND_ID,
					JSON.stringify({
						choices: [{ message: { content: answerFor(i) } }],
					}),
					String(1 + (i % 12)),
					String(i),
				],
			);
		}
		for (let i = 1; i <= RUN_COUNT; i++) {
			await client.query(
				`INSERT INTO sentiment_detections (prompt_run_id, brand_id, detector_version, status, mention_count) VALUES ($1, $2, $3, 'mentions', 1)`,
				[runId(i), BRAND_ID, DETECTOR],
			);
		}
		const mention = async (run: string, key: string, type: "brand" | "competitor", name: string) =>
			(
				await client.query<{ id: string }>(
					`INSERT INTO prompt_run_entity_mentions (prompt_run_id, brand_id, entity_type, competitor_id, entity_key, entity_name, detector_version)
					 VALUES ($1, $2, $3, $4::uuid, $5, $6, $7) RETURNING id`,
					[run, BRAND_ID, type, type === "brand" ? null : key, key, name, DETECTOR],
				)
			).rows[0].id;
		const analysis = async (run: string, status: string) =>
			(
				await client.query<{ id: string }>(
					`INSERT INTO sentiment_analyses (prompt_run_id, brand_id, classifier_version, taxonomy_version, status, completed_at)
					 VALUES ($1, $2, $3, $4, $5, CASE WHEN $5 = 'completed' THEN NOW() END) RETURNING id`,
					[run, BRAND_ID, CLASSIFIER, TAXONOMY, status],
				)
			).rows[0].id;
		const observe = async (analysisId: string, mentionId: string, run: string, type: "brand" | "competitor", key: string, score: number, mixed = false) =>
			(
				await client.query<{ id: string }>(
					`INSERT INTO sentiment_observations (analysis_id, mention_id, prompt_run_id, brand_id, entity_type, competitor_id, entity_key, score, category, confidence, evidence)
					 VALUES ($1, $2, $3, $4, $5, $6::uuid, $7, $8, $9, 0.9, $10::jsonb) RETURNING id`,
					[
						analysisId,
						mentionId,
						run,
						BRAND_ID,
						type,
						type === "brand" ? null : key,
						key,
						score,
						categoryFor(score, mixed),
						JSON.stringify(mixed ? [evidenceSpan(run, "solid tariff", "positive"), evidenceSpan(run, "keeps growing", "negative")] : [evidenceSpan(run, "Alpha delivers a solid tariff", "positive")]),
					],
				)
			).rows[0].id;

		const alpha = COMPETITORS[0];
		const bravo = COMPETITORS[1];
		// Runs 1–24: Alpha mentioned and classified; runs 25–28: Alpha mentioned, analysis pending/failed/no obs; 29–30: no Alpha.
		for (let i = 1; i <= 28; i++) {
			const m = await mention(runId(i), alpha.id, "competitor", alpha.name);
			if (i <= 24) {
				const a = await analysis(runId(i), "completed");
				const obs = await observe(a, m, runId(i), "competitor", alpha.id, ALPHA_SCORES[i - 1], ALPHA_SCORES[i - 1] === 50 && i === 14);
				if (i <= 6) {
					await client.query(
						`INSERT INTO sentiment_aspect_observations (observation_id, taxonomy_version, aspect_key, aspect_label, score, category, confidence, evidence)
						 VALUES ($1, $2, 'price', 'Price', $3, $4, 0.8, $5::jsonb)`,
						[obs, TAXONOMY, i <= 3 ? 80 : 30, i <= 3 ? "positive" : "negative", JSON.stringify([evidenceSpan(runId(i), "solid tariff", i <= 3 ? "positive" : "negative")])],
					);
				}
			} else if (i === 25) await analysis(runId(i), "failed");
			else if (i === 26) await analysis(runId(i), "pending");
		}
		// Brand: mentioned in every run, classified in runs 1–24 with a flat 70.
		for (let i = 1; i <= RUN_COUNT; i++) {
			const m = await mention(runId(i), "brand", "brand", BRAND_NAME);
			if (i <= 24) {
				const { rows } = await client.query<{ id: string }>("SELECT id FROM sentiment_analyses WHERE prompt_run_id = $1", [runId(i)]);
				await observe(rows[0].id, m, runId(i), "brand", "brand", 70);
			}
		}
		// Bravo..Golf: mention counts 6,5,4,3,2,1 (roster order after Alpha), each with one observation of 60 on its first run.
		for (const [index, c] of COMPETITORS.slice(1, 7).entries()) {
			const count = 6 - index;
			for (let j = 1; j <= count; j++) {
				const m = await mention(runId(j), c.id, "competitor", c.name);
				if (j === 1) {
					const { rows } = await client.query<{ id: string }>("SELECT id FROM sentiment_analyses WHERE prompt_run_id = $1", [runId(1)]);
					await observe(rows[0].id, m, runId(1), "competitor", c.id, 60);
				}
			}
		}
		// Inactive competitor mentioned and classified in run 1: must not appear anywhere current.
		const gm = await mention(runId(1), GONE.id, "competitor", GONE.name);
		const { rows: a1 } = await client.query<{ id: string }>("SELECT id FROM sentiment_analyses WHERE prompt_run_id = $1", [runId(1)]);
		await observe(a1[0].id, gm, runId(1), "competitor", GONE.id, 5);
		// Citations on run 1 (Alpha's top answer) only.
		await client.query(
			`INSERT INTO citations (prompt_run_id, prompt_id, brand_id, model, url, domain, title, citation_index, created_at) VALUES
			 ($1, $2, $3, 'chatgpt', 'https://source-one.example.test/a', 'source-one.example.test', 'Source One', 0, NOW()),
			 ($1, $2, $3, 'chatgpt', 'https://source-two.example.test/b', 'source-two.example.test', 'Source Two', 1, NOW())`,
			[runId(1), PROMPTS.plain, BRAND_ID],
		);
		void bravo;
	});

	test.afterAll(async () => {
		try {
			await cleanup(client);
		} finally {
			await client.end();
		}
	});

	test("E2E-SNT-001: sidebar, route, filters — Tags, Lookback, Aspect, Sort; no Search, no model", async ({ page }) => {
		await page.goto(`${BRAND_URL}/share-of-voice`);
		const nav = page.getByRole("link", { name: "Sentiment" }).first();
		await expect(nav).toBeVisible();
		await nav.click();
		await expect(page).toHaveURL(new RegExp(`${PAGE_URL}$`));
		await expect(page.getByRole("heading", { level: 1, name: "Sentiment" })).toBeVisible();
		await expect(page.getByTestId("sentiment-summary")).toBeVisible();

		await expect(page.getByRole("button", { name: /tags/i })).toBeVisible();
		await expect(page.getByRole("button", { name: /last|all time|month|week|year/i }).first()).toBeVisible();
		await expect(page.getByTestId("sentiment-aspect-trigger")).toBeVisible();
		await expect(page.getByTestId("sentiment-sort-trigger")).toBeVisible();
		await expect(page.getByPlaceholder(/search prompts/i)).toHaveCount(0);
		await expect(page.getByRole("button", { name: /all models/i })).toHaveCount(0);
		const text = (await page.locator("main").textContent()) ?? "";
		expect(text).not.toMatch(/openrouter|gpt-5|chatgpt|classifier/i);
	});

	test("E2E-SNT-006 + metrics: rendered values match the SQL oracle", async ({ page }) => {
		const alpha = COMPETITORS[0];
		const oracle = await client.query<{ t: number; m: number; c: number; sum: number; pos: number; neg: number; neutral: number; mixed: number }>(
			`WITH scope AS (SELECT id FROM prompt_runs WHERE brand_id = $1 AND created_at >= (date_trunc('day', now()) - interval '1 month'))
			 SELECT (SELECT count(*)::int FROM scope) AS t,
			        (SELECT count(DISTINCT m.prompt_run_id)::int FROM prompt_run_entity_mentions m WHERE m.entity_key = $2 AND m.detector_version = $3 AND m.prompt_run_id IN (SELECT id FROM scope)) AS m,
			        count(o.*)::int AS c, coalesce(sum(o.score),0)::int AS sum,
			        count(*) FILTER (WHERE o.category='positive')::int AS pos, count(*) FILTER (WHERE o.category='negative')::int AS neg,
			        count(*) FILTER (WHERE o.category='neutral')::int AS neutral, count(*) FILTER (WHERE o.category='mixed')::int AS mixed
			 FROM sentiment_observations o JOIN sentiment_analyses a ON a.id = o.analysis_id
			 WHERE o.entity_key = $2 AND a.classifier_version = $4 AND a.status = 'completed' AND o.prompt_run_id IN (SELECT id FROM scope)`,
			[BRAND_ID, alpha.id, DETECTOR, CLASSIFIER],
		);
		const o = oracle.rows[0];
		expect(o.t).toBe(RUN_COUNT);
		expect(o.m).toBe(28);
		expect(o.c).toBe(24);
		const expectedSentiment = Math.round(o.sum / o.c);
		const expectedMentionVis = Math.round((o.m / o.t) * 100);
		const expectedPosVis = Math.round((o.pos / o.t) * 100);
		const expectedNegVis = Math.round((o.neg / o.t) * 100);

		await page.goto(PAGE_URL);
		const row = page.getByTestId("sentiment-leaderboard-row").filter({ hasText: alpha.name });
		await expect(row).toBeVisible();
		const cells = row.locator("td");
		await expect(cells.nth(3)).toContainText(`${expectedSentiment} · 24 of 28 analyzed mentions`);
		await expect(cells.nth(4)).toHaveText(`${expectedMentionVis}%`);
		await expect(cells.nth(5)).toHaveText(`${expectedPosVis}%`);
		await expect(cells.nth(6)).toHaveText(`${expectedNegVis}%`);
		await expect(cells.nth(8)).toHaveText(`${Math.round((o.c / o.m) * 100)}%`);
		await expect(cells.nth(9)).toHaveText(String(RUN_COUNT));
		await expect(row.getByText("Partial")).toBeVisible();

		// Headline = own brand: flat 70 over 24 analyzed of 30 mentions.
		await expect(page.getByTestId("sentiment-headline")).toHaveText("70");
		await expect(page.getByTestId("sentiment-headline-mentions")).toContainText("24 of 30 analyzed mentions");
		await expect(page.getByTestId("sentiment-headline-meta")).toContainText(`30 mentions · ${RUN_COUNT} evaluated responses`);

		// Legend: brand first with You, then Top-6 by mentions (Alpha 28, Bravo 6, …, Foxtrot 2); Golf (1), Zero and Gone absent.
		const legend = page.getByTestId("sentiment-legend").locator("li");
		await expect(legend).toHaveCount(7);
		await expect(legend.nth(0)).toContainText(BRAND_NAME);
		await expect(legend.nth(0)).toContainText("You");
		await expect(legend.nth(1)).toContainText("Alpha");
		await expect(legend.nth(6)).toContainText("Foxtrot");
		await expect(page.getByTestId("sentiment-legend")).not.toContainText("Golf");
		await expect(page.getByTestId("sentiment-legend")).not.toContainText("Zero");
		await expect(page.locator("main")).not.toContainText("Gone");

		// Zero-mention competitor is still in the leaderboard with a dash and "0 mentions".
		const zero = page.getByTestId("sentiment-leaderboard-row").filter({ hasText: "Zero" });
		await expect(zero.locator("td").nth(3)).toContainText("— · 0 mentions");
		await expect(page.getByTestId("sentiment-coverage-note")).toContainText(/still in progress|failed/);
		// Low-sample cue on a competitor with one classified mention.
		await expect(page.getByTestId("sentiment-leaderboard-row").filter({ hasText: "Golf" }).getByText("Low sample")).toBeVisible();
	});

	test("E2E-SNT-002: aspect and sort persist in the URL; stale q/model parameters change nothing", async ({ page }) => {
		await page.goto(PAGE_URL);
		await expect(page.getByTestId("sentiment-leaderboard")).toBeVisible();
		await page.getByTestId("sentiment-sort-trigger").click();
		await page.getByRole("menuitemradio", { name: "Brand A–Z" }).click();
		await expect(page).toHaveURL(/sort=name/);
		const names = await page.getByTestId("sentiment-leaderboard-row").locator("td:nth-child(3)").allInnerTexts();
		const cleaned = names.map((n) => n.replace(/\s*You\s*$/, "").trim());
		expect(cleaned).toEqual([...cleaned].sort((a, b) => a.localeCompare(b, "en", { sensitivity: "base" })));

		await page.getByTestId("sentiment-aspect-trigger").click();
		await page.getByRole("menuitemradio", { name: "Price" }).click();
		await expect(page).toHaveURL(/aspect=price/);
		await expect(page).toHaveURL(/sort=name/);
		// Alpha under Price: 6 aspect rows (3 × 80, 3 × 30) → 55 over a 6-answer Price sample; Price Mention Visibility 6/30 = 20 %,
		// Positive 3/30 = 10 %, Negative 10 %; classifier coverage stays 24/28 = 86 % and the Partial cue reflects only that.
		const alphaRow = page.getByTestId("sentiment-leaderboard-row").filter({ hasText: "Alpha" });
		await expect(alphaRow.locator("td").nth(3)).toContainText("55 · 6 Price mentions");
		await expect(alphaRow.locator("td").nth(4)).toHaveText("20%");
		await expect(alphaRow.locator("td").nth(5)).toHaveText("10%");
		await expect(alphaRow.locator("td").nth(6)).toHaveText("10%");
		await expect(alphaRow.locator("td").nth(8)).toHaveText("86%");
		await expect(page.getByText("Price Mention Visibility")).toBeVisible();
		await expect(page.getByTestId("sentiment-headline-mentions")).toContainText("0 Price mentions");
		await expect(page.getByTestId("sentiment-headline")).toHaveText("—");
		// Bravo is classified (1 of 6) but never evaluated on Price: an empty sample, not a partial classification.
		const bravoRow = page.getByTestId("sentiment-leaderboard-row").filter({ hasText: "Bravo" });
		await expect(bravoRow.locator("td").nth(3)).toContainText("— · 0 Price mentions");
		await expect(page.getByTestId("sentiment-legend").locator("li").nth(0)).toContainText("— · 0 Price");

		const payloads: string[] = [];
		page.on("request", (request) => {
			if (request.url().includes("/_serverFn/")) payloads.push(request.url() + (request.postData() ?? ""));
		});
		await page.goto(`${PAGE_URL}?aspect=price&sort=name&q=stale-search&model=chatgpt`);
		await expect(alphaRow.locator("td").nth(3)).toContainText("55 · 6 Price mentions");
		await expect(page).toHaveURL(/aspect=price/);
		expect(payloads.length).toBeGreaterThan(0);
		expect(payloads.join("\n")).not.toMatch(/stale-search/);
		expect(payloads.filter((p) => /aspect/.test(p)).join("\n")).not.toMatch(/chatgpt/);
	});

	test("E2E-SNT-003: a row expands lazily to 10/10 non-overlapping evidence with sources and a working deep link", async ({ page }) => {
		const evidenceRequests: string[] = [];
		page.on("request", (request) => {
			if (request.url().includes("/_serverFn/") && /entityKey/.test(decodeURIComponent(request.url()))) evidenceRequests.push(request.url());
		});
		await page.goto(PAGE_URL);
		await expect(page.getByTestId("sentiment-leaderboard")).toBeVisible();
		expect(evidenceRequests).toHaveLength(0);

		const alphaRow = page.getByTestId("sentiment-leaderboard-row").filter({ hasText: "Alpha" });
		await alphaRow.click();
		await expect(alphaRow).toHaveAttribute("aria-expanded", "true");
		const evidence = page.getByTestId("sentiment-evidence");
		await expect(evidence).toBeVisible();
		await expect.poll(() => evidenceRequests.length).toBe(1);
		await expect(evidence).toHaveAttribute("data-total", "24");
		const highest = page.getByTestId("sentiment-evidence-highest").getByTestId("sentiment-evidence-item");
		const lowest = page.getByTestId("sentiment-evidence-lowest").getByTestId("sentiment-evidence-item");
		await expect(highest).toHaveCount(10);
		await expect(lowest).toHaveCount(10);
		const highRuns = await highest.evaluateAll((els) => els.map((el) => el.getAttribute("data-run")));
		const lowRuns = await lowest.evaluateAll((els) => els.map((el) => el.getAttribute("data-run")));
		expect(new Set([...highRuns, ...lowRuns]).size).toBe(20);
		await expect(highest.first()).toContainText("100");
		await expect(highest.first()).toContainText("Positive");
		await expect(lowest.first()).toContainText("10");
		await expect(lowest.first()).toContainText("Negative");
		await expect(highest.first().locator("mark").first()).toContainText(/solid tariff/);
		await expect(highest.first().getByTestId("sentiment-evidence-sources")).toContainText("source-one.example.test");
		await expect(lowest.first().getByTestId("sentiment-evidence-sources")).toContainText("No cited sources");
		await expect(evidence).not.toContainText(/openrouter|gpt|chatgpt/i);

		// Only one row open at a time; keyboard toggles.
		const bravoRow = page.getByTestId("sentiment-leaderboard-row").filter({ hasText: "Bravo" });
		await bravoRow.focus();
		await page.keyboard.press("Enter");
		await expect(bravoRow).toHaveAttribute("aria-expanded", "true");
		await expect(alphaRow).toHaveAttribute("aria-expanded", "false");
		await expect(page.getByTestId("sentiment-expanded")).toHaveCount(1);
		await page.keyboard.press("Space");
		await expect(bravoRow).toHaveAttribute("aria-expanded", "false");

		// Deep link opens the exact stored response, highlighted and pinned.
		await alphaRow.click();
		const link = highest.first().getByTestId("sentiment-evidence-deep-link");
		const href = (await link.getAttribute("href")) ?? "";
		expect(href).toMatch(/tab=responses/);
		expect(href).toMatch(new RegExp(`run=${runId(1)}`));
		await link.click();
		await expect(page).toHaveURL(/tab=responses/);
		const focused = page.getByTestId("focused-run");
		await expect(focused).toBeVisible();
		await expect(focused).toHaveAttribute("data-run-id", runId(1));
		await expect(focused).toContainText("Linked response");
		await expect(focused).toContainText("Synthetic answer 1.");
	});

	test("B7: the highlighted excerpt is the exact stored span, not a text search", async ({ page }) => {
		await page.goto(PAGE_URL);
		await page.getByTestId("sentiment-leaderboard-row").filter({ hasText: "Alpha" }).click();
		const first = page.getByTestId("sentiment-evidence-highest").getByTestId("sentiment-evidence-item").first();
		await expect(first.locator("mark")).toHaveCount(1);
		await expect(first.locator("mark")).toHaveText("Alpha delivers a solid tariff");
		// The excerpt around the span is the stored answer, cut at raw offsets.
		await expect(first.getByTestId("sentiment-evidence-excerpt")).toContainText("Alpha delivers a solid tariff while Sentiment E2E keeps growing");
	});

	test("B6: deleting a prompt through the real API removes its runs and every sentiment row", async ({ request }) => {
		const promptId = uuid("2", 9);
		const run = uuid("3", 99);
		await client.query(
			`INSERT INTO prompts (id, brand_id, value, enabled, tags, system_tags, created_at, updated_at)
			 VALUES ($1, $2, 'Prompt to delete', true, '{}', '{unbranded}', NOW(), NOW())`,
			[promptId, BRAND_ID],
		);
		await client.query(
			`INSERT INTO prompt_runs (id, prompt_id, brand_id, model, provider, version, web_search_enabled, raw_output, web_queries, brand_mentioned, competitors_mentioned, created_at)
			 VALUES ($1, $2, $3, 'chatgpt', 'openrouter', 'e2e', true, $4, '{}', true, '{}', NOW())`,
			[run, promptId, BRAND_ID, JSON.stringify({ choices: [{ message: { content: answerFor(99) } }] })],
		);
		await client.query(
			`INSERT INTO citations (prompt_run_id, prompt_id, brand_id, model, url, domain, title, citation_index, created_at)
			 VALUES ($1, $2, $3, 'chatgpt', 'https://source-del.example.test/', 'source-del.example.test', 'Del', 0, NOW())`,
			[run, promptId, BRAND_ID],
		);
		await client.query(
			`INSERT INTO sentiment_detections (prompt_run_id, brand_id, detector_version, status, mention_count) VALUES ($1, $2, $3, 'mentions', 1)`,
			[run, BRAND_ID, DETECTOR],
		);
		const alpha = COMPETITORS[0];
		const { rows: m } = await client.query<{ id: string }>(
			`INSERT INTO prompt_run_entity_mentions (prompt_run_id, brand_id, entity_type, competitor_id, entity_key, entity_name, detector_version)
			 VALUES ($1, $2, 'competitor', $3::uuid, $3::text, $4, $5) RETURNING id`,
			[run, BRAND_ID, alpha.id, alpha.name, DETECTOR],
		);
		const { rows: a } = await client.query<{ id: string }>(
			`INSERT INTO sentiment_analyses (prompt_run_id, brand_id, classifier_version, taxonomy_version, status, completed_at)
			 VALUES ($1, $2, $3, $4, 'completed', NOW()) RETURNING id`,
			[run, BRAND_ID, CLASSIFIER, TAXONOMY],
		);
		const { rows: o } = await client.query<{ id: string }>(
			`INSERT INTO sentiment_observations (analysis_id, mention_id, prompt_run_id, brand_id, entity_type, competitor_id, entity_key, score, category, confidence, evidence)
			 VALUES ($1, $2, $3, $4, 'competitor', $5::uuid, $5::text, 80, 'positive', 0.9, $6::jsonb) RETURNING id`,
			[a[0].id, m[0].id, run, BRAND_ID, alpha.id, JSON.stringify([evidenceSpan(run, "solid tariff", "positive")])],
		);
		await client.query(
			`INSERT INTO sentiment_aspect_observations (observation_id, taxonomy_version, aspect_key, aspect_label, score, category, confidence, evidence)
			 VALUES ($1, $2, 'price', 'Price', 80, 'positive', 0.8, '[]'::jsonb)`,
			[o[0].id, TAXONOMY],
		);

		const response = await request.delete(`/api/v1/prompts/${promptId}`, { headers: { Authorization: `Bearer ${TEST_API_KEY}` } });
		expect(response.status()).toBe(200);
		const body = (await response.json()) as { id: string; deletedRunsCount: number };
		expect(body.id).toBe(promptId);
		expect(body.deletedRunsCount).toBe(1);

		const { rows } = await client.query<{ n: string }>(
			`SELECT (SELECT count(*) FROM prompt_runs WHERE id = $1)
			      + (SELECT count(*) FROM sentiment_detections WHERE prompt_run_id = $1)
			      + (SELECT count(*) FROM prompt_run_entity_mentions WHERE prompt_run_id = $1)
			      + (SELECT count(*) FROM sentiment_analyses WHERE prompt_run_id = $1)
			      + (SELECT count(*) FROM sentiment_observations WHERE prompt_run_id = $1)
			      + (SELECT count(*) FROM sentiment_aspect_observations WHERE observation_id = $2)
			      + (SELECT count(*) FROM citations WHERE prompt_run_id = $1) AS n`,
			[run, o[0].id],
		);
		expect(Number(rows[0].n)).toBe(0);
		// The rest of the seeded graph is untouched.
		const { rows: remaining } = await client.query<{ n: number }>("SELECT count(*)::int AS n FROM sentiment_observations WHERE brand_id = $1", [BRAND_ID]);
		expect(remaining[0].n).toBeGreaterThan(20);
	});

	test("deep link rejects a run that belongs to another prompt", async ({ page }) => {
		await page.goto(`${BRAND_URL}/prompts/${PROMPTS.tagged}?tab=responses&run=${runId(1)}`);
		await expect(page.getByTestId("focused-run-missing")).toBeVisible();
		await expect(page.getByTestId("focused-run")).toHaveCount(0);
	});

	test("E2E-SNT-004: 375/768/1280/1400, dark mode, focus and tooltip containment without overflow", async ({ page }) => {
		for (const width of [375, 768, 1280, 1400]) {
			await page.setViewportSize({ width, height: width < 768 ? 900 : 1000 });
			await page.goto(PAGE_URL);
			await expect(page.getByTestId("sentiment-summary")).toBeVisible();
			await expect(page.getByTestId("sentiment-leaderboard")).toBeVisible();
			await page.getByTestId("sentiment-leaderboard-row").filter({ hasText: "Alpha" }).click();
			await expect(page.getByTestId("sentiment-evidence")).toBeVisible();
			const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
			expect(overflow, `page overflow at ${width}px`).toBeLessThanOrEqual(0);
			if (process.env.SENT01_SCREENSHOT_DIR) await page.screenshot({ path: `${process.env.SENT01_SCREENSHOT_DIR}/sentiment-${width}.png`, fullPage: true });
		}
		await page.setViewportSize({ width: 1400, height: 1000 });
		await page.goto(PAGE_URL);
		await page.evaluate(() => document.documentElement.classList.add("dark"));
		await expect(page.getByTestId("sentiment-summary")).toBeVisible();
		if (process.env.SENT01_SCREENSHOT_DIR) await page.screenshot({ path: `${process.env.SENT01_SCREENSHOT_DIR}/sentiment-1400-dark.png`, fullPage: true });
		await page.evaluate(() => document.documentElement.classList.remove("dark"));

		// Trend tooltip at first, middle and last point stays inside the viewport.
		const trend = page.getByTestId("sentiment-trend");
		// Centre the plot: a minimal scroll can leave its top grid line under the sticky header.
		await trend.evaluate((el) => el.scrollIntoView({ block: "center" }));
		const box = (await trend.locator("svg.recharts-surface").boundingBox()) as { x: number; y: number };
		const lines = await trend
			.locator(".recharts-cartesian-grid-horizontal line")
			.evaluateAll((els) =>
				els.map((el) => ({ x1: Number(el.getAttribute("x1")), x2: Number(el.getAttribute("x2")), y: Number(el.getAttribute("y1")) })),
			);
		const x1 = lines[0].x1;
		const x2 = lines[0].x2;
		const top = Math.min(...lines.map((l) => l.y));
		for (const fraction of [0.02, 0.5, 0.98]) {
			await page.mouse.move(box.x + x1 + (x2 - x1) * fraction, box.y + top + 3);
			const tooltip = page.getByTestId("sentiment-trend-tooltip");
			await expect(tooltip).toBeVisible();
			const tb = (await tooltip.boundingBox()) as { x: number; width: number };
			const vw = await page.evaluate(() => window.innerWidth);
			expect(tb.x).toBeGreaterThanOrEqual(0);
			expect(tb.x + tb.width).toBeLessThanOrEqual(vw + 1);
			await expect(tooltip).toContainText("analyzed");
		}
		// Legend toggles are keyboard-reachable buttons with pressed state.
		const legendButton = page.getByTestId("sentiment-trend-legend").getByRole("button").first();
		await legendButton.focus();
		await expect(legendButton).toBeFocused();
		await expect(legendButton).toHaveAttribute("aria-pressed", "true");
		await page.keyboard.press("Enter");
		await expect(legendButton).toHaveAttribute("aria-pressed", "false");
	});

	test("E2E-SNT-005: adjacent pages still open with the same roster", async ({ page }) => {
		for (const [path, heading] of [
			["/visibility", /visibility/i],
			["/share-of-voice", /share of voice/i],
			["/citations", /citation/i],
		] as const) {
			await page.goto(`${BRAND_URL}${path}`);
			await expect(page.getByRole("heading", { name: heading }).first()).toBeVisible();
			await expect(page.locator("main")).not.toContainText("Gone");
		}
	});
});

async function cleanup(client: pg.Client) {
	await client.query(`DELETE FROM sentiment_aspect_observations WHERE observation_id IN (SELECT id FROM sentiment_observations WHERE brand_id = $1)`, [BRAND_ID]);
	await client.query("DELETE FROM sentiment_observations WHERE brand_id = $1", [BRAND_ID]);
	await client.query("DELETE FROM sentiment_analyses WHERE brand_id = $1", [BRAND_ID]);
	await client.query("DELETE FROM prompt_run_entity_mentions WHERE brand_id = $1", [BRAND_ID]);
	await client.query("DELETE FROM sentiment_detections WHERE brand_id = $1", [BRAND_ID]);
	await client.query("DELETE FROM citations WHERE brand_id = $1", [BRAND_ID]);
	await client.query("DELETE FROM prompt_runs WHERE brand_id = $1", [BRAND_ID]);
	await client.query("DELETE FROM pgboss.job WHERE name = 'process-prompt' AND data->>'promptId' = ANY($1::text[])", [Object.values(PROMPTS)]).catch(() => undefined);
	await client.query("DELETE FROM prompts WHERE brand_id = $1", [BRAND_ID]);
	await client.query("DELETE FROM competitors WHERE brand_id = $1", [BRAND_ID]);
	await client.query("DELETE FROM brands WHERE id = $1", [BRAND_ID]);
}
