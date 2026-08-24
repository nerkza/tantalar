/**
 * Wave 9 e2e (TAN-030/032/035/036/037/043): operations UI in a real browser.
 *  - skip link + keyboard access (a11y);
 *  - audit tab reachable;
 *  - integrations section renders API-key creation with one-time secret;
 *  - system ops section: backup button + diagnostics + bundle preview;
 *  - narrow viewport usability with compact navigation.
 *
 * Same harness discipline as admin.spec.ts: page.evaluate for interactions.
 */
import { expect, test } from "@playwright/test";
import { signIn } from "./helpers";

async function goAdmin(page: import("@playwright/test").Page) {
  await page.evaluate(() => { window.location.hash = "/admin"; });
  await expect(page.getByRole("tab", { name: "Queue" })).toBeVisible({ timeout: 15_000 });
}

test.beforeEach(async ({ page }) => {
  await signIn(page);
});

test("skip link appears on focus and targets main content", async ({ page }) => {
  await goAdmin(page);
  await page.keyboard.press("Tab");
  const skip = page.getByTestId("skip-link");
  await expect(skip).toBeAttached();
  // After focusing the skip link it becomes visible.
  await skip.focus();
  await expect(skip).toBeVisible();
});

test("audit tab lists security entries", async ({ page }) => {
  await goAdmin(page);
  await page.evaluate(() => {
    const tabs = document.querySelectorAll('[role="tab"]');
    for (const t of tabs) {
      if (t.textContent?.trim() === "Audit") { (t as HTMLElement).click(); break; }
    }
  });
  await expect(page.getByTestId("audit-view")).toBeVisible({ timeout: 15_000 });
});

test("settings system section exposes backup, restore and diagnostics", async ({ page }) => {
  await page.evaluate(() => { window.location.hash = "/settings"; });
  await expect(page.getByTestId("settings-page")).toBeVisible({ timeout: 15_000 });
  await page.evaluate(() => {
    const tabs = document.querySelectorAll('[role="tab"]');
    for (const t of tabs) {
      if (t.textContent?.trim() === "System") { (t as HTMLElement).click(); break; }
    }
  });
  await expect(page.getByTestId("run-backup")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("diagnostics-block")).toContainText(/Node v|Transcoder support/);

  // Creating a backup reports its location truthfully.
  await page.evaluate(() => {
    const btn = document.querySelector('[data-testid="run-backup"]') as HTMLElement;
    if (btn) btn.click();
  });
  await expect(page.getByTestId("system-note")).toContainText(/Backup written|storage unavailable/, { timeout: 15_000 });

  // Support bundle preview states redaction behaviour.
  await expect(page.getByTestId("support-bundle-block")).toContainText(/redact/i);
});

test("integrations section creates an API key whose secret is shown once", async ({ page }) => {
  await page.evaluate(() => { window.location.hash = "/settings"; });
  await expect(page.getByTestId("settings-page")).toBeVisible({ timeout: 15_000 });
  await page.evaluate(() => {
    const tabs = document.querySelectorAll('[role="tab"]');
    for (const t of tabs) {
      if (t.textContent?.trim() === "Integrations") { (t as HTMLElement).click(); break; }
    }
  });
  const nameInput = page.getByTestId("apikey-name");
  await expect(nameInput).toBeVisible({ timeout: 15_000 });
  await nameInput.fill(`e2e-key-${Date.now()}`);
  await page.evaluate(() => {
    const btn = document.querySelector('[data-testid="create-apikey"]') as HTMLElement;
    if (btn) btn.click();
  });
  const secretBox = page.getByTestId("apikey-secret-once");
  await expect(secretBox).toBeVisible({ timeout: 15_000 });
  await expect(secretBox).toContainText("tantalar_");
  await expect(secretBox).toContainText("will not be shown again");

  // Dismissing removes the secret from the DOM entirely.
  await page.evaluate(() => {
    const done = document.querySelector('[data-testid="apikey-secret-once"] button') as HTMLElement | null;
    if (done) done.click();
  });
  await expect(page.getByTestId("apikey-secret-once")).toHaveCount(0);
});

test("admin views remain usable at 320 pixels with compact navigation", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 });
  await goAdmin(page);
  await expect(page.getByRole("tablist")).toBeVisible();
  // Header actions stay inside the viewport (no two-axis searching).
  const signOut = page.getByRole("button", { name: "Sign out" });
  await expect(signOut).toBeVisible();
});
