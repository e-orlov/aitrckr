import type { Meta, StoryObj } from "@storybook/react";
import { TooltipProvider } from "@workspace/ui/components/tooltip";
import type { ComponentType, ReactNode } from "react";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { buildCitationStructure } from "@/lib/citation-structure";
import { Route } from "@/routes/_authed/app/org/$org/brand/$brand/citation-structure";
import { type CitationStructureResult, setMockCitationStructure } from "./_mocks/server-citation-structure";
import { setMockBrand } from "./_mocks/use-brands";

// The route file exports only `Route` (route files must, for code-splitting).
// Render its component via the route options — the mock exposes `options`.
const CitationStructurePage = (Route as unknown as { options: { component: ComponentType } }).options.component;

const onboardedBrand = {
	id: "arag",
	name: "ARAG",
	website: "https://arag.de/",
	additionalDomains: ["arag.com"],
	onboarded: true,
	enabled: true,
	prompts: [{ id: "p1", value: "rechtsschutz vergleich", enabled: true }],
	effectiveModels: ["chatgpt", "claude"],
	trackedTargets: [
		{ value: "chatgpt", model: "chatgpt", premium: false, tier: "scraped", intervalHours: 12, replication: 1 },
		{ value: "claude", model: "claude", premium: false, tier: "scraped", intervalHours: 12, replication: 1 },
	],
	earliestDataDate: "2026-08-01",
	delayOverrideHours: 12,
};

/** Build a response exactly the way the server does, from raw URL groups. */
function response(
	rows: { url: string; count: number }[],
	ownedDomains = ["arag.de", "arag.com"],
	overrides: Partial<CitationStructureResult> = {},
): CitationStructureResult {
	const structure = buildCitationStructure({ brandId: "arag", brandName: "ARAG", ownedDomains, rows });
	return {
		availableTags: ["branded", "unbranded", "rechtsschutz"],
		ownedDomainCount: ownedDomains.length,
		totalOwnedOccurrences: structure.totalOwnedOccurrences,
		eligibleRawUrlGroups: structure.eligibleRawUrlGroups,
		excludedInvalidUrlOccurrences: structure.excludedInvalidUrlOccurrences,
		nodes: structure.nodes,
		links: structure.links,
		...overrides,
	};
}

/** Apex, www and a prerelease host under the primary domain, plus the additional domain. Total 73. */
export const aragLike = response([
	{ url: "https://www.arag.de/rechtsschutzversicherung/", count: 18 },
	{ url: "https://www.arag.de/rechtsschutzversicherung", count: 6 },
	{ url: "https://www.arag.de/service/rechtsschutz-rechner/", count: 11 },
	{ url: "https://www.arag.de/", count: 9 },
	{ url: "http://www.arag.de/?utm_source=chatgpt.com", count: 3 },
	{ url: "https://www.arag.de/service/faq", count: 4 },
	{ url: "https://www.arag.de/ratgeber/mietrecht/", count: 2 },
	{ url: "https://arag.de/", count: 5 },
	{ url: "https://arag.de/karriere", count: 1 },
	{ url: "https://prerelease.arag.de/rechtsschutzversicherung", count: 2 },
	{ url: "https://www.arag.com/", count: 7 },
	{ url: "https://www.arag.com/about-us/", count: 4 },
	{ url: "https://www.arag.com/products/legal-insurance", count: 1 },
	{ url: "https://notarag.de/x", count: 40 },
	{ url: "https://reddit.com/r/versicherung", count: 25 },
]);

const many = (() => {
	const rows: { url: string; count: number }[] = [];
	const owned: string[] = [];
	for (let d = 0; d < 11; d++) {
		owned.push(`arag-${d}.test`);
		for (let h = 0; h < 8; h++) {
			for (let p = 0; p < 6; p++) {
				rows.push({
					url: `https://h${h}.arag-${d}.test/section-${p}/page`,
					count: ((d * 13 + h * 5 + p * 3) % 17) + 1,
				});
			}
		}
	}
	return response(rows, owned);
})();

