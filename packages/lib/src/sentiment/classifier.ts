import { createHash } from "node:crypto";
import type { z } from "zod";
import { API_PROVIDER_MAX_OUTPUT_TOKENS } from "../providers/config";
import { toStructuredOutputJsonSchema } from "../providers/json-schema";
import type { Provider, StructuredResearchRequestSummary, StructuredResearchUsage } from "../providers/types";
import { StructuredResearchResponseError } from "../providers/types";
import { anchorMap, type EvidenceAnchor, hasTableRows, SENTIMENT_EVIDENCE_VERSION, segmentAnswer } from "./anchors";
import { type DiagnosticReason, type DiagnosticStage, diagnostic, safeGenerationId } from "./diagnostics";
import { safeEnvelope } from "./errors";
import { type PaidResponseEnvelope, SentimentValidationError } from "./errors-validation";
import { belongsOnlyToOthers, type GroundingMap, groundAnchors, isAttributable } from "./grounding";
import { buildSentimentPrompt } from "./prompt";
import { resolveSentimentProvider } from "./provider";
import { type AnalyzableText, analyzableText, analyzeAnswerRanges } from "./ranges";
import type { VerifierIssueCode } from "./resolution";
import { schemaBudgetViolations } from "./schema-budget";
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
	sortSentimentEntities,
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

/**
 * One aspect claim the provider proposed that the answer does not support for
 * that entity (classifier v5). Dropped from the result and recorded for the
 * operator: identifiers and the allow-listed code only — never text.
 */
/** An aspect claim the independent verifier objected to; the claim is dropped, the entity's overall verdict stands. */
export type VerifierFilteredClaimCode = `verifier:${VerifierIssueCode}`;
export type FilteredClaimCode = AspectLocalValidationCode | VerifierFilteredClaimCode;

export interface FilteredClaim {
	entityKey: string;
	aspectKey: SentimentAspectKey;
	code: FilteredClaimCode;
	/** The anchor ids the claim cited, in citation order, de-duplicated. */
	anchorIds: string[];
}

/**
 * The closed set of validation codes that are local to one aspect claim: each
 * says "this aspect's citations do not support this aspect for this entity"
 * and nothing about the entity's overall verdict or the answer as a whole.
 * Raised against an aspect target they drop that claim alone (classifier v5);
 * raised against an overall target — or any code outside this list on any
 * target — they stay terminal for the whole analysis. Fail closed: a new code
 * is terminal until it is deliberately added here.
 */
export const ASPECT_LOCAL_VALIDATION_CODES = Object.freeze([
	"aspect-ungrounded",
	"evidence-entity-unbound",
	"polarity-category-mismatch",
	"mixed-needs-dual-evidence",
	"evidence-anchor-polarity-conflict",
] as const);
export type AspectLocalValidationCode = (typeof ASPECT_LOCAL_VALIDATION_CODES)[number];

export function isAspectLocalValidationCode(code: unknown): code is AspectLocalValidationCode {
	return typeof code === "string" && (ASPECT_LOCAL_VALIDATION_CODES as readonly string[]).includes(code);
}

/** Dropped claims by allow-listed code, for operator reports; codes only. */
export function countFilteredClaimCodes(claims: readonly FilteredClaim[]): Record<string, number> {
	const counts: Record<string, number> = {};
	for (const claim of claims) counts[claim.code] = (counts[claim.code] ?? 0) + 1;
	return counts;
}

