/**
 * AI Visibility as concentric rings: one ring per entity, each filled to its own
 * Visibility on an independent 0–100 scale over a full background track. This is
 * deliberately not a segmented donut — Visibility values are not parts of one
 * whole and may sum to more than 100%.
 */
import { ChartContainer } from "@workspace/ui/components/chart";
import { Cell, PolarAngleAxis, RadialBar, RadialBarChart, Tooltip } from "recharts";
import { colorFor, entityColorMap, formatPct } from "@/components/competitive-visibility/format";
import type { MetricLegendItem } from "@/components/metric-summary/metric-legend";
import type { CompetitiveVisibilityEntity, CompetitiveVisibilitySeries } from "@/lib/competitive-visibility";

export interface CompetitiveVisibilityRing {
	key: string;
	name: string;
	isBrand: boolean;
	value: number;
	visibility: number | null;
	mentionedRuns: number;
	visiblePromptCount: number;
	coveragePercent: number | null;
	fill: string;
}

/**
 * The one ordered dataset behind the rings and the legend: brand first, then the
 * trend roster in rank order, coloured by position.
 */
export function buildCompetitiveVisibilityRings(
	series: CompetitiveVisibilitySeries[],
	entities: CompetitiveVisibilityEntity[],
): CompetitiveVisibilityRing[] {
	const colors = entityColorMap(series);
	const byKey = new Map(entities.map((e) => [e.key, e]));
	return series.flatMap((s) => {
		const e = byKey.get(s.key);
		if (!e) return [];
		return [
			{
				key: s.key,
				name: s.name,
				isBrand: s.isBrand,
				value: e.visibility ?? 0,
				visibility: e.visibility,
				mentionedRuns: e.mentionedRuns,
				visiblePromptCount: e.visiblePromptCount,
				coveragePercent: e.coveragePercent,
				fill: colorFor(colors, s.key),
			},
		];
	});
}

/** Legend rows in ring order with the same once-rounded Visibility the tooltip shows. */
export function competitiveVisibilityLegendItems(rings: readonly CompetitiveVisibilityRing[]): MetricLegendItem[] {
	return rings.map((r) => ({
		id: r.key,
		label: r.name,
		color: r.fill,
		valueLabel: formatPct(r.visibility),
		emphasis: r.isBrand ? "primary" : "muted",
		badgeLabel: r.isBrand ? "You" : undefined,
	}));
}

/** The rings alone (no legend), for composition inside a summary card. */
export function CompetitiveVisibilityRadialChart({
	rings,
	snapshotRuns,
	evaluatedPromptCount,
	size = 220,
}: {
	rings: readonly CompetitiveVisibilityRing[];
	snapshotRuns: number;
	evaluatedPromptCount: number;
	/** Chart side in px — explicit so it measures the same wherever it renders. */
	size?: number;
}) {
	// Recharts draws the first datum innermost, so the rings are fed in reverse to
	// put the brand on the outside.
	const drawn = [...rings].reverse();
	const summary = rings.map((r) => `${r.name} ${formatPct(r.visibility)}`).join(", ");
	return (
		<div
			role="img"
			data-testid="competitive-visibility-radial"
			aria-label={`AI Visibility rings, each on its own 0 to 100 percent scale: ${summary}`}
			className="shrink-0"
		>
			<ChartContainer config={{}} className="aspect-square" style={{ height: size, width: size }}>
				<RadialBarChart
					data={drawn}
					innerRadius="32%"
					outerRadius="100%"
					startAngle={90}
					endAngle={-270}
					barCategoryGap={rings.length > 4 ? 2 : 4}
				>
					<PolarAngleAxis type="number" domain={[0, 100]} tick={false} axisLine={false} />
					<RadialBar dataKey="value" background cornerRadius={3} isAnimationActive={false}>
						{drawn.map((r) => (
							<Cell key={r.key} fill={r.fill} />
						))}
					</RadialBar>
					<Tooltip
						isAnimationActive={false}
						cursor={false}
						content={({ active, payload }) => {
							if (!active || !payload?.length) return null;
							const ring = payload[0]?.payload as CompetitiveVisibilityRing | undefined;
							if (!ring) return null;
							return (
								<div
									data-testid="competitive-visibility-radial-tooltip"
									className="border-border/50 bg-background grid min-w-[13rem] gap-1 rounded-lg border px-2.5 py-1.5 text-xs shadow-xl"
								>
									<div className="flex items-center gap-2 font-medium">
										<span
											aria-hidden="true"
											className="h-2.5 w-2.5 shrink-0 rounded-[2px]"
											style={{ background: ring.fill }}
										/>
										<span className="truncate">{ring.name}</span>
										{ring.isBrand && <span className="text-muted-foreground">(You)</span>}
									</div>
									<dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 tabular-nums">
										<dt className="text-muted-foreground">Visibility</dt>
										<dd className="text-right font-mono">{formatPct(ring.visibility)}</dd>
										<dt className="text-muted-foreground">Mentioned in</dt>
										<dd className="text-right font-mono">
											{ring.mentionedRuns} / {snapshotRuns} eligible runs
										</dd>
										<dt className="text-muted-foreground">Visible prompts</dt>
										<dd className="text-right font-mono">
											{ring.visiblePromptCount} / {evaluatedPromptCount} ({formatPct(ring.coveragePercent)})
										</dd>
									</dl>
								</div>
							);
						}}
					/>
				</RadialBarChart>
			</ChartContainer>
		</div>
	);
}
