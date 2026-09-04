import { MAX_PROMPTS } from "./constants";
import { sanitizeUserTags } from "./user-tags";

/**
 * Why a pasted line did not become a prompt.
 *
 * Reported rather than dropped silently: pasting fifty lines and getting
 * forty-one prompts with no explanation is the case this parser exists to
 * avoid, since the nine that vanished are indistinguishable from a bug.
 */
export interface SkippedLines {
	/** Lines that were empty or whitespace only. */
	blank: number;
	/** Lines matching a prompt already in the list. */
	duplicateOfExisting: string[];
	/** Lines repeated within the pasted text itself. */
	duplicateInPaste: string[];
	/** Lines dropped because the list is capped at `MAX_PROMPTS`. */
	overCapacity: string[];
	/** 1-based line numbers of lines that carry tags but no prompt text. */
	missingPrompt: number[];
}

/** One pasted line: the prompt and the user tags that were written after it. */
export interface BulkPromptRecord {
	value: string;
	tags: string[];
}

export interface BulkPromptParse {
	/** Lines that became prompts, in the order they were pasted. */
	added: BulkPromptRecord[];
	skipped: SkippedLines;
}

export interface ParseBulkPromptsOptions {
	/** Prompt values already in the list, used for duplicate detection. */
	existing?: readonly string[];
	/** Total prompts the list may hold. Defaults to `MAX_PROMPTS`. */
	limit?: number;
}

/**
 * Field separator. Reserved syntax: there is no quoting or escaping, so a
 * literal semicolon cannot appear inside a prompt or a tag.
 */
const FIELD_SEPARATOR = ";";

/**
 * Comparison key for two prompts being "the same".
 *
 * Case and surrounding whitespace are ignored, and runs of internal whitespace
 * collapse to one space, so a line re-pasted from a wrapped document does not
 * arrive as a second distinct prompt.
 */
function dedupeKey(value: string): string {
	return value.trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * Split pasted text into prompts, one per line, each optionally followed by
 * semicolon-separated tags: `prompt text;tag1;tag2`.
 *
 * Everything this drops, it names. The caller gets the lines that became
 * prompts and, separately, every line that did not along with the reason, so
 * the screen can tell someone that three of their lines were already in the
 * list rather than leaving them to count.
 *
 * Two prompts are duplicates when their text matches, whatever their tags: a
 * duplicate's tags are dropped with it rather than merged into the prompt that
 * won, since a paste is a request to add prompts, not to edit existing ones.
 *
 * Capacity is measured against the whole list, not the paste: `limit` is the
 * total the list may hold, so a paste of ten lines into a list already holding
 * `limit - 2` prompts contributes two and reports eight as over capacity.
 */
export function parseBulkPrompts(text: string, options: ParseBulkPromptsOptions = {}): BulkPromptParse {
	const { existing = [], limit = MAX_PROMPTS } = options;

	const seen = new Set(existing.map(dedupeKey));
	const room = Math.max(0, limit - existing.length);

	const added: BulkPromptRecord[] = [];
	const skipped: SkippedLines = {
		blank: 0,
		duplicateOfExisting: [],
		duplicateInPaste: [],
		overCapacity: [],
		missingPrompt: [],
	};

	const withinPaste = new Set<string>();

	text.split(/\r?\n/).forEach((raw, index) => {
		if (raw.trim().length === 0) {
			skipped.blank += 1;
			return;
		}

		const [first, ...rest] = raw.split(FIELD_SEPARATOR);
		const value = first.trim();
		if (value.length === 0) {
			skipped.missingPrompt.push(index + 1);
			return;
		}

		const key = dedupeKey(value);
		if (withinPaste.has(key)) {
			skipped.duplicateInPaste.push(value);
			return;
		}
		if (seen.has(key)) {
			skipped.duplicateOfExisting.push(value);
			return;
		}

		// Capacity is checked after the duplicate rules on purpose. A line that
		// was never going to be added is not competing for a slot, so reporting
		// it as over capacity would blame the limit for something the limit did
		// not cause.
		if (added.length >= room) {
			skipped.overCapacity.push(value);
			return;
		}

		withinPaste.add(key);
		added.push({ value, tags: sanitizeUserTags(rest) });
	});

	return { added, skipped };
}

/**
 * One sentence naming what the parse dropped, or null when it dropped nothing.
 *
 * Over-capacity and missing-prompt lines are deliberately absent: they block
 * the paste outright rather than being skipped, so the caller reports those as
 * an error instead.
 */
export function describeSkipped(skipped: SkippedLines): string | null {
	const parts: string[] = [];
	const duplicates = skipped.duplicateOfExisting.length + skipped.duplicateInPaste.length;
	if (duplicates > 0) {
		parts.push(`${duplicates} duplicate${duplicates === 1 ? "" : "s"}`);
	}
	if (skipped.blank > 0) {
		parts.push(`${skipped.blank} blank line${skipped.blank === 1 ? "" : "s"}`);
	}
	if (parts.length === 0) return null;
	return `Skipped ${parts.join(" and ")}.`;
}

/**
 * The error shown for lines that have tags but no prompt, naming each line so
 * nobody has to count. Null when there are none.
 */
export function describeMissingPrompt(lines: readonly number[]): string | null {
	if (lines.length === 0) return null;
	if (lines.length === 1) {
		return `Line ${lines[0]} has no prompt text before its first semicolon. Fix or remove it to continue.`;
	}
	const listed = `${lines.slice(0, -1).join(", ")} and ${lines[lines.length - 1]}`;
	return `Lines ${listed} have no prompt text before their first semicolon. Fix or remove them to continue.`;
}
