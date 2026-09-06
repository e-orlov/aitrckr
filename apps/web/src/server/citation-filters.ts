/**
 * Tag semantics shared by the citation pages, so every citation view resolves
 * the same prompts for the same filter.
 */
import { SYSTEM_TAGS } from "@workspace/lib/db/schema";
import { getEffectiveBrandedStatus } from "@workspace/lib/tag-utils";

export interface TaggedPrompt {
	id: string;
	tags: string[] | null;
	systemTags: string[] | null;
}

/**
 * Prompt ids matching the tag filter. Branded/unbranded are derived rather than
 * stored, so they resolve through getEffectiveBrandedStatus; every other tag
 * matches against the prompt's own tags or its system tags.
 */
export function promptIdsMatchingTags(allPrompts: TaggedPrompt[], tagFilter: string[]): string[] {
	const wantsBranded = tagFilter.includes(SYSTEM_TAGS.BRANDED);
	const wantsUnbranded = tagFilter.includes(SYSTEM_TAGS.UNBRANDED);
	const userTagFilter = tagFilter.filter((tag) => tag !== SYSTEM_TAGS.BRANDED && tag !== SYSTEM_TAGS.UNBRANDED);

	return allPrompts
		.filter((prompt) => {
			const systemTags = prompt.systemTags || [];
			const userTags = prompt.tags || [];
			if (wantsBranded || wantsUnbranded) {
				const { isBranded } = getEffectiveBrandedStatus(systemTags, userTags);
				if (isBranded ? wantsBranded : wantsUnbranded) return true;
			}
			const allTags = [...systemTags, ...userTags].map((tag) => tag.toLowerCase());
			return userTagFilter.some((tag) => allTags.includes(tag));
		})
		.map((prompt) => prompt.id);
}

/** The two system tags first, then the brand's own tags sorted. */
export function availableTagsFor(allPrompts: TaggedPrompt[]): string[] {
	const userTags = new Set(allPrompts.flatMap((prompt) => prompt.tags || []));
	return [
		SYSTEM_TAGS.BRANDED,
		SYSTEM_TAGS.UNBRANDED,
		...[...userTags]
			.filter((tag) => tag.toLowerCase() !== SYSTEM_TAGS.BRANDED && tag.toLowerCase() !== SYSTEM_TAGS.UNBRANDED)
			.sort(),
	];
}

/** `"a,b,,c"` → `["a","b","c"]`; absent → every enabled prompt. */
export function parseTagFilter(tags: string | undefined): string[] {
	return tags?.split(",").filter(Boolean) || [];
}
