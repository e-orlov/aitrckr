import { SENTIMENT_SORT_KEYS, type SentimentSortKey } from "@workspace/lib/sentiment/metrics";
import { SENTIMENT_ASPECT_KEYS, SENTIMENT_ASPECTS, type SentimentAspectKey } from "@workspace/lib/sentiment/types";

/**
 * Route-local URL state for the Sentiment page. `aspect` and `sort` ride in
 * the search params beside the shared Tags/Lookback keys; anything else in the
 * URL (a stale `q` or `model` from another page) is ignored by this page.
 */
export type SentimentAspectParam = "overall" | SentimentAspectKey;

export const DEFAULT_SENTIMENT_ASPECT: SentimentAspectParam = "overall";
export const DEFAULT_SENTIMENT_SORT: SentimentSortKey = "sentiment";

export function coerceSentimentAspect(value: unknown): SentimentAspectParam {
	return typeof value === "string" && (SENTIMENT_ASPECT_KEYS as readonly string[]).includes(value)
		? (value as SentimentAspectKey)
		: DEFAULT_SENTIMENT_ASPECT;
}

export function coerceSentimentSort(value: unknown): SentimentSortKey {
	return typeof value === "string" && (SENTIMENT_SORT_KEYS as readonly string[]).includes(value)
		? (value as SentimentSortKey)
		: DEFAULT_SENTIMENT_SORT;
}

export const SENTIMENT_ASPECT_OPTIONS: { value: SentimentAspectParam; label: string }[] = [
	{ value: "overall", label: "Overall" },
	...SENTIMENT_ASPECT_KEYS.map((key) => ({ value: key, label: SENTIMENT_ASPECTS[key].label })),
];

export const SENTIMENT_SORT_OPTIONS: { value: SentimentSortKey; label: string }[] = [
	{ value: "sentiment", label: "Sentiment" },
	{ value: "mentions", label: "Mentions" },
	{ value: "mentionVisibility", label: "Mention Visibility" },
	{ value: "positiveVisibility", label: "Positive Visibility" },
	{ value: "negativeVisibility", label: "Negative Visibility" },
	{ value: "name", label: "Brand A–Z" },
];
