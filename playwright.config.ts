import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  globalSetup: "./e2e/global-setup.ts",
  timeout: 60_000,
  use: {
    baseURL: process.env.TANTALAR_WEB_URL ?? "http://127.0.0.1:5173",
    launchOptions: {
      executablePath: process.env.CHROMIUM_PATH ?? "/usr/bin/chromium",
    },
    trace: "retain-on-failure",
  },
  webServer: process.env.TANTALAR_WEB_URL
    ? undefined
    : {
        command: "pnpm --filter @tantalar/web exec vite --port 5173 --strictPort",
        url: "http://127.0.0.1:5173",
        reuseExistingServer: true,
        timeout: 120_000,
      },
});
