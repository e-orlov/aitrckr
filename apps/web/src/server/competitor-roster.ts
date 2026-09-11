import {
	activeCompetitorsOf,
	competitorRosterOrder,
	planCompetitorRoster,
	type RosterEntry,
	RosterPlanError,
} from "@workspace/lib/db/competitors";
import { db } from "@workspace/lib/db/db";
import { competitors } from "@workspace/lib/db/schema";
import { assertAllowed, decideCompetitorCap } from "@workspace/lib/entitlements";
import { eq, inArray, sql } from "drizzle-orm";
import { cleanAndValidateDomain } from "@/lib/domain-categories";
import { PublicError } from "@/lib/public-errors";

export interface SubmittedCompetitor {
	/** Present for competitors the editor loaded from the database. */
	id?: string;
	name: string;
	domains: string[];
	aliases: string[];
}

function normalize(submitted: SubmittedCompetitor[]): RosterEntry[] {
	return submitted.map((c) => {
		const cleanedDomains = c.domains.map((d) => cleanAndValidateDomain(d));
		const invalid = c.domains.filter((_, i) => !cleanedDomains[i]);
		if (invalid.length > 0) {
			throw new PublicError("competitor-domains", `Invalid domain(s) for "${c.name}": ${invalid.join(", ")}`);
		}
		return {
			id: c.id,
			name: c.name.trim(),
			domains: [...new Set(cleanedDomains.filter((d): d is string => d !== null))],
			aliases: [...new Set(c.aliases.map((a) => a.trim()).filter(Boolean))],
		};
	});
}

/**
 * Persist the roster the settings editor submits. The submitted list is the
 * brand's resulting active roster, but rows are updated in place and omitted
 * rows are only marked inactive, so a competitor's id survives every save.
 */
export async function saveCompetitorRoster(brandId: string, submitted: SubmittedCompetitor[]) {
	assertAllowed(decideCompetitorCap(submitted.length));
	const entries = normalize(submitted);

	return db.transaction(async (tx) => {
		// Lock the brand's rows so two concurrent saves cannot both reactivate or
		// insert against the same stale picture.
		const stored = await tx
			.select({
				id: competitors.id,
				name: competitors.name,
				domains: competitors.domains,
				aliases: competitors.aliases,
				active: competitors.active,
			})
			.from(competitors)
			.where(eq(competitors.brandId, brandId))
			.for("update");

		let plan: ReturnType<typeof planCompetitorRoster>;
		try {
			plan = planCompetitorRoster(stored, entries);
		} catch (error) {
			if (error instanceof RosterPlanError) throw new PublicError(error.code, error.message);
			throw error;
		}

		const now = new Date();
		for (const update of plan.updates) {
			await tx
				.update(competitors)
				.set({
					name: update.name,
					domains: update.domains,
					aliases: update.aliases,
					active: true,
					removedAt: null,
					updatedAt: now,
					...(update.previousName !== null
						? { previousNames: sql`array_append(${competitors.previousNames}, ${update.previousName})` }
						: {}),
				})
				.where(eq(competitors.id, update.id));
		}

		if (plan.deactivate.length > 0) {
			await tx
				.update(competitors)
				.set({ active: false, removedAt: now, updatedAt: now })
				.where(inArray(competitors.id, plan.deactivate));
		}

		if (plan.inserts.length > 0) {
			await tx.insert(competitors).values(
				plan.inserts.map((c) => ({
					brandId,
					name: c.name,
					domains: c.domains,
					aliases: c.aliases,
				})),
			);
		}

		return tx.query.competitors.findMany({
			where: activeCompetitorsOf(brandId),
			orderBy: competitorRosterOrder,
		});
	});
}
