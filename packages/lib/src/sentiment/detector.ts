import { type AnalyzableText, analyzeAnswerRanges } from "./ranges";
import { isWordChar, normalizeText } from "./text";
import { BRAND_ENTITY_KEY, SENTIMENT_DETECTOR_VERSION, sortSentimentEntities } from "./types";

/** What the detector knows about one entity: names, aliases and owned domains. */
export interface DetectableEntity {
	key: string;
	entityType: "brand" | "competitor";
	competitorId: string | null;
	name: string;
	aliases: string[];
	domains: string[];
}

export interface DetectedMention {
	key: string;
	entityType: "brand" | "competitor";
	competitorId: string | null;
	entityName: string;
	/** Distinct normalized terms that matched, bounded for audit. */
	matchedTerms: string[];
}

const MAX_MATCHED_TERMS = 5;
const MIN_TERM_LENGTH = 2;

/** Bare host without scheme, path, port or a leading `www.`. */
export function normalizeDomainTerm(domain: string): string {
	return normalizeText(domain)
		.replace(/^[a-z]+:\/\//, "")
		.replace(/^www\./, "")
		.replace(/[/:?#].*$/, "")
		.replace(/\.+$/, "");
}

/**
 * A term counts only when it is bounded by non-word characters on both sides,
 * so "HUK" does not match "hukum" and "das.de" does not match "adas.de".
 * Unicode-aware: letters, marks and digits are word characters.
 */
export function containsBoundedTerm(normalizedText: string, normalizedTerm: string): boolean {
	if (normalizedTerm.length < MIN_TERM_LENGTH) return false;
	let from = 0;
	while (from <= normalizedText.length - normalizedTerm.length) {
		const at = normalizedText.indexOf(normalizedTerm, from);
		if (at === -1) return false;
		const before = at === 0 ? undefined : normalizedText[at - 1];
		const after = normalizedText[at + normalizedTerm.length];
		const startsWithWord = isWordChar(normalizedTerm[0]);
		const endsWithWord = isWordChar(normalizedTerm[normalizedTerm.length - 1]);
		if ((!startsWithWord || !isWordChar(before)) && (!endsWithWord || !isWordChar(after))) return true;
		from = at + 1;
	}
	return false;
}

/**
 * The terms that make an entity *mentioned*: its name and aliases, normalized
 * and deduplicated. Owned domains are deliberately not among them — a domain
 * is a source reference, never a statement about the entity.
 */
export function mentionTerms(entity: DetectableEntity): string[] {
	const terms = new Set<string>();
	for (const raw of [entity.name, ...entity.aliases]) {
		const term = normalizeText(raw);
		if (term.length >= MIN_TERM_LENGTH) terms.add(term);
	}
	return [...terms];
}

/** Every term an entity can be recognized by — names, aliases and owned domains — for legacy-name reconciliation. */
export function entityTerms(entity: DetectableEntity): string[] {
	const terms = new Set<string>(mentionTerms(entity));
	for (const raw of entity.domains) {
		const term = normalizeDomainTerm(raw);
		if (term.length >= MIN_TERM_LENGTH) terms.add(term);
	}
	return [...terms];
}

/**
 * Deterministic, version `sent-detector-v2`: one mention per entity whose name
 * or alias occurs in the natural-language text of the answer, regardless of
 * how often it appears. URLs, link destinations, standalone links, source
 * lines and reference markers are not scanned (`analyzeAnswerRanges`), so a
 * citation domain or a name inside a path never counts; the result is in the
 * canonical entity order.
 */
export function detectEntityMentions(
	answerBody: string,
	entities: DetectableEntity[],
	analysis: AnalyzableText = analyzeAnswerRanges(answerBody),
): DetectedMention[] {
	const naturalTexts = analysis.natural
		.map((range) => normalizeText(answerBody.slice(range.start, range.end)))
		.filter((text) => text.length > 0);
	if (naturalTexts.length === 0) return [];
	const mentions: DetectedMention[] = [];
	for (const entity of entities) {
		const matched = mentionTerms(entity).filter((term) => naturalTexts.some((text) => containsBoundedTerm(text, term)));
		if (matched.length === 0) continue;
		mentions.push({
			key: entity.key,
			entityType: entity.entityType,
			competitorId: entity.competitorId,
			entityName: entity.name,
			matchedTerms: matched.slice(0, MAX_MATCHED_TERMS),
		});
	}
	return sortSentimentEntities(mentions);
}

/** The own-brand entity as the detector sees it. */
export function brandEntity(brand: {
	name: string;
	aliases: string[] | null;
	website: string;
	additionalDomains: string[] | null;
}): DetectableEntity {
	return {
		key: BRAND_ENTITY_KEY,
		entityType: "brand",
		competitorId: null,
		name: brand.name,
		aliases: brand.aliases ?? [],
		domains: [brand.website, ...(brand.additionalDomains ?? [])],
	};
}

/** A competitor row as the detector sees it; `previousNames` keep renamed competitors detectable in history. */
export function competitorEntity(competitor: {
	id: string;
	name: string;
	aliases: string[] | null;
	domains: string[] | null;
	previousNames?: string[] | null;
}): DetectableEntity {
	return {
		key: competitor.id,
		entityType: "competitor",
		competitorId: competitor.id,
		name: competitor.name,
		aliases: [...(competitor.aliases ?? []), ...(competitor.previousNames ?? [])],
		domains: competitor.domains ?? [],
	};
}

export { SENTIMENT_DETECTOR_VERSION };
