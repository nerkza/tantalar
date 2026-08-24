/**
 * Wave 8 e2e: responsive layout at the required widths (320, 390, 768,
 * 1024, wide desktop), accessibility behaviour (keyboard navigation,
 * landmarks, labels), light/dark scheme switching, and visual evidence
 * screenshots for review.
 */
import { expect, test } from "@playwright/test";
import { signIn } from "./helpers";

const WIDTHS = [320, 390, 768, 1024, 1600] as const;

test("product shell renders and stays usable at every required viewport", async ({ page }) => {
  await signIn(page);
  await page.getByTestId("nav-movies").click();
  await expect(page.getByTestId("movies-page")).toBeVisible();

  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 900 });
    // No horizontal overflow: the layout adapts instead of scrolling sideways.
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, `horizontal overflow at ${width}px`).toBeLessThanOrEqual(1);
    await page.screenshot({ path: `../artifacts/wave8-movies-${width}.png`, fullPage: false });

    if (width < 640) {
      // Mobile: the burger toggle opens the nav drawer.
      await page.getByLabel("Navigation menu").click();
      await expect(page.getByTestId("nav-series")).toBeVisible();
      await page.getByTestId("nav-series").click();
    } else {
      await expect(page.getByTestId("nav-series")).toBeVisible();
      await page.getByTestId("nav-series").click();
    }
    await expect(page.getByTestId("series-page")).toBeVisible();
  }
});

test("home page states render across desktop and mobile", async ({ page }) => {
  await signIn(page);
  for (const width of [390, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(page.getByTestId("home-page")).toBeVisible();
    await expect(page.getByText("Continue watching")).toBeVisible();
    await page.screenshot({ path: `../artifacts/wave8-home-${width}.png` });
  }
});

test("settings page renders all twelve sections and switches theme by name", async ({ page }) => {
  await signIn(page);
  await page.getByTestId("nav-settings").click();
  await expect(page.getByTestId("settings-page")).toBeVisible();
  for (const name of ["General", "Libraries", "Downloads", "Indexers", "Quality", "Import",
    "Metadata", "Playback", "Users", "Integrations", "VPN", "System"]) {
    await expect(page.getByRole("tab", { name })).toBeVisible();
  }

  // Theme switch uses human names only; no internal token names in the UI.
  const scheme = page.getByTestId("scheme-select");
  await expect(scheme).toBeVisible();
  await expect(scheme.locator("option")).toHaveCount(2);
  await expect(scheme).toContainText("Light");
  await expect(scheme).toContainText("Dark");

  await scheme.selectOption("light");
  await expect
    .poll(() =>
      page.evaluate(() =>
        getComputedStyle(document.documentElement).getPropertyValue("--tantalar-color-bg").trim(),
      ),
    )
    .toBe("#f5f6fa");
  await page.screenshot({ path: "../artifacts/wave8-settings-light.png" });
  await scheme.selectOption("dark");
  await expect
    .poll(() =>
      page.evaluate(() =>
        getComputedStyle(document.documentElement).getPropertyValue("--tantalar-color-bg").trim(),
      ),
    )
    .toBe("#10121a");
  await page.screenshot({ path: "../artifacts/wave8-settings-dark.png" });
});

test("keyboard-only operation: navigate, open player, control playback", async ({ page }) => {
  await signIn(page);
  // Keyboard-operable product nav.
  await page.getByTestId("nav-movies").focus();
  await page.keyboard.press("Tab");
  const focused = await page.evaluate(() => document.activeElement?.getAttribute("data-testid"));
  expect(focused).toBeTruthy();

  // Player keyboard controls: space toggles play state.
  await page.goto("/#/watch/f-ep1");
  await expect(page.getByTestId("player-page")).toBeVisible();
  await page.waitForFunction(() => {
    const v = document.querySelector('[data-testid="player-video"]') as HTMLVideoElement | null;
    return !!v && v.readyState >= 1;
  });
  await page.keyboard.press("Space");
  await page.waitForFunction(() => {
    const v = document.querySelector('[data-testid="player-video"]') as HTMLVideoElement;
    return !v.paused;
  });
  await page.keyboard.press("k"); // pause via K
  await page.waitForFunction(() => {
    const v = document.querySelector('[data-testid="player-video"]') as HTMLVideoElement;
    return v.paused;
  });
});

test("screen-reader semantics: navigation landmarks, current page, live regions", async ({ page }) => {
  await signIn(page);
  // Navbar is a labelled landmark with aria-current on the active item.
  await expect(page.getByLabel("Main navigation")).toBeVisible();
  await page.getByTestId("nav-movies").click();
  await expect(page.getByTestId("movies-page")).toBeVisible();
  await expect(page.getByTestId("nav-movies")).toHaveAttribute("aria-current", "page");

  // Player exposes an accessible seek slider and a polite live region.
  await page.goto("/#/watch/f-ep1");
  await expect(page.getByTestId("player-page")).toBeVisible();
  await expect(page.getByRole("slider", { name: "Seek" })).toBeVisible();
  await expect(page.locator(".visually-hidden-live")).toHaveCount(1);

  // Search inputs are labelled.
  await page.goto("/#/movies");
  await expect(page.getByTestId("movies-page")).toBeVisible();
  await expect(page.getByLabel("Search Movies")).toBeVisible();
});
