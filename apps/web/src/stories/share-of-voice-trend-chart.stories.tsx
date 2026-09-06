import type { Meta, StoryObj } from "@storybook/react";
import { Card, CardContent, CardHeader, CardTitle } from "@workspace/ui/components/card";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { ShareOfVoiceTrendChart } from "@/components/share-of-voice-trend-chart";
import { BRAND_COLOR, COMPETITOR_PALETTE, OTHERS_COLOR } from "@/lib/share-of-voice-palette";
import {
	mockShareOfVoice,
	mockShareOfVoiceTop6Others,
	mockShareOfVoiceWithNullDay,
	TOP6_DATES,
	top6ExpectedRows,
} from "./analytics-fixtures";

const meta = {
	title: "Components/Share of Voice Trend Chart",
	component: ShareOfVoiceTrendChart,
	decorators: [
		(Story) => (
			<div className="bg-background text-foreground p-6" style={{ width: 720 }}>
				<Card>
					<CardHeader>
						<CardTitle>Share of Voice Trends</CardTitle>
					</CardHeader>
					<CardContent>
						<Story />
					</CardContent>
				</Card>
			</div>
		),
	],
} satisfies Meta<typeof ShareOfVoiceTrendChart>;

export default meta;
type Story = StoryObj<typeof meta>;

const hexToRgb = (hex: string) => {
	const n = Number.parseInt(hex.slice(1), 16);
	return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
};

const OTHERS_DASH = "5 4";

/**
 * Wait for Recharts to lay the lines out (ResponsiveContainer measures first)
 * and finish the entrance animation, which draws every line through a
 * temporary stroke-dasharray.
 */
async function lines(canvasElement: HTMLElement, expected: number) {
	const all = () => [...canvasElement.querySelectorAll<SVGPathElement>("path.recharts-line-curve")];
	await waitFor(() => expect(all()).toHaveLength(expected));
	await waitFor(
		() => expect(all().every((p) => [null, "", OTHERS_DASH].includes(p.getAttribute("stroke-dasharray")))).toBe(true),
		{ timeout: 5000 },
	);
	return all();
}

/** Plot rectangle in client coordinates, from the horizontal grid lines' extent. */
function plotRect(canvasElement: HTMLElement) {
	const surface = canvasElement.querySelector("svg.recharts-surface") as SVGSVGElement;
	const grid = canvasElement.querySelector(".recharts-cartesian-grid-horizontal line") as SVGLineElement;
	const rect = surface.getBoundingClientRect();
	const x1 = Number(grid.getAttribute("x1"));
	const x2 = Number(grid.getAttribute("x2"));
	const ys = [...canvasElement.querySelectorAll<SVGLineElement>(".recharts-cartesian-grid-horizontal line")].map((l) =>
		Number(l.getAttribute("y1")),
	);
	return {
		left: rect.left + x1,
		right: rect.left + x2,
		top: rect.top + Math.min(...ys),
		bottom: rect.top + Math.max(...ys),
	};
}

/** Move the pointer to a fraction of the plot width, near the top edge where no line runs. */
async function hoverAt(canvasElement: HTMLElement, fraction: number) {
	const wrapper = canvasElement.querySelector(".recharts-wrapper") as HTMLElement;
	const plot = plotRect(canvasElement);
	const clientX = plot.left + (plot.right - plot.left) * fraction;
	const clientY = plot.top + 2;
	await userEvent.pointer([{ target: wrapper, coords: { clientX, clientY } }]);
	return { clientX, clientY };
}

function tooltipRows(canvasElement: HTMLElement): Array<[string, string]> {
	const tooltip = canvasElement.querySelector("[data-testid=share-of-voice-trend-tooltip]");
	return [...(tooltip?.querySelectorAll("[data-series]") ?? [])].map((row) => {
		const spans = row.querySelectorAll("span");
		return [spans[1].textContent ?? "", spans[2].textContent ?? ""];
	});
}
const tooltipDate = (canvasElement: HTMLElement) =>
	canvasElement.querySelector("[data-testid=share-of-voice-trend-tooltip] > div")?.textContent ?? "";

const longDate = (iso: string) => {
	const [y, m, d] = iso.split("-").map(Number);
	return new Date(y, m - 1, d).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
};

