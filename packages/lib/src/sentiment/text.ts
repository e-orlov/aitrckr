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
 * The normalized body together with, for every UTF-16 unit of it, the span of
 * the raw stored body it came from. `text` is exactly what `normalizeText`
 * returns for the same input, so a match found in `text` maps back to the
 * raw characters the classifier actually cited.
 */
export interface IndexedText {
	text: string;
	/** Raw start offset of each normalized unit (`starts.length === text.length`). */
	starts: number[];
	/** Raw end offset (exclusive) of each normalized unit. */
	ends: number[];
}

const WHITESPACE = /\s/u;

/**
 * The one normalization the detector, the evidence check and the excerpt
 * mapping share: NFKC and case folding per code point, every whitespace run
 * collapsed to one space, trimmed. Two strings that differ only in these
 * ways are the same text. Per-code-point folding keeps the mapping exact
 * (one raw code point → n normalized units) at the price of not composing
 * across code points, which is fine because both sides use the same rule.
 */
export function normalizeIndexed(raw: string): IndexedText {
	const out: IndexedText = { text: "", starts: [], ends: [] };
	const units: string[] = [];
	const push = (unit: string, start: number, end: number) => {
		units.push(unit);
		out.starts.push(start);
		out.ends.push(end);
	};
	let rawIndex = 0;
	let pendingSpace: { start: number; end: number } | null = null;
	for (const char of raw) {
		const rawStart = rawIndex;
		rawIndex += char.length;
		for (const unit of char.normalize("NFKC").toLowerCase()) {
			if (WHITESPACE.test(unit)) {
				// Leading whitespace is trimmed; an inner run collapses to one space spanning the whole run.
				if (units.length > 0) pendingSpace = { start: pendingSpace?.start ?? rawStart, end: rawIndex };
				continue;
			}
			if (pendingSpace) {
				push(" ", pendingSpace.start, pendingSpace.end);
				pendingSpace = null;
			}
			for (const codeUnit of unit.split("")) push(codeUnit, rawStart, rawIndex);
		}
	}
	out.text = units.join("");
	return out;
}

export function normalizeText(input: string): string {
	return normalizeIndexed(input).text;
}

/** Unicode-aware "word character": letters, marks and digits. */
export function isWordChar(char: string | undefined): boolean {
	return char !== undefined && /[\p{L}\p{M}\p{N}]/u.test(char);
}
