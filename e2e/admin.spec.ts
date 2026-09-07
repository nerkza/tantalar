import { expect, test } from "@playwright/test";
import { fillSafely, signIn } from "./helpers";

test.beforeEach(async ({ page }) => { await signIn(page); });

test("watch history and wanted grids render, sort and filter", async ({ page }) => {
  const csrf = (await page.context().cookies()).find(cookie => cookie.name === "tantalar_csrf")!.value;
  const progress = await page.request.post("/api/v1/library/f-ep1/resume", { headers: { "x-csrf-token": csrf }, data: { positionMs: 30000, durationMs: 30000 } });
  expect(progress.ok()).toBe(true);
  await page.goto("/#/activity");
  await page.getByRole("tab", { name: "History", exact: true }).click();
  const history = page.getByTestId("watch-activity-grid");
  await fillSafely(history.getByRole("textbox", { name: "Filter watch activity" }), "no-such-item-xyz");
  await expect(history).toContainText("Nothing completed yet.");
  await page.goto("/#/admin/acquisition/downloads");
  await page.getByRole("tab", { name: "Wanted", exact: true }).click();
  const wanted = page.getByTestId("wanted-grid");
  await expect(wanted).toBeVisible();
  await wanted.getByRole("button", { name: "Details layout", exact: true }).click();
  await wanted.locator("th").first().click();
  await expect(wanted.locator("th").first()).toHaveAttribute("aria-sort", /ascending|descending/);
});

test("grid layout preference persists across navigation", async ({ page }) => {
  await page.goto("/#/admin/people");
  const grid = page.getByTestId("users-grid");
  const saved = page.waitForResponse(response => response.url().includes("/ui-preferences") && response.request().method() === "PUT" && response.ok());
  await grid.getByRole("button", { name: "List layout", exact: true }).click();
  await saved;
  await expect(grid.getByRole("button", { name: "List layout", exact: true })).toHaveAttribute("aria-pressed", "true");
  await page.goto("/#/home");
  await expect(page.getByTestId("home-page")).toBeVisible();
  await page.goto("/#/admin/people");
  await expect(grid.getByRole("button", { name: "List layout", exact: true })).toHaveAttribute("aria-pressed", "true");
});

test("theme editor previews, saves and reverts, and rejects malicious CSS", async ({ page }) => {
  await page.goto("/#/admin/system/appearance");
  await page.getByRole("button", { name: "Edit Accent", exact: true }).click();
  await fillSafely(page.getByLabel("Accent hex value", { exact: true }), "#ff00ff");
  const preview = page.getByRole("region", { name: "Tantalar preview" });
  await expect(preview).toHaveCSS("--tantalar-color-primary", "#ff00ff");
  await page.getByRole("button", { name: "Edit Background", exact: true }).click();
  const background = page.getByLabel("Background hex value", { exact: true });
  await fillSafely(background, "url(javascript:alert(1))");
  await expect(page.getByTestId("theme-errors")).toBeVisible();
  await expect(page.getByTestId("save-theme")).toBeDisabled();
  await fillSafely(background, "#10121a");
  await fillSafely(page.getByLabel("Theme name", { exact: true }), "e2e-magenta");
  await page.getByTestId("save-theme").click();
  await expect(page.getByRole("button", { name: "Use e2e-magenta theme", exact: true })).toBeVisible();
  await page.reload();
  await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--tantalar-color-primary").trim())).toBe("#ff00ff");
  await page.getByRole("button", { name: "Edit Accent", exact: true }).click();
  await fillSafely(page.getByLabel("Accent hex value", { exact: true }), "#00ff00");
  await page.getByTestId("revert-theme").click();
  await expect(preview).toHaveCSS("--tantalar-color-primary", "#ff00ff");
});

test("trace inspector reconstructs the grab to import chain", async ({ page }) => {
  await page.goto("/#/admin/audit/trace");
  await page.getByText("Trace filters", { exact: true }).click();
  await fillSafely(page.getByLabel("Filter by operation id"), "corr-e2e-phase6");
  const grid = page.getByTestId("trace-grid");
  await expect(grid).toContainText("dev.tantalar.event.import.completed");
  await grid.getByRole("row", { name: "Inspect dev.tantalar.event.import.completed", exact: true }).click();
  const inspector = page.getByTestId("operations-log-inspector");
  await inspector.getByRole("tab", { name: "Trace", exact: true }).click();
  await expect(inspector).toContainText('Grabbed "good-rel"');
  await expect(inspector).toContainText("Searched indexers");
  await expect(inspector).toContainText("imported successfully");
});

test("people creates a user and lists them", async ({ page }) => {
  await page.goto("/#/admin/people");
  const username = `e2e-user-${Date.now()}`;
  await page.getByRole("button", { name: "Add person", exact: true }).click();
  const drawer = page.getByRole("dialog").filter({ has: page.getByRole("heading", { name: "Add person", exact: true }) });
  await fillSafely(drawer.getByRole("textbox", { name: "Username", exact: true }), username);
  await fillSafely(drawer.getByLabel("Temporary password"), "password-e2e-123");
  await drawer.getByRole("button", { name: "Create account", exact: true }).click();
  await expect(page.getByTestId("users-grid")).toContainText(username);
  await expect(page.getByRole("dialog").getByRole("heading", { name: `Manage ${username}`, exact: true })).toBeVisible();
});

test("system health reports plugin states", async ({ page }) => {
  await page.goto("/#/admin/system/health");
  const health = page.getByTestId("system-health-dashboard");
  await expect(health.getByRole("table", { name: "Extensions", exact: true })).toContainText(/Running|Healthy/i);
  await expect(health).toContainText("FFmpeg transcoding");
});

test("Control navigation is keyboard operable", async ({ page }) => {
  await page.goto("/#/admin");
  const people = page.getByTestId("control-nav-people");
  await people.focus();
  await page.keyboard.press("Enter");
  await expect(people).toHaveAttribute("aria-current", "page");
  await expect(page.getByTestId("users-grid")).toBeVisible();
});

test("Control is usable on a narrow viewport", async ({ page }) => {
  await page.setViewportSize({ width: 400, height: 800 });
  await page.goto("/#/admin");
  await page.getByRole("button", { name: "Navigation menu", exact: true }).click();
  await page.getByTestId("control-nav-extensions").click();
  await expect(page.getByTestId("control-page-extensions")).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
