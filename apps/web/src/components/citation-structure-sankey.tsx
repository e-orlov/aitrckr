/**
 * The Citation Structure page's one visualization: a four-column Sankey of
 * owned citation occurrences — brand → configured domain → raw hostname →
 * normalized path. Display only; ownership and reduction rules live in the
 * server-side builder that produced `nodes`/`links`.
 */
import { type ChartConfig, ChartContainer } from "@workspace/ui/components/chart";
import { useId } from "react";
import { Layer, Rectangle, Sankey, type SankeyLinkProps, type SankeyNodeProps, Tooltip } from "recharts";
import type { CitationStructureLink, CitationStructureNode, CitationStructureNodeKind } from "@/lib/citation-structure";

/** Below this width the four columns and their labels overlap; the canvas scrolls instead. */
export const MIN_CHART_WIDTH = 880;
const MIN_CHART_HEIGHT = 360;
/**
 * Enough for the worst case the builder's limits allow (~120 terminal nodes);
 * a lower cap would squeeze node heights below a pixel and hide the flows.
 */
const MAX_CHART_HEIGHT = 3600;
/** Vertical room per terminal node so neighbouring labels never collide. */
const ROW_HEIGHT = 26;
const NODE_PADDING = 12;
const NODE_WIDTH = 12;
/** Room for the terminal column's labels, drawn to the right of the last nodes. */
const MARGIN = { top: 8, right: 300, bottom: 8, left: 8 };
const MAX_LABEL_CHARS: Record<number, number> = { 0: 26, 1: 30, 2: 34, 3: 44 };

const KIND_LABEL: Record<CitationStructureNodeKind, string> = {
	brand: "Brand",
	domain: "Owned domain",
	host: "Hostname",
	path: "Path",
	rest: "Grouped remainder",
};

/** Paired light/dark fills, one per hierarchy level plus the synthetic remainder. */
const chartConfig = {
	brand: { label: "Brand", theme: { light: "#2563eb", dark: "#60a5fa" } },
	domain: { label: "Owned domain", theme: { light: "#4f46e5", dark: "#818cf8" } },
	host: { label: "Hostname", theme: { light: "#0d9488", dark: "#2dd4bf" } },
	path: { label: "Path", theme: { light: "#475569", dark: "#94a3b8" } },
	rest: { label: "Grouped remainder", theme: { light: "#9ca3af", dark: "#6b7280" } },
} satisfies ChartConfig;

export interface CitationStructureSankeyProps {
	nodes: CitationStructureNode[];
	links: CitationStructureLink[];
	/** Owned occurrences in the current filter — the denominator for every percentage. */
	total: number;
	className?: string;
}

export function chartHeightFor(nodes: readonly CitationStructureNode[]): number {
	const terminals = nodes.filter((node) => node.depth === 3).length;
	const rows = Math.max(terminals, nodes.filter((node) => node.depth === 2).length);
	return Math.min(MAX_CHART_HEIGHT, Math.max(MIN_CHART_HEIGHT, rows * ROW_HEIGHT + MARGIN.top + MARGIN.bottom));
}

export function formatOccurrences(value: number): string {
	return `${value.toLocaleString()} ${value === 1 ? "occurrence" : "occurrences"}`;
}

export function formatShare(value: number, total: number): string {
	if (total <= 0) return "0%";
	return `${((value / total) * 100).toLocaleString(undefined, { maximumFractionDigits: 1 })}%`;
}

