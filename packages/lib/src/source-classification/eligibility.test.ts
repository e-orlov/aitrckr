import { describe, expect, it } from "vitest";
import { collectSourceClassificationCandidates } from "./eligibility";
import { SOURCE_CLASSIFIER_VERSION, sourceClassificationJobSchema } from "./types";

const none = new Set<string>();
const citation = (domain: string, url = `https://${domain}/`, title: string | null = null) => ({ domain, url, title });

describe("collectSourceClassificationCandidates", () => {
	// F05-UT-002 / F05-UT-003 — brand and competitor hostnames (and their
	// subdomains) never become candidates.
	it("excludes brand and competitor domains including subdomains", () => {
		const candidates = collectSourceClassificationCandidates(
			[
				citation("mybrand.com"),
				citation("shop.mybrand.com"),
				citation("rival.io"),
				citation("blog.rival.io"),
				citation("unknown-source.de"),
			],
			new Set(["mybrand.com"]),
			new Set(["rival.io"]),
		);
		expect(candidates.map((c) => c.hostname)).toEqual(["unknown-source.de"]);
	});

	// F05-AT-003 — every deterministic category is ineligible; only residual
	// domain-level "other" hostnames become candidates.
	it("excludes every deterministically categorized domain", () => {
		const deterministic = [
			"nytimes.com", // editorial
			"g2.com", // reviews
			"amazon.com", // ecommerce
			"reddit.com", // social
			"github.com", // developer
			"prnewswire.com", // pr
			"wikipedia.org", // reference
			"nih.gov", // institutional
			"forums.example-shop.com", // forum subdomain -> social
		];
		const candidates = collectSourceClassificationCandidates(
			[...deterministic.map((d) => citation(d)), citation("unknown-source.de")],
			none,
			none,
		);
		expect(candidates.map((c) => c.hostname)).toEqual(["unknown-source.de"]);
	});

	// F05-AT-004 / F05-IT-004 — many citations of one hostname yield one candidate.
	it("deduplicates hostnames across citations and normalizes variants onto one candidate", () => {
		const candidates = collectSourceClassificationCandidates(
			[
				citation("unknown-source.de", "https://unknown-source.de/a"),
				citation("www.unknown-source.de", "https://www.unknown-source.de/b"),
				citation("UNKNOWN-SOURCE.de.", "https://unknown-source.de/c"),
				citation("not a domain"),
			],
			none,
			none,
		);
		expect(candidates).toHaveLength(1);
		expect(candidates[0].hostname).toBe("unknown-source.de");
	});

	// F05-FR-003 — an article-looking page does not suppress domain-level
	// eligibility; the page signal rides along as a bounded hint instead.
	it("keeps an unknown hostname eligible when its pages look editorial, and carries bounded enum hints", () => {
		const candidates = collectSourceClassificationCandidates(
			[
				citation("unknown-source.de", "https://unknown-source.de/blog/best-10-tools", "Best 10 tools reviewed"),
				citation("unknown-source.de", "https://unknown-source.de/how-to/setup", "How to set up"),
			],
			none,
			none,
		);
		expect(candidates).toHaveLength(1);
		const candidate = candidates[0];
		expect(candidate.builtInCategory).toBe("other");
		expect(candidate.classifierVersion).toBe(SOURCE_CLASSIFIER_VERSION);
		expect(candidate.pageFallbackHint).toBe("editorial");
		expect(candidate.pageTypeHints?.length).toBeLessThanOrEqual(5);
		// F05-IT-011 — the payload validates against the queue contract and holds
		// nothing beyond hostname, version, built-in result, and enum hints.
		expect(sourceClassificationJobSchema.parse(candidate)).toEqual(candidate);
	});

	it("returns no candidates when everything is invalid, brand, or deterministic", () => {
		expect(
			collectSourceClassificationCandidates(
				[citation("localhost"), citation("mybrand.com"), citation("wikipedia.org")],
				new Set(["mybrand.com"]),
				none,
			),
		).toEqual([]);
	});
});
