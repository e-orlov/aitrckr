/**
 * Display rules shared by the three Competitive AI Visibility cards, so a value
 * is rounded once and an entity is coloured the same in the radial, the trend
 * and the leaderboard.
 */
import type { CompetitiveVisibilitySeries } from "@/lib/competitive-visibility";
import { BRAND_COLOR, COMPETITOR_PALETTE, OTHERS_COLOR } from "@/lib/share-of-voice-palette";

/** The one place a Visibility percentage becomes text. `null` (no denominator) renders as an em dash. */
export const formatPct = (value: number | null | undefined): string =>
	typeof value === "number" && Number.isFinite(value) ? `${Math.round(value)}%` : "—";

/** Build a local Date from "YYYY-MM-DD" (avoids the UTC off-by-one of `new Date(iso)`). */
export function localDate(value: string): Date {
	const [year, month, day] = value.split("-").map(Number);
	return new Date(year, month - 1, day);
}
export const shortDate = (value: string) =>
	localDate(value).toLocaleDateString("en-US", { month: "short", day: "numeric" });
export const longDate = (value: string) =>
	localDate(value).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });

/**
 * Colour by series position: the brand blue, then the palette in trend rank
 * order (the same assignment the Share of Voice page makes for the same
 * ranking). Entities outside the trend roster get the neutral grey.
 */
export function entityColorMap(series: CompetitiveVisibilitySeries[]): Map<string, string> {
	const map = new Map<string, string>();
	let competitorRank = 0;
	for (const s of series) {
		map.set(s.key, s.isBrand ? BRAND_COLOR : COMPETITOR_PALETTE[competitorRank++ % COMPETITOR_PALETTE.length]);
	}
	return map;
}

export const colorFor = (colors: Map<string, string>, key: string): string => colors.get(key) ?? OTHERS_COLOR;
