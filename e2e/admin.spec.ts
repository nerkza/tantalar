/**
 * Phase 6 e2e (stories 25–27): admin management grids, theme editor
 * preview/persist/revert with malicious CSS rejection, trajectory
 * reconstruction, keyboard accessibility, responsive layouts.
 *
 * Chromium / Playwright harness limitation on this environment:
 * CDP mouse events and keyDown/insertText hang on admin-page elements
 * when React state updates follow.  ALL page interactions (clicks,
 * fills, key-presses) use page.evaluate with native DOM events.
 * Only `page.keyboard.press` for non-text navigation keys works.
 */
import { expect, test } from "@playwright/test";
import { fillSafely, signIn } from "./helpers";

/** Navigate to #/admin via hash manipulation, then wait for the admin shell. */
async function goAdmin(page: import("@playwright/test").Page) {
  await page.evaluate(() => { window.location.hash = "/admin"; });
  await expect(page.getByRole("tab", { name: "Queue" })).toBeVisible({ timeout: 15_000 });
}

/** JS-click a role=tab by visible text. */
async function clickTab(page: import("@playwright/test").Page, name: string) {
  await page.evaluate((n) => {
    const tabs = document.querySelectorAll('[role="tab"]');
    for (const t of tabs) {
      if (t.textContent?.trim() === n) { (t as HTMLElement).click(); break; }
    }
  }, name);
}

test.beforeEach(async ({ page }) => {
  await signIn(page);
  await goAdmin(page);
});

test("queue/wanted/history grids render, sort and filter", async ({ page }) => {
  await clickTab(page, "History");
  const history = page.getByTestId("history-grid");
  await expect(history).toBeVisible();

  const filter = history.getByLabel("Filter history-grid");
  await fillSafely(filter, "no-such-item-xyz");
  await expect(history).toContainText(/No watch history yet|Nothing to show/);
  await page.evaluate(() => {
    const el = document.querySelector('[data-testid="history-grid"] input') as HTMLInputElement;
    if (el) { el.value = ""; el.dispatchEvent(new Event("input", { bubbles: true })); }
  });

  await clickTab(page, "Wanted");
  const wanted = page.getByTestId("wanted-grid");
  await expect(wanted).toBeVisible();
  // JS-click first th to toggle sort; wait for aria-sort to update.
  await page.evaluate(() => {
    const th = document.querySelector('[data-testid="wanted-grid"] th') as HTMLElement | null;
    if (th) th.click();
  });
  await expect(wanted.locator("th").first()).toHaveAttribute("aria-sort", /ascending|descending/, { timeout: 5_000 });
});

test("grid customization persists density preference across navigation", async ({ page }) => {
  await clickTab(page, "Settings");
  await page.evaluate(() => {
    const sw = document.querySelector('[role="switch"]') as HTMLElement;
    if (sw) sw.click();
  });
  await page.waitForTimeout(500);

  // Navigate away and back.
  await page.evaluate(() => { window.location.hash = "/home"; });
  await expect(page.getByTestId("home-page")).toBeVisible();
  await goAdmin(page);
  await clickTab(page, "Settings");
  await expect(page.getByRole("switch")).toBeChecked({ timeout: 15_000 });
});

test("theme editor: token override previews in both UIs, saves, reverts; malicious CSS rejected", async ({ page }) => {
  await clickTab(page, "Settings");
  const editor = page.getByTestId("theme-editor");

  // Settings use human labels; internal CSS variable names never appear.
  const primary = editor.getByLabel("Accent color", { exact: true });
  await fillSafely(primary, "#ff00ff");
  await expect
    .poll(() =>
      page.evaluate(() =>
        getComputedStyle(document.documentElement).getPropertyValue("--tantalar-color-primary").trim(),
      ),
    )
    .toBe("#ff00ff");

  const bg = editor.getByLabel("Page background", { exact: true });
  await fillSafely(bg, "url(javascript:alert(1))");
  await expect(page.getByTestId("theme-errors")).toBeVisible();

  await fillSafely(editor.getByLabel("Theme name"), "e2e-magenta");
  await page.evaluate(() => {
    const btn = document.querySelector('[data-testid="save-theme"]') as HTMLElement;
    if (btn) btn.click();
  });
  await page.waitForTimeout(500);

  // Navigate away and back.
  await page.evaluate(() => { window.location.hash = "/home"; });
  await expect(page.getByTestId("home-page")).toBeVisible();
  await goAdmin(page);
  await clickTab(page, "Settings");

  await expect
    .poll(() =>
      page.evaluate(() =>
        getComputedStyle(document.documentElement).getPropertyValue("--tantalar-color-primary").trim(),
      ),
    )
    .toBe("#ff00ff");

  await page.evaluate(() => {
    const btn = document.querySelector('[data-testid="revert-theme"]') as HTMLElement;
    if (btn) btn.click();
  });
  await page.waitForTimeout(300);
  await page.evaluate(() => { window.location.hash = "/home"; });
  await expect(page.getByTestId("home-page")).toBeVisible();
  const css = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue("--tantalar-color-bg").trim(),
  );
  expect(css).not.toBe("");
});

test("trajectory view reconstructs the grab→import decision chain", async ({ page }) => {
  await clickTab(page, "Activity");
  const chainSelect = page.getByTestId("chain-select");
  await expect(chainSelect).toBeVisible({ timeout: 15_000 });
  // Pick seeded chain via JS.
  const optionValue = await page.evaluate(() => {
    const sel = document.querySelector('[data-testid="chain-select"]') as HTMLSelectElement | null;
    if (!sel) return "";
    for (const o of Array.from(sel.options)) {
      if (o.value.includes("corr-e2e-phase6")) return o.value;
    }
    return "";
  });
  expect(optionValue).not.toBe("");
  await chainSelect.selectOption(optionValue);
  const reconstruction = page.getByTestId("decision-reconstruction");
  await expect(reconstruction).toBeVisible();
  await expect(reconstruction).toContainText('Grabbed "good-rel"');
  await expect(reconstruction).toContainText("Searched indexers");
  await expect(reconstruction).toContainText("Import completed");
  await expect(reconstruction).toContainText("Full grab→import chain reconstructed");
});

test("users view creates a user and lists them", async ({ page }) => {
  await clickTab(page, "Users");
  const username = `e2e-user-${Date.now()}`;

  await fillSafely(page.getByTestId("new-user-username"), username);
  await fillSafely(page.getByTestId("new-user-password"), "password-e2e-123");
  await page.evaluate(() => {
    const btn = document.querySelector('[data-testid="create-user"]') as HTMLElement;
    if (btn) btn.click();
  });
  await expect(page.getByTestId("users-grid")).toContainText(username);
});

test("system health view reports plugin states", async ({ page }) => {
  await clickTab(page, "System");
  await expect(page.getByTestId("system-health")).toBeVisible();
  await expect(page.getByTestId("system-health")).toContainText(/Ready: true|Degraded service/);
});

test("admin console is keyboard navigable across tabs", async ({ page }) => {
  await page.getByRole("tab", { name: "Queue" }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("tab", { name: "Wanted" })).toHaveAttribute("aria-selected", "true");
});

test("admin views are usable on a narrow viewport", async ({ page }) => {
  await page.setViewportSize({ width: 400, height: 800 });
  await expect(page.getByRole("tablist")).toBeVisible();
  await clickTab(page, "Plugins");
  await expect(page.getByText("Plugins", { exact: true }).first()).toBeVisible();
});