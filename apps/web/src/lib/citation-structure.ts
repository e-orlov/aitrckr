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

/** A node of the pruned display tree; children are already in display order. */
interface DisplayNode extends CitationStructureNode {
	children: DisplayNode[];
}

interface HostView {
	domainKey: string;
	host: HostAgg;
	paths: Counted[];
}

const synthetic = (
	id: string,
	name: string,
	depth: DisplayNode["depth"],
	value: number,
	fullLabel: string,
	hiddenChildCount: number,
): DisplayNode => ({ id, name, kind: "rest", depth, value, fullLabel, hiddenChildCount, children: [] });

const sumOf = <T>(items: readonly T[], pick: (item: T) => number) => items.reduce((sum, item) => sum + pick(item), 0);
const pathsIn = (domain: DomainAgg) => sumOf([...domain.hosts.values()], (host) => host.paths.size);

/**
 * Domains beyond the visible budget collapse into one chain — Other owned
 * domains → Other hosts → Rest — so their occurrences still reach a terminal.
 */
function otherDomainsChain(brandId: string, hidden: DomainAgg[]): DisplayNode | undefined {
	const value = sumOf(hidden, (domain) => domain.count);
	if (value === 0) return undefined;
	const rest = synthetic(
		`other-domains-rest:${encode(brandId)}`,
		REST_LABEL,
		3,
		value,
		`${REST_LABEL} · ${OTHER_DOMAINS_LABEL}`,
		sumOf(hidden, pathsIn),
	);
	const hosts = synthetic(
		`other-domains-hosts:${encode(brandId)}`,
		OTHER_HOSTS_LABEL,
		2,
		value,
		`${OTHER_HOSTS_LABEL} · ${OTHER_DOMAINS_LABEL}`,
		sumOf(hidden, (domain) => domain.hosts.size),
	);
	hosts.children.push(rest);
	const other = synthetic(
		`other-domains:${encode(brandId)}`,
		OTHER_DOMAINS_LABEL,
		1,
		value,
		OTHER_DOMAINS_LABEL,
		hidden.length,
	);
	other.children.push(hosts);
	return other;
}

/** Hosts beyond a domain's budget collapse into Other hosts → Rest. */
function otherHostsChain(domainKey: string, hidden: HostAgg[]): DisplayNode | undefined {
	const value = sumOf(hidden, (host) => host.count);
	if (value === 0) return undefined;
	const rest = synthetic(
		`other-hosts-rest:${encode(domainKey)}`,
		REST_LABEL,
		3,
		value,
		`${REST_LABEL} · ${OTHER_HOSTS_LABEL} · ${domainKey}`,
		sumOf(hidden, (host) => host.paths.size),
	);
	const other = synthetic(
		`other-hosts:${encode(domainKey)}`,
		OTHER_HOSTS_LABEL,
		2,
		value,
		`${OTHER_HOSTS_LABEL} · ${domainKey}`,
		hidden.length,
	);
	other.children.push(rest);
	return other;
}

/**
 * Pick the concrete paths to draw: every visible host keeps its top path, then
 * the rest of the global budget is filled by count, ties by stable key.
 */
