import { test, expect } from "@playwright/test";

test("Control-only setup resumes, finishes, and can enable Media later", async ({ page }) => {
  test.skip(process.env.TANTALAR_E2E_ONBOARDING !== "1", "Run with TANTALAR_E2E_ONBOARDING=1 for a fresh setup fixture.");
  await page.goto("/");
  await page.getByLabel("Username").fill("admin");
  await page.getByLabel("Password").fill("password-admin-1");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Administrator account", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Choose your frontend" })).toBeVisible();
  await expect(page.getByRole("radio", { name: "Control only", exact: true })).toBeChecked();
  for (const width of [390, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
    await page.screenshot({ path: `../artifacts/onboarding-dark-${width}.png`, fullPage: true });
  }
  await page.getByRole("button", { name: "Continue", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "Libraries", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Save and exit" }).click();
  await expect(page.getByTestId("control-page-overview")).toBeVisible();
  await page.reload();
  await expect(page.getByRole("heading", { name: "Libraries", exact: true })).toBeVisible();
  for (const heading of ["Libraries", "Acquisition", "Metadata", "First title"]) {
    await expect(page.getByRole("heading", { name: heading, exact: true, level: 1 })).toBeVisible();
    await page.getByRole("button", { name: "Leave for later" }).click();
  }
  await expect(page.getByRole("heading", { name: "Review setup" })).toBeVisible();
  await expect(page.getByText("Backend capability check passed.")).toBeVisible();
  await page.screenshot({ path: "../artifacts/onboarding-control-review.png", fullPage: true });
  await page.getByRole("button", { name: "Finish setup" }).click();
  await expect(page.getByTestId("control-page-overview")).toBeVisible();
  await expect(page.getByRole("button", { name: "Back to Media" })).toHaveCount(0);
  await page.goto("/#/home");
  await expect(page.getByTestId("control-page-overview")).toBeVisible();
  await page.reload();
  await expect(page.getByTestId("control-page-overview")).toBeVisible();

  for (const scheme of ["light", "dark"] as const) {
    await page.goto("/#/admin/system/appearance");
    await page.getByTestId("scheme-select").selectOption(scheme);
    if (scheme === "dark") await page.getByRole("button", { name: "Use Graphite theme" }).click();
    await page.getByRole("button", { name: "Setup", exact: true }).click();
    await page.getByRole("button", { name: /^Choose your frontend/ }).click();
    await expect(page.getByRole("heading", { name: "Choose your frontend" })).toBeVisible();
    await page.screenshot({ path: `../artifacts/onboarding-${scheme === "dark" ? "preset" : "light"}.png`, fullPage: true });
    await page.getByRole("button", { name: "Save and exit" }).click();
    await expect(page.getByTestId("control-page-overview")).toBeVisible();
  }
  await page.goto("/#/admin/system/frontend");
  await page.getByRole("switch", { name: "Enable Tantalar Media" }).click();
  await expect(page.getByRole("switch", { name: "Enable Tantalar Media" })).toBeChecked();
  await page.getByRole("button", { name: "Back to Media" }).click();
  await expect(page.getByTestId("home-page")).toBeVisible();

  // Verify the optional player against the generated-video fixture, not a network provider.
  const login = await page.request.post("/api/v1/auth/login", { data: { username: "admin", password: "password-admin-1" } });
  const { csrfToken } = await login.json();
  const library = await (await page.request.get("/api/v1/library")).json();
  expect(library.items.length).toBeGreaterThan(0);
  await page.request.put("/api/v1/onboarding/preferences", { headers: { "x-csrf-token": csrfToken }, data: { currentStep: "playback", titleFileId: library.items[0].fileId } });
  await page.goto("/#/setup");
  const video = page.getByLabel("Video player");
  await expect(video).toBeVisible();
  await video.evaluate((element: HTMLVideoElement) => element.play());
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.currentTime)).toBeGreaterThan(1);
  await page.getByRole("button", { name: "Check playback" }).click();
  await expect(page.getByRole("button", { name: "Playback Verified", exact: true })).toBeVisible();
  await page.getByRole("button", { name: /^Review setup/ }).click();
  await expect(page.getByText("The browser reported playback progress for the selected title.")).toBeVisible();
});
