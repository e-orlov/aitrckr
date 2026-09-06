import type { Meta, StoryObj } from "@storybook/react";
import { SidebarInset, SidebarProvider } from "@workspace/ui/components/sidebar";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { PromptsEditor } from "@/components/prompts-editor";
import { mockPromptSave } from "./_mocks/server-prompts";

const prompts = Array.from({ length: 24 }, (_, i) => ({
	id: `prompt-${i}`,
	value: `What are the best AI visibility tools for ${["agencies", "startups", "enterprises", "ecommerce"][i % 4]}? (${i + 1})`,
	enabled: i % 5 !== 0,
	tags: i % 3 === 0 ? ["comparison"] : [],
	systemTags: i % 2 === 0 ? ["unbranded"] : ["branded"],
}));

const meta = {
	title: "Pages/PromptsEditor",
	component: PromptsEditor,
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
} satisfies Meta<typeof PromptsEditor>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
	args: {
		initialPrompts: prompts,
		brandId: "mock-brand-id",
		pageTitle: "Prompts",
		pageDescription: "Add, edit, or remove your brand tracking keywords and prompts",
	},
};

/**
 * The server rejects the save with a database error whose message carries the
 * SQL and the parameters (the shape Drizzle produces). The user must see only
 * the safe save message, keep their unsaved edits, and be able to save again.
 */
export const SaveFailureShowsSafeMessage: Story = {
	args: {
		initialPrompts: prompts.slice(0, 3),
		brandId: "mock-brand-id",
		pageTitle: "Prompts",
		pageDescription: "Add, edit, or remove your brand tracking keywords and prompts",
	},
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

		// The fault was one-shot; the retry goes through and the bar clears.
		await userEvent.click(await canvas.findByRole("button", { name: /save changes/i }));
		await waitFor(() => expect(canvas.queryByText("Unsaved changes")).toBeNull());
	},
};
