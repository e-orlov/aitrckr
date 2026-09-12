/**
 * The Sentiment page body: the shared metric-summary card with the sentiment
 * rings (upper left), the trend (upper right) and the expandable leaderboard,
 * driven by the overview server function. States: skeleton, no responses,
 * mention detection pending, partially classified, error with retry.
 */

import { type SentimentSortKey, sortEntityRows } from "@workspace/lib/sentiment/metrics";
import { Button } from "@workspace/ui/components/button";
import { Card, CardContent, CardHeader } from "@workspace/ui/components/card";
import { Skeleton } from "@workspace/ui/components/skeleton";
import { TooltipProvider } from "@workspace/ui/components/tooltip";
import { type ReactNode, useState } from "react";
import { MetricLegend } from "@/components/metric-summary/metric-legend";
import { MetricCardTitle, MetricSummaryCard } from "@/components/metric-summary/metric-summary-card";
import { SentimentEvidencePanels } from "@/components/sentiment/evidence-panels";
import { formatMentionCount, formatScore, longDate } from "@/components/sentiment/format";
import { SentimentLeaderboard } from "@/components/sentiment/leaderboard";
import { buildSentimentRings, SentimentRadialChart, sentimentLegendItems } from "@/components/sentiment/radial";
import { SentimentTrendChart } from "@/components/sentiment/trend-chart";
import { type SentimentFilters, useSentimentOverview } from "@/hooks/use-sentiment";
import { useSiteIcons } from "@/hooks/use-site-icons";
import { SENTIMENT_ASPECT_OPTIONS } from "@/lib/sentiment-search";
import type { SentimentEntityRow, SentimentOverviewResponse } from "@/server/sentiment";

export const SENTIMENT_TIPS = {
	summary:
		"How positively the AI answers in the selected period describe each brand when they mention it: the mean of per-answer scores from 0 (maximally negative) to 100 (unequivocal endorsement); 50 is neutral. Shown beside every score is the number of mentions the score rests on. This is the selected-period aggregate, not the latest run.",
	trends:
		"Mean sentiment of the classified mentions inside each time bucket, on the same 0–100 scale; the dashed line marks the neutral midpoint 50. A bucket without classified mentions is left blank — nothing is carried forward.",
	leaderboard:
		"Every tracked competitor and your brand. Sentiment is shown with its sample size; the visibility columns share one denominator — the evaluated responses in the period.",
} as const;

export function SentimentSkeleton() {
	return (
		<div className="space-y-6" data-testid="sentiment-loading">
			<div className="grid gap-6 lg:grid-cols-2">
				<Card>
					<CardHeader>
						<Skeleton className="h-6 w-40" />
					</CardHeader>
					<CardContent className="space-y-3">
						<Skeleton className="h-10 w-24" />
						<Skeleton className="h-4 w-3/4" />
						<Skeleton className="h-[220px] w-full" />
					</CardContent>
				</Card>
				<Card>
					<CardHeader>
						<Skeleton className="h-6 w-40" />
					</CardHeader>
					<CardContent>
						<Skeleton className="h-[220px] w-full" />
					</CardContent>
				</Card>
			</div>
			<Card>
				<CardContent className="space-y-2 pt-6">
					<Skeleton className="h-4 w-full" />
					<Skeleton className="h-4 w-5/6" />
				</CardContent>
			</Card>
		</div>
	);
}

export function SentimentEmpty() {
	return (
		<Card data-testid="sentiment-empty">
			<CardContent className="pt-6">
				<div className="text-muted-foreground py-8 text-center">
					No stored responses for the selected filters yet. Sentiment appears once your prompts have been run.
				</div>
			</CardContent>
		</Card>
	);
}

export function SentimentError({ onRetry }: { onRetry: () => void }) {
	return (
		<Card data-testid="sentiment-error">
			<CardContent className="flex flex-wrap items-center gap-3 pt-6 text-sm" role="alert">
				<span className="text-destructive">Sentiment could not be loaded.</span>
				<Button type="button" size="sm" variant="outline" onClick={onRetry}>
					Retry
				</Button>
			</CardContent>
		</Card>
	);
}

/**
 * Presentation only: the three cards for one loaded overview. Expansion state
 * and the expanded content are owned by the caller so Storybook can render
 * evidence fixtures without the network.
 */
