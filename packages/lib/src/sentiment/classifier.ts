import { createHash } from "node:crypto";
import { API_PROVIDER_MAX_OUTPUT_TOKENS } from "../providers/config";
import type { Provider, StructuredResearchRequestSummary, StructuredResearchUsage } from "../providers/types";
import { StructuredResearchResponseError } from "../providers/types";
import { anchorMap, type EvidenceAnchor, segmentAnswer } from "./anchors";
import { type DiagnosticReason, type DiagnosticStage, diagnostic, safeGenerationId } from "./diagnostics";
import { type PaidResponseEnvelope, SentimentValidationError } from "./errors-validation";
import { type GroundingMap, groundAnchors, isAttributable, namesOnlyOthers } from "./grounding";
import { buildSentimentPrompt } from "./prompt";
import { resolveSentimentProvider } from "./provider";
import { type AnalyzableText, analyzableText, analyzeAnswerRanges } from "./ranges";
import { normalizeText } from "./text";
import {
	type EvidencePolarity,
	isScoreCategoryConsistent,
	SENTIMENT_CLASSIFIER_VERSION,
	SENTIMENT_MODEL,
	SENTIMENT_PROVIDER_ID,
	SENTIMENT_TAXONOMY_VERSION,
	type SentimentAspectKey,
	type SentimentCandidate,
	type SentimentCategory,
	type SentimentClassificationResult,
	type SentimentEvidence,
	type SentimentEvidenceRef,
	sentimentClassificationResultSchema,
	sentimentProviderResultSchema,
	sentimentProviderResultSchemaFor,
	toClassificationResult,
} from "./types";

export { SentimentValidationError } from "./errors-validation";

export interface ValidatedAspect {
	key: SentimentAspectKey;
	score: number;
	category: SentimentCategory;
	confidence: number;
	evidence: SentimentEvidence[];
}

export interface ValidatedEntitySentiment {
	key: string;
	score: number;
	category: SentimentCategory;
	confidence: number;
	evidence: SentimentEvidence[];
	aspects: ValidatedAspect[];
}

export interface SentimentClassification {
	entities: ValidatedEntitySentiment[];
	provider: string;
	model: string | null;
	webSearch: boolean;
	classifierVersion: string;
	taxonomyVersion: string;
	inputHash: string;
	/** Safe numeric usage of the call (tokens, charged cost, web searches); undefined when the provider reported none. */
	usage?: StructuredResearchUsage;
	/** What the provider was asked to do (model, web search, tool budget, output cap); undefined when it did not report it. */
	request?: StructuredResearchRequestSummary;
	/** Opaque provider generation id of the call, for audit; null when the provider reported none. */
	generationId?: string | null;
}

/**
 * Hard output cap for every sentiment call: the provider table's OpenRouter
 * limit. Bounds the completion (and reasoning) tokens one classification can
 * be billed for; the structured answer needs a small fraction of it.
 */
export const SENTIMENT_MAX_OUTPUT_TOKENS = API_PROVIDER_MAX_OUTPUT_TOKENS.openrouter;

/**
 * The exact classifier input in canonical form: the normalized
 * natural-language text of the answer (citation ranges elided, so a changed
 * link destination is not a changed input) and every candidate's identity
 * (key, type, name, aliases) in a stable order. A stored analysis is current
 * only while this hash still matches, so a roster, name or alias change makes
 * the run eligible again instead of being hidden behind an older completed
 * analysis.
 */
