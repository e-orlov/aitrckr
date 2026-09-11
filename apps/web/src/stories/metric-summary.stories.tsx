/**
 * The shared metric summary primitives on their own: the card shell with every
 * slot, the generic legend's contract, and a synthetic category metric that
 * proves a future non-brand metric can consume the same display contract.
 */
import type { Meta, StoryObj } from "@storybook/react";
import { TooltipProvider } from "@workspace/ui/components/tooltip";
import { expect, userEvent, within } from "storybook/test";
import { MetricLegend, type MetricLegendItem } from "@/components/metric-summary/metric-legend";
import { MetricSummaryCard } from "@/components/metric-summary/metric-summary-card";

const BRAND_ITEMS: readonly MetricLegendItem[] = [
	{ id: "brand:acme", label: "Acme", color: "#2563eb", valueLabel: "38%", emphasis: "primary", badgeLabel: "You" },
	{ id: "competitor:globex", label: "Globex", color: "#10b981", valueLabel: "15%", emphasis: "muted" },
	{ id: "competitor:initech", label: "Initech", color: "#f59e0b", valueLabel: "0%", emphasis: "muted" },
	{ id: "others", label: "Others", color: "#cbd5e1", valueLabel: "100%", emphasis: "muted" },
];

/**
 * Layout contract only — not a product decision and not a sentiment formula.
 * Three categories with preformatted, non-percent-shaped values and no badge.
 */
const CATEGORY_ITEMS: readonly MetricLegendItem[] = [
	{ id: "positive", label: "Positive", color: "#10b981", valueLabel: "12 of 20", emphasis: "primary" },
	{ id: "neutral", label: "Neutral", color: "#94a3b8", valueLabel: "5 of 20" },
	{ id: "negative", label: "Negative", color: "#ef4444", valueLabel: "3 of 20", emphasis: "muted" },
];

function CategoryStage() {
	// A neutral placeholder for "the metric's own chart": the shell must not care what it is.
	return (
		<div
			role="img"
			aria-label="Synthetic category chart placeholder"
			className="grid place-items-center rounded-full border-8 border-dashed border-muted text-xs text-muted-foreground"
			style={{ width: 220, height: 220 }}
		>
			chart slot
		</div>
	);
}

const meta = {
	title: "Components/Metric Summary",
	component: MetricSummaryCard,
	decorators: [
		(Story, { parameters }) => (
			<TooltipProvider>
				<div
					className={`${parameters.dark ? "dark " : ""}bg-background text-foreground p-6`}
					style={{ width: parameters.shellWidth ?? 640 }}
				>
					<Story />
				</div>
			</TooltipProvider>
		),
	],
} satisfies Meta<typeof MetricSummaryCard>;

export default meta;
type Story = StoryObj<typeof meta>;

const hexToRgb = (hex: string) => {
	const n = Number.parseInt(hex.slice(1), 16);
	return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
};
const legendRows = (root: HTMLElement, name: string) =>
	within(within(root).getByRole("list", { name })).getAllByRole("listitem");

export const AllSlots: Story = {
	args: {
		testId: "summary",
		title: "Example Metric",
		infoContent: "How this metric is calculated.",
		value: "38%",
		description: "Acme across 640 runs and 9 competitors.",
		meta: "640 runs · 1,200 citations in this period",
		visual: <CategoryStage />,
		legend: <MetricLegend items={BRAND_ITEMS} ariaLabel="Brands" testId="summary-legend" />,
	},
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const card = canvas.getByTestId("summary");
		// One heading with the accessible info affordance.
		await expect(within(card).getAllByRole("heading")).toHaveLength(1);
		await expect(within(card).getByRole("heading", { level: 2, name: /Example Metric/ })).toBeInTheDocument();
		const info = within(card).getByRole("button", { name: "About Example Metric" });
		await userEvent.hover(info);
		// The tooltip renders in a portal at the document root.
		await expect(await within(document.body).findByText("How this metric is calculated.")).toBeInTheDocument();
		await userEvent.unhover(info);
		// Slot order in the DOM: value → description → meta → visual group.
		const order = Array.from(card.querySelectorAll("[data-slot]")).map((el) => el.getAttribute("data-slot"));
		const idx = (slot: string) => order.indexOf(slot);
		await expect(idx("metric-summary-value")).toBeLessThan(idx("metric-summary-meta"));
		await expect(idx("metric-summary-meta")).toBeLessThan(idx("metric-visual-group"));
		await expect(idx("metric-visual")).toBeLessThan(idx("metric-legend"));
		await expect(card.querySelector("[data-slot=metric-summary-meta]")).toHaveTextContent("640 runs · 1,200 citations");
		await expect(within(card).getByRole("img", { name: /placeholder/ })).toBeInTheDocument();
		await expect(legendRows(card, "Brands")).toHaveLength(4);
		await expect(card.querySelectorAll(".recharts-legend-wrapper")).toHaveLength(0);
	},
};

