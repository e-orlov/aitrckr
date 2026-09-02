import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { categorizeDomain } from "../citations/domain-categories.server";
import type { Provider } from "../providers/types";
import { classifySourceHostname } from "./classifier";
import { SOURCE_CLASSIFIER_VERSION, type SourceClassificationCategory } from "./types";

/**
 * The required quality-evaluation set (F05-FR-012) plus the two additional
 * hostnames the acceptance gate covers. These hostnames exist ONLY here and in
 * evaluation documentation — the repo-scan test below proves they never appear
 * in production classifier logic, seeds, or prompts.
 */
const EVALUATION_SET: Record<string, SourceClassificationCategory> = {
	"verbraucherzentrale.de": "institutional",
	"gesetze-im-internet.de": "institutional",
	"bafin.de": "institutional",
	"arbeitsagentur.de": "institutional",
	"finanztip.de": "editorial",
	"test.de": "editorial",
};

/**
 * A schema-valid fake provider whose canned answers live in this test file.
 * It answers ANY hostname (extracted from the prompt) — proving the harness
 * feeds arbitrary inputs through the real classifier boundary rather than a
 * production domain switch.
 */
function fixtureProvider(answers: Record<string, SourceClassificationCategory>): Provider {
	return {
		id: "eval-fixture",
		name: "Evaluation fixture",
		access: "api",
		isConfigured: () => true,
		run: async () => {
			throw new Error("not used");
		},
		runStructuredResearch: (async ({
			prompt,
			schema,
		}: {
			prompt: string;
			schema: { parse: (v: unknown) => unknown };
		}) => {
			const hostname = /Hostname to classify: (\S+)/.exec(prompt)?.[1] ?? "";
			const category = answers[hostname] ?? "other";
			return {
				object: schema.parse({ category, confidence: 0.9, reason: `fixture answer for ${hostname}` }),
				modelVersion: "eval-fixture-model",
			};
		}) as never,
	};
}

// F05-EVAL-001 / F05-AT-012 — the deterministic evaluation fixture returns the
// expected labels through the production classifier boundary.
describe("four-domain (plus extended) evaluation fixture", () => {
	it("classifies every evaluation hostname as expected through classifySourceHostname", async () => {
		const provider = fixtureProvider(EVALUATION_SET);
		for (const [hostname, expected] of Object.entries(EVALUATION_SET)) {
			// Each evaluation hostname must be genuinely eligible: built-in
			// domain-level classification leaves it in "other".
			expect(categorizeDomain(hostname, new Set(), new Set()), hostname).toBe("other");

			const result = await classifySourceHostname(
				{ hostname, classifierVersion: SOURCE_CLASSIFIER_VERSION, builtInCategory: "other" },
				{ resolveProvider: () => provider },
			);
			expect(result.category, hostname).toBe(expected);
			expect(result.provider).toBe("eval-fixture");
			expect(result.model).toBe("eval-fixture-model");
		}
	});

	it("accepts arbitrary hostnames, not just the evaluation set", async () => {
		const provider = fixtureProvider({ "any-other-source.example.org": "editorial" });
		const result = await classifySourceHostname(
			{
				hostname: "any-other-source.example.org",
				classifierVersion: SOURCE_CLASSIFIER_VERSION,
				builtInCategory: "other",
			},
			{ resolveProvider: () => provider },
		);
		expect(result.category).toBe("editorial");
	});

	it("validates the fixture's output through the same strict schema as production", async () => {
		const brokenProvider: Provider = {
			...fixtureProvider({}),
			runStructuredResearch: (async () => ({
				object: { category: "institutional", confidence: 0.9, reason: "" },
			})) as never,
		};
		await expect(
			classifySourceHostname(
				{ hostname: "broken.example.org", classifierVersion: SOURCE_CLASSIFIER_VERSION, builtInCategory: "other" },
				{ resolveProvider: () => brokenProvider },
			),
		).rejects.toThrow();
	});
});

// F05-SAFE-002 / F05-AT-012 — the evaluation hostnames must not occur in any
// production source path: no allowlist entries, switch statements, biased
// prompt examples, or pre-seeded rows.
describe("evaluation hostnames are absent from production code", () => {
	const repoRoot = resolve(import.meta.dirname ?? __dirname, "..", "..", "..", "..");
	const productionRoots = [
		join(repoRoot, "packages", "lib", "src"),
		join(repoRoot, "packages", "lib", "scripts"),
		join(repoRoot, "apps", "web", "src"),
		join(repoRoot, "apps", "worker", "src"),
		join(repoRoot, "apps", "worker", "scripts"),
	];

	function* sourceFiles(dir: string): Generator<string> {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const path = join(dir, entry.name);
			if (entry.isDirectory()) {
				if (entry.name === "node_modules" || entry.name === "__tests__") continue;
				yield* sourceFiles(path);
			} else if (/\.(ts|tsx|sql|json)$/.test(entry.name) && !/\.test\.(ts|tsx)$/.test(entry.name)) {
				yield path;
			}
		}
	}

	it("finds no evaluation hostname in non-test production sources", () => {
		const offenders: string[] = [];
		for (const root of productionRoots) {
			for (const file of sourceFiles(root)) {
				const content = readFileSync(file, "utf8");
				for (const hostname of Object.keys(EVALUATION_SET)) {
					// test.de would false-positive on substrings; match as a standalone domain token.
					const token = new RegExp(`(?<![-\\w.])${hostname.replace(/\./g, "\\.")}(?![-\\w])`);
					if (token.test(content)) offenders.push(`${file}: ${hostname}`);
				}
			}
		}
		expect(offenders).toEqual([]);
	});
});