export function sentimentInputHash(
	answerBody: string,
	candidates: SentimentCandidate[],
	analysis: AnalyzableText = analyzeAnswerRanges(answerBody),
): string {
	const canonical = {
		body: normalizeText(analyzableText(analysis)),
		candidates: [...candidates]
			.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
			.map((c) => ({
				key: c.key,
				type: c.entityType,
				name: normalizeText(c.name),
				aliases: [...new Set(c.aliases.map(normalizeText))].sort(),
			})),
	};
	return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

interface EvidenceWhere {
	stage: DiagnosticStage;
	entityKey: string;
	aspectKey: SentimentAspectKey | null;
	label: string;
}

function fail(
	reason: DiagnosticReason,
	message: string,
	where: Partial<EvidenceWhere> & { stage: DiagnosticStage },
	extra: { evidenceIndex?: number; anchorId?: string } = {},
): never {
	throw new SentimentValidationError(
		reason,
		message,
		diagnostic(where.stage, reason, {
			entityKey: where.entityKey ?? null,
			aspectKey: where.aspectKey ?? null,
			evidenceIndex: extra.evidenceIndex ?? null,
			anchorId: extra.anchorId ?? null,
		}),
	);
}

/**
 * One evidence claim is identified by its entity, its target (the entity
 * overall or one aspect), its anchor and its polarity. Identity decides
 * de-duplication and conflicts; nothing about a claim is ever rewritten.
 */
function claimIdentity(where: EvidenceWhere, ref: SentimentEvidenceRef): string {
	return `${where.entityKey}|${where.aspectKey ?? "overall"}|${ref.anchorId}|${ref.polarity}`;
}

/**
 * One citation of one target: the anchor must belong to the answer; an
 * identical claim (same target, anchor and polarity) is de-duplicated
 * deterministically (the first occurrence stands); two different polarities on
 * one anchor within one target are admissible only as the positive/negative
 * pair of a Mixed target — any other differing pair is a contradiction.
 */
function resolveOneRef(
	anchors: Map<string, EvidenceAnchor>,
	ref: SentimentEvidenceRef,
	index: number,
	where: EvidenceWhere,
	category: SentimentCategory,
	seenClaims: Set<string>,
	polaritiesByAnchor: Map<string, Set<EvidencePolarity>>,
	groundingMap: GroundingMap | null,
): SentimentEvidence | null {
	const anchor = anchors.get(ref.anchorId);
	if (!anchor) {
		fail("evidence-unknown-anchor", `${where.label}: anchor "${ref.anchorId}" is not part of the answer`, where, {
			evidenceIndex: index,
			anchorId: /^s\d{4}$/.test(ref.anchorId) ? ref.anchorId : undefined,
		});
	}
	const grounding = groundingMap?.get(ref.anchorId);
	if (grounding && namesOnlyOthers(grounding, where.entityKey)) {
		fail(
			"evidence-entity-unbound",
			`${where.label}: anchor "${ref.anchorId}" names another candidate but not this one`,
			where,
			{ evidenceIndex: index, anchorId: ref.anchorId },
		);
	}
	const identity = claimIdentity(where, ref);
	if (seenClaims.has(identity)) return null;
	seenClaims.add(identity);
	const polarities = polaritiesByAnchor.get(ref.anchorId) ?? new Set<EvidencePolarity>();
	polarities.add(ref.polarity);
	polaritiesByAnchor.set(ref.anchorId, polarities);
	const mixedPair = polarities.size === 2 && polarities.has("positive") && polarities.has("negative");
	if (polarities.size > 1 && !(category === "mixed" && mixedPair)) {
		fail(
			"evidence-anchor-polarity-conflict",
			`${where.label}: anchor "${ref.anchorId}" cited with two polarities for one target outside a mixed verdict`,
			where,
			{ evidenceIndex: index, anchorId: ref.anchorId },
		);
	}
	return { quote: anchor.text, start: anchor.start, end: anchor.end, polarity: ref.polarity };
}

/**
 * The polarities a target's citations may carry, by category (classifier
 * v4): a Positive, Negative or Neutral verdict cites only its own polarity;
 * a Mixed verdict cites at least one positive and at least one negative
 * anchor and nothing else. The wire schema makes other combinations
 * unrepresentable; this is the independent second boundary.
 */
function assertPolarityFitsCategory(
	where: EvidenceWhere,
	category: SentimentCategory,
	resolved: SentimentEvidence[],
): void {
	const polarities = new Set(resolved.map((e) => e.polarity));
	const fits =
		category === "mixed"
			? polarities.has("positive") && polarities.has("negative") && !polarities.has("neutral")
			: polarities.size === 1 && polarities.has(category);
	if (fits) return;
	if (category === "mixed" && !(polarities.has("positive") && polarities.has("negative"))) {
		fail("mixed-needs-dual-evidence", `${where.label}: mixed requires one positive and one negative citation`, {
			...where,
			stage: "cross-field",
		});
	}
	fail("polarity-category-mismatch", `${where.label}: ${category} verdict cites ${[...polarities].sort().join("/")} evidence`, {
		...where,
		stage: "cross-field",
	});
}

/**
 * Resolve cited anchors into stored evidence for one target: every id must
 * belong to this answer, identical claims collapse to one, an anchor that
 * names only other candidates is refused, one anchor may carry positive and
 * negative only for a Mixed target, the polarities must fit the category,
 * and at least one anchor must be attributable to the target's entity. The
 * stored form is the exact raw slice of the anchor.
 */
function resolveEvidence(
	anchors: Map<string, EvidenceAnchor>,
	refs: SentimentEvidenceRef[],
	where: EvidenceWhere,
	category: SentimentCategory,
	groundingMap: GroundingMap | null,
): SentimentEvidence[] {
	const resolved: SentimentEvidence[] = [];
	const seenClaims = new Set<string>();
	const polaritiesByAnchor = new Map<string, Set<EvidencePolarity>>();
	const resolvedIds: string[] = [];
	refs.forEach((ref, index) => {
		const evidence = resolveOneRef(anchors, ref, index, where, category, seenClaims, polaritiesByAnchor, groundingMap);
		if (evidence) {
			resolved.push(evidence);
			resolvedIds.push(ref.anchorId);
		}
	});
	assertPolarityFitsCategory(where, category, resolved);
	if (groundingMap) {
		const attributable = resolvedIds.some((id) => {
			const grounding = groundingMap.get(id);
			return grounding !== undefined && isAttributable(grounding, where.entityKey);
		});
		if (!attributable) {
			fail(
				where.aspectKey === null ? "entity-ungrounded" : "aspect-ungrounded",
				`${where.label}: no cited anchor is attributable to this entity`,
				{ ...where, stage: "cross-field" },
			);
		}
	}
	return resolved;
}

/** Aspect rows of one entity: unique keys, consistent score/category, resolved citations. */
function validateAspects(
	anchors: Map<string, EvidenceAnchor>,
	entity: SentimentClassificationResult["entities"][number],
	groundingMap: GroundingMap | null,
): ValidatedAspect[] {
	const aspectKeys = new Set<string>();
	const aspects: ValidatedAspect[] = [];
	for (const aspect of entity.aspects) {
		const at: EvidenceWhere = {
			stage: "aspect",
			entityKey: entity.key,
			aspectKey: aspect.key,
			label: `entity "${entity.key}" aspect "${aspect.key}"`,
		};
		if (aspectKeys.has(aspect.key)) fail("duplicate-aspect", `${at.label} returned twice`, at);
		aspectKeys.add(aspect.key);
		if (!isScoreCategoryConsistent(aspect.score, aspect.category)) {
			fail("score-category", `${at.label}: ${aspect.category} does not fit score ${aspect.score}`, {
				...at,
				stage: "cross-field",
			});
		}
		aspects.push({
			key: aspect.key,
			score: aspect.score,
			category: aspect.category,
			confidence: aspect.confidence,
			evidence: resolveEvidence(anchors, aspect.evidence, { ...at, stage: "evidence" }, aspect.category, groundingMap),
		});
	}
	return aspects;
}

/**
 * Local validation of a provider answer in its wire shape (classifier v4),
 * independent of what the provider already parsed: the discriminated shape,
 * then every rule of `validateClassification`. Anything invalid throws with a
 * bounded diagnostic and nothing is persisted.
 */
export function validateSentimentResult(
	raw: unknown,
	args: {
		answerBody: string;
		candidates: SentimentCandidate[];
		anchors?: readonly EvidenceAnchor[];
		analysis?: AnalyzableText;
	},
): ValidatedEntitySentiment[] {
	const parsed = sentimentProviderResultSchema.safeParse(raw);
	if (!parsed.success) {
		fail("schema", parsed.error.issues[0]?.message ?? "invalid classifier output", { stage: "provider-schema" });
	}
	return validateClassification(toClassificationResult(parsed.data), args);
}

/**
 * The rules over the internal claim representation, shared by the wire
 * validation, the canary, the shadow oracle and the golden corpus: every
 * supplied candidate exactly once and nothing else, score/category
 * consistency, every citation an anchor of this very answer (resolved here to
 * the exact raw slice and offsets), polarities that fit the category, a
 * positive and a negative citation for Mixed, at most one result per aspect
 * key, and deterministic entity grounding of every target.
 */
export function validateClassification(
	raw: unknown,
	args: {
		answerBody: string;
		candidates: SentimentCandidate[];
		anchors?: readonly EvidenceAnchor[];
		analysis?: AnalyzableText;
		/** `false` replays rows produced before the grounding guard existed without it; production always grounds. */
		grounding?: boolean;
	},
): ValidatedEntitySentiment[] {
	const anchorList = [
		...(args.anchors ?? segmentAnswer(args.answerBody, args.analysis ?? analyzeAnswerRanges(args.answerBody))),
	];
	const anchors = anchorMap(anchorList);
	const groundingMap = args.grounding === false ? null : groundAnchors(args.answerBody, anchorList, args.candidates);
	const parsed = sentimentClassificationResultSchema.safeParse(raw);
	if (!parsed.success) {
		fail("schema", parsed.error.issues[0]?.message ?? "invalid classifier output", { stage: "provider-schema" });
	}
	const result: SentimentClassificationResult = parsed.data;
	const expected = new Set(args.candidates.map((c) => c.key));
	const seen = new Set<string>();
	const entities: ValidatedEntitySentiment[] = [];

	for (const entity of result.entities) {
		const at: EvidenceWhere = {
			stage: "entity",
			entityKey: entity.key,
			aspectKey: null,
			label: `entity "${entity.key}"`,
		};
		if (!expected.has(entity.key)) fail("unknown-entity", `${at.label} was not a candidate`, at);
		if (seen.has(entity.key)) fail("duplicate-entity", `${at.label} returned twice`, at);
		seen.add(entity.key);
		if (!isScoreCategoryConsistent(entity.score, entity.category)) {
			fail("score-category", `${at.label}: ${entity.category} does not fit score ${entity.score}`, {
				...at,
				stage: "cross-field",
			});
		}
		const evidence = resolveEvidence(anchors, entity.evidence, { ...at, stage: "evidence" }, entity.category, groundingMap);
		const aspects = validateAspects(anchors, entity, groundingMap);
		entities.push({
			key: entity.key,
			score: entity.score,
			category: entity.category,
			confidence: entity.confidence,
			evidence,
			aspects,
		});
	}

	for (const key of expected) {
		if (!seen.has(key))
			fail("missing-entity", `candidate "${key}" was not classified`, { stage: "entity", entityKey: key });
	}
	return entities;
}

export interface SentimentClassifierDeps {
	/** Injected in tests; production always resolves the locked OpenRouter path. */
	resolveProvider?: () => Provider;
}

/** Anchors of the answer, computed before any request; an answer that cannot be represented is refused without spending. */
function anchorsBeforeRequest(answerBody: string, analysis: AnalyzableText): EvidenceAnchor[] {
	let anchors: EvidenceAnchor[];
	try {
		anchors = segmentAnswer(answerBody, analysis);
	} catch (error) {
		if (error instanceof SentimentValidationError) throw error.beforeRequest();
		throw error;
	}
	if (anchors.length === 0) {
		throw new SentimentValidationError(
			"answer-unsegmentable",
			"the answer has no citable segment",
			diagnostic("evidence", "answer-unsegmentable"),
		).beforeRequest();
	}
	return anchors;
}

/** The citation/natural range analysis, computed before any request; a body the analysis cannot represent is refused without spending. */
function rangesBeforeRequest(answerBody: string): AnalyzableText {
	try {
		return analyzeAnswerRanges(answerBody);
	} catch (error) {
		if (error instanceof SentimentValidationError) throw error.beforeRequest();
		throw error;
	}
}

type ResearchResult = Awaited<ReturnType<NonNullable<Provider["runStructuredResearch"]>>>;

/**
 * The one provider request. A response the provider itself could not turn
 * into the requested object is a paid, terminal defect of this answer and is
 * rethrown as a validation error carrying the response envelope.
 */
async function requestClassification(
	provider: Provider,
	prompt: string,
	anchorIds: string[],
	entityKeys: string[],
	signal: AbortSignal | undefined,
): Promise<ResearchResult> {
	if (!provider.runStructuredResearch) {
		throw new Error(`Provider "${provider.id}" does not implement structured research`);
	}
	try {
		return await provider.runStructuredResearch({
			prompt,
			schema: sentimentProviderResultSchemaFor(anchorIds, entityKeys),
			webSearch: true,
			signal,
			maxOutputTokens: SENTIMENT_MAX_OUTPUT_TOKENS,
		});
	} catch (error) {
		if (error instanceof StructuredResearchResponseError) {
			throw new SentimentValidationError(
				error.code,
				error.message,
				diagnostic("provider-schema", error.code === "no-content" ? "invalid-json" : error.code),
			).withEnvelope({
				generationId: error.envelope.generationId,
				request: error.envelope.request,
				usage: error.envelope.usage ?? null,
			});
		}
		throw error;
	}
}

/**
 * One structured-research call per prompt run through the locked provider
 * path (web search on, so the model can disambiguate identities), validated
 * locally before anything is persisted. Retry policy belongs to the queue;
 * a locally rejected paid answer is terminal for this exact input.
 */
export async function classifySentiment(
	args: { answerBody: string; candidates: SentimentCandidate[] },
	deps: SentimentClassifierDeps = {},
	signal?: AbortSignal,
): Promise<SentimentClassification> {
	if (args.candidates.length === 0) {
		throw new SentimentValidationError(
			"no-candidates",
			"nothing to classify",
			diagnostic("entity", "no-candidates"),
		).beforeRequest();
	}
	const analysis = rangesBeforeRequest(args.answerBody);
	const anchors = anchorsBeforeRequest(args.answerBody, analysis);
	const provider = deps.resolveProvider ? deps.resolveProvider() : resolveSentimentProvider();
	const result = await requestClassification(
		provider,
		buildSentimentPrompt({ ...args, anchors }),
		anchors.map((anchor) => anchor.id),
		args.candidates.map((candidate) => candidate.key),
		signal,
	);
	// From here on the provider has answered and charged: every rejection
	// carries the paid response's envelope so the cost and the generation
	// are never lost with the answer.
	const envelope: PaidResponseEnvelope = {
		generationId: safeGenerationId(result.generationId),
		request: result.request ?? null,
		usage: result.usage ?? null,
	};
	try {
		if (provider.id === SENTIMENT_PROVIDER_ID && result.modelVersion !== SENTIMENT_MODEL) {
			throw new SentimentValidationError(
				"model-mismatch",
				`sentiment is locked to ${SENTIMENT_MODEL}; provider answered with ${result.modelVersion ?? "unknown"}`,
				diagnostic("provider-schema", "model-mismatch"),
			);
		}
		return {
			entities: validateSentimentResult(result.object, { ...args, anchors, analysis }),
			provider: provider.id,
			model: result.modelVersion ?? null,
			webSearch: true,
			classifierVersion: SENTIMENT_CLASSIFIER_VERSION,
			taxonomyVersion: SENTIMENT_TAXONOMY_VERSION,
			inputHash: sentimentInputHash(args.answerBody, args.candidates, analysis),
			usage: result.usage,
			request: result.request,
			generationId: envelope.generationId,
		};
	} catch (error) {
		if (error instanceof SentimentValidationError) throw error.withEnvelope(envelope);
		throw error;
	}
}
