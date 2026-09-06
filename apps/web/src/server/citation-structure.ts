/** Server function for the Citation Structure page (owned citation URL Sankey). */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireAuthSession, requireBrandAccess } from "@/lib/auth/helpers";
import { type CitationStructureResult, loadCitationStructure } from "@/server/citation-structure-load";

export type { CitationStructureResult } from "@/server/citation-structure-load";

export const getCitationStructureFn = createServerFn({ method: "GET" })
	.validator(
		z.object({
			brandId: z.string(),
			days: z.number().int().positive().optional().default(7),
			tags: z.string().optional(),
			model: z.string().optional(),
		}),
	)
	.handler(async ({ data }): Promise<CitationStructureResult> => {
		const session = await requireAuthSession();
		await requireBrandAccess(session.user.id, data.brandId);
		return loadCitationStructure(data);
	});
