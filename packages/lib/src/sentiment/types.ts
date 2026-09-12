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
export const SENTIMENT_CLASSIFIER_VERSION = "sent-classifier-v1";

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

const evidenceSchema = z.strictObject({
	quote: z.string().trim().min(1).max(EVIDENCE_QUOTE_MAX_LENGTH),
});

const aspectResultSchema = z.strictObject({
	key: z.enum(SENTIMENT_ASPECT_KEYS),
	score: z.number().int().min(0).max(100),
	category: z.enum(SENTIMENT_CATEGORIES),
	confidence: z.number().min(0).max(1),
	evidence: z.array(evidenceSchema).min(1).max(EVIDENCE_MAX_ITEMS),
});

const entityResultSchema = z.strictObject({
	key: z.string().min(1),
	score: z.number().int().min(0).max(100),
	category: z.enum(SENTIMENT_CATEGORIES),
	confidence: z.number().min(0).max(1),
	evidence: z.array(evidenceSchema).min(1).max(EVIDENCE_MAX_ITEMS),
	aspects: z.array(aspectResultSchema).max(SENTIMENT_ASPECT_KEYS.length),
});

/**
 * Strict contract for the classifier's structured answer. Unknown keys,
 * categories or aspects are validation errors and are never coerced into a
 * stored Neutral or `other`.
 */
export const sentimentClassificationResultSchema = z.strictObject({
	entities: z.array(entityResultSchema).min(1),
});

export type SentimentClassificationResult = z.infer<typeof sentimentClassificationResultSchema>;
export type SentimentEntityResult = z.infer<typeof entityResultSchema>;
export type SentimentAspectResult = z.infer<typeof aspectResultSchema>;

/** An exact excerpt with its locator in the whitespace/Unicode-normalized answer body. */
export interface SentimentEvidence {
	quote: string;
	start: number;
	end: number;
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
