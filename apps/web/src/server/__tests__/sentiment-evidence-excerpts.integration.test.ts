/**
 * Runs against the disposable test database (`DATABASE_URL`). The evidence
 * loader must hand the client enough of the stored answer to show every
 * cited span in full: one observation with three anchors far apart — the
 * live production shape — and every highlight must equal the raw slice.
 */
import pg from "pg";
import { createElement, Fragment } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LONG_ANSWER, THREE_DISTANT_SPANS } from "@/components/sentiment/__tests__/evidence-fixture";
import { highlightExcerpt } from "@/components/sentiment/excerpt-highlight";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must point at the seeded test stack");

const { SENTIMENT_CLASSIFIER_VERSION, SENTIMENT_DETECTOR_VERSION, SENTIMENT_TAXONOMY_VERSION } = await import(
	"@workspace/lib/sentiment"
);
const { loadSentimentEvidence } = await import("@/server/sentiment-load");

const ORG = "default";
const BRAND = "sent-excerpt-brand";
const A = "5e970010-0000-4000-8000-00000000000a";
const PROMPT = "5e970010-0000-4000-8000-000000000101";
const RUN = "5e970010-0000-4000-8000-000000000201";
const client = new pg.Client({ connectionString: DATABASE_URL });

async function cleanup() {
	await client.query(
		`DELETE FROM sentiment_aspect_observations WHERE observation_id IN (SELECT id FROM sentiment_observations WHERE brand_id = $1)`,
		[BRAND],
	);
	for (const table of [
		"sentiment_observations",
		"sentiment_analyses",
		"prompt_run_entity_mentions",
		"sentiment_detections",
		"citations",
		"prompt_runs",
		"prompts",
		"competitors",
	]) {
		await client.query(`DELETE FROM ${table} WHERE brand_id = $1`, [BRAND]);
	}
	await client.query("DELETE FROM brands WHERE id = $1", [BRAND]);
}

beforeAll(async () => {
	const host = new URL(DATABASE_URL).hostname;
	if (!["localhost", "127.0.0.1", "::1"].includes(host)) throw new Error(`refusing non-loopback database ${host}`);
	await client.connect();
	const org = await client.query("SELECT id FROM organization WHERE slug = $1", [ORG]);
	if (org.rows.length !== 1) throw new Error("seeded organization missing — not the disposable test database");
	await cleanup();
	await client.query(
		`INSERT INTO brands (id, organization_id, slug, name, website, enabled, onboarded, created_at, updated_at)
		 VALUES ($1, $2, $1, 'Sent Excerpt', 'https://sent-excerpt.example.test/', true, true, now(), now())`,
		[BRAND, org.rows[0].id],
	);
	await client.query(
		`INSERT INTO competitors (id, brand_id, name, domains, active, removed_at, created_at, updated_at)
		 VALUES ($1, $2, 'Arvo', '{arvo.example.test}', true, NULL, now(), now())`,
		[A, BRAND],
	);
	await client.query(
		`INSERT INTO prompts (id, brand_id, value, enabled, tags, system_tags, created_at, updated_at)
		 VALUES ($1, $2, 'Excerpt prompt', false, '{}', '{unbranded}', now(), now())`,
		[PROMPT, BRAND],
	);
	await client.query(
		`INSERT INTO prompt_runs (id, prompt_id, brand_id, model, provider, version, web_search_enabled, raw_output, brand_mentioned, competitors_mentioned, created_at)
		 VALUES ($1, $2, $3, 'chatgpt', 'openrouter', 'v', true, $4, true, '{}', now() - interval '2 days')`,
		[RUN, PROMPT, BRAND, JSON.stringify({ choices: [{ message: { content: LONG_ANSWER } }] })],
	);
	await client.query(
		`INSERT INTO sentiment_detections (prompt_run_id, brand_id, detector_version, status, mention_count) VALUES ($1, $2, $3, 'mentions', 1)`,
		[RUN, BRAND, SENTIMENT_DETECTOR_VERSION],
	);
	const mention = (
		await client.query<{ id: string }>(
			`INSERT INTO prompt_run_entity_mentions (prompt_run_id, brand_id, entity_type, competitor_id, entity_key, entity_name, detector_version)
			 VALUES ($1, $2, 'competitor', $3::uuid, $3::text, 'Arvo', $4) RETURNING id`,
			[RUN, BRAND, A, SENTIMENT_DETECTOR_VERSION],
		)
	).rows[0].id;
	const analysis = (
		await client.query<{ id: string }>(
			`INSERT INTO sentiment_analyses (prompt_run_id, brand_id, classifier_version, taxonomy_version, status, completed_at)
			 VALUES ($1, $2, $3, $4, 'completed', now()) RETURNING id`,
			[RUN, BRAND, SENTIMENT_CLASSIFIER_VERSION, SENTIMENT_TAXONOMY_VERSION],
		)
	).rows[0].id;
	await client.query(
		`INSERT INTO sentiment_observations (analysis_id, mention_id, prompt_run_id, brand_id, entity_type, competitor_id, entity_key, score, category, confidence, evidence)
		 VALUES ($1, $2, $3, $4, 'competitor', $5::uuid, $5::text, 50, 'mixed', 0.9, $6::jsonb)`,
		[analysis, mention, RUN, BRAND, A, JSON.stringify(THREE_DISTANT_SPANS)],
	);
});

afterAll(async () => {
	await cleanup();
	await client.end();
});

const marksOf = (html: string) =>
	[...html.matchAll(/<mark[^>]*>([\s\S]*?)<\/mark>/g)].map((m) =>
		m[1]
			.replace(/&quot;/g, '"')
			.replace(/&#x27;/g, "'")
			.replace(/&amp;/g, "&")
			.replace(/&lt;/g, "<")
			.replace(/&gt;/g, ">"),
	);

describe("IT-SNT-EXC-001 evidence loader exposes every cited span in full", () => {
	it("three distant anchors of one stored answer are all highlighted as exact raw slices", async () => {
		const evidence = await loadSentimentEvidence({
			brandId: BRAND,
			lookback: "1m",
			aspect: "overall",
			timezone: "UTC",
			entityKey: A,
			limit: 10,
		});
		expect(evidence.totalObservations).toBe(1);
		const item = evidence.highest[0];
		expect(item.evidence).toHaveLength(3);
		const marks = item.excerpts.flatMap((group) =>
			marksOf(renderToStaticMarkup(createElement(Fragment, null, ...highlightExcerpt(group)))),
		);
		for (const span of THREE_DISTANT_SPANS) {
			expect(marks, `span ${span.start}-${span.end} must be rendered in full`).toContain(
				LONG_ANSWER.slice(span.start, span.end),
			);
		}
		expect(marks).toHaveLength(3);
		// Three distant anchors → three separate groups, each an exact raw slice, and never the whole answer.
		expect(item.excerpts).toHaveLength(3);
		for (const group of item.excerpts) expect(group.text).toBe(LONG_ANSWER.slice(group.excerptStart, group.excerptEnd));
		expect(item.excerpts.reduce((n, g) => n + g.text.length, 0)).toBeLessThan(LONG_ANSWER.length);
	});
});
