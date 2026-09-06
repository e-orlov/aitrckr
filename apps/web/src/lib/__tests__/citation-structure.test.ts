import { describe, expect, it } from "vitest";
import {
	assertConservation,
	buildCitationStructure,
	type CitationStructure,
	type CitationStructureNode,
	matchOwnedDomain,
	normalizeCitationPath,
	OTHER_DOMAINS_LABEL,
	OTHER_HOSTS_LABEL,
	ownedDomainCandidates,
	parseOwnedCitationUrl,
	REST_LABEL,
} from "@/lib/citation-structure";

const BRAND = { brandId: "arag", brandName: "ARAG" };

function build(rows: { url: string; count: number }[], ownedDomains: string[] = ["arag.de"], limits?: object) {
	return buildCitationStructure({ ...BRAND, ownedDomains, rows, limits });
}

const byKind = (structure: CitationStructure, kind: CitationStructureNode["kind"]) =>
	structure.nodes.filter((node) => node.kind === kind);
const byDepth = (structure: CitationStructure, depth: number) => structure.nodes.filter((node) => node.depth === depth);
const named = (structure: CitationStructure, name: string, depth?: number) =>
	structure.nodes.find((node) => node.name === name && (depth === undefined || node.depth === depth));
const linkSum = (structure: CitationStructure, fromDepth: number) =>
	structure.links
		.filter((link) => structure.nodes[link.source].depth === fromDepth)
		.reduce((sum, link) => sum + link.value, 0);

/** Root = every depth's node sum = every depth's link sum, per AC-06. */
function expectConserved(structure: CitationStructure, total: number) {
	expect(structure.totalOwnedOccurrences).toBe(total);
	if (total === 0) {
		expect(structure.nodes).toEqual([]);
		expect(structure.links).toEqual([]);
		return;
	}
	expect(structure.nodes[0].value).toBe(total);
	for (const depth of [1, 2, 3]) {
		expect(byDepth(structure, depth).reduce((sum, node) => sum + node.value, 0)).toBe(total);
		expect(linkSum(structure, depth - 1)).toBe(total);
	}
	expect(() => assertConservation(structure)).not.toThrow();
}

