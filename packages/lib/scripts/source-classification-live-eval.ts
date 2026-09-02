#!/usr/bin/env tsx
/**
 * F-05 live acceptance gate (F05-LIVE-AT-001): run the REAL source classifier
 * once per explicitly listed hostname and compare against the expected
 * category. This is a manual, paid, bounded evaluation — never wired into CI.
 *
 * Guarantees, by construction:
 *   - requires the unmistakable `--live` opt-in flag or it refuses to run;
 *   - input is an explicit fixed list of `hostname=expectedCategory` pairs;
 *   - hard cap of MAX_LIVE_INVOCATIONS hostnames per run;
 *   - exactly ONE top-level classifier invocation per hostname — no retry,
 *     no majority vote, no loop-until-expected;
 *   - calls the production classifier boundary (`classifySourceHostname`)
 *     with the real provider — no fake, no fixture mapping, no pre-seeded
 *     cache;
 *   - performs no database or queue write: it never imports the cache store
 *     or pg-boss (this package has no queue dependency at all), and the
 *     built-in domain-level category is computed locally.
 *
 * Usage (hostnames and expectations come only from the command line — none are
 * embedded here, so the harness generalizes to any evaluation set):
 *   pnpm --filter @workspace/lib eval:source-classification -- --live \
 *     some-hostname.example=institutional another-hostname.example=editorial
 *
 * Reads `<repo>/apps/web/.env` and `<repo>/.env` automatically; --env-file
 * PATH overrides. Real env vars always win over .env entries.
 */
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { categorizeDomain } from "../src/citations/domain-categories.server";
import { classifySourceHostname } from "../src/source-classification/classifier";
import { normalizeSourceHostname } from "../src/source-classification/hostname";
import {
	SOURCE_CLASSIFICATION_CATEGORIES,
	SOURCE_CLASSIFICATION_LIVE_MAX_INVOCATIONS,
	SOURCE_CLASSIFIER_VERSION,
	type SourceClassificationCategory,
} from "../src/source-classification/types";

const MAX_LIVE_INVOCATIONS = SOURCE_CLASSIFICATION_LIVE_MAX_INVOCATIONS;

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
	for (const line of contents.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		const eq = trimmed.indexOf("=");
		if (eq < 0) continue;
		const key = trimmed.slice(0, eq).trim();
		let value = trimmed.slice(eq + 1).trim();
		if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
			value = value.slice(1, -1);
		}
		if (process.env[key] === undefined) process.env[key] = value;
	}
}

interface Expectation {
	hostname: string;
	expected: SourceClassificationCategory;
}

function parseExpectations(positionals: string[]): Expectation[] {
	const expectations: Expectation[] = [];
	const seen = new Set<string>();
	for (const arg of positionals) {
		const eq = arg.indexOf("=");
		if (eq < 0) throw new Error(`Expected "hostname=expectedCategory", got "${arg}"`);
		const rawHostname = arg.slice(0, eq).trim();
		const expected = arg.slice(eq + 1).trim() as SourceClassificationCategory;
		const hostname = normalizeSourceHostname(rawHostname);
		if (!hostname) throw new Error(`Invalid hostname "${rawHostname}"`);
		if (!SOURCE_CLASSIFICATION_CATEGORIES.includes(expected)) {
			throw new Error(`Invalid expected category "${expected}" for "${hostname}"`);
		}
		if (seen.has(hostname)) throw new Error(`Duplicate hostname "${hostname}"`);
		seen.add(hostname);
		expectations.push({ hostname, expected });
	}
	return expectations;
}

/** Exactly ONE top-level classifier invocation; an error is a FAIL, never a retry. */
async function evaluateHostnameOnce(
	hostname: string,
	expected: SourceClassificationCategory,
): Promise<Record<string, unknown> & { status: "PASS" | "FAIL" }> {
	try {
		const classification = await classifySourceHostname({
			hostname,
			classifierVersion: SOURCE_CLASSIFIER_VERSION,
			builtInCategory: "other",
		});
		const pass = classification.category === expected;
		console.log(
			`${pass ? "PASS" : "FAIL"} ${hostname}: actual="${classification.category}" expected="${expected}" ` +
				`confidence=${classification.confidence} provider=${classification.provider} model=${classification.model ?? "unknown"}`,
		);
		console.log(`     reason: ${classification.reason}`);
		return {
			hostname,
			expected,
			actual: classification.category,
			confidence: classification.confidence,
			reason: classification.reason,
			provider: classification.provider,
			model: classification.model,
			classifierVersion: classification.classifierVersion,
			status: pass ? "PASS" : "FAIL",
		};
	} catch (error) {
		const message = (error instanceof Error ? error.message : String(error)).slice(0, 500);
		console.log(`FAIL ${hostname}: classifier error (not retried): ${message}`);
		return { hostname, expected, status: "FAIL", error: message };
	}
}

async function main(): Promise<void> {
	const { values, positionals } = parseArgs({
		options: {
			live: { type: "boolean", default: false },
			"env-file": { type: "string" },
		},
		allowPositionals: true,
	});

	if (values["env-file"]) {
		await loadDotEnv(resolveHomePath(values["env-file"]));
	} else {
		const repoRoot = join(import.meta.dirname ?? __dirname, "..", "..", "..");
		await loadDotEnv(join(repoRoot, "apps", "web", ".env"));
		await loadDotEnv(join(repoRoot, ".env"));
	}

	if (!values.live) {
		console.error(
			"Refusing to run: this command makes PAID live LLM calls. Re-run with --live and an explicit hostname=expectedCategory list.",
		);
		process.exit(2);
	}

	const expectations = parseExpectations(positionals);
	if (expectations.length === 0) {
		console.error("No hostnames given. Pass an explicit list of hostname=expectedCategory pairs.");
		process.exit(2);
	}
	if (expectations.length > MAX_LIVE_INVOCATIONS) {
		console.error(
			`Refusing to run: ${expectations.length} hostnames exceed the hard cap of ${MAX_LIVE_INVOCATIONS} live invocations per run.`,
		);
		process.exit(2);
	}

	console.log(`F-05 live acceptance gate — classifier version ${SOURCE_CLASSIFIER_VERSION}`);
	console.log(`Hostnames: ${expectations.length} (one top-level classifier invocation each, no retry)\n`);

	let invocations = 0;
	let failures = 0;
	const results: Record<string, unknown>[] = [];

	for (const { hostname, expected } of expectations) {
		const builtIn = categorizeDomain(hostname, new Set(), new Set());
		if (builtIn !== "other") {
			failures++;
			results.push({ hostname, expected, status: "FAIL", error: `built-in domain-level category is "${builtIn}"` });
			console.log(`FAIL ${hostname}: built-in category is "${builtIn}", not eligible for F-05 (no LLM call made)`);
			continue;
		}

		invocations++;
		const result = await evaluateHostnameOnce(hostname, expected);
		if (result.status === "FAIL") failures++;
		results.push(result);
	}

	console.log(`\nSummary: ${expectations.length - failures}/${expectations.length} passed`);
	console.log(`Top-level classifier invocations: ${invocations} (cap ${MAX_LIVE_INVOCATIONS}, no harness retry)`);
	console.log(`No database or queue writes were performed (none are reachable from this command).`);
	console.log(JSON.stringify({ classifierVersion: SOURCE_CLASSIFIER_VERSION, invocations, results }, null, 2));

	process.exit(failures > 0 ? 1 : 0);
}

main().catch((error) => {
	console.error(error);
	process.exit(2);
});
