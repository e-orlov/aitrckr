import { expect, type Page } from "@playwright/test";

/**
 * Opens the account menu reliably: a click that lands before hydration
 * attaches the trigger's handler is silently lost, so re-drive the click
 * until the menu actually opens instead of clicking once and waiting.
 */
export async function openAccountMenu(page: Page): Promise<void> {
	await expect(async () => {
		await page.getByRole("button", { name: "Account and organizations" }).click();
		await expect(page.getByRole("menu")).toBeVisible({ timeout: 2_000 });
	}).toPass({ timeout: 30_000 });
}
