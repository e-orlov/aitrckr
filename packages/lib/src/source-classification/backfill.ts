import { categorizeDomain } from "../citations/domain-categories.server";
import { normalizeSourceHostname } from "./hostname";
import { SOURCE_CLASSIFIER_VERSION } from "./types";

export interface BackfillCitationRow {
	domain: string;
	brandId: string;
}

export interface BackfillBrandContext {
	brandDomains: Set<string>;
	competitorDomains: Set<string>;
}

export interface BackfillInventory {
	scannedCitations: number;
	distinctHostnames: number;
	invalid: number;
	brandOrCompetitorSkipped: number;
	deterministicSkipped: number;
	cachedCurrentSkipped: number;
	staleCached: number;
	eligible: number;
}

export interface BackfillSelection {
	inventory: BackfillInventory;
	/** Unique eligible normalized hostnames, ready to become job payloads. */
	eligibleHostnames: string[];
}

/**
 * Pure selection step of the historical backfill: which hostnames from a
 * citation scan still need classification for the current classifier version.
 * Deterministic and idempotent — running it twice over the same inputs yields
 * the same counts, and it performs no I/O (the caller loads rows/cache and
 * decides whether to enqueue). A hostname counts as brand/competitor-skipped
 * only when every brand citing it treats it as brand/competitor; if at least
 * one citing brand sees it as a plain source, its domain-level role matters
 * and it stays in the pipeline.
 */
export function selectBackfillCandidates(args: {
	citations: BackfillCitationRow[];
	brandContexts: Map<string, BackfillBrandContext>;
	cachedVersions: Map<string, string>;
	classifierVersion?: string;
}): BackfillSelection {
	const classifierVersion = args.classifierVersion ?? SOURCE_CLASSIFIER_VERSION;
	const inventory: BackfillInventory = {
		scannedCitations: args.citations.length,
		distinctHostnames: 0,
		invalid: 0,
		brandOrCompetitorSkipped: 0,
		deterministicSkipped: 0,
		cachedCurrentSkipped: 0,
		staleCached: 0,
		eligible: 0,
	};

	const brandsByHostname = new Map<string, Set<string>>();
	const invalidDomains = new Set<string>();
	for (const row of args.citations) {
		const hostname = normalizeSourceHostname(row.domain);
		if (!hostname) {
			invalidDomains.add(row.domain);
			continue;
		}
		const brandIds = brandsByHostname.get(hostname);
		if (brandIds) brandIds.add(row.brandId);
		else brandsByHostname.set(hostname, new Set([row.brandId]));
	}
	inventory.invalid = invalidDomains.size;
	inventory.distinctHostnames = brandsByHostname.size + invalidDomains.size;

	const eligibleHostnames: string[] = [];
	const emptySet = new Set<string>();
	for (const [hostname, brandIds] of brandsByHostname) {
		const contexts = [...brandIds].map((brandId) => args.brandContexts.get(brandId));
		const brandOrCompetitorEverywhere =
			contexts.length > 0 &&
			contexts.every((context) => {
				if (!context) return false;
				const category = categorizeDomain(hostname, context.brandDomains, context.competitorDomains);
				return category === "brand" || category === "competitor";
			});
		if (brandOrCompetitorEverywhere) {
			inventory.brandOrCompetitorSkipped++;
			continue;
		}

		if (categorizeDomain(hostname, emptySet, emptySet) !== "other") {
			inventory.deterministicSkipped++;
			continue;
		}

		const cachedVersion = args.cachedVersions.get(hostname);
		if (cachedVersion === classifierVersion) {
			inventory.cachedCurrentSkipped++;
			continue;
		}
		if (cachedVersion !== undefined) inventory.staleCached++;

		eligibleHostnames.push(hostname);
	}

	eligibleHostnames.sort();
	inventory.eligible = eligibleHostnames.length;
	return { inventory, eligibleHostnames };
}
