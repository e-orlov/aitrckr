/**
 * Server function for the Competitive AI Visibility overview on the Visibility
 * page: the brand and its tracked competitors under the one canonical
 * per-prompt LVCF Visibility definition, for the page's full filter scope
 * (lookback, model, tags, search, timezone). Read-only; no schema change.
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireAuthSession, requireBrandAccess } from "@/lib/auth/helpers";
import type { LookbackPeriod } from "@/lib/chart-utils";
import { LOOKBACK } from "@/server/analysis";
import { type CompetitiveVisibilityResponse, loadCompetitiveVisibility } from "@/server/competitive-visibility-load";

export type { CompetitiveVisibilityResponse } from "@/server/competitive-visibility-load";

export const getCompetitiveVisibilityFn = createServerFn({ method: "GET" })
	.validator(
		z.object({
			brandId: z.string(),
			lookback: LOOKBACK.default("1m"),
			model: z.string().optional(),
			tags: z.string().optional(),
			search: z.string().optional(),
			timezone: z.string().default("UTC"),
		}),
	)
	.handler(async ({ data }): Promise<CompetitiveVisibilityResponse> => {
		const session = await requireAuthSession();
		await requireBrandAccess(session.user.id, data.brandId);
		return loadCompetitiveVisibility({
			brandId: data.brandId,
			lookback: data.lookback as LookbackPeriod,
			model: data.model,
			tags: data.tags,
			search: data.search,
			timezone: data.timezone,
		});
	});
