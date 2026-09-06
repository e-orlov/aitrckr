/**
 * Owned citation URL structure: brand → configured owned domain → raw hostname →
 * normalized pathname, weighted by citation occurrences. Pure — no React, no DB.
 *
 * The flow unit is one persisted `citations` row. Input rows are the SQL
 * groups by raw URL (`count(*)`), and every group contributes its whole count.
 * The general `normalizeUrl()` is deliberately not used here: it strips `www.`,
 * and telling `www.arag.de` from `arag.de` is the point of the hostname level.
 */
import { extractDomain } from "@/lib/domain-categories";

export const MAX_VISIBLE_DOMAINS = 8;
export const MAX_VISIBLE_HOSTS_PER_DOMAIN = 6;
export const MAX_VISIBLE_CONCRETE_PATHS = 60;

export const OTHER_DOMAINS_LABEL = "Other owned domains";
export const OTHER_HOSTS_LABEL = "Other hosts";
export const REST_LABEL = "Rest";

export type CitationStructureNodeKind = "brand" | "domain" | "host" | "path" | "rest";

export interface CitationStructureNode {
	id: string;
	name: string;
	kind: CitationStructureNodeKind;
	value: number;
	depth: 0 | 1 | 2 | 3;
	fullLabel: string;
	/** Synthetic nodes only: how many distinct children were folded into this node. */
	hiddenChildCount?: number;
}

export interface CitationStructureLink {
	source: number;
	target: number;
	value: number;
}

export interface CitationStructure {
	totalOwnedOccurrences: number;
	eligibleRawUrlGroups: number;
	excludedInvalidUrlOccurrences: number;
	nonOwnedOccurrences: number;
	nodes: CitationStructureNode[];
	links: CitationStructureLink[];
}

export interface OwnedCitationRow {
	url: string;
	count: number;
}

export interface CitationStructureLimits {
	maxVisibleDomains: number;
	maxVisibleHostsPerDomain: number;
	maxVisibleConcretePaths: number;
}

export const DEFAULT_LIMITS: CitationStructureLimits = {
	maxVisibleDomains: MAX_VISIBLE_DOMAINS,
	maxVisibleHostsPerDomain: MAX_VISIBLE_HOSTS_PER_DOMAIN,
	maxVisibleConcretePaths: MAX_VISIBLE_CONCRETE_PATHS,
};

/**
 * The brand's ownership roots: the primary website plus every additional
 * domain, through the same extraction the Citations page uses for its
 * brand-domain set (scheme, `www.` and path removed, lowercased).
 */
export function ownedDomainCandidates(
	website: string | null | undefined,
	additionalDomains: readonly string[] | null | undefined,
): string[] {
	const out: string[] = [];
	for (const raw of [website ?? "", ...(additionalDomains ?? [])]) {
		const domain = extractDomain(raw.trim()).trim().toLowerCase().replace(/\.$/, "");
		if (domain && !out.includes(domain)) out.push(domain);
	}
	return out;
}

/** Exact or dot-suffix match; the longest configured candidate wins. */
export function matchOwnedDomain(hostname: string, candidates: readonly string[]): string | undefined {
	let best: string | undefined;
	for (const candidate of candidates) {
		if (hostname !== candidate && !hostname.endsWith(`.${candidate}`)) continue;
		if (best === undefined || candidate.length > best.length) best = candidate;
	}
	return best;
}

export function normalizeCitationPath(pathname: string): string {
	const path = pathname || "/";
	if (path === "/") return "/";
	return path.replace(/\/+$/, "") || "/";
}

/**
 * WHATWG parse of a stored raw URL. Only http(s) with a hostname qualifies;
 * anything else is `undefined` so the caller can count it as excluded.
 */
export function parseOwnedCitationUrl(raw: string): { hostname: string; path: string } | undefined {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		return undefined;
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
	const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
	if (!hostname) return undefined;
	return { hostname, path: normalizeCitationPath(url.pathname) };
}

// Locale-independent, so ordering is identical on every server and browser.
const compareKeys = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

interface Counted {
	key: string;
	count: number;
}

/** Occurrences descending, then key ascending. */
function byCountThenKey<T extends Counted>(a: T, b: T): number {
	return b.count - a.count || compareKeys(a.key, b.key);
}

const encode = (...parts: string[]) => parts.map(encodeURIComponent).join("|");

interface HostAgg {
	key: string;
	count: number;
	paths: Map<string, number>;
}

interface DomainAgg {
	key: string;
	count: number;
	hosts: Map<string, HostAgg>;
}

