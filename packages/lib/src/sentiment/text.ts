import { extractTextContent } from "../text-extraction";

/**
 * `extractTextContent` answers with human-readable sentinels instead of an
 * empty string when there is nothing to extract ("No text content found in …
 * output.", "No content.", "Error extracting text content.", "Unknown provider
 * format …"); none of them is an answer.
 */
const EXTRACTION_SENTINEL =
	/^(No (text |AI overview )?content[^.]*\.|Error extracting text content\.|Unknown provider format[^.]*\.?)$/;

/**
 * The stored answer body of a prompt run, or null when the run has no
 * extractable text. Only the body is ever inspected for mentions and
 * sentiment — never the prompt, citation metadata or search results.
 */
export function extractAnswerBody(rawOutput: unknown, provider: string | null, model: string): string | null {
	let text: string;
	try {
		text = extractTextContent(rawOutput, provider ?? model);
	} catch {
		return null;
	}
	if (typeof text !== "string") return null;
	const trimmed = text.trim();
	if (trimmed.length === 0 || EXTRACTION_SENTINEL.test(trimmed)) return null;
	return text;
}

/**
 * The one normalization both the detector and the evidence check use: NFKC,
 * case-folded, every whitespace run collapsed to one space, trimmed. Two
 * strings that differ only in these ways are the same text.
 */
export function normalizeText(input: string): string {
	return input.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}

/** Unicode-aware "word character": letters, marks and digits. */
export function isWordChar(char: string | undefined): boolean {
	return char !== undefined && /[\p{L}\p{M}\p{N}]/u.test(char);
}
