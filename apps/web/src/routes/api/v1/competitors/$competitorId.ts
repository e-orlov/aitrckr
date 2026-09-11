/**
 * /api/v1/competitors/:competitorId — single competitor resource.
 *
 * GET     fetch one competitor
 * PATCH   update name / domains / aliases (replace semantics on arrays)
 * DELETE  remove the competitor from the brand's roster (returns the removed competitor)
 *
 * Removal is a soft state change: the row and its id stay in the database so
 * historical analytics keep their identity, and it disappears from every
 * current-roster surface. A removed competitor is not addressable here.
 *
 * Protected by API key authentication.
 */
import { createFileRoute } from "@tanstack/react-router";
import { db } from "@workspace/lib/db/db";
import { competitors } from "@workspace/lib/db/schema";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { ApiError, createApiHandler } from "@/lib/api/handler";
import { dedupeAliases, dedupeDomains } from "@/lib/domain-categories";

// z.guid(), not z.uuid(): matches the loose 8-4-4-4-12 hex check this API has
// always used; z.uuid() enforces RFC version bits and rejects existing IDs.
const competitorParams = z.object({ competitorId: z.guid("Invalid competitor ID format") });

const activeById = (competitorId: string) => and(eq(competitors.id, competitorId), eq(competitors.active, true));

const updateCompetitorBody = z
	.object({
		name: z.string().trim().min(1, "name must be a non-empty string").optional(),
		domains: z.array(z.string()).optional(),
		aliases: z.array(z.string()).optional(),
	})
	.refine((body) => Object.keys(body).length > 0, "At least one of name, domains, or aliases must be provided");

export const Route = createFileRoute("/api/v1/competitors/$competitorId")({
	server: {
		handlers: {
			GET: createApiHandler({
				params: competitorParams,
				handle: async ({ params }) => {
					const row = await db.query.competitors.findFirst({ where: activeById(params.competitorId) });
					if (!row) {
						throw new ApiError(404, "Not Found", `Competitor with ID '${params.competitorId}' not found`);
					}
					return row;
				},
			}),

			PATCH: createApiHandler({
				params: competitorParams,
				body: updateCompetitorBody,
				handle: async ({ params, body }) => {
					const { competitorId } = params;

					const existing = await db.query.competitors.findFirst({ where: activeById(competitorId) });
					if (!existing) {
						throw new ApiError(404, "Not Found", `Competitor with ID '${competitorId}' not found`);
					}

					const update: Partial<typeof competitors.$inferInsert> = {};
					if (body.name !== undefined && body.name !== existing.name) {
						update.name = body.name;
						update.previousNames = [...existing.previousNames, existing.name];
					}
					if (body.domains !== undefined) {
						update.domains = dedupeDomains(body.domains);
					}
					if (body.aliases !== undefined) {
						update.aliases = dedupeAliases(body.aliases);
					}

					const [updated] = await db.update(competitors).set(update).where(activeById(competitorId)).returning();
					// The existence check above can race with a concurrent removal;
					// the update's returning() is the source of truth.
					if (!updated) {
						throw new ApiError(404, "Not Found", `Competitor with ID '${competitorId}' not found`);
					}
					return updated;
				},
			}),

			DELETE: createApiHandler({
				params: competitorParams,
				handle: async ({ params }) => {
					const now = new Date();
					const [removed] = await db
						.update(competitors)
						.set({ active: false, removedAt: now, updatedAt: now })
						.where(activeById(params.competitorId))
						.returning();
					if (!removed) {
						throw new ApiError(404, "Not Found", `Competitor with ID '${params.competitorId}' not found`);
					}
					return removed;
				},
			}),
		},
	},
});