const longLabels = response(
	[
		{
			url: "https://www.arag.de/rechtsschutzversicherung/privat-rechtsschutz/vergleich-der-tarife-fuer-familien-und-singles/2026",
			count: 12,
		},
		{ url: "https://very-long-subdomain-name-for-marketing-campaigns.arag.de/landing", count: 5 },
		{ url: "https://www.arag.de/a/b/c/d/e/f/g/h/i/j/k/l/m/n/o/p/q/r/s/t/u/v/w/x/y/z", count: 3 },
	],
	["arag.de"],
);

function Shell({ children, className = "" }: { children: ReactNode; className?: string }) {
	return (
		<TooltipProvider>
			<div className={`bg-background text-foreground antialiased flex min-h-svh flex-col ${className}`}>
				<div className="flex flex-1 flex-col">
					<div className="@container/main flex flex-1 flex-col gap-2">
						<div className="flex flex-1 flex-col gap-4 p-4 md:gap-6 md:p-6">{children}</div>
					</div>
				</div>
			</div>
		</TooltipProvider>
	);
}

const meta = {
	title: "Pages/Citation Structure",
	component: CitationStructurePage,
	parameters: { layout: "fullscreen" },
	decorators: [
		(Story, context) => {
			setMockBrand(onboardedBrand);
			return (
				<Shell className={context.parameters.dark ? "dark" : ""}>
					<Story />
				</Shell>
			);
		},
	],
} satisfies Meta<typeof CitationStructurePage>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The page's analytical content is exactly one Sankey — no cards, tables, tabs or second chart. */
async function expectOnlyTheSankey(canvasElement: HTMLElement) {
	const canvas = within(canvasElement);
	await expect(await canvas.findByRole("heading", { level: 1, name: /citation structure/i })).toBeInTheDocument();
	await expect(canvas.getAllByTestId("citation-structure-sankey")).toHaveLength(1);
	await expect(canvasElement.querySelectorAll("[data-slot=chart]")).toHaveLength(1);
	await expect(canvasElement.querySelectorAll(".recharts-surface")).toHaveLength(1);
	await expect(canvas.queryAllByRole("table")).toHaveLength(0);
	await expect(canvas.queryAllByRole("tablist")).toHaveLength(0);
	await expect(canvasElement.querySelectorAll("[data-slot=card]")).toHaveLength(0);
	await expect(canvas.queryByRole("searchbox")).toBeNull();
	// The shared filter row: model, tags and lookback — nothing else.
	await expect(canvas.getByRole("button", { name: /all models/i })).toBeInTheDocument();
	await expect(canvas.getByRole("button", { name: /^tags$/i })).toBeInTheDocument();
	await expect(canvas.getByRole("button", { name: /last 30 days/i })).toBeInTheDocument();
	await expect(canvas.queryByText(/results?$/i)).toBeNull();
}

const nodeLayers = (canvasElement: HTMLElement) =>
	canvasElement.querySelectorAll<SVGGElement>("g.recharts-sankey-node");