function ellipsize(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, Math.max(1, max - 1))}…` : text;
}

/**
 * A node after Recharts' layout pass. Recharts spreads each input node into its
 * layout record, so our fields ride along; its typing only knows the geometry.
 */
type LaidOutNode = CitationStructureNode & SankeyNodeProps["payload"];

const laidOut = (payload: SankeyNodeProps["payload"]) => payload as LaidOutNode;

function SankeyNode({ x, y, width, height, payload: raw, total }: SankeyNodeProps & { total: number }) {
	const payload = laidOut(raw);
	const label = ellipsize(payload.name, MAX_LABEL_CHARS[payload.depth] ?? 30);
	const count = payload.value.toLocaleString();
	const textY = y + height / 2;
	const description = `${KIND_LABEL[payload.kind]} ${payload.fullLabel}: ${formatOccurrences(payload.value)}, ${formatShare(payload.value, total)}`;
	return (
		<Layer className="recharts-sankey-node" data-kind={payload.kind} data-depth={payload.depth}>
			<title>{description}</title>
			<Rectangle
				x={x}
				y={y}
				width={width}
				height={Math.max(height, 1)}
				fill={`var(--color-${payload.kind})`}
				fillOpacity={0.9}
				radius={2}
			/>
			<text
				x={x + width + 6}
				y={textY}
				dominantBaseline="middle"
				className="fill-foreground"
				fontSize={11}
				fontWeight={payload.depth === 0 ? 600 : 500}
				stroke="var(--background)"
				strokeWidth={3}
				strokeLinejoin="round"
				style={{ paintOrder: "stroke" }}
			>
				{label}
				<tspan className="fill-muted-foreground" fontWeight={400} dx={6}>
					{count}
				</tspan>
			</text>
		</Layer>
	);
}

function SankeyLink({
	sourceX,
	sourceY,
	sourceControlX,
	targetX,
	targetY,
	targetControlX,
	linkWidth,
	payload,
}: SankeyLinkProps) {
	return (
		<path
			className="recharts-sankey-link"
			d={`M${sourceX},${sourceY}C${sourceControlX},${sourceY} ${targetControlX},${targetY} ${targetX},${targetY}`}
			fill="none"
			stroke={`var(--color-${laidOut(payload.target).kind})`}
			strokeOpacity={0.28}
			strokeWidth={Math.max(linkWidth, 1)}
		/>
	);
}

type LinkItem = { source: LaidOutNode; target: LaidOutNode; value: number };

/**
 * Recharts hands the tooltip its payload-searcher result, i.e. one more
 * `{ payload, name, value }` wrapper around the hovered node or link.
 */
interface TooltipItem {
	payload: { payload: LaidOutNode | LinkItem; name: string; value: number };
}

function isLinkItem(item: LaidOutNode | LinkItem): item is LinkItem {
	return "source" in item && typeof item.source === "object" && item.source !== null;
}

export function CitationStructureTooltip({
	active,
	payload,
	total,
}: {
	active?: boolean;
	payload?: TooltipItem[];
	total: number;
}) {
	const item = payload?.[0]?.payload?.payload;
	if (!active || !item) return null;

	if (isLinkItem(item)) {
		return (
			<div
				role="status"
				className="border-border/50 bg-background grid min-w-[12rem] max-w-md gap-1 rounded-lg border px-2.5 py-1.5 text-xs shadow-xl"
			>
				<div className="font-medium break-all">
					{item.source.fullLabel} → {item.target.fullLabel}
				</div>
				<div className="text-muted-foreground">Flow</div>
				<div className="tabular-nums">
					{formatOccurrences(item.value)} · {formatShare(item.value, total)} of owned citations
				</div>
			</div>
		);
	}

	return (
		<div
			role="status"
			className="border-border/50 bg-background grid min-w-[12rem] max-w-md gap-1 rounded-lg border px-2.5 py-1.5 text-xs shadow-xl"
		>
			<div className="font-medium break-all">{item.fullLabel}</div>
			<div className="text-muted-foreground">{KIND_LABEL[item.kind]}</div>
			<div className="tabular-nums">
				{formatOccurrences(item.value)} · {formatShare(item.value, total)} of owned citations
			</div>
			{item.hiddenChildCount !== undefined && (
				<div className="text-muted-foreground tabular-nums">
					{formatOccurrences(item.value)} across {item.hiddenChildCount.toLocaleString()}{" "}
					{hiddenChildNoun(item, item.hiddenChildCount)}
				</div>
			)}
		</div>
	);
}

function hiddenChildNoun(node: CitationStructureNode, count: number): string {
	const singular = node.depth === 1 ? "domain" : node.depth === 2 ? "hostname" : "path";
	return count === 1 ? singular : `${singular}s`;
}

/**
 * The same hierarchy as a nested list for assistive technology. Recharts'
 * accessibility layer exposes the chart as one focusable application; the
 * per-node labels and counts live here.
 */
function HierarchySummary({ nodes, links, total, id }: CitationStructureSankeyProps & { id: string }) {
	const children = new Map<number, number[]>();
	for (const link of links) {
		const list = children.get(link.source) ?? [];
		list.push(link.target);
		children.set(link.source, list);
	}
	const item = (index: number) => {
		const node = nodes[index];
		const kids = children.get(index) ?? [];
		return (
			<li key={node.id}>
				{KIND_LABEL[node.kind]} {node.fullLabel}: {formatOccurrences(node.value)}, {formatShare(node.value, total)}
				{node.hiddenChildCount !== undefined
					? ` across ${node.hiddenChildCount.toLocaleString()} ${hiddenChildNoun(node, node.hiddenChildCount)}`
					: ""}
				{kids.length > 0 && <ul>{kids.map(item)}</ul>}
			</li>
		);
	};
	return (
		<ul id={id} className="sr-only" data-testid="citation-structure-summary">
			{nodes.length > 0 && item(0)}
		</ul>
	);
}

export function CitationStructureSankey({ nodes, links, total, className }: CitationStructureSankeyProps) {
	const summaryId = useId();
	const height = chartHeightFor(nodes);
	const root = nodes[0];
	const title = root ? `Owned citation structure for ${root.fullLabel}` : "Owned citation structure";
	const desc = `${formatOccurrences(total)} flowing from the brand through ${nodes.filter((n) => n.kind === "domain").length} owned domain(s) and ${nodes.filter((n) => n.kind === "host").length} hostname(s) into ${nodes.filter((n) => n.depth === 3).length} path node(s).`;

	return (
		<figure
			className={className}
			data-testid="citation-structure-sankey"
			aria-label={title}
			aria-describedby={summaryId}
		>
			<div className="overflow-x-auto">
				<div style={{ minWidth: MIN_CHART_WIDTH }}>
					<ChartContainer config={chartConfig} className="aspect-auto w-full" style={{ height }}>
						<Sankey
							data={{ nodes, links }}
							nodeWidth={NODE_WIDTH}
							nodePadding={NODE_PADDING}
							margin={MARGIN}
							sort={false}
							title={title}
							desc={desc}
							node={(props) => <SankeyNode {...props} total={total} />}
							link={(props) => <SankeyLink {...props} />}
						>
							<Tooltip isAnimationActive={false} content={<CitationStructureTooltip total={total} />} />
						</Sankey>
					</ChartContainer>
				</div>
			</div>
			<HierarchySummary nodes={nodes} links={links} total={total} id={summaryId} />
		</figure>
	);
}
