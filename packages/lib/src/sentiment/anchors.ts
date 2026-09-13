import { SentimentValidationError } from "./errors-validation";
import { EVIDENCE_QUOTE_MAX_LENGTH } from "./types";

/**
 * Version of the evidence contract between the classifier and the provider:
 * the answer is handed over as ordered, identified segments and the model
 * cites segment ids, never text. Frozen into the canary contract.
 */
export const SENTIMENT_EVIDENCE_VERSION = "sent-evidence-v1";

/** Hard cap on anchors per answer; a longer answer is refused before any call. */
export const ANCHOR_MAX_COUNT = 400;

/** One exact, immutable slice of the raw answer the model may cite by id. */
export interface EvidenceAnchor {
	id: string;
	start: number;
	end: number;
	text: string;
}

const ANCHOR_ID = /^s\d{4}$/;
const LINE_BREAK = /\r\n|\r|\n/g;
/** Bullet, numbered and quote markers that open a Markdown line; never part of an anchor. */
const LINE_MARKER = /^(?:[ \t]*)(?:(?:[-*+•▪◦]|\d{1,3}[.)]|[a-z][.)]|>)[ \t]+)+/iu;
const SENTENCE_END = /[.!?…]+["'”’»)]?(?=\s)/gu;
const WHITESPACE = /\s/u;
const CONTENT = /[\p{L}\p{N}]/u;

/**
 * Tokens after which a period does not end a sentence (German and English
 * abbreviations, ordinals are handled by the digit rule). Lower-cased, no
 * trailing period.
 */
const ABBREVIATIONS = new Set([
	"z",
	"b",
	"bzw",
	"ca",
	"nr",
	"dr",
	"prof",
	"u",
	"a",
	"inkl",
	"exkl",
	"ggf",
	"evtl",
	"str",
	"vgl",
	"usw",
	"etc",
	"mio",
	"mrd",
	"tel",
	"abs",
	"art",
	"max",
	"min",
	"e.g",
	"i.e",
	"vs",
	"mr",
	"mrs",
	"ms",
	"jr",
	"sr",
	"st",
	"no",
	"approx",
	"dept",
	"inc",
	"ltd",
	"co",
]);

export function isAnchorId(value: string): boolean {
	return ANCHOR_ID.test(value);
}

function anchorIdFor(index: number): string {
	return `s${String(index + 1).padStart(4, "0")}`;
}

/** Is the character at `index` inside a URL-like token (no whitespace back to a scheme or `www.`)? */
function insideUrl(text: string, index: number): boolean {
	let from = index;
	while (from > 0 && !WHITESPACE.test(text[from - 1])) from -= 1;
	const token = text.slice(from, index + 1);
	return /^(?:https?:\/\/|www\.)/iu.test(token) || /^[\w.-]+\.[a-z]{2,}\//iu.test(token);
}

function wordBefore(text: string, index: number): string {
	let from = index;
	while (from > 0 && !WHITESPACE.test(text[from - 1]) && text[from - 1] !== "(") from -= 1;
	return text.slice(from, index).toLowerCase();
}

/** Sentence boundaries inside one line, as end offsets relative to the line. */
function sentenceEnds(line: string): number[] {
	const ends: number[] = [];
	for (const match of line.matchAll(SENTENCE_END)) {
		const at = match.index;
		const end = at + match[0].length;
		const punctuationStart = at;
		// A sentence does not end where the text continues in lower case ("slower… but", "z. B. günstig").
		const next = line.slice(end).match(/\S/u)?.[0];
		if (next !== undefined && /\p{Ll}/u.test(next)) continue;
		if (line[punctuationStart] === "." && match[0].startsWith(".") && match[0].length === 1) {
			// A single period: not a boundary after an abbreviation (incl. dotted ones like z.B./e.g.),
			// a single letter, a decimal/ordinal number or inside a URL.
			const before = wordBefore(line, punctuationStart);
			if (ABBREVIATIONS.has(before) || before.includes(".") || /^\p{L}$/u.test(before)) continue;
			if (/^\d+$/u.test(before)) continue;
			if (insideUrl(line, punctuationStart)) continue;
		}
		ends.push(end);
	}
	return ends;
}

interface Span {
	start: number;
	end: number;
	/** Raw range of a stripped list marker (`1.`, `2)`, `-`, `>`); markup, not answer content. */
	marker?: { start: number; end: number };
}

/** Trim whitespace and a leading Markdown marker; returns null when nothing citable is left. */
function contentSpan(text: string, start: number, end: number): Span | null {
	let s = start;
	let e = end;
	while (s < e && WHITESPACE.test(text[s])) s += 1;
	const marker = LINE_MARKER.exec(text.slice(s, e));
	const markerRange = marker ? { start: s, end: s + marker[0].length } : undefined;
	if (marker) s += marker[0].length;
	while (e > s && WHITESPACE.test(text[e - 1])) e -= 1;
	if (s >= e || !CONTENT.test(text.slice(s, e))) return null;
	return markerRange ? { start: s, end: e, marker: markerRange } : { start: s, end: e };
}

/** A code-unit index is a safe split point when it does not fall inside a surrogate pair or before a combining mark. */
function isSafeCut(text: string, index: number): boolean {
	const code = text.charCodeAt(index);
	if (code >= 0xdc00 && code <= 0xdfff) return false;
	return !/\p{M}/u.test(text[index] ?? "");
}

const SOFT_BOUNDARIES = new Set(["; ", ", ", "– ", "- ", ": "]);

/** Last soft boundary (`; ` `, ` ` – ` ` - ` `: `) at or before `limit`, as a safe cut index, or -1. */
function lastBoundaryCut(text: string, from: number, limit: number): number {
	for (let i = limit; i > from + 1; i -= 1) {
		if (SOFT_BOUNDARIES.has(text.slice(i - 2, i)) && isSafeCut(text, i)) return i;
	}
	return -1;
}

/** Last whitespace→non-whitespace transition at or before `limit`, as a safe cut index, or -1. */
function lastWhitespaceCut(text: string, from: number, limit: number): number {
	for (let i = limit; i > from + 1; i -= 1) {
		if (WHITESPACE.test(text[i - 1]) && !WHITESPACE.test(text[i]) && isSafeCut(text, i)) return i;
	}
	return -1;
}

/** Hard cut at `limit`, moved back until it neither splits a surrogate pair nor precedes a combining mark. */
function hardCut(text: string, from: number, limit: number): number {
	let cut = limit;
	while (cut > from + 1 && !isSafeCut(text, cut)) cut -= 1;
	return cut;
}

/**
 * Split one over-long span deterministically: prefer the last soft boundary
 * before the limit, then the last whitespace, then a hard cut that never
 * breaks a surrogate pair or a mark.
 */
function splitLongSpan(text: string, start: number, end: number): Span[] {
	const pieces: Span[] = [];
	let cursor = start;
	while (end - cursor > EVIDENCE_QUOTE_MAX_LENGTH) {
		const limit = cursor + EVIDENCE_QUOTE_MAX_LENGTH;
		let cut = lastBoundaryCut(text, cursor, limit);
		if (cut === -1) cut = lastWhitespaceCut(text, cursor, limit);
		if (cut === -1) cut = hardCut(text, cursor, limit);
		const piece = contentSpan(text, cursor, cut);
		if (piece) pieces.push(piece);
		cursor = cut;
	}
	const last = contentSpan(text, cursor, end);
	if (last) pieces.push(last);
	return pieces;
}

/**
 * Deterministic segmentation of a raw answer into citable anchors: line by
 * line (CRLF/LF/CR), sentence by sentence (German/English abbreviations,
 * numbers and URLs do not end a sentence), each span trimmed of whitespace
 * and list markers, over-long spans split at safe boundaries, ids assigned in
 * answer order. Two environments holding the same answer produce the same
 * anchors; nothing depends on locale, time, storage or randomness.
 *
 * Invariants (checked here and in tests): `text === answerBody.slice(start,
 * end)`, every span ≤ `EVIDENCE_QUOTE_MAX_LENGTH`, spans are ordered and do
 * not overlap, and every letter or digit of the answer lies inside a span.
 */
export function segmentAnswer(answerBody: string): EvidenceAnchor[] {
	const spans: Span[] = [];
	let lineStart = 0;
	const lines: { start: number; end: number }[] = [];
	for (const brk of answerBody.matchAll(LINE_BREAK)) {
		lines.push({ start: lineStart, end: brk.index });
		lineStart = brk.index + brk[0].length;
	}
	lines.push({ start: lineStart, end: answerBody.length });

	for (const line of lines) {
		const text = answerBody.slice(line.start, line.end);
		let from = 0;
		for (const end of [...sentenceEnds(text), text.length]) {
			if (end <= from) continue;
			const span = contentSpan(answerBody, line.start + from, line.start + end);
			from = end;
			if (!span) continue;
			if (span.end - span.start > EVIDENCE_QUOTE_MAX_LENGTH)
				spans.push(...splitLongSpan(answerBody, span.start, span.end));
			else spans.push(span);
		}
	}

	if (spans.length > ANCHOR_MAX_COUNT) {
		throw new SentimentValidationError(
			"answer-unsegmentable",
			`answer needs ${spans.length} anchors, cap ${ANCHOR_MAX_COUNT}`,
		);
	}
	const anchors = spans.map((span, index) => ({
		id: anchorIdFor(index),
		start: span.start,
		end: span.end,
		text: answerBody.slice(span.start, span.end),
	}));
	assertCoverage(
		answerBody,
		anchors,
		spans.flatMap((span) => (span.marker ? [span.marker] : [])),
	);
	return anchors;
}

/**
 * Every letter or digit of the answer must be inside an anchor — except the
 * digits/letters of a stripped list marker, which are markup — and anchors
 * must be ordered and non-overlapping.
 */
function assertCoverage(
	answerBody: string,
	anchors: EvidenceAnchor[],
	markers: { start: number; end: number }[],
): void {
	const isMarkup = (i: number) => markers.some((m) => i >= m.start && i < m.end);
	const uncovered = (from: number, to: number) => {
		for (let i = from; i < to; i += 1) if (CONTENT.test(answerBody[i]) && !isMarkup(i)) return true;
		return false;
	};
	let cursor = 0;
	for (const anchor of anchors) {
		if (anchor.start < cursor || anchor.end <= anchor.start || anchor.end - anchor.start > EVIDENCE_QUOTE_MAX_LENGTH) {
			throw new SentimentValidationError("answer-unsegmentable", `anchor ${anchor.id} is out of order or over-long`);
		}
		if (uncovered(cursor, anchor.start)) {
			throw new SentimentValidationError("answer-unsegmentable", `content before ${anchor.id} is not covered`);
		}
		cursor = anchor.end;
	}
	if (uncovered(cursor, answerBody.length)) {
		throw new SentimentValidationError("answer-unsegmentable", "trailing content is not covered");
	}
}

/** Anchors keyed by id, for O(1) membership checks during validation. */
export function anchorMap(anchors: EvidenceAnchor[]): Map<string, EvidenceAnchor> {
	return new Map(anchors.map((anchor) => [anchor.id, anchor]));
}
