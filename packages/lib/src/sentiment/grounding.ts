import type { EvidenceAnchor } from "./anchors";
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
 *   the header row of its table (a row of a comparison table describes every
 *   entity the header names, even when a cell mentions the other one), the
 *   colon-terminated line introducing its list, the first line of its own
 *   list item, the nearest preceding anchor of its own paragraph that names a
 *   candidate, or the nearest heading above it when nothing in between names
 *   any candidate. Inheritance never crosses a table boundary, another heading
 *   or a line that names a candidate.
 * An anchor is attributable to the union of both sets; an anchor that names
 * candidates itself and is not attributable to the claimed one names only
 * others; a `generic` anchor (neither set) is attributable to nobody and can
 * never carry a target alone.
 */
export type AnchorContext =
	| "explicit"
	| "table-header"
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
const TABLE_ROW = /^\s*\|/u;
/** A Markdown table alignment row: pipes, colons, dashes and spaces only. */
const TABLE_SEPARATOR = /^\s*\|?[\s:|-]*-{3,}[\s:|-]*\|?\s*$/u;
const LIST_ITEM = /^(?:[ \t]*)(?:[-*+•▪◦]|\d{1,3}[.)]|[a-z][.)]|>)[ \t]+/iu;
/** An indented line (two spaces or a tab) directly under a list item continues that item. */
const INDENTED = /^(?: {2,}|\t)/u;
/** A line that introduces what follows: it ends with a colon, optionally inside closing emphasis. */
const COLON_INTRO = /:[\s*_]*$/u;

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
}

function classifyLine(text: string, previous: LineKind | null): LineKind {
	if (!CONTENT.test(text)) return TABLE_SEPARATOR.test(text) && text.includes("-") ? "table-separator" : "blank";
	if (HEADING.test(text)) return "heading";
	if (TABLE_ROW.test(text)) return TABLE_SEPARATOR.test(text) ? "table-separator" : "table-row";
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
		lines.push({ index, start, end, kind: classifyLine(text, previous), anchors: [], explicit: new Set() });
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
		for (const key of explicitKeys(anchor.naturalText, terms)) line.explicit.add(key);
	}
	return lines;
}

/** The header row of the contiguous table block containing `line`, or null when `line` is that header. */
function tableHeader(lines: Line[], line: Line): Line | null {
	let first = line.index;
	while (first > 0 && (lines[first - 1].kind === "table-row" || lines[first - 1].kind === "table-separator")) first -= 1;
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
	while (at >= 0 && (lines[at].kind === "list-item" || lines[at].kind === "list-continuation" || lines[at].kind === "blank"))
		at -= 1;
	if (at < 0) return null;
	const candidate = lines[at];
	if (candidate.kind !== "text" && candidate.kind !== "heading") return null;
	return COLON_INTRO.test(answerBody.slice(candidate.start, candidate.end).trimEnd()) ? candidate : null;
}

/**
 * The nearest preceding anchor in the same paragraph (for a list item: the
 * same line) that names a candidate; scanning stops at a blank line, a
 * heading, a table row or another list item.
 */
function paragraphOwner(lines: Line[], line: Line, anchor: EvidenceAnchor, explicitByAnchor: Map<string, Set<string>>): Set<string> | null {
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
			let inherited: Set<string> | null = null;
			let context: AnchorContext = explicit.size > 0 ? "explicit" : "generic";
			if (line.kind === "table-row") {
				// A comparison row describes every entity of its header, whatever a cell happens to name.
				const header = tableHeader(lines, line);
				if (header && header.explicit.size > 0) {
					inherited = header.explicit;
					if (explicit.size === 0) context = "table-header";
				}
			} else if (explicit.size === 0) {
				const owner = paragraphOwner(lines, line, anchor, explicitByAnchor);
				if (owner) {
					inherited = owner;
					context = "paragraph";
				} else if (line.kind === "list-continuation") {
					const item = listItemOf(lines, line);
					if (item && item.explicit.size > 0) {
						inherited = item.explicit;
						context = "list-item";
					}
				}
				if (!inherited && (line.kind === "list-item" || line.kind === "list-continuation")) {
					const intro = listIntro(lines, line, answerBody);
					if (intro && intro.explicit.size > 0) {
						inherited = intro.explicit;
						context = "list-intro";
					}
				}
				if (!inherited && line.kind !== "heading") {
					const heading = headingOwner(lines, line);
					if (heading) {
						inherited = heading.explicit;
						context = "heading";
					}
				}
			}
			out.set(anchor.id, { anchorId: anchor.id, explicit, inherited: inherited ?? new Set(), context });
		}
	}
	return out;
}

/** Is the anchor attributable to `entityKey` — by naming it or through its structural context? */
export function isAttributable(grounding: AnchorGrounding, entityKey: string): boolean {
	return grounding.explicit.has(entityKey) || grounding.inherited.has(entityKey);
}

/** Does the anchor name other candidates while not being attributable to `entityKey` — evidence that belongs to somebody else? */
export function namesOnlyOthers(grounding: AnchorGrounding, entityKey: string): boolean {
	return grounding.explicit.size > 0 && !isAttributable(grounding, entityKey);
}
