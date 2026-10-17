import { expect } from "@playwright/test";
import { signIn, test } from "./helpers";
import { BUILT_IN_THEMES } from "../apps/web/src/theme/tokens";

test("guides profile setup, reports protection, and confirms direct access", async ({ page }) => {
  const ids = ["dev.tantalar.plugin.torrent-native", "dev.tantalar.plugin.usenet-native"];
  let configured = false;
  let disconnected = false;
  const state = () => ({
    host: { platform: "linux", tools: { wg: true, ip: true, nft: true, setpriv: true }, tunDevice: false, netAdmin: true, sysAdmin: true, supported: true, missing: [], checkedAt: new Date().toISOString() },
    lifecycleControlReady: true, enforcementReady: true, openvpnApplySupported: false, profiles: [], bindings: [],
    clients: ids.map((clientId, index) => ({ clientId, profileId: configured && !(disconnected && index === 0) ? "fixture" : null, health: configured ? "healthy" : null, allowDispatch: true })),
    checkedAt: new Date().toISOString(),
  });
  await page.route("**/api/v1/plugins", route => route.fulfill({ json: { plugins: [{ manifest: { id: "dev.tantalar.plugin.vpn-manager", version: "0.1.0", provides: [], requires: [], subscriptions: [] }, state: "healthy" }] } }));
  await page.route("**/api/v1/acquisition/vpn", async route => {
    if (route.request().method() === "PUT") {
      const body = route.request().postDataJSON();
      expect(body.clientIds).toEqual(ids);
      expect(body.configText).toContain("[Interface]");
      configured = true;
    }
    await route.fulfill({ json: state() });
  });
  await page.route("**/api/v1/acquisition/vpn/disconnect", async route => {
    expect(route.request().postDataJSON()).toEqual({ clientId: ids[0], confirmDirect: true });
    disconnected = true;
    await route.fulfill({ json: state() });
  });
  await signIn(page);
  await page.goto("/#/admin/acquisition/vpn");
  await expect(page.getByRole("heading", { name: "Set up download protection" })).toBeVisible();
  await page.locator('input[type="file"]').setInputFiles({ name: "provider.conf", mimeType: "text/plain", buffer: Buffer.from("[Interface]\n# UI fixture; the Linux proof uses a real generated WireGuard profile.\n") });
  await page.getByRole("checkbox", { name: "Native Usenet", exact: true }).check();
  await page.getByRole("button", { name: "Enable protection", exact: true }).click();
  const torrent = page.getByRole("region", { name: "Native Torrent connection" });
  const usenet = page.getByRole("region", { name: "Native Usenet connection" });
  await expect(torrent.getByText("VPN connected", { exact: true })).toBeVisible();
  await expect(usenet.getByText("VPN connected", { exact: true })).toBeVisible();
  await torrent.getByRole("button", { name: "Use direct connection" }).click();
  expect(disconnected).toBe(false);
  await torrent.getByRole("button", { name: "Confirm direct connection" }).click();
  await expect(torrent.getByText("Direct", { exact: true })).toBeVisible();
  await expect(usenet.getByText("VPN connected", { exact: true })).toBeVisible();
  await page.setViewportSize({ width: 360, height: 800 });
  await expect.poll(() => page.locator("main").evaluate(element => parseFloat(getComputedStyle(element).paddingLeft))).toBeLessThan(48);
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.evaluate(() => { (document.activeElement as HTMLElement)?.blur(); window.scrollTo(0, 0); });
  await page.screenshot({ path: "../artifacts/vpn-setup-narrow.png", fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({ path: "../artifacts/vpn-setup-desktop.png", fullPage: true });
  for (const scheme of ["light", "graphite"]) {
    await page.route("**/ui-preferences", route => route.fulfill({ json: { preferences: { colorScheme: scheme === "light" ? "light" : "dark", tokenOverrides: scheme === "light" ? {} : BUILT_IN_THEMES.find(theme => theme.id === scheme)!.tokens } } }));
    for (const [surface, route] of [["vpn", "acquisition/vpn"], ["mcp", "integrations/mcp"]]) {
      await page.goto(`/#/admin/${route}`);
      await page.reload();
      await expect(page.getByRole("heading", { name: surface === "vpn" ? "Set up download protection" : "MCP setup", exact: true })).toBeVisible();
      await expect(page.locator("html")).toHaveAttribute("data-mantine-color-scheme", scheme === "light" ? "light" : "dark");
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: `../artifacts/${surface}-setup-${scheme}.png`, fullPage: true });
    }
    await page.unroute("**/ui-preferences");
  }
});
