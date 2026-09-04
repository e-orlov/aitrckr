// Kept free of database imports so the browser-side bulk parser can share the
// exact normalization the server applies when it writes a prompt's tags.

export function normalizeTag(tag: string): string {
	return tag.toLowerCase().trim();
}

/**
 * Sanitize user tags - normalize and dedupe.
 * Note: "branded" and "unbranded" are allowed as user tags to override system-computed values.
 */
export function sanitizeUserTags(tags: string[]): string[] {
	return tags
		.map(normalizeTag)
		.filter((tag) => tag.length > 0)
		.filter((tag, index, self) => self.indexOf(tag) === index);
}
