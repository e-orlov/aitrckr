import {
	EVIDENCE_MAX_ITEMS,
	EVIDENCE_QUOTE_MAX_LENGTH,
	SENTIMENT_ASPECT_KEYS,
	SENTIMENT_ASPECTS,
	type SentimentCandidate,
} from "./types";

export const SENTIMENT_SCORE_RULES = `Score each entity on 0..100 for how the ANSWER portrays it:
- 0 = maximally negative, 25 = clearly negative, 50 = neutral or balanced, 75 = clearly positive, 100 = unequivocal endorsement.
Category must match the score exactly:
- "positive": score 51..100 — the answer recommends, praises or presents the entity favourably.
- "negative": score 0..49 — the answer warns about, excludes, criticises or presents a material disadvantage of the entity.
- "neutral": score exactly 50 — the entity is only named or described factually, with no evaluation.
- "mixed": score exactly 50 — the answer states meaningful positive AND meaningful negative points about the entity (cite one of each).
Rules:
- Judge only what the stored answer says about THIS entity; never copy the overall tone of the answer.
- "not expensive" / "kein Nachteil" and other negations flip polarity; read double negations carefully.
- "A is better than B" is positive for A and negative for B only when the wording clearly says so; a plain comparison without judgement is neutral for both.
- A negative statement about the whole industry is not a negative statement about every named company.
- An opinion the answer attributes to a cited source, a user review or a rating site is NOT the answer's own evaluation unless the answer adopts it.
- Pronouns and later clauses that clearly refer to a named entity count for that entity.
- Different entities in the same answer may have different sentiment; repeated mentions of one entity are one observation.
- Confidence is 0..1 for how unambiguous the evidence is.`;

export const SENTIMENT_EVIDENCE_RULES = `Evidence must be exact, verbatim excerpts copied from the ANSWER (max ${EVIDENCE_QUOTE_MAX_LENGTH} characters each, at most ${EVIDENCE_MAX_ITEMS} per item). Do not paraphrase, translate, fix typos or merge sentences. A "mixed" item needs at least two excerpts: one positive, one negative.`;

export function aspectTaxonomyText(): string {
	return SENTIMENT_ASPECT_KEYS.map((key) => {
		const aspect = SENTIMENT_ASPECTS[key];
		const synonyms = aspect.synonyms.length > 0 ? ` Synonyms: ${aspect.synonyms.join(", ")}.` : "";
		return `- "${key}" (${aspect.label}): ${aspect.description}${synonyms}`;
	}).join("\n");
}

/**
 * One call per answer: every detected entity is judged in the same request so
 * comparisons and negations are attributed consistently. The web search is
 * allowed only to disambiguate identities; it may never add, replace or
 * correct sentiment that the stored answer does not express.
 */
export function buildSentimentPrompt(args: { answerBody: string; candidates: SentimentCandidate[] }): string {
	const entityList = args.candidates
		.map((candidate) => {
			const aliases = candidate.aliases.length > 0 ? ` (also known as: ${candidate.aliases.join(", ")})` : "";
			const role = candidate.entityType === "brand" ? "the brand being tracked" : "a competitor";
			return `- key "${candidate.key}": ${candidate.name}${aliases} — ${role}`;
		})
		.join("\n");

	return `You are an analyst measuring how an AI assistant's stored answer portrays specific insurance companies.

You will receive the ANSWER (a stored response) and a list of ENTITIES with fixed keys. Return one item per entity key — every listed key exactly once, no other keys. Your judgement must be based ONLY on the text of the ANSWER. You may use web search solely to recognise which company a name, abbreviation or domain refers to; never to look up reputation, reviews or facts and never to change a sentiment the ANSWER does not express itself.

${SENTIMENT_SCORE_RULES}

Aspects: additionally rate the entity on each aspect the ANSWER actually evaluates for it, using the canonical keys below (map synonyms to the canonical key; do not invent aspects). Omit aspects the answer does not evaluate for that entity. An entity can be "mixed" overall while an aspect is clearly positive or negative.
${aspectTaxonomyText()}

${SENTIMENT_EVIDENCE_RULES}

ENTITIES:
${entityList}

ANSWER:
"""
${args.answerBody}
"""`;
}
