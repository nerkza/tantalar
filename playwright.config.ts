import { defineConfig } from "@playwright/test";
const webPort = process.env.TANTALAR_WEB_PORT ?? "5173";

export default defineConfig({
  testDir: "./e2e",
  globalSetup: "./e2e/global-setup.ts",
  timeout: 60_000,
  use: {
    baseURL: process.env.TANTALAR_WEB_URL ?? `http://127.0.0.1:${webPort}`,
    launchOptions: {
      ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
    },
    trace: "retain-on-failure",
  },
  webServer: process.env.TANTALAR_WEB_URL
    ? undefined
    : {
        command: `pnpm --filter @tantalar/web exec vite --host 127.0.0.1 --port ${webPort} --strictPort`,
        env: { TANTALAR_API: `http://127.0.0.1:${process.env.TANTALAR_API_PORT ?? 3199}` },
        url: `http://127.0.0.1:${webPort}`,
        reuseExistingServer: true,
        timeout: 120_000,
      },
});
