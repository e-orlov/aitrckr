/**
 * The one hostname normalizer for the source-classification cache. Every place
 * that touches a cache key — lookup, persistence, job payloads, dedupe, tests —
 * must go through this so casing/`www.`/port/path variants of one hostname land
 * on one row while distinct non-`www` subdomains stay distinct (different
 * subdomains can play different source roles).
 */

// Same shape the app already accepts for user-entered domains
// (cleanAndValidateDomain): dot-separated alnum/hyphen labels.
const HOSTNAME_REGEX = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

const IPV4_REGEX = /^\d{1,3}(\.\d{1,3}){3}$/;

// Reserved/local-only suffixes that can never be a public source.
const LOCAL_ONLY_TLDS = new Set(["local", "localhost", "internal", "invalid"]);

/**
 * Normalize a URL, hostname, or domain-ish string to the exact-hostname cache
 * key: lowercase, no trailing dot, no leading `www.`, no scheme / credentials /
 * port / path / query / fragment. Returns null for empty, malformed, local-only
 * (single-label or reserved TLD), or IP inputs.
 */
export function normalizeSourceHostname(input: unknown): string | null {
	if (typeof input !== "string") return null;
	const trimmed = input.trim();
	if (!trimmed) return null;

	let hostname: string;
	try {
		const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
		hostname = new URL(withScheme).hostname;
	} catch {
		return null;
	}

	hostname = hostname.toLowerCase().replace(/\.$/, "");
	hostname = hostname.replace(/^www\./, "");

	if (!HOSTNAME_REGEX.test(hostname)) return null;
	if (IPV4_REGEX.test(hostname)) return null;
	const tld = hostname.slice(hostname.lastIndexOf(".") + 1);
	if (LOCAL_ONLY_TLDS.has(tld)) return null;
	return hostname;
}
