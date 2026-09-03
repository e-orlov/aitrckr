import { inferPageType } from "../citations/domain-categories";
import { categorizeDomain } from "../citations/domain-categories.server";
import { normalizeSourceHostname } from "./hostname";
import {
	PAGE_FALLBACK_HINTS,
	type PageFallbackHint,
	SOURCE_CLASSIFIER_VERSION,
	type SourceClassificationCategory,
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

const EMPTY_SET: Set<string> = new Set();

/**
 * Turn a freshly persisted citation set into the F-05 job payloads it makes
 * eligible. Pure: normalization, dedupe, and brand/competitor exclusion happen
 * here; the current-version cache filter is a separate (DB) step. Every valid
 * hostname that is not a configured brand/competitor domain is eligible — the
 * built-in domain lists no longer gate classification, they only contribute the
 * non-authoritative `deterministicHint` (and remain the read-time fallback
 * until a cache row lands).
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
		// Contextual exclusion: configured brand/competitor domains are authoritative
		// facts, never a classification question.
		const contextual = categorizeDomain(hostname, brandDomains, competitorDomains);
		if (contextual === "brand" || contextual === "competitor") continue;

		// The context-free deterministic opinion travels as a hint only.
		const deterministicHint = categorizeDomain(hostname, EMPTY_SET, EMPTY_SET) as SourceClassificationCategory;

		const { pageTypes, pageFallbackHint } = collectPageHints(group);
		candidates.push({
			hostname,
			classifierVersion: SOURCE_CLASSIFIER_VERSION,
			deterministicHint,
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
