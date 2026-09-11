/**
 * Server-only loader for the Competitive AI Visibility overview. Lives apart
 * from the server-fn file so the database reads stay strippable from the client
 * bundle (see `server/prompt-resolution.ts` for the why).
 */
import { activeCompetitorsOf } from "@workspace/lib/db/competitors";
import { db } from "@workspace/lib/db/db";
import { brands, competitors } from "@workspace/lib/db/schema";
import { eq } from "drizzle-orm";
import { generateDateRange, type LookbackPeriod } from "@/lib/chart-utils";
import { type CompetitiveVisibilityResult, computeCompetitiveVisibility } from "@/lib/competitive-visibility";
import {
	getCitationsTotalCount,
	getPerPromptDailyCompetitorRuns,
	getPerPromptVisibilityTimeSeries,
} from "@/lib/postgres-read";
import { resolveRange } from "@/server/analysis";
import { resolveFilteredPrompts } from "@/server/prompt-resolution";

export interface CompetitiveVisibilityResponse extends CompetitiveVisibilityResult {
	brand: { id: string; name: string };
	dateRange: { fromDate: string; toDate: string };
	/** Citations recorded in the window for the same prompts and model. Informational. */
	windowCitations: number;
}

export interface CompetitiveVisibilityScope {
	brandId: string;
	lookback: LookbackPeriod;
	model?: string;
	tags?: string;
	search?: string;
	timezone: string;
}

const EMPTY: CompetitiveVisibilityResult = {
	asOfDate: null,
	snapshotRuns: 0,
	evaluatedPromptCount: 0,
	windowRuns: 0,
	entities: [],
	series: [],
	points: [],
};

export async function loadCompetitiveVisibility(
	scope: CompetitiveVisibilityScope,
): Promise<CompetitiveVisibilityResponse> {
	const { timezone, fromDateStr, toDateStr } = resolveRange(scope.lookback, scope.timezone);
	const dateRange = { fromDate: fromDateStr, toDate: toDateStr };

	const [brandRows, roster, resolved] = await Promise.all([
		db.select({ id: brands.id, name: brands.name }).from(brands).where(eq(brands.id, scope.brandId)).limit(1),
		db
			.select({ id: competitors.id, name: competitors.name })
			.from(competitors)
			.where(activeCompetitorsOf(scope.brandId)),
		resolveFilteredPrompts(scope.brandId, { tags: scope.tags, search: scope.search }),
	]);
	const brandRow = brandRows[0];
	if (!brandRow) throw new Error("Brand not found");
	const brand = { id: brandRow.id, name: brandRow.name };
	const promptIds = resolved.map((p) => p.id);

	// Nothing matches the filters: a valid empty payload, and no run query at all.
	if (promptIds.length === 0) {
		return { ...EMPTY, brand, dateRange, windowCitations: 0 };
	}

	const [promptRuns, competitorRuns, windowCitations] = await Promise.all([
		getPerPromptVisibilityTimeSeries(scope.brandId, fromDateStr, toDateStr, timezone, promptIds, scope.model),
		getPerPromptDailyCompetitorRuns(scope.brandId, fromDateStr, toDateStr, timezone, promptIds, scope.model),
		getCitationsTotalCount(scope.brandId, fromDateStr, toDateStr, timezone, promptIds, scope.model),
	]);

	const result = computeCompetitiveVisibility(
		brand,
		roster,
		promptRuns.map((r) => ({
			promptId: r.prompt_id,
			date: String(r.date),
			runs: Number(r.total_runs),
			brandRuns: Number(r.brand_mentioned_count),
		})),
		competitorRuns.map((r) => ({
			promptId: r.prompt_id,
			date: String(r.date),
			competitor: r.competitor,
			runs: Number(r.runs),
		})),
		generateDateRange(new Date(fromDateStr), new Date(toDateStr)),
	);

	return { ...result, brand, dateRange, windowCitations: Number(windowCitations) };
}