export interface SentimentClassification {
	/** Entities whose overall verdict (and surviving aspects) the answer supports. */
	entities: ValidatedEntitySentiment[];
	/** Aspect claims dropped as unsupported (classifier v5); empty when every claim was grounded. */
	filteredClaims: FilteredClaim[];
	/** Entities still needing a targeted repair before the candidate can be verified (ADR Amendment B). */
	unresolvedTargets: UnresolvedTarget[];
	/** A defect of the answer's contract the model cannot repair; the case leaves the automatic workflow. */
	contractDefect: { code: DiagnosticReason } | null;
	/** The provider's candidate in the internal claim representation (keys, verdicts, anchor ids, polarities — no text). */
	candidate: SentimentClassificationResult | null;
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
 * analysis. The model reads the answer as segments, so the segmentation is
 * part of the input too: an answer whose segments the evidence contract
 * version changed (a table row is cell by cell since sent-evidence-v3) carries
 * that version, while an answer segmented identically under every version
 * keeps its hash, and with it every stored candidate that still applies.
 */
export function sentimentInputHash(
	answerBody: string,
	candidates: SentimentCandidate[],
	analysis: AnalyzableText = analyzeAnswerRanges(answerBody),
): string {
	const canonical = {
		body: normalizeText(analyzableText(analysis)),
		...(hasTableRows(answerBody) ? { evidence: SENTIMENT_EVIDENCE_VERSION } : {}),
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
 * One citation of one target: the anchor must belong to the answer and must
 * not be another candidate's evidence (by name or by structural context —
 * the neighbouring cell of a comparison table, the other entity's section);
 * an identical claim (same target, anchor and polarity) is de-duplicated
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
	if (grounding && belongsOnlyToOthers(grounding, where.entityKey)) {
		fail(
			"evidence-entity-unbound",
			`${where.label}: anchor "${ref.anchorId}" is attributed to another candidate but not this one`,
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
	fail(
		"polarity-category-mismatch",
		`${where.label}: ${category} verdict cites ${[...polarities].sort().join("/")} evidence`,
		{
			...where,
			stage: "cross-field",
		},
	);
}

/**
 * Resolve cited anchors into stored evidence for one target: every id must
 * belong to this answer, identical claims collapse to one, an anchor that is
 * only another candidate's (by name or by context) is refused whatever its
 * neighbours are, one anchor may carry positive and negative only for a Mixed
 * target, the polarities must fit the category, and at least one anchor must
 * be attributable to the target's entity. The stored form is the exact raw
 * slice of the anchor.
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

/**
 * Whether a validation error raised while resolving one aspect's citations is
 * that aspect's own defect: an allow-listed code whose diagnostic names exactly
 * this entity and this aspect. Anything else — another code, a diagnostic for
 * another target, a foreign error — is not filtered.
 */
function isLocalAspectDefect(
	error: unknown,
	entityKey: string,
	aspectKey: SentimentAspectKey,
): error is SentimentValidationError & { code: AspectLocalValidationCode } {
	return (
		error instanceof SentimentValidationError &&
		isAspectLocalValidationCode(error.code) &&
		error.diagnostic?.entityKey === entityKey &&
		error.diagnostic?.aspectKey === aspectKey
	);
}

/**
 * Aspect rows of one entity: unique keys and consistent score/category are
 * contract defects and terminal; the citations of each aspect are resolved on
 * their own, and an aspect whose citations do not support it for this entity
 * (an allow-listed aspect-local code) is dropped into `filtered` instead of
 * failing the analysis (classifier v5). An omitted aspect is never replaced by
 * a neutral placeholder.
 */
function validateAspects(
	anchors: Map<string, EvidenceAnchor>,
	entity: SentimentClassificationResult["entities"][number],
	groundingMap: GroundingMap | null,
	filtered: FilteredClaim[],
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
		let evidence: SentimentEvidence[];
		try {
			evidence = resolveEvidence(anchors, aspect.evidence, { ...at, stage: "evidence" }, aspect.category, groundingMap);
		} catch (error) {
			if (!isLocalAspectDefect(error, entity.key, aspect.key)) throw error;
			filtered.push({
				entityKey: entity.key,
				aspectKey: aspect.key,
				code: error.code,
				anchorIds: [...new Set(aspect.evidence.map((ref) => ref.anchorId))],
			});
			continue;
		}
		aspects.push({
			key: aspect.key,
			score: aspect.score,
			category: aspect.category,
			confidence: aspect.confidence,
			evidence,
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
	return validateSentimentResultDetailed(raw, args).entities;
}

/** `validateSentimentResult` together with the aspect claims it dropped. */
export function validateSentimentResultDetailed(
	raw: unknown,
	args: {
		answerBody: string;
		candidates: SentimentCandidate[];
		anchors?: readonly EvidenceAnchor[];
		analysis?: AnalyzableText;
	},
): ValidatedClassification {
	const parsed = sentimentProviderResultSchema.safeParse(raw);
	if (!parsed.success) {
		fail("schema", parsed.error.issues[0]?.message ?? "invalid classifier output", { stage: "provider-schema" });
	}
	return validateClassificationDetailed(toClassificationResult(parsed.data), args);
}

export interface ValidatedClassification {
	entities: ValidatedEntitySentiment[];
	filteredClaims: FilteredClaim[];
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
	return validateClassificationDetailed(raw, args).entities;
}

/**
 * `validateClassification` with the audit of what was dropped: the mandatory
 * overall verdict of every candidate is validated first and any defect there
 * is terminal; each aspect claim is then validated on its own and an
 * unsupported one is returned in `filteredClaims` instead of failing the
 * analysis (classifier v5). A result with a valid overall for every candidate
 * and no surviving aspect is complete.
 */
export function validateClassificationDetailed(
	raw: unknown,
	args: {
		answerBody: string;
		candidates: SentimentCandidate[];
		anchors?: readonly EvidenceAnchor[];
		analysis?: AnalyzableText;
		grounding?: boolean;
	},
): ValidatedClassification {
	const ctx = buildValidationContext(args);
	const parsed = sentimentClassificationResultSchema.safeParse(raw);
	if (!parsed.success) {
		fail("schema", parsed.error.issues[0]?.message ?? "invalid classifier output", { stage: "provider-schema" });
	}
	const result: SentimentClassificationResult = parsed.data;
	const expected = new Set(args.candidates.map((c) => c.key));
	const seen = new Set<string>();
	const entities: ValidatedEntitySentiment[] = [];
	const filteredClaims: FilteredClaim[] = [];

	for (const entity of result.entities) {
		const label = `entity "${entity.key}"`;
		if (!expected.has(entity.key))
			fail("unknown-entity", `${label} was not a candidate`, { stage: "entity", entityKey: entity.key });
		if (seen.has(entity.key))
			fail("duplicate-entity", `${label} returned twice`, { stage: "entity", entityKey: entity.key });
		seen.add(entity.key);
		entities.push(validateOneEntity(entity, ctx, filteredClaims));
	}

	for (const key of expected) {
		if (!seen.has(key))
			fail("missing-entity", `candidate "${key}" was not classified`, { stage: "entity", entityKey: key });
	}
	return { entities, filteredClaims };
}

/** Anchors and grounding of one answer, computed once for every entity of a candidate. */
export interface ValidationContext {
	anchorList: EvidenceAnchor[];
	anchors: Map<string, EvidenceAnchor>;
	groundingMap: GroundingMap | null;
}

export function buildValidationContext(args: {
	answerBody: string;
	candidates: SentimentCandidate[];
	anchors?: readonly EvidenceAnchor[];
	analysis?: AnalyzableText;
	grounding?: boolean;
}): ValidationContext {
	const anchorList = [
		...(args.anchors ?? segmentAnswer(args.answerBody, args.analysis ?? analyzeAnswerRanges(args.answerBody))),
	];
	return {
		anchorList,
		anchors: anchorMap(anchorList),
		groundingMap: args.grounding === false ? null : groundAnchors(args.answerBody, anchorList, args.candidates),
	};
}

/**
 * One entity of a candidate: score/category consistency, its overall
 * citations resolved and grounded, its aspects validated on their own (an
 * allow-listed aspect defect lands in `filtered`). Throws the entity's own
 * defect; the caller decides whether that is terminal or a repair target.
 */
export function validateOneEntity(
	entity: SentimentClassificationResult["entities"][number],
	ctx: ValidationContext,
	filtered: FilteredClaim[],
): ValidatedEntitySentiment {
	const at: EvidenceWhere = {
		stage: "entity",
		entityKey: entity.key,
		aspectKey: null,
		label: `entity "${entity.key}"`,
	};
	if (!isScoreCategoryConsistent(entity.score, entity.category)) {
		fail("score-category", `${at.label}: ${entity.category} does not fit score ${entity.score}`, {
			...at,
			stage: "cross-field",
		});
	}
	const evidence = resolveEvidence(
		ctx.anchors,
		entity.evidence,
		{ ...at, stage: "evidence" },
		entity.category,
		ctx.groundingMap,
	);
	const aspects = validateAspects(ctx.anchors, entity, ctx.groundingMap, filtered);
	return {
		key: entity.key,
		score: entity.score,
		category: entity.category,
		confidence: entity.confidence,
		evidence,
		aspects,
	};
}

/**
 * One entity whose overall verdict the current candidate does not support,
 * with the safe reason: a deterministic validation code, or a verifier issue
 * prefixed `verifier:`. Identifiers only — never text.
 */
export interface UnresolvedTarget {
	entityKey: string;
	reason: string;
	aspectKey: SentimentAspectKey | null;
	anchorId: string | null;
	source: "deterministic" | "verifier";
}

export interface CandidateAssessment {
	/** Entities whose overall verdict and surviving aspects are grounded. */
	entities: ValidatedEntitySentiment[];
	filteredClaims: FilteredClaim[];
	/** Entities that still need a repair before the candidate can be verified. */
	unresolved: UnresolvedTarget[];
	/** A defect the model cannot repair (wire shape, unknown or duplicate entity): the case leaves the automatic workflow. */
	contractDefect: { code: DiagnosticReason } | null;
}

/** Codes that mean the candidate as a whole breaks the request contract rather than one entity's grounding. */
const CONTRACT_DEFECT_CODES = new Set<string>(["schema", "unknown-entity", "duplicate-entity"]);

/**
 * Deterministic assessment of a candidate (ADR Amendment B, phase B): every
 * entity is validated on its own; an allow-listed aspect defect drops that
 * aspect; any other defect of an entity — its overall verdict, a malformed
 * aspect — makes that entity an unresolved repair target; a missing entity is
 * an unresolved target too. Nothing here is a product outcome.
 */
export function assessCandidate(
	raw: unknown,
	args: {
		answerBody: string;
		candidates: SentimentCandidate[];
		anchors?: readonly EvidenceAnchor[];
		analysis?: AnalyzableText;
	},
): CandidateAssessment {
	const parsed = sentimentClassificationResultSchema.safeParse(raw);
	if (!parsed.success) return { entities: [], filteredClaims: [], unresolved: [], contractDefect: { code: "schema" } };
	const expected = new Set(args.candidates.map((c) => c.key));
	const seen = new Set<string>();
	for (const entity of parsed.data.entities) {
		if (!expected.has(entity.key))
			return { entities: [], filteredClaims: [], unresolved: [], contractDefect: { code: "unknown-entity" } };
		if (seen.has(entity.key))
			return { entities: [], filteredClaims: [], unresolved: [], contractDefect: { code: "duplicate-entity" } };
		seen.add(entity.key);
	}
	const ctx = buildValidationContext(args);
	const entities: ValidatedEntitySentiment[] = [];
	const filteredClaims: FilteredClaim[] = [];
	const unresolved: UnresolvedTarget[] = [];
	for (const entity of parsed.data.entities) {
		const filtered: FilteredClaim[] = [];
		try {
			entities.push(validateOneEntity(entity, ctx, filtered));
			filteredClaims.push(...filtered);
		} catch (error) {
			if (!(error instanceof SentimentValidationError)) throw error;
			if (CONTRACT_DEFECT_CODES.has(error.code)) {
				return {
					entities: [],
					filteredClaims: [],
					unresolved: [],
					contractDefect: { code: error.code as DiagnosticReason },
				};
			}
			unresolved.push({
				entityKey: entity.key,
				reason: error.code,
				aspectKey: error.diagnostic?.aspectKey ?? null,
				anchorId: error.diagnostic?.anchorId ?? null,
				source: "deterministic",
			});
		}
	}
	for (const candidate of sortSentimentEntities(args.candidates)) {
		if (!seen.has(candidate.key)) {
			unresolved.push({
				entityKey: candidate.key,
				reason: "missing-entity",
				aspectKey: null,
				anchorId: null,
				source: "deterministic",
			});
		}
	}
	return { entities, filteredClaims, unresolved, contractDefect: null };
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
 * The exact JSON Schema this request would carry is measured against the
 * provider's documented strict structured-output limits before anything is
 * sent. The schema is a deterministic function of the answer's anchors and the
 * candidate roster, so a schema that breaks a limit is a terminal defect of
 * this input, refused without spending; a retry could only produce the same
 * schema.
 */
function assertRequestSchemaBudget(schema: z.ZodType): void {
	const violations = schemaBudgetViolations(toStructuredOutputJsonSchema(schema));
	if (violations.length === 0) return;
	const first = violations[0];
	throw new SentimentValidationError(
		"schema-budget-exceeded",
		`request schema breaks the provider limit ${first.rule}: ${first.actual} (limit ${first.limit})`,
		diagnostic("provider-schema", "schema-budget-exceeded"),
	).beforeRequest();
}

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
	const schema = sentimentProviderResultSchemaFor(anchorIds, entityKeys);
	assertRequestSchemaBudget(schema);
	try {
		return await provider.runStructuredResearch({
			prompt,
			schema,
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
 * The initial structured-research call for a prompt run through the locked
 * provider path (web search on, so the model can disambiguate identities),
 * assessed locally: grounded entities are accepted, unsupported aspect claims
 * dropped, defective overall verdicts become repair targets. Only a response
 * the provider could not shape, a wrong model or an answer breaking the
 * request contract throws (classifier v5, ADR Amendment B).
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
		const wire = sentimentProviderResultSchema.safeParse(result.object);
		if (!wire.success) {
			throw new SentimentValidationError(
				"schema",
				wire.error.issues[0]?.message ?? "invalid classifier output",
				diagnostic("provider-schema", "schema"),
			);
		}
		const candidate = toClassificationResult(wire.data);
		const assessment = assessCandidate(candidate, { ...args, anchors, analysis });
		return {
			entities: assessment.entities,
			filteredClaims: assessment.filteredClaims,
			unresolvedTargets: assessment.unresolved,
			contractDefect: assessment.contractDefect,
			candidate,
			provider: provider.id,
			model: result.modelVersion ?? null,
			webSearch: true,
			classifierVersion: SENTIMENT_CLASSIFIER_VERSION,
			taxonomyVersion: SENTIMENT_TAXONOMY_VERSION,
			inputHash: sentimentInputHash(args.answerBody, args.candidates, analysis),
			// The same allowlist a rejected answer's envelope goes through: only the
			// locked model's request summary and finite numeric usage ever leave here.
			usage: safeEnvelope(envelope)?.usage ?? undefined,
			request: safeEnvelope(envelope)?.request ?? undefined,
			generationId: envelope.generationId,
		};
	} catch (error) {
		if (error instanceof SentimentValidationError) throw error.withEnvelope(envelope);
		throw error;
	}
}
