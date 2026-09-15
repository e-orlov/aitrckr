import { SentimentValidationError } from "./errors-validation";

/**
 * A half-open range of UTF-16 code units into the raw stored answer body.
 * Every range this module produces is relative to the raw body, never to a
 * normalized copy, so `body.slice(start, end)` is always the exact text.
 */
export interface TextRange {
	start: number;
	end: number;
}

export type ExcludedRangeKind =
	/** `https://…`, `www.…`, a bare `domain.tld[/path]` or an e-mail address. */
	| "url"
	/** A Markdown link: the destination always, the label too when it is not natural text. */
	| "markdown-link"
	/** `[1]`, `[^1]`, `【1】` reference markers. */
	| "citation-marker"
	/** A reference-style link definition line `[1]: https://…`. */
	| "link-definition"
	/** A whole line whose only content is sources: links, URLs, markers and source labels. */
	| "source-line";

export interface ExcludedRange extends TextRange {
	kind: ExcludedRangeKind;
}

/**
 * The one range analysis every sentiment component shares — mention detector,
 * candidate construction, anchor segmenter, input hash, provider prompt,
 * canary inspect/preflight/boundary and mention backfill. `natural` is the
 * complement of `excluded`; both are ordered, non-overlapping, non-empty and
 * derived only from the body's own bytes (no locale, time, storage or roster).
 */
export interface AnalyzableText {
	body: string;
	excluded: ExcludedRange[];
	natural: TextRange[];
}

const LINE_BREAK = /\r\n|\r|\n/g;
const WHITESPACE = /\s/u;
const CONTENT = /[\p{L}\p{N}]/u;

/**
 * Top-level domains under which a bare `name.tld` token (no scheme, no `www.`)
 * is read as a source reference. Bounded on purpose: an abbreviation or a
 * name with inner periods (`z.B.`, `D.A.S.`, `e.g.`) never matches.
 */
const BARE_DOMAIN_TLDS = new Set([
	"com",
	"net",
	"org",
	"info",
	"biz",
	"io",
	"co",
	"eu",
	"de",
	"at",
	"ch",
	"li",
	"uk",
	"ie",
	"fr",
	"it",
	"es",
	"pt",
	"nl",
	"be",
	"lu",
	"dk",
	"se",
	"no",
	"fi",
	"pl",
	"cz",
	"sk",
	"hu",
	"us",
	"ca",
	"au",
	"nz",
	"app",
	"dev",
	"online",
	"shop",
	"site",
	"web",
	"news",
	"blog",
	"tv",
	"me",
	"ai",
	"edu",
	"gov",
]);

/**
 * Words that label a source without saying anything about an entity. A line
 * consisting of such labels plus links/URLs/markers is a source line.
 */
const SOURCE_LABELS = new Set([
	"quelle",
	"quellen",
	"source",
	"sources",
	"referenz",
	"referenzen",
	"reference",
	"references",
	"siehe",
	"vgl",
	"see",
	"link",
	"links",
	"weitere",
	"informationen",
	"information",
	"mehr",
	"erfahren",
	"more",
	"read",
	"details",
	"nachweis",
	"nachweise",
	"fußnote",
	"fußnoten",
	"footnote",
	"footnotes",
	"zitiert",
	"cited",
	"via",
	"auch",
	"und",
	"and",
	"oder",
	"or",
	"unter",
	"at",
	"auf",
	"on",
	"in",
	"the",
	"der",
	"die",
	"das",
	"zu",
	"to",
	"von",
	"from",
	"bei",
	"hier",
	"here",
	"online",
]);

