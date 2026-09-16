import { z } from "zod";

/**
 * Bump to make every stored run eligible for one deterministic re-detection
 * (matching rules, normalization or boundary changes).
 */
export const SENTIMENT_DETECTOR_VERSION = "sent-detector-v2";

/**
 * Bump to invalidate every stored analysis and make every mentioned run
 * eligible for one paid reclassification (prompt, rules or model policy
 * change). Rows with another version stay auditable and are ignored at read
 * time.
 */
export const SENTIMENT_CLASSIFIER_VERSION = "sent-classifier-v4";

/**
 * Transitional read policy: every Sentiment read prefers a completed analysis
 * of the current classifier and falls back, per prompt run, to a completed
 * analysis of a listed older version, so history classified under the
 * previous contract stays visible until it is reclassified. Preference order;
 * versions not listed here (v2 and older) are never read. Removing the
 * fallback is a later explicit decision, not a side effect of a deployment.
 */
export const SENTIMENT_READABLE_CLASSIFIER_VERSIONS = [SENTIMENT_CLASSIFIER_VERSION, "sent-classifier-v3"] as const;

/**
 * Versioned separately from the classifier: a later taxonomy must never
 * silently rewrite what an older aspect row meant. The aspect *keys* and
 * their meaning are unchanged in v4; the routing rules that send a statement
 * to one key belong to the classifier contract, not to the taxonomy.
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
 * by id. The id is bound to the current answer when the ids are known (the
 * request schema) and to the anchor pattern otherwise (parsing a stored or
 * replayed result); the polarity is fixed by the list the citation sits in.
 */
function anchorIdSchemaFor(anchorIds?: readonly string[]) {
	return anchorIds && anchorIds.length > 0
		? z.enum(anchorIds as [string, ...string[]])
		: z.string().regex(ANCHOR_ID_PATTERN);
}

function citationListFor(polarity: EvidencePolarity, anchorIds?: readonly string[]) {
	return z
		.array(z.strictObject({ anchorId: anchorIdSchemaFor(anchorIds), polarity: z.enum([polarity]) }))
		.min(1)
		.max(EVIDENCE_MAX_ITEMS);
}

const confidenceSchema = z.number().min(0).max(1);

/**
 * One judged target (an entity overall or one of its aspects) as the provider
 * returns it — classifier contract `sent-classifier-v4`. The category is a
 * discriminator: each branch admits only the score range and the citation
 * polarities that belong to it, so a Positive target carrying a negative
 * citation, a Negative target carrying a positive one, or a Mixed target
 * without one citation of each polarity is not representable. Mixed may cite
 * one both-sides anchor once per polarity. Everything is expressed with the
 * strict structured-output subset only (`anyOf`, `enum`, numeric and array
 * bounds), never with `if/then`, `contains`, `allOf`, `not` or `oneOf`.
 */
function targetBranchesFor<Extra extends z.ZodRawShape>(extra: Extra, anchorIds?: readonly string[]) {
	return [
		z.strictObject({
			...extra,
			category: z.enum(["positive"]),
			score: z.number().int().min(51).max(100),
			confidence: confidenceSchema,
			evidence: citationListFor("positive", anchorIds),
		}),
		z.strictObject({
			...extra,
			category: z.enum(["negative"]),
			score: z.number().int().min(0).max(49),
			confidence: confidenceSchema,
			evidence: citationListFor("negative", anchorIds),
		}),
		z.strictObject({
			...extra,
			category: z.enum(["neutral"]),
			score: z.number().int().min(50).max(50),
			confidence: confidenceSchema,
			evidence: citationListFor("neutral", anchorIds),
		}),
		z.strictObject({
			...extra,
			category: z.enum(["mixed"]),
			score: z.number().int().min(50).max(50),
			confidence: confidenceSchema,
			positiveEvidence: citationListFor("positive", anchorIds),
			negativeEvidence: citationListFor("negative", anchorIds),
		}),
	] as const;
}

