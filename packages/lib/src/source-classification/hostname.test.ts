import { describe, expect, it } from "vitest";
import { normalizeSourceHostname } from "./hostname";

// F05-UT-001 / F05-AT-009 — canonical hostname normalization, invalid values,
// exact-subdomain isolation.
describe("normalizeSourceHostname", () => {
	it("folds casing, www, trailing dot, scheme, port, path, query, and fragment variants onto one key", () => {
		const variants = [
			"Verbraucherzentrale.de",
			"www.verbraucherzentrale.de",
			"verbraucherzentrale.de.",
			"WWW.VERBRAUCHERZENTRALE.DE.",
			"https://www.verbraucherzentrale.de",
			"https://verbraucherzentrale.de:8443/energie/preise?a=1#frag",
			"http://user:pass@verbraucherzentrale.de/impressum",
			"  verbraucherzentrale.de/path  ",
		];
		for (const variant of variants) {
			expect(normalizeSourceHostname(variant), variant).toBe("verbraucherzentrale.de");
		}
	});

	it("keeps a distinct non-www subdomain a distinct key", () => {
		expect(normalizeSourceHostname("blog.example.com")).toBe("blog.example.com");
		expect(normalizeSourceHostname("shop.example.com")).toBe("shop.example.com");
		expect(normalizeSourceHostname("blog.example.com")).not.toBe(normalizeSourceHostname("example.com"));
		// Only a leading www. is removed — an inner www label survives.
		expect(normalizeSourceHostname("www.blog.example.com")).toBe("blog.example.com");
	});

	it("rejects empty, malformed, local-only, and IP inputs", () => {
		const invalid = [
			"",
			"   ",
			null,
			undefined,
			42,
			"not a domain",
			"localhost",
			"intranet",
			"printer.local",
			"service.internal",
			"host.localhost",
			"127.0.0.1",
			"192.168.0.1:3000",
			"http://[::1]/",
			"-bad-.example.com",
			"http://",
		];
		for (const value of invalid) {
			expect(normalizeSourceHostname(value as never), String(value)).toBeNull();
		}
	});

	it("is idempotent on already-normalized hostnames", () => {
		for (const hostname of ["gesetze-im-internet.de", "finanztip.de", "test.de", "sub.domain.co.uk"]) {
			expect(normalizeSourceHostname(hostname)).toBe(hostname);
		}
	});
});
