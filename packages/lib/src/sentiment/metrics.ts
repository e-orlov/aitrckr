import type { SentimentCategory } from "./types";

/**
 * Raw counts for one entity in one scope; every metric derives from these.
 * Three counts are deliberately distinct and must never be confused:
 *
 * - `mentions` (M): responses that mention the entity at all. Independent of
 *   the selected aspect.
 * - `classified` (C): mentions with a completed current-version entity
 *   classification. This is classifier COVERAGE and drives `partial`; it too
 *   is independent of the selected aspect.
 * - `sample` (S): the observations the displayed score rests on. In the
 *   overall view S = C; in an aspect view S is the number of classified
 *   mentions in which the answer evaluated that aspect. An answer that never
 *   discusses Price is simply not in the Price sample — it is not
 *   "unclassified".
 */
export interface EntityCounts {
	/** Eligible stored responses in scope (`T`). */
	eligibleResponses: number;
	/** Distinct responses mentioning the entity (`M`). */
	mentions: number;
	/** Mentions with a completed current-version entity classification (`C`). */
	classified: number;
	/** Observations in the selected view (`S`); the category counts and `scoreSum` are over these. */
	sample: number;
	positive: number;
	neutral: number;
	mixed: number;
	negative: number;
	/** Sum of the scores over the sample. */
	scoreSum: number;
}

export interface EntityMetrics {
	/** Mean score over the sample; null when the sample is empty. */
	sentiment: number | null;
	/** M / T: share of evaluated responses mentioning the entity (aspect-independent). */
	mentionVisibility: number | null;
	/** S / T: share of evaluated responses in the selected sample (equals `mentionVisibility` only when S = M). */
	sampleVisibility: number | null;
	/** Positive observations of the sample / T. */
	positiveVisibility: number | null;
	/** Negative observations of the sample / T. */
	negativeVisibility: number | null;
	positiveMix: number | null;
	neutralMix: number | null;
	mixedMix: number | null;
	negativeMix: number | null;
	/** C / M: share of mentions the current classifier has covered; null without mentions. */
	analysisCoverage: number | null;
	/** True when some mentions are still unclassified (C < M). Never set by an aspect being absent. */
	partial: boolean;
}

const ratio = (numerator: number, denominator: number): number | null =>
	denominator === 0 ? null : (numerator / denominator) * 100;

/**
 * Canonical formulas, full precision; callers round once for display.
 * `T = 0` yields null visibilities (an empty state, never a fabricated 0),
 * `S = 0` yields a null sentiment (shown as "—", never 0 or 50).
 */
export function computeEntityMetrics(c: EntityCounts): EntityMetrics {
	return {
		sentiment: c.sample === 0 ? null : c.scoreSum / c.sample,
		mentionVisibility: ratio(c.mentions, c.eligibleResponses),
		sampleVisibility: ratio(c.sample, c.eligibleResponses),
		positiveVisibility: ratio(c.positive, c.eligibleResponses),
		negativeVisibility: ratio(c.negative, c.eligibleResponses),
		positiveMix: ratio(c.positive, c.sample),
		neutralMix: ratio(c.neutral, c.sample),
		mixedMix: ratio(c.mixed, c.sample),
		negativeMix: ratio(c.negative, c.sample),
		analysisCoverage: ratio(c.classified, c.mentions),
		partial: c.mentions > 0 && c.classified < c.mentions,
	};
}

/** Below this many observations in the sample a score carries a visible low-sample cue. */
export const LOW_SAMPLE_THRESHOLD = 5;

/** Which sample the page is showing: every classified mention, or one aspect's observations. */
export type SentimentView = "overall" | "aspect";

/** The visibility the leaderboard's "Mention Visibility" column shows for the view: M/T overall, S/T for an aspect. */
export function viewVisibility(metrics: EntityMetrics, view: SentimentView): number | null {
	return view === "overall" ? metrics.mentionVisibility : metrics.sampleVisibility;
}

