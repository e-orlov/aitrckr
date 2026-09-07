/**
 * Visibility Trends: the brand and its top competitors as independent lines on a
 * fixed 0–100% axis, one tooltip shared across the plot (pointing anywhere at a
 * date lists every shown series in a fixed order), and a legend whose items
 * toggle their line. Which competitors appear, and in which order, is decided by
 * the server roster — this component only styles and formats them.
 */
import { type ChartConfig, ChartContainer, ChartTooltip } from "@workspace/ui/components/chart";
import { useState } from "react";
import { CartesianGrid, Line, LineChart, XAxis, YAxis } from "recharts";
import { colorFor, entityColorMap, formatPct, longDate, shortDate } from "@/components/competitive-visibility/format";
import type { CompetitiveVisibilityPoint, CompetitiveVisibilitySeries } from "@/lib/competitive-visibility";

type Row = { date: string; runs: number | null } & Record<string, number | null | string>;

export function CompetitiveVisibilityTrendChart({
	series,
	points,
	height = 220,
}: {
	series: CompetitiveVisibilitySeries[];
	points: CompetitiveVisibilityPoint[];
	/** Plot height in px; the legend wraps below it. Explicit so the chart measures the same wherever it renders. */
	height?: number;
}) {
	const [hidden, setHidden] = useState<ReadonlySet<string>>(() => new Set());
	const colors = entityColorMap(series);
	const styled = series.map((s) => ({ ...s, color: colorFor(colors, s.key), strokeWidth: s.isBrand ? 2.75 : 1.75 }));
	const rows: Row[] = points.map((p) => ({ date: p.date, runs: p.runs, ...p.visibility }));
	const config = Object.fromEntries(
		styled.map((s) => [s.key, { label: s.name, color: s.color }]),
	) satisfies ChartConfig;

	if (styled.length === 0 || rows.length === 0) {
		return (
			<div data-testid="competitive-visibility-trend" className="text-muted-foreground py-8 text-center text-sm">
				No trend data for the selected filters.
			</div>
		);
	}

	const toggle = (key: string) =>
		setHidden((prev) => {
			const next = new Set(prev);
			if (next.has(key)) next.delete(key);
			else next.add(key);
			return next;
		});

	return (
		<div data-testid="competitive-visibility-trend" className="flex min-w-0 flex-col">
			<ChartContainer
				config={config}
				className="aspect-auto w-full"
				style={{ height }}
				role="img"
				aria-label={`Visibility over time for ${styled.map((s) => s.name).join(", ")}, 0 to 100 percent`}
			>
				<LineChart data={rows} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
					<CartesianGrid vertical={false} strokeDasharray="3 3" />
					<XAxis
						dataKey="date"
						tickLine={false}
						axisLine={false}
						tickMargin={8}
						minTickGap={50}
						tick={{ fontSize: 11 }}
						tickFormatter={shortDate}
					/>
					<YAxis
						domain={[0, 100]}
						allowDecimals={false}
						tickLine={false}
						axisLine={false}
						tickMargin={8}
						ticks={[0, 25, 50, 75, 100]}
						tick={{ fontSize: 11 }}
						tickFormatter={(value: number) => `${value}%`}
					/>
					<ChartTooltip
						isAnimationActive={false}
						content={({ active, payload, label }) => {
							if (!active || !payload?.length) return null;
							const row = payload[0]?.payload as Row | undefined;
							if (!row) return null;
							return (
								<div
									data-testid="competitive-visibility-trend-tooltip"
									className="border-border/50 bg-background grid min-w-[12rem] items-start gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs shadow-xl"
								>
									<div className="font-medium">{longDate(String(label))}</div>
									{typeof row.runs === "number" && (
										<div className="text-muted-foreground">{row.runs.toLocaleString()} eligible runs</div>
									)}
									<div className="grid gap-1">
										{styled.map((s) => {
											if (hidden.has(s.key)) return null;
											const value = row[s.key];
											if (typeof value !== "number") return null;
											return (
												<div key={s.key} className="flex items-center gap-2" data-series={s.key}>
													<span
														aria-hidden="true"
														className="h-2.5 w-2.5 shrink-0 rounded-[2px]"
														style={{ background: s.color }}
													/>
													<span className="text-muted-foreground max-w-[14rem] truncate" title={s.name}>
														{s.name}
													</span>
													<span className="ml-auto font-mono tabular-nums">{formatPct(value)}</span>
												</div>
											);
										})}
									</div>
								</div>
							);
						}}
					/>
					{styled.map((s) => (
						<Line
							key={s.key}
							dataKey={s.key}
							name={s.name}
							type="monotone"
							stroke={s.color}
							strokeWidth={s.strokeWidth}
							dot={false}
							activeDot={{ r: 4, strokeWidth: 0 }}
							connectNulls={false}
							hide={hidden.has(s.key)}
						/>
					))}
				</LineChart>
			</ChartContainer>
			<ul
				aria-label="Series"
				data-testid="competitive-visibility-trend-legend"
				className="text-muted-foreground mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs"
			>
				{styled.map((s) => {
					const shown = !hidden.has(s.key);
					return (
						<li key={s.key} className="flex min-w-0 items-center" data-series={s.key}>
							<button
								type="button"
								aria-pressed={shown}
								onClick={() => toggle(s.key)}
								title={`${shown ? "Hide" : "Show"} ${s.name}`}
								className={`flex min-w-0 cursor-pointer items-center gap-1.5 rounded px-1 py-0.5 hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring ${shown ? "" : "line-through opacity-50"}`}
							>
								<svg aria-hidden="true" width="18" height="6" className="shrink-0">
									<line x1="0" y1="3" x2="18" y2="3" stroke={s.color} strokeWidth={s.isBrand ? 3 : 2} />
								</svg>
								<span className={`max-w-[12rem] truncate ${s.isBrand ? "text-foreground font-medium" : ""}`}>
									{s.name}
									{s.isBrand ? " (You)" : ""}
								</span>
							</button>
						</li>
					);
				})}
			</ul>
		</div>
	);
}
