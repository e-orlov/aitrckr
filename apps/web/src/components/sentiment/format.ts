/**
 * Display rules shared by the Sentiment cards, so a value is rounded exactly
 * once and an entity is coloured the same in the radial, the trend and the
 * leaderboard (the same brand/competitor palette the adjacent analytics use).
 */
import type { SentimentCategory } from "@workspace/lib/sentiment/types";
import { BRAND_COLOR, COMPETITOR_PALETTE, OTHERS_COLOR } from "@/lib/share-of-voice-palette";
import type { SentimentEntityRow } from "@/server/sentiment";

/** The one place a 0–100 sentiment score becomes text. `null` (nothing classified) renders as an em dash. */
export const formatScore = (value: number | null | undefined): string =>
	typeof value === "number" && Number.isFinite(value) ? String(Math.round(value)) : "—";

/** Percent with one rounding; `null` (no denominator) renders as an em dash. */
export const formatPct = (value: number | null | undefined): string =>
	typeof value === "number" && Number.isFinite(value) ? `${Math.round(value)}%` : "—";

/** "24 mentions" or "21 of 24 analyzed mentions" when classification is incomplete. */
export function formatMentionCount(row: { mentions: number; classified: number }): string {
	if (row.mentions === 0) return "0 mentions";
	if (row.classified < row.mentions) {
		return `${row.classified} of ${row.mentions} analyzed ${row.mentions === 1 ? "mention" : "mentions"}`;
	}
	return `${row.mentions} ${row.mentions === 1 ? "mention" : "mentions"}`;
}

export function localDate(value: string): Date {
	const [year, month, day] = value.split("-").map(Number);
	return new Date(year, month - 1, day);
}
export const shortDate = (value: string) =>
	localDate(value).toLocaleDateString("en-US", { month: "short", day: "numeric" });
export const longDate = (value: string) =>
	localDate(value).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });

/** Bucket label: a day, the week starting on that day, or the month. */
export function bucketLabel(bucketStart: string, bucket: "day" | "week" | "month"): string {
	if (bucket === "month") return localDate(bucketStart).toLocaleDateString("en-US", { month: "long", year: "numeric" });
	if (bucket === "week") return `Week of ${longDate(bucketStart)}`;
	return longDate(bucketStart);
}

/**
 * Colour by chart-roster position: the brand blue, then the palette in roster
 * order. Entities outside the roster get the neutral grey.
 */
export function entityColorMap(roster: readonly string[]): Map<string, string> {
	const map = new Map<string, string>();
	let competitorRank = 0;
	for (const key of roster) {
		map.set(key, key === "brand" ? BRAND_COLOR : COMPETITOR_PALETTE[competitorRank++ % COMPETITOR_PALETTE.length]);
	}
	return map;
}

export const colorFor = (colors: Map<string, string>, key: string): string => colors.get(key) ?? OTHERS_COLOR;

/** Category styling: text + colour token; text always carries the category so colour is never the only cue. */
export const CATEGORY_STYLE: Record<SentimentCategory, { label: string; className: string; bar: string }> = {
	positive: { label: "Positive", className: "text-emerald-700 dark:text-emerald-400", bar: "bg-emerald-500" },
	neutral: { label: "Neutral", className: "text-muted-foreground", bar: "bg-slate-400" },
	mixed: { label: "Mixed", className: "text-amber-700 dark:text-amber-400", bar: "bg-amber-500" },
	negative: { label: "Negative", className: "text-rose-700 dark:text-rose-400", bar: "bg-rose-500" },
};

export const CATEGORY_ORDER: SentimentCategory[] = ["positive", "neutral", "mixed", "negative"];

export function rowsByKey(rows: readonly SentimentEntityRow[]): Map<string, SentimentEntityRow> {
	return new Map(rows.map((row) => [row.key, row]));
}
