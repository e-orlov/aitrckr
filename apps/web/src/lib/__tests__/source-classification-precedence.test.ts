/**
 * F-05 effective-category precedence over the shared classifier
 * (@workspace/lib re-exported through @/lib/domain-categories.server):
 *
 *   1. brand/competitor (current config)  2. cached current-version LLM result
 *   (any of the nine categories, including a definitive "other")
 *   3. deterministic domain rules  4. URL/title page fallback  5. other
 */
import { describe, expect, it } from "vitest";
import { CITATION_CATEGORIES, type CitationCategory } from "@/lib/domain-categories";
import {
	categorizeDomain,
	classifyUrl,
	type SupplementalDomainCategory,
	type SupplementalDomainLookup,
} from "@/lib/domain-categories.server";

const none = new Set<string>();
const supplementalFor =
	(entries: Record<string, SupplementalDomainCategory>): SupplementalDomainLookup =>
	(domain) =>
		entries[domain];

describe("F05-UT-004 — eleven-category product taxonomy", () => {
	it("has exactly the eleven product categories", () => {
		expect(CITATION_CATEGORIES).toEqual([
			"brand",
			"competitor",
			"editorial",
			"reviews",
			"ecommerce",
			"social",
			"developer",
			"pr",
			"reference",
			"institutional",
			"other",
		]);
	});

	it("resolves every deterministic category when no cache row exists", () => {
		const expectations: [string, CitationCategory][] = [
			["mybrand.com", "brand"],
			["rival.io", "competitor"],
			["nytimes.com", "editorial"],
			["g2.com", "reviews"],
			["amazon.com", "ecommerce"],
			["reddit.com", "social"],
			["github.com", "developer"],
			["prnewswire.com", "pr"],
			["wikipedia.org", "reference"],
			["nih.gov", "institutional"],
			["unlisted-company.de", "other"],
		];
		for (const [domain, expected] of expectations) {
			expect(
				categorizeDomain(domain, new Set(["mybrand.com"]), new Set(["rival.io"]), supplementalFor({})),
				domain,
			).toBe(expected);
		}
	});
});

describe("F05-UT-005 — effective precedence order", () => {
	const cached = supplementalFor({ "cached.de": "institutional" });

	// F05-AT-001 — brand (incl. subdomain) wins over a cached F-05 result.
	it("brand and its subdomains beat a cached classification", () => {
		const brand = new Set(["cached.de"]);
		expect(categorizeDomain("cached.de", brand, none, cached)).toBe("brand");
		expect(categorizeDomain("shop.cached.de", brand, none, cached)).toBe("brand");
		expect(classifyUrl("cached.de", "https://cached.de/blog/post", "Post", brand, none, cached)).toBe("brand");
	});

	// F05-AT-002 / F05-IT-009 — competitor config is retroactive over the cache
	// without rewriting anything: the same call with a changed set flips the result.
	it("adding/removing a competitor flips the category immediately over an existing cache row", () => {
		const asCompetitor = categorizeDomain("cached.de", none, new Set(["cached.de"]), cached);
		expect(asCompetitor).toBe("competitor");
		const afterRemoval = categorizeDomain("cached.de", none, none, cached);
		expect(afterRemoval).toBe("institutional"); // reveals the cached classification
	});

	// F05R — a current cache row corrects the deterministic domain lists.
	it("a cached classification beats a conflicting deterministic list entry", () => {
		const corrections = supplementalFor({
			"wikipedia.org": "editorial",
			"g2.com": "ecommerce",
			"reddit.com": "other",
		});
		expect(categorizeDomain("wikipedia.org", none, none, corrections)).toBe("editorial");
		expect(categorizeDomain("g2.com", none, none, corrections)).toBe("ecommerce");
		expect(categorizeDomain("reddit.com", none, none, corrections)).toBe("other");
	});

	it("every one of the nine cached categories is surfaced as the effective category", () => {
		const categories: SupplementalDomainCategory[] = [
			"editorial",
			"reviews",
			"ecommerce",
			"social",
			"developer",
			"pr",
			"reference",
			"institutional",
			"other",
		];
		for (const category of categories) {
			const lookup = supplementalFor({ "cached.de": category });
			expect(categorizeDomain("cached.de", none, none, lookup), category).toBe(category);
		}
	});

	// F05-AT-006 — a cached result precedes the page-type fallback.
	it("cached institutional wins over an article-looking URL", () => {
		expect(classifyUrl("cached.de", "https://cached.de/blog/10-best-tips", "10 best tips", none, none, cached)).toBe(
			"institutional",
		);
	});

	// F05R — a cached "other" is a definitive source classification: it also
	// suppresses the page-type fallback.
	it("cached other wins over an article-looking URL", () => {
		const lookup = supplementalFor({ "plain.de": "other" });
		expect(classifyUrl("plain.de", "https://plain.de/blog/review-of-x", "Review of X", none, none, lookup)).toBe(
			"other",
		);
	});

	// F05-AT-007 — a domain absent from the lookup falls through to the
	// deterministic lists, then the page-type fallback.
	it("a domain without a cache entry falls through to deterministic rules and page-type fallback", () => {
		const lookup = supplementalFor({});
		expect(categorizeDomain("wikipedia.org", none, none, lookup)).toBe("reference");
		expect(classifyUrl("plain.de", "https://plain.de/blog/review-of-x", "Review of X", none, none, lookup)).toBe(
			"editorial",
		);
		expect(classifyUrl("plain.de", "https://plain.de/products/thing", null, none, none, lookup)).toBe("ecommerce");
		expect(classifyUrl("plain.de", "https://plain.de/imprint-xyz", null, none, none, lookup)).toBe("other");
	});

	it("without any supplemental lookup, behavior is exactly the pre-F05 classifier (F05-REG-001)", () => {
		expect(categorizeDomain("unknown.de", none, none)).toBe("other");
		expect(classifyUrl("unknown.de", "https://unknown.de/blog/post", "Post", none, none)).toBe("editorial");
	});
});