export const WithoutMeta: Story = {
	args: { ...AllSlots.args, meta: undefined },
	play: async ({ canvasElement }) => {
		const card = within(canvasElement).getByTestId("summary");
		await expect(card.querySelector("[data-slot=metric-summary-meta]")).toBeNull();
		// No empty paragraph is reserved: the text block has exactly value + description.
		await expect(card.querySelectorAll("[data-slot=metric-summary-text] > *")).toHaveLength(2);
	},
};

export const LegendContract: Story = {
	name: "Legend contract (order, values, emphasis, badge, a11y)",
	args: { ...AllSlots.args, meta: undefined },
	play: async ({ canvasElement }) => {
		const card = within(canvasElement).getByTestId("summary");
		const list = within(card).getByRole("list", { name: "Brands" });
		await expect(list.tagName).toBe("UL");
		await expect(list).toHaveAttribute("data-testid", "summary-legend");
		const rows = legendRows(card, "Brands");
		// Exactly the caller's order and ids — nothing sorted, grouped or dropped (the 0% and 100% rows stay).
		await expect(rows.map((li) => li.getAttribute("data-entity"))).toEqual(BRAND_ITEMS.map((i) => i.id));
		await expect(rows.map((li) => li.textContent)).toEqual(["AcmeYou38%", "Globex15%", "Initech0%", "Others100%"]);
		// Display-ready values are rendered verbatim: no extra percent sign, no rounding.
		await expect(rows.map((li) => (li.lastElementChild as HTMLElement).textContent)).toEqual(
			BRAND_ITEMS.map((i) => i.valueLabel),
		);
		for (const [i, li] of rows.entries()) {
			const spans = li.querySelectorAll("span");
			await expect(spans[0]).toHaveAttribute("aria-hidden", "true");
			await expect(getComputedStyle(spans[0]).backgroundColor).toBe(hexToRgb(BRAND_ITEMS[i].color));
			await expect(spans[1]).toHaveAttribute("title", BRAND_ITEMS[i].label);
			await expect(spans[1]).toHaveClass("truncate");
			await expect(li.lastElementChild).toHaveClass("ml-auto", "whitespace-nowrap", "tabular-nums");
		}
		// Emphasis and badge come only from the caller.
		await expect(rows[0].querySelectorAll("span")[0]).toHaveClass("h-3", "w-3");
		await expect(rows[0].querySelectorAll("span")[1]).toHaveClass("font-medium");
		await expect(within(rows[0]).getByText("You")).toBeInTheDocument();
		await expect(rows[1].querySelectorAll("span")[0]).toHaveClass("h-2.5", "w-2.5");
		await expect(rows[1].querySelectorAll("span")[1]).toHaveClass("text-muted-foreground");
		await expect(within(rows[1]).queryByText("You")).toBeNull();
		await expect(within(rows[3]).queryByText("You")).toBeNull();
		// Informational: no interactive elements or tab stops inside the list.
		await expect(list.querySelectorAll("button, a, [tabindex]")).toHaveLength(0);
	},
};

