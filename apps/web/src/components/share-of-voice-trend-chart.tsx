/**
 * Share of Voice Trends: the brand, its top competitors and the Others tail as
 * separate lines over time, with one tooltip shared across the plot — pointing
 * anywhere at a date lists every series' share for that date in a fixed order.
 *
 * Dedicated to the Share of Voice page; the overview keeps its single-series
 * TrendChart. Which competitors are shown, their order, and the Others sum are
 * decided by the server (see shareOfVoiceComparisonTimeSeriesLVCF) — this
 * component only styles and formats them.
 */

import { type ChartConfig, ChartContainer, ChartTooltip } from "@workspace/ui/components/chart";
import { CartesianGrid, Line, LineChart, XAxis, YAxis } from "recharts";
import { shareOfVoiceTrendSeriesColor } from "@/lib/share-of-voice-palette";
import type { ShareOfVoiceComparisonTrend, ShareOfVoiceTrendSeries } from "@/lib/visibility-stats";

type Row = { date: string } & Record<string, number | null | string>;

interface SeriesStyle extends ShareOfVoiceTrendSeries {
	color: string;
	strokeWidth: number;
	dashed: boolean;
}

/** Build a local Date from a "YYYY-MM-DD" string (avoids the UTC off-by-one of `new Date(iso)`). */
function localDate(value: string): Date {
	const [year, month, day] = value.split("-").map(Number);
	return new Date(year, month - 1, day);
}
const shortDate = (value: string) => localDate(value).toLocaleDateString("en-US", { month: "short", day: "numeric" });
const longDate = (value: string) =>
	localDate(value).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });

/** The one place a share becomes text: round once, at display time. */
const formatPct = (value: number) => `${Math.round(value)}%`;

function styleSeries(series: ShareOfVoiceTrendSeries[]): SeriesStyle[] {
	let competitorRank = 0;
	return series.map((s) => {
		const color = shareOfVoiceTrendSeriesColor(s.kind, s.kind === "competitor" ? competitorRank++ : 0);
		return {
			...s,
			color,
			strokeWidth: s.kind === "brand" ? 2.75 : s.kind === "competitor" ? 1.75 : 1.5,
			dashed: s.kind === "others",
		};
	});
}

/** Top of the y axis: the next 10% step above the data, never above 100%. */
function yAxisMax(dataMax: number): number {
	if (!Number.isFinite(dataMax) || dataMax <= 0) return 100;
	return Math.min(100, Math.max(10, Math.ceil(dataMax / 10) * 10));
}

export function ShareOfVoiceTrendChart({
	trend,
	height = 180,
}: {
	trend: ShareOfVoiceComparisonTrend;
	/** Plot height in px; the legend wraps below it. Explicit so the chart measures the same wherever it renders. */
	height?: number;
}) {
	const styles = styleSeries(trend.series);
	const rows: Row[] = trend.points.map((p) => ({ date: p.date, ...p.values }));
	const config = Object.fromEntries(
		styles.map((s) => [s.key, { label: s.name, color: s.color }]),
	) satisfies ChartConfig;

	if (styles.length === 0 || rows.length === 0) {
		return (
			<div data-testid="share-of-voice-trend-chart" className="text-muted-foreground py-8 text-center text-sm">
				No trend data for the selected filters.
			</div>
		);
	}

	return (
		<div data-testid="share-of-voice-trend-chart" className="flex flex-col">
			<ChartContainer config={config} className="aspect-auto w-full" style={{ height }}>
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
						domain={[0, yAxisMax]}
						allowDecimals={false}
						tickLine={false}
						axisLine={false}
						tickMargin={8}
						tickCount={5}
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
									data-testid="share-of-voice-trend-tooltip"
									className="border-border/50 bg-background grid min-w-[12rem] items-start gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs shadow-xl"
								>
									<div className="font-medium">{longDate(String(label))}</div>
									<div className="grid gap-1">
										{styles.map((s) => {
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
					{styles.map((s) => (
						<Line
							key={s.key}
							dataKey={s.key}
							name={s.name}
							type="monotone"
							stroke={s.color}
							strokeWidth={s.strokeWidth}
							strokeDasharray={s.dashed ? "5 4" : undefined}
							dot={false}
							activeDot={{ r: 4, strokeWidth: 0 }}
							connectNulls
						/>
					))}
				</LineChart>
			</ChartContainer>
			<ul
				aria-label="Series"
				data-testid="share-of-voice-trend-legend"
				className="text-muted-foreground mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs"
			>
				{styles.map((s) => (
					<li key={s.key} className="flex min-w-0 items-center gap-1.5" data-series={s.key}>
						<svg aria-hidden="true" width="18" height="6" className="shrink-0">
							<line
								x1="0"
								y1="3"
								x2="18"
								y2="3"
								stroke={s.color}
								strokeWidth={s.kind === "brand" ? 3 : 2}
								strokeDasharray={s.dashed ? "4 3" : undefined}
							/>
						</svg>
						<span className="max-w-[12rem] truncate" title={s.name}>
							{s.name}
						</span>
					</li>
				))}
			</ul>
		</div>
	);
}
