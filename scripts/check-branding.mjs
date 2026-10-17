import assert from "node:assert/strict";
import { chromium } from "@playwright/test";

// Run against Vite: node scripts/check-branding.mjs
const browser = await chromium.launch({ channel: "chrome" });
try {
  const page = await browser.newPage();
  let bootstrap = false;
  let signedIn = false;
  await page.route("**/api/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    const user = signedIn ? { id: "brand-check", username: "brand-check", role: "admin" } : null;
    const body = path.endsWith("/bootstrap/status") ? { required: bootstrap }
      : path.endsWith("/onboarding") ? { complete: true, steps: {} }
      : path.endsWith("/ui-preferences") ? { preferences: {} }
      : path.endsWith("/themes") ? { themes: [] }
      : path.endsWith("/version") ? { label: "0.0.1 Alpha" }
      : path.endsWith("/auth/me") ? { user }
      : { user, items: [], total: 0 };
    return route.fulfill({ json: body });
  });
  await page.goto(process.env.TANTALAR_WEB_URL ?? "http://127.0.0.1:5173");
  await page.getByRole("heading", { name: "Sign in", exact: true }).waitFor();
  for (const width of [1280, 375]) {
    await page.setViewportSize({ width, height: 800 });
    for (const scheme of ["dark", "light"]) {
      await page.evaluate((value) => document.documentElement.setAttribute("data-mantine-color-scheme", value), scheme);
      const logo = page.getByRole("img", { name: "Tantalar", exact: true });
      assert.equal(await logo.count(), 1);
      assert(await logo.locator(`.tantalar-logo__${scheme}`).isVisible());
      assert(await logo.locator(`.tantalar-logo__${scheme === "dark" ? "light" : "dark"}`).isHidden());
      assert(await logo.locator("img").evaluateAll((images) => images.every((image) => image.complete && image.naturalWidth > 0)));
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    }
  }
  for (const href of await page.locator('link[rel="icon"], link[rel="apple-touch-icon"]').evaluateAll((links) => links.map((link) => link.href))) {
    const response = await page.request.get(href);
    assert(response.ok());
    assert.match(response.headers()["content-type"], /image\//);
  }
  bootstrap = true;
  await page.reload();
  await page.getByRole("heading", { name: "Create your administrator" }).waitFor();
  assert(await page.getByRole("img", { name: "Tantalar", exact: true }).isVisible());
  if (process.env.TANTALAR_BRAND_SCREENSHOT) await page.screenshot({ path: process.env.TANTALAR_BRAND_SCREENSHOT });
  bootstrap = false;
  signedIn = true;
  await page.goto(`${process.env.TANTALAR_WEB_URL ?? "http://127.0.0.1:5173"}/#/preferences`);
  await page.reload();
  const home = page.getByRole("link", { name: "Tantalar home" });
  await home.waitFor();
  await page.getByRole("heading", { name: "Notifications", exact: true }).waitFor();
  for (const width of [1280, 375]) {
    await page.setViewportSize({ width, height: 800 });
    assert(await home.isVisible());
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  }
  await home.focus();
  assert.equal(await home.evaluate((element) => getComputedStyle(element).outlineStyle), "solid");
  // Graphite preset background, with its existing light foreground treatment.
  await page.evaluate(() => {
    document.documentElement.style.setProperty("--tantalar-color-surface", "#1c1c1c");
  });
  if (process.env.TANTALAR_BRAND_SCREENSHOT) await page.screenshot({ path: process.env.TANTALAR_BRAND_SCREENSHOT.replace(".png", "-header.png") });
  await home.click();
  assert.equal(new URL(page.url()).hash, "#/");
  console.log("Branding passed: dark/light, desktop/mobile, sign-in/setup, header/home link, keyboard focus, browser icons.");
} finally {
  await browser.close();
}
