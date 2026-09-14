/**
 * The product mark every layout renders: the wordmark for a stock deployment,
 * the tenant's icon and name for a whitelabel one.
 */
import type { Meta, StoryObj } from "@storybook/react";
import { DEFAULT_CHART_COLORS } from "@workspace/config/constants";
import { expect, within } from "storybook/test";
import { Logo } from "@/components/logo";
import { type ClientConfig, setMockClientConfig } from "./_mocks/config-client";
import { setMockRouteContext } from "./_mocks/tanstack-router";

const stockConfig: ClientConfig = {
	mode: "local",
	features: { readOnly: false, showOptimizeButton: false, canCreateBrands: true },
	branding: { name: "Elmo", chartColors: DEFAULT_CHART_COLORS.map((c) => c) },
	analytics: {},
};

const whitelabelConfig: ClientConfig = {
	mode: "whitelabel",
	features: { readOnly: false, showOptimizeButton: true, canCreateBrands: false },
	branding: {
		name: "BrandMonitor Pro",
		icon: "https://api.dicebear.com/9.x/shapes/svg?seed=brand",
		parentName: "AgencyCo",
		parentUrl: "https://agency.example.com",
		chartColors: DEFAULT_CHART_COLORS.map((c) => c),
	},
	analytics: {},
};

export default {
	title: "Brand / Logo",
} satisfies Meta;

/** Stock deployments show the wordmark and nothing else. */
export const Wordmark: StoryObj = {
	render: () => {
		setMockClientConfig(stockConfig);
		setMockRouteContext({ clientConfig: stockConfig });
		return <Logo data-testid="logo" />;
	},
	play: async ({ canvasElement }) => {
		const logo = within(canvasElement).getByTestId("logo");
		await expect(logo).toHaveTextContent(/^aitrckr$/);
		await expect(within(logo).queryByText(/elmo/i)).toBeNull();
		await expect(within(logo).queryByRole("img")).toBeNull();
	},
};

/** Whitelabel deployments show the tenant's mark, never the wordmark. */
export const Whitelabel: StoryObj = {
	render: () => {
		setMockClientConfig(whitelabelConfig);
		setMockRouteContext({ clientConfig: whitelabelConfig });
		return <Logo data-testid="logo" />;
	},
	play: async ({ canvasElement }) => {
		const logo = within(canvasElement).getByTestId("logo");
		await expect(within(logo).getByText("BrandMonitor Pro")).toBeInTheDocument();
		await expect(within(logo).getByRole("img", { name: "BrandMonitor Pro logo" })).toBeInTheDocument();
		await expect(within(logo).queryByText("aitrckr")).toBeNull();
	},
};
