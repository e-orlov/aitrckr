/**
 * Competitive AI Visibility overview at the top of the Visibility page: the
 * brand's headline Visibility with a radial comparison against its top
 * competitors, the same entities over time, and a leaderboard of every tracked
 * competitor. One query feeds all three cards so they always describe the same
 * snapshot for the same filters.
 */
import { IconInfoCircle } from "@tabler/icons-react";
import { Card, CardContent, CardHeader, CardTitle } from "@workspace/ui/components/card";
import { Skeleton } from "@workspace/ui/components/skeleton";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@workspace/ui/components/tooltip";
import type { ReactNode } from "react";
import { formatPct, longDate } from "@/components/competitive-visibility/format";
import { CompetitiveVisibilityLeaderboard } from "@/components/competitive-visibility/leaderboard";
import { CompetitiveVisibilityRadial } from "@/components/competitive-visibility/radial";
import { CompetitiveVisibilityTrendChart } from "@/components/competitive-visibility/trend-chart";
import { browserTimezone, useCompetitiveVisibility } from "@/hooks/use-competitive-visibility";
import { useSiteIcons } from "@/hooks/use-site-icons";
import type { LookbackPeriod } from "@/lib/chart-utils";
import { BRAND_SERIES_KEY } from "@/lib/competitive-visibility";
import type { CompetitiveVisibilityResponse } from "@/server/competitive-visibility";

const TIPS = {
	visibility:
		"Each brand is measured independently: the percentage of eligible AI responses that mention it, from the same responses and the same prompts. The rings share one 0–100% scale and do not add up to 100%.",
	trends:
		"Daily Visibility of your brand and its top competitors. Each prompt's latest response is carried forward on days it did not run, so staggered schedules do not create artificial dips.",
	leaderboard: "Every tracked competitor, ranked by Visibility. Configure competitors in Settings.",
};

const RADIAL_HEIGHT = 220;
const TREND_HEIGHT = 220;

export interface CompetitiveVisibilitySectionFilters {
	lookback: LookbackPeriod;
	model?: string;
	tags?: string[];
	search?: string;
}

export function CompetitiveVisibilitySection({
	brandId,
	filters,
}: {
	brandId: string | undefined;
	filters: CompetitiveVisibilitySectionFilters;
}) {
	const { data, isLoading, isPlaceholderData, isError } = useCompetitiveVisibility(brandId, {
		...filters,
		timezone: browserTimezone(),
	});
	const { domainFor } = useSiteIcons(brandId);

	// A previous scope's payload is only a placeholder for layout — never shown as
	// the current numbers — so a filter change shows the skeleton, not stale data.
	if (isError) {
		return <CompetitiveVisibilityError />;
	}
	if (isLoading || !data || isPlaceholderData) {
		return <CompetitiveVisibilitySkeleton />;
	}
	return <CompetitiveVisibilityCards data={data} domainFor={domainFor} />;
}

