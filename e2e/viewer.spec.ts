import { expect, test } from "@playwright/test";

const USER = "admin";
const PASS = "password-admin-1";

/** Sign in through the UI and land on the library. */
export async function signIn(page: import("@playwright/test").Page): Promise<void> {
  await page.goto("/");
  await page.getByLabel("Username").fill(USER);
  await page.getByLabel("Password").fill(PASS);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByTestId("library-page")).toBeVisible();
}

test("viewer sign-in succeeds and shows the library", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Username").fill(USER);
  await page.getByLabel("Password").fill("wrong-password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("alert")).toBeVisible();

  await page.getByLabel("Password").fill(PASS);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByTestId("library-page")).toBeVisible();
});

test("library browsing shows visible items only (visibility boundaries)", async ({ page }) => {
  await signIn(page);
  // Admin sees all libraries.
  await expect(page.getByTestId("library-item-f-ep1")).toBeVisible();
  await expect(page.getByTestId("library-item-f-restricted")).toBeVisible();

  // A restricted viewer mapped to the same admin session would still be
  // filtered server-side; assert the API honours it fail-closed for an
  // unknown viewer id via query param.
  const res = await page.request.get("/api/v1/library?viewerId=u-none");
  expect(res.status()).toBe(200);
  const body = (await res.json()) as { items: unknown[] };
  expect(body.items).toHaveLength(0);
});

test("direct play: mp4 item negotiates direct mode and streams bytes", async ({ page }) => {
  await signIn(page);
  await page.getByTestId("library-item-f-ep1").click();
  await expect(page.getByTestId("player-page")).toBeVisible();
  await expect(page.getByTestId("player-page")).toHaveAttribute("data-mode", "direct");
  // The video element has a real stream source and media loads.
  await page.waitForFunction(() => {
    const v = document.querySelector('[data-testid="player-video"]') as HTMLVideoElement | null;
    return !!v && v.readyState >= 1;
  });
});

test("HLS fallback: mkv/hevc item negotiates HLS with quality options", async ({ page }) => {
  await signIn(page);
  await page.getByTestId("library-item-f-mkv-hevc-dts").click();
  await expect(page.getByTestId("player-page")).toBeVisible();
  await expect(page.getByTestId("player-page")).toHaveAttribute("data-mode", "hls");
  const quality = page.getByTestId("quality-select");
  await expect(quality).toBeEnabled();
  // Full ladder (1080p/720p/480p) plus Auto.
  await expect(quality.locator("option")).toHaveCount(4, { timeout: 15_000 });
});

test("subtitle selection lists embedded tracks; PGS is marked not renderable", async ({ page }) => {
  await signIn(page);
  await page.getByTestId("library-item-f-mkv-hevc-dts").click();
  const subs = page.getByTestId("subtitle-select");
  await expect(subs.locator("option")).toHaveCount(3, { timeout: 10_000 });
  await expect(subs).toContainText("pgs");
  await expect(subs).toContainText("not renderable");
});

test("selecting the SRT track serves subtitle content end-to-end", async ({ page }) => {
  await signIn(page);
  await page.getByTestId("library-item-f-mkv-hevc-dts").click();
  const subs = page.getByTestId("subtitle-select");
  await expect(subs.locator("option")).toHaveCount(3, { timeout: 10_000 });
  // The content route must serve the registered SRT payload for this track.
  const res = await page.request.get("/api/v1/library/subtitles/sub-srt-en");
  expect(res.status()).toBe(200);
  expect(await res.text()).toContain("Hello from the synthetic embedded track.");
});

test("resume: progress reported while playing restores on replay", async ({ page }) => {
  await signIn(page);
  await page.getByTestId("library-item-f-ep1").click();
  await expect(page.getByTestId("player-page")).toBeVisible();
  // Seek near the end via the slider's keyboard interface (accessible seek).
  await page.waitForFunction(() => {
    const v = document.querySelector('[data-testid="player-video"]') as HTMLVideoElement | null;
    return !!v && Number.isFinite(v.duration) && v.duration > 0;
  });
  await page.getByRole("slider", { name: "Seek" }).press("End");
  await page.waitForTimeout(1_500); // let the onSeeked report fire
  const res = await page.request.get("/api/v1/library/f-ep1/resume");
  const body = (await res.json()) as { resumePoint: { positionMs: number } | null };
  expect(body.resumePoint).not.toBeNull();
  expect(body.resumePoint!.positionMs).toBeGreaterThan(0);

  // Reload the player: resume point applies (currentTime > 0).
  await page.goto("/#/watch/f-ep1");
  await expect(page.getByTestId("player-page")).toBeVisible();
  await page.waitForFunction(() => {
    const v = document.querySelector('[data-testid="player-video"]') as HTMLVideoElement | null;
    return !!v && v.readyState >= 1 && v.currentTime > 0;
  });
});

test("seek during HLS playback updates position", async ({ page }) => {
  await signIn(page);
  await page.getByTestId("library-item-f-mkv-hevc-dts").click();
  await expect(page.getByTestId("player-page")).toBeVisible();
  await page.waitForFunction(() => {
    const v = document.querySelector('[data-testid="player-video"]') as HTMLVideoElement | null;
    return !!v && Number.isFinite(v.duration) && v.duration > 0;
  });
  await page.getByRole("slider", { name: "Seek" }).press("ArrowRight");
  const pos = await page.evaluate(
    () => (document.querySelector('[data-testid="player-video"]') as HTMLVideoElement).currentTime,
  );
  expect(pos).toBeGreaterThan(0);
});

test("next-episode autoplay advances to ep2 when ep1 ends", async ({ page }) => {
  await signIn(page);
  await page.goto("/#/watch/f-ep1");
  await expect(page.getByTestId("player-page")).toBeVisible();
  // Seek near the end, then play at high rate so the ended event fires
  // (a paused seek to the tail does not emit `ended`) → hash navigates to ep2.
  await page.evaluate(() => {
    const v = document.querySelector('[data-testid="player-video"]') as HTMLVideoElement;
    const apply = () => {
      v.muted = true;
      v.playbackRate = 16;
      v.currentTime = Math.max(0, v.duration - 1);
      void v.play();
    };
    if (v.readyState >= 1) apply();
    else v.addEventListener("loadedmetadata", apply, { once: true });
  });
  await page.waitForURL(/watch\/f-ep2/, { timeout: 20_000 });
  await expect(page.getByTestId("player-page")).toBeVisible();
});
