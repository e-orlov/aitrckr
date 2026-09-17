import { type EvidenceAnchor, segmentAnswer } from "./anchors";
import {
	EVIDENCE_MAX_ITEMS,
	SENTIMENT_ASPECT_KEYS,
	SENTIMENT_ASPECTS,
	type SentimentCandidate,
	sortSentimentEntities,
} from "./types";

export const SENTIMENT_SCORE_RULES = `Score each entity on 0..100 for how the ANSWER portrays it:
- 0 = maximally negative, 25 = clearly negative, 50 = neutral or balanced, 75 = clearly positive, 100 = unequivocal endorsement.
Category must match the score exactly:
- "positive": score 51..100 — the answer recommends, praises or presents the entity favourably.
- "negative": score 0..49 — the answer warns about, excludes, criticises or presents a material disadvantage of the entity.
- "neutral": score exactly 50 — the entity is only named or described factually, with no evaluation.
- "mixed": score exactly 50 — the answer states a meaningful positive AND a meaningful negative point about the same target.
Rules:
- Judge only what the stored answer says about THIS entity; never copy the overall tone of the answer.
- "not expensive" / "kein Nachteil" and other negations flip polarity; read double negations carefully.
- "A is better than B" is positive for A and negative for B only when the wording clearly says so; a plain comparison without judgement is neutral for both.
- A negative statement about the whole industry is not a negative statement about every named company.
- An opinion the answer attributes to a cited source, a user review or a rating site is NOT the answer's own evaluation unless the answer adopts it.
- Different entities in the same answer may have different sentiment; repeated mentions of one entity are one observation.
- Confidence is 0..1 for how unambiguous the evidence is.`;

export const SENTIMENT_GROUNDING_RULES = `Grounding — evaluate one exact candidate at a time and cite only segments that are about that candidate:
- A segment is evidence for a candidate only when it names that candidate (name or alias) or unmistakably continues a sentence, list or table row that names it. A segment that names a different candidate is never evidence for this one, even if it appears in the same paragraph or table.
- Never exchange evidence between the rows or columns of a comparison table: the row or cell that describes candidate B says nothing about candidate A.
- A segment that names no candidate at all (a general checklist, a generic tip, a definition, a heading) cannot carry a verdict by itself; cite it only next to a segment that names the candidate, and only when it clearly continues that candidate's description. Bullets directly under a product title that names the candidate, and the paragraph that directly answers a one-line question naming the candidate, count as continuing it; bullets under a generic label ("Advantages", "Disadvantages", "Conclusion", "Check before signing") do not.
- Aspects are optional findings, not a checklist: never return an aspect for every taxonomy key. Return an aspect only when a segment that names the candidate (or continues such a segment) explicitly evaluates that aspect; when no such segment exists, leave the aspect out. An omitted aspect means "considered, not supported by this text" and is the correct answer; an aspect resting on a generic checklist, a general recommendation, a statistic or an unevaluated description is a defect and will be discarded.
- Never fill a missing aspect with a "neutral" placeholder: a "neutral" aspect is only for a segment that names the candidate and describes that aspect factually without evaluating it.
- If a candidate is only named in a list of examples, a pass-through mention or an instruction, its verdict is "neutral" with that segment as the citation.`;

export const SENTIMENT_EVIDENCE_RULES = `Evidence is cited by segment id, never by text. The ANSWER below is split into numbered segments like [s0001]; links, URLs and source lists have been removed from it, so every segment is natural language and a source reference is never evidence. Decide the polarity of every relevant segment for the target FIRST — "positive", "negative" or "neutral" for what that segment says about that target — and choose the category from those polarities afterwards:
- only positive segments → "positive"; only negative segments → "negative"; only neutral segments → "neutral";
- at least one positive AND at least one negative segment about the same target → "mixed". A "mixed" verdict lists its positive citations in "positiveEvidence" and its negative citations in "negativeEvidence"; every other verdict lists its citations in "evidence", all carrying the verdict's own polarity.
- A single segment that states both a positive and a negative side (for example good value but a rising deductible) may appear once in "positiveEvidence" and once in "negativeEvidence" of a "mixed" verdict — and only there.
- Keep the polarities of different aspects separate: a segment may be positive for "coverage" and negative for "price"; that does not make either aspect "mixed".
For every entity and aspect item list at most ${EVIDENCE_MAX_ITEMS} citations per list, each an "anchorId" that is exactly one of the segment ids shown. Never invent ids, never quote or rewrite text, never cite a segment twice with the same polarity in one list.`;