describe("buildCitationStructure — occurrences and hierarchy", () => {
	it("UT-01 one eligible URL creates one four-level chain of value 1", () => {
		const s = build([{ url: "https://www.arag.de/service", count: 1 }]);
		expect(s.nodes.map((n) => [n.depth, n.kind, n.name, n.value])).toEqual([
			[0, "brand", "ARAG", 1],
			[1, "domain", "arag.de", 1],
			[2, "host", "www.arag.de", 1],
			[3, "path", "/service", 1],
		]);
		expect(s.links).toEqual([
			{ source: 0, target: 1, value: 1 },
			{ source: 1, target: 2, value: 1 },
			{ source: 2, target: 3, value: 1 },
		]);
		expectConserved(s, 1);
	});

	it("UT-02 a grouped raw URL with count 7 contributes 7, not 1", () => {
		const s = build([{ url: "https://www.arag.de/service", count: 7 }]);
		expect(s.totalOwnedOccurrences).toBe(7);
		expect(s.eligibleRawUrlGroups).toBe(1);
		expect(s.nodes.every((n) => n.value === 7)).toBe(true);
		expectConserved(s, 7);
	});

	it("UT-03 several raw URL groups landing on one host/path sum every occurrence", () => {
		const s = build([
			{ url: "https://www.arag.de/service", count: 3 },
			{ url: "https://www.arag.de/service/", count: 2 },
			{ url: "http://www.arag.de/service?x=1", count: 4 },
		]);
		expect(named(s, "/service", 3)?.value).toBe(9);
		expect(s.eligibleRawUrlGroups).toBe(3);
		expectConserved(s, 9);
	});

	it("UT-04 scheme, port, query, fragment and non-root trailing slash share one path node", () => {
		const s = build([
			{ url: "https://www.arag.de/service/", count: 1 },
			{ url: "http://www.arag.de/service", count: 1 },
			{ url: "https://www.arag.de:443/service/?utm_source=x#section", count: 1 },
			{ url: "https://www.arag.de:8443/service///", count: 1 },
		]);
		expect(byKind(s, "path")).toHaveLength(1);
		expect(named(s, "/service", 3)?.value).toBe(4);
		expect(byKind(s, "host")).toHaveLength(1);
		expectConserved(s, 4);
	});

	it("UT-05 apex and www remain separate hosts under the same configured domain", () => {
		const s = build([
			{ url: "https://arag.de/", count: 2 },
			{ url: "https://www.arag.de/", count: 3 },
		]);
		expect(byKind(s, "domain").map((n) => n.name)).toEqual(["arag.de"]);
		expect(byKind(s, "host").map((n) => [n.name, n.value])).toEqual([
			["www.arag.de", 3],
			["arag.de", 2],
		]);
		expectConserved(s, 5);
	});

	it("UT-06 an arbitrary nested subdomain stays distinct and matches the configured root", () => {
		const s = build([
			{ url: "https://prerelease.arag.de/x", count: 1 },
			{ url: "https://deep.prerelease.arag.de/x", count: 1 },
			{ url: "https://www.arag.de/x", count: 1 },
		]);
		expect(byKind(s, "domain").map((n) => n.name)).toEqual(["arag.de"]);
		expect(byKind(s, "host").map((n) => n.name)).toEqual([
			"deep.prerelease.arag.de",
			"prerelease.arag.de",
			"www.arag.de",
		]);
		expectConserved(s, 3);
	});

	it("UT-07 primary website and additional domains both appear", () => {
		const owned = ownedDomainCandidates("https://www.arag.de/", [" ARAG.com ", "arag.com", "", "https://arag.co.uk/x"]);
		expect(owned).toEqual(["arag.de", "arag.com", "arag.co.uk"]);
		const s = build(
			[
				{ url: "https://www.arag.de/a", count: 2 },
				{ url: "https://www.arag.com/b", count: 1 },
			],
			owned,
		);
		expect(byKind(s, "domain").map((n) => [n.name, n.value])).toEqual([
			["arag.de", 2],
			["arag.com", 1],
		]);
		expectConserved(s, 3);
	});

	it("UT-08 the longest configured suffix wins for nested configured domains", () => {
		expect(matchOwnedDomain("a.shop.example.com", ["example.com", "shop.example.com"])).toBe("shop.example.com");
		expect(matchOwnedDomain("shop.example.com", ["shop.example.com", "example.com"])).toBe("shop.example.com");
		expect(matchOwnedDomain("blog.example.com", ["example.com", "shop.example.com"])).toBe("example.com");
		expect(matchOwnedDomain("www.example.co.uk", ["example.co.uk"])).toBe("example.co.uk");
		const s = build(
			[
				{ url: "https://a.shop.example.com/p", count: 1 },
				{ url: "https://blog.example.com/p", count: 1 },
			],
			["example.com", "shop.example.com"],
		);
		expect(
			byKind(s, "domain")
				.map((n) => n.name)
				.sort(),
		).toEqual(["example.com", "shop.example.com"]);
		expect(s.nodes.find((n) => n.kind === "host" && n.name === "a.shop.example.com")?.id).toContain("shop.example.com");
		expectConserved(s, 2);
	});

	it("UT-09 lookalike suffixes are excluded", () => {
		expect(matchOwnedDomain("notarag.de", ["arag.de"])).toBeUndefined();
		expect(matchOwnedDomain("arag.de.evil.test", ["arag.de"])).toBeUndefined();
		expect(matchOwnedDomain("arag.dex", ["arag.de"])).toBeUndefined();
		const s = build([
			{ url: "https://notarag.de/x", count: 5 },
			{ url: "https://arag.de.evil.test/x", count: 5 },
			{ url: "https://www.arag.de/x", count: 1 },
		]);
		expect(s.totalOwnedOccurrences).toBe(1);
		expect(s.nonOwnedOccurrences).toBe(10);
		expect(s.excludedInvalidUrlOccurrences).toBe(0);
		expectConserved(s, 1);
	});

	it("UT-10 invalid URL, missing hostname and non-HTTP schemes are excluded without throwing", () => {
		expect(parseOwnedCitationUrl("not a url")).toBeUndefined();
		expect(parseOwnedCitationUrl("ftp://arag.de/x")).toBeUndefined();
		expect(parseOwnedCitationUrl("mailto:info@arag.de")).toBeUndefined();
		expect(parseOwnedCitationUrl("javascript:alert(1)")).toBeUndefined();
		expect(parseOwnedCitationUrl("file:///etc/passwd")).toBeUndefined();
		expect(parseOwnedCitationUrl("")).toBeUndefined();
		const s = build([
			{ url: "not a url", count: 2 },
			{ url: "ftp://arag.de/x", count: 3 },
			{ url: "https://www.arag.de/ok", count: 4 },
		]);
		expect(s.excludedInvalidUrlOccurrences).toBe(5);
		expect(s.totalOwnedOccurrences).toBe(4);
		expect(s.eligibleRawUrlGroups).toBe(1);
		expectConserved(s, 4);
	});

	it("UT-11 an empty pathname maps to root", () => {
		expect(normalizeCitationPath("")).toBe("/");
		expect(normalizeCitationPath("/")).toBe("/");
		expect(parseOwnedCitationUrl("https://arag.de")?.path).toBe("/");
		expect(parseOwnedCitationUrl("https://arag.de?x=1#y")?.path).toBe("/");
		expect(parseOwnedCitationUrl("https://arag.de///")?.path).toBe("/");
	});

	it("UT-12 a non-root trailing slash is removed", () => {
		expect(normalizeCitationPath("/service/")).toBe("/service");
		expect(normalizeCitationPath("/service///")).toBe("/service");
		expect(normalizeCitationPath("/a/b/")).toBe("/a/b");
	});

	it("UT-13 path case and repeated internal slashes remain distinct, encoding is the parser's", () => {
		const s = build([
			{ url: "https://www.arag.de/Service", count: 1 },
			{ url: "https://www.arag.de/service", count: 1 },
			{ url: "https://www.arag.de/service//faq", count: 1 },
			{ url: "https://www.arag.de/service/faq", count: 1 },
			{ url: "https://www.arag.de/ü", count: 1 },
			{ url: "https://www.arag.de/%C3%BC", count: 1 },
		]);
		expect(byKind(s, "path").map((n) => n.name)).toEqual([
			"/%C3%BC",
			"/Service",
			"/service",
			"/service//faq",
			"/service/faq",
		]);
		expect(named(s, "/%C3%BC", 3)?.value).toBe(2);
		expectConserved(s, 6);
	});

	it("UT-14 the same path text on two hostnames yields distinct nodes", () => {
		const s = build([
			{ url: "https://arag.de/service", count: 1 },
			{ url: "https://www.arag.de/service", count: 2 },
		]);
		const paths = byKind(s, "path");
		expect(paths).toHaveLength(2);
		expect(new Set(paths.map((n) => n.id)).size).toBe(2);
		expect(paths.map((n) => n.fullLabel).sort()).toEqual(["arag.de/service", "www.arag.de/service"]);
		expectConserved(s, 3);
	});

	it("UT-15 the same path text on two owned domains yields distinct nodes, delimiters in paths cannot collide", () => {
		const s = build(
			[
				{ url: "https://www.arag.de/service", count: 1 },
				{ url: "https://www.arag.com/service", count: 1 },
				{ url: "https://www.arag.com/service|x", count: 1 },
				{ url: "https://www.arag.com/service%7Cx", count: 1 },
			],
			["arag.de", "arag.com"],
		);
		const ids = s.nodes.map((n) => n.id);
		expect(new Set(ids).size).toBe(ids.length);
		// The parser leaves a literal `|` in the path, so the raw and the
		// percent-encoded form are two paths — and two ids, despite `|` being the id delimiter.
		expect(byKind(s, "path").map((n) => n.name)).toEqual(["/service", "/service%7Cx", "/service|x", "/service"]);
		expect(byKind(s, "path").map((n) => n.id)).toEqual([
			"path:arag.com|www.arag.com|%2Fservice",
			"path:arag.com|www.arag.com|%2Fservice%257Cx",
			"path:arag.com|www.arag.com|%2Fservice%7Cx",
			"path:arag.de|www.arag.de|%2Fservice",
		]);
		expectConserved(s, 4);
	});
});

