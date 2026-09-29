import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

/**
 * Every place in the repository that hands a schema to `runStructuredResearch`
 * (directly or through the onboarding forwarders), and the test that serializes
 * that call site's exact production schema through the shared contract. A new
 * call site fails this file until it is registered here with such a test.
 */
const REGISTRY: {
	source: string;
	role: "consumer" | "forwarder" | "reuses";
	/** The production symbol the call site passes as its schema. */
	schemaSymbol?: string;
	/** Test that imports `schemaSymbol` from the production module. */
	coveredBy?: { test: string; importFrom: string };
}[] = [
	{
		source: "packages/lib/src/sentiment/classifier.ts",
		role: "consumer",
		schemaSymbol: "sentimentProviderResultSchemaFor",
		coveredBy: {
			test: "packages/lib/src/providers/structured-output-consumers.test.ts",
			importFrom: "../sentiment/types",
		},
	},
	{
		source: "packages/lib/src/sentiment/job.ts",
		role: "consumer",
		schemaSymbol: "repairResultSchemaFor",
		coveredBy: {
			test: "packages/lib/src/providers/structured-output-consumers.test.ts",
			importFrom: "../sentiment/resolution",
		},
	},
	{
		source: "packages/lib/src/sentiment/job.ts",
		role: "consumer",
		schemaSymbol: "verifierResultSchemaFor",
		coveredBy: {
			test: "packages/lib/src/providers/structured-output-consumers.test.ts",
			importFrom: "../sentiment/resolution",
		},
	},
	{
		source: "packages/lib/src/source-classification/classifier.ts",
		role: "consumer",
		schemaSymbol: "sourceClassificationResultSchema",
		coveredBy: {
			test: "packages/lib/src/providers/structured-output-consumers.test.ts",
			importFrom: "../source-classification/types",
		},
	},
	{
		source: "packages/lib/src/onboarding/analyze.ts",
		role: "consumer",
		schemaSymbol: "buildOnboardingAnalysisSchema",
		coveredBy: {
			test: "packages/lib/src/providers/structured-output-consumers.test.ts",
			importFrom: "../onboarding/analyze",
		},
	},
	{
		source: "apps/web/src/server/opportunities.ts",
		role: "consumer",
		schemaSymbol: "opportunitiesSchema",
		coveredBy: {
			test: "apps/web/src/server/__tests__/opportunities-schema.test.ts",
			importFrom: "@/server/opportunities",
		},
	},
	// Operator script: reuses the onboarding context, so it sends the exact
	// onboarding schema and cannot define one of its own (asserted below).
	{ source: "packages/lib/scripts/compare-onboarding.ts", role: "reuses" },
	// Generic forwarders: no schema of their own.
	{ source: "packages/lib/src/onboarding/llm.ts", role: "forwarder" },
];

const CALL_SITE = /\.runStructuredResearch\(|\brunStructuredResearchPrompt\(|\brunStructuredCompletionPrompt\(/;
const SCAN_ROOTS = ["apps", "packages", "e2e"];
const SKIP_DIRS = new Set(["node_modules", "dist", "build", "coverage", "__tests__"]);

function* sourceFiles(dir: string): Generator<string> {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue;
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			yield* sourceFiles(full);
		} else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
			yield full;
		}
	}
}

function read(rel: string): string {
	return readFileSync(path.join(repoRoot, rel), "utf8");
}

const toRepoPath = (abs: string) => path.relative(repoRoot, abs).split(path.sep).join("/");

describe("structured-output consumer registry", () => {
	it("runs against the repository root", () => {
		expect(statSync(path.join(repoRoot, "pnpm-workspace.yaml")).isFile()).toBe(true);
	});

	it("every runStructuredResearch call site in the repository is registered", () => {
		const found = new Set<string>();
		for (const root of SCAN_ROOTS) {
			for (const file of sourceFiles(path.join(repoRoot, root))) {
				if (CALL_SITE.test(readFileSync(file, "utf8"))) found.add(toRepoPath(file));
			}
		}
		expect([...found].sort()).toEqual([...new Set(REGISTRY.map((r) => r.source))].sort());
	});

	it.each(REGISTRY.filter((r) => r.role === "consumer"))(
		"$source passes $schemaSymbol to the provider and $coveredBy.test imports that symbol from the production module",
		({ source, schemaSymbol, coveredBy }) => {
			if (!schemaSymbol || !coveredBy) throw new Error("consumer entries need a schema symbol and a covering test");
			const consumer = read(source);
			expect(consumer).toMatch(new RegExp(`\\b${schemaSymbol}\\b`));
			const test = read(coveredBy.test);
			const imports = test.match(/^import[\s\S]*?from\s+"([^"]+)";/gm) ?? [];
			const importing = imports.find((line) => line.includes(`"${coveredBy.importFrom}"`));
			expect(importing, `${coveredBy.test} must import from ${coveredBy.importFrom}`).toBeDefined();
			expect(importing).toContain(schemaSymbol);
		},
	);

	it("contract tests contain no Zod schema construction — only production symbols reach the guard", () => {
		const tests = new Set(REGISTRY.flatMap((r) => (r.coveredBy ? [r.coveredBy.test] : [])));
		for (const test of tests) {
			const text = read(test);
			expect(text, test).not.toMatch(/\bz\.(object|enum|string|array|number|literal|union|discriminatedUnion)\(/);
			expect(text, test).not.toMatch(/^import \{[^}]*\bz\b[^}]*\} from "zod";/m);
		}
	});

	it("the onboarding runtime and its operator script send the schema the exported factory builds", () => {
		const analyze = read("packages/lib/src/onboarding/analyze.ts");
		expect(analyze).toMatch(/export function buildOnboardingAnalysisSchema\(/);
		expect(analyze).toMatch(/schema: buildOnboardingAnalysisSchema\(\{ maxCompetitors, maxPrompts \}\)/);
		expect(analyze).toMatch(/runStructuredResearchPrompt\(ctx\.prompt, ctx\.schema\)/);

		const script = read("packages/lib/scripts/compare-onboarding.ts");
		expect(script).toContain("buildAnalysisContext");
		expect(script).toMatch(/runStructuredResearch\(\{ prompt: ctx\.prompt, schema: ctx\.schema \}\)/);
		expect(script).not.toMatch(/from "zod"/);
		expect(script).not.toMatch(/\bz\.\w+\(/);
	});

	it("the opportunities runtime sends the exported schema the web test serializes", () => {
		const opportunities = read("apps/web/src/server/opportunities.ts");
		expect(opportunities).toMatch(/export const opportunitiesSchema = z\.object\(/);
		expect(opportunities).toMatch(/runStructuredCompletionPrompt\(prompt, opportunitiesSchema\)/);
	});
});
