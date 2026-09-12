import { createHash } from "node:crypto";
import { resolveResearchProvider } from "../providers/research";
import type { Provider } from "../providers/types";
import { buildSentimentPrompt } from "./prompt";
import { normalizeText } from "./text";
import {
	isScoreCategoryConsistent,
	SENTIMENT_CLASSIFIER_VERSION,
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

/** Stable hash of what the classifier saw: normalized body + candidate keys. */
export function sentimentInputHash(answerBody: string, candidates: SentimentCandidate[]): string {
	const hash = createHash("sha256");
	hash.update(normalizeText(answerBody));
	hash.update("\n");
	hash.update(
		[...candidates]
			.map((c) => c.key)
			.sort()
			.join(","),
	);
	return hash.digest("hex");
}

/**
 * Locate an excerpt in the answer after the shared normalization. Returns the
 * locator in the normalized body, or null when the excerpt is not verbatim.
 */
export function locateEvidence(normalizedBody: string, quote: string): SentimentEvidence | null {
	const needle = normalizeText(quote);
	if (needle.length === 0) return null;
	const start = normalizedBody.indexOf(needle);
	if (start === -1) return null;
	return { quote: quote.trim(), start, end: start + needle.length };
}

function validateEvidence(
	normalizedBody: string,
	quotes: { quote: string }[],
	where: string,
	category: SentimentCategory,
): SentimentEvidence[] {
	const located: SentimentEvidence[] = [];
	for (const { quote } of quotes) {
		const hit = locateEvidence(normalizedBody, quote);
		if (!hit)
			throw new SentimentValidationError("evidence-not-in-answer", `${where}: excerpt is not verbatim in the answer`);
		located.push(hit);
	}
	if (category === "mixed" && located.length < 2) {
		throw new SentimentValidationError(
			"mixed-needs-dual-evidence",
			`${where}: mixed requires a positive and a negative excerpt`,
		);
	}
	return located;
}

/**
 * Local validation of a structured answer, independent of what the provider
 * already parsed: every supplied candidate exactly once and nothing else,
 * score/category consistency, evidence verbatim in the stored body, dual
 * evidence for Mixed, at most one result per aspect key. Anything invalid
 * throws and nothing is persisted.
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
	const body = normalizeText(args.answerBody);
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
		const evidence = validateEvidence(body, entity.evidence, `entity "${entity.key}"`, entity.category);
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
	/** Injected in tests; production resolves the shared research provider. */
	resolveProvider?: () => Provider;
}

/**
 * One structured-research call per prompt run through the shared provider
 * path (web search on, so the model can disambiguate identities), validated
 * locally before anything is persisted. Retry policy belongs to the queue.
 */
export async function classifySentiment(
	args: { answerBody: string; candidates: SentimentCandidate[] },
	deps: SentimentClassifierDeps = {},
): Promise<SentimentClassification> {
	if (args.candidates.length === 0) throw new SentimentValidationError("no-candidates", "nothing to classify");

	const provider = deps.resolveProvider ? deps.resolveProvider() : resolveResearchProvider();
	if (!provider.runStructuredResearch) {
		throw new Error(`Provider "${provider.id}" does not implement structured research`);
	}

	const result = await provider.runStructuredResearch({
		prompt: buildSentimentPrompt(args),
		schema: sentimentClassificationResultSchema,
		webSearch: true,
	});

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