export const Default: Story = {
	decorators: [
		(Story) => {
			setMockCitationStructure(aragLike);
			return <Story />;
		},
	],
	play: async ({ canvasElement }) => {
		await expectOnlyTheSankey(canvasElement);
		const canvas = within(canvasElement);

		// Layout is async (ResponsiveContainer measures first), so wait for the nodes.
		await waitFor(() => expect(nodeLayers(canvasElement).length).toBe(aragLike.nodes.length));
		const labels = [...nodeLayers(canvasElement)].map((g) => g.querySelector("text")?.textContent);
		await expect(labels).toContain("ARAG73");
		await expect(labels).toContain("arag.de61");
		await expect(labels).toContain("arag.com12");
		await expect(labels).toContain("www.arag.de53");
		await expect(labels).toContain("arag.de6");
		await expect(labels).toContain("prerelease.arag.de2");
		await expect(labels).toContain("/rechtsschutzversicherung24");
		await expect(labels).toContain("/12");

		// Full labels and exact counts stay available to assistive technology.
		const summary = canvas.getByTestId("citation-structure-summary");
		await expect(summary).toHaveTextContent("Brand ARAG: 73 occurrences, 100%");
		// Percentages go through toLocaleString, so the decimal separator follows the browser locale.
		await expect(summary).toHaveTextContent(/Hostname www\.arag\.de: 53 occurrences, 72[.,]6%/);
		await expect(summary).toHaveTextContent(/Path www\.arag\.de\/rechtsschutzversicherung: 24 occurrences, 32[.,]9%/);
		await expect(canvasElement.querySelector(".recharts-surface")).toHaveAttribute("role", "application");
		await expect(canvasElement.querySelector(".recharts-surface")).toHaveAttribute("tabindex", "0");

		// Hovering a node shows its full label, type, exact count and share.
		const wwwNode = [...nodeLayers(canvasElement)].find(
			(g) => g.querySelector("text")?.textContent === "www.arag.de53",
		);
		await userEvent.hover(wwwNode?.querySelector("path") as SVGPathElement);
		const tooltip = await canvas.findByRole("status");
		await expect(tooltip).toHaveTextContent("www.arag.de");
		await expect(tooltip).toHaveTextContent("Hostname");
		await expect(tooltip).toHaveTextContent(/53 occurrences · 72[.,]6% of owned citations/);
	},
};

export const MultipleDomains: Story = {
	decorators: [
		(Story) => {
			setMockCitationStructure(
				response(
					[
						{ url: "https://www.arag.de/a", count: 30 },
						{ url: "https://www.arag.com/b", count: 20 },
						{ url: "https://www.arag.co.uk/c", count: 10 },
						{ url: "https://shop.arag.es/d", count: 5 },
						{ url: "https://arag.es/", count: 5 },
					],
					["arag.de", "arag.com", "arag.co.uk", "arag.es"],
				),
			);
			return <Story />;
		},
	],
	play: async ({ canvasElement }) => {
		await expectOnlyTheSankey(canvasElement);
		await waitFor(() => expect(nodeLayers(canvasElement).length).toBe(1 + 4 + 5 + 5));
		const domainLabels = [...canvasElement.querySelectorAll("g.recharts-sankey-node[data-depth='1'] text")].map(
			(t) => t.textContent,
		);
		await expect(domainLabels).toEqual(["arag.de30", "arag.com20", "arag.co.uk10", "arag.es10"]);
	},
};

export const RestReduction: Story = {
	decorators: [
		(Story) => {
			setMockCitationStructure(many);
			return <Story />;
		},
	],
	play: async ({ canvasElement }) => {
		await expectOnlyTheSankey(canvasElement);
		const canvas = within(canvasElement);
		await waitFor(() => expect(nodeLayers(canvasElement).length).toBe(many.nodes.length));
		const restNodes = many.nodes.filter((n) => n.kind === "rest");
		await expect(restNodes.length).toBeGreaterThan(0);
		await expect(many.nodes.filter((n) => n.kind === "domain")).toHaveLength(8);
		await expect(many.nodes.filter((n) => n.kind === "path").length).toBeLessThanOrEqual(60);

		// The remainder nodes carry both the folded occurrences and how many children were folded.
		const otherDomains = many.nodes.find((n) => n.id.startsWith("other-domains:")) as (typeof many.nodes)[number];
		const layer = [...nodeLayers(canvasElement)].find((g) =>
			g.querySelector("title")?.textContent?.startsWith("Grouped remainder Other owned domains:"),
		);
		await userEvent.hover(layer?.querySelector("path") as SVGPathElement);
		const tooltip = await canvas.findByRole("status");
		await expect(tooltip).toHaveTextContent("Other owned domains");
		await expect(tooltip).toHaveTextContent(
			new RegExp(`${otherDomains.value.toLocaleString().replace(/[.,]/g, "[.,]")} occurrences across 3 domains`),
		);
	},
};

