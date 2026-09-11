/**
 * UI-R1 design preview: both summary cards composed with the shared
 * `MetricSummaryCard` shell at identical card widths, with the two donut-size
 * variants under evaluation. Storybook-only until the design gate.
 */
import type { Meta, StoryObj } from "@storybook/react";
import { TooltipProvider } from "@workspace/ui/components/tooltip";
import { expect, waitFor, within } from "storybook/test";
import { formatPct } from "@/components/competitive-visibility/format";
import {
	buildCompetitiveVisibilityRings,
	CompetitiveVisibilityRadialChart,
	competitiveVisibilityLegendItems,
} from "@/components/competitive-visibility/radial";
import { MetricLegend } from "@/components/metric-summary/metric-legend";
import { MetricSummaryCard } from "@/components/metric-summary/metric-summary-card";
import {
	buildShareOfVoiceSlices,
	type DonutRadii,
	ShareOfVoiceDonutChart,
	shareOfVoiceLegendItems,
} from "@/components/share-of-voice-donut";
import { BRAND_SERIES_KEY } from "@/lib/competitive-visibility";
import { mockDonutEntriesWithOthers } from "./analytics-fixtures";
import { mockCompetitiveVisibility } from "./competitive-visibility-fixtures";

const STAGE = 220;
/** Variant A: today's donut geometry centred in the 220 px stage. */
const RADII_A: DonutRadii = { inner: 48, outer: 84 };
/** Variant B: the same ring proportions scaled to the stage (×220/180). */
const RADII_B: DonutRadii = { inner: 59, outer: 103 };

const SOV_TIP =
	"Each brand's share of all brand and competitor mentions in the AI answers to your prompts, counted per run. Shares add up to 100% before rounding.";
const VIS_TIP =
	"Each brand is measured independently: the percentage of eligible AI responses that mention it, from the same responses and the same prompts. The rings share one 0–100% scale and do not add up to 100%.";

function ShareOfVoiceCardPreview({ radii, size = STAGE }: { radii: DonutRadii; size?: number }) {
	const slices = buildShareOfVoiceSlices(mockDonutEntriesWithOthers);
	const brand = slices.find((s) => s.kind === "brand");
	return (
		<MetricSummaryCard
			testId="preview-share-of-voice"
			title="Share of Voice"
			infoContent={SOV_TIP}
			value={brand ? `${brand.percent}%` : "—"}
			description={`Acme across 640 runs and ${mockDonutEntriesWithOthers.length - 1} competitors.`}
			visual={<ShareOfVoiceDonutChart slices={slices} size={size} radii={radii} />}
			legend={<MetricLegend items={shareOfVoiceLegendItems(slices)} ariaLabel="Brands" testId="preview-sov-legend" />}
		/>
	);
}

function VisibilityCardPreview() {
	const data = mockCompetitiveVisibility;
	const rings = buildCompetitiveVisibilityRings(data.series, data.entities);
	const own = data.entities.find((e) => e.key === BRAND_SERIES_KEY);
	return (
		<MetricSummaryCard
			testId="preview-ai-visibility"
			title="AI Visibility"
			infoContent={VIS_TIP}
			value={formatPct(own?.visibility)}
			description={`${data.brand.name} is mentioned in ${own?.mentionedRuns ?? 0} of ${data.snapshotRuns} eligible runs across ${data.evaluatedPromptCount} evaluated prompts as of September 6, 2026.`}
			meta={`${data.windowRuns} runs · ${data.windowCitations} citations in this period · top ${data.series.length - 1} of ${data.entities.length - 1} competitors shown, all in the leaderboard`}
			visual={
				<CompetitiveVisibilityRadialChart
					rings={rings}
					snapshotRuns={data.snapshotRuns}
					evaluatedPromptCount={data.evaluatedPromptCount}
					size={STAGE}
				/>
			}
			legend={
				<MetricLegend items={competitiveVisibilityLegendItems(rings)} ariaLabel="Brands" testId="preview-vis-legend" />
			}
		/>
	);
}

