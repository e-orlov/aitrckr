import { z } from "zod";

/**
 * Bump to make every stored run eligible for one deterministic re-detection
 * (matching rules, normalization or boundary changes).
 */
export const SENTIMENT_DETECTOR_VERSION = "sent-detector-v1";

/**
 * Bump to invalidate every stored analysis and make every mentioned run
 * eligible for one paid reclassification (prompt, rules or model policy
 * change). Rows with another version stay auditable and are ignored at read
 * time.
 */
export const SENTIMENT_CLASSIFIER_VERSION = "sent-classifier-v2";

/**
 * Versioned separately from the classifier: a later taxonomy must never
 * silently rewrite what an older aspect row meant.
 */
export const SENTIMENT_TAXONOMY_VERSION = "sent-aspects-v1";

export const SENTIMENT_CATEGORIES = ["positive", "neutral", "mixed", "negative"] as const;
export type SentimentCategory = (typeof SENTIMENT_CATEGORIES)[number];

export const SENTIMENT_ASPECT_KEYS = ["price", "coverage", "service", "other"] as const;
export type SentimentAspectKey = (typeof SENTIMENT_ASPECT_KEYS)[number];

/** Canonical aspect taxonomy `sent-aspects-v1`; synonyms are mapped in, never stored as dimensions. */
export const SENTIMENT_ASPECTS: Record<SentimentAspectKey, { label: string; description: string; synonyms: string[] }> =
	{
		price: {
			label: "Price",
			description: "Cost, premiums, fees, value for money, discounts, price increases.",
			synonyms: [
				"cost",
				"costs",
				"premium",
				"premiums",
				"fee",
				"fees",
				"value",
				"pricing",
				"preis",
				"beitrag",
				"kosten",
				"tarif",
			],
		},
		coverage: {
			label: "Coverage",
			description: "What is insured or included, exclusions, limits, waiting periods, scope of protection.",
			synonyms: [
				"scope",
				"protection",
				"included",
				"exclusions",
				"limits",
				"deckung",
				"leistung",
				"leistungsumfang",
				"schutz",
				"wartezeit",
			],
		},
		service: {
			label: "Service",
			description: "Customer support, claims handling, responsiveness, helpdesk, digital tools, advice quality.",
			synonyms: [
				"support",
				"customer service",
				"claims",
				"helpdesk",
				"hotline",
				"beratung",
				"kundenservice",
				"schadenabwicklung",
				"erreichbarkeit",
			],
		},
		other: {
			label: "Other",
			description: "Any other evaluated aspect (reputation, trust, ratings, financial strength, market position).",
			synonyms: [],
		},
	};

export const EVIDENCE_QUOTE_MAX_LENGTH = 300;
export const EVIDENCE_MAX_ITEMS = 3;
/**
 * The polarity of one excerpt as the classifier reads it. Declared per
 * excerpt so a Mixed verdict can be checked locally: it must cite at least one
 * positive and one negative excerpt, never two of the same polarity.
 */
export const EVIDENCE_POLARITIES = ["positive", "negative", "neutral"] as const;
export type EvidencePolarity = (typeof EVIDENCE_POLARITIES)[number];

/** Locked production path: the shared OpenRouter structured-research call with this exact model. */
export const SENTIMENT_PROVIDER_ID = "openrouter";
export const SENTIMENT_MODEL = "openai/gpt-5-mini";

/**
 * Run-level detection receipt states. `mentions`/`no_mentions` are completed
 * scans of an extractable answer; `unextractable` records that the stored
 * output had no answer text to scan. A run without a current-version receipt
 * has not been scanned.
 */
export const SENTIMENT_DETECTION_STATUSES = ["mentions", "no_mentions", "unextractable"] as const;
export type SentimentDetectionStatus = (typeof SENTIMENT_DETECTION_STATUSES)[number];

export const SENTIMENT_ANALYSIS_STATUSES = ["pending", "processing", "completed", "no_mentions", "failed"] as const;
export type SentimentAnalysisStatus = (typeof SENTIMENT_ANALYSIS_STATUSES)[number];

/**
 * A `processing` claim older than this is treated as abandoned (worker died
 * mid-call) and may be re-claimed. Equals the queue's job expiry, so a live
 * job can never still be inside its provider call when its claim expires.
 */
export const SENTIMENT_CLAIM_TIMEOUT_SECONDS = 900;

/**
 * Cross-field rule shared by the classifier validation, the database checks
 * and the display layer: Positive 51–100, Negative 0–49, Neutral and Mixed
 * exactly 50.
 */
export function isScoreCategoryConsistent(score: number, category: SentimentCategory): boolean {
	if (!Number.isInteger(score) || score < 0 || score > 100) return false;
	switch (category) {
		case "positive":
			return score >= 51;
		case "negative":
			return score <= 49;
		case "neutral":
		case "mixed":
			return score === 50;
	}
}

/** Anchor ids are `s0001`…: four digits, assigned by the deterministic segmenter in answer order. */
export const ANCHOR_ID_PATTERN = /^s\d{4}$/;

