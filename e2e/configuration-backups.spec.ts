import { expect, test } from "@playwright/test";
import { fillSafely, signIn } from "./helpers";
import { BUILT_IN_THEMES } from "../apps/web/src/theme/tokens";

test("configuration export, import and schedules work across themes and screen sizes", async ({ page }) => {
  let scheme = "dark";
  await page.route("**/api/v1/users/*/ui-preferences", route => route.fulfill({ json: { preferences: { colorScheme: scheme === "light" ? "light" : "dark", tokenOverrides: scheme === "graphite" ? BUILT_IN_THEMES.find(p => p.id === "graphite")!.tokens : {} } } }));
  await signIn(page);
  await page.goto("/#/admin/system/backups");
  await expect(page.getByRole("heading", { name: "Configuration and backups", exact: true })).toBeVisible();
  const schedule = page.getByRole("textbox", { name: /Schedule \(UTC\)/ });
  await expect(schedule).toHaveValue("daily 02:00");
  await fillSafely(schedule, "daily 06:15");
  await page.getByRole("button", { name: "Save backup settings" }).click();
  await expect.poll(async () => (await (await page.request.get("/api/v1/system/backup/settings")).json()).schedule).toBe("daily 06:15");
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export configuration file" }).click();
  const file = await download;
  await page.locator('input[type="file"]').setInputFiles((await file.path())!);
  page.once("dialog", dialog => dialog.accept());
  await page.getByRole("button", { name: "Validate and import" }).click();
  await expect(page.getByText("Restart required", { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByText("Restart required", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Cancel pending import" }).click();
  await expect(page.getByRole("button", { name: "Validate and import" })).toBeVisible();
  for (const theme of ["dark", "light", "graphite"]) {
    scheme = theme;
    await page.reload();
    await expect(schedule).toHaveValue("daily 06:15");
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
      await page.screenshot({ path: `../artifacts/configuration-backups-${theme}-${width}.png`, fullPage: true, animations: "disabled" });
    }
  }
  await page.getByRole("button", { name: "Save backup settings" }).focus();
  await page.keyboard.press("Enter");
});