export const SENTIMENT_ASPECT_ROUTING_RULES = `Aspect routing — rate an aspect only when the ANSWER explicitly evaluates it for this candidate, and file every evaluation under its canonical key:
- "price": premiums, contributions, price-performance / value for money, discounts, cost to the customer, and the deductible / self-retention (Selbstbeteiligung, Selbstbehalt) including whether it can rise or be waived.
- "coverage": insured risks, benefits and their scope, limits and sums insured, exclusions, waiting periods, retroactive cover, what is and is not protected.
- "service": claims handling, advice and consultation, reachability, response times, digital tools and customer service.
- "other": only an explicit evaluative statement about the candidate that genuinely fits none of the three keys — reputation, trust, test wins and ratings, financial strength, flexibility of the tariff structure, transparency.
- A bare name, a ranking position without judgement, a case count, a usage share, a growth figure or any other descriptive statistic is not an evaluation: it is "neutral" evidence and never a "positive" or "negative" aspect. Omit an aspect entirely when the answer states no explicit evaluative claim for it; "other" is a narrow fallback, never a default bucket.
- Assign the same kind of statement to the same key in every answer: a deductible caveat is always "price", a waiting period always "coverage", slow claims handling always "service".`;

export const SENTIMENT_KEY_RULES = `Entity keys are opaque identifiers. Return each "key" exactly as listed in ENTITIES, character for character — never the entity's name, alias, domain or a variation of the key. The output schema only accepts the listed keys.`;

export function aspectTaxonomyText(): string {
	return SENTIMENT_ASPECT_KEYS.map((key) => {
		const aspect = SENTIMENT_ASPECTS[key];
		const synonyms = aspect.synonyms.length > 0 ? ` Synonyms: ${aspect.synonyms.join(", ")}.` : "";
		return `- "${key}" (${aspect.label}): ${aspect.description}${synonyms}`;
	}).join("\n");
}

/** The answer as the model receives it: every anchor once, in order, prefixed by its id — natural language only, citations elided. */
export function renderAnchoredAnswer(anchors: readonly EvidenceAnchor[]): string {
	return anchors.map((anchor) => `[${anchor.id}] ${anchor.naturalText}`).join("\n");
}

/**
 * One call per answer: every detected entity is judged in the same request so
 * comparisons and negations are attributed consistently. The web search is
 * allowed only to disambiguate identities; it may never add, replace or
 * correct sentiment that the stored answer does not express.
 */
export function buildSentimentPrompt(args: {
	answerBody: string;
	candidates: SentimentCandidate[];
	/** Pre-computed anchors of `answerBody`; segmented here when omitted. */
	anchors?: readonly EvidenceAnchor[];
}): string {
	const anchors = args.anchors ?? segmentAnswer(args.answerBody);
	const entityList = sortSentimentEntities(args.candidates)
		.map((candidate) => {
			const aliases = candidate.aliases.length > 0 ? ` (also known as: ${candidate.aliases.join(", ")})` : "";
			const role = candidate.entityType === "brand" ? "the brand being tracked" : "a competitor";
			return `- key "${candidate.key}": ${candidate.name}${aliases} — ${role}`;
		})
		.join("\n");

	return `You are an analyst measuring how an AI assistant's stored answer portrays specific insurance companies.

You will receive the ANSWER (a stored response, split into numbered segments) and a list of ENTITIES with fixed keys. Return one item per entity key — every listed key exactly once, no other keys. Your judgement must be based ONLY on the text of the ANSWER. You may use web search solely to recognise which company a name, abbreviation or domain refers to; never to look up reputation, reviews or facts and never to change a sentiment the ANSWER does not express itself.

${SENTIMENT_KEY_RULES}

${SENTIMENT_GROUNDING_RULES}

${SENTIMENT_SCORE_RULES}

Aspects: additionally rate the entity only on the aspects the ANSWER explicitly evaluates for it, using the canonical keys below (map synonyms to the canonical key; do not invent aspects). The aspect list may be empty; an entity can be "mixed" overall while an aspect is clearly positive or negative.
${aspectTaxonomyText()}

${SENTIMENT_ASPECT_ROUTING_RULES}

${SENTIMENT_EVIDENCE_RULES}

ENTITIES:
${entityList}

ANSWER (segments; cite by id):
"""
${renderAnchoredAnswer(anchors)}
"""`;
}
