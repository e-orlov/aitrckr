import type { Meta, StoryObj } from "@storybook/react";
import { expect, userEvent, waitFor, within } from "storybook/test";
import {
	CompetitiveVisibilityCards,
	CompetitiveVisibilityError,
	CompetitiveVisibilitySkeleton,
} from "@/components/competitive-visibility/section";
import { BRAND_SERIES_KEY } from "@/lib/competitive-visibility";
import { BRAND_COLOR, COMPETITOR_PALETTE, OTHERS_COLOR } from "@/lib/share-of-voice-palette";
import {
	DATES_20,
	DATES_32,
	LONG_NAME,
	mockCompetitiveVisibility,
	mockCompetitiveVisibilityBrandOnly,
	mockCompetitiveVisibilityEdge,
	mockCompetitiveVisibilityEmpty,
	mockCompetitiveVisibilitySparse,
} from "./competitive-visibility-fixtures";

const meta = {
	title: "Components/Competitive Visibility",
	component: CompetitiveVisibilityCards,
	decorators: [
		(Story) => (
			<div className="bg-background text-foreground p-6" style={{ width: 1200 }}>
				<Story />
			</div>
		),
	],
} satisfies Meta<typeof CompetitiveVisibilityCards>;

export default meta;
type Story = StoryObj<typeof meta>;

const hexToRgb = (hex: string) => {
	const n = Number.parseInt(hex.slice(1), 16);
	return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
};
const longDate = (iso: string) => {
	const [y, m, d] = iso.split("-").map(Number);
	return new Date(y, m - 1, d).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
};

const q = (root: HTMLElement, testId: string) => root.querySelector(`[data-testid=${testId}]`) as HTMLElement;

/** Wait for Recharts to lay the trend lines out and finish the entrance animation. */
async function trendLines(root: HTMLElement, expected: number) {
	const trend = () => q(root, "competitive-visibility-trend");
	const all = () => [...trend().querySelectorAll<SVGPathElement>("path.recharts-line-curve")];
	await waitFor(() => expect(all()).toHaveLength(expected));
	await waitFor(() => expect(all().every((p) => !p.getAttribute("stroke-dasharray"))).toBe(true), { timeout: 5000 });
	return all();
}

function plotRect(trend: HTMLElement) {
	const surface = trend.querySelector("svg.recharts-surface") as SVGSVGElement;
	const rect = surface.getBoundingClientRect();
	const grid = [...trend.querySelectorAll<SVGLineElement>(".recharts-cartesian-grid-horizontal line")];
	return {
		left: rect.left + Number(grid[0].getAttribute("x1")),
		right: rect.left + Number(grid[0].getAttribute("x2")),
		top: rect.top + Math.min(...grid.map((l) => Number(l.getAttribute("y1")))),
	};
}
async function hoverTrend(root: HTMLElement, fraction: number) {
	const trend = q(root, "competitive-visibility-trend");
	const wrapper = trend.querySelector(".recharts-wrapper") as HTMLElement;
	const plot = plotRect(trend);
	await userEvent.pointer([
		{ target: wrapper, coords: { clientX: plot.left + (plot.right - plot.left) * fraction, clientY: plot.top + 2 } },
	]);
}
function trendTooltipRows(root: HTMLElement): Array<[string, string]> {
	const tooltip = root.querySelector("[data-testid=competitive-visibility-trend-tooltip]");
	return [...(tooltip?.querySelectorAll("[data-series]") ?? [])].map((row) => {
		const spans = row.querySelectorAll("span");
		return [spans[1].textContent ?? "", spans[2].textContent ?? ""];
	});
}
const trendTooltipDate = (root: HTMLElement) =>
	root.querySelector("[data-testid=competitive-visibility-trend-tooltip] > div")?.textContent ?? "";

function leaderboardRows(root: HTMLElement) {
	const table = q(root, "competitive-visibility-leaderboard");
	return [...table.querySelectorAll("tbody tr")].map((tr) => {
		const cells = [...tr.querySelectorAll("td")];
		return {
			rank: cells[0].textContent ?? "",
			name: (cells[1].querySelector("span[title]") as HTMLElement).textContent ?? "",
			you: cells[1].textContent?.includes("You") ?? false,
			visibility: (cells[2].querySelector("span") as HTMLElement).textContent ?? "",
			barWidth: (cells[2].querySelector("[data-testid=visibility-bar-fill]") as HTMLElement).style.width,
			barColor: (cells[2].querySelector("[data-testid=visibility-bar-fill]") as HTMLElement).style.backgroundColor,
			visiblePrompts: (cells[3].textContent ?? "").replace(/\s+/g, " ").trim(),
			evaluated: cells[4].textContent ?? "",
		};
	});
}

const pct = (v: number | null) => (v === null ? "—" : `${Math.round(v)}%`);

