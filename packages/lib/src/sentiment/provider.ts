import { getProvider } from "../providers/index";
import type { Provider } from "../providers/types";
import { SENTIMENT_MODEL, SENTIMENT_PROVIDER_ID } from "./types";

export class SentimentProviderError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SentimentProviderError";
	}
}

/**
 * Sentiment classification is pinned to one paid path: the shared OpenRouter
 * structured-research call, which sends `openai/gpt-5-mini` with strict JSON
 * schema output and the web-search server tool. The general research
 * preference (`ONBOARDING_LLM_TARGET`, direct OpenAI/Anthropic keys) is
 * deliberately not consulted, so configuring another LLM key can never move
 * sentiment spend or behaviour to a different provider or model.
 */
export function resolveSentimentProvider(): Provider {
	const provider = getProvider(SENTIMENT_PROVIDER_ID);
	if (!provider.isConfigured()) {
		throw new SentimentProviderError(
			`Sentiment classification requires OPENROUTER_API_KEY (locked to ${SENTIMENT_PROVIDER_ID} / ${SENTIMENT_MODEL}).`,
		);
	}
	if (!provider.runStructuredResearch) {
		throw new SentimentProviderError(`Provider "${provider.id}" does not implement structured research`);
	}
	return provider;
}
