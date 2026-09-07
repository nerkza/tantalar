import { expect, test } from "@playwright/test";
import { fillSafely, signIn } from "./helpers";

test("overview and release search remain usable across widths and themes", async ({ page }) => {
  let scheme = "dark";
  let tags: string[] = [];
  const item = { id: "movie-observatory", kind: "movie", title: "The Last Observatory", year: 2026, overview: "An astronomer returns to a remote observatory to complete an interrupted survey.", monitored: true, qualityProfile: "uhd", episodes: [] };
  await page.route("**/api/v1/users/*/ui-preferences", route => route.fulfill({ json: { preferences: { colorScheme: scheme } } }));
  await page.route("**/api/v1/acquisition/managed/movie/movie-observatory", route => route.fulfill({ json: { item: { ...item, tags }, files: [] } }));
  await page.route("**/api/v1/acquisition/managed/movie/movie-observatory/tags", async route => { tags = route.request().postDataJSON().tags; await route.fulfill({ json: { tags } }); });
  const queries: string[] = [];
  await page.route("**/api/v1/acquisition/managed/movie/movie-observatory/releases?**", route => {
    queries.push(new URL(route.request().url()).searchParams.get("query") ?? "");
    return route.fulfill({ json: { item, failures: [], releases: [{ releaseId: "a".repeat(64), title: "The.Last.Observatory.2026.UHD.BluRay.2160p.DDP.5.1.Atmos.DV.HDR.x265-LongReleaseGroup", kind: "nzb", sizeBytes: 10 * 1024 ** 3, publishedAt: "2026-09-01T12:00:00Z", indexerId: "test", quality: "2160p", accepted: true, reasons: [{ code: "preferred_quality", message: "Quality matches the monitoring profile" }], rank: 0 }] } });
  });
  await page.route("**/api/v1/acquisition/managed/movie/movie-observatory/grab", route => route.fulfill({ status: 503, json: { error: "The download directory has insufficient free space." } }));
  await signIn(page);
  for (const theme of ["dark", "light"]) {
    scheme = theme;
    await page.goto("/#/admin");
    await page.reload();
    await expect(page.getByTestId("control-overview-dashboard")).toBeVisible();
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 1050 });
      await expect(page.locator("main h1")).toHaveCount(1);
      expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
      await page.screenshot({ path: `../artifacts/overview-${theme}-${width}.png`, animations: "disabled", fullPage: true });
    }
    await page.goto("/#/admin/media/releases/movie/movie-observatory");
    await expect(page.getByRole("heading", { name: item.title, exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Grab", exact: true })).toBeEnabled();
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 1050 });
      await expect(page.locator("main h1")).toHaveCount(1);
      expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
      await page.screenshot({ path: `../artifacts/releases-${theme}-${width}.png`, animations: "disabled", fullPage: true });
    }
  }
  await fillSafely(page.getByLabel("Search indexers"), "Observatory extended");
  await expect.poll(() => queries.at(-1)).toBe("Observatory extended");
  await page.getByRole("button", { name: "Grab", exact: true }).click();
  await expect(page.getByText("The download directory has insufficient free space.")).toBeVisible();
  await page.getByText("Tags", { exact: true }).click();
  await fillSafely(page.getByLabel("New tag"), "weekend");
  await page.getByRole("button", { name: "Add tag", exact: true }).click();
  await expect(page.getByRole("button", { name: "Remove tag weekend" })).toBeVisible();
  await page.reload();
  await page.getByText("Tags (1)", { exact: true }).click();
  await expect(page.getByRole("button", { name: "Remove tag weekend" })).toBeVisible();
});