export const Default: Story = {
	args: { data: mockCompetitiveVisibility },
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const data = mockCompetitiveVisibility;
		const own = data.entities.find((e) => e.isBrand);
		if (!own) throw new Error("fixture has no brand");

		// Three headings, the headline is the brand's canonical value with real denominators.
		await expect(canvas.getByText("AI Visibility")).toBeInTheDocument();
		await expect(canvas.getByText("Visibility Trends")).toBeInTheDocument();
		await expect(canvas.getByText("Visibility Leaderboard")).toBeInTheDocument();
		await expect(q(canvasElement, "competitive-visibility-headline")).toHaveTextContent("46%");
		await expect(
			canvas.getByText(
				/Acme is mentioned in 19 of 41 eligible runs across 33 evaluated prompts as of September 6, 2026\./,
			),
		).toBeInTheDocument();
		await expect(canvas.getByText(/945 citations in this period · top 6 of 8 competitors shown/)).toBeInTheDocument();

		// Radial: one ring per shown entity over a full background track — independent scales, no donut slices.
		const radial = q(canvasElement, "competitive-visibility-radial");
		await waitFor(() => expect(radial.querySelectorAll(".recharts-radial-bar-background-sector")).toHaveLength(7));
		await expect(radial.querySelectorAll(".recharts-radial-bar-sector")).toHaveLength(7);
		await expect(radial.querySelectorAll(".recharts-pie, .recharts-pie-sector")).toHaveLength(0);
		const radialLegend = within(radial).getByRole("list", { name: "Brands" });
		const legendItems = within(radialLegend).getAllByRole("listitem");
		await expect(legendItems).toHaveLength(7);
		await expect(legendItems[0]).toHaveTextContent("Acme");
		await expect(legendItems[0]).toHaveTextContent("You");
		await expect(legendItems[0]).toHaveTextContent("46%");
		const legendValues = legendItems.map((li) => Number((li.textContent?.match(/(\d+)%$/) ?? [])[1]));
		await expect(legendValues.reduce((s, v) => s + v, 0)).toBeGreaterThan(100);
		await expect(radial.querySelector("[role=img]")).toHaveAttribute("aria-label", expect.stringContaining("Acme 46%"));

		// Leaderboard: every tracked competitor, ranked, absolute bars, coverage as one group.
		const rows = leaderboardRows(canvasElement);
		await expect(rows).toHaveLength(9);
		await expect(rows.map((r) => r.rank)).toEqual(["1", "2", "3", "4", "5", "6", "7", "8", "9"]);
		const acme = rows.find((r) => r.name === "Acme");
		await expect(acme).toMatchObject({ you: true, visibility: "46%", visiblePrompts: "14 (42%)", evaluated: "33" });
		await expect(Number.parseFloat(acme?.barWidth ?? "")).toBeCloseTo(own.visibility as number, 2);
		await expect(rows.filter((r) => r.you)).toHaveLength(1);
		for (const [i, row] of rows.entries()) {
			const entity = data.entities[i];
			await expect(row.name).toBe(entity.name);
			await expect(row.visibility).toBe(pct(entity.visibility));
			await expect(Number.parseFloat(row.barWidth)).toBeCloseTo(entity.visibility as number, 2);
			await expect(row.evaluated).toBe("33");
		}
		// Bars are not scaled to the leader: the top row is not 100% wide.
		await expect(rows[0].barWidth).not.toBe("100%");
		const tyrell = rows.find((r) => r.name === "Tyrell");
		await expect(tyrell).toMatchObject({ visibility: "0%", barWidth: "0%", visiblePrompts: "0 (0%)" });
		// Colour follows the trend roster; rows outside the Top 6 are grey.
		await expect(acme?.barColor).toBe(hexToRgb(BRAND_COLOR));
		const competitorsInOrder = data.series.slice(1).map((s) => s.name);
		for (const [i, name] of competitorsInOrder.entries()) {
			await expect(rows.find((r) => r.name === name)?.barColor).toBe(hexToRgb(COMPETITOR_PALETTE[i]));
		}
		for (const row of rows.filter((r) => !r.you && !competitorsInOrder.includes(r.name))) {
			await expect(row.barColor).toBe(hexToRgb(OTHERS_COLOR));
		}

		// Trend: brand + six, brand first and emphasised, fixed 0–100 axis, same colours as the leaderboard.
		const paths = await trendLines(canvasElement, 7);
		await expect(paths[0].getAttribute("stroke")).toBe(BRAND_COLOR);
		await expect(Number(paths[0].getAttribute("stroke-width"))).toBeGreaterThan(
			Number(paths[1].getAttribute("stroke-width")),
		);
		for (const [i, p] of paths.slice(1).entries()) await expect(p.getAttribute("stroke")).toBe(COMPETITOR_PALETTE[i]);
		// Five tick groups for the fixed 0/25/50/75/100 axis (their labels are asserted with real CSS in the E2E spec).
		await waitFor(() =>
			expect(
				q(canvasElement, "competitive-visibility-trend").querySelectorAll(
					".recharts-yAxis .recharts-cartesian-axis-tick",
				),
			).toHaveLength(5),
		);
		const seriesLegend = within(q(canvasElement, "competitive-visibility-trend")).getByRole("list", { name: "Series" });
		const buttons = within(seriesLegend).getAllByRole("button");
		await expect(buttons.map((b) => b.textContent)).toEqual(["Acme (You)", ...competitorsInOrder]);
		await expect(buttons.some((b) => /others/i.test(b.textContent ?? ""))).toBe(false);

		// One shared tooltip: full date, all series in fixed order, once-rounded values that match the leaderboard on the last day.
		await hoverTrend(canvasElement, 1);
		await waitFor(() => expect(trendTooltipRows(canvasElement)).toHaveLength(7));
		await expect(trendTooltipDate(canvasElement)).toBe(longDate(DATES_32[31]));
		await expect(trendTooltipRows(canvasElement)).toEqual(
			data.series.map((s) => [s.name, pct(data.entities.find((e) => e.key === s.key)?.visibility ?? null)]),
		);
		await hoverTrend(canvasElement, 0);
		await waitFor(() => expect(trendTooltipDate(canvasElement)).toBe(longDate(DATES_32[0])));
		await expect(trendTooltipRows(canvasElement)[0]).toEqual([
			"Acme",
			pct(data.points[0].visibility[BRAND_SERIES_KEY]),
		]);
		await hoverTrend(canvasElement, 15 / 31);
		await waitFor(() => expect(trendTooltipDate(canvasElement)).toBe(longDate(DATES_32[15])));
		await expect(trendTooltipRows(canvasElement)).toHaveLength(7);
	},
};

