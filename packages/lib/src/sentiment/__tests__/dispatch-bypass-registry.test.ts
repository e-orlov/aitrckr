import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../..");
const SKIP = new Set(["node_modules", "dist", "build", "coverage", "__tests__"]);

function* sources(dir: string): Generator<string> {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (entry.name.startsWith(".") || SKIP.has(entry.name)) continue;
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) yield* sources(full);
		else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) yield full;
	}
}
const rel = (abs: string) => path.relative(repoRoot, abs).split(path.sep).join("/");
const filesMatching = (roots: string[], pattern: RegExp) => {
	const found: string[] = [];
	for (const root of roots) {
		for (const file of sources(path.join(repoRoot, root))) {
			if (pattern.test(readFileSync(file, "utf8"))) found.push(rel(file));
		}
	}
	return found.sort();
};

/**
 * Every path a future change could use to reach the sentiment provider or the
 * sentiment queue without passing the dispatch controls. A new match fails
 * this file until it is either routed through the controls or registered
 * here with a reason.
 */
describe("dispatch controls cannot be bypassed by construction", () => {
	it("only the locked resolver obtains the sentiment provider; every workflow request goes through the guarded provider", () => {
		expect(filesMatching(["packages/lib/src/sentiment"], /\bgetProvider\(/)).toEqual([
			"packages/lib/src/sentiment/provider.ts",
		]);
		expect(filesMatching(["packages/lib/src/sentiment"], /\.runStructuredResearch\(/)).toEqual([
			// the classify request (provider handed in by the workflow) and the repair/verify request plus the guard itself
			"packages/lib/src/sentiment/classifier.ts",
			"packages/lib/src/sentiment/job.ts",
		]);
	});

	it("classify-sentiment jobs are created only through sendSentimentJob (plus the loopback verification script)", () => {
		// Every pg-boss send flavour, positional or object form, plus direct job-table insertion.
		const queueName = String.raw`(?:SENTIMENT_QUEUE\b|"classify-sentiment"|'classify-sentiment')`;
		const positionalSend = new RegExp(
			String.raw`\.(?:send|sendAfter|sendThrottled|sendDebounced|sendSingleton)\(\s*${queueName}`,
		);
		const objectSend = new RegExp(String.raw`\bname:\s*${queueName}`);
		const rawInsert = /insert\s+into\s+pgboss\.job\b/i;
		expect(filesMatching(["apps", "packages"], positionalSend)).toEqual([
			"apps/worker/scripts/verify-sentiment-db.ts",
			"packages/lib/src/sentiment/enqueue.ts",
		]);
		expect(filesMatching(["apps", "packages"], objectSend)).toEqual([]);
		expect(filesMatching(["apps", "packages"], rawInsert)).toEqual([]);
		expect(filesMatching(["apps", "packages"], /\bsendSentimentJob\(/)).toEqual([
			"apps/worker/src/jobs/classify-sentiment.ts",
			"packages/lib/src/sentiment/backfill.ts",
			"packages/lib/src/sentiment/enqueue.ts",
			"packages/lib/src/sentiment/held-release.ts",
			"packages/lib/src/sentiment/job.ts",
			"packages/lib/src/sentiment/resume.ts",
		]);
	});

	it("every producer that sends a job consults the dispatch control, and the natural producer reads it only after ensureAnalysis", () => {
		for (const file of [
			"packages/lib/src/sentiment/enqueue.ts",
			"packages/lib/src/sentiment/backfill.ts",
			"packages/lib/src/sentiment/held-release.ts",
		]) {
			expect(readFileSync(path.join(repoRoot, file), "utf8"), file).toMatch(/readDispatchState/);
		}
		const job = readFileSync(path.join(repoRoot, "packages/lib/src/sentiment/job.ts"), "utf8");
		expect(job).toMatch(/isHeld\(await readDispatchState\(\)\)\) return \{ held: true/);
		const enqueue = readFileSync(path.join(repoRoot, "packages/lib/src/sentiment/enqueue.ts"), "utf8");
		const body = enqueue.slice(enqueue.indexOf("export async function enqueueSentimentBestEffort"));
		expect(body.indexOf("ensureAnalysis)(")).toBeGreaterThan(-1);
		expect(body.indexOf("readDispatchState)()")).toBeGreaterThan(body.indexOf("ensureAnalysis)("));
		expect(body.indexOf("sendSentimentJob(")).toBeGreaterThan(body.indexOf("readDispatchState)()"));
	});

	it("no production code injects its own provider into the job core except the canary wrapper and the workflow's own guarded hand-off", () => {
		expect(filesMatching(["apps", "packages"], /resolveProvider:\s*\(\)/)).toEqual([
			"packages/lib/src/sentiment/canary.ts",
			"packages/lib/src/sentiment/job.ts",
		]);
	});
});
