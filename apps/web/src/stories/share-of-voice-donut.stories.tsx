import type { Meta, StoryObj } from "@storybook/react";
import { TooltipProvider } from "@workspace/ui/components/tooltip";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { MetricLegend } from "@/components/metric-summary/metric-legend";
import { MetricSummaryCard } from "@/components/metric-summary/metric-summary-card";
import {
	buildShareOfVoiceSlices,
	SHARE_OF_VOICE_DONUT_RADII,
	SHARE_OF_VOICE_DONUT_SIZE,
	ShareOfVoiceDonutChart,
	shareOfVoiceLegendItems,
} from "@/components/share-of-voice-donut";
import { BRAND_COLOR, OTHERS_COLOR } from "@/lib/share-of-voice-palette";
import type { ShareOfVoiceEntry } from "@/server/analysis";
import {
	mockDonutEntriesBrandOnly,
	mockDonutEntriesFewer,
	mockDonutEntriesLongNames,
	mockDonutEntriesWithOthers,
	mockDonutEntriesWithoutOthers,
} from "./analytics-fixtures";

/** The summary card exactly as the Share of Voice page composes it. */
function ShareOfVoiceSummary({ entries }: { entries: ShareOfVoiceEntry[] }) {
	const slices = buildShareOfVoiceSlices(entries);
	const brand = slices.find((s) => s.kind === "brand");
	return (
		<TooltipProvider>
			<MetricSummaryCard
				testId="share-of-voice-summary"
				title="Share of Voice"
				infoContent="Each brand’s share of all brand and competitor mentions."
				value={brand ? `${brand.percent}%` : "—"}
				description={`${entries[0]?.name ?? "Acme"} across 640 runs${entries.length > 1 ? ` and ${entries.length - 1} competitors` : ""}.`}
				visual={slices.length > 0 ? <ShareOfVoiceDonutChart slices={slices} /> : null}
				legend={
					slices.length > 0 ? (
						<MetricLegend
							items={shareOfVoiceLegendItems(slices)}
							ariaLabel="Brands"
							testId="share-of-voice-brand-list"
						/>
					) : null
				}
			/>
		</TooltipProvider>
	);
}

const meta = {
	title: "Components/Share of Voice Donut",
	component: ShareOfVoiceSummary,
	decorators: [
		(Story, { parameters }) => (
			<div
				className={`${parameters.dark ? "dark " : ""}bg-background text-foreground ${parameters.shellWidth ? "p-2" : "p-6"}`}
				style={{ width: parameters.shellWidth ?? 640 }}
			>
				<Story />
			</div>
		),
	],
} satisfies Meta<typeof ShareOfVoiceSummary>;

export default meta;
type Story = StoryObj<typeof meta>;

const hexToRgb = (hex: string) => {
	const n = Number.parseInt(hex.slice(1), 16);
	return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
};

async function sectors(canvasElement: HTMLElement, count: number) {
	await waitFor(() => expect(canvasElement.querySelectorAll(".recharts-pie-sector path")).toHaveLength(count));
	return Array.from(canvasElement.querySelectorAll(".recharts-pie-sector path"));
}
const list = (canvasElement: HTMLElement) => within(canvasElement).getByRole("list", { name: "Brands" });
const rows = (canvasElement: HTMLElement) => within(list(canvasElement)).getAllByRole("listitem");

/** Every row mirrors its sector: name, once-rounded percentage and colour, in canonical order. */
async function expectListMirrorsDonut(canvasElement: HTMLElement, entries: ShareOfVoiceEntry[]) {
	const slices = buildShareOfVoiceSlices(entries);
	const paths = await sectors(canvasElement, slices.length);
	const items = rows(canvasElement);
	await expect(items).toHaveLength(slices.length);
	slices.forEach((s, i) => {
		const row = items[i];
		expect(row.getAttribute("data-entity")).toBe(s.key);
		const spans = row.querySelectorAll("span");
		expect(spans[1]).toHaveTextContent(s.name);
		expect(spans[1].getAttribute("title")).toBe(s.name);
		expect(row.lastElementChild).toHaveTextContent(`${s.percent}%`);
		const dot = spans[0];
		expect(dot.getAttribute("aria-hidden")).toBe("true");
		expect(getComputedStyle(dot).backgroundColor).toBe(hexToRgb(s.color));
		expect(paths[i].getAttribute("fill")).toBe(s.color);
		if (s.kind === "brand") expect(within(row).getByText("You")).toBeInTheDocument();
		else expect(within(row).queryByText("You")).toBeNull();
	});
	// Informational only: no buttons, links or focusable rows, and no Recharts legend.
	expect(list(canvasElement).querySelectorAll("button, a, [tabindex]")).toHaveLength(0);
	expect(canvasElement.querySelectorAll(".recharts-legend-wrapper")).toHaveLength(0);
}

