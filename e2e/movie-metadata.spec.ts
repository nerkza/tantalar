import { expect, test } from "@playwright/test";
import { fillSafely, signIn } from "./helpers";
import { BUILT_IN_THEMES } from "../apps/web/src/theme/tokens";

test("movie cards, details and playback retain metadata across widths and themes", async ({ page }) => {
  const item = {
    fileId: "f-mkv-hevc-dts", itemKey: "mkv-item", title: "The Last Observatory", kind: "movie", libraryId: "lib-main",
    year: 2026, overview: "An astronomer returns to a remote observatory to complete an interrupted survey.",
    metadataSnapshot: {
      kind: "movie", provider: "tmdb", externalId: "tmdb-1", name: "The Last Observatory", year: 2026,
      runtimeMinutes: 101, releaseDate: "2026-08-01", genres: ["Drama", "Mystery"], certification: "PG",
      rating: 7.5, voteCount: 42, status: "Released",
    },
  };
  let scheme = "dark";
  let tokens: Record<string, string> = {};
  await page.route("**/api/v1/users/*/ui-preferences", (route) => route.fulfill({ json: { preferences: { colorScheme: scheme, tokenOverrides: tokens } } }));
  await page.route(url => url.pathname === "/api/v1/library", (route) => route.fulfill({ json: { items: [item], total: 1, collections: [], continueWatching: [] } }));
  await signIn(page);
  for (const theme of ["dark", "light", "preset"]) {
    scheme = theme === "light" ? "light" : "dark";
    tokens = theme === "preset" ? { ...BUILT_IN_THEMES.find((preset) => preset.id === "graphite")!.tokens } : {};
    await page.goto("/#/movies");
    await page.reload();
    await expect(page.getByRole("button", { name: "Play The Last Observatory", exact: true })).toBeVisible();
    for (const width of [390, 1440]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.getByRole("button", { name: "Details for The Last Observatory" }).focus();
      await page.getByRole("button", { name: "Details for The Last Observatory" }).press("Enter");
      const dialog = page.getByRole("dialog");
      await expect(dialog).toHaveCSS("opacity", "1");
      await expect(dialog.getByText("2026 · 101 min · PG")).toBeVisible();
      await expect(dialog.getByText("Drama, Mystery")).toBeVisible();
      await expect(dialog.getByRole("img", { name: "The Last Observatory backdrop unavailable" })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
      await page.screenshot({ path: `../artifacts/movie-metadata-${theme}-${width}.png`, animations: "disabled" });
      await page.keyboard.press("Escape");
      await expect(dialog).not.toBeVisible();
      await expect(page.getByRole("button", { name: "Details for The Last Observatory" })).toBeFocused();
    }
  }
  await page.getByRole("button", { name: "Play The Last Observatory", exact: true }).click();
  await expect(page.getByTestId("player-page")).toBeVisible();
  await expect(page.getByRole("heading", { name: "The Last Observatory" })).toBeVisible();
  await expect(page.getByText("2026 · 101 min", { exact: true })).toBeVisible();
});

test("Control uses the same movie facts in discovery and managed details", async ({ page }) => {
  const item = {
    id: "movie-1", kind: "movie", externalId: "tmdb-1", provider: "tmdb", title: "The Last Observatory",
    year: 2026, overview: "An astronomer completes a survey.", monitored: true, acquisitionState: "wanted",
    metadataSnapshot: { runtimeMinutes: 101, genres: ["Drama"], certification: "PG", releaseDate: "2026-08-01", status: "Released", rating: 7.5, voteCount: 42 },
  };
  await page.route(url => url.pathname === "/api/v1/acquisition/managed", (route) => route.fulfill({ json: { items: [item], total: 1, tags: [], facets: {} } }));
  await page.route("**/api/v1/acquisition/managed/movie/movie-1", (route) => route.fulfill({ json: { item, files: [] } }));
  await page.route("**/api/v1/acquisition/search?**", (route) => route.fulfill({ json: { candidates: [item] } }));
  await signIn(page);
  await page.goto("/#/admin/media/discover");
  await fillSafely(page.getByRole("textbox", { name: "Title", exact: true }), "Observatory");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(page.getByText("2026 · 101 min · Managed")).toBeVisible();
  await page.getByText("Movie details", { exact: true }).click();
  await expect(page.getByText("2026 · 101 min · PG")).toBeVisible();
  await page.goto("/#/admin/media/managed");
  await page.setViewportSize({ width: 390, height: 1000 });
  await expect(page.getByRole("button", { name: "Filter Year: 2026", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("2026 · 101 min · PG")).toBeVisible();
  await expect(dialog.getByRole("textbox", { name: "Title", exact: true })).toHaveValue("The Last Observatory");
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
});
