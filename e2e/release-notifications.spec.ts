import { expect, test } from "@playwright/test";
import { signIn } from "./helpers";

test("release action feedback stays in notifications on desktop and mobile", async ({ page }) => {
  await page.route("**/api/v1/users/*/ui-preferences", route => route.fulfill({ json: { preferences: {} } }));
  await page.route("**/api/v1/acquisition/managed/movie/movie-notice", route => route.fulfill({ json: {
    item: { id: "movie-notice", kind: "movie", title: "Observatory", year: 2026, monitored: true, episodes: [], tags: [] }, files: [],
  } }));
  await page.route("**/api/v1/acquisition/managed/movie/movie-notice/releases*", route => route.fulfill({ json: {
    releases: [{ releaseId: "fixture", title: "Observatory.2026.1080p", kind: "nzb", sizeBytes: 1024, quality: "1080p", accepted: true, reasons: [], rank: 1 }], failures: [],
  } }));
  let fail = true;
  await page.route("**/api/v1/acquisition/managed/movie/movie-notice/grab", route => route.fulfill({
    status: fail ? 503 : 202,
    json: fail ? { error: "The indexer could not provide the release file." } : { grabbed: true },
  }));
  await signIn(page);
  await page.goto("/#/admin/media/releases/movie/movie-notice");
  const grid = page.getByTestId("releases-grid");
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(grid.getByRole("button", { name: "Grab", exact: true })).toBeVisible();
    await grid.getByRole("button", { name: "Grab", exact: true }).scrollIntoViewIfNeeded();
    const before = await grid.evaluate(element => (element as HTMLElement).offsetTop);
    await grid.getByRole("button", { name: "Grab", exact: true }).click();
    const notice = page.locator("article.tantalar-notice").filter({ hasText: "Download failed" });
    await expect(notice).toHaveAttribute("role", "alert");
    await expect(notice).toContainText("The indexer could not provide the release file.");
    expect(await grid.evaluate(element => (element as HTMLElement).offsetTop)).toBe(before);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: `../artifacts/release-notification-${width}.png`, animations: "disabled" });
    await notice.getByRole("button", { name: "Dismiss Download failed" }).click();
    await expect(notice).toHaveCount(0);
  }
  fail = false;
  await grid.getByRole("button", { name: "Grab", exact: true }).click();
  await expect(page.locator("article.tantalar-notice").filter({ hasText: "Release queued." })).toHaveAttribute("role", "status");
});
