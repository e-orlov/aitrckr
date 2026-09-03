import { resolveResearchProvider } from "../providers/research";
import type { Provider } from "../providers/types";
import { normalizeSourceHostname } from "./hostname";
import { buildSourceClassificationPrompt } from "./prompt";
import {
	SOURCE_CLASSIFIER_VERSION,
	type SourceClassification,
	type SourceClassificationJobData,
	sourceClassificationResultSchema,
} from "./types";

export interface SourceClassifierDeps {
	/** Injected in tests; production resolves the shared research provider. */
	resolveProvider?: () => Provider;
}

/**
 * Classify one eligible hostname through the shared structured-research
 * provider. This is the production classifier boundary: the live acceptance
 * command calls it as-is, the worker calls it per job, and tests inject a fake
 * provider here. One top-level provider call per invocation — retry policy
 * belongs to the queue (and to the provider's own bounded internal transport
 * policy), not to this function.
 *
 * The hostname must normalize (and already be normalized). The provider's
 * answer is validated again locally; an invalid answer throws and is never
 * persisted as `other`.
 */
export async function classifySourceHostname(
	input: SourceClassificationJobData,
	deps: SourceClassifierDeps = {},
): Promise<SourceClassification> {
	const normalized = normalizeSourceHostname(input.hostname);
	if (!normalized || normalized !== input.hostname) {
		throw new Error(`source classification requires a normalized hostname; got "${input.hostname}"`);
	}

	const prompt = buildSourceClassificationPrompt(input);

	const provider = deps.resolveProvider ? deps.resolveProvider() : resolveResearchProvider();
	if (!provider.runStructuredResearch) {
		throw new Error(`Provider "${provider.id}" does not implement structured research`);
	}

	const result = await provider.runStructuredResearch({
		prompt,
		schema: sourceClassificationResultSchema,
		webSearch: true,
	});

	// The provider already parsed against the schema; validate again locally so a
	// provider implementation that skips or loosens parsing cannot leak an
	// out-of-contract value into the cache.
	const validated = sourceClassificationResultSchema.parse(result.object);

	return {
		hostname: normalized,
		...validated,
		provider: provider.id,
		model: result.modelVersion ?? null,
		classifierVersion: SOURCE_CLASSIFIER_VERSION,
	};
}
