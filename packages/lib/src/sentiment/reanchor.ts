import { createHash } from "node:crypto";
import { type EvidenceAnchor, segmentAnswer } from "./anchors";
import { assessCandidate, sentimentInputHash } from "./classifier";
import { belongsOnlyToOthers, groundAnchors, isAttributable } from "./grounding";
import { type AnalyzableText, analyzeAnswerRanges } from "./ranges";
import {
	EVIDENCE_MAX_ITEMS,
	type SentimentAspectKey,
	type SentimentCandidate,
	type SentimentCategory,
	type SentimentClassificationResult,
	type SentimentEvidence,
	type SentimentEvidenceRef,
	sentimentClassificationResultSchema,
} from "./types";

/**
 * Re-anchoring of a stored result under the current evidence contract
 * (SENT-ATTR-01). A stored evidence span was one anchor when it was written;
 * under a newer segmentation it may now cover several anchors — the cells of
 * a table row — of which only the ones attributable to the span's entity are
 * that entity's evidence. The plan is pure: it says what the stored result
 * becomes (the same result, the same result under the current input hash, a
 * narrowed candidate to verify or repair, or nothing usable) and never writes.
 */

export interface StoredTargetResult {
	category: SentimentCategory;
	score: number;
	confidence: number;
	evidence: SentimentEvidence[];
}

export interface StoredEntityResult extends StoredTargetResult {
	key: string;
	aspects: (StoredTargetResult & { key: SentimentAspectKey })[];
}

export type SpanMapping =
	/** The span is exactly one current anchor that is not another entity's. */
	| { kind: "identical"; anchorId: string }
	/** The span is exactly one current anchor, but that anchor is another entity's evidence: it is dropped. */
	| { kind: "foreign"; anchorId: string }
	/** The span covers several current anchors; only the entity's own are kept. */
	| { kind: "narrowed"; kept: string[]; droppedOthers: string[]; droppedGeneric: string[] }
	/** The span slices no current anchor exactly: nothing of it can be carried over. */
	| { kind: "unmapped" };

export type ReanchorAction =
	/** Every span is one current anchor, the result validates and the stored input hash is current: nothing to do. */
	| "current"
	/** Same as `current` except the stored input hash predates the contract: only the hash is stale. */
	| "restamp"
	/** Spans were narrowed (or a claim is filtered under the current rules); the narrowed candidate needs independent verification. */
	| "reverify"
	/** The narrowed candidate leaves an entity's overall verdict unsupported; it needs a repair before verification. */
	| "repair"
	/** Nothing of the stored result can be carried over for at least one entity: classify the answer again. */
	| "reclassify";

export interface ReanchorPlan {
	action: ReanchorAction;
	inputHash: string;
	storedInputHash: string | null;
	/** The provisional candidate a `reverify`/`repair` continues from; null otherwise. */
	candidate: SentimentClassificationResult | null;
	mappings: { entityKey: string; aspectKey: SentimentAspectKey | null; index: number; mapping: SpanMapping }[];
	/** Aspect claims whose every span belonged to somebody else, or to nobody after narrowing. */
	droppedAspects: { entityKey: string; aspectKey: SentimentAspectKey }[];
	/** Why a `reclassify` was chosen. */
	reason: string | null;
	/** sha256 of the stored entities as given, for a write's precondition. */
	storedDigest: string;
}

