// Read-side access to the F-05 supplemental source-classification cache: one
// batched lookup per request, turned into the synchronous lookup the shared
// classification path consumes. Never triggers classification — reads must not
// call the LLM; absent/stale/pending rows simply behave as no supplemental
// result.
import type { SupplementalDomainLookup } from "@workspace/lib/citations/domain-categories.server";
import { getSupplementalDomainCategories, normalizeSourceHostname } from "@workspace/lib/source-classification";

const EMPTY_LOOKUP: SupplementalDomainLookup = () => undefined;

/**
 * Load current-version cache rows (any of the nine classifiable categories,
 * including a definitive `other`) for the distinct hostnames in a citation set
 * and return the lookup `categorizeDomain` / `classifyUrl` accept. A cache
 * outage degrades to built-in behavior instead of failing the page.
 */
export async function loadSupplementalDomainLookup(domains: Iterable<string>): Promise<SupplementalDomainLookup> {
	const hostnames = new Set<string>();
	for (const domain of domains) {
		const hostname = normalizeSourceHostname(domain);
		if (hostname) hostnames.add(hostname);
	}
	if (hostnames.size === 0) return EMPTY_LOOKUP;

	try {
		const categories = await getSupplementalDomainCategories([...hostnames]);
		if (categories.size === 0) return EMPTY_LOOKUP;
		return (domain) => {
			const hostname = normalizeSourceHostname(domain);
			return hostname ? categories.get(hostname) : undefined;
		};
	} catch (error) {
		console.error("Failed to load supplemental source classifications (falling back to built-in):", error);
		return EMPTY_LOOKUP;
	}
}
