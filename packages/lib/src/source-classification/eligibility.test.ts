import { describe, expect, it } from "vitest";
import { collectSourceClassificationCandidates } from "./eligibility";
import { SOURCE_CLASSIFIER_VERSION, sourceClassificationJobSchema } from "./types";

const none = new Set<string>();
const citation = (domain: string, url = `https://${domain}/`, title: string | null = null) => ({ domain, url, title });

describe("collectSourceClassificationCandidates", () => {
	// F05-UT-002 / F05-UT-003 — brand and competitor hostnames (and their
	// subdomains) never become candidates: they are configured facts, not a
	// classification question.
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

	// F05R — the built-in lists no longer gate eligibility: a deterministically
	// known reviews/ecommerce/social/... domain is still a candidate, with the
	// deterministic result carried only as a non-authoritative hint.
	it("keeps deterministically categorized domains eligible and carries the deterministic hint", () => {
		const expectations: Record<string, string> = {
			"nytimes.com": "editorial",
			"g2.com": "reviews",
			"amazon.com": "ecommerce",
			"reddit.com": "social",
			"github.com": "developer",
			"prnewswire.com": "pr",
			"wikipedia.org": "reference",
			"nih.gov": "institutional",
			"unknown-source.de": "other",
		};
		const candidates = collectSourceClassificationCandidates(
			Object.keys(expectations).map((d) => citation(d)),
			none,
			none,
		);
		expect(candidates.map((c) => c.hostname).sort()).toEqual(Object.keys(expectations).sort());
		for (const candidate of candidates) {
			expect(candidate.deterministicHint, candidate.hostname).toBe(expectations[candidate.hostname]);
		}
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

	// F05-FR-003 — page-type signals ride along as bounded hints, never as the answer.
	it("carries bounded enum page hints and a payload that validates against the queue contract", () => {
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
		expect(candidate.deterministicHint).toBe("other");
		expect(candidate.classifierVersion).toBe(SOURCE_CLASSIFIER_VERSION);
		expect(candidate.pageFallbackHint).toBe("editorial");
		expect(candidate.pageTypeHints?.length).toBeLessThanOrEqual(5);
		// F05-IT-011 — nothing beyond hostname, version, and enum hints.
		expect(sourceClassificationJobSchema.parse(candidate)).toEqual(candidate);
	});

	it("returns no candidates when everything is invalid or brand/competitor", () => {
		expect(
			collectSourceClassificationCandidates(
				[citation("localhost"), citation("mybrand.com"), citation("rival.io")],
				new Set(["mybrand.com"]),
				new Set(["rival.io"]),
			),
		).toEqual([]);
	});
});
