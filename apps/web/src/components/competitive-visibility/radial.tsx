/**
 * AI Visibility as concentric rings: one ring per entity, each filled to its own
 * Visibility on an independent 0–100 scale over a full background track. This is
 * deliberately not a segmented donut — Visibility values are not parts of one
 * whole and may sum to more than 100%.
 */
import { Badge } from "@workspace/ui/components/badge";
import { ChartContainer } from "@workspace/ui/components/chart";
import { Cell, PolarAngleAxis, RadialBar, RadialBarChart, Tooltip } from "recharts";
import { colorFor, entityColorMap, formatPct } from "@/components/competitive-visibility/format";
import type { CompetitiveVisibilityEntity, CompetitiveVisibilitySeries } from "@/lib/competitive-visibility";

interface Ring {
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

export function CompetitiveVisibilityRadial({
	series,
	entities,
	snapshotRuns,
	evaluatedPromptCount,
	size = 220,
}: {
	series: CompetitiveVisibilitySeries[];
	entities: CompetitiveVisibilityEntity[];
	snapshotRuns: number;
	evaluatedPromptCount: number;
	/** Chart side in px — explicit so it measures the same wherever it renders. */
	size?: number;
}) {
	const colors = entityColorMap(series);
	const byKey = new Map(entities.map((e) => [e.key, e]));
	// Legend order: brand first, then rank. Recharts draws the first datum
	// innermost, so the rings are fed in reverse to put the brand on the outside.
	const rings: Ring[] = series.flatMap((s) => {
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
	const drawn = [...rings].reverse();
	const summary = rings.map((r) => `${r.name} ${formatPct(r.visibility)}`).join(", ");

	if (rings.length === 0) return null;

	return (
		<div
			data-testid="competitive-visibility-radial"
			className="flex flex-col items-center gap-3 sm:flex-row sm:items-center"
		>
			<div
				role="img"
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
								const ring = payload[0]?.payload as Ring | undefined;
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
			<ul aria-label="Brands" data-testid="competitive-visibility-radial-legend" className="min-w-0 grid gap-1 text-xs">
				{rings.map((r) => (
					<li key={r.key} className="flex min-w-0 items-center gap-2" data-entity={r.key}>
						<span
							aria-hidden="true"
							className={`shrink-0 rounded-full ${r.isBrand ? "h-3 w-3" : "h-2.5 w-2.5"}`}
							style={{ background: r.fill }}
						/>
						<span className={`min-w-0 truncate ${r.isBrand ? "font-medium" : "text-muted-foreground"}`} title={r.name}>
							{r.name}
						</span>
						{r.isBrand && (
							<Badge variant="secondary" className="px-1.5 py-0 text-[10px]">
								You
							</Badge>
						)}
						<span className="ml-auto font-mono tabular-nums">{formatPct(r.visibility)}</span>
					</li>
				))}
			</ul>
		</div>
	);
}