function aggregate(rows: readonly OwnedCitationRow[], ownedDomains: readonly string[]) {
	const domains = new Map<string, DomainAgg>();
	let total = 0;
	let eligibleRawUrlGroups = 0;
	let excludedInvalidUrlOccurrences = 0;
	let nonOwnedOccurrences = 0;

	for (const row of rows) {
		const count = Number(row.count);
		if (!Number.isInteger(count) || count <= 0) continue;
		const parsed = parseOwnedCitationUrl(row.url);
		if (!parsed) {
			excludedInvalidUrlOccurrences += count;
			continue;
		}
		const domainKey = matchOwnedDomain(parsed.hostname, ownedDomains);
		if (domainKey === undefined) {
			nonOwnedOccurrences += count;
			continue;
		}

		total += count;
		eligibleRawUrlGroups += 1;
		let domain = domains.get(domainKey);
		if (!domain) {
			domain = { key: domainKey, count: 0, hosts: new Map() };
			domains.set(domainKey, domain);
		}
		domain.count += count;
		let host = domain.hosts.get(parsed.hostname);
		if (!host) {
			host = { key: parsed.hostname, count: 0, paths: new Map() };
			domain.hosts.set(parsed.hostname, host);
		}
		host.count += count;
		host.paths.set(parsed.path, (host.paths.get(parsed.path) ?? 0) + count);
	}

	return { domains, total, eligibleRawUrlGroups, excludedInvalidUrlOccurrences, nonOwnedOccurrences };
}

interface VisibleHost {
	domain: DomainAgg;
	host: HostAgg;
	paths: Counted[];
}

/**
 * Pick the concrete paths to draw: every visible host keeps its top path, then
 * the rest of the global budget is filled by count, ties by stable key.
 */
function selectVisiblePaths(visibleHosts: VisibleHost[], budget: number): Set<string> {
	const pathKey = (h: VisibleHost, path: string) => encode(h.domain.key, h.host.key, path);
	const selected = new Set<string>();
	const candidates: Counted[] = [];

	for (const visible of visibleHosts) {
		for (const [index, path] of visible.paths.entries()) {
			const key = pathKey(visible, path.key);
			if (index === 0) selected.add(key);
			else candidates.push({ key, count: path.count });
		}
	}

	candidates.sort(byCountThenKey);
	for (const candidate of candidates) {
		if (selected.size >= budget) break;
		selected.add(candidate.key);
	}
	return selected;
}

