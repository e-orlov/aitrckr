/**
 * Provider-agnostic onboarding research.
 *
 * Onboarding always runs against a direct API provider (Anthropic / OpenAI /
 * OpenRouter / Mistral) — the deployment guarantees one is configured, and
 * the CLI's setup wizard enforces it. Each provider implements
 * `runStructuredResearch<T>(prompt, schema)` itself, picking the most
 * idiomatic combo for its API:
 *   • Anthropic / OpenAI — `generateText` + native web-search tool +
 *     `output: Output.object(schema)`.
 *   • OpenRouter — `generateObject` against a `:online`-suffixed slug
 *     (web search baked into the route).
 *   • Mistral — OpenAI-compat `generateObject` (no web search; users who
 *     want it should target a different provider via ONBOARDING_LLM_TARGET).
 *
 * This module's job is just to pick the right provider and forward the call.
 * No prompt wrappers, no JSON parsing, no two-pass anything.
 *
 * `ONBOARDING_LLM_TARGET` (parsed like a SCRAPE_TARGETS entry) overrides the
 * preference order if a deployment wants a specific provider/model.
 */
import type { z } from "zod";
import type { StructuredResearchResult } from "../providers";
import { resolveResearchProvider } from "../providers/research";

// Provider preference + resolution moved to providers/research.ts (shared with
// source classification); re-exported so onboarding callers are unchanged.
export { RESEARCH_PROVIDER_PREFERENCE, type ResearchProviderId, resolveResearchProvider } from "../providers/research";

/**
 * Run a research prompt and return a Zod-validated structured response. The
 * heavy lifting (web search, structured outputs, retry) lives inside each
 * provider's `runStructuredResearch` impl — we just pick the provider.
 */
export async function runStructuredResearchPrompt<T>(prompt: string, schema: z.ZodType<T>): Promise<T> {
	const provider = resolveResearchProvider();
	if (!provider.runStructuredResearch) {
		throw new Error(`Provider "${provider.id}" does not implement structured research`);
	}
	const result = await provider.runStructuredResearch({ prompt, schema });
	return result.object;
}

/**
 * Like {@link runStructuredResearchPrompt} but with the web-search tool OFF — a
 * single structured completion over context you assemble into the prompt. Same
 * provider selection (honors `ONBOARDING_LLM_TARGET` / the preference order),
 * no tools and no agent loop. Use when the prompt already carries all the data.
 *
 * Returns the validated object plus the resolved model id (`modelVersion`) so
 * callers can record which model produced the result.
 */
export async function runStructuredCompletionPrompt<T>(
	prompt: string,
	schema: z.ZodType<T>,
): Promise<StructuredResearchResult<T>> {
	const provider = resolveResearchProvider();
	if (!provider.runStructuredResearch) {
		throw new Error(`Provider "${provider.id}" does not implement structured research`);
	}
	return provider.runStructuredResearch({ prompt, schema, webSearch: false });
}