export const Default: Story = {
	args: { entries: mockDonutEntriesWithOthers },
	play: async ({ canvasElement }) => {
		await expectListMirrorsDonut(canvasElement, mockDonutEntriesWithOthers);
		const items = rows(canvasElement);
		await expect(items.map((li) => li.textContent)).toEqual([
			"AcmeYou38%",
			"Globex15%",
			"Initech13%",
			"Umbrella11%",
			"Hooli6%",
			"Vandelay6%",
			"Wonka4%",
			"Others6%",
		]);
		// Independently rounded shares: 99% displayed, not redistributed to 100%.
		const shown = items.map((li) => Number((li.lastElementChild as HTMLElement).textContent?.replace("%", "")));
		await expect(shown.reduce((s, v) => s + v, 0)).toBe(99);
		await expect(items[0].querySelector("span")).toHaveClass("h-3", "w-3");
		await expect(items[1].querySelector("span")).toHaveClass("h-2.5", "w-2.5");
		await expect(items[1].querySelectorAll("span")[1]).toHaveClass("text-muted-foreground");
		await expect(items.at(-1)).toHaveTextContent("Others");
		await expect(getComputedStyle(items.at(-1)?.querySelector("span") as Element).backgroundColor).toBe(
			hexToRgb(OTHERS_COLOR),
		);
		// Shared shell: heading + info tip, value and description before the visual group, chart at the
		// shared 220 px stage with Variant B radii; the geometry is asserted with real CSS in the E2E spec.
		const card = canvasElement.querySelector("[data-testid=share-of-voice-summary]") as HTMLElement;
		await expect(within(card).getByRole("heading", { level: 2, name: /Share of Voice/ })).toBeInTheDocument();
		await expect(within(card).getByRole("button", { name: "About Share of Voice" })).toBeInTheDocument();
		const group = card.querySelector("[data-slot=metric-visual-group]") as HTMLElement;
		await expect(group.querySelector("[data-slot=metric-visual] [data-testid=share-of-voice-donut]")).not.toBeNull();
		await expect(group.querySelector("[data-slot=metric-legend] ul")).toBe(list(canvasElement));
		await expect(card.querySelector("[data-slot=metric-summary-meta]")).toBeNull();
		const chart = card.querySelector(".recharts-wrapper") as HTMLElement;
		await expect(chart.style.width).toBe(`${SHARE_OF_VOICE_DONUT_SIZE}px`);
		await expect(SHARE_OF_VOICE_DONUT_RADII).toEqual({ inner: 59, outer: 103 });
		await expect(list(canvasElement)).toHaveClass("min-w-0", "grid", "gap-1", "text-xs");
		await expect(items[0].querySelectorAll("span")[1]).toHaveClass("font-medium", "truncate");
		await expect(items[0].lastElementChild).toHaveClass("ml-auto", "font-mono", "tabular-nums");
	},
};

export const RoundedTotalNotEqualTo100: Story = {
	args: { entries: mockDonutEntriesWithoutOthers },
	play: async ({ canvasElement }) => {
		await expectListMirrorsDonut(canvasElement, mockDonutEntriesWithoutOthers);
		const shown = rows(canvasElement).map((li) =>
			Number((li.lastElementChild as HTMLElement).textContent?.replace("%", "")),
		);
		await expect(shown).toEqual([41, 16, 14, 11, 7, 7, 5]);
		await expect(shown.reduce((s, v) => s + v, 0)).toBe(101);
	},
};

export const WithoutOthers: Story = {
	args: { entries: mockDonutEntriesWithoutOthers },
	play: async ({ canvasElement }) => {
		await expectListMirrorsDonut(canvasElement, mockDonutEntriesWithoutOthers);
		await expect(rows(canvasElement)).toHaveLength(7);
		await expect(within(list(canvasElement)).queryByText("Others")).toBeNull();
	},
};

export const FewerCompetitors: Story = {
	args: { entries: mockDonutEntriesFewer },
	play: async ({ canvasElement }) => {
		await expectListMirrorsDonut(canvasElement, mockDonutEntriesFewer);
		await expect(rows(canvasElement).map((li) => li.textContent)).toEqual(["AcmeYou58%", "Globex23%", "Initech19%"]);
	},
};

export const BrandOnly: Story = {
	args: { entries: mockDonutEntriesBrandOnly },
	play: async ({ canvasElement }) => {
		await expectListMirrorsDonut(canvasElement, mockDonutEntriesBrandOnly);
		await expect(rows(canvasElement).map((li) => li.textContent)).toEqual(["AcmeYou100%"]);
	},
};

