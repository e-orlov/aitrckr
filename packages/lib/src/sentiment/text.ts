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
const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/**
 * The one normalization the detector, the evidence check and the excerpt
 * mapping share: whole-string Unicode NFKC, case folding, every whitespace
 * run collapsed to one space, trimmed. Two strings that differ only in these
 * ways are the same text.
 *
 * The offset map is built per grapheme cluster: canonical composition and
 * reordering only ever act inside a cluster (a base with its combining
 * marks, Hangul jamo), so normalizing cluster by cluster reproduces the
 * whole-string result exactly — which is asserted, not assumed: `text` is
 * always `raw.normalize("NFKC")` folded, and if a pathological input ever
 * made the per-cluster concatenation differ, the whole body maps to one span
 * (a match then still resolves to raw text that re-normalizes to the quote,
 * or is rejected). Case folding is applied per cluster as well, so a raw
 * cluster always maps to a contiguous run of normalized units.
 */
export function normalizeIndexed(raw: string): IndexedText {
	const state: FoldState = { units: [], starts: [], ends: [], spaceStart: -1, spaceEnd: -1 };
	const whole = raw.normalize("NFKC");
	const clusters = [...GRAPHEMES.segment(raw)].map((part) => ({
		start: part.index,
		end: part.index + part.segment.length,
		normalized: part.segment.normalize("NFKC"),
	}));
	const aligned = clusters.map((c) => c.normalized).join("") === whole;
	const pieces = aligned ? clusters : [{ start: 0, end: raw.length, normalized: whole }];
	for (const piece of pieces) {
		for (const unit of piece.normalized.toLowerCase()) consumeUnit(state, unit, piece.start, piece.end);
	}
	return { text: state.units.join(""), starts: state.starts, ends: state.ends };
}

interface FoldState {
	units: string[];
	starts: number[];
	ends: number[];
	/** Raw span of the whitespace run waiting to be emitted as one space; `spaceStart` is -1 when none is pending. */
	spaceStart: number;
	spaceEnd: number;
}

function consumeUnit(state: FoldState, unit: string, rawStart: number, rawEnd: number): void {
	if (WHITESPACE.test(unit)) {
		// Leading whitespace is trimmed; an inner run collapses to one space spanning the whole run.
		if (state.units.length === 0) return;
		if (state.spaceStart < 0) state.spaceStart = rawStart;
		state.spaceEnd = rawEnd;
		return;
	}
	if (state.spaceStart >= 0) {
		state.units.push(" ");
		state.starts.push(state.spaceStart);
		state.ends.push(state.spaceEnd);
		state.spaceStart = -1;
	}
	for (const codeUnit of unit.split("")) {
		state.units.push(codeUnit);
		state.starts.push(rawStart);
		state.ends.push(rawEnd);
	}
}

export function normalizeText(input: string): string {
	return normalizeIndexed(input).text;
}

/** Unicode-aware "word character": letters, marks and digits. */
export function isWordChar(char: string | undefined): boolean {
	return char !== undefined && /[\p{L}\p{M}\p{N}]/u.test(char);
}
