import { db } from "@workspace/lib/db/db";
import { competitors } from "@workspace/lib/db/schema";
import { assertAllowed, decideCompetitorCap } from "@workspace/lib/entitlements";
import { eq } from "drizzle-orm";
import { cleanAndValidateDomain } from "@/lib/domain-categories";
import { PublicError } from "@/lib/public-errors";

export interface SubmittedCompetitor {
	name: string;
	domains: string[];
	aliases: string[];
}

/**
 * Persist the roster the settings editor submits. A bulk replace: the list
 * submitted is the list the brand ends up with.
 */
export async function saveCompetitorRoster(brandId: string, submitted: SubmittedCompetitor[]) {
	assertAllowed(decideCompetitorCap(submitted.length));

	const cleaned = submitted.map((c) => {
		const cleanedDomains = c.domains.map((d) => cleanAndValidateDomain(d));
		const invalid = c.domains.filter((_, i) => !cleanedDomains[i]);
		if (invalid.length > 0) {
			throw new PublicError("competitor-domains", `Invalid domain(s) for "${c.name}": ${invalid.join(", ")}`);
		}
		return {
			name: c.name,
			domains: cleanedDomains.filter(Boolean) as string[],
			aliases: c.aliases,
		};
	});

	return db.transaction(async (tx) => {
		await tx.delete(competitors).where(eq(competitors.brandId, brandId));

		if (cleaned.length > 0) {
			await tx.insert(competitors).values(
				cleaned.map((c) => ({
					brandId,
					name: c.name,
					domains: c.domains,
					aliases: c.aliases,
				})),
			);
		}

		return tx.query.competitors.findMany({
			where: eq(competitors.brandId, brandId),
		});
	});
}
