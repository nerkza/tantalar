import { expect, test } from "@playwright/test";
import { signIn } from "./helpers";

test.beforeEach(async ({ page }) => { await signIn(page); });

test("skip link appears on focus and targets main content", async ({ page }) => {
  await page.goto("/#/admin");
  const skip = page.getByTestId("skip-link");
  await skip.focus();
  await expect(skip).toBeVisible();
  await expect(skip).toHaveAttribute("href", "#main-content");
});

test("Control audit lists security entries", async ({ page }) => {
  await page.goto("/#/admin/audit/log");
  await expect(page.getByTestId("audit-view")).toBeVisible();
  await expect(page.getByTestId("audit-view")).toContainText(/Sign.in|Login|Authenticated/i);
});

test("system diagnostics and authenticated backup remain available", async ({ page }) => {
  await page.goto("/#/admin/system/health");
  const health = page.getByTestId("system-health-dashboard");
  await expect(health).toContainText("FFmpeg transcoding");
  await health.getByText("Advanced diagnostics", { exact: true }).click();
  await expect(health.getByRole("table", { name: "Advanced diagnostics", exact: true })).toContainText(/v\d+\./);
  const csrf = (await page.context().cookies()).find(cookie => cookie.name === "tantalar_csrf")!.value;
  const backup = await page.request.post("/api/v1/system/backup", { headers: { "x-csrf-token": csrf }, data: {} });
  expect(backup.status()).toBe(200);
  expect((await backup.json()).path).toMatch(/\.db$/);
  const preview = await page.request.get("/api/v1/system/support-bundle/preview");
  expect(preview.status()).toBe(200);
  expect((await preview.json()).sections.length).toBeGreaterThan(0);
});

test("integrations creates an API key whose secret is shown once", async ({ page }) => {
  await page.goto("/#/admin/integrations/overview");
  await page.getByTestId("apikey-name").fill(`e2e-key-${Date.now()}`);
  await page.getByTestId("create-apikey").click();
  const secret = page.getByTestId("apikey-secret-once");
  await expect(secret).toContainText("tantalar_");
  await expect(secret).toContainText("will not be shown again");
  await secret.getByRole("button").click();
  await expect(secret).toHaveCount(0);
});

test("Control remains usable at 320 pixels with compact navigation", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 });
  await page.goto("/#/admin");
  await page.getByRole("button", { name: "Navigation menu", exact: true }).click();
  await expect(page.getByRole("navigation", { name: "Control navigation" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign out", exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
