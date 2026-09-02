import { z } from "zod";
import { CITATION_PAGE_TYPES, type CitationPageType } from "../citations/domain-categories";

/**
 * Bump this to invalidate every cached row and make all hostnames eligible for
 * one reclassification (prompt change, taxonomy change, model policy change).
 * Rows with any other version are stale: ignored at read time and replaced
 * through the normal successful-classification path.
 */
export const SOURCE_CLASSIFIER_VERSION = "f05-v1";

/**
 * Identifier for the built-in taxonomy revision described to the LLM. The
 * eleven-category set below matches the v0.3.0 code (`CITATION_CATEGORIES`) —
 * not the older public docs page, which predates it.
 */
export const SOURCE_TAXONOMY_VERSION = "elmo-v0.3.0";

/** The only categories the supplemental classifier may produce. */
export const SOURCE_CLASSIFICATION_CATEGORIES = ["editorial", "institutional", "other"] as const;
export type SourceClassificationCategory = (typeof SOURCE_CLASSIFICATION_CATEGORIES)[number];

export const SOURCE_CLASSIFICATION_REASON_MAX_LENGTH = 500;

/**
 * Strict contract for the LLM's structured answer. Anything outside it —
 * unknown labels, extra keys, NaN/out-of-range confidence, empty or oversized
 * reasons — is a validation error, never coerced into a stored `other`.
 */
export const sourceClassificationResultSchema = z.strictObject({
	category: z.enum(SOURCE_CLASSIFICATION_CATEGORIES),
	confidence: z.number().min(0).max(1),
	reason: z.string().trim().min(1).max(SOURCE_CLASSIFICATION_REASON_MAX_LENGTH),
});

export type SourceClassificationResult = z.infer<typeof sourceClassificationResultSchema>;

/** A validated classification plus the provenance the cache row records. */
export interface SourceClassification extends SourceClassificationResult {
	hostname: string;
	provider: string;
	model: string | null;
	classifierVersion: string;
}

/** Page-fallback categories the built-in URL/title heuristic can produce. */
export const PAGE_FALLBACK_HINTS = ["editorial", "ecommerce", "social"] as const;
export type PageFallbackHint = (typeof PAGE_FALLBACK_HINTS)[number];

const MAX_PAGE_TYPE_HINTS = 5;

/**
 * Queue payload: the minimum safe data. Normalized hostname, classifier
 * version, the producer's domain-level built-in result (which must be "other"
 * — the worker refuses anything else before any provider call), and bounded
 * enum-only hints. Never answer text, brand/competitor lists, or secrets.
 */
export const sourceClassificationJobSchema = z.strictObject({
	hostname: z.string().min(1),
	classifierVersion: z.string().min(1),
	builtInCategory: z.literal("other"),
	pageTypeHints: z
		.array(z.enum(CITATION_PAGE_TYPES as [CitationPageType, ...CitationPageType[]]))
		.max(MAX_PAGE_TYPE_HINTS)
		.optional(),
	pageFallbackHint: z.enum(PAGE_FALLBACK_HINTS).optional(),
});

export type SourceClassificationJobData = z.infer<typeof sourceClassificationJobSchema>;

export const SOURCE_CLASSIFICATION_QUEUE = "classify-source-domain";

/** One active job per hostname + classifier version (pg-boss singletonKey). */
export function sourceClassificationSingletonKey(hostname: string, classifierVersion: string): string {
	return `source-classification:${hostname}:${classifierVersion}`;
}
