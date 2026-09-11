/**
 * Shared shell of the top summary card on a metric page: title with an
 * information tip, headline value, full-width explanation, optional metadata,
 * then one visual group holding the metric's own chart and its legend list.
 * The shell knows nothing about the metric — every slot is display-ready
 * content supplied by the caller.
 */
import { IconInfoCircle } from "@tabler/icons-react";
import { Card, CardContent, CardHeader } from "@workspace/ui/components/card";
import { Tooltip, TooltipContent, TooltipTrigger } from "@workspace/ui/components/tooltip";
import { cn } from "@workspace/ui/lib/utils";
import type { ReactNode } from "react";

export interface MetricSummaryCardProps {
	/** Plain text so the info button can be named "About {title}". */
	readonly title: string;
	readonly infoContent: ReactNode;
	/** Headline value, already formatted. */
	readonly value: ReactNode;
	readonly description: ReactNode;
	/** Secondary line under the description; omitted entirely when absent. */
	readonly meta?: ReactNode;
	/** The metric's chart, sized by the caller. */
	readonly visual: ReactNode;
	/** The metric's legend list (normally a `MetricLegend`). */
	readonly legend: ReactNode;
	readonly testId?: string;
	readonly className?: string;
}

export function MetricSummaryCard({
	title,
	infoContent,
	value,
	description,
	meta,
	visual,
	legend,
	testId,
	className,
}: MetricSummaryCardProps) {
	const hasMeta = meta !== undefined && meta !== null && meta !== false;
	const hasVisual =
		(visual !== undefined && visual !== null && visual !== false) ||
		(legend !== undefined && legend !== null && legend !== false);
	return (
		<Card data-testid={testId} className={cn("min-w-0", className)}>
			<CardHeader>
				<MetricCardTitle title={title} infoContent={infoContent} />
			</CardHeader>
			<CardContent className="@container/metric-summary flex flex-col gap-4">
				<div data-slot="metric-summary-text">
					<div data-slot="metric-summary-value" className="text-3xl sm:text-4xl font-bold tabular-nums">
						{value}
					</div>
					<p className="text-sm text-muted-foreground mt-1">{description}</p>
					{hasMeta && (
						<p data-slot="metric-summary-meta" className="text-xs text-muted-foreground mt-1">
							{meta}
						</p>
					)}
				</div>
				{hasVisual && <MetricVisualGroup visual={visual} legend={legend} />}
			</CardContent>
		</Card>
	);
}

/** Card heading with the information affordance, shared by every metric card. */
export function MetricCardTitle({ title, infoContent }: { readonly title: string; readonly infoContent: ReactNode }) {
	return (
		<h2 data-slot="card-title" className="flex items-center gap-1.5 leading-none font-semibold">
			{title}
			<Tooltip>
				<TooltipTrigger
					render={<button type="button" aria-label={`About ${title}`} className="text-muted-foreground cursor-help" />}
				>
					<IconInfoCircle className="h-3.5 w-3.5" />
				</TooltipTrigger>
				<TooltipContent className="max-w-xs text-sm font-normal">{infoContent}</TooltipContent>
			</Tooltip>
		</h2>
	);
}

/**
 * Chart and legend side by side when the card is wide enough for both, chart
 * centred with the legend below when it is not. Driven by the card's own width
 * (container query), not the viewport, so a half-width card on a laptop and a
 * full-width card on a phone both get the right arrangement.
 */
export function MetricVisualGroup({ visual, legend }: { readonly visual: ReactNode; readonly legend: ReactNode }) {
	return (
		<div
			data-slot="metric-visual-group"
			className="flex flex-col items-center gap-3 @[24rem]/metric-summary:flex-row @[24rem]/metric-summary:items-center"
		>
			<div data-slot="metric-visual" className="shrink-0">
				{visual}
			</div>
			<div data-slot="metric-legend" className="min-w-0 max-w-full">
				{legend}
			</div>
		</div>
	);
}