/** Bullet/numbered/quote markers that open a Markdown line (mirrors the segmenter). */
const LINE_MARKER = /^(?:[ \t]*)(?:(?:[-*+•▪◦]|\d{1,3}[.)]|[a-z][.)]|>)[ \t]+)+/iu;
/** `[label](destination "title")`; one nesting level of parentheses inside the destination is allowed. */
const MARKDOWN_LINK = /\[([^[\]\r\n]*)\]\(((?:[^()\s]|\([^()\s]*\))*)(?:[ \t]+"[^"\r\n]*")?\)/gu;
const SCHEME_URL = /(?:https?:\/\/|www\.)[^\s<>()[\]{}"'`]+/giu;
const EMAIL = /[\p{L}\p{N}._%+-]+@(?:[\p{L}\p{N}-]+\.)+\p{L}{2,}/giu;
const BARE_DOMAIN = /(?:[\p{L}\p{N}-]+\.)+([\p{L}]{2,})(?::\d{2,5})?(?:\/[^\s<>()[\]{}"'`]*)?/giu;
const REFERENCE_MARKER = /\[\^?\d{1,3}\]|【\d{1,3}】/gu;
const LINK_DEFINITION = /^[ \t]*\[[^\]\r\n]{1,64}\]:[ \t]*<?(?:https?:\/\/|www\.)\S.*$/iu;
/** Punctuation that ends a URL only when it trails it. */
const TRAILING_PUNCTUATION = /[.,;:!?…]+$/u;
const LABEL_IS_MARKER = /^\s*(?:\^?\d{1,3}|[ivxlc]{1,5}|[a-z])\s*$/iu;

function isWordChar(char: string | undefined): boolean {
	return char !== undefined && /[\p{L}\p{N}]/u.test(char);
}

function isDomainLike(text: string): boolean {
	const trimmed = text.trim();
	if (trimmed.length === 0) return false;
	if (/^(?:https?:\/\/|www\.)/iu.test(trimmed)) return true;
	const match = new RegExp(`^${BARE_DOMAIN.source}$`, "iu").exec(trimmed);
	return match !== null && BARE_DOMAIN_TLDS.has(match[1].toLowerCase());
}

/** A link label that says nothing about an entity: empty, a URL/domain, a reference marker or a source label. */
function isNonNaturalLabel(label: string): boolean {
	const trimmed = label.trim();
	if (trimmed.length === 0 || !CONTENT.test(trimmed)) return true;
	if (isDomainLike(trimmed) || LABEL_IS_MARKER.test(trimmed)) return true;
	const words = trimmed
		.toLowerCase()
		.split(/[^\p{L}\p{N}]+/u)
		.filter((w) => w.length > 0);
	return words.length > 0 && words.every((word) => SOURCE_LABELS.has(word));
}

function lineRanges(body: string): TextRange[] {
	const lines: TextRange[] = [];
	let start = 0;
	for (const brk of body.matchAll(LINE_BREAK)) {
		lines.push({ start, end: brk.index });
		start = brk.index + brk[0].length;
	}
	lines.push({ start, end: body.length });
	return lines;
}

function trimTrailingPunctuation(text: string, start: number, end: number): number {
	const trailing = TRAILING_PUNCTUATION.exec(text.slice(start, end));
	return trailing ? end - trailing[0].length : end;
}

/** URLs, e-mails and bare domains of one line, as body offsets. */
function urlRanges(body: string, line: TextRange, taken: (i: number) => boolean): ExcludedRange[] {
	const text = body.slice(line.start, line.end);
	const found: ExcludedRange[] = [];
	for (const match of text.matchAll(SCHEME_URL)) {
		const start = line.start + match.index;
		if (taken(start)) continue;
		found.push({ start, end: trimTrailingPunctuation(body, start, start + match[0].length), kind: "url" });
	}
	for (const match of text.matchAll(EMAIL)) {
		const start = line.start + match.index;
		if (taken(start)) continue;
		found.push({ start, end: start + match[0].length, kind: "url" });
	}
	for (const match of text.matchAll(BARE_DOMAIN)) {
		const start = line.start + match.index;
		const end = trimTrailingPunctuation(body, start, start + match[0].length);
		if (taken(start) || !BARE_DOMAIN_TLDS.has(match[1].toLowerCase())) continue;
		// A domain token must stand alone: not glued to a word, `@` or a path character.
		const before = body[start - 1];
		if (isWordChar(before) || before === "@" || before === "/" || before === "." || before === "-") continue;
		const after = body[end];
		if (isWordChar(after) && !/\//u.test(body[end] ?? "")) continue;
		found.push({ start, end, kind: "url" });
	}
	return found;
}

interface LinkParts {
	whole: TextRange;
	label: TextRange;
	/** From `](` to the closing `)`. */
	destination: TextRange;
}

function markdownLinks(body: string, line: TextRange): LinkParts[] {
	const text = body.slice(line.start, line.end);
	const links: LinkParts[] = [];
	for (const match of text.matchAll(MARKDOWN_LINK)) {
		const start = line.start + match.index;
		const labelStart = start + 1;
		const labelEnd = labelStart + match[1].length;
		links.push({
			whole: { start, end: start + match[0].length },
			label: { start: labelStart, end: labelEnd },
			destination: { start: labelEnd, end: start + match[0].length },
		});
	}
	return links;
}

function mergeRanges(ranges: ExcludedRange[]): ExcludedRange[] {
	const sorted = [...ranges].sort((a, b) => a.start - b.start || a.end - b.end);
	const merged: ExcludedRange[] = [];
	for (const range of sorted) {
		if (range.end <= range.start) continue;
		const last = merged[merged.length - 1];
		if (last && range.start <= last.end) {
			if (range.end > last.end) last.end = range.end;
			continue;
		}
		merged.push({ ...range });
	}
	return merged;
}

const BRACKET_PAIRS: Record<string, string> = { "(": ")", "[": "]", "{": "}", "<": ">" };
/** Separators that may sit between two citations inside one bracket group. */
const CITATION_SEPARATOR = /^[\s,;/|·•]+$/u;

/** The end of the group of excluded ranges starting at `from` that are separated only by whitespace/separators. */
function groupEnd(body: string, ranges: ExcludedRange[], from: number): number {
	let j = from;
	while (j + 1 < ranges.length) {
		const gap = body.slice(ranges[j].end, ranges[j + 1].start);
		if (gap.length > 0 && !CITATION_SEPARATOR.test(gap)) break;
		j += 1;
	}
	return j;
}

/** The bracket pair immediately around `[start, end)` (whitespace allowed), or null. */
function wrappingBrackets(body: string, line: TextRange, start: number, end: number): TextRange | null {
	let open = start - 1;
	while (open >= line.start && WHITESPACE.test(body[open])) open -= 1;
	let close = end;
	while (close < line.end && WHITESPACE.test(body[close])) close += 1;
	const opener = body[open];
	if (open < line.start || !(opener in BRACKET_PAIRS) || body[close] !== BRACKET_PAIRS[opener]) return null;
	return { start: open, end: close + 1 };
}

/**
 * Brackets that wrap nothing but excluded ranges, whitespace and separators
 * (`([adac.de](https://…))`, `[1][2]`) are part of the citation, not prose.
 */
function absorbWrappingBrackets(body: string, ranges: ExcludedRange[], line: TextRange): ExcludedRange[] {
	let changed = true;
	let current = ranges;
	while (changed) {
		changed = false;
		const next: ExcludedRange[] = [];
		for (let i = 0; i < current.length; i += 1) {
			const last = groupEnd(body, current, i);
			const wrapped = wrappingBrackets(body, line, current[i].start, current[last].end);
			if (!wrapped) {
				next.push(current[i]);
				continue;
			}
			next.push({ start: wrapped.start, end: wrapped.end, kind: current[i].kind });
			changed = true;
			i = last;
		}
		current = mergeRanges(next);
	}
	return current;
}

/**
 * Whether a line, once its excluded ranges, link labels, list marker, source
 * labels and punctuation are removed, says nothing at all — then the whole
 * line is a source line and even its natural-looking link labels are not prose.
 */
function isSourceLine(body: string, line: TextRange, excluded: ExcludedRange[], links: LinkParts[]): boolean {
	if (excluded.length === 0) return false;
	const drop = (i: number) =>
		excluded.some((r) => i >= r.start && i < r.end) || links.some((l) => i >= l.label.start && i < l.label.end);
	let residual = "";
	for (let i = line.start; i < line.end; i += 1) residual += drop(i) ? " " : body[i];
	residual = residual.replace(LINE_MARKER, " ");
	const words = residual
		.toLowerCase()
		.split(/[^\p{L}\p{N}]+/u)
		.filter((w) => w.length > 0);
	return words.every((word) => SOURCE_LABELS.has(word));
}

function analyzeLine(body: string, line: TextRange): ExcludedRange[] {
	const text = body.slice(line.start, line.end);
	if (LINK_DEFINITION.test(text) && CONTENT.test(text)) {
		return [{ start: line.start, end: line.end, kind: "link-definition" }];
	}
	const links = markdownLinks(body, line);
	const ranges: ExcludedRange[] = [];
	for (const link of links) {
		const label = body.slice(link.label.start, link.label.end);
		if (isNonNaturalLabel(label)) ranges.push({ ...link.whole, kind: "markdown-link" });
		else {
			ranges.push({ start: link.whole.start, end: link.label.start, kind: "markdown-link" });
			ranges.push({ ...link.destination, kind: "markdown-link" });
		}
	}
	const inLink = (i: number) => links.some((l) => i >= l.whole.start && i < l.whole.end);
	ranges.push(...urlRanges(body, line, inLink));
	for (const match of text.matchAll(REFERENCE_MARKER)) {
		const start = line.start + match.index;
		if (!inLink(start)) ranges.push({ start, end: start + match[0].length, kind: "citation-marker" });
	}
	let merged = mergeRanges(ranges);
	if (merged.length === 0) return [];
	if (isSourceLine(body, line, merged, links)) {
		let s = line.start;
		let e = line.end;
		while (s < e && WHITESPACE.test(body[s])) s += 1;
		while (e > s && WHITESPACE.test(body[e - 1])) e -= 1;
		return [{ start: s, end: e, kind: "source-line" }];
	}
	merged = absorbWrappingBrackets(body, merged, line);
	return merged;
}

function assertWellFormed(body: string, ranges: readonly TextRange[], label: string): void {
	let cursor = 0;
	for (const range of ranges) {
		if (
			!Number.isInteger(range.start) ||
			!Number.isInteger(range.end) ||
			range.start < cursor ||
			range.end <= range.start ||
			range.end > body.length
		) {
			throw new SentimentValidationError("answer-unsegmentable", `${label} ranges are malformed`);
		}
		cursor = range.end;
	}
}

/**
 * Split the raw answer into citation ranges and natural-language ranges. Pure
 * and total: the same body always yields the same ranges; an internal
 * inconsistency throws `answer-unsegmentable` instead of returning a partial
 * result. Nothing here depends on the roster, so the same ranges feed every
 * consumer of the answer.
 */
export function analyzeAnswerRanges(body: string): AnalyzableText {
	const excluded = mergeRanges(lineRanges(body).flatMap((line) => analyzeLine(body, line)));
	assertWellFormed(body, excluded, "excluded");
	const natural: TextRange[] = [];
	let cursor = 0;
	for (const range of excluded) {
		if (range.start > cursor) natural.push({ start: cursor, end: range.start });
		cursor = range.end;
	}
	if (cursor < body.length) natural.push({ start: cursor, end: body.length });
	assertWellFormed(body, natural, "natural");
	return { body, excluded, natural };
}

/** The parts of `range` that are natural language, in order. */
export function naturalSlices(analysis: AnalyzableText, range: TextRange): TextRange[] {
	const slices: TextRange[] = [];
	for (const natural of analysis.natural) {
		if (natural.end <= range.start) continue;
		if (natural.start >= range.end) break;
		slices.push({ start: Math.max(natural.start, range.start), end: Math.min(natural.end, range.end) });
	}
	return slices;
}

/** Whether the raw range holds at least one natural-language letter or digit. */
export function hasNaturalContent(analysis: AnalyzableText, range: TextRange): boolean {
	return naturalSlices(analysis, range).some((slice) => CONTENT.test(analysis.body.slice(slice.start, slice.end)));
}

/** Is the body offset inside an excluded range? */
export function isExcludedOffset(analysis: AnalyzableText, index: number): boolean {
	return analysis.excluded.some((range) => index >= range.start && index < range.end);
}

/**
 * The natural-language text of a raw range: its natural slices concatenated,
 * with exactly one space where an elided citation separated two words (a
 * space is added between glued words, one is dropped between two spaces). This
 * is what the provider reads; the stored evidence stays the raw slice.
 */
export function naturalTextOf(analysis: AnalyzableText, range: TextRange): string {
	const slices = naturalSlices(analysis, range);
	let out = "";
	let previousEnd = -1;
	for (const slice of slices) {
		let piece = analysis.body.slice(slice.start, slice.end);
		if (previousEnd >= 0 && slice.start > previousEnd) {
			const before = out[out.length - 1];
			const after = piece[0];
			const beforeIsSpace = before !== undefined && WHITESPACE.test(before);
			const afterIsSpace = after !== undefined && WHITESPACE.test(after);
			if (before !== undefined && after !== undefined && !beforeIsSpace && !afterIsSpace) out += " ";
			else if (beforeIsSpace && afterIsSpace) piece = piece.slice(1);
		}
		out += piece;
		previousEnd = slice.end;
	}
	return out;
}

/** Every natural range of the body as text, one per line, in order — the canonical analyzable text. */
export function analyzableText(analysis: AnalyzableText): string {
	return analysis.natural.map((range) => analysis.body.slice(range.start, range.end)).join("\n");
}
