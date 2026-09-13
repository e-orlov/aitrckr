#!/usr/bin/env tsx
/**
 * SENT-01 golden-set live evaluation (GOLD-SNT-001 live gate): run the REAL
 * sentiment classifier once per selected synthetic case and score it against
 * the hand labels. Manual, paid and bounded — never wired into CI.
 *
 * Guarantees, by construction:
 *   - refuses to run without the unmistakable `--live` flag;
 *   - hard cap of MAX_LIVE_CASES cases per run (default 5), selected by id or
 *     as the first N cases of the corpus;
 *   - exactly ONE classifier invocation per case — no retry, no re-ask;
 *   - calls the production boundary (`classifySentiment`) with the shared
 *     research provider — no fake provider, no fixture short-circuit;
 *   - performs no database or queue write and reads no production answer.
 *
 * Usage:
 *   pnpm --filter @workspace/lib eval:sentiment-golden -- --live --max 3
 *   pnpm --filter @workspace/lib eval:sentiment-golden -- --live g05-not-expensive-de g07-comparison-en
 *
 * Reads `<repo>/apps/web/.env` and `<repo>/.env` automatically; --env-file
 * PATH overrides. Real env vars always win over .env entries.
 */
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { classifySentiment } from "../src/sentiment/classifier";
import { GOLDEN_CASES } from "../src/sentiment/golden/corpus";
import { goldenGatesPass, scoreGoldenCase, summarizeGolden } from "../src/sentiment/golden/evaluate";
import { SENTIMENT_CLASSIFIER_VERSION } from "../src/sentiment/types";

const MAX_LIVE_CASES = 10;

function resolveHomePath(p: string): string {
	if (p === "~") return homedir();
	if (p.startsWith("~/")) return resolve(homedir(), p.slice(2));
	return resolve(p);
}

async function loadDotEnv(path: string): Promise<void> {
	let contents: string;
	try {
		contents = await readFile(path, "utf8");
	} catch {
		return;
	}
	for (const line of contents.split(/\r?\n/)) {
		const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
		if (!match) continue;
		const [, key, raw] = match;
		if (process.env[key] !== undefined) continue;
		process.env[key] = raw.replace(/^["']|["']$/g, "");
	}
}

async function main(): Promise<void> {
	const { values, positionals } = parseArgs({
		allowPositionals: true,
		options: {
			live: { type: "boolean", default: false },
			max: { type: "string" },
			"env-file": { type: "string" },
		},
	});
	if (!values.live) {
		console.error("Refusing to run without --live: this evaluation makes paid provider calls.");
		process.exit(2);
	}
	const repoRoot = resolve(import.meta.dirname, "../../..");
	if (values["env-file"]) await loadDotEnv(resolveHomePath(values["env-file"]));
	else {
		await loadDotEnv(join(repoRoot, "apps/web/.env"));
		await loadDotEnv(join(repoRoot, ".env"));
	}

	const max = Math.min(MAX_LIVE_CASES, Math.max(1, Number.parseInt(values.max ?? "5", 10) || 5));
	const selected =
		positionals.length > 0
			? positionals.map((id) => {
					const found = GOLDEN_CASES.find((c) => c.id === id);
					if (!found) throw new Error(`unknown golden case "${id}"`);
					return found;
				})
			: GOLDEN_CASES.slice(0, max);
	if (selected.length > MAX_LIVE_CASES) {
		console.error(
			`Refusing ${selected.length} cases: the hard cap is ${MAX_LIVE_CASES} classifier invocations per run.`,
		);
		process.exit(2);
	}

	console.log(
		`Sentiment golden live eval — classifier ${SENTIMENT_CLASSIFIER_VERSION}, ${selected.length} case(s), one call each`,
	);
	const scores = [];
	for (const goldenCase of selected) {
		const started = Date.now();
		try {
			const result = await classifySentiment({ answerBody: goldenCase.answer, candidates: goldenCase.candidates });
			const score = scoreGoldenCase(goldenCase, result.entities);
			scores.push(score);
			console.log(
				`${goldenCase.id}: provider=${result.provider} model=${result.model ?? "?"} ${Date.now() - started}ms ` +
					`category ${score.categoryMatches}/${score.categoryTotal}, aspects ${score.aspectMatches}/${score.aspectTotal}` +
					(score.failures.length ? `\n  ${score.failures.join("\n  ")}` : ""),
			);
		} catch (error) {
			scores.push(scoreGoldenCase(goldenCase, null));
			console.log(`${goldenCase.id}: INVALID — ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	const summary = summarizeGolden(scores);
	console.log(JSON.stringify({ ...summary, gatesPass: goldenGatesPass(summary) }, null, 2));
	process.exit(goldenGatesPass(summary) ? 0 : 1);
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