describe("buildCitationStructure — ordering and reduction", () => {
	it("UT-16 sorts by count descending then by stable lexical key", () => {
		const s = build([
			{ url: "https://arag.de/b", count: 2 },
			{ url: "https://arag.de/a", count: 2 },
			{ url: "https://arag.de/c", count: 5 },
			{ url: "https://arag.de/B", count: 2 },
		]);
		expect(byKind(s, "path").map((n) => n.name)).toEqual(["/c", "/B", "/a", "/b"]);
	});

	it("UT-17 domain pruning folds the tail into Other owned domains with exact value and hidden-child count", () => {
		const rows = ["d1", "d2", "d3", "d4", "d5"].map((d, i) => ({ url: `https://www.${d}.test/p`, count: 10 - i }));
		rows.push({ url: `https://api.d5.test/q`, count: 1 });
		const owned = ["d1.test", "d2.test", "d3.test", "d4.test", "d5.test"];
		const s = build(rows, owned, { maxVisibleDomains: 3 });
		expect(byKind(s, "domain").map((n) => n.name)).toEqual(["d1.test", "d2.test", "d3.test"]);
		const other = named(s, OTHER_DOMAINS_LABEL, 1);
		expect(other).toMatchObject({ kind: "rest", value: 7 + 6 + 1, hiddenChildCount: 2 });
		expect(byDepth(s, 1).at(-1)?.name).toBe(OTHER_DOMAINS_LABEL);
		const chainHosts = s.nodes.find((n) => n.id.startsWith("other-domains-hosts:"));
		const chainRest = s.nodes.find((n) => n.id.startsWith("other-domains-rest:"));
		expect(chainHosts).toMatchObject({ depth: 2, value: 14, hiddenChildCount: 3, name: OTHER_HOSTS_LABEL });
		expect(chainRest).toMatchObject({ depth: 3, value: 14, hiddenChildCount: 3, name: REST_LABEL });
		expectConserved(s, 10 + 9 + 8 + 7 + 6 + 1);
	});

	it("UT-18 host pruning folds the tail into Other hosts with exact value and hidden-child count", () => {
		const rows = ["a", "b", "c", "d"].map((h, i) => ({ url: `https://${h}.arag.de/p`, count: 4 - i }));
		rows.push({ url: "https://d.arag.de/q", count: 1 });
		const s = build(rows, ["arag.de"], { maxVisibleHostsPerDomain: 2 });
		expect(byKind(s, "host").map((n) => n.name)).toEqual(["a.arag.de", "b.arag.de"]);
		const other = named(s, OTHER_HOSTS_LABEL, 2);
		expect(other).toMatchObject({ kind: "rest", value: 2 + 1 + 1, hiddenChildCount: 2 });
		const rest = s.nodes.find((n) => n.id.startsWith("other-hosts-rest:"));
		expect(rest).toMatchObject({ depth: 3, value: 4, hiddenChildCount: 3 });
		expectConserved(s, 4 + 3 + 2 + 1 + 1);
	});

	it("UT-19 the global path budget reserves each visible host's top path, then fills by count and key", () => {
		const s = build(
			[
				{ url: "https://a.arag.de/a1", count: 100 },
				{ url: "https://a.arag.de/a2", count: 90 },
				{ url: "https://a.arag.de/a3", count: 80 },
				{ url: "https://b.arag.de/b1", count: 5 },
				{ url: "https://b.arag.de/b2", count: 4 },
				{ url: "https://c.arag.de/c1", count: 1 },
			],
			["arag.de"],
			{ maxVisibleConcretePaths: 4 },
		);
		expect(byKind(s, "path").map((n) => n.fullLabel)).toEqual([
			"a.arag.de/a1",
			"a.arag.de/a2",
			"b.arag.de/b1",
			"c.arag.de/c1",
		]);
		const rests = byKind(s, "rest");
		expect(rests.map((n) => [n.fullLabel, n.value, n.hiddenChildCount])).toEqual([
			[`${REST_LABEL} · a.arag.de`, 80, 1],
			[`${REST_LABEL} · b.arag.de`, 4, 1],
		]);
		expectConserved(s, 280);
	});

	it("UT-20 path pruning produces a per-host Rest with exact occurrence value and hidden-path count", () => {
		const rows = Array.from({ length: 10 }, (_, i) => ({ url: `https://www.arag.de/p${i}`, count: 10 - i }));
		const s = build(rows, ["arag.de"], { maxVisibleConcretePaths: 3 });
		expect(byKind(s, "path").map((n) => n.name)).toEqual(["/p0", "/p1", "/p2"]);
		const rest = named(s, REST_LABEL, 3);
		expect(rest).toMatchObject({ value: 7 + 6 + 5 + 4 + 3 + 2 + 1, hiddenChildCount: 7 });
		expect(rest?.id).toBe("rest-path:arag.de|www.arag.de");
		expect(byDepth(s, 3).at(-1)?.name).toBe(REST_LABEL);
		expectConserved(s, 55);
	});

	it("UT-21 zero-value synthetic nodes are omitted", () => {
		const s = build([
			{ url: "https://www.arag.de/a", count: 1 },
			{ url: "https://arag.de/b", count: 1 },
		]);
		expect(byKind(s, "rest")).toEqual([]);
		expect(s.nodes.some((n) => n.name === OTHER_DOMAINS_LABEL || n.name === OTHER_HOSTS_LABEL)).toBe(false);
	});

	it("UT-22 conservation holds before and after pruning at every level", () => {
		const rows: { url: string; count: number }[] = [];
		let total = 0;
		for (let d = 0; d < 12; d++) {
			for (let h = 0; h < 9; h++) {
				for (let p = 0; p < 7; p++) {
					const count = ((d * 7 + h * 3 + p) % 11) + 1;
					rows.push({ url: `https://h${h}.d${d}.test/p${p}`, count });
					total += count;
				}
			}
		}
		const owned = Array.from({ length: 12 }, (_, d) => `d${d}.test`);
		const full = build(rows, owned, {
			maxVisibleDomains: 1000,
			maxVisibleHostsPerDomain: 1000,
			maxVisibleConcretePaths: 100000,
		});
		expect(byKind(full, "rest")).toEqual([]);
		expect(byKind(full, "path")).toHaveLength(12 * 9 * 7);
		expectConserved(full, total);

		const pruned = build(rows, owned);
		expect(byKind(pruned, "domain")).toHaveLength(8);
		expect(byKind(pruned, "host")).toHaveLength(8 * 6);
		expect(byKind(pruned, "path").length).toBeLessThanOrEqual(60);
		expect(byKind(pruned, "rest").length).toBeGreaterThan(0);
		expectConserved(pruned, total);

		for (const [index, node] of pruned.nodes.entries()) {
			const inflow = pruned.links.filter((l) => l.target === index).reduce((s, l) => s + l.value, 0);
			const outflow = pruned.links.filter((l) => l.source === index).reduce((s, l) => s + l.value, 0);
			if (node.depth > 0) expect(inflow).toBe(node.value);
			if (node.depth < 3) expect(outflow).toBe(node.value);
		}
		for (const link of pruned.links) {
			expect(Number.isInteger(link.value) && link.value > 0).toBe(true);
		}
	});

	it("UT-23 the metric is citation occurrences, not distinct prompts or raw URL groups", () => {
		const s = build([
			{ url: "https://www.arag.de/a", count: 5 },
			{ url: "https://www.arag.de/a?ref=1", count: 3 },
			{ url: "https://www.arag.de/b", count: 1 },
		]);
		expect(s.totalOwnedOccurrences).toBe(9);
		expect(s.eligibleRawUrlGroups).toBe(3);
		expect(byKind(s, "path")).toHaveLength(2);
		expect(s.totalOwnedOccurrences).not.toBe(s.eligibleRawUrlGroups);
		expect(s.totalOwnedOccurrences).not.toBe(byKind(s, "path").length);
	});

	it("UT-24 an empty configured-domain set yields a valid empty result", () => {
		const s = build([{ url: "https://www.arag.de/a", count: 5 }], []);
		expectConserved(s, 0);
		expect(s.nonOwnedOccurrences).toBe(5);
		expect(ownedDomainCandidates("", [])).toEqual([]);
		expect(ownedDomainCandidates(null, null)).toEqual([]);
	});

	it("UT-25 empty eligible citations yield a valid empty result", () => {
		const s = build([]);
		expectConserved(s, 0);
		expect(s.eligibleRawUrlGroups).toBe(0);
		expect(s.excludedInvalidUrlOccurrences).toBe(0);
	});

	it("UT-26 ownership depends only on configured domains — no other classification input exists", () => {
		// The builder's signature has no supplemental-classification input; a
		// host that a cache might label "news" is owned iff a configured domain matches.
		const s = build(
			[
				{ url: "https://news.arag.de/x", count: 2 },
				{ url: "https://reddit.com/r/arag", count: 9 },
			],
			["arag.de"],
		);
		expect(byKind(s, "host").map((n) => n.name)).toEqual(["news.arag.de"]);
		expect(s.nonOwnedOccurrences).toBe(9);
		expectConserved(s, 2);
	});

	it("rejects a broken structure", () => {
		const s = build([{ url: "https://www.arag.de/a", count: 2 }]);
		expect(() => assertConservation({ ...s, links: s.links.map((l) => ({ ...l, value: 1 })) })).toThrow(/conservation/);
		expect(() => assertConservation({ ...s, totalOwnedOccurrences: 3 })).toThrow(/root value/);
	});
});
