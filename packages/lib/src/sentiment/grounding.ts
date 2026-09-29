import { type EvidenceAnchor, isTableRowLine, isTableSeparatorLine } from "./anchors";
import { containsBoundedTerm } from "./detector";
import { normalizeText } from "./text";
import type { SentimentCandidate } from "./types";

/**
 * Deterministic entity–anchor grounding (classifier contract v4). Decides,
 * from the answer's own bytes and the candidate roster only, which candidates
 * an anchor can be evidence for. The one source of entity mentions is the
 * detector's term matching over the anchor's natural-language text; no fuzzy
 * matching, no model, no repair of the provider's output.
 *
 * Two levels of attribution:
 * - `explicit`: the anchor itself names the candidate (name or alias, bounded).
 * - `inherited`: candidates attributed from the anchor's structural context —
 *   for a table cell the header cell of its own column (a column-per-entity
 *   comparison table) or, when the header names nobody, the nearest preceding
 *   cell of its own row that names a candidate (a row-per-entity table); for
 *   everything else the colon-terminated line introducing its list, the
 *   emphasised product-title line standing alone right above its list when
 *   that title names exactly one candidate, the first line of its own list
 *   item, the nearest preceding anchor of its own paragraph that names a
 *   candidate, the one-line clarifying question right above its paragraph
 *   when the paragraph opens with a continuation form and names no other
 *   candidate, or the nearest heading above it when nothing in between names
 *   any candidate. Every inheritance is one hop and never crosses a table
 *   boundary, another heading or a line that names a candidate; an anchor
 *   that names a candidate itself inherits nothing, so a cell that names
 *   the other column's entity is evidence for that entity alone.
 * An anchor is attributable to the union of both sets; an anchor that names
 * candidates itself and is not attributable to the claimed one names only
 * others; a `generic` anchor (neither set) is attributable to nobody and can
 * never carry a target alone.
 */
export type AnchorContext =
	| "explicit"
	| "table-header"
	| "table-row"
	| "list-intro"
	| "list-item"
	| "paragraph"
	| "heading"
	| "generic";

export interface AnchorGrounding {
	anchorId: string;
	/** Candidate keys the anchor's own natural text names. */
	explicit: ReadonlySet<string>;
	/** Candidate keys attributed from the structural context. */
	inherited: ReadonlySet<string>;
	/** Where the attribution came from; `explicit` when the anchor names a candidate itself. */
	context: AnchorContext;
}

export type GroundingMap = ReadonlyMap<string, AnchorGrounding>;

const LINE_BREAK = /\r\n|\r|\n/g;
const CONTENT = /[\p{L}\p{N}]/u;
const HEADING = /^\s{0,3}#{1,6}\s/u;
const LIST_ITEM = /^(?:[ \t]*)(?:[-*+•▪◦]|\d{1,3}[.)]|[a-z][.)]|>)[ \t]+/iu;
/** An indented line (two spaces or a tab) directly under a list item continues that item. */
const INDENTED = /^(?: {2,}|\t)/u;
/** A line that introduces what follows: it ends with a colon, optionally inside closing emphasis. */
const COLON_INTRO = /:[\s*_]*$/u;
/**
 * A product-title line: the whole line is one emphasised label (`**…**` or
 * `__…__`, an optional trailing colon), short, without sentence punctuation.
 */