function digestOf(value: unknown): string {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function mapSpan(
	span: SentimentEvidence,
	answerBody: string,
	anchors: readonly EvidenceAnchor[],
	grounding: ReturnType<typeof groundAnchors>,
	entityKey: string,
): SpanMapping {
	if (answerBody.slice(span.start, span.end) !== span.quote) return { kind: "unmapped" };
	const inside = anchors.filter((a) => a.start >= span.start && a.end <= span.end);
	if (inside.length === 0) return { kind: "unmapped" };
	if (inside.length === 1 && inside[0].start === span.start && inside[0].end === span.end) {
		const g = grounding.get(inside[0].id);
		return g && belongsOnlyToOthers(g, entityKey)
			? { kind: "foreign", anchorId: inside[0].id }
			: { kind: "identical", anchorId: inside[0].id };
	}
	const kept: string[] = [];
	const droppedOthers: string[] = [];
	const droppedGeneric: string[] = [];
	for (const anchor of inside) {
		const g = grounding.get(anchor.id);
		if (g && isAttributable(g, entityKey)) kept.push(anchor.id);
		else if (g && belongsOnlyToOthers(g, entityKey)) droppedOthers.push(anchor.id);
		else droppedGeneric.push(anchor.id);
	}
	return { kind: "narrowed", kept, droppedOthers, droppedGeneric };
}

function refsOf(mappings: SpanMapping[], evidence: SentimentEvidence[]): SentimentEvidenceRef[] | null {
	const refs: SentimentEvidenceRef[] = [];
	const seen = new Set<string>();
	mappings.forEach((mapping, index) => {
		if (mapping.kind === "unmapped" || mapping.kind === "foreign") return;
		const ids = mapping.kind === "identical" ? [mapping.anchorId] : mapping.kept;
		for (const anchorId of ids) {
			const identity = `${anchorId}|${evidence[index].polarity}`;
			if (seen.has(identity)) continue;
			seen.add(identity);
			refs.push({ anchorId, polarity: evidence[index].polarity });
		}
	});
	if (refs.length > EVIDENCE_MAX_ITEMS * 2) return null;
	return refs;
}

/** Mutable state of one planning pass: every span mapping, dropped aspects, the first reason to classify again. */
interface Pass {
	answerBody: string;
	anchors: readonly EvidenceAnchor[];
	grounding: ReturnType<typeof groundAnchors>;
	mappings: ReanchorPlan["mappings"];
	droppedAspects: ReanchorPlan["droppedAspects"];
	narrowed: boolean;
	reclassify: string | null;
}

/** The refs one stored target carries over; null when the target cannot be carried over at all. */
function carryTarget(
	pass: Pass,
	entityKey: string,
	aspectKey: SentimentAspectKey | null,
	stored: StoredTargetResult,
): SentimentEvidenceRef[] | null {
	const label = `${entityKey}${aspectKey ? `/${aspectKey}` : ""}`;
	const perSpan = stored.evidence.map((span) =>
		mapSpan(span, pass.answerBody, pass.anchors, pass.grounding, entityKey),
	);
	for (const [index, mapping] of perSpan.entries()) pass.mappings.push({ entityKey, aspectKey, index, mapping });
	if (perSpan.some((m) => m.kind === "unmapped")) {
		pass.reclassify ??= `${label}: a stored span is not a slice of the current anchors`;
		return null;
	}
	if (perSpan.some((m) => m.kind === "narrowed" || m.kind === "foreign")) pass.narrowed = true;
	const refs = refsOf(perSpan, stored.evidence);
	if (refs === null) pass.reclassify ??= `${label}: narrowed evidence exceeds ${EVIDENCE_MAX_ITEMS * 2} citations`;
	return refs;
}

function carryEntity(pass: Pass, entity: StoredEntityResult): SentimentClassificationResult["entities"][number] | null {
	const overall = carryTarget(pass, entity.key, null, entity);
	if (overall === null || overall.length === 0) {
		pass.reclassify ??= `${entity.key}: no stored overall evidence remains attributable to the entity`;
		return null;
	}
	const aspects: SentimentClassificationResult["entities"][number]["aspects"] = [];
	for (const aspect of entity.aspects) {
		const refs = carryTarget(pass, entity.key, aspect.key, aspect);
		if (refs === null) continue;
		if (refs.length === 0) {
			pass.droppedAspects.push({ entityKey: entity.key, aspectKey: aspect.key });
			continue;
		}
		aspects.push({
			key: aspect.key,
			score: aspect.score,
			category: aspect.category,
			confidence: aspect.confidence,
			evidence: refs,
		});
	}
	return {
		key: entity.key,
		score: entity.score,
		category: entity.category,
		confidence: entity.confidence,
		evidence: overall,
		aspects,
	};
}

/**
 * Plan what a stored result becomes under the current segmentation and
 * grounding. Deterministic for the same answer, roster and stored rows.
 */
export function planReanchor(args: {
	answerBody: string;
	candidates: SentimentCandidate[];
	storedInputHash: string | null;
	entities: StoredEntityResult[];
	anchors?: readonly EvidenceAnchor[];
	analysis?: AnalyzableText;
}): ReanchorPlan {
	const analysis = args.analysis ?? analyzeAnswerRanges(args.answerBody);
	const anchors = args.anchors ?? segmentAnswer(args.answerBody, analysis);
	const pass: Pass = {
		answerBody: args.answerBody,
		anchors,
		grounding: groundAnchors(args.answerBody, anchors, args.candidates),
		mappings: [],
		droppedAspects: [],
		narrowed: false,
		reclassify: null,
	};
	const entities: SentimentClassificationResult["entities"] = [];
	for (const entity of args.entities) {
		const carried = carryEntity(pass, entity);
		if (carried) entities.push(carried);
	}
	const { mappings, droppedAspects, narrowed, reclassify } = pass;
	const base = {
		inputHash: sentimentInputHash(args.answerBody, args.candidates, analysis),
		storedInputHash: args.storedInputHash,
		mappings,
		droppedAspects,
		storedDigest: digestOf(args.entities),
	};
	if (reclassify) return { ...base, action: "reclassify", candidate: null, reason: reclassify };
	const parsed = sentimentClassificationResultSchema.safeParse({ entities });
	if (!parsed.success) {
		return {
			...base,
			action: "reclassify",
			candidate: null,
			reason: `narrowed candidate is not representable: ${parsed.error.issues[0]?.message ?? "schema"}`,
		};
	}
	const candidate = parsed.data;
	const assessment = assessCandidate(candidate, {
		answerBody: args.answerBody,
		candidates: args.candidates,
		anchors,
		analysis,
	});
	if (assessment.contractDefect)
		return {
			...base,
			action: "reclassify",
			candidate: null,
			reason: `contract defect ${assessment.contractDefect.code}`,
		};
	if (assessment.unresolved.length > 0) return { ...base, action: "repair", candidate, reason: null };
	if (narrowed || droppedAspects.length > 0 || assessment.filteredClaims.length > 0)
		return { ...base, action: "reverify", candidate, reason: null };
	return {
		...base,
		action: args.storedInputHash === base.inputHash ? "current" : "restamp",
		candidate: null,
		reason: null,
	};
}
