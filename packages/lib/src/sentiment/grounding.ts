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
 * - `inherited`: the anchor names no candidate at all and sits in a structural
 *   context whose owner is explicit — the header row of its table, the
 *   colon-terminated line introducing its list, or the nearest preceding
 *   anchor of its own paragraph or list item that names a candidate. Inheritance
 *   stops at a blank line, a heading, a new list item, a table boundary or any
 *   anchor that names a candidate.
 * An anchor with an explicit set is attributable exactly to that set; an anchor
 * without one is attributable to its inherited set; a `generic` anchor
 * (neither) is attributable to nobody and can never carry a target alone.
 */
export type AnchorContext = "explicit" | "table-header" | "list-intro" | "paragraph" | "generic";

export interface AnchorGrounding {
	anchorId: string;
	/** Candidate keys the anchor's own natural text names. */
	explicit: ReadonlySet<string>;
	/** Candidate keys attributed from the structural context when the anchor names none itself. */
	inherited: ReadonlySet<string>;
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
/** A line that introduces what follows: it ends with a colon, optionally inside closing emphasis. */
const COLON_INTRO = /:[\s*_]*$/u;

type LineKind = "blank" | "heading" | "table-row" | "table-separator" | "list-item" | "text";

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

function classifyLine(text: string): LineKind {
	if (!CONTENT.test(text)) return TABLE_SEPARATOR.test(text) && text.includes("-") ? "table-separator" : "blank";
	if (HEADING.test(text)) return "heading";
	if (TABLE_ROW.test(text)) return TABLE_SEPARATOR.test(text) ? "table-separator" : "table-row";
	if (LIST_ITEM.test(text)) return "list-item";
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
		lines.push({ index, start, end, kind: classifyLine(text), anchors: [], explicit: new Set() });
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

/** The colon-terminated line that introduces the list containing `line` (blank lines between them allowed), or null. */
function listIntro(lines: Line[], line: Line, answerBody: string): Line | null {
	let at = line.index - 1;
	while (at >= 0 && (lines[at].kind === "list-item" || lines[at].kind === "blank")) at -= 1;
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
function paragraphOwner(lines: Line[], line: Line, anchor: EvidenceAnchor, grounded: Map<string, Set<string>>): Set<string> | null {
	const ownAnchors = line.anchors;
	for (let i = ownAnchors.indexOf(anchor) - 1; i >= 0; i -= 1) {
		const keys = grounded.get(ownAnchors[i].id);
		if (keys && keys.size > 0) return keys;
	}
	if (line.kind !== "text") return null;
	for (let at = line.index - 1; at >= 0; at -= 1) {
		const previous = lines[at];
		if (previous.kind !== "text") return null;
		for (let i = previous.anchors.length - 1; i >= 0; i -= 1) {
			const keys = grounded.get(previous.anchors[i].id);
			if (keys && keys.size > 0) return keys;
		}
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
	for (const line of lines) for (const anchor of line.anchors) explicitByAnchor.set(anchor.id, explicitKeys(anchor.naturalText, terms));

	const out = new Map<string, AnchorGrounding>();
	for (const line of lines) {
		for (const anchor of line.anchors) {
			const explicit = explicitByAnchor.get(anchor.id) ?? new Set<string>();
			if (explicit.size > 0) {
				out.set(anchor.id, { anchorId: anchor.id, explicit, inherited: new Set(), context: "explicit" });
				continue;
			}
			let inherited: Set<string> | null = null;
			let context: AnchorContext = "generic";
			const owner = paragraphOwner(lines, line, anchor, explicitByAnchor);
			if (owner) {
				inherited = owner;
				context = "paragraph";
			} else if (line.kind === "table-row") {
				const header = tableHeader(lines, line);
				if (header && header.explicit.size > 0) {
					inherited = header.explicit;
					context = "table-header";
				}
			} else if (line.kind === "list-item") {
				const intro = listIntro(lines, line, answerBody);
				if (intro && intro.explicit.size > 0) {
					inherited = intro.explicit;
					context = "list-intro";
				}
			}
			out.set(anchor.id, { anchorId: anchor.id, explicit, inherited: inherited ?? new Set(), context });
		}
	}
	return out;
}

/** Is the anchor attributable to `entityKey` — explicitly, or by inheritance when it names nobody itself? */
export function isAttributable(grounding: AnchorGrounding, entityKey: string): boolean {
	if (grounding.explicit.size > 0) return grounding.explicit.has(entityKey);
	return grounding.inherited.has(entityKey);
}

/** Does the anchor explicitly name other candidates while not naming `entityKey` — evidence that belongs to somebody else? */
export function namesOnlyOthers(grounding: AnchorGrounding, entityKey: string): boolean {
	return grounding.explicit.size > 0 && !grounding.explicit.has(entityKey);
}