export const ThreeCompetitors: Story = {
	args: { trend: mockShareOfVoice.comparisonTrend },
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const paths = await lines(canvasElement, 4);
		// Unfilled lines only: the brand emphasised, competitors thinner, none dashed.
		await expect(canvasElement.querySelectorAll(".recharts-area, .recharts-area-area")).toHaveLength(0);
		await expect(paths.map((p) => p.getAttribute("fill"))).toEqual(["none", "none", "none", "none"]);
		await expect(paths[0].getAttribute("stroke")).toBe(BRAND_COLOR);
		await expect(Number(paths[0].getAttribute("stroke-width"))).toBeGreaterThan(
			Number(paths[1].getAttribute("stroke-width")),
		);
		await expect(paths.some((p) => p.getAttribute("stroke-dasharray"))).toBe(false);

		const legend = canvas.getByRole("list", { name: "Series" });
		await expect(
			within(legend)
				.getAllByRole("listitem")
				.map((li) => li.textContent),
		).toEqual(["Acme", "Globex", "Initech", "Umbrella"]);
		// Recharts' accessibility layer stays on.
		await expect(canvasElement.querySelector(".recharts-surface")).toHaveAttribute("role", "application");
		await expect(canvasElement.querySelector(".recharts-surface")).toHaveAttribute("tabindex", "0");
		await expect(canvasElement.querySelectorAll(".recharts-legend-wrapper")).toHaveLength(0);
	},
};

export const TopSixPlusOthers: Story = {
	args: { trend: mockShareOfVoiceTop6Others.comparisonTrend },
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const paths = await lines(canvasElement, 8);
		const series = mockShareOfVoiceTop6Others.comparisonTrend.series;

		// Colours follow the frozen rank; Others is grey and dashed.
		await expect(paths[0].getAttribute("stroke")).toBe(BRAND_COLOR);
		for (let k = 0; k < 6; k++) await expect(paths[k + 1].getAttribute("stroke")).toBe(COMPETITOR_PALETTE[k]);
		await expect(paths[7].getAttribute("stroke")).toBe(OTHERS_COLOR);
		await expect(paths[7].getAttribute("stroke-dasharray")).toBe(OTHERS_DASH);
		await expect(paths.slice(0, 7).some((p) => p.getAttribute("stroke-dasharray"))).toBe(false);

		// Legend: same order, colours and a dashed cue for Others; long names truncate visually but keep the full text.
		const legend = canvas.getByRole("list", { name: "Series" });
		const items = within(legend).getAllByRole("listitem");
		await expect(items.map((li) => li.textContent)).toEqual(series.map((s) => s.name));
		await expect(items[7].querySelector("line")).toHaveAttribute("stroke-dasharray");
		await expect(items[1].querySelector("line")).not.toHaveAttribute("stroke-dasharray");
		const longName = items.find((li) => li.textContent?.startsWith("Umbrella Corporation")) as HTMLElement;
		await expect(longName.querySelector("span")).toHaveAttribute("title", longName.textContent ?? "");
		await expect(legend.getBoundingClientRect().top).toBeGreaterThanOrEqual(
			(canvasElement.querySelector(".recharts-wrapper") as HTMLElement).getBoundingClientRect().bottom,
		);

		// Hover far above every line at the first, a middle and the last date.
		const n = TOP6_DATES.length;
		for (const [fraction, index] of [
			[0, 0],
			[7 / (n - 1), 7],
			[1, n - 1],
		] as const) {
			await hoverAt(canvasElement, fraction);
			await waitFor(() => expect(tooltipDate(canvasElement)).toBe(longDate(TOP6_DATES[index])));
			await expect(tooltipRows(canvasElement)).toEqual(top6ExpectedRows(index));
			// Every series gets an active dot at the selected date and one vertical cursor is shown.
			await expect(canvasElement.querySelectorAll(".recharts-active-dot")).toHaveLength(8);
			await expect(canvasElement.querySelectorAll(".recharts-tooltip-cursor")).toHaveLength(1);
		}
		// Zero rows stay visible ("0%") both for a competitor early on and for Others at the end.
		await hoverAt(canvasElement, 0);
		await waitFor(() =>
			expect(tooltipRows(canvasElement).some(([name, v]) => name === "Hooli" && v === "0%")).toBe(true),
		);
		await hoverAt(canvasElement, 1);
		await waitFor(() => expect(tooltipRows(canvasElement).at(-1)).toEqual(["Others", "0%"]));
		// Rows never reorder by value: Globex leads Acme on the last day but Acme is still first.
		await expect(tooltipRows(canvasElement)[0][0]).toBe("Acme");
		await expect(Number.parseInt(tooltipRows(canvasElement)[1][1], 10)).toBeGreaterThan(
			Number.parseInt(tooltipRows(canvasElement)[0][1], 10),
		);
		// The tooltip at the right edge stays inside the viewport and creates no horizontal overflow.
		const tooltip = canvasElement.querySelector("[data-testid=share-of-voice-trend-tooltip]") as HTMLElement;
		const box = tooltip.getBoundingClientRect();
		await expect(box.right).toBeLessThanOrEqual(document.documentElement.clientWidth);
		await expect(box.left).toBeGreaterThanOrEqual(0);
		await expect(document.documentElement.scrollWidth).toBe(document.documentElement.clientWidth);
		// Colour markers match the lines.
		const markers = [...tooltip.querySelectorAll<HTMLElement>("[data-series] > span:first-child")];
		await expect(markers[0].style.background).toBe(hexToRgb(BRAND_COLOR));
		await expect(markers[7].style.background).toBe(hexToRgb(OTHERS_COLOR));
	},
};

