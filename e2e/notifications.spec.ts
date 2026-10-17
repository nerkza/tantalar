import { expect, test } from "@playwright/test";
import { signIn } from "./helpers";

test("a live plugin event opens its Control route from the notice", async ({ page }) => {
  await signIn(page);
  await expect(page.locator('[aria-label="Notifications"][data-live="live"]')).toBeAttached({ timeout: 15_000 });

  await page.evaluate(() => { window.location.hash = "/admin/extensions"; });
  const plugin = page.getByTestId("plugin-dev.tantalar.plugin.serving");
  await expect(plugin).toBeVisible({ timeout: 15_000 });
  await plugin.getByRole("button", { name: "Restart" }).click();

  const notice = page.getByRole("status").filter({ hasText: "Plugin started" });
  await expect(notice).toBeVisible({ timeout: 15_000 });
  await expect(notice.getByRole("button", { name: "Dismiss Plugin started" })).toBeVisible();
  const activate = notice.getByRole("button", { name: "Open Extensions" });
  const activateBox = await activate.boundingBox();
  expect(activateBox).not.toBeNull();
  expect(activateBox!.height).toBeGreaterThanOrEqual(40);
  await page.setViewportSize({ width: 360, height: 740 });
  const box = await notice.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(360);
  await page.getByTestId("back-to-media").click();
  await activate.click();

  await expect(page).toHaveURL(/#\/admin\/extensions$/);
  await expect(page.getByTestId("control-page-extensions")).toBeVisible();
});

test("notification preferences remain usable in both themes at the narrow preset", async ({ page }) => {
  await signIn(page);
  await page.evaluate(() => { window.location.hash = "/admin/system/appearance"; });
  await expect(page.getByTestId("scheme-select")).toBeVisible();

  const scheme = page.getByTestId("scheme-select");
  await scheme.selectOption("light");
  const controlNavigation = page.getByRole("navigation", { name: "Control navigation" });
  const shortcut = page.getByTestId("nav-notifications");
  await expect(shortcut).toBeVisible();
  const [navigationBox, shortcutBox] = await Promise.all([controlNavigation.boundingBox(), shortcut.boundingBox()]);
  expect(navigationBox).not.toBeNull();
  expect(shortcutBox).not.toBeNull();
  expect(shortcutBox!.y + shortcutBox!.height).toBeGreaterThan(navigationBox!.y + navigationBox!.height - 64);
  await shortcut.click();
  await expect(page).toHaveURL(/#\/admin\/system\/notifications$/);
  await expect(controlNavigation).toBeVisible();
  await expect(page.getByRole("heading", { name: "Notifications" })).toBeVisible();
  await page.screenshot({ path: "../artifacts/notifications-control-desktop.png", fullPage: false });
  await page.setViewportSize({ width: 360, height: 740 });
  await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--tantalar-color-bg").trim())).toBe("#f5f6fa");
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: "../artifacts/notifications-preferences-light-360.png", fullPage: true });

  await page.setViewportSize({ width: 1280, height: 720 });
  await page.evaluate(() => { window.location.hash = "/admin/system/appearance"; });
  await expect(page.getByTestId("scheme-select")).toBeVisible();
  await page.getByTestId("scheme-select").selectOption("dark");
  await page.getByTestId("nav-notifications").click();
  await expect(page).toHaveURL(/#\/admin\/system\/notifications$/);
  await expect(page.getByRole("heading", { name: "Notifications" })).toBeVisible();
  await page.setViewportSize({ width: 360, height: 740 });
  await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--tantalar-color-bg").trim())).toBe("#10121a");
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: "../artifacts/notifications-preferences-dark-360.png", fullPage: true });

  await page.evaluate(() => { window.location.hash = "/admin/integrations/mcp"; });
  await expect(page.getByTestId("mcp-settings")).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: "../artifacts/mcp-settings-dark-360.png", fullPage: true });
});