export const LongLabels: Story = {
	decorators: [
		(Story) => {
			setMockCitationStructure(longLabels);
			return <Story />;
		},
	],
	play: async ({ canvasElement }) => {
		await expectOnlyTheSankey(canvasElement);
		const canvas = within(canvasElement);
		await waitFor(() => expect(nodeLayers(canvasElement).length).toBe(longLabels.nodes.length));
		// The visible label is ellipsized; the accessible summary keeps the whole path.
		const labels = [...nodeLayers(canvasElement)].map((g) => g.querySelector("text")?.textContent ?? "");
		await expect(labels.some((label) => label.includes("…"))).toBe(true);
		await expect(canvas.getByTestId("citation-structure-summary")).toHaveTextContent(
			"/rechtsschutzversicherung/privat-rechtsschutz/vergleich-der-tarife-fuer-familien-und-singles/2026: 12 occurrences",
		);
	},
};

export const Empty: Story = {
	decorators: [
		(Story) => {
			setMockCitationStructure(response([{ url: "https://reddit.com/r/x", count: 9 }]));
			return <Story />;
		},
	],
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await expect(await canvas.findByText(/No citations of your own domains yet/)).toBeInTheDocument();
		await expect(canvas.queryByTestId("citation-structure-sankey")).toBeNull();
	},
};

export const Unconfigured: Story = {
	decorators: [
		(Story) => {
			setMockCitationStructure(response([], [], { ownedDomainCount: 0 }));
			return <Story />;
		},
	],
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await expect(await canvas.findByText(/No owned domain is configured/)).toBeInTheDocument();
		await expect(canvas.getByText("Brand settings")).toBeInTheDocument();
		await expect(canvas.queryByTestId("citation-structure-sankey")).toBeNull();
	},
};

export const Loading: Story = {
	decorators: [
		(Story) => {
			setMockCitationStructure(() => new Promise(() => {}));
			return <Story />;
		},
	],
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await expect(await canvas.findByTestId("citation-structure-loading")).toBeInTheDocument();
		await expect(canvas.queryByTestId("citation-structure-sankey")).toBeNull();
		await expect(canvasElement.querySelectorAll("[data-slot=card]")).toHaveLength(0);
	},
};

export const LoadError: Story = {
	decorators: [
		(Story) => {
			setMockCitationStructure(() => Promise.reject(new globalThis.Error("boom")));
			return <Story />;
		},
	],
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const alert = await canvas.findByRole("alert");
		await expect(alert).toHaveTextContent("Failed to load the citation structure. Please try again.");
		await expect(alert).not.toHaveTextContent("boom");
		await expect(within(alert).getByRole("button", { name: "Retry" })).toBeInTheDocument();
		await expect(canvas.queryByTestId("citation-structure-sankey")).toBeNull();
	},
};

export const Dark: Story = {
	parameters: { dark: true },
	decorators: [
		(Story) => {
			setMockCitationStructure(aragLike);
			return <Story />;
		},
	],
	play: async ({ canvasElement }) => {
		await expectOnlyTheSankey(canvasElement);
		await waitFor(() => expect(nodeLayers(canvasElement).length).toBe(aragLike.nodes.length));
		// The dark palette resolves through the chart's own CSS variables.
		const brandRect = canvasElement.querySelector("g.recharts-sankey-node[data-depth='0'] path") as SVGPathElement;
		await expect(getComputedStyle(brandRect).fill).toBe("rgb(96, 165, 250)");
	},
};

export const Narrow: Story = {
	decorators: [
		(Story) => {
			setMockCitationStructure(aragLike);
			return (
				<div style={{ width: 375 }}>
					<Story />
				</div>
			);
		},
	],
	play: async ({ canvasElement }) => {
		await expectOnlyTheSankey(canvasElement);
		await waitFor(() => expect(nodeLayers(canvasElement).length).toBe(aragLike.nodes.length));
		// Four columns never get crushed: the canvas keeps its minimum width and scrolls horizontally.
		const scroller = canvasElement.querySelector(
			"[data-testid=citation-structure-sankey] .overflow-x-auto",
		) as HTMLElement;
		await expect(scroller.scrollWidth).toBeGreaterThan(scroller.clientWidth);
		await expect(scroller.scrollWidth).toBeGreaterThanOrEqual(880);
	},
};