export const LongCompetitorNames: Story = {
	args: { entries: mockDonutEntriesLongNames },
	play: async ({ canvasElement }) => {
		await expectListMirrorsDonut(canvasElement, mockDonutEntriesLongNames);
		// Long names truncate inside the row (full name in the title and DOM text); nothing spills out.
		const ul = list(canvasElement);
		await expect(ul.scrollWidth).toBeLessThanOrEqual(ul.clientWidth + 1);
		const card = canvasElement.querySelector("[data-slot=card]") as HTMLElement;
		await expect(card.scrollWidth).toBeLessThanOrEqual(card.clientWidth + 1);
		await expect(document.documentElement.scrollWidth).toBe(document.documentElement.clientWidth);
		for (const row of rows(canvasElement)) {
			const pct = row.lastElementChild as HTMLElement;
			await expect(pct.getBoundingClientRect().right).toBeLessThanOrEqual(ul.getBoundingClientRect().right + 1);
		}
	},
};

export const Empty: Story = {
	args: { entries: [] },
	play: async ({ canvasElement }) => {
		// Nothing was mentioned: neither the donut, the list nor an empty visual group renders
		// (the page shows its empty card instead of this one).
		await expect(canvasElement.querySelectorAll(".recharts-pie")).toHaveLength(0);
		await expect(within(canvasElement).queryByRole("list", { name: "Brands" })).toBeNull();
		await expect(canvasElement.querySelector("[data-testid=share-of-voice-donut]")).toBeNull();
		await expect(canvasElement.querySelector("[data-slot=metric-visual-group]")).toBeNull();
	},
};

export const DonutTooltipStillWorks: Story = {
	args: { entries: mockDonutEntriesWithOthers },
	play: async ({ canvasElement }) => {
		await sectors(canvasElement, 8);
		// Recharts re-keys the sectors on every entrance-animation frame, so wait for the
		// geometry to settle and query the live elements only then.
		const geometry = () =>
			Array.from(canvasElement.querySelectorAll(".recharts-pie-sector path"))
				.map((p) => p.getAttribute("d"))
				.join("|");
		let previous = geometry();
		await waitFor(
			async () => {
				await new Promise((r) => setTimeout(r, 250));
				const current = geometry();
				const settled = current === previous;
				previous = current;
				expect(settled).toBe(true);
			},
			{ timeout: 5000, interval: 50 },
		);
		const hover = async (index: number) => {
			const g = canvasElement.querySelectorAll(".recharts-pie-sector")[index] as HTMLElement;
			const box = g.getBoundingClientRect();
			await userEvent.pointer([
				{ target: g, coords: { clientX: box.left + box.width / 2, clientY: box.top + box.height / 2 } },
			]);
		};
		await hover(0);
		await waitFor(() =>
			expect(canvasElement.querySelector(".recharts-tooltip-wrapper")).toHaveTextContent("Acme: 38%"),
		);
		await hover(7);
		await waitFor(() =>
			expect(canvasElement.querySelector(".recharts-tooltip-wrapper")).toHaveTextContent("Others: 6%"),
		);
	},
};

export const NarrowCard: Story = {
	args: { entries: mockDonutEntriesWithOthers },
	parameters: { shellWidth: 343 },
	play: async ({ canvasElement }) => {
		await expectListMirrorsDonut(canvasElement, mockDonutEntriesWithOthers);
		const card = canvasElement.querySelector("[data-slot=card]") as HTMLElement;
		await expect(card.scrollWidth).toBeLessThanOrEqual(card.clientWidth + 1);
		await expect(document.documentElement.scrollWidth).toBe(document.documentElement.clientWidth);
		// In a narrow card the group switches to a column (container query; real-CSS check in E2E).
		const ul = list(canvasElement).getBoundingClientRect();
		await expect(ul.right).toBeLessThanOrEqual(document.documentElement.clientWidth);
	},
};

export const DarkTheme: Story = {
	args: { entries: mockDonutEntriesWithOthers },
	parameters: { dark: true },
	play: async ({ canvasElement }) => {
		await expectListMirrorsDonut(canvasElement, mockDonutEntriesWithOthers);
		const items = rows(canvasElement);
		// Entity colours are inline and theme-independent; text colours come from the theme tokens
		// (`text-foreground` / `text-muted-foreground`), which the E2E dark-mode check renders for real.
		await expect(getComputedStyle(items[0].querySelector("span") as Element).backgroundColor).toBe(
			hexToRgb(BRAND_COLOR),
		);
		await expect(items[1].querySelectorAll("span")[1]).toHaveClass("text-muted-foreground");
		await expect(canvasElement.closest(".dark") ?? canvasElement.querySelector(".dark")).not.toBeNull();
	},
};
