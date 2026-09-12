/**
 * Sentiment Trends: the brand and the chart-roster competitors as independent
 * lines on a fixed 0–100 axis with the neutral midpoint marked at 50, one
 * tooltip shared across the plot (score and analyzed mentions per bucket), a
 * legend whose items toggle their line, and no forward fill — a bucket without
 * classified mentions is a gap.
 */
import { type ChartConfig, ChartContainer, ChartTooltip } from "@workspace/ui/components/chart";
import { useState } from "react";
import { CartesianGrid, Line, LineChart, ReferenceLine, XAxis, YAxis } from "recharts";
import { bucketLabel, colorFor, entityColorMap, formatScore, shortDate } from "@/components/sentiment/format";
import type { SentimentEntityRow, SentimentSeriesPoint } from "@/server/sentiment";

type Row = { bucketStart: string } & Record<string, number | null | string>;

export function SentimentTrendChart({
	roster,
	rows: entityRows,
	series,
	bucket,
	height = 220,
}: {
	roster: readonly string[];
	rows: readonly SentimentEntityRow[];
	series: SentimentSeriesPoint[];
	bucket: "day" | "week" | "month";
	height?: number;
}) {
	const [hidden, setHidden] = useState<ReadonlySet<string>>(() => new Set());
	const colors = entityColorMap(roster);
	const byKey = new Map(entityRows.map((row) => [row.key, row]));
	const styled = roster.flatMap((key) => {
		const row = byKey.get(key);
		if (!row) return [];
		return [
			{
				key,
				name: row.name,
				isBrand: row.isBrand,
				color: colorFor(colors, key),
				strokeWidth: row.isBrand ? 2.75 : 1.75,
			},
		];
	});
	const rows: Row[] = series.map((point) => {
		const row: Row = { bucketStart: point.bucketStart };
		for (const key of roster) {
			row[key] = point.values[key]?.sentiment ?? null;
			row[`${key}__n`] = point.values[key]?.classified ?? 0;
		}
		return row;
	});
	const config = Object.fromEntries(
		styled.map((s) => [s.key, { label: s.name, color: s.color }]),
	) satisfies ChartConfig;
	const anyPoint = rows.some((row) => styled.some((s) => typeof row[s.key] === "number"));

	if (styled.length === 0 || rows.length === 0 || !anyPoint) {
		return (
			<div data-testid="sentiment-trend" className="text-muted-foreground py-8 text-center text-sm">
				No classified mentions in the selected period yet.
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
		<div data-testid="sentiment-trend" className="flex min-w-0 flex-col">
			<ChartContainer
				config={config}
				className="aspect-auto w-full"
				style={{ height }}
				role="img"
				aria-label={`Sentiment over time for ${styled.map((s) => s.name).join(", ")}, 0 to 100 with 50 as neutral`}
			>
				<LineChart data={rows} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
					<CartesianGrid vertical={false} strokeDasharray="3 3" />
					<XAxis
						dataKey="bucketStart"
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
					/>
					<ReferenceLine
						y={50}
						stroke="var(--muted-foreground)"
						strokeDasharray="4 4"
						strokeOpacity={0.6}
						ifOverflow="extendDomain"
					/>
					<ChartTooltip
						isAnimationActive={false}
						content={({ active, payload, label }) => {
							if (!active || !payload?.length) return null;
							const row = payload[0]?.payload as Row | undefined;
							if (!row) return null;
							return (
								<div
									data-testid="sentiment-trend-tooltip"
									className="border-border/50 bg-background grid min-w-[13rem] max-w-[min(20rem,90vw)] items-start gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs shadow-xl"
								>
									<div className="font-medium">{bucketLabel(String(label), bucket)}</div>
									<div className="grid gap-1">
										{styled.map((s) => {
											if (hidden.has(s.key)) return null;
											const value = row[s.key];
											const n = row[`${s.key}__n`];
											return (
												<div key={s.key} className="flex items-center gap-2" data-series={s.key}>
													<span
														aria-hidden="true"
														className="h-2.5 w-2.5 shrink-0 rounded-[2px]"
														style={{ background: s.color }}
													/>
													<span className="text-muted-foreground max-w-[12rem] truncate" title={s.name}>
														{s.name}
													</span>
													<span className="ml-auto font-mono tabular-nums">
														{typeof value === "number" ? `${formatScore(value)} · ${n} analyzed` : "— · 0 analyzed"}
													</span>
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
							dot={{ r: 2.5, strokeWidth: 0 }}
							activeDot={{ r: 4, strokeWidth: 0 }}
							connectNulls={false}
							isAnimationActive={false}
							hide={hidden.has(s.key)}
						/>
					))}
				</LineChart>
			</ChartContainer>
			<ul
				aria-label="Series"
				data-testid="sentiment-trend-legend"
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