export function buildCitationStructure(input: {
	brandId: string;
	brandName: string;
	ownedDomains: readonly string[];
	rows: readonly OwnedCitationRow[];
	limits?: Partial<CitationStructureLimits>;
}): CitationStructure {
	const limits = { ...DEFAULT_LIMITS, ...input.limits };
	const agg = aggregate(input.rows, input.ownedDomains);
	const base = {
		totalOwnedOccurrences: agg.total,
		eligibleRawUrlGroups: agg.eligibleRawUrlGroups,
		excludedInvalidUrlOccurrences: agg.excludedInvalidUrlOccurrences,
		nonOwnedOccurrences: agg.nonOwnedOccurrences,
	};
	if (agg.total === 0) return { ...base, nodes: [], links: [] };

	const nodes: CitationStructureNode[] = [];
	const links: CitationStructureLink[] = [];
	const indexOf = new Map<string, number>();
	const addNode = (node: CitationStructureNode): number => {
		const index = nodes.length;
		nodes.push(node);
		indexOf.set(node.id, index);
		return index;
	};
	const addLink = (sourceId: string, targetId: string, value: number) => {
		const source = indexOf.get(sourceId);
		const target = indexOf.get(targetId);
		if (source === undefined || target === undefined) throw new Error("citation structure: link to unknown node");
		links.push({ source, target, value });
	};

	const rootId = `brand:${encode(input.brandId)}`;
	addNode({ id: rootId, name: input.brandName, kind: "brand", value: agg.total, depth: 0, fullLabel: input.brandName });

	// Depth 1: domains, in display order, synthetic last.
	const sortedDomains = [...agg.domains.values()].sort(byCountThenKey);
	const visibleDomains = sortedDomains.slice(0, limits.maxVisibleDomains);
	const hiddenDomains = sortedDomains.slice(limits.maxVisibleDomains);
	for (const domain of visibleDomains) {
		addNode({
			id: `domain:${encode(domain.key)}`,
			name: domain.key,
			kind: "domain",
			value: domain.count,
			depth: 1,
			fullLabel: domain.key,
		});
	}
	const otherDomainsValue = hiddenDomains.reduce((sum, d) => sum + d.count, 0);
	const otherDomainsId = `other-domains:${encode(input.brandId)}`;
	if (otherDomainsValue > 0) {
		addNode({
			id: otherDomainsId,
			name: OTHER_DOMAINS_LABEL,
			kind: "rest",
			value: otherDomainsValue,
			depth: 1,
			fullLabel: OTHER_DOMAINS_LABEL,
			hiddenChildCount: hiddenDomains.length,
		});
	}

	// Depth 2: hosts grouped under their domain, synthetic last within each group.
	const visibleHosts: VisibleHost[] = [];
	const otherHostsByDomain = new Map<string, { value: number; hosts: number; paths: number }>();
	for (const domain of visibleDomains) {
		const sortedHosts = [...domain.hosts.values()].sort(byCountThenKey);
		const keep = sortedHosts.slice(0, limits.maxVisibleHostsPerDomain);
		const fold = sortedHosts.slice(limits.maxVisibleHostsPerDomain);
		for (const host of keep) {
			addNode({
				id: `host:${encode(domain.key, host.key)}`,
				name: host.key,
				kind: "host",
				value: host.count,
				depth: 2,
				fullLabel: host.key,
			});
			const paths = [...host.paths.entries()].map(([key, count]) => ({ key, count })).sort(byCountThenKey);
			visibleHosts.push({ domain, host, paths });
		}
		const folded = {
			value: fold.reduce((sum, h) => sum + h.count, 0),
			hosts: fold.length,
			paths: fold.reduce((sum, h) => sum + h.paths.size, 0),
		};
		if (folded.value > 0) {
			otherHostsByDomain.set(domain.key, folded);
			addNode({
				id: `other-hosts:${encode(domain.key)}`,
				name: OTHER_HOSTS_LABEL,
				kind: "rest",
				value: folded.value,
				depth: 2,
				fullLabel: `${OTHER_HOSTS_LABEL} · ${domain.key}`,
				hiddenChildCount: folded.hosts,
			});
		}
	}
	const otherDomainsHostsId = `other-domains-hosts:${encode(input.brandId)}`;
	if (otherDomainsValue > 0) {
		addNode({
			id: otherDomainsHostsId,
			name: OTHER_HOSTS_LABEL,
			kind: "rest",
			value: otherDomainsValue,
			depth: 2,
			fullLabel: `${OTHER_HOSTS_LABEL} · ${OTHER_DOMAINS_LABEL}`,
			hiddenChildCount: hiddenDomains.reduce((sum, d) => sum + d.hosts.size, 0),
		});
	}

	// Depth 3: paths grouped under their host, Rest last within each group.
	const selectedPaths = selectVisiblePaths(visibleHosts, limits.maxVisibleConcretePaths);
	const restByHost = new Map<string, { value: number; paths: number }>();
	for (const visible of visibleHosts) {
		let restValue = 0;
		let restPaths = 0;
		for (const path of visible.paths) {
			const id = `path:${encode(visible.domain.key, visible.host.key, path.key)}`;
			if (selectedPaths.has(encode(visible.domain.key, visible.host.key, path.key))) {
				addNode({
					id,
					name: path.key,
					kind: "path",
					value: path.count,
					depth: 3,
					fullLabel: `${visible.host.key}${path.key}`,
				});
			} else {
				restValue += path.count;
				restPaths += 1;
			}
		}
		if (restValue > 0) {
			restByHost.set(encode(visible.domain.key, visible.host.key), { value: restValue, paths: restPaths });
			addNode({
				id: `rest-path:${encode(visible.domain.key, visible.host.key)}`,
				name: REST_LABEL,
				kind: "rest",
				value: restValue,
				depth: 3,
				fullLabel: `${REST_LABEL} · ${visible.host.key}`,
				hiddenChildCount: restPaths,
			});
		}
	}
	for (const [domainKey, folded] of otherHostsByDomain) {
		addNode({
			id: `other-hosts-rest:${encode(domainKey)}`,
			name: REST_LABEL,
			kind: "rest",
			value: folded.value,
			depth: 3,
			fullLabel: `${REST_LABEL} · ${OTHER_HOSTS_LABEL} · ${domainKey}`,
			hiddenChildCount: folded.paths,
		});
	}
	const otherDomainsRestId = `other-domains-rest:${encode(input.brandId)}`;
	if (otherDomainsValue > 0) {
		addNode({
			id: otherDomainsRestId,
			name: REST_LABEL,
			kind: "rest",
			value: otherDomainsValue,
			depth: 3,
			fullLabel: `${REST_LABEL} · ${OTHER_DOMAINS_LABEL}`,
			hiddenChildCount: hiddenDomains.reduce(
				(sum, d) => sum + [...d.hosts.values()].reduce((s, h) => s + h.paths.size, 0),
				0,
			),
		});
	}

	// Links, in node order so link index order mirrors node order.
	for (const domain of visibleDomains) addLink(rootId, `domain:${encode(domain.key)}`, domain.count);
	if (otherDomainsValue > 0) addLink(rootId, otherDomainsId, otherDomainsValue);
	for (const visible of visibleHosts) {
		addLink(
			`domain:${encode(visible.domain.key)}`,
			`host:${encode(visible.domain.key, visible.host.key)}`,
			visible.host.count,
		);
	}
	for (const [domainKey, folded] of otherHostsByDomain) {
		addLink(`domain:${encode(domainKey)}`, `other-hosts:${encode(domainKey)}`, folded.value);
	}
	if (otherDomainsValue > 0) addLink(otherDomainsId, otherDomainsHostsId, otherDomainsValue);
	for (const visible of visibleHosts) {
		const hostId = `host:${encode(visible.domain.key, visible.host.key)}`;
		for (const path of visible.paths) {
			if (selectedPaths.has(encode(visible.domain.key, visible.host.key, path.key))) {
				addLink(hostId, `path:${encode(visible.domain.key, visible.host.key, path.key)}`, path.count);
			}
		}
		const rest = restByHost.get(encode(visible.domain.key, visible.host.key));
		if (rest) addLink(hostId, `rest-path:${encode(visible.domain.key, visible.host.key)}`, rest.value);
	}
	for (const [domainKey, folded] of otherHostsByDomain) {
		addLink(`other-hosts:${encode(domainKey)}`, `other-hosts-rest:${encode(domainKey)}`, folded.value);
	}
	if (otherDomainsValue > 0) addLink(otherDomainsHostsId, otherDomainsRestId, otherDomainsValue);

	const result = { ...base, nodes, links };
	assertConservation(result);
	return result;
}

