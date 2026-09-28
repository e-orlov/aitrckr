import { z } from "zod";

/** Most prompt ids one selection, and therefore one bulk request, may carry: the whole brand cap. */
export const MAX_BULK_SELECTION = 10_000;

/**
 * Most prompts one delete commit may take. Measured on a restored copy with
 * representative history (see the R2 closeout): a full-cap delete of prompts
 * with runs, citations and sentiment graphs completes well inside the lock
 * and statement budget, so the cap equals the selection cap.
 */
export const MAX_DELETE_BATCH = 10_000;

export const promptIdListSchema = z
	.array(z.string().uuid())
	.min(1)
	.max(MAX_BULK_SELECTION)
	.transform((ids) => [...new Set(ids)]);

export function deletePhrase(count: number): string {
	return `DELETE ${count} PROMPTS`;
}

export function removeTagPhrase(tag: string): string {
	return `REMOVE ${tag}`;
}