export type SentimentBucket = "day" | "week" | "month";

/**
 * Daily for one-month windows (a calendar month inclusive of both ends is at
 * most 32 days), weekly through 180 days, monthly beyond — deterministic and
 * bounded to a safe number of points.
 */
export const DAILY_BUCKET_MAX_DAYS = 35;
export function bucketForRange(days: number): SentimentBucket {
	if (days <= DAILY_BUCKET_MAX_DAYS) return "day";
	if (days <= 180) return "week";
	return "month";
}

export interface RosterCandidate {
	key: string;
	name: string;
	mentions: number;
	sample: number;
}

/**
 * Chart roster order: the view's count descending (mentions overall, the
 * aspect sample in an aspect view), then normalized name, then key — never by
 * sentiment score, so a one-mention outlier cannot dominate the overview.
 * Returns at most `limit` entries.
 */
export function selectChartRoster<T extends RosterCandidate>(
	candidates: T[],
	limit = 6,
	view: SentimentView = "overall",
): T[] {
	const count = (row: T) => (view === "overall" ? row.mentions : row.sample);
	return [...candidates]
		.sort(
			(a, b) =>
				count(b) - count(a) ||
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
	sample: number;
	metrics: EntityMetrics;
}

/**
 * Leaderboard order. Sentiment: descending with nulls last, ties by sample
 * size descending; numeric sorts descending with nulls last; name A–Z. The
 * "mentions" and "mentionVisibility" sorts follow the view (M overall, S for
 * an aspect) so the order matches the displayed column. Every sort ends with
 * normalized name, then key, so the order is total.
 */
export function sortEntityRows<T extends SortableEntityRow>(
	rows: T[],
	sortKey: SentimentSortKey,
	view: SentimentView = "overall",
): T[] {
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
				return desc(a.metrics.sentiment, b.metrics.sentiment) || b.sample - a.sample || byName(a, b);
			case "mentions":
				return (view === "overall" ? b.mentions - a.mentions : b.sample - a.sample) || byName(a, b);
			case "mentionVisibility":
				return desc(viewVisibility(a.metrics, view), viewVisibility(b.metrics, view)) || byName(a, b);
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

const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Stable total order for evidence: score, run timestamp, prompt id, run id.
 * Plain code-unit comparison so it agrees with Postgres' ordering of
 * timestamps and uuids, which the SQL evidence queries use.
 */
export function compareObservationsAscending(a: ScoredObservation, b: ScoredObservation): number {
	return (
		a.score - b.score ||
		byCodeUnit(a.runCreatedAt, b.runCreatedAt) ||
		byCodeUnit(a.promptId, b.promptId) ||
		byCodeUnit(a.promptRunId, b.promptRunId)
	);
}

/**
 * How many records the highest and lowest sets receive for `total`
 * observations: `limit` each when there are enough, otherwise the records
 * are allocated from both ends without duplicating any — the highest half
 * (rounded up) to `highest`, the rest to `lowest`. Shared by the SQL loader
 * (COUNT + two ORDER BY/LIMIT queries) and the in-memory split.
 */
export function extremesAllocation(total: number, limit = 10): { highCount: number; lowCount: number } {
	if (total >= 2 * limit) return { highCount: limit, lowCount: limit };
	const highCount = Math.ceil(total / 2);
	return { highCount, lowCount: total - highCount };
}

/** Deterministic, non-overlapping extremes over an in-memory list (see `extremesAllocation`). */
export function splitExtremes<T extends ScoredObservation>(rows: T[], limit = 10): { highest: T[]; lowest: T[] } {
	const ascending = [...rows].sort(compareObservationsAscending);
	const { highCount, lowCount } = extremesAllocation(ascending.length, limit);
	return { highest: ascending.slice(ascending.length - highCount).reverse(), lowest: ascending.slice(0, lowCount) };
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