function SideBySide({ radii, cardWidth, dark }: { radii: DonutRadii; cardWidth: number; dark?: boolean }) {
	return (
		<TooltipProvider delay={150}>
			<div className={`${dark ? "dark " : ""}bg-background text-foreground p-6`}>
				<div className="flex flex-wrap items-start gap-6">
					<div style={{ width: cardWidth }}>
						<ShareOfVoiceCardPreview radii={radii} />
					</div>
					<div style={{ width: cardWidth }}>
						<VisibilityCardPreview />
					</div>
				</div>
			</div>
		</TooltipProvider>
	);
}

const meta = {
	title: "Design/UI-R1 Metric Summary Preview",
	component: SideBySide,
	parameters: { layout: "fullscreen" },
} satisfies Meta<typeof SideBySide>;

export default meta;
type Story = StoryObj<typeof meta>;

async function expectSharedStructure(canvasElement: HTMLElement) {
	const canvas = within(canvasElement);
	for (const [testId, legendId, chartSel, rows] of [
		["preview-share-of-voice", "preview-sov-legend", ".recharts-pie-sector path", 8],
		["preview-ai-visibility", "preview-vis-legend", ".recharts-radial-bar-sector", 7],
	] as const) {
		const card = canvas.getByTestId(testId);
		const c = within(card);
		await expect(c.getByRole("heading", { level: 2 })).toBeInTheDocument();
		await expect(c.getByRole("button", { name: /^About / })).toBeInTheDocument();
		const list = c.getByRole("list", { name: "Brands" });
		await expect(list).toHaveAttribute("data-testid", legendId);
		await expect(within(list).getAllByRole("listitem")).toHaveLength(rows);
		await waitFor(() => expect(card.querySelectorAll(chartSel).length).toBeGreaterThanOrEqual(rows - 1));
		// DOM order: value, description before the visual group.
		const value = card.querySelector("[data-slot=metric-summary-value]") as HTMLElement;
		const group = card.querySelector("[data-slot=metric-visual-group]") as HTMLElement;
		await expect(value.compareDocumentPosition(group) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
		await expect(card.querySelectorAll(".recharts-legend-wrapper")).toHaveLength(0);
		await expect(within(list).getAllByText("You")).toHaveLength(1);
	}
	await expect(canvas.getByTestId("preview-share-of-voice").querySelector(".recharts-radial-bar")).toBeNull();
	await expect(canvas.getByTestId("preview-ai-visibility").querySelector(".recharts-pie")).toBeNull();
}

export const SideBySideVariantA: Story = {
	name: "Side by side — Variant A (donut geometry kept, 531 px cards)",
	args: { radii: RADII_A, cardWidth: 531 },
	play: async ({ canvasElement }) => {
		await expectSharedStructure(canvasElement);
		await expect(
			canvasElement.querySelector("[data-testid=preview-share-of-voice] [data-slot=metric-summary-meta]"),
		).toBeNull();
		await expect(
			canvasElement.querySelector("[data-testid=preview-ai-visibility] [data-slot=metric-summary-meta]"),
		).not.toBeNull();
	},
};

export const SideBySideVariantB: Story = {
	name: "Side by side — Variant B (donut scaled to the 220 px stage, 531 px cards)",
	args: { radii: RADII_B, cardWidth: 531 },
	play: async ({ canvasElement }) => {
		await expectSharedStructure(canvasElement);
	},
};

export const NarrowCards: Story = {
	name: "Narrow cards (343 px) — Variant B",
	args: { radii: RADII_B, cardWidth: 343 },
	play: async ({ canvasElement }) => {
		await expectSharedStructure(canvasElement);
	},
};

export const DarkVariantB: Story = {
	name: "Dark — Variant B (531 px cards)",
	args: { radii: RADII_B, cardWidth: 531, dark: true },
	play: async ({ canvasElement }) => {
		await expectSharedStructure(canvasElement);
	},
};
