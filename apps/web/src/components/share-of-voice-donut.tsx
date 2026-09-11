/**
 * Donut of share of voice: the brand plus its top competitors, with the long
 * tail bucketed into "Others", and a permanently visible list of the same
 * slices beside it. Sits beside the headline share number.
 */

import { Badge } from "@workspace/ui/components/badge";
import { ChartContainer } from "@workspace/ui/components/chart";
import { Cell, Pie, PieChart, Tooltip } from "recharts";
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

export function ShareOfVoiceDonut({
	entries,
	topN = 6,
	domainFor,
	size = 180,
}: {
	entries: ShareOfVoiceEntry[];
	topN?: number;
	domainFor?: (name: string) => string | undefined;
	/** Chart side in px — explicit so it measures the same wherever it renders. */
	size?: number;
}) {
	const slices = buildShareOfVoiceSlices(entries, topN, domainFor);
	if (slices.length === 0) return null;

	return (
		<div
			data-testid="share-of-voice-donut"
			className="flex shrink-0 flex-col items-center gap-3 sm:ml-auto sm:flex-row sm:items-center"
		>
			<ChartContainer config={{}} className="aspect-square shrink-0" style={{ height: size, width: size }}>
				<PieChart>
					<Pie
						data={slices}
						dataKey="value"
						nameKey="name"
						innerRadius={48}
						outerRadius={84}
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
			<ul
				aria-label="Brands"
				data-testid="share-of-voice-brand-list"
				className="min-w-0 max-w-[8.5rem] grid gap-1 text-xs"
			>
				{slices.map((s) => (
					<li key={s.key} className="flex min-w-0 items-center gap-2" data-entity={s.key}>
						<span
							aria-hidden="true"
							className={`shrink-0 rounded-full ${s.kind === "brand" ? "h-3 w-3" : "h-2.5 w-2.5"}`}
							style={{ background: s.color }}
						/>
						<span
							className={`min-w-0 truncate ${s.kind === "brand" ? "font-medium" : "text-muted-foreground"}`}
							title={s.name}
						>
							{s.name}
						</span>
						{s.kind === "brand" && (
							<Badge variant="secondary" className="px-1.5 py-0 text-[10px]">
								You
							</Badge>
						)}
						<span className="ml-auto font-mono tabular-nums">{s.percent}%</span>
					</li>
				))}
			</ul>
		</div>
	);
}
