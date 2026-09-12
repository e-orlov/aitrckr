export {
	decodeRunCursor,
	encodeRunCursor,
	type MentionBackfillCounts,
	type MentionBackfillResult,
	type RunCursor,
	runMentionBackfill,
	runSentimentEnqueue,
	type SentimentEnqueueInventory,
	type SentimentEnqueueResult,
} from "./backfill";
export {
	classifySentiment,
	locateEvidence,
	type SentimentClassification,
	type SentimentClassifierDeps,
	SentimentValidationError,
	sentimentInputHash,
	type ValidatedAspect,
	type ValidatedEntitySentiment,
	validateSentimentResult,
} from "./classifier";
export {
	brandEntity,
	competitorEntity,
	containsBoundedTerm,
	type DetectableEntity,
	type DetectedMention,
	detectEntityMentions,
	entityTerms,
	normalizeDomainTerm,
} from "./detector";
export {
	enqueueSentimentBestEffort,
	type SentimentEnqueueOutcome,
	type SentimentSender,
	sendSentimentJob,
} from "./enqueue";
export { runSentimentJob, type SentimentJobDeps, type SentimentJobOutcome } from "./job";
export {
	bucketForRange,
	categoryLabel,
	compareObservationsAscending,
	computeEntityMetrics,
	type EntityCounts,
	type EntityMetrics,
	LOW_SAMPLE_THRESHOLD,
	type RosterCandidate,
	type ScoredObservation,
	SENTIMENT_SORT_KEYS,
	type SentimentBucket,
	type SentimentSortKey,
	type SortableEntityRow,
	selectChartRoster,
	sortEntityRows,
	splitExtremes,
} from "./metrics";
export { buildSentimentPrompt, SENTIMENT_EVIDENCE_RULES, SENTIMENT_SCORE_RULES } from "./prompt";
export { ensureSentimentQueue, SENTIMENT_QUEUE_OPTIONS, type SentimentQueueAdmin } from "./queue-setup";
export {
	candidatesFromMentions,
	ensureAnalysis,
	loadDetectableEntities,
	loadMentions,
	loadRunForSentiment,
	persistMentions,
	type StoredMention,
	type StoredRunForSentiment,
} from "./store";
export { extractAnswerBody, normalizeText } from "./text";
export {
	BRAND_ENTITY_KEY,
	EVIDENCE_MAX_ITEMS,
	EVIDENCE_QUOTE_MAX_LENGTH,
	isScoreCategoryConsistent,
	SENTIMENT_ASPECT_KEYS,
	SENTIMENT_ASPECTS,
	SENTIMENT_CATEGORIES,
	SENTIMENT_CLASSIFIER_VERSION,
	SENTIMENT_DETECTOR_VERSION,
	SENTIMENT_QUEUE,
	SENTIMENT_TAXONOMY_VERSION,
	type SentimentAspectKey,
	type SentimentCandidate,
	type SentimentCategory,
	type SentimentClassificationResult,
	type SentimentEvidence,
	type SentimentJobData,
	sentimentClassificationResultSchema,
	sentimentJobSchema,
	sentimentSingletonKey,
} from "./types";