export const NarrowCard: Story = {
	args: { trend: mockShareOfVoiceTop6Others.comparisonTrend },
	decorators: [
		(Story) => (
			<div className="bg-background text-foreground p-2" style={{ width: 320 }}>
				<Card>
					<CardContent className="pt-6">
						<Story />
					</CardContent>
				</Card>
			</div>
		),
	],
	play: async ({ canvasElement }) => {
		await lines(canvasElement, 8);
		const legend = canvasElement.querySelector("[data-testid=share-of-voice-trend-legend]") as HTMLElement;
		const wrapper = canvasElement.querySelector(".recharts-wrapper") as HTMLElement;
		// The legend sits below the plot and the plot itself shrinks to the card; the
		// wrapped-legend and no-overflow layout is asserted with real CSS in the E2E spec.
		await expect(legend.getBoundingClientRect().top).toBeGreaterThanOrEqual(wrapper.getBoundingClientRect().bottom);
		await expect(wrapper.getBoundingClientRect().width).toBeLessThanOrEqual(320);
		await expect(document.documentElement.scrollWidth).toBe(document.documentElement.clientWidth);
		await hoverAt(canvasElement, 1);
		await waitFor(() => expect(tooltipRows(canvasElement)).toHaveLength(8));
		const box = (
			canvasElement.querySelector("[data-testid=share-of-voice-trend-tooltip]") as HTMLElement
		).getBoundingClientRect();
		await expect(box.right).toBeLessThanOrEqual(document.documentElement.clientWidth);
		await expect(document.documentElement.scrollWidth).toBe(document.documentElement.clientWidth);
	},
};

export const DarkTheme: Story = {
	args: { trend: mockShareOfVoiceTop6Others.comparisonTrend },
	decorators: [
		(Story) => (
			<div className="dark bg-background text-foreground p-6" style={{ width: 720 }}>
				<Card>
					<CardContent className="pt-6">
						<Story />
					</CardContent>
				</Card>
			</div>
		),
	],
	play: async ({ canvasElement }) => {
		const paths = await lines(canvasElement, 8);
		await expect(paths[0].getAttribute("stroke")).toBe(BRAND_COLOR);
		await hoverAt(canvasElement, 0.5);
		await waitFor(() => expect(tooltipRows(canvasElement)).toHaveLength(8));
	},
};

export const WithNullDay: Story = {
	args: { trend: mockShareOfVoiceWithNullDay.comparisonTrend },
	play: async ({ canvasElement }) => {
		await lines(canvasElement, 4);
		const n = mockShareOfVoiceWithNullDay.comparisonTrend.points.length;
		// The day without a denominator shows no tooltip rows rather than fake zeros …
		await hoverAt(canvasElement, 10 / (n - 1));
		await waitFor(() => expect(canvasElement.querySelector("[data-testid=share-of-voice-trend-tooltip]")).toBeNull());
		// … while its neighbours do, and the lines stay connected across the gap.
		await hoverAt(canvasElement, 11 / (n - 1));
		await waitFor(() => expect(tooltipRows(canvasElement)).toHaveLength(4));
		await expect(tooltipDate(canvasElement)).toBe(
			longDate(mockShareOfVoiceWithNullDay.comparisonTrend.points[11].date),
		);
	},
};

export const BrandOnly: Story = {
	args: {
		trend: {
			series: [{ key: "brand", name: "Acme", kind: "brand" }],
			points: mockShareOfVoice.comparisonTrend.points.map((p) => ({ date: p.date, values: { brand: 100 } })),
		},
	},
	play: async ({ canvasElement }) => {
		await lines(canvasElement, 1);
		await expect(within(canvasElement).getAllByRole("listitem")).toHaveLength(1);
		await hoverAt(canvasElement, 0.5);
		await waitFor(() => expect(tooltipRows(canvasElement)).toEqual([["Acme", "100%"]]));
	},
};

export const Empty: Story = {
	args: { trend: { series: [], points: [] } },
	play: async ({ canvasElement }) => {
		await expect(within(canvasElement).getByText(/no trend data/i)).toBeInTheDocument();
		await expect(canvasElement.querySelectorAll(".recharts-surface")).toHaveLength(0);
	},
};
