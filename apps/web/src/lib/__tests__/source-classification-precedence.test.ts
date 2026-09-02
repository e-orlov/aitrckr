/**
 * F-05 effective-category precedence over the shared classifier
 * (@workspace/lib re-exported through @/lib/domain-categories.server):
 *
 *   1. brand/competitor (current config)  2. deterministic domain rules
 *   3. cached F-05 editorial/institutional  4. URL/title page fallback  5. other
 */
import { describe, expect, it } from "vitest";
import { CITATION_CATEGORIES, type CitationCategory } from "@/lib/domain-categories";
import { categorizeDomain, classifyUrl, type SupplementalDomainLookup } from "@/lib/domain-categories.server";

const none = new Set<string>();
const supplementalFor =
	(entries: Record<string, "editorial" | "institutional">): SupplementalDomainLookup =>
	(domain) =>
		entries[domain];

describe("F05-UT-004 — eleven-category taxonomy regression with supplemental lookup active", () => {
	it("keeps every deterministic category and never yields a Google category", () => {
		// A supplemental lookup that would relabel everything institutional — it
		// must never be consulted for a deterministically categorized domain.
		const aggressive: SupplementalDomainLookup = () => "institutional";
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
			["unlisted-company.de", "institutional"], // only the residual case reaches the lookup
		];
		for (const [domain, expected] of expectations) {
			expect(categorizeDomain(domain, new Set(["mybrand.com"]), new Set(["rival.io"]), aggressive), domain).toBe(
				expected,
			);
		}
		expect(CITATION_CATEGORIES).toHaveLength(11);
		expect(CITATION_CATEGORIES).not.toContain("google");
	});
});

describe("F05-UT-005 — five-stage effective order", () => {
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

	it("deterministic domain rules beat the cached classification", () => {
		const conflicting = supplementalFor({ "wikipedia.org": "editorial" } as never);
		expect(categorizeDomain("wikipedia.org", none, none, conflicting)).toBe("reference");
	});

	// F05-AT-006 — a cached editorial/institutional result precedes the page-type fallback.
	it("cached institutional wins over an article-looking URL", () => {
		expect(classifyUrl("cached.de", "https://cached.de/blog/10-best-tips", "10 best tips", none, none, cached)).toBe(
			"institutional",
		);
	});

	// F05-AT-007 / F05-UT-006 — absent from the lookup (incl. a valid cached
	// "other") falls through to the existing page-type fallback.
	it("a domain without a promotable cache entry falls through to page-type fallback", () => {
		const lookup = supplementalFor({});
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
