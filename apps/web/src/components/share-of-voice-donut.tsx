/**
 * Donut of share of voice: the brand plus its top competitors, with the long
 * tail bucketed into "Others". One ordered slice array feeds the sectors, the
 * tooltip and the legend rows shown beside the chart in the summary card.
 */

import { ChartContainer } from "@workspace/ui/components/chart";
import { Cell, Pie, PieChart, Tooltip } from "recharts";
import type { MetricLegendItem } from "@/components/metric-summary/metric-legend";
import { SiteIcon } from "@/components/site-icon";
import { BRAND_COLOR, OTHERS_COLOR, COMPETITOR_PALETTE as PALETTE } from "@/lib/share-of-voice-palette";
import type { ShareOfVoiceEntry } from "@/server/analysis";

export type ShareOfVoiceSliceKind = "brand" | "competitor" | "others";

export interface ShareOfVoiceSlice {
	key: string;
	kind: ShareOfVoiceSliceKind;
	name: string;
	/** Mentions — the donut's angular value. */
	value: number;
	color: string;
	/** Share of the slice total, rounded once for display; every consumer shows this number. */
	percent: number;
	/** Absent on the "Others" bucket, which stands for no single brand. */
	domain?: string;
}

/**
 * The one ordered dataset behind the donut sectors and the visible list:
 * brand first, then the first `topN` competitors in the server's order, then
 * "Others" only when a tail exists. Entities without mentions are not slices.
 */
export function buildShareOfVoiceSlices(
	entries: ShareOfVoiceEntry[],
	topN = 6,
	domainFor?: (name: string) => string | undefined,
): ShareOfVoiceSlice[] {
	const slices: Omit<ShareOfVoiceSlice, "percent">[] = [];
	let paletteIdx = 0;
	let shownCompetitors = 0;
	let othersValue = 0;

	for (const e of entries) {
		if (e.mentions <= 0) continue;
		if (e.isBrand) {
			slices.push({
				key: `brand:${e.name}`,
				kind: "brand",
				name: e.name,
				value: e.mentions,
				color: BRAND_COLOR,
				domain: domainFor?.(e.name),
			});
		} else if (shownCompetitors < topN) {
			slices.push({
				key: `competitor:${e.name}`,
				kind: "competitor",
				name: e.name,
				value: e.mentions,
				color: PALETTE[paletteIdx++ % PALETTE.length],
				domain: domainFor?.(e.name),
			});
			shownCompetitors++;
		} else {
			othersValue += e.mentions;
		}
	}
	if (othersValue > 0)
		slices.push({ key: "others", kind: "others", name: "Others", value: othersValue, color: OTHERS_COLOR });

	const total = slices.reduce((s, x) => s + x.value, 0);
	if (total === 0) return [];
	return slices.map((s) => ({ ...s, percent: Math.round((s.value / total) * 100) }));
}

/** Legend rows in slice order with the same once-rounded share the tooltip shows. */
export function shareOfVoiceLegendItems(slices: readonly ShareOfVoiceSlice[]): MetricLegendItem[] {
	return slices.map((s) => ({
		id: s.key,
		label: s.name,
		color: s.color,
		valueLabel: `${s.percent}%`,
		emphasis: s.kind === "brand" ? "primary" : "muted",
		badgeLabel: s.kind === "brand" ? "You" : undefined,
	}));
}

export interface DonutRadii {
	inner: number;
	outer: number;
}

/** The sectors alone (no legend), for composition inside a summary card. */
/** Shared visual stage of the summary cards and the ring proportions scaled to it. */
export const SHARE_OF_VOICE_DONUT_SIZE = 220;
export const SHARE_OF_VOICE_DONUT_RADII: DonutRadii = { inner: 59, outer: 103 };

export function ShareOfVoiceDonutChart({
	slices,
	size = SHARE_OF_VOICE_DONUT_SIZE,
	radii = SHARE_OF_VOICE_DONUT_RADII,
}: {
	slices: readonly ShareOfVoiceSlice[];
	/** Chart side in px — explicit so it measures the same wherever it renders. */
	size?: number;
	radii?: DonutRadii;
}) {
	const summary = slices.map((s) => `${s.name} ${s.percent}%`).join(", ");
	return (
		<div role="img" data-testid="share-of-voice-donut" aria-label={`Share of Voice: ${summary}`} className="shrink-0">
			<ChartContainer config={{}} className="aspect-square" style={{ height: size, width: size }}>
				<PieChart>
					<Pie
						data={slices as ShareOfVoiceSlice[]}
						dataKey="value"
						nameKey="name"
						innerRadius={radii.inner}
						outerRadius={radii.outer}
						paddingAngle={1}
						strokeWidth={1}
					>
						{slices.map((s) => (
							<Cell key={s.key} fill={s.color} />
						))}
					</Pie>
					<Tooltip
						content={({ active, payload }) => {
							if (!active || !payload?.length) return null;
							const s = payload[0].payload as ShareOfVoiceSlice;
							return (
								<div className="flex items-center gap-1.5 rounded-md border bg-background px-2 py-1 text-xs shadow-md">
									{s.kind !== "others" && <SiteIcon domain={s.domain} size="xs" />}
									<span>
										{s.name}: {s.percent}%
									</span>
								</div>
							);
						}}
					/>
				</PieChart>
			</ChartContainer>
		</div>
	);
}