function aspectTargetSchemaFor(anchorIds?: readonly string[]) {
	return z.union(targetBranchesFor({ key: z.enum(SENTIMENT_ASPECT_KEYS) }, anchorIds));
}

/**
 * The entity key is bound to the exact opaque candidate keys when they are
 * known (the request schema), so a display name, alias or variation can never
 * be a schema-valid answer; parsing a stored or replayed result binds by shape
 * only and the local allowlist decides.
 */
function entityTargetSchemaFor(anchorIds?: readonly string[], entityKeys?: readonly string[]) {
	const key = entityKeys && entityKeys.length > 0 ? z.enum(entityKeys as [string, ...string[]]) : z.string().min(1);
	return z.union(
		targetBranchesFor(
			{ key, aspects: z.array(aspectTargetSchemaFor(anchorIds)).max(SENTIMENT_ASPECT_KEYS.length) },
			anchorIds,
		),
	);
}

/**
 * Strict wire contract for the classifier's structured answer, bound to one
 * answer's anchor ids and one request's candidate keys: an id outside the
 * answer, a key outside the candidates, or a category/polarity combination
 * the branches do not admit fails the provider-side schema before it can
 * reach local validation. Unknown keys, categories or aspects are validation
 * errors and are never coerced into a stored Neutral or `other`.
 */
export function sentimentProviderResultSchemaFor(anchorIds: readonly string[], entityKeys: readonly string[]) {
	return z.strictObject({ entities: z.array(entityTargetSchemaFor(anchorIds, entityKeys)).min(1) });
}

/** The same wire contract without the per-answer binding (anchor ids by pattern, keys by shape). */
export const sentimentProviderResultSchema = z.strictObject({
	entities: z.array(entityTargetSchemaFor()).min(1),
});

export type SentimentProviderResult = z.infer<typeof sentimentProviderResultSchema>;
export type SentimentProviderEntity = SentimentProviderResult["entities"][number];
export type SentimentProviderAspect = SentimentProviderEntity["aspects"][number];

/**
 * Internal claim representation shared by validation, persistence, the canary
 * and the golden corpus: one flat citation list per target, each citation an
 * anchor id with its polarity. The wire shape above is translated into this
 * form right after schema parsing; nothing downstream depends on the branch
 * layout.
 */
const evidenceRefSchema = z.strictObject({
	anchorId: z.string().regex(ANCHOR_ID_PATTERN),
	polarity: z.enum(EVIDENCE_POLARITIES),
});
const aspectResultSchema = z.strictObject({
	key: z.enum(SENTIMENT_ASPECT_KEYS),
	score: z.number().int().min(0).max(100),
	category: z.enum(SENTIMENT_CATEGORIES),
	confidence: confidenceSchema,
	evidence: z
		.array(evidenceRefSchema)
		.min(1)
		.max(EVIDENCE_MAX_ITEMS * 2),
});
export const sentimentClassificationResultSchema = z.strictObject({
	entities: z
		.array(
			z.strictObject({
				key: z.string().min(1),
				score: z.number().int().min(0).max(100),
				category: z.enum(SENTIMENT_CATEGORIES),
				confidence: confidenceSchema,
				evidence: z
					.array(evidenceRefSchema)
					.min(1)
					.max(EVIDENCE_MAX_ITEMS * 2),
				aspects: z.array(aspectResultSchema).max(SENTIMENT_ASPECT_KEYS.length),
			}),
		)
		.min(1),
});

export type SentimentClassificationResult = z.infer<typeof sentimentClassificationResultSchema>;
export type SentimentEntityResult = SentimentClassificationResult["entities"][number];
export type SentimentAspectResult = SentimentEntityResult["aspects"][number];
export type SentimentEvidenceRef = SentimentEntityResult["evidence"][number];

