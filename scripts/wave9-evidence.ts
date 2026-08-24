/**
 * Wave 9 visual evidence: boots its own server (same recipe as the Playwright
 * global setup) plus a vite dev server, then captures screenshots of the new
 * operations surfaces at desktop and mobile widths.
 * Run: npx tsx scripts/wave9-evidence.ts
 */
import { chromium } from "@playwright/test";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Kysely } from "kysely";
import { migrate, openDatabase, type Db } from "../packages/db/dist/index.js";
import { EventBus } from "../apps/server/src/events.js";
import { ServiceContainer } from "../apps/server/src/container.js";
import { Scheduler } from "../apps/server/src/scheduler.js";
import { Supervisor } from "../apps/server/src/supervisor.js";
import { AuthService } from "../apps/server/src/auth.js";
import { buildServer } from "../apps/server/src/http.js";

const API_PORT = 3377;
const WEB_PORT = 5198;
const OUT = "/srv/projects/artifacts";

async function main() {
  mkdirSync(OUT, { recursive: true });
  const dir = mkdtempSync(join(tmpdir(), "tantalar-wave9-ev-"));
  const db: Kysely<Db> = await openDatabase({ dialect: "sqlite", sqlitePath: join(dir, "t.db") });
  await migrate(db);
  const bus = new EventBus(db);
  const container = new ServiceContainer();
  container.register({ pluginId: "core", capability: "dev.tantalar.capability.event.emit", invoke: async () => ({ ok: true }) });
  const supervisor = new Supervisor({
    bus,
    container,
    scheduler: new Scheduler(db),
    restartPolicy: { initialBackoffMs: 100, maxBackoffMs: 500, backoffMultiplier: 2, windowMs: 10_000, maxRestartsInWindow: 5 },
    resolveEntry: () => ({ command: "true", args: [], env: {} }),
  });
  const auth = new AuthService(db);
  const app = await buildServer({
    auth,
    db,
    bus,
    supervisor,
    container,
    ready: () => true,
    ops: { auth, db, bus, supervisor, container, ready: () => true, sqlitePath: join(dir, "t.db"), dataDir: dir },
  });
  await app.listen({ port: API_PORT, host: "127.0.0.1" });
  await auth.createUser("admin", "password-admin-1", "admin");

  // Seed one durable download job + audit entries so the views show data.
  const { DownloadJobStore } = await import("../packages/db/dist/index.js");
  const jobs = new DownloadJobStore(db);
  const { record } = await jobs.create({
    itemKey: "series.evidence",
    title: "Evidence Episode S01E01",
    source: "torrent",
    providerPluginId: "dev.tantalar.plugin.torrent-native",
    sourceRef: "magnet:?xt=urn:btih:evidence",
  });
  await jobs.updateProgress(record.jobId, { state: "downloading", progressPercent: 63 });

  // Vite dev server proxying /api to the booted API.
  const webRoot = resolve("apps/web");
  const vite = spawn(process.execPath, [resolve("node_modules/vite/bin/vite.js"), "--port", String(WEB_PORT), "--strictPort"], {
    cwd: webRoot,
    env: { ...process.env, TANTALAR_API: `http://127.0.0.1:${API_PORT}` },
    stdio: "ignore",
  });
  // Wait for the vite proxy to answer (API up first, so this settles fast).
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    try {
      const res = await fetch(`http://127.0.0.1:${WEB_PORT}/api/v1/bootstrap/status`);
      if (res.ok) break;
    } catch { /* retry */ }
  }

  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? "/usr/bin/chromium" });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto(`http://127.0.0.1:${WEB_PORT}/`);
  await page.getByLabel("Username").fill("admin");
  await page.getByLabel("Password").fill("password-admin-1");
  await page.getByRole("button", { name: "Sign in" }).click();
  // The sign-in click triggers API calls through the fresh vite proxy; give
  // the SPA time to land on Home before asserting.
  await page.waitForTimeout(3000);
  // Debug: capture whatever state the page is in.
  await page.screenshot({ path: `${OUT}/wave9-debug-signin.png` });
  // The Home view may show a truthful error state when the serving plugin
  // is not mounted in this evidence harness; wait for the shell instead.
  await page.waitForSelector('nav, [aria-label="Main navigation"]', { timeout: 30_000 });
  await page.waitForTimeout(1000);

  const shot = async (name: string) => {
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${OUT}/${name}.png` });
    console.log(`captured ${name}`);
  };
  const clickTab = async (label: string) => {
    await page.evaluate((n) => {
      for (const t of document.querySelectorAll('[role="tab"]')) {
        if (t.textContent?.trim() === n) { (t as HTMLElement).click(); break; }
      }
    }, label);
    await page.waitForTimeout(400);
  };

  await page.evaluate(() => { window.location.hash = "/admin"; });
  await page.waitForSelector('[role="tab"]', { timeout: 15_000 });
  await shot("wave9-admin-queue");

  await clickTab("Audit");
  await shot("wave9-admin-audit");

  await page.evaluate(() => { window.location.hash = "/settings"; });
  await page.waitForSelector('[data-testid="settings-page"]', { timeout: 15_000 });
  await clickTab("Integrations");
  await shot("wave9-settings-integrations");

  await clickTab("System");
  await shot("wave9-settings-system");

  // Mobile 320px admin.
  const mobile = await browser.newPage({ viewport: { width: 320, height: 640 } });
  await mobile.goto(`http://127.0.0.1:${WEB_PORT}/`);
  await mobile.getByLabel("Username").fill("admin");
  await mobile.getByLabel("Password").fill("password-admin-1");
  await mobile.getByRole("button", { name: "Sign in" }).click();
  await mobile.waitForTimeout(2500);
  await mobile.evaluate(() => { window.location.hash = "/admin"; });
  await mobile.waitForTimeout(700);
  await mobile.screenshot({ path: `${OUT}/wave9-mobile-320-admin.png` });
  console.log("captured wave9-mobile-320-admin");

  await browser.close();
  vite.kill();
  await app.close().catch(() => undefined);
  await db.destroy().catch(() => undefined);
}

void main();