export const LegendToggle: Story = {
	args: { data: mockCompetitiveVisibility },
	play: async ({ canvasElement }) => {
		await trendLines(canvasElement, 7);
		const legend = within(q(canvasElement, "competitive-visibility-trend")).getByRole("list", { name: "Series" });
		const [brand, first] = within(legend).getAllByRole("button");
		await expect(first).toHaveAttribute("aria-pressed", "true");
		await userEvent.click(first);
		await expect(first).toHaveAttribute("aria-pressed", "false");
		await waitFor(() =>
			expect(
				q(canvasElement, "competitive-visibility-trend").querySelectorAll("path.recharts-line-curve"),
			).toHaveLength(6),
		);
		await hoverTrend(canvasElement, 1);
		await waitFor(() => expect(trendTooltipRows(canvasElement)).toHaveLength(6));
		await expect(trendTooltipRows(canvasElement).map(([name]) => name)).not.toContain(first.textContent);
		// Keyboard: the legend items are real buttons.
		first.focus();
		await userEvent.keyboard("{Enter}");
		await expect(first).toHaveAttribute("aria-pressed", "true");
		await waitFor(() =>
			expect(
				q(canvasElement, "competitive-visibility-trend").querySelectorAll("path.recharts-line-curve"),
			).toHaveLength(7),
		);
		await expect(brand).toHaveTextContent("Acme (You)");
	},
};

export const EdgeValues: Story = {
	args: { data: mockCompetitiveVisibilityEdge },
	play: async ({ canvasElement }) => {
		const rows = leaderboardRows(canvasElement);
		// 100% and 0% are real values, the long name is truncated with a title, and the brand is not pinned first.
		await expect(rows.map((r) => [r.name, r.visibility, r.visiblePrompts])).toEqual([
			[LONG_NAME, "100%", "2 (100%)"],
			["Acme", "50%", "1 (50%)"],
			["Halfway", "50%", "1 (50%)"],
			["Zero Corp", "0%", "0 (0%)"],
		]);
		await expect(rows[0].barWidth).toBe("100%");
		await expect(rows[3].barWidth).toBe("0%");
		await expect(rows.map((r) => r.you)).toEqual([false, true, false, false]);
		const nameCell = canvasElement.querySelector(`[title="${LONG_NAME}"]`) as HTMLElement;
		await expect(nameCell).toHaveClass("truncate");
		await expect(document.documentElement.scrollWidth).toBe(document.documentElement.clientWidth);
		const radial = q(canvasElement, "competitive-visibility-radial");
		// Four tracks; the 0% ring has no filled arc to draw.
		await waitFor(() => expect(radial.querySelectorAll(".recharts-radial-bar-background-sector")).toHaveLength(4));
		await expect(radial.querySelectorAll(".recharts-radial-bar-sector")).toHaveLength(3);
		await expect(q(canvasElement, "competitive-visibility-headline")).toHaveTextContent("50%");
	},
};