function selectVisiblePaths(hosts: readonly HostView[], budget: number): Set<string> {
	const selected = new Set<string>();
	const candidates: Counted[] = [];
	for (const view of hosts) {
		for (const [index, path] of view.paths.entries()) {
			const key = encode(view.domainKey, view.host.key, path.key);
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

function pathChildren(view: HostView, selected: ReadonlySet<string>): DisplayNode[] {
	const children: DisplayNode[] = [];
	const hidden: Counted[] = [];
	for (const path of view.paths) {
		if (!selected.has(encode(view.domainKey, view.host.key, path.key))) {
			hidden.push(path);
			continue;
		}
		children.push({
			id: `path:${encode(view.domainKey, view.host.key, path.key)}`,
			name: path.key,
			kind: "path",
			depth: 3,
			value: path.count,
			fullLabel: `${view.host.key}${path.key}`,
			children: [],
		});
	}
	const restValue = sumOf(hidden, (path) => path.count);
	if (restValue > 0) {
		children.push(
			synthetic(
				`rest-path:${encode(view.domainKey, view.host.key)}`,
				REST_LABEL,
				3,
				restValue,
				`${REST_LABEL} · ${view.host.key}`,
				hidden.length,
			),
		);
	}
	return children;
}

function buildDisplayTree(
	input: { brandId: string; brandName: string },
	domains: Map<string, DomainAgg>,
	total: number,
	limits: CitationStructureLimits,
): DisplayNode {
	const root: DisplayNode = {
		id: `brand:${encode(input.brandId)}`,
		name: input.brandName,
		kind: "brand",
		depth: 0,
		value: total,
		fullLabel: input.brandName,
		children: [],
	};

	const sortedDomains = [...domains.values()].sort(byCountThenKey);
	const hostViews: HostView[] = [];
	const hostNodes = new Map<HostView, DisplayNode>();
	for (const domain of sortedDomains.slice(0, limits.maxVisibleDomains)) {
		const domainNode: DisplayNode = {
			id: `domain:${encode(domain.key)}`,
			name: domain.key,
			kind: "domain",
			depth: 1,
			value: domain.count,
			fullLabel: domain.key,
			children: [],
		};
		const sortedHosts = [...domain.hosts.values()].sort(byCountThenKey);
		for (const host of sortedHosts.slice(0, limits.maxVisibleHostsPerDomain)) {
			const view: HostView = {
				domainKey: domain.key,
				host,
				paths: [...host.paths.entries()].map(([key, count]) => ({ key, count })).sort(byCountThenKey),
			};
			const hostNode: DisplayNode = {
				id: `host:${encode(domain.key, host.key)}`,
				name: host.key,
				kind: "host",
				depth: 2,
				value: host.count,
				fullLabel: host.key,
				children: [],
			};
			hostViews.push(view);
			hostNodes.set(view, hostNode);
			domainNode.children.push(hostNode);
		}
		const otherHosts = otherHostsChain(domain.key, sortedHosts.slice(limits.maxVisibleHostsPerDomain));
		if (otherHosts) domainNode.children.push(otherHosts);
		root.children.push(domainNode);
	}
	const otherDomains = otherDomainsChain(input.brandId, sortedDomains.slice(limits.maxVisibleDomains));
	if (otherDomains) root.children.push(otherDomains);

	const selected = selectVisiblePaths(hostViews, limits.maxVisibleConcretePaths);
	for (const view of hostViews) {
		(hostNodes.get(view) as DisplayNode).children = pathChildren(view, selected);
	}
	return root;
}

/**
 * Flatten depth by depth in tree order, so each column reads top-down in the
 * same order as its parents and the Sankey needs no crossing links. Recharts
 * links reference node indices, which only exist after this step.
 */
function flatten(root: DisplayNode): Pick<CitationStructure, "nodes" | "links"> {
	const nodes: CitationStructureNode[] = [];
	const links: CitationStructureLink[] = [];
	let level: { node: DisplayNode; parent: number | undefined }[] = [{ node: root, parent: undefined }];
	while (level.length > 0) {
		const next: typeof level = [];
		for (const { node, parent } of level) {
			const { children, ...plain } = node;
			const index = nodes.push(plain) - 1;
			if (parent !== undefined) links.push({ source: parent, target: index, value: node.value });
			for (const child of children) next.push({ node: child, parent: index });
		}
		level = next;
	}
	return { nodes, links };
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

	const result = { ...base, ...flatten(buildDisplayTree(input, agg.domains, agg.total, limits)) };
	assertConservation(result);
	return result;
}

const fail = (message: string): never => {
	throw new Error(`citation structure conservation violated: ${message}`);
};

const isPositiveInteger = (value: number) => Number.isInteger(value) && value > 0;

/** Per-node inflow/outflow from the links; also validates every link. */
function flows(nodes: readonly CitationStructureNode[], links: readonly CitationStructureLink[]) {
	const inflow = new Array<number>(nodes.length).fill(0);
	const outflow = new Array<number>(nodes.length).fill(0);
	for (const link of links) {
		if (!isPositiveInteger(link.value)) fail(`link value ${link.value}`);
		const source = nodes[link.source];
		const target = nodes[link.target];
		if (!source || !target) fail("link to unknown node");
		if (target.depth !== source.depth + 1) fail("link skips a depth");
		outflow[link.source] += link.value;
		inflow[link.target] += link.value;
	}
	return { inflow, outflow };
}

function checkNode(node: CitationStructureNode, inflow: number, outflow: number) {
	if (!isPositiveInteger(node.value)) fail(`node value ${node.value} (${node.id})`);
	if (node.depth > 0 && inflow !== node.value) fail(`inflow ${inflow} ≠ value ${node.value} (${node.id})`);
	if (node.depth < 3 && outflow !== node.value) fail(`outflow ${outflow} ≠ value ${node.value} (${node.id})`);
	if (node.depth === 3 && outflow !== 0) fail(`terminal with outflow (${node.id})`);
}

/**
 * Every occurrence that enters the root leaves through exactly one terminal:
 * the root equals each depth's node sum and each depth's link sum, every
 * non-terminal node's inflow equals its value equals its outflow, and no link
 * carries a non-positive or non-integer value. Throws on the first violation.
 */
export function assertConservation(structure: Pick<CitationStructure, "nodes" | "links" | "totalOwnedOccurrences">) {
	const { nodes, links, totalOwnedOccurrences } = structure;
	if (nodes.length === 0) {
		if (links.length > 0 || totalOwnedOccurrences !== 0) fail("links or total without nodes");
		return;
	}
	if (nodes[0].depth !== 0 || nodes[0].value !== totalOwnedOccurrences) fail("root value ≠ total");

	const { inflow, outflow } = flows(nodes, links);
	const perDepth = [0, 0, 0, 0];
	const ids = new Set<string>();
	for (const [index, node] of nodes.entries()) {
		if (ids.has(node.id)) fail(`duplicate node id ${node.id}`);
		ids.add(node.id);
		checkNode(node, inflow[index], outflow[index]);
		perDepth[node.depth] += node.value;
	}
	for (const depth of [1, 2, 3]) {
		if (perDepth[depth] !== totalOwnedOccurrences) fail(`depth ${depth} sum ${perDepth[depth]} ≠ total`);
	}
}
