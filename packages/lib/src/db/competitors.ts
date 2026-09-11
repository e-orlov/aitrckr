/**
 * Competitor roster helpers shared by every reader that means "currently
 * tracked" and by the settings save that must keep competitor ids stable.
 */
import { and, asc, eq } from "drizzle-orm";
import { competitors } from "./schema";

/** Where-clause for the brand's current roster; every "currently tracked" reader uses this. */
export function activeCompetitorsOf(brandId: string) {
	return and(eq(competitors.brandId, brandId), eq(competitors.active, true));
}

/** Stable roster order so the editor's list and the saved list line up. */
export const competitorRosterOrder = [asc(competitors.createdAt), asc(competitors.id)];

export interface StoredCompetitor {
	id: string;
	name: string;
	domains: string[];
	aliases: string[];
	active: boolean;
}

/** One entry as the editor submits it — normalized domains, optional persistent id. */
export interface RosterEntry {
	id?: string;
	name: string;
	domains: string[];
	aliases: string[];
}

export type RosterPlanErrorCode =
	| "competitor-unknown"
	| "competitor-duplicate-id"
	| "competitor-domains-duplicate"
	| "competitor-reactivation-ambiguous";

export class RosterPlanError extends Error {
	constructor(
		readonly code: RosterPlanErrorCode,
		message: string,
	) {
		super(message);
		this.name = "RosterPlanError";
	}
}

export interface RosterUpdate {
	id: string;
	name: string;
	domains: string[];
	aliases: string[];
	/** The old name when the entry renames the competitor. */
	previousName: string | null;
	/** True when the stored row was inactive and this save brings it back. */
	reactivate: boolean;
}

export interface RosterPlan {
	inserts: RosterEntry[];
	updates: RosterUpdate[];
	/** Active rows omitted from the submission. */
	deactivate: string[];
	/** Rows submitted with no change at all. */
	unchanged: string[];
}

function sameList(a: string[], b: string[]): boolean {
	return a.length === b.length && a.every((value, index) => value === b[index]);
}

function assertSubmissionIsWellFormed(byId: Map<string, StoredCompetitor>, submitted: RosterEntry[]): Set<string> {
	const seenIds = new Set<string>();
	const domainOwner = new Map<string, RosterEntry>();
	for (const entry of submitted) {
		if (entry.id !== undefined) {
			if (!byId.has(entry.id)) {
				throw new RosterPlanError("competitor-unknown", `Competitor ${entry.id} does not belong to this brand`);
			}
			if (seenIds.has(entry.id)) {
				throw new RosterPlanError("competitor-duplicate-id", `Competitor ${entry.id} was submitted twice`);
			}
			seenIds.add(entry.id);
		}
		for (const domain of new Set(entry.domains)) {
			const owner = domainOwner.get(domain);
			if (owner && owner !== entry) {
				throw new RosterPlanError(
					"competitor-domains-duplicate",
					`Domain "${domain}" is listed for both "${owner.name}" and "${entry.name}"`,
				);
			}
			domainOwner.set(domain, entry);
		}
	}
	return seenIds;
}

/**
 * Entries without an id may reuse a stored row nobody claimed by id, but only
 * when exactly one such row shares a normalized domain — a name alone never
 * merges. Two candidates, or one candidate wanted by two entries, reject the
 * whole save so nothing is guessed.
 */
function matchUnclaimedRows(
	unclaimed: StoredCompetitor[],
	submitted: RosterEntry[],
): Map<RosterEntry, StoredCompetitor> {
	const claimedBy = new Map<string, RosterEntry>();
	const matched = new Map<RosterEntry, StoredCompetitor>();
	for (const entry of submitted) {
		if (entry.id !== undefined) continue;
		const domains = new Set(entry.domains);
		const candidates = unclaimed.filter((row) => row.domains.some((domain) => domains.has(domain)));
		if (candidates.length === 0) continue;
		if (candidates.length > 1) {
			throw new RosterPlanError(
				"competitor-reactivation-ambiguous",
				`"${entry.name}" matches ${candidates.length} stored competitors by domain; re-add it from the stored entry instead`,
			);
		}
		const candidate = candidates[0];
		const other = claimedBy.get(candidate.id);
		if (other) {
			throw new RosterPlanError(
				"competitor-reactivation-ambiguous",
				`"${entry.name}" and "${other.name}" both match stored competitor "${candidate.name}"`,
			);
		}
		claimedBy.set(candidate.id, entry);
		matched.set(entry, candidate);
	}
	return matched;
}

function rowChange(row: StoredCompetitor, entry: RosterEntry): RosterUpdate | null {
	const renamed = row.name !== entry.name;
	const changed =
		renamed || !sameList(row.domains, entry.domains) || !sameList(row.aliases, entry.aliases) || !row.active;
	if (!changed) return null;
	return {
		id: row.id,
		name: entry.name,
		domains: entry.domains,
		aliases: entry.aliases,
		previousName: renamed ? row.name : null,
		reactivate: !row.active,
	};
}

/**
 * Diff the submitted roster against the brand's stored rows (active and
 * inactive). Pure: the caller loads the rows inside its transaction and
 * applies the plan there. Entries carrying an id update that row in place;
 * active rows the submission omits are deactivated, inactive ones are left as
 * they are.
 */
export function planCompetitorRoster(stored: StoredCompetitor[], submitted: RosterEntry[]): RosterPlan {
	const byId = new Map(stored.map((row) => [row.id, row]));
	const claimedIds = assertSubmissionIsWellFormed(byId, submitted);
	const matched = matchUnclaimedRows(
		stored.filter((row) => !claimedIds.has(row.id)),
		submitted,
	);

	const plan: RosterPlan = { inserts: [], updates: [], deactivate: [], unchanged: [] };
	const kept = new Set<string>();
	for (const entry of submitted) {
		const row = entry.id !== undefined ? byId.get(entry.id) : matched.get(entry);
		if (!row) {
			plan.inserts.push(entry);
			continue;
		}
		kept.add(row.id);
		const update = rowChange(row, entry);
		if (update) plan.updates.push(update);
		else plan.unchanged.push(row.id);
	}
	for (const row of stored) {
		if (row.active && !kept.has(row.id)) plan.deactivate.push(row.id);
	}
	return plan;
}
