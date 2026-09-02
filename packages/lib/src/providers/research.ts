/**
 * Structured-research provider selection, shared by every feature that needs a
 * one-shot structured LLM call (onboarding research, source classification).
 * Moved out of `onboarding/llm.ts` unchanged so non-onboarding callers don't
 * import the onboarding module; that module re-exports these for its callers.
 */
import { getProvider, parseScrapeTargets } from "./index";
import type { Provider } from "./types";

/**
 * Direct-API providers in the order structured research prefers them. GPT-5
 * Mini was the cheapest + best-recall in compare-onboarding runs, so we go
 * OpenAI direct first, then OpenAI via OpenRouter as a fallback (same model,
 * just different key), then Anthropic, then Mistral.
 *
 * Exported so the compare-onboarding script reads from the same source as
 * production — keeps the two from drifting.
 */
export const RESEARCH_PROVIDER_PREFERENCE = ["openai-api", "openrouter", "anthropic-api", "mistral-api"] as const;

export type ResearchProviderId = (typeof RESEARCH_PROVIDER_PREFERENCE)[number];

const ONBOARDING_LLM_TARGET_HELP =
	"Set ONBOARDING_LLM_TARGET (e.g. claude:anthropic-api) " +
	"or configure ANTHROPIC_API_KEY / OPENAI_API_KEY / OPENROUTER_API_KEY / MISTRAL_API_KEY.";

/**
 * Pick which direct-API provider structured research should use.
 *
 * Resolution order:
 *   1. `ONBOARDING_LLM_TARGET` env override (parsed `model:provider`; only
 *      the `provider` segment is honored).
 *   2. First provider in `RESEARCH_PROVIDER_PREFERENCE` that's configured AND
 *      implements `runStructuredResearch`.
 *
 * Each provider supplies its own research model internally — there's no way
 * to override the model via env or option. Operators who want a different
 * model edit the provider's `DEFAULT_RESEARCH_MODEL` constant in source.
 */
export function resolveResearchProvider(env: Record<string, string | undefined> = process.env): Provider {
	const explicit = env.ONBOARDING_LLM_TARGET?.trim();
	if (explicit) {
		const [parsed] = parseScrapeTargets(explicit);
		if (!parsed) throw new Error(`Invalid ONBOARDING_LLM_TARGET: "${explicit}"`);
		const provider = getProvider(parsed.provider);
		if (!provider.isConfigured()) {
			throw new Error(
				`ONBOARDING_LLM_TARGET points at "${parsed.provider}" but it isn't configured. ${ONBOARDING_LLM_TARGET_HELP}`,
			);
		}
		if (!provider.runStructuredResearch) {
			throw new Error(
				`ONBOARDING_LLM_TARGET points at "${parsed.provider}", which does not support structured research. ${ONBOARDING_LLM_TARGET_HELP}`,
			);
		}
		return provider;
	}

	for (const id of RESEARCH_PROVIDER_PREFERENCE) {
		const provider = getProvider(id);
		if (!provider.isConfigured()) continue;
		if (!provider.runStructuredResearch) continue;
		return provider;
	}

	throw new Error(`Structured research requires at least one direct LLM API provider. ${ONBOARDING_LLM_TARGET_HELP}`);
}
