/**
 * Selected-period sentiment as concentric 0–100 rings: one ring per chart-
 * roster entity over a full background track, the brand outermost. Scores are
 * independent (not parts of a whole), so this is deliberately not a donut and
 * has no "Others" slice. The neutral midpoint is 50.
 */
import { ChartContainer } from "@workspace/ui/components/chart";
import { Cell, PolarAngleAxis, RadialBar, RadialBarChart, Tooltip } from "recharts";
import type { MetricLegendItem } from "@/components/metric-summary/metric-legend";
import {
	colorFor,
	entityColorMap,
	formatPct,
	formatSampleCount,
	formatSampleCountCompact,
	formatScore,
} from "@/components/sentiment/format";
import type { SentimentEntityRow } from "@/server/sentiment";

export interface SentimentRing {
	key: string;
	name: string;
	isBrand: boolean;
	/** Drawn value; 0 when the sample is empty so the track stays empty. */
	value: number;
	sentiment: number | null;
	mentions: number;
	classified: number;
	sample: number;
	mentionVisibility: number | null;
	sampleVisibility: number | null;
	/** Selected aspect label, null in the overall view. */
	aspectLabel: string | null;
	fill: string;
}

/** The one ordered dataset behind the rings and the legend: brand first, then the roster in order. */
export function buildSentimentRings(
	roster: readonly string[],
	rows: readonly SentimentEntityRow[],
	aspectLabel: string | null = null,
): SentimentRing[] {
	const colors = entityColorMap(roster);
	const byKey = new Map(rows.map((row) => [row.key, row]));
	return roster.flatMap((key) => {
		const row = byKey.get(key);
		if (!row) return [];
		return [
			{
				key,
				name: row.name,
				isBrand: row.isBrand,
				value: row.metrics.sentiment ?? 0,
				sentiment: row.metrics.sentiment,
				mentions: row.mentions,
				classified: row.classified,
				sample: row.sample,
				mentionVisibility: row.metrics.mentionVisibility,
				sampleVisibility: row.metrics.sampleVisibility,
				aspectLabel,
				fill: colorFor(colors, key),
			},
		];
	});
}

/** Legend rows in ring order: score and sample, the same once-rounded values the tooltip shows. */
export function sentimentLegendItems(rings: readonly SentimentRing[]): MetricLegendItem[] {
	return rings.map((ring) => ({
		id: ring.key,
		label: ring.name,
		color: ring.fill,
		valueLabel: `${formatScore(ring.sentiment)} · ${formatSampleCountCompact(ring, ring.aspectLabel)}`,
		emphasis: ring.isBrand ? "primary" : "muted",
		badgeLabel: ring.isBrand ? "You" : undefined,
		title: `${ring.name}: ${formatScore(ring.sentiment)} · ${formatSampleCount(ring, ring.aspectLabel)}`,
	}));
}

export function SentimentRadialChart({
	rings,
	eligibleResponses,
	size = 220,
}: {
	rings: readonly SentimentRing[];
	eligibleResponses: number;
	size?: number;
}) {
	// Recharts draws the first datum innermost, so the rings are fed in reverse to put the brand outside.
	const drawn = [...rings].reverse();
	const summary = rings.map((ring) => `${ring.name} ${formatScore(ring.sentiment)}`).join(", ");
	return (
		<div
			role="img"
			data-testid="sentiment-radial"
			aria-label={`Sentiment rings, each on its own 0 to 100 scale with 50 as neutral: ${summary}`}
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
						{drawn.map((ring) => (
							<Cell key={ring.key} fill={ring.fill} />
						))}
					</RadialBar>
					<Tooltip
						isAnimationActive={false}
						cursor={false}
						content={({ active, payload }) => {
							if (!active || !payload?.length) return null;
							const ring = payload[0]?.payload as SentimentRing | undefined;
							if (!ring) return null;
							return (
								<div
									data-testid="sentiment-radial-tooltip"
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
										<dt className="text-muted-foreground">Sentiment</dt>
										<dd className="text-right font-mono">{formatScore(ring.sentiment)} / 100</dd>
										<dt className="text-muted-foreground">
											{ring.aspectLabel ? `${ring.aspectLabel} sample` : "Analyzed"}
										</dt>
										<dd className="text-right font-mono">
											{ring.aspectLabel
												? `${ring.sample} of ${ring.classified} analyzed`
												: `${ring.classified} of ${ring.mentions} mentions`}
										</dd>
										<dt className="text-muted-foreground">
											{ring.aspectLabel ? `${ring.aspectLabel} in` : "Mentioned in"}
										</dt>
										<dd className="text-right font-mono">
											{ring.aspectLabel ? ring.sample : ring.mentions} / {eligibleResponses} responses (
											{formatPct(ring.aspectLabel ? ring.sampleVisibility : ring.mentionVisibility)})
										</dd>
									</dl>
									<div className="text-muted-foreground">50 = neutral midpoint</div>
								</div>
							);
						}}
					/>
				</RadialBarChart>
			</ChartContainer>
		</div>
	);
}
