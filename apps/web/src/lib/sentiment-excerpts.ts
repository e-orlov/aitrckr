/**
 * Excerpt planning for the evidence cards. The classifier cites up to three
 * anchors that may sit anywhere in a stored answer; the card must show every
 * cited span in full — never truncated, dropped, merged into a neighbour or
 * re-derived from normalized text — without turning into the whole answer.
 *
 * Each span gets a raw-offset window around it; overlapping or touching
 * windows merge, distant ones stay separate, so one anchor yields one
 * excerpt and three distant anchors yield three. Offsets are raw code-unit
 * offsets into the stored body throughout; the client maps a highlight to
 * its excerpt with `start - excerptStart`.
 */
import type { EvidencePolarity, SentimentEvidence } from "@workspace/lib/sentiment";

/** Raw characters kept on each side of a cited span. */
export const EXCERPT_RADIUS = 160;
/** How far a window may grow outward to land on a word or sentence boundary instead of mid-word. */
export const EXCERPT_BOUNDARY_REACH = 40;

export interface ExcerptHighlight {
	/** Raw offsets into the stored answer; `answer.slice(start, end)` is exactly the highlighted text. */
	start: number;
	end: number;
	/** Every polarity cited for this exact range (two only for a Mixed verdict citing one anchor twice). */
	polarities: EvidencePolarity[];
}

export interface ExcerptGroup {
	excerptStart: number;
	excerptEnd: number;
	/** `answer.slice(excerptStart, excerptEnd)` — raw, never normalized. */
	text: string;
	highlights: ExcerptHighlight[];
	/** True when stored text precedes / follows this excerpt (the UI shows an ellipsis only then). */
	leadingEllipsis: boolean;
	trailingEllipsis: boolean;
}

const POLARITY_ORDER: Record<EvidencePolarity, number> = { positive: 0, negative: 1, neutral: 2 };

/**
 * A span is usable only when it is an exact raw slice of the answer. Anything
 * else (non-integers, out-of-range offsets, a quote that does not match the
 * slice) is refused rather than approximated.
 */
export function isExactEvidenceSpan(answer: string, span: SentimentEvidence): boolean {
	return (
		Number.isInteger(span.start) &&
		Number.isInteger(span.end) &&
		span.start >= 0 &&
		span.end > span.start &&
		span.end <= answer.length &&
		answer.slice(span.start, span.end) === span.quote
	);
}

function sortSpans(spans: readonly SentimentEvidence[]): SentimentEvidence[] {
	return [...spans].sort(
		(a, b) => a.start - b.start || a.end - b.end || POLARITY_ORDER[a.polarity] - POLARITY_ORDER[b.polarity],
	);
}

/** Merge identical ranges into one highlight (union of polarities); overlapping ranges become their union. */
function mergeHighlights(spans: readonly SentimentEvidence[]): ExcerptHighlight[] {
	const out: ExcerptHighlight[] = [];
	for (const span of spans) {
		const last = out.at(-1);
		if (last && span.start < last.end) {
			last.end = Math.max(last.end, span.end);
			if (!last.polarities.includes(span.polarity)) last.polarities.push(span.polarity);
			continue;
		}
		out.push({ start: span.start, end: span.end, polarities: [span.polarity] });
	}
	return out;
}

const isBoundary = (ch: string) => /\s/.test(ch);
/** Sentence-final punctuation, optionally followed by a closing quote or bracket. */
const SENTENCE_END = /[.!?…]["'”’»)]?$/;

/**
 * Grow a window outward — never inward — to the nearest whitespace or
 * sentence end within `reach`, so excerpts do not start or stop mid-word.
 * The cited span itself is never touched.
 */
function widenStart(answer: string, start: number, reach: number): number {
	if (start === 0) return 0;
	for (let i = start; i >= Math.max(0, start - reach); i--) {
		if (i === 0) return 0;
		if (isBoundary(answer[i - 1]) && !isBoundary(answer[i])) return i;
	}
	return start;
}

function widenEnd(answer: string, end: number, reach: number): number {
	if (end >= answer.length) return answer.length;
	for (let i = end; i <= Math.min(answer.length, end + reach); i++) {
		if (i === answer.length) return answer.length;
		if (SENTENCE_END.test(answer.slice(Math.max(0, i - 2), i)) && (i === answer.length || isBoundary(answer[i])))
			return i;
	}
	for (let i = end; i <= Math.min(answer.length, end + reach); i++) {
		if (i === answer.length || isBoundary(answer[i])) return i;
	}
	return end;
}

const isLowSurrogate = (answer: string, offset: number) => {
	const code = answer.charCodeAt(offset);
	return code >= 0xdc00 && code <= 0xdfff;
};

/** Never split a UTF-16 surrogate pair at an excerpt edge: a start moves back to the high half, an end forward past the low half. */
const alignStart = (answer: string, offset: number) => (isLowSurrogate(answer, offset) ? offset - 1 : offset);
const alignEnd = (answer: string, offset: number) => (isLowSurrogate(answer, offset) ? offset + 1 : offset);

/**
 * Deterministic excerpt groups for one observation's evidence. Input order
 * does not matter; malformed spans throw so a wrong highlight is never shown.
 */
export function planExcerpts(
	answer: string,
	spans: readonly SentimentEvidence[],
	options: { radius?: number; boundaryReach?: number } = {},
): ExcerptGroup[] {
	const radius = options.radius ?? EXCERPT_RADIUS;
	const reach = options.boundaryReach ?? EXCERPT_BOUNDARY_REACH;
	for (const span of spans) {
		if (!isExactEvidenceSpan(answer, span)) {
			throw new RangeError(`evidence span ${span.start}-${span.end} is not an exact slice of the answer`);
		}
	}
	if (spans.length === 0) return [];
	const sorted = sortSpans(spans);
	const windows = sorted.map((span) => ({
		start: alignStart(answer, widenStart(answer, Math.max(0, span.start - radius), reach)),
		end: alignEnd(answer, widenEnd(answer, Math.min(answer.length, span.end + radius), reach)),
		spans: [span],
	}));
	const merged: typeof windows = [];
	for (const window of windows) {
		const last = merged.at(-1);
		if (last && window.start <= last.end) {
			last.end = Math.max(last.end, window.end);
			last.spans.push(...window.spans);
			continue;
		}
		merged.push({ ...window, spans: [...window.spans] });
	}
	return merged.map((window) => ({
		excerptStart: window.start,
		excerptEnd: window.end,
		text: answer.slice(window.start, window.end),
		highlights: mergeHighlights(window.spans),
		leadingEllipsis: window.start > 0,
		trailingEllipsis: window.end < answer.length,
	}));
}
