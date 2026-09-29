/**
 * Mock for @/server/sentiment used in Storybook stories. The real module
 * re-exports the server-only loader types and imports `@/server/analysis`
 * (postgres); stories render the presentational Sentiment components with
 * fixtures, so the server functions are never called here.
 */
export type {
	SentimentAspectFilter,
	SentimentEntityRow,
	SentimentEvidenceItem,
	SentimentEvidenceResponse,
	SentimentOverviewResponse,
	SentimentSeriesPoint,
} from "@/server/sentiment";

export const SENTIMENT_EVIDENCE_LIMIT = 10;

export const getSentimentOverviewFn = async (..._args: unknown[]) => {
	throw new Error("getSentimentOverviewFn is not available in Storybook");
};

export const getSentimentEvidenceFn = async (..._args: unknown[]) => {
	throw new Error("getSentimentEvidenceFn is not available in Storybook");
};