type ProviderTarget = { category: SentimentCategory } & (
	| { evidence: SentimentEvidenceRef[] }
	| { positiveEvidence: SentimentEvidenceRef[]; negativeEvidence: SentimentEvidenceRef[] }
);

/** Citations of one wire target in one flat list: the positive list first for Mixed, in the provider's order otherwise. */
function citationsOf(target: ProviderTarget): SentimentEvidenceRef[] {
	if ("positiveEvidence" in target) return [...target.positiveEvidence, ...target.negativeEvidence];
	return target.evidence;
}

/** Translate a parsed wire result into the internal claim representation; no rule is applied here. */
export function toClassificationResult(provider: SentimentProviderResult): SentimentClassificationResult {
	return {
		entities: provider.entities.map((entity) => ({
			key: entity.key,
			score: entity.score,
			category: entity.category,
			confidence: entity.confidence,
			evidence: citationsOf(entity),
			aspects: entity.aspects.map((aspect) => ({
				key: aspect.key,
				score: aspect.score,
				category: aspect.category,
				confidence: aspect.confidence,
				evidence: citationsOf(aspect),
			})),
		})),
	};
}

/**
 * Translate an internal result back into the wire shape. Only representable
 * results translate: a target whose citations do not fit its category's
 * branch (a Positive target with a negative citation, a Mixed target lacking
 * one polarity) throws — the wire contract cannot express it.
 */
export function toProviderResult(raw: unknown): SentimentProviderResult {
	const result = sentimentClassificationResultSchema.parse(raw);
	const wire = (target: SentimentEntityResult | SentimentAspectResult) => {
		const { evidence, ...rest } = target;
		if (target.category === "mixed") {
			const positiveEvidence = evidence.filter((e) => e.polarity === "positive");
			const negativeEvidence = evidence.filter((e) => e.polarity === "negative");
			if (
				positiveEvidence.length === 0 ||
				negativeEvidence.length === 0 ||
				positiveEvidence.length + negativeEvidence.length !== evidence.length
			)
				throw new Error(`mixed target needs positive and negative citations only`);
			return { ...rest, positiveEvidence, negativeEvidence };
		}
		if (evidence.some((e) => e.polarity !== target.category))
			throw new Error(`${target.category} target may cite ${target.category} anchors only`);
		return { ...rest, evidence };
	};
	return sentimentProviderResultSchema.parse({
		entities: result.entities.map((entity) => ({ ...wire(entity), aspects: entity.aspects.map(wire) })),
	});
}

/**
 * JSON Schema keywords the strict structured-output mode of the locked
 * provider supports. Anything else in a request schema is a contract defect
 * caught by tests before a call is ever made.
 */
export const STRICT_STRUCTURED_OUTPUT_KEYWORDS = [
	"$schema",
	"$defs",
	"$ref",
	"type",
	"properties",
	"required",
	"additionalProperties",
	"items",
	"anyOf",
	"enum",
	"minItems",
	"maxItems",
	"minimum",
	"maximum",
	"description",
	"title",
] as const;

/** Throws when a serialized schema uses a keyword outside the supported subset (`if/then/else`, `contains`, `allOf`, `not`, `oneOf`, …). */
export function assertStrictStructuredOutputSubset(schema: unknown): void {
	const allowed = new Set<string>(STRICT_STRUCTURED_OUTPUT_KEYWORDS);
	const walk = (node: unknown, path: string, underProperties: boolean) => {
		if (Array.isArray(node)) {
			for (const [i, item] of node.entries()) walk(item, `${path}[${i}]`, false);
			return;
		}
		if (typeof node !== "object" || node === null) return;
		for (const [key, value] of Object.entries(node)) {
			if (!underProperties && !allowed.has(key)) {
				throw new Error(`unsupported JSON Schema keyword "${key}" at ${path || "$"}`);
			}
			walk(value, `${path}.${key}`, key === "properties" || key === "$defs");
		}
	};
	walk(schema, "", false);
}

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
