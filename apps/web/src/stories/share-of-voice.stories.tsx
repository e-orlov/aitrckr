import type { Meta, StoryObj } from "@storybook/react";
import { TooltipProvider } from "@workspace/ui/components/tooltip";
import type { ComponentType, ReactNode } from "react";
import { expect, waitFor, within } from "storybook/test";
import { Route } from "@/routes/_authed/app/org/$org/brand/$brand/share-of-voice";

// The route file exports only `Route` (route files must, for code-splitting).
// Render its component via the route options — the mock exposes `options`.
const ShareOfVoicePage = (Route as unknown as { options: { component: ComponentType } }).options.component;

import { setMockShareOfVoice } from "./_mocks/server-analysis";
import { setMockBrand } from "./_mocks/use-brands";
import { mockShareOfVoice, mockShareOfVoiceTop6Others } from "./analytics-fixtures";

const onboardedBrand = {
	id: "brand-1",
	name: "Acme",
	website: "https://acme.com",
	onboarded: true,
	enabled: true,
	prompts: [{ id: "p1", value: "best crm", enabled: true }],
	effectiveModels: ["gpt-4o", "claude-3-5-sonnet", "gemini-1.5-pro"],
	earliestDataDate: "2026-05-05",
	delayOverrideHours: 24,
};

function Shell({ children }: { children: ReactNode }) {
	return (
		<TooltipProvider>
			<div className="bg-background text-foreground antialiased flex min-h-svh flex-col">
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
	title: "Pages/Share of Voice",
	component: ShareOfVoicePage,
	parameters: { layout: "fullscreen" },
	decorators: [
		(Story) => {
			setMockBrand(onboardedBrand);
			setMockShareOfVoice(mockShareOfVoice);
			return (
				<Shell>
					<Story />
				</Shell>
			);
		},
	],
} satisfies Meta<typeof ShareOfVoicePage>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await expect(await canvas.findByRole("heading", { level: 1, name: /share of voice/i })).toBeInTheDocument();
		// The page keeps its three cards; only the Trends card became a comparison chart.
		await expect(canvas.getByText("Share of Voice Trends")).toBeInTheDocument();
		await expect(canvas.getByText("Share of Voice Leaderboard")).toBeInTheDocument();
		await expect(canvas.getAllByTestId("share-of-voice-trend-chart")).toHaveLength(1);
		await waitFor(() => expect(canvasElement.querySelectorAll("path.recharts-line-curve")).toHaveLength(4));
		await expect(within(canvas.getByRole("list", { name: "Series" })).getAllByRole("listitem")).toHaveLength(4);
	},
};

export const TopSixPlusOthers: Story = {
	decorators: [
		(Story) => {
			setMockShareOfVoice(mockShareOfVoiceTop6Others);
			return <Story />;
		},
	],
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await expect(await canvas.findByRole("heading", { level: 1, name: /share of voice/i })).toBeInTheDocument();
		await waitFor(() => expect(canvasElement.querySelectorAll("path.recharts-line-curve")).toHaveLength(8));
		const legend = within(canvas.getByRole("list", { name: "Series" }))
			.getAllByRole("listitem")
			.map((li) => li.textContent);
		await expect(legend).toEqual(mockShareOfVoiceTop6Others.comparisonTrend.series.map((s) => s.name));

		// Headline and the brand's leaderboard cell agree with the trend's last point.
		const lastBrand = mockShareOfVoiceTop6Others.comparisonTrend.points.at(-1)?.values.brand as number;
		const headline = `${Math.round(lastBrand)}%`;
		await expect(canvas.getByText(headline, { selector: ".text-3xl, .text-3xl *" })).toBeInTheDocument();
		const brandRow = canvas.getAllByRole("row").find((r) => within(r).queryByText("You")) as HTMLElement;
		await expect(brandRow).toHaveTextContent(headline);
	},
};