/**
 * The provider never types an excerpt: it cites one of the answer's anchors
 * by id and labels its polarity. `anchorIdSchema` binds the id to the
 * current answer when the ids are known (the request schema), and to the
 * anchor pattern otherwise (parsing a stored or replayed result).
 */
function evidenceSchemaFor(anchorIds?: readonly string[]) {
	const anchorId =
		anchorIds && anchorIds.length > 0
			? z.enum(anchorIds as [string, ...string[]])
			: z.string().regex(ANCHOR_ID_PATTERN);
	return z.strictObject({
		anchorId,
		polarity: z.enum(EVIDENCE_POLARITIES),
	});
}

function aspectResultSchemaFor(anchorIds?: readonly string[]) {
	return z.strictObject({
		key: z.enum(SENTIMENT_ASPECT_KEYS),
		score: z.number().int().min(0).max(100),
		category: z.enum(SENTIMENT_CATEGORIES),
		confidence: z.number().min(0).max(1),
		evidence: z.array(evidenceSchemaFor(anchorIds)).min(1).max(EVIDENCE_MAX_ITEMS),
	});
}

function entityResultSchemaFor(anchorIds?: readonly string[]) {
	return z.strictObject({
		key: z.string().min(1),
		score: z.number().int().min(0).max(100),
		category: z.enum(SENTIMENT_CATEGORIES),
		confidence: z.number().min(0).max(1),
		evidence: z.array(evidenceSchemaFor(anchorIds)).min(1).max(EVIDENCE_MAX_ITEMS),
		aspects: z.array(aspectResultSchemaFor(anchorIds)).max(SENTIMENT_ASPECT_KEYS.length),
	});
}

/**
 * Strict contract for the classifier's structured answer, bound to one
 * answer's anchor ids: an id outside the answer fails the provider-side
 * schema before it can reach local validation. Unknown keys, categories or
 * aspects are validation errors and are never coerced into a stored Neutral
 * or `other`.
 */
export function sentimentClassificationResultSchemaFor(anchorIds: readonly string[]) {
	return z.strictObject({ entities: z.array(entityResultSchemaFor(anchorIds)).min(1) });
}

/** The same contract without the per-answer id binding (anchor ids by pattern only). */
export const sentimentClassificationResultSchema = z.strictObject({
	entities: z.array(entityResultSchemaFor()).min(1),
});

export type SentimentClassificationResult = z.infer<typeof sentimentClassificationResultSchema>;
export type SentimentEntityResult = SentimentClassificationResult["entities"][number];
export type SentimentAspectResult = SentimentEntityResult["aspects"][number];
export type SentimentEvidenceRef = SentimentEntityResult["evidence"][number];

/**
 * An exact excerpt of the stored answer body. `start`/`end` are UTF-16 offsets
 * into the raw stored body (not its normalized copy), so `body.slice(start,
 * end)` is the exact text the classifier cited; `quote` is that slice.
 */
export interface SentimentEvidence {
	quote: string;
	start: number;
	end: number;
	polarity: EvidencePolarity;
}

/** The entity the classifier must judge; `key` is `brand` or the competitor uuid. */
export interface SentimentCandidate {
	key: string;
	entityType: "brand" | "competitor";
	competitorId: string | null;
	name: string;
	aliases: string[];
}

export const SENTIMENT_QUEUE = "classify-sentiment";

/**
 * Queue payload: ids and versions only. The worker re-reads the stored answer
 * body and the mention rows itself, so answer text never rides on the queue.
 */
export const sentimentJobSchema = z.strictObject({
	promptRunId: z.guid(),
	classifierVersion: z.string().min(1),
	taxonomyVersion: z.string().min(1),
});
export type SentimentJobData = z.infer<typeof sentimentJobSchema>;

/** One queued-or-active job per prompt run + classifier version (pg-boss singletonKey). */
export function sentimentSingletonKey(promptRunId: string, classifierVersion: string): string {
	return `sentiment:${promptRunId}:${classifierVersion}`;
}

export const BRAND_ENTITY_KEY = "brand";

/**
 * The canonical order of sentiment entities everywhere they are listed —
 * candidates, prompts, mention projections, canary contracts: the own brand
 * first, then competitors by their immutable key (the competitor UUID) in
 * plain code-unit order. Never storage order, insertion order, timestamps,
 * row ids or a locale-aware collation, so every environment holding the same
 * entities produces the same sequence.
 */
export function compareSentimentEntities(
	a: { entityType: "brand" | "competitor"; key: string },
	b: { entityType: "brand" | "competitor"; key: string },
): number {
	if (a.entityType !== b.entityType) return a.entityType === "brand" ? -1 : 1;
	return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

/** A copy of `items` in the canonical entity order. */
export function sortSentimentEntities<T extends { entityType: "brand" | "competitor"; key: string }>(
	items: readonly T[],
): T[] {
	return [...items].sort(compareSentimentEntities);
}
