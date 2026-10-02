/**
 * The marketing site's wordmark: the navbar and footer marks on every page
 * layout, the typography specimen on the brand page, and the social image.
 * Runs against a live apps/www server (see the `www` project in the config).
 */
import { expect, type Locator, test } from "@playwright/test";

const WORDMARK = "aitrckr";

async function expectWordmark(mark: Locator) {
  await expect(mark).toBeVisible({ timeout: 30_000 });
  await expect(mark).toHaveText(WORDMARK);
  await expect(mark).not.toContainText("elmo");
  // One line, nothing hidden: the rendered box fits the text it contains.
  const fits = await mark.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const fontSize = Number.parseFloat(getComputedStyle(el).fontSize);
    return el.scrollWidth <= el.clientWidth + 1 && r.height < fontSize * 1.6 && r.right <= window.innerWidth;
  });
  expect(fits).toBe(true);
}

for (const viewport of [
  { name: "desktop", width: 1440, height: 900 },
  { name: "mobile", width: 390, height: 844 },
]) {
  test.describe(`${viewport.name} layout`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test("the navbar mark is the wordmark and leads home", async ({ page }) => {
      await page.goto("/pricing");
      const home = page.locator("header").getByRole("link", { name: "Homepage" });
      await expect(home).toHaveAttribute("href", "/");
      await expectWordmark(home.locator("span.font-titan-one"));
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
      expect(overflow).toBe(false);
    });

    test("the footer mark is the wordmark and leads home", async ({ page }) => {
      await page.goto("/");
      const home = page.locator("footer").getByRole("link", { name: "Homepage" });
      await home.scrollIntoViewIfNeeded();
      await expect(home).toHaveAttribute("href", "/");
      await expectWordmark(home.locator("span.font-titan-one"));
    });

    test("the docs layout carries the same navbar mark", async ({ page }) => {
      await page.goto("/docs");
      await expectWordmark(page.locator("header").getByRole("link", { name: "Homepage" }).locator("span.font-titan-one"));
    });
  });
}

test("the brand page's typography specimen shows the wordmark", async ({ page }) => {
  await page.goto("/brand");
  const specimen = page.locator("a[href*='Titan+One'] .font-titan-one");
  await expect(specimen).toHaveText(WORDMARK);
});

test("the social image renders", async ({ request }) => {
  const response = await request.get("/og.png");
  expect(response.status()).toBe(200);
  expect(response.headers()["content-type"]).toContain("image/png");
});
