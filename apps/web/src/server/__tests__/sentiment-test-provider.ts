import type { Provider } from "@workspace/lib/providers/types";

/**
 * Wraps a classification double so the v5 resolution workflow's other phases
 * are answered too: the independent verifier accepts (or answers the given
 * verdict) and a repair returns the given answer or fails as unscripted.
 * Classification prompts are delegated untouched.
 */
export function withResolutionPhases(
	provider: Provider,
	options: { verify?: unknown; repair?: unknown; onPhase?: (phase: "classify" | "repair" | "verify") => void } = {},
): Provider {
	return {
		...provider,
		async runStructuredResearch(opts: { prompt: string; schema: { parse: (v: unknown) => unknown } }) {
			const phase = opts.prompt.startsWith("You are an independent verifier")
				? "verify"
				: opts.prompt.startsWith("You are repairing")
					? "repair"
					: "classify";
			options.onPhase?.(phase);
			if (phase === "classify") {
				if (!provider.runStructuredResearch) throw new Error("no classification double");
				return provider.runStructuredResearch(opts as never);
			}
			const answer = phase === "verify" ? (options.verify ?? { verdict: "accept", issues: [] }) : options.repair;
			if (answer === undefined) throw new Error(`unscripted ${phase} call`);
			return {
				object: opts.schema.parse(answer),
				modelVersion: "openai/gpt-5-mini",
				generationId: `gen-${phase}-${Math.random().toString(36).slice(2, 10)}`,
				usage: {
					inputTokens: 100,
					outputTokens: 20,
					reasoningTokens: 0,
					costUsd: 0.001,
					webSearchRequests: 0,
					webSearchRequestsConflict: false,
				},
			};
		},
	} as unknown as Provider;
}
