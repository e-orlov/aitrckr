import { inferPageType } from "../citations/domain-categories";
import { categorizeDomain } from "../citations/domain-categories.server";
import { normalizeSourceHostname } from "./hostname";
import {
	PAGE_FALLBACK_HINTS,
	type PageFallbackHint,
	SOURCE_CLASSIFIER_VERSION,
	type SourceClassificationJobData,
} from "./types";

export interface CitationLike {
	url: string;
	domain: string;
	title?: string | null;
}

const MAX_PAGE_TYPE_HINTS = 5;

// What the built-in page fallback in classifyUrl would render for a page type.
const PAGE_TYPE_FALLBACK: Partial<Record<string, PageFallbackHint>> = {
	article: "editorial",
	listicle: "editorial",
	howto: "editorial",
	comparison: "editorial",
	review: "editorial",
	product: "ecommerce",
	shopping: "ecommerce",
	forum: "social",
};

/**
 * Turn a freshly persisted citation set into the F-05 job payloads it makes
 * eligible. Pure: normalization, dedupe, brand/competitor exclusion, and the
 * domain-level deterministic gate all happen here; the current-version cache
 * filter is a separate (DB) step. Eligibility is decided on the domain-level
 * built-in result — the URL/title page fallback must not suppress enqueueing,
 * it only contributes bounded enum hints to the payload.
 */
export function collectSourceClassificationCandidates(
	citationsList: CitationLike[],
	brandDomains: Set<string>,
	competitorDomains: Set<string>,
): SourceClassificationJobData[] {
	const byHostname = new Map<string, CitationLike[]>();
	for (const citation of citationsList) {
		const hostname = normalizeSourceHostname(citation.domain);
		if (!hostname) continue;
		const list = byHostname.get(hostname);
		if (list) list.push(citation);
		else byHostname.set(hostname, [citation]);
	}

	const candidates: SourceClassificationJobData[] = [];
	for (const [hostname, group] of byHostname) {
		// Domain-level built-in decision, including brand/competitor context: only
		// a residual "other" hostname may reach the LLM.
		if (categorizeDomain(hostname, brandDomains, competitorDomains) !== "other") continue;

		const { pageTypes, pageFallbackHint } = collectPageHints(group);
		candidates.push({
			hostname,
			classifierVersion: SOURCE_CLASSIFIER_VERSION,
			builtInCategory: "other",
			...(pageTypes.length ? { pageTypeHints: pageTypes as SourceClassificationJobData["pageTypeHints"] } : {}),
			...(pageFallbackHint ? { pageFallbackHint } : {}),
		});
	}
	return candidates;
}

/** Bounded enum-only hints for one hostname's citation group. */
function collectPageHints(group: CitationLike[]): {
	pageTypes: string[];
	pageFallbackHint: PageFallbackHint | undefined;
} {
	const pageTypes: string[] = [];
	const fallbackCounts = new Map<PageFallbackHint, number>();
	for (const citation of group) {
		const pageType = inferPageType(citation.url, citation.title);
		if (!pageTypes.includes(pageType) && pageTypes.length < MAX_PAGE_TYPE_HINTS) pageTypes.push(pageType);
		const fallback = PAGE_TYPE_FALLBACK[pageType];
		if (fallback) fallbackCounts.set(fallback, (fallbackCounts.get(fallback) ?? 0) + 1);
	}
	const pageFallbackHint = PAGE_FALLBACK_HINTS.map((hint) => ({ hint, count: fallbackCounts.get(hint) ?? 0 }))
		.filter((entry) => entry.count > 0)
		.sort((a, b) => b.count - a.count)[0]?.hint;
	return { pageTypes, pageFallbackHint };
}