const LONG: readonly MetricLegendItem[] = [
	{
		id: "brand",
		label: "Württembergische Gemeinde-Versicherung Rechtsschutz AG & Co. KGaA",
		color: "#2563eb",
		valueLabel: "38%",
		emphasis: "primary",
		badgeLabel: "You",
	},
	{
		id: "c1",
		label: "Ärzte­versicherung Österreich — Rechtsschutz für Ärztinnen und Ärzte",
		color: "#10b981",
		valueLabel: "15%",
		emphasis: "muted",
	},
	{ id: "c2", label: "株式会社ロングネームテスト保険", color: "#f59e0b", valueLabel: "7%", emphasis: "muted" },
	// Duplicate visible label with a distinct id: both rows must render.
	{ id: "c3a", label: "Same Name", color: "#8b5cf6", valueLabel: "3%", emphasis: "muted" },
	{ id: "c3b", label: "Same Name", color: "#ec4899", valueLabel: "2%", emphasis: "muted" },
];

export const LongAndUnicodeLabels: Story = {
	args: { ...AllSlots.args, meta: undefined, legend: <MetricLegend items={LONG} ariaLabel="Brands" /> },
	parameters: { shellWidth: 420 },
	play: async ({ canvasElement }) => {
		const card = within(canvasElement).getByTestId("summary");
		const rows = legendRows(card, "Brands");
		await expect(rows).toHaveLength(5);
		await expect(rows.map((li) => li.getAttribute("data-entity"))).toEqual(LONG.map((i) => i.id));
		await expect(rows[0].querySelectorAll("span")[1]).toHaveAttribute("title", LONG[0].label);
		await expect(rows[0].querySelectorAll("span")[1]).toHaveTextContent(LONG[0].label);
		await expect(card.scrollWidth).toBeLessThanOrEqual(card.clientWidth + 1);
		await expect(document.documentElement.scrollWidth).toBe(document.documentElement.clientWidth);
	},
};

export const CategoryMetricContract: Story = {
	name: "Synthetic category metric (Sentiment-readiness layout contract)",
	args: {
		testId: "category",
		title: "Example Category Metric",
		infoContent:
			"Synthetic fixture: proves the shell and legend do not assume brands. Not a product decision or formula.",
		value: "60%",
		description: "12 of 20 answers were classified in the primary category.",
		visual: <CategoryStage />,
		legend: <MetricLegend items={CATEGORY_ITEMS} ariaLabel="Categories" testId="category-legend" />,
	},
	play: async ({ canvasElement }) => {
		const card = within(canvasElement).getByTestId("category");
		const rows = legendRows(card, "Categories");
		await expect(rows).toHaveLength(3);
		await expect(rows.map((li) => li.textContent)).toEqual(["Positive12 of 20", "Neutral5 of 20", "Negative3 of 20"]);
		// No brand assumptions: no You badge, no "%" appended, three category colours, meta absent.
		await expect(within(card).queryByText("You")).toBeNull();
		await expect(rows.every((li) => !(li.lastElementChild as HTMLElement).textContent?.includes("%"))).toBe(true);
		await expect(rows.map((li) => (li.querySelector("span") as HTMLElement).style.background)).toEqual([
			"rgb(16, 185, 129)",
			"rgb(148, 163, 184)",
			"rgb(239, 68, 68)",
		]);
		await expect(card.querySelector("[data-slot=metric-summary-meta]")).toBeNull();
		// Default emphasis row has neither the primary nor the muted treatment.
		await expect(rows[1].querySelectorAll("span")[1]).not.toHaveClass("font-medium");
		await expect(rows[1].querySelectorAll("span")[1]).not.toHaveClass("text-muted-foreground");
	},
};

export const CategoryMetricWithMetaNarrowDark: Story = {
	name: "Synthetic category metric — meta present, narrow, dark",
	args: { ...CategoryMetricContract.args, meta: "20 answers in this period" },
	parameters: { shellWidth: 343, dark: true },
	play: async ({ canvasElement }) => {
		const card = within(canvasElement).getByTestId("category");
		await expect(card.querySelector("[data-slot=metric-summary-meta]")).toHaveTextContent("20 answers in this period");
		await expect(legendRows(card, "Categories")).toHaveLength(3);
		await expect(card.scrollWidth).toBeLessThanOrEqual(card.clientWidth + 1);
	},
};
