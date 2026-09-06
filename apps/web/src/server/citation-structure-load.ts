/**
 * Read path for the Citation Structure page. Kept apart from the server
 * function so the client bundle never sees the database imports: Start only
 * strips the handler body, and anything else a server-function module
 * references at top level would ship to the browser.
 */
import { db } from "@workspace/lib/db/db";
import { brands, prompts } from "@workspace/lib/db/schema";
import { and, eq } from "drizzle-orm";
import { citationDateWindow } from "@/lib/chart-utils";
import {
	buildCitationStructure,
	type CitationStructureLink,
	type CitationStructureNode,
	ownedDomainCandidates,
} from "@/lib/citation-structure";
import { getCitationUrlStats } from "@/lib/postgres-read";
import { availableTagsFor, parseTagFilter, promptIdsMatchingTags, type TaggedPrompt } from "@/server/citation-filters";

export interface CitationStructureResult {
	availableTags: string[];
	/** Configured owned domains the brand has; 0 means the page cannot show anything until Brand settings has one. */
	ownedDomainCount: number;
	/** Owned citation occurrences in the filtered window — the count that decides diagram vs. empty state. */
	totalOwnedOccurrences: number;
	eligibleRawUrlGroups: number;
	excludedInvalidUrlOccurrences: number;
	nodes: CitationStructureNode[];
	links: CitationStructureLink[];
}

export interface CitationStructureInput {
	brandId: string;
	days: number;
	tags?: string;
	model?: string;
}

/** The three reads the page needs, injectable so the read path is testable without a database. */
export interface CitationStructureReads {
	loadBrand(
		brandId: string,
	): Promise<{ name: string; website: string | null; additionalDomains: string[] | null } | undefined>;
	loadEnabledPrompts(brandId: string): Promise<TaggedPrompt[]>;
	loadUrlStats(
		brandId: string,
		fromDate: string,
		toDate: string,
		timezone: string,
		promptIds: string[],
		model?: string,
	): Promise<{ url: string; count: number }[]>;
}

const dbReads: CitationStructureReads = {
	loadBrand: async (brandId) => {
		const [brand] = await db
			.select({ name: brands.name, website: brands.website, additionalDomains: brands.additionalDomains })
			.from(brands)
			.where(eq(brands.id, brandId))
			.limit(1);
		return brand;
	},
	loadEnabledPrompts: (brandId) =>
		db
			.select({ id: prompts.id, tags: prompts.tags, systemTags: prompts.systemTags })
			.from(prompts)
			.where(and(eq(prompts.brandId, brandId), eq(prompts.enabled, true))),
	loadUrlStats: getCitationUrlStats,
};

/**
 * Same window, enabled-prompt, tag and model semantics as the Citations page,
 * then the raw URL groups go straight into the owned-structure builder: no
 * URL normalization in between, so `www.` and other subdomains survive.
 */
export async function loadCitationStructure(
	input: CitationStructureInput,
	reads: CitationStructureReads = dbReads,
	now: Date = new Date(),
): Promise<CitationStructureResult> {
	const { fromDateStr, toDateStr } = citationDateWindow(now, input.days);
	const [brand, allPrompts] = await Promise.all([
		reads.loadBrand(input.brandId),
		reads.loadEnabledPrompts(input.brandId),
	]);

	const ownedDomains = ownedDomainCandidates(brand?.website, brand?.additionalDomains);
	const availableTags = availableTagsFor(allPrompts);
	const empty = (): CitationStructureResult => ({
		availableTags,
		ownedDomainCount: ownedDomains.length,
		totalOwnedOccurrences: 0,
		eligibleRawUrlGroups: 0,
		excludedInvalidUrlOccurrences: 0,
		nodes: [],
		links: [],
	});
	if (!brand || ownedDomains.length === 0) return empty();

	const tagFilter = parseTagFilter(input.tags);
	const promptIds = tagFilter.length > 0 ? promptIdsMatchingTags(allPrompts, tagFilter) : allPrompts.map((p) => p.id);
	if (promptIds.length === 0) return empty();

	const rows = await reads.loadUrlStats(input.brandId, fromDateStr, toDateStr, "UTC", promptIds, input.model);
	const structure = buildCitationStructure({
		brandId: input.brandId,
		brandName: brand.name,
		ownedDomains,
		rows: rows.map((row) => ({ url: row.url, count: Number(row.count) })),
	});

	if (structure.excludedInvalidUrlOccurrences > 0) {
		console.warn(
			`citation-structure: brand ${input.brandId} excluded ${structure.excludedInvalidUrlOccurrences} occurrence(s) with unparseable or non-http(s) URLs`,
		);
	}

	return {
		availableTags,
		ownedDomainCount: ownedDomains.length,
		totalOwnedOccurrences: structure.totalOwnedOccurrences,
		eligibleRawUrlGroups: structure.eligibleRawUrlGroups,
		excludedInvalidUrlOccurrences: structure.excludedInvalidUrlOccurrences,
		nodes: structure.nodes,
		links: structure.links,
	};
}