export const BrandOnly: Story = {
	args: { data: mockCompetitiveVisibilityBrandOnly },
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await expect(canvas.getByText(/no competitors configured/)).toBeInTheDocument();
		await expect(leaderboardRows(canvasElement)).toHaveLength(1);
		await expect(leaderboardRows(canvasElement)[0]).toMatchObject({
			name: "Acme",
			you: true,
			visibility: "67%",
			visiblePrompts: "2 (100%)",
			evaluated: "2",
		});
		await trendLines(canvasElement, 1);
		const radial = q(canvasElement, "competitive-visibility-radial");
		await waitFor(() => expect(radial.querySelectorAll(".recharts-radial-bar-sector")).toHaveLength(1));
	},
};

export const SparseDays: Story = {
	args: { data: mockCompetitiveVisibilitySparse },
	play: async ({ canvasElement }) => {
		await trendLines(canvasElement, 3);
		// The leading days without a denominator show no rows — never a fake 0% …
		await hoverTrend(canvasElement, 2 / (DATES_20.length - 1));
		await waitFor(() =>
			expect(canvasElement.querySelector("[data-testid=competitive-visibility-trend-tooltip]")).toBeNull(),
		);
		// … while the first day with data does, and the headline is the last non-null point.
		await hoverTrend(canvasElement, 1);
		await waitFor(() => expect(trendTooltipRows(canvasElement)).toHaveLength(3));
		await expect(trendTooltipRows(canvasElement)[0]).toEqual(["Acme", "100%"]);
		await expect(q(canvasElement, "competitive-visibility-headline")).toHaveTextContent("100%");
	},
};

export const Empty: Story = {
	args: { data: mockCompetitiveVisibilityEmpty },
	play: async ({ canvasElement }) => {
		await expect(q(canvasElement, "competitive-visibility-empty")).toHaveTextContent(
			"No visibility data for the selected time range and filters.",
		);
		await expect(canvasElement.querySelector("[data-testid=competitive-visibility-headline]")).toBeNull();
		await expect(canvasElement.textContent).not.toMatch(/NaN|Infinity|0%/);
	},
};

export const Loading: Story = {
	render: () => <CompetitiveVisibilitySkeleton />,
	play: async ({ canvasElement }) => {
		const skeleton = q(canvasElement, "competitive-visibility-loading");
		await expect(skeleton).toHaveAttribute("aria-busy", "true");
		// Reserves the final layout height so the prompt list does not jump.
		await expect(skeleton.getBoundingClientRect().height).toBeGreaterThan(400);
		await expect(canvasElement.textContent).not.toMatch(/%/);
	},
};

export const ErrorState: Story = {
	render: () => <CompetitiveVisibilityError />,
	play: async ({ canvasElement }) => {
		const alert = within(canvasElement).getByRole("alert");
		await expect(alert).toHaveTextContent(/Couldn't load the competitive visibility overview/);
		await expect(alert).toHaveTextContent(/prompt list below is unaffected/);
	},
};

export const Narrow: Story = {
	args: { data: mockCompetitiveVisibility },
	decorators: [
		(Story) => (
			<div className="bg-background text-foreground p-2" style={{ width: 360 }}>
				<Story />
			</div>
		),
	],
	play: async ({ canvasElement }) => {
		await trendLines(canvasElement, 7);
		await expect(document.documentElement.scrollWidth).toBe(document.documentElement.clientWidth);
		const cards = [...canvasElement.querySelectorAll("[data-slot=card]")];
		// Stacked: each card starts below the previous one.
		for (let i = 1; i < cards.length; i++) {
			await expect(cards[i].getBoundingClientRect().top).toBeGreaterThanOrEqual(
				cards[i - 1].getBoundingClientRect().bottom - 1,
			);
		}
		await hoverTrend(canvasElement, 1);
		await waitFor(() => expect(trendTooltipRows(canvasElement)).toHaveLength(7));
		const box = (
			canvasElement.querySelector("[data-testid=competitive-visibility-trend-tooltip]") as HTMLElement
		).getBoundingClientRect();
		await expect(box.right).toBeLessThanOrEqual(document.documentElement.clientWidth);
	},
};

export const DarkTheme: Story = {
	args: { data: mockCompetitiveVisibility },
	decorators: [
		(Story) => (
			<div className="dark bg-background text-foreground p-6" style={{ width: 1200 }}>
				<Story />
			</div>
		),
	],
	play: async ({ canvasElement }) => {
		const paths = await trendLines(canvasElement, 7);
		await expect(paths[0].getAttribute("stroke")).toBe(BRAND_COLOR);
		await expect(q(canvasElement, "competitive-visibility-headline")).toHaveTextContent("46%");
		await hoverTrend(canvasElement, 0.5);
		await waitFor(() => expect(trendTooltipRows(canvasElement)).toHaveLength(7));
	},
};