export function CompetitiveVisibilityCards({
	data,
	domainFor,
}: {
	data: CompetitiveVisibilityResponse;
	domainFor?: (name: string) => string | undefined;
}) {
	if (data.snapshotRuns === 0 || data.asOfDate === null) {
		return (
			<Card data-testid="competitive-visibility-empty">
				<CardContent className="pt-6">
					<div className="text-muted-foreground text-center py-8 text-sm">
						No visibility data for the selected time range and filters.
					</div>
				</CardContent>
			</Card>
		);
	}

	const own = data.entities.find((e) => e.key === BRAND_SERIES_KEY);
	const competitorCount = data.entities.length - 1;
	const shownCompetitors = data.series.length - 1;

	return (
		<TooltipProvider delay={150}>
			<div data-testid="competitive-visibility-section" className="space-y-6">
				<div className="grid min-w-0 gap-6 lg:grid-cols-2">
					<Card className="min-w-0">
						<CardHeader>
							<TitleWithTip title="AI Visibility" tip={TIPS.visibility} />
						</CardHeader>
						<CardContent className="flex flex-col gap-4">
							<div>
								<div
									data-testid="competitive-visibility-headline"
									className="text-3xl sm:text-4xl font-bold tabular-nums"
								>
									{formatPct(own?.visibility)}
								</div>
								<p className="text-sm text-muted-foreground mt-1">
									{data.brand.name} is mentioned in {own?.mentionedRuns ?? 0} of {data.snapshotRuns.toLocaleString()}{" "}
									eligible runs across {data.evaluatedPromptCount.toLocaleString()} evaluated prompt
									{data.evaluatedPromptCount === 1 ? "" : "s"} as of {longDate(data.asOfDate)}.
								</p>
								<p className="text-xs text-muted-foreground mt-1">
									{data.windowRuns.toLocaleString()} runs · {data.windowCitations.toLocaleString()} citations in this
									period
									{competitorCount === 0
										? " · no competitors configured"
										: shownCompetitors < competitorCount
											? ` · top ${shownCompetitors} of ${competitorCount} competitors shown, all in the leaderboard`
											: ""}
								</p>
							</div>
							<CompetitiveVisibilityRadial
								series={data.series}
								entities={data.entities}
								snapshotRuns={data.snapshotRuns}
								evaluatedPromptCount={data.evaluatedPromptCount}
								size={RADIAL_HEIGHT}
							/>
						</CardContent>
					</Card>

					<Card className="min-w-0">
						<CardHeader>
							<TitleWithTip title="Visibility Trends" tip={TIPS.trends} />
						</CardHeader>
						<CardContent>
							<CompetitiveVisibilityTrendChart series={data.series} points={data.points} height={TREND_HEIGHT} />
						</CardContent>
					</Card>
				</div>

				<Card className="min-w-0">
					<CardHeader>
						<TitleWithTip title="Visibility Leaderboard" tip={TIPS.leaderboard} />
					</CardHeader>
					<CardContent>
						<CompetitiveVisibilityLeaderboard
							series={data.series}
							entities={data.entities}
							evaluatedPromptCount={data.evaluatedPromptCount}
							domainFor={domainFor}
						/>
					</CardContent>
				</Card>
			</div>
		</TooltipProvider>
	);
}

function TitleWithTip({ title, tip }: { title: string; tip: string }) {
	return (
		<CardTitle className="flex items-center gap-1.5">
			{title}
			<Tooltip>
				<TooltipTrigger
					render={<button type="button" aria-label={`About ${title}`} className="text-muted-foreground cursor-help" />}
				>
					<IconInfoCircle className="h-3.5 w-3.5" />
				</TooltipTrigger>
				<TooltipContent className="max-w-xs text-sm font-normal">{tip}</TooltipContent>
			</Tooltip>
		</CardTitle>
	);
}

export function CompetitiveVisibilitySkeleton() {
	const card = (body: ReactNode) => (
		<Card className="min-w-0">
			<CardHeader>
				<Skeleton className="h-5 w-40" />
			</CardHeader>
			<CardContent>{body}</CardContent>
		</Card>
	);
	return (
		<div data-testid="competitive-visibility-loading" aria-busy="true" className="space-y-6">
			<div className="grid gap-6 lg:grid-cols-2">
				{card(
					<div className="flex flex-col gap-4">
						<Skeleton className="h-10 w-24" />
						<Skeleton className="h-4 w-3/4" />
						<div className="flex items-center gap-4">
							<Skeleton className="rounded-full" style={{ height: RADIAL_HEIGHT, width: RADIAL_HEIGHT }} />
							<div className="flex-1 space-y-2">
								<Skeleton className="h-3 w-full" />
								<Skeleton className="h-3 w-5/6" />
								<Skeleton className="h-3 w-2/3" />
							</div>
						</div>
					</div>,
				)}
				{card(<Skeleton style={{ height: TREND_HEIGHT + 28 }} className="w-full" />)}
			</div>
			{card(
				<div className="space-y-3">
					<Skeleton className="h-4 w-full" />
					<Skeleton className="h-4 w-full" />
					<Skeleton className="h-4 w-5/6" />
				</div>,
			)}
		</div>
	);
}

export function CompetitiveVisibilityError() {
	return (
		<Card data-testid="competitive-visibility-error" role="alert">
			<CardContent className="pt-6">
				<div className="text-muted-foreground text-center py-6 text-sm">
					<p className="mb-1">Couldn't load the competitive visibility overview.</p>
					<p className="text-xs">The prompt list below is unaffected. Try refreshing the page.</p>
				</div>
			</CardContent>
		</Card>
	);
}