const TITLE_LINE = /^(?:\*\*|__)([^*_][^.!?;]{0,78}?)(?:\*\*|__):?\s*$/u;
/** A one-sentence clarifying question: ends with a question mark, optionally inside closing emphasis or quotes. */
const QUESTION_END = /\?[\s*_"“”„)\]]*$/u;
/**
 * Continuation openers a paragraph may start with to refer back to the entity
 * of the clarifying question right above it (bounded DE/EN set, matched on the
 * anchor's natural text after leading emphasis and quotes are stripped).
 */
const CONTINUATION_OPENER =
	/^(?:sie|es|er|diese|dieser|dieses|ja|nein|kurz gesagt|kurz zusammengefasst|kurz|grundsätzlich|it|they|this|these|yes|no|in short|short answer|generally|overall)(?![\p{L}\p{N}])/iu;
const LEADING_MARKUP = /^[\s*_>"“„'([]+/u;

type LineKind = "blank" | "heading" | "table-row" | "table-separator" | "list-item" | "list-continuation" | "text";

interface Line {
	index: number;
	start: number;
	end: number;
	kind: LineKind;
	/** Anchors whose start offset lies on this line, in answer order. */
	anchors: EvidenceAnchor[];
	/** Union of the explicit candidate sets of the line's anchors. */
	explicit: Set<string>;
	/** For a table row: the explicit candidate set of every cell, by column. */
	cells: Map<number, Set<string>>;
}

function classifyLine(text: string, previous: LineKind | null): LineKind {
	if (!CONTENT.test(text)) return isTableSeparatorLine(text) ? "table-separator" : "blank";
	if (HEADING.test(text)) return "heading";
	if (isTableRowLine(text)) return "table-row";
	if (isTableSeparatorLine(text)) return "table-separator";
	if (LIST_ITEM.test(text)) return "list-item";
	if (INDENTED.test(text) && (previous === "list-item" || previous === "list-continuation")) return "list-continuation";
	return "text";
}

/** The terms that make a candidate explicitly mentioned: its name and aliases, normalized like the detector does. */
function candidateTerms(candidate: SentimentCandidate): string[] {
	const terms = new Set<string>();
	for (const raw of [candidate.name, ...candidate.aliases]) {
		const term = normalizeText(raw);
		if (term.length >= 2) terms.add(term);
	}
	return [...terms];
}

function explicitKeys(naturalText: string, terms: Map<string, string[]>): Set<string> {
	const normalized = normalizeText(naturalText);
	const keys = new Set<string>();
	if (normalized.length === 0) return keys;
	for (const [key, candidateTermList] of terms) {
		if (candidateTermList.some((term) => containsBoundedTerm(normalized, term))) keys.add(key);
	}
	return keys;
}

function splitLines(answerBody: string, anchors: readonly EvidenceAnchor[], terms: Map<string, string[]>): Line[] {
	const lines: Line[] = [];
	let start = 0;
	let index = 0;
	const push = (end: number) => {
		const text = answerBody.slice(start, end);
		const previous = lines.at(-1)?.kind ?? null;
		lines.push({
			index,
			start,
			end,
			kind: classifyLine(text, previous),
			anchors: [],
			explicit: new Set(),
			cells: new Map(),
		});
		index += 1;
	};
	for (const brk of answerBody.matchAll(LINE_BREAK)) {
		push(brk.index);
		start = brk.index + brk[0].length;
	}
	push(answerBody.length);
	let lineAt = 0;
	for (const anchor of anchors) {
		while (lineAt < lines.length - 1 && anchor.start >= lines[lineAt].end) lineAt += 1;
		const line = lines[lineAt];
		line.anchors.push(anchor);
		const keys = explicitKeys(anchor.naturalText, terms);
		for (const key of keys) line.explicit.add(key);
		if (anchor.table) {
			const cell = line.cells.get(anchor.table.column) ?? new Set<string>();
			for (const key of keys) cell.add(key);
			line.cells.set(anchor.table.column, cell);
		}
	}
	return lines;
}

/** The header row of the contiguous table block containing `line`, or null when `line` is that header. */
function tableHeader(lines: Line[], line: Line): Line | null {
	let first = line.index;
	while (first > 0 && (lines[first - 1].kind === "table-row" || lines[first - 1].kind === "table-separator"))
		first -= 1;
	const header = lines[first];
	return header.index === line.index || header.kind !== "table-row" ? null : header;
}

/** The first line of the list item a continuation line belongs to. */
function listItemOf(lines: Line[], line: Line): Line | null {
	let at = line.index;
	while (at > 0 && lines[at].kind === "list-continuation") at -= 1;
	return lines[at].kind === "list-item" ? lines[at] : null;
}

/** The colon-terminated line that introduces the list containing `line` (blank lines between them allowed), or null. */
function listIntro(lines: Line[], line: Line, answerBody: string): Line | null {
	let at = line.index - 1;
	while (
		at >= 0 &&
		(lines[at].kind === "list-item" || lines[at].kind === "list-continuation" || lines[at].kind === "blank")
	)
		at -= 1;
	if (at < 0) return null;
	const candidate = lines[at];
	if (candidate.kind !== "text" && candidate.kind !== "heading") return null;
	return COLON_INTRO.test(answerBody.slice(candidate.start, candidate.end).trimEnd()) ? candidate : null;
}

/**
 * G1 — the product-title line that introduces the list containing `line`: an
 * emphasised label naming exactly one candidate, standing alone (blank lines
 * around it), followed only by blank lines and the list itself. Inheritance
 * stops when a list item between the title and `line` names any candidate;
 * it is one hop — the title's own explicit set, never something it inherited.
 */
function titleIntro(lines: Line[], line: Line, answerBody: string): Line | null {
	let at = line.index - 1;
	while (
		at >= 0 &&
		(lines[at].kind === "list-item" || lines[at].kind === "list-continuation" || lines[at].kind === "blank")
	) {
		if (lines[at].explicit.size > 0) return null;
		at -= 1;
	}
	if (at < 0) return null;
	const title = lines[at];
	if (title.kind !== "text" || title.explicit.size !== 1) return null;
	if (at > 0 && lines[at - 1].kind !== "blank") return null;
	return TITLE_LINE.test(answerBody.slice(title.start, title.end).trim()) ? title : null;
}

/** The first line of the paragraph (contiguous `text` lines) containing `line`. */
function paragraphStart(lines: Line[], line: Line): Line {
	let at = line.index;
	while (at > 0 && lines[at - 1].kind === "text") at -= 1;
	return lines[at];
}

/**
 * G2 — the one-line clarifying question directly above the paragraph
 * containing `line`: a single sentence (one anchor) ending in a question mark,
 * naming exactly one candidate, standing alone; only blank lines between it
 * and the paragraph; the paragraph names no other candidate and opens with a
 * bounded continuation form. One hop: the question's own explicit set, and
 * only for this paragraph.
 */
function questionIntro(lines: Line[], line: Line, answerBody: string): Line | null {
	if (line.kind !== "text") return null;
	const first = paragraphStart(lines, line);
	let at = first.index - 1;
	if (at < 0 || lines[at].kind !== "blank") return null;
	while (at >= 0 && lines[at].kind === "blank") at -= 1;
	if (at < 0) return null;
	const question = lines[at];
	if (question.kind !== "text" || question.anchors.length !== 1 || question.explicit.size !== 1) return null;
	if (at > 0 && lines[at - 1].kind !== "blank") return null;
	if (!QUESTION_END.test(answerBody.slice(question.start, question.end).trimEnd())) return null;
	const [subject] = question.explicit;
	for (let i = first.index; i < lines.length && lines[i].kind === "text"; i += 1) {
		for (const key of lines[i].explicit) if (key !== subject) return null;
	}
	const opener = first.anchors[0]?.naturalText.replace(LEADING_MARKUP, "") ?? "";
	return CONTINUATION_OPENER.test(opener) ? question : null;
}

/**
 * The nearest preceding anchor in the same paragraph (for a list item: the
 * same line) that names a candidate; scanning stops at a blank line, a
 * heading, a table row or another list item.
 */
function paragraphOwner(
	lines: Line[],
	line: Line,
	anchor: EvidenceAnchor,
	explicitByAnchor: Map<string, Set<string>>,
): Set<string> | null {
	const ownAnchors = line.anchors;
	for (let i = ownAnchors.indexOf(anchor) - 1; i >= 0; i -= 1) {
		const keys = explicitByAnchor.get(ownAnchors[i].id);
		if (keys && keys.size > 0) return keys;
	}
	if (line.kind !== "text") return null;
	for (let at = line.index - 1; at >= 0; at -= 1) {
		const previous = lines[at];
		if (previous.kind !== "text") return null;
		for (let i = previous.anchors.length - 1; i >= 0; i -= 1) {
			const keys = explicitByAnchor.get(previous.anchors[i].id);
			if (keys && keys.size > 0) return keys;
		}
	}
	return null;
}

/**
 * The nearest heading above `line` that names a candidate, provided no line
 * between them names any candidate and no other heading or table intervenes.
 */
function headingOwner(lines: Line[], line: Line): Line | null {
	for (let at = line.index - 1; at >= 0; at -= 1) {
		const previous = lines[at];
		if (previous.kind === "heading") return previous.explicit.size > 0 ? previous : null;
		if (previous.kind === "table-row" || previous.kind === "table-separator") return null;
		if (previous.explicit.size > 0) return null;
	}
	return null;
}

/**
 * Ground every anchor of an answer against the candidate roster. Pure and
 * deterministic: the same body, anchors and candidates give the same map in
 * every environment.
 */
export function groundAnchors(
	answerBody: string,
	anchors: readonly EvidenceAnchor[],
	candidates: readonly SentimentCandidate[],
): GroundingMap {
	const terms = new Map(candidates.map((candidate) => [candidate.key, candidateTerms(candidate)]));
	const lines = splitLines(answerBody, anchors, terms);
	const explicitByAnchor = new Map<string, Set<string>>();
	for (const line of lines)
		for (const anchor of line.anchors) explicitByAnchor.set(anchor.id, explicitKeys(anchor.naturalText, terms));

	const out = new Map<string, AnchorGrounding>();
	for (const line of lines) {
		for (const anchor of line.anchors) {
			const explicit = explicitByAnchor.get(anchor.id) ?? new Set<string>();
			out.set(anchor.id, groundOne(answerBody, lines, line, anchor, explicit, explicitByAnchor));
		}
	}
	return out;
}

interface Inheritance {
	keys: Set<string>;
	context: AnchorContext;
}

function groundOne(
	answerBody: string,
	lines: Line[],
	line: Line,
	anchor: EvidenceAnchor,
	explicit: Set<string>,
	explicitByAnchor: Map<string, Set<string>>,
): AnchorGrounding {
	let inheritance: Inheritance | null = null;
	if (explicit.size > 0) inheritance = null;
	else if (line.kind === "table-row") inheritance = tableInheritance(lines, line, anchor, explicitByAnchor);
	else inheritance = contextInheritance(answerBody, lines, line, anchor, explicitByAnchor);
	const context: AnchorContext = explicit.size > 0 ? "explicit" : (inheritance?.context ?? "generic");
	return { anchorId: anchor.id, explicit, inherited: inheritance?.keys ?? new Set(), context };
}

/**
 * A table cell that names nobody belongs to the entity of its column when the
 * header cell of that column names one (a column-per-entity comparison
 * table); in such a table a column whose header names nobody (the criterion
 * label, a summary column) belongs to nobody. When the header names no
 * candidate at all (a row-per-entity table, or no header), the cell belongs
 * to the nearest preceding cell of its own row that names a candidate. A cell
 * never inherits from another row or another column.
 */
function tableInheritance(
	lines: Line[],
	line: Line,
	anchor: EvidenceAnchor,
	explicitByAnchor: Map<string, Set<string>>,
): Inheritance | null {
	const header = tableHeader(lines, line);
	if (header && header.explicit.size > 0) {
		const column = anchor.table?.column;
		const owner = column === undefined ? undefined : header.cells.get(column);
		return owner && owner.size > 0 ? { keys: owner, context: "table-header" } : null;
	}
	const ownAnchors = line.anchors;
	for (let i = ownAnchors.indexOf(anchor) - 1; i >= 0; i -= 1) {
		const keys = explicitByAnchor.get(ownAnchors[i].id);
		if (keys && keys.size > 0) return { keys, context: "table-row" };
	}
	return null;
}

/** Structural context for an anchor that names no candidate itself, in order of proximity. */
function contextInheritance(
	answerBody: string,
	lines: Line[],
	line: Line,
	anchor: EvidenceAnchor,
	explicitByAnchor: Map<string, Set<string>>,
): Inheritance | null {
	const owner = paragraphOwner(lines, line, anchor, explicitByAnchor);
	if (owner) return { keys: owner, context: "paragraph" };
	if (line.kind === "list-continuation") {
		const item = listItemOf(lines, line);
		if (item && item.explicit.size > 0) return { keys: item.explicit, context: "list-item" };
	}
	if (line.kind === "list-item" || line.kind === "list-continuation") {
		const intro = listIntro(lines, line, answerBody) ?? titleIntro(lines, line, answerBody);
		if (intro && intro.explicit.size > 0) return { keys: intro.explicit, context: "list-intro" };
	}
	if (line.kind === "text") {
		const question = questionIntro(lines, line, answerBody);
		if (question) return { keys: question.explicit, context: "paragraph" };
	}
	if (line.kind !== "heading") {
		const heading = headingOwner(lines, line);
		if (heading) return { keys: heading.explicit, context: "heading" };
	}
	return null;
}

/** Is the anchor attributable to `entityKey` — by naming it or through its structural context? */
export function isAttributable(grounding: AnchorGrounding, entityKey: string): boolean {
	return grounding.explicit.has(entityKey) || grounding.inherited.has(entityKey);
}

/** Does the anchor name other candidates while not being attributable to `entityKey` — evidence that belongs to somebody else? */
export function namesOnlyOthers(grounding: AnchorGrounding, entityKey: string): boolean {
	return grounding.explicit.size > 0 && !isAttributable(grounding, entityKey);
}

/**
 * Is the anchor somebody else's evidence — attributed, by name or by its
 * structural context (the other column of a comparison table, the other
 * entity's section or list), to at least one candidate and not to
 * `entityKey`? A generic anchor belongs to nobody and is not somebody else's.
 */
export function belongsOnlyToOthers(grounding: AnchorGrounding, entityKey: string): boolean {
	return (grounding.explicit.size > 0 || grounding.inherited.size > 0) && !isAttributable(grounding, entityKey);
}
