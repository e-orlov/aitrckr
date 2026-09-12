import { createHash } from "node:crypto";
import type { Provider } from "../providers/types";
import { buildSentimentPrompt } from "./prompt";
import { resolveSentimentProvider } from "./provider";
import { type IndexedText, normalizeIndexed, normalizeText } from "./text";
import {
	EVIDENCE_RAW_SPAN_MAX_LENGTH,
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
	sentimentClassificationResultSchema,
} from "./types";

export class SentimentValidationError extends Error {
	constructor(
		readonly code: string,
		message: string,
	) {
		super(message);
		this.name = "SentimentValidationError";
	}
}

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
}

/**
 * The exact classifier input in canonical form: the normalized answer body
 * and every candidate's identity (key, type, name, aliases) in a stable
 * order. A stored analysis is current only while this hash still matches,
 * so a roster, name or alias change makes the run eligible again instead of
 * being hidden behind an older completed analysis.
 */
export function sentimentInputHash(answerBody: string, candidates: SentimentCandidate[]): string {
	const canonical = {
		body: normalizeText(answerBody),
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

/**
 * Locate an excerpt in the answer after the shared normalization and map it
 * back to the raw stored body. Returns the raw-offset locator whose slice
 * normalizes to the same text, or null when the excerpt is not verbatim.
 */
export function locateEvidence(
	body: IndexedText,
	rawBody: string,
	quote: string,
	polarity: EvidencePolarity,
): SentimentEvidence | null {
	const needle = normalizeText(quote);
	if (needle.length === 0) return null;
	const at = body.text.indexOf(needle);
	if (at === -1) return null;
	const start = body.starts[at];
	const end = body.ends[at + needle.length - 1];
	if (start === undefined || end === undefined) return null;
	const raw = rawBody.slice(start, end);
	if (normalizeText(raw) !== needle || raw.length > EVIDENCE_RAW_SPAN_MAX_LENGTH) return null;
	return { quote: raw, start, end, polarity };
}

function validateEvidence(
	body: IndexedText,
	rawBody: string,
	quotes: { quote: string; polarity: EvidencePolarity }[],
	where: string,
	category: SentimentCategory,
): SentimentEvidence[] {
	const located: SentimentEvidence[] = [];
	for (const { quote, polarity } of quotes) {
		const hit = locateEvidence(body, rawBody, quote, polarity);
		if (!hit)
			throw new SentimentValidationError("evidence-not-in-answer", `${where}: excerpt is not verbatim in the answer`);
		located.push(hit);
	}
	if (category === "mixed") {
		const polarities = new Set(located.map((e) => e.polarity));
		if (!polarities.has("positive") || !polarities.has("negative")) {
			throw new SentimentValidationError(
				"mixed-needs-dual-evidence",
				`${where}: mixed requires one positive and one negative excerpt`,
			);
		}
	}
	return located;
}

/**
 * Local validation of a structured answer, independent of what the provider
 * already parsed: every supplied candidate exactly once and nothing else,
 * score/category consistency, evidence verbatim in the stored body (raw
 * offsets resolved), a positive and a negative excerpt for Mixed, at most one
 * result per aspect key. Anything invalid throws and nothing is persisted.
 */
export function validateSentimentResult(
	raw: unknown,
	args: { answerBody: string; candidates: SentimentCandidate[] },
): ValidatedEntitySentiment[] {
	const parsed = sentimentClassificationResultSchema.safeParse(raw);
	if (!parsed.success) {
		throw new SentimentValidationError("schema", parsed.error.issues[0]?.message ?? "invalid classifier output");
	}
	const result: SentimentClassificationResult = parsed.data;
	const body = normalizeIndexed(args.answerBody);
	const expected = new Set(args.candidates.map((c) => c.key));
	const seen = new Set<string>();
	const entities: ValidatedEntitySentiment[] = [];

	for (const entity of result.entities) {
		if (!expected.has(entity.key))
			throw new SentimentValidationError("unknown-entity", `entity "${entity.key}" was not a candidate`);
		if (seen.has(entity.key))
			throw new SentimentValidationError("duplicate-entity", `entity "${entity.key}" returned twice`);
		seen.add(entity.key);
		if (!isScoreCategoryConsistent(entity.score, entity.category)) {
			throw new SentimentValidationError(
				"score-category",
				`entity "${entity.key}": ${entity.category} does not fit score ${entity.score}`,
			);
		}
		const evidence = validateEvidence(
			body,
			args.answerBody,
			entity.evidence,
			`entity "${entity.key}"`,
			entity.category,
		);
		const aspectKeys = new Set<string>();
		const aspects: ValidatedAspect[] = [];
		for (const aspect of entity.aspects) {
			if (aspectKeys.has(aspect.key))
				throw new SentimentValidationError(
					"duplicate-aspect",
					`entity "${entity.key}": aspect "${aspect.key}" returned twice`,
				);
			aspectKeys.add(aspect.key);
			if (!isScoreCategoryConsistent(aspect.score, aspect.category)) {
				throw new SentimentValidationError(
					"score-category",
					`entity "${entity.key}" aspect "${aspect.key}": ${aspect.category} does not fit score ${aspect.score}`,
				);
			}
			aspects.push({
				key: aspect.key,
				score: aspect.score,
				category: aspect.category,
				confidence: aspect.confidence,
				evidence: validateEvidence(
					body,
					args.answerBody,
					aspect.evidence,
					`entity "${entity.key}" aspect "${aspect.key}"`,
					aspect.category,
				),
			});
		}
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
		if (!seen.has(key)) throw new SentimentValidationError("missing-entity", `candidate "${key}" was not classified`);
	}
	return entities;
}

export interface SentimentClassifierDeps {
	/** Injected in tests; production always resolves the locked OpenRouter path. */
	resolveProvider?: () => Provider;
}

/**
 * One structured-research call per prompt run through the locked provider
 * path (web search on, so the model can disambiguate identities), validated
 * locally before anything is persisted. Retry policy belongs to the queue.
 */
export async function classifySentiment(
	args: { answerBody: string; candidates: SentimentCandidate[] },
	deps: SentimentClassifierDeps = {},
	signal?: AbortSignal,
): Promise<SentimentClassification> {
	if (args.candidates.length === 0) throw new SentimentValidationError("no-candidates", "nothing to classify");

	const provider = deps.resolveProvider ? deps.resolveProvider() : resolveSentimentProvider();
	if (!provider.runStructuredResearch) {
		throw new Error(`Provider "${provider.id}" does not implement structured research`);
	}

	const result = await provider.runStructuredResearch({
		prompt: buildSentimentPrompt(args),
		schema: sentimentClassificationResultSchema,
		webSearch: true,
		signal,
	});
	if (provider.id === SENTIMENT_PROVIDER_ID && result.modelVersion !== SENTIMENT_MODEL) {
		throw new SentimentValidationError(
			"model-mismatch",
			`sentiment is locked to ${SENTIMENT_MODEL}; provider answered with ${result.modelVersion ?? "unknown"}`,
		);
	}

	return {
		entities: validateSentimentResult(result.object, args),
		provider: provider.id,
		model: result.modelVersion ?? null,
		webSearch: true,
		classifierVersion: SENTIMENT_CLASSIFIER_VERSION,
		taxonomyVersion: SENTIMENT_TAXONOMY_VERSION,
		inputHash: sentimentInputHash(args.answerBody, args.candidates),
	};
}
