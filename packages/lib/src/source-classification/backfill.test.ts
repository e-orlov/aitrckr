import { describe, expect, it } from "vitest";
import { type BackfillBrandContext, selectBackfillCandidates } from "./backfill";
import { SOURCE_CLASSIFIER_VERSION } from "./types";

const brandContexts = new Map<string, BackfillBrandContext>([
	["brand-a", { brandDomains: new Set(["mybrand.com"]), competitorDomains: new Set(["rival.io"]) }],
	["brand-b", { brandDomains: new Set(["otherbrand.com"]), competitorDomains: new Set<string>() }],
]);

// F05-AT-011 / F05-IT-010 — the backfill selection is deterministic, idempotent,
// and applies the same eligibility rules as live ingestion.
describe("selectBackfillCandidates", () => {
	const citations = [
		// duplicates + normalization variants of one eligible hostname
		{ domain: "unknown-source.de", brandId: "brand-a" },
		{ domain: "www.unknown-source.de", brandId: "brand-a" },
		{ domain: "unknown-source.de", brandId: "brand-b" },
		// invalid
		{ domain: "not a domain", brandId: "brand-a" },
		{ domain: "localhost", brandId: "brand-a" },
		// brand/competitor for every citing brand
		{ domain: "mybrand.com", brandId: "brand-a" },
		{ domain: "rival.io", brandId: "brand-a" },
		// brand for one brand but a plain source for another -> stays eligible
		{ domain: "otherbrand.com", brandId: "brand-a" },
		{ domain: "otherbrand.com", brandId: "brand-b" },
		// deterministic categories
		{ domain: "wikipedia.org", brandId: "brand-a" },
		{ domain: "amazon.com", brandId: "brand-b" },
		// cached current + stale
		{ domain: "cached-current.de", brandId: "brand-a" },
		{ domain: "cached-stale.de", brandId: "brand-a" },
	];

	const cachedVersions = new Map([
		["cached-current.de", SOURCE_CLASSIFIER_VERSION],
		["cached-stale.de", "f05-v0"],
	]);

	it("selects only unique eligible current-version gaps and counts every skip reason", () => {
		const { inventory, eligibleHostnames } = selectBackfillCandidates({ citations, brandContexts, cachedVersions });

		expect(eligibleHostnames).toEqual(["cached-stale.de", "otherbrand.com", "unknown-source.de"]);
		expect(inventory).toEqual({
			scannedCitations: citations.length,
			// unknown-source.de, invalid×2, mybrand.com, rival.io, otherbrand.com,
			// wikipedia.org, amazon.com, cached-current.de, cached-stale.de
			distinctHostnames: 10,
			invalid: 2,
			brandOrCompetitorSkipped: 2,
			deterministicSkipped: 2,
			cachedCurrentSkipped: 1,
			staleCached: 1,
			eligible: 3,
		});
	});

	it("is idempotent: a second run over the same inputs yields identical output", () => {
		const first = selectBackfillCandidates({ citations, brandContexts, cachedVersions });
		const second = selectBackfillCandidates({ citations, brandContexts, cachedVersions });
		expect(second).toEqual(first);
	});

	// F05-AT-010 — bumping the classifier version makes previously cached
	// hostnames eligible exactly once more.
	it("treats every cached row as stale after a version change", () => {
		const { inventory, eligibleHostnames } = selectBackfillCandidates({
			citations,
			brandContexts,
			cachedVersions,
			classifierVersion: "f05-v2",
		});
		expect(eligibleHostnames).toContain("cached-current.de");
		expect(eligibleHostnames).toContain("cached-stale.de");
		expect(inventory.cachedCurrentSkipped).toBe(0);
		expect(inventory.staleCached).toBe(2);
	});
});
