import type { SentimentCategory } from "./types";

/** Raw counts for one entity in one scope; every metric derives from these. */
export interface EntityCounts {
	/** Eligible stored responses in scope (`T`). */
	eligibleResponses: number;
	/** Distinct responses mentioning the entity (`M`). */
	mentions: number;
	/** Mentions classified by the current classifier version (`C`). */
	classified: number;
	positive: number;
	neutral: number;
	mixed: number;
	negative: number;
	/** Sum of the classified scores. */
	scoreSum: number;
}

export interface EntityMetrics {
	/** Mean score over classified mentions; null when nothing is classified. */
	sentiment: number | null;
	mentionVisibility: number | null;
	positiveVisibility: number | null;
	negativeVisibility: number | null;
	positiveMix: number | null;
	neutralMix: number | null;
	mixedMix: number | null;
	negativeMix: number | null;
	/** Share of mentions classified at the current version; null without mentions. */
	analysisCoverage: number | null;
	/** True when some mentions are still unclassified. */
	partial: boolean;
}

const ratio = (numerator: number, denominator: number): number | null =>
	denominator === 0 ? null : (numerator / denominator) * 100;

/**
 * Canonical formulas, full precision; callers round once for display.
 * `T = 0` yields null visibilities (an empty state, never a fabricated 0),
 * `C = 0` yields a null sentiment (shown as "—", never 0 or 50).
 */
export function computeEntityMetrics(c: EntityCounts): EntityMetrics {
	return {
		sentiment: c.classified === 0 ? null : c.scoreSum / c.classified,
		mentionVisibility: ratio(c.mentions, c.eligibleResponses),
		positiveVisibility: ratio(c.positive, c.eligibleResponses),
		negativeVisibility: ratio(c.negative, c.eligibleResponses),
		positiveMix: ratio(c.positive, c.classified),
		neutralMix: ratio(c.neutral, c.classified),
		mixedMix: ratio(c.mixed, c.classified),
		negativeMix: ratio(c.negative, c.classified),
		analysisCoverage: ratio(c.classified, c.mentions),
		partial: c.mentions > 0 && c.classified < c.mentions,
	};
}

/** Below this many classified mentions a score carries a visible low-sample cue. */
export const LOW_SAMPLE_THRESHOLD = 5;

export type SentimentBucket = "day" | "week" | "month";

/** Daily through 31 days, weekly through 180 days, monthly beyond — deterministic and bounded. */
export function bucketForRange(days: number): SentimentBucket {
	if (days <= 31) return "day";
	if (days <= 180) return "week";
	return "month";
}

export interface RosterCandidate {
	key: string;
	name: string;
	mentions: number;
}

/**
 * Chart roster order: mention count descending, then normalized name, then
 * key — never by sentiment score, so a one-mention outlier cannot dominate
 * the overview. Returns at most `limit` entries.
 */
export function selectChartRoster<T extends RosterCandidate>(candidates: T[], limit = 6): T[] {
	return [...candidates]
		.sort(
			(a, b) =>
				b.mentions - a.mentions ||
				a.name.localeCompare(b.name, "en", { sensitivity: "base" }) ||
				a.key.localeCompare(b.key),
		)
		.slice(0, limit);
}

export const SENTIMENT_SORT_KEYS = [
	"sentiment",
	"mentions",
	"mentionVisibility",
	"positiveVisibility",
	"negativeVisibility",
	"name",
] as const;
export type SentimentSortKey = (typeof SENTIMENT_SORT_KEYS)[number];

export interface SortableEntityRow {
	key: string;
	name: string;
	mentions: number;
	classified: number;
	metrics: EntityMetrics;
}

/**
 * Leaderboard order. Sentiment: descending with nulls last, ties by classified
 * mentions descending; numeric sorts descending with nulls last; name A–Z.
 * Every sort ends with normalized name, then key, so the order is total.
 */
export function sortEntityRows<T extends SortableEntityRow>(rows: T[], sortKey: SentimentSortKey): T[] {
	const byName = (a: T, b: T) =>
		a.name.localeCompare(b.name, "en", { sensitivity: "base" }) || a.key.localeCompare(b.key);
	const desc = (a: number | null, b: number | null) => {
		if (a === null && b === null) return 0;
		if (a === null) return 1;
		if (b === null) return -1;
		return b - a;
	};
	return [...rows].sort((a, b) => {
		switch (sortKey) {
			case "sentiment":
				return desc(a.metrics.sentiment, b.metrics.sentiment) || b.classified - a.classified || byName(a, b);
			case "mentions":
				return b.mentions - a.mentions || byName(a, b);
			case "mentionVisibility":
				return desc(a.metrics.mentionVisibility, b.metrics.mentionVisibility) || byName(a, b);
			case "positiveVisibility":
				return desc(a.metrics.positiveVisibility, b.metrics.positiveVisibility) || byName(a, b);
			case "negativeVisibility":
				return desc(a.metrics.negativeVisibility, b.metrics.negativeVisibility) || byName(a, b);
			default:
				return byName(a, b);
		}
	});
}

export interface ScoredObservation {
	score: number;
	runCreatedAt: string;
	promptId: string;
	promptRunId: string;
}

/** Stable total order for evidence: score, run timestamp, prompt id, run id. */
export function compareObservationsAscending(a: ScoredObservation, b: ScoredObservation): number {
	return (
		a.score - b.score ||
		a.runCreatedAt.localeCompare(b.runCreatedAt) ||
		a.promptId.localeCompare(b.promptId) ||
		a.promptRunId.localeCompare(b.promptRunId)
	);
}

/**
 * Deterministic, non-overlapping extremes: up to `limit` highest and up to
 * `limit` lowest observations. With fewer than `2 * limit` observations the
 * records are allocated from both ends without duplicating any record — the
 * highest half (rounded up) goes to `highest`, the rest to `lowest`.
 */
export function splitExtremes<T extends ScoredObservation>(rows: T[], limit = 10): { highest: T[]; lowest: T[] } {
	const ascending = [...rows].sort(compareObservationsAscending);
	const n = ascending.length;
	if (n >= 2 * limit) {
		return { highest: ascending.slice(n - limit).reverse(), lowest: ascending.slice(0, limit) };
	}
	const highCount = Math.ceil(n / 2);
	return { highest: ascending.slice(n - highCount).reverse(), lowest: ascending.slice(0, n - highCount) };
}

/** Display label for a stored category. */
export function categoryLabel(category: SentimentCategory): string {
	switch (category) {
		case "positive":
			return "Positive";
		case "neutral":
			return "Neutral";
		case "mixed":
			return "Mixed";
		case "negative":
			return "Negative";
	}
}
