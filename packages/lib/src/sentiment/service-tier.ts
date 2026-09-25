/** Explicit opt-in keeps other OpenRouter research calls on their current route. */
export function sentimentServiceTier(): "flex" | undefined {
	return process.env.SENTIMENT_OPENROUTER_SERVICE_TIER === "flex" ? "flex" : undefined;
}
