import { type EvidenceAnchor, segmentAnswer } from "../anchors";
import {
	type SentimentClassificationResult,
	type SentimentEvidenceRef,
	type SentimentProviderResult,
	toProviderResult,
} from "../types";
import type { GoldenCase, GoldenReferenceEvidence } from "./corpus";

const collapse = (text: string) => text.replace(/\s+/g, " ").trim();

/**
 * The corpus is labelled with human-readable excerpts; the provider contract
 * cites anchors. Each excerpt must lie inside exactly one anchor of the
 * answer, which makes the corpus a segmenter contract as well: an excerpt
 * straddling two segments is a labelling or segmentation defect and throws.
 */
function anchorOf(anchors: EvidenceAnchor[], quote: string, caseId: string): EvidenceAnchor {
	const needle = collapse(quote);
	const hits = anchors.filter((anchor) => collapse(anchor.text).includes(needle));
	if (hits.length === 1) return hits[0];
	throw new Error(
		`${caseId}: reference excerpt ${JSON.stringify(quote)} lies in ${hits.length} anchors (expected exactly one)`,
	);
}

/** Excerpts resolved to anchor citations, keeping one citation per `(anchorId, polarity)`. */
function cite(anchors: EvidenceAnchor[], evidence: GoldenReferenceEvidence[], caseId: string): SentimentEvidenceRef[] {
	const refs: SentimentEvidenceRef[] = [];
	for (const item of evidence) {
		const ref = { anchorId: anchorOf(anchors, item.quote, caseId).id, polarity: item.polarity };
		if (!refs.some((r) => r.anchorId === ref.anchorId && r.polarity === ref.polarity)) refs.push(ref);
	}
	return refs;
}

/** The reference labelling of a case in the exact wire form the provider must return (classifier v4 branches). */
export function goldenReference(goldenCase: GoldenCase): SentimentProviderResult {
	return toProviderResult(goldenReferenceClaims(goldenCase));
}

/** The reference labelling in the internal claim representation (one flat citation list per target). */
export function goldenReferenceClaims(goldenCase: GoldenCase): SentimentClassificationResult {
	const anchors = segmentAnswer(goldenCase.answer);
	return {
		entities: goldenCase.reference.entities.map((entity) => ({
			key: entity.key,
			score: entity.score,
			category: entity.category,
			confidence: entity.confidence,
			evidence: cite(anchors, entity.evidence, goldenCase.id),
			aspects: entity.aspects.map((aspect) => ({
				key: aspect.key,
				score: aspect.score,
				category: aspect.category,
				confidence: aspect.confidence,
				evidence: cite(anchors, aspect.evidence, goldenCase.id),
			})),
		})),
	};
}
