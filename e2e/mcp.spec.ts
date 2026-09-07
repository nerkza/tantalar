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
  await expect(setup.getByText("Streamable HTTP", { exact: true })).toBeVisible();

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

  await expect(setup.getByLabel("API key")).toHaveValue(secret);
  await clickButton(setup, "Run protocol test");
  const protocolResult = setup.getByTestId("mcp-test-result");
  await expect(protocolResult).toContainText("Protocol test passed", { timeout: 15_000 });
  await expect(protocolResult).toContainText("initialize: Passed");
  await expect(protocolResult).toContainText("ping: Passed");
  await expect(protocolResult).toContainText("tools/list: Passed");

  await clickButton(setup, "Open MCP Audit");
  await expect(page).toHaveURL(/#\/admin\/audit\/mcp$/);
  const audit = page.getByTestId("audit-view");
  await expect(audit).toBeVisible({ timeout: 15_000 });
  await expect(audit).toContainText("dev.tantalar.event.mcp.call", { timeout: 15_000 });
  await expect(audit).toContainText("dev.tantalar.plugin.mcp");
});