/**
 * Every occurrence that enters the root leaves through exactly one terminal:
 * the root equals each depth's node sum and each depth's link sum, every
 * non-terminal node's inflow equals its value equals its outflow, and no link
 * carries a non-positive or non-integer value. Throws on the first violation.
 */
export function assertConservation(structure: Pick<CitationStructure, "nodes" | "links" | "totalOwnedOccurrences">) {
	const { nodes, links, totalOwnedOccurrences } = structure;
	const fail = (message: string): never => {
		throw new Error(`citation structure conservation violated: ${message}`);
	};
	if (nodes.length === 0) {
		if (links.length > 0 || totalOwnedOccurrences !== 0) fail("links or total without nodes");
		return;
	}

	const inflow = new Array<number>(nodes.length).fill(0);
	const outflow = new Array<number>(nodes.length).fill(0);
	for (const link of links) {
		if (!Number.isInteger(link.value) || link.value <= 0) fail(`link value ${link.value}`);
		if (!nodes[link.source] || !nodes[link.target]) fail("link to unknown node");
		if (nodes[link.target].depth !== nodes[link.source].depth + 1) fail("link skips a depth");
		outflow[link.source] += link.value;
		inflow[link.target] += link.value;
	}

	const perDepth = [0, 0, 0, 0];
	const ids = new Set<string>();
	for (const [index, node] of nodes.entries()) {
		if (ids.has(node.id)) fail(`duplicate node id ${node.id}`);
		ids.add(node.id);
		if (!Number.isInteger(node.value) || node.value <= 0) fail(`node value ${node.value} (${node.id})`);
		perDepth[node.depth] += node.value;
		if (node.depth > 0 && inflow[index] !== node.value)
			fail(`inflow ${inflow[index]} ≠ value ${node.value} (${node.id})`);
		if (node.depth < 3 && outflow[index] !== node.value)
			fail(`outflow ${outflow[index]} ≠ value ${node.value} (${node.id})`);
		if (node.depth === 3 && outflow[index] !== 0) fail(`terminal with outflow (${node.id})`);
	}
	if (nodes[0].depth !== 0 || nodes[0].value !== totalOwnedOccurrences) fail("root value ≠ total");
	for (const depth of [1, 2, 3]) {
		if (perDepth[depth] !== totalOwnedOccurrences) fail(`depth ${depth} sum ${perDepth[depth]} ≠ total`);
	}
}
