import type { Meta, StoryObj } from "@storybook/react";
import { SidebarInset, SidebarProvider } from "@workspace/ui/components/sidebar";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { PromptCatalog } from "@/components/prompt-catalog";
import type { PromptCatalogPage } from "@/server/prompt-catalog-load";
import { mockPromptSave } from "./_mocks/server-prompts";

const now = new Date("2026-09-01T00:00:00Z");
const rows: PromptCatalogPage["rows"] = Array.from({ length: 24 }, (_, i) => ({
	id: `prompt-${i}`,
	brandId: "mock-brand-id",
	value: `What are the best AI visibility tools for ${["agencies", "startups", "enterprises", "ecommerce"][i % 4]}? (${i + 1})`,
	enabled: i % 5 !== 0,
	tags: i % 3 === 0 ? ["comparison"] : [],
	systemTags: i % 2 === 0 ? ["unbranded"] : ["branded"],
	premiumModels: [],
	createdAt: now,
	updatedAt: now,
}));

function page(pageRows: PromptCatalogPage["rows"], overrides: Partial<PromptCatalogPage> = {}): PromptCatalogPage {
	return {
		rows: pageRows,
		total: pageRows.length,
		page: 1,
		pageSize: 50,
		totalPages: 1,
		brand: { total: pageRows.length, enabled: pageRows.filter((p) => p.enabled).length },
		tagOptions: ["comparison", "pricing"],
		...overrides,
	};
}

const search = { page: 1, q: "", tag: "", status: "all" as const };

const meta = {
	title: "Pages/PromptCatalog",
	component: PromptCatalog,
	parameters: { layout: "fullscreen" },
	decorators: [
		(Story) => (
			<SidebarProvider>
				<div className="w-64 shrink-0 bg-sidebar" />
				<SidebarInset className="md:border md:border-border/60 md:rounded-xl overflow-clip">
					<header className="bg-background sticky top-0 z-10 flex h-16 shrink-0 items-center gap-2 border-b px-4">
						Mock header
					</header>
					<div className="flex flex-1 flex-col gap-4 p-4 md:gap-6 md:p-6">
						<Story />
					</div>
				</SidebarInset>
			</SidebarProvider>
		),
	],
} satisfies Meta<typeof PromptCatalog>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
	args: { brandId: "mock-brand-id", page: page(rows), search },
};

/** A page deep inside a large catalog: the pager and the brand-wide counter. */
export const PageOfTenThousand: Story = {
	args: {
		brandId: "mock-brand-id",
		page: page(rows, { total: 10_000, page: 137, totalPages: 200, brand: { total: 10_000, enabled: 412 } }),
		search: { ...search, page: 137 },
	},
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await expect(canvas.getByTestId("catalog-range")).toHaveTextContent("Showing 6,801–6,850 of 10,000 prompts");
		await expect(canvas.getByTestId("catalog-capacity")).toHaveTextContent(
			"10,000/10,000 prompts in this brand · 412 enabled",
		);
		await expect(canvas.getByRole("button", { name: /^add prompt$/i })).toBeDisabled();
		await expect(canvas.getByText("Page 137 of 200")).toBeVisible();
	},
};

/**
 * The server rejects the save with a database error whose message carries the
 * SQL and the parameters (the shape Drizzle produces). The user must see only
 * the safe save message, keep their unsaved edits, and be able to save again.
 */
export const SaveFailureShowsSafeMessage: Story = {
	args: { brandId: "mock-brand-id", page: page(rows.slice(0, 3)), search },
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const canary = "F04_R2_SECRET_CANARY";
		mockPromptSave.rejectNextWith = new Error(
			`Failed query: insert into "prompts" ("id", "brand_id", "value", "tags") values (default, $1, $2, $3)\nparams: mock-brand-id,${canary},{secret-tag}`,
		);

		const firstPrompt = (await canvas.findAllByPlaceholderText("Enter prompt text..."))[0];
		await userEvent.type(firstPrompt, " edited");
		const save = await canvas.findByRole("button", { name: /save changes/i });
		await userEvent.click(save);

		const alert = await canvas.findByRole("alert");
		await expect(alert).toHaveTextContent("Failed to save prompts. Your changes were not saved. Please try again.");
		const text = canvasElement.textContent ?? "";
		for (const leak of ["Failed query", "insert into", "params", canary, "secret-tag"]) {
			await expect(text).not.toContain(leak);
		}
		await expect(canvas.getByText("Unsaved changes")).toBeVisible();
		await expect(firstPrompt).toHaveValue(`${rows[0].value} edited`);

		// The fault was one-shot; the retry goes through and the bar clears.
		await userEvent.click(await canvas.findByRole("button", { name: /save changes/i }));
		await waitFor(() => expect(canvas.queryByText("Unsaved changes")).toBeNull());
	},
};
