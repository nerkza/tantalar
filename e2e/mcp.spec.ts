import { expect, type Locator } from "@playwright/test";
import { fillSafely, signIn, test } from "./helpers";

async function clickButton(scope: Locator, name: string): Promise<void> {
  await scope.getByRole("button", { name, exact: true }).evaluate((button) => {
    (button as HTMLButtonElement).click();
  });
}

test("creates an MCP client key, verifies the protocol, and observes the audit call", async ({ page }) => {
  await signIn(page);
  await page.goto("/#/admin/integrations/mcp");
  const setup = page.getByTestId("mcp-settings");
  await expect(setup.getByRole("heading", { name: "MCP setup" })).toBeVisible({ timeout: 15_000 });
  await expect(setup.getByText("Server ready", { exact: false })).toBeVisible();
  await expect(setup.getByLabel("Port")).toBeHidden();

  await setup.getByText("Connection permissions", { exact: true }).click();
  await expect(setup.getByLabel("events.read")).toBeChecked();
  await expect(setup.getByLabel("operations.read")).toBeChecked();
  await expect(setup.getByLabel("config.read")).toBeChecked();
  await fillSafely(setup.getByLabel("Key name"), `e2e-mcp-${Date.now()}`);

  const keyRequest = page.waitForRequest((request) =>
    request.method() === "POST" && new URL(request.url()).pathname === "/api/v1/api-keys",
  );
  await clickButton(setup, "Create read-only key");
  const requestBody = (await keyRequest).postDataJSON() as { scopes: string[] };
  expect(requestBody.scopes).toEqual(["events.read", "operations.read", "config.read"]);

  const secretBox = setup.getByTestId("apikey-secret-once");
  await expect(secretBox).toBeVisible({ timeout: 15_000 });
  const secret = (await secretBox.getByText(/^tantalar_/).textContent()) ?? "";
  expect(secret).toMatch(/^tantalar_/);
  await secretBox.getByRole("button", { name: "Done" }).evaluate((button) => {
    (button as HTMLButtonElement).click();
  });
  await expect(secretBox).toHaveCount(0);

  await expect(setup.getByLabel("Client API key", { exact: true })).toHaveValue(secret);
  await clickButton(setup, "Run protocol test");
  const protocolResult = setup.getByTestId("mcp-test-result");
  await expect(protocolResult).toContainText("Protocol test passed", { timeout: 15_000 });
  await expect(protocolResult).toContainText("initialize: Passed");
  await expect(protocolResult).toContainText("ping: Passed");
  await expect(protocolResult).toContainText("tools/list: Passed");

  await page.setViewportSize({ width: 360, height: 800 });
  await expect.poll(() => page.locator("main").evaluate((element) => parseFloat(getComputedStyle(element).paddingLeft))).toBeLessThan(48);
  await expect(setup.getByRole("button", { name: "Copy configuration with key" })).toBeEnabled();
  await page.screenshot({ path: "../artifacts/mcp-setup-narrow.png", fullPage: true });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({ path: "../artifacts/mcp-setup-desktop.png", fullPage: true });

  await clickButton(setup, "Open MCP Audit");
  await expect(page).toHaveURL(/#\/admin\/audit\/mcp$/);
  const audit = page.getByTestId("audit-view");
  await expect(audit).toBeVisible({ timeout: 15_000 });
  await expect(audit).toContainText("dev.tantalar.event.mcp.call", { timeout: 15_000 });
  await expect(audit).toContainText("dev.tantalar.plugin.mcp");
});