export function SentimentCards({
	data,
	sortKey,
	expandedKey,
	onToggle,
	domainFor,
	renderExpanded,
}: {
	data: SentimentOverviewResponse;
	sortKey: SentimentSortKey;
	expandedKey: string | null;
	onToggle: (key: string) => void;
	domainFor: (name: string) => string | undefined;
	renderExpanded: (row: SentimentEntityRow) => ReactNode;
}) {
	if (data.eligibleResponses === 0) return <SentimentEmpty />;
	const brandRow = data.entities.find((row) => row.isBrand);
	const rings = buildSentimentRings(data.chartRoster, data.entities);
	const sorted = sortEntityRows(data.entities, sortKey);
	const aspectLabel = SENTIMENT_ASPECT_OPTIONS.find((o) => o.value === data.aspect)?.label ?? "Overall";
	const detectionPending = data.coverage.responsesDetected < data.eligibleResponses;
	const classificationPending = data.coverage.analyses.pending > 0 || data.entities.some((row) => row.metrics.partial);
	const noClassifications = data.entities.every((row) => row.classified === 0);
	const period = `${longDate(data.dateRange.fromDate)} – ${longDate(data.dateRange.toDate)}`;

	return (
		<TooltipProvider delay={150}>
			<div className="space-y-6">
				{(detectionPending || classificationPending || data.coverage.analyses.failed > 0) && (
					<div
						className="text-muted-foreground rounded-md border border-dashed px-3 py-2 text-xs"
						data-testid="sentiment-coverage-note"
						role="status"
					>
						{detectionPending && (
							<span>
								Mention detection covers {data.coverage.responsesDetected.toLocaleString()} of{" "}
								{data.eligibleResponses.toLocaleString()} responses so far.{" "}
							</span>
						)}
						{classificationPending && (
							<span>
								Sentiment analysis is still in progress for some mentions; scores show the analyzed part only.{" "}
							</span>
						)}
						{data.coverage.analyses.failed > 0 && (
							<span>
								{data.coverage.analyses.failed} {data.coverage.analyses.failed === 1 ? "analysis" : "analyses"} failed
								and will be retried.
							</span>
						)}
					</div>
				)}
				<div className="grid gap-6 lg:grid-cols-2">
					<MetricSummaryCard
						testId="sentiment-summary"
						title="AI Sentiment"
						infoContent={SENTIMENT_TIPS.summary}
						value={<span data-testid="sentiment-headline">{formatScore(brandRow?.metrics.sentiment)}</span>}
						description={
							brandRow ? (
								<span data-testid="sentiment-headline-mentions">
									{brandRow.name}: {formatMentionCount(brandRow)} in the selected period
									{data.aspect !== "overall" ? ` (${aspectLabel})` : ""}.
								</span>
							) : (
								"Your brand in the selected period."
							)
						}
						meta={
							brandRow ? (
								<span data-testid="sentiment-headline-meta">
									{brandRow.classified.toLocaleString()} analyzed · {brandRow.mentions.toLocaleString()} mentions ·{" "}
									{data.eligibleResponses.toLocaleString()} evaluated responses · {period}
								</span>
							) : undefined
						}
						visual={<SentimentRadialChart rings={rings} eligibleResponses={data.eligibleResponses} />}
						legend={<MetricLegend items={sentimentLegendItems(rings)} ariaLabel="Brands" testId="sentiment-legend" />}
					/>
					<Card data-testid="sentiment-trends">
						<CardHeader>
							<MetricCardTitle title="Sentiment Trends" infoContent={SENTIMENT_TIPS.trends} />
						</CardHeader>
						<CardContent>
							{noClassifications ? (
								<div className="text-muted-foreground py-8 text-center text-sm" data-testid="sentiment-trend">
									{detectionPending || classificationPending
										? "Sentiment analysis has not produced classified mentions for this period yet."
										: "No mentions of your brand or competitors were classified in this period."}
								</div>
							) : (
								<SentimentTrendChart
									roster={data.chartRoster}
									rows={data.entities}
									series={data.series}
									bucket={data.bucket}
								/>
							)}
						</CardContent>
					</Card>
				</div>
				<Card>
					<CardHeader>
						<MetricCardTitle title="Sentiment Leaderboard" infoContent={SENTIMENT_TIPS.leaderboard} />
					</CardHeader>
					<CardContent className="overflow-x-auto">
						<SentimentLeaderboard
							rows={sorted}
							chartRoster={data.chartRoster}
							eligibleResponses={data.eligibleResponses}
							expandedKey={expandedKey}
							onToggle={onToggle}
							domainFor={domainFor}
							renderExpanded={renderExpanded}
						/>
					</CardContent>
				</Card>
			</div>
		</TooltipProvider>
	);
}

export function SentimentSection({
	brandId,
	filters,
	sortKey,
	org,
	brand,
}: {
	brandId: string;
	filters: SentimentFilters;
	sortKey: SentimentSortKey;
	org: string;
	brand: string;
}) {
	const { data, isLoading, isPlaceholderData, isError, refetch } = useSentimentOverview(brandId, filters);
	const { domainFor } = useSiteIcons(brandId);
	const [expandedKey, setExpandedKey] = useState<string | null>(null);

	if (isError) return <SentimentError onRetry={() => refetch()} />;
	if (isLoading || !data || isPlaceholderData) return <SentimentSkeleton />;
	return (
		<SentimentCards
			data={data}
			sortKey={sortKey}
			expandedKey={expandedKey}
			onToggle={(key) => setExpandedKey((current) => (current === key ? null : key))}
			domainFor={domainFor}
			renderExpanded={(row) => (
				<SentimentEvidencePanels brandId={brandId} entityKey={row.key} filters={filters} org={org} brand={brand} />
			)}
		/>
	);
}
