import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  globalSetup: "./e2e/global-setup.ts",
  timeout: 60_000,
  use: {
    baseURL: process.env.TANTALAR_WEB_URL ?? "http://127.0.0.1:5173",
    launchOptions: {
      ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
    },
    trace: "retain-on-failure",
  },
  webServer: process.env.TANTALAR_WEB_URL
    ? undefined
    : {
        command: "pnpm --filter @tantalar/web exec vite --host 127.0.0.1 --port 5173 --strictPort",
        env: { TANTALAR_API: `http://127.0.0.1:${process.env.TANTALAR_API_PORT ?? 3199}` },
        url: "http://127.0.0.1:5173",
        reuseExistingServer: true,
        timeout: 120_000,
      },
});
