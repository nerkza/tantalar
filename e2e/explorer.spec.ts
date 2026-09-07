import { expect, test } from "@playwright/test";
import { fillSafely, signIn } from "./helpers";
import { BUILT_IN_THEMES } from "../apps/web/src/theme/tokens";

const layoutLabels: Record<string, string> = { details: "Details", list: "List", columns: "Two columns", small: "Small tiles", medium: "Medium tiles", large: "Large tiles" };

test("shared explorer layouts, labels, remote pages and account preferences", async ({ page }) => {
  const items = Array.from({ length: 31 }, (_, index) => ({
    id: `movie-${index}`, fileId: `file-${index}`, itemKey: `movie-${index}`, libraryId: "lib-main",
    title: `Observatory ${String(index + 1).padStart(2, "0")}`, kind: "movie", year: index < 28 ? 2026 : 2001,
    monitored: false, localFileCount: 1, qualityProfile: "1080p", tags: [],
    metadataSnapshot: { rating: 7.5, voteCount: 42, actors: ["Sam Lee"], directors: ["Alex Brown"], genres: ["Drama"], certification: "PG" },
  }));
  let preferences: Record<string, unknown> = {};
  await page.route("**/api/v1/users/*/ui-preferences", async route => {
    if (route.request().method() === "PUT") preferences = { ...preferences, ...route.request().postDataJSON().preferences };
    await route.fulfill({ json: { saved: true, preferences } });
  });
  const facets = { year: ["2001", "2026"], rating: ["7.5"], actors: ["Sam Lee"], directors: ["Alex Brown"], genres: ["Drama"], certification: ["PG"], qualityProfile: ["1080p"] };
  await page.route(/\/api\/v1\/(library(?:\?|$)|acquisition\/managed(?:\?|$))/, async route => {
    const q = new URL(route.request().url()).searchParams;
    let filtered = items.filter(item => (!q.get("search") || item.title.toLowerCase().includes(q.get("search")!.toLowerCase())) && (!q.get("filter_year") || String(item.year) === q.get("filter_year")));
    if (q.get("sort") === "title") filtered.sort((a, b) => a.title.localeCompare(b.title) * (q.get("desc") === "true" ? -1 : 1));
    const total = filtered.length, size = Number(q.get("pageSize") ?? 25), offset = (Number(q.get("page") ?? 1) - 1) * size;
    await route.fulfill({ json: { items: filtered.slice(offset, offset + size), total, facets, tags: [], collections: [], continueWatching: [] } });
  });
  await signIn(page);
  await page.goto("/#/movies");
  const grid = page.getByTestId("catalog-movie-grid");
  await expect(grid.getByText("1–25 of 31", { exact: true })).toBeVisible();
  await grid.getByRole("button", { name: "Next", exact: true }).click();
  await expect(grid.getByText("26–31 of 31", { exact: true })).toBeVisible();
  await grid.getByRole("button", { name: "Filter Year: 2001", exact: true }).first().click();
  await expect(grid.getByText("1–3 of 3", { exact: true })).toBeVisible();
  for (const mode of ["details", "list", "columns", "small", "medium", "large"]) {
    await grid.getByRole("button", { name: `${layoutLabels[mode]} layout`, exact: true }).click();
    await expect(grid.getByRole("button", { name: "Play Observatory 29", exact: true })).toBeVisible();
    await expect(grid.getByRole("button", { name: "Remove Year: 2001 filter", exact: true })).toBeVisible();
    if (!["list", "details"].includes(mode)) {
      await expect(grid.getByRole("button", { name: "Filter Rating: 7.5", exact: true })).toHaveCount(0);
      await expect(grid.getByText("More details", { exact: true })).toHaveCount(0);
    }
  }
  await expect.poll(() => (preferences["collection:catalog-movie-grid"] as { view?: string })?.view).toBe("large");
  await page.reload();
  await expect(grid.getByRole("button", { name: "Large tiles layout", exact: true })).toHaveAttribute("aria-pressed", "true");
  await fillSafely(grid.getByRole("textbox", { name: "Filter Movies", exact: true }), "Observatory 31");
  await expect(grid.getByText("1–1 of 1", { exact: true })).toBeVisible();
  await page.goto("/#/admin/media/managed");
  const managed = page.getByTestId("managed-titles-grid");
  await expect(managed.getByRole("button", { name: "List layout", exact: true })).toHaveAttribute("aria-pressed", "true");
  for (const theme of ["dark", "light", "graphite"]) {
    preferences = { ...preferences, colorScheme: theme === "light" ? "light" : "dark", tokenOverrides: theme === "graphite" ? BUILT_IN_THEMES.find(p => p.id === "graphite")!.tokens : {} };
    await page.reload();
    await expect(managed.getByRole("button", { name: "Edit", exact: true }).first()).toBeVisible();
    for (const width of [390, 1440]) {
      await page.setViewportSize({ width, height: 1000 });
      for (const mode of ["columns", "small", "medium", "large"]) {
        await managed.getByRole("button", { name: `${layoutLabels[mode]} layout`, exact: true }).click();
        await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
        await page.screenshot({ path: `../artifacts/explorer-${theme}-${width}-${mode}.png`, animations: "disabled" });
      }
    }
  }
});
