import { afterAll, beforeAll, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate, openDatabase } from "@tantalar/db";
import { AuthService } from "../apps/server/src/auth.js";
import { EventBus } from "../apps/server/src/events.js";
import { ServiceContainer } from "../apps/server/src/container.js";
import type { Supervisor } from "../apps/server/src/supervisor.js";
import { buildServer } from "../apps/server/src/http.js";
import { OnboardingService } from "../apps/server/src/onboarding.js";

const dir = mkdtempSync(join(tmpdir(), "tantalar-setup-checks-"));
const db = await openDatabase({ dialect: "sqlite", sqlitePath: join(dir, "test.db") });
let app: Awaited<ReturnType<typeof buildServer>>;
let headers: Record<string, string>;
let metadataMode = "fixture";
let downloadState = "downloading";
let positionMs = 0;
let downloadsCreated = 0;

beforeAll(async () => {
  await migrate(db);
  const auth = new AuthService(db);
  await auth.createInitialAdmin("admin", "password-admin-1");
  app = await buildServer({ db, auth, bus: new EventBus(db), container: new ServiceContainer(), supervisor: { list: () => [] } as unknown as Supervisor, ready: () => true });
  app.get("/api/v1/libraries/validate", async () => ({ results: [{ library: { id: "library", enabled: true }, ok: true }] }));
  app.get("/api/v1/acquisition/usenet", async () => ({ ready: true, downloadRoots: [dir], servers: [{ id: "server" }] }));
  app.post("/api/v1/acquisition/usenet/test", async () => ({ ok: true }));
  app.get("/api/v1/indexers", async () => ({ indexers: [{ id: "indexer", enabled: true, protocol: "newznab" }] }));
  app.post("/api/v1/indexers/indexer/test", async () => ({ ok: true }));
  app.get("/api/v1/acquisition/metadata", async () => ({ mode: metadataMode }));
  app.get("/api/v1/acquisition/search", async () => ({ candidates: [{ title: "Alien" }] }));
  app.get("/api/v1/catalog", async () => ({ items: [{ fileId: "file", itemKey: "title", method: "copy" }] }));
  app.get("/api/v1/queue", async () => ({ jobs: [{ jobId: "job", itemKey: "title", state: downloadState }] }));
  app.post("/api/v1/queue", async () => { downloadsCreated++; return {}; });
  app.get("/api/v1/library/file/resume", async () => ({ resumePoint: { positionMs } }));
  const login = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username: "admin", password: "password-admin-1" } });
  headers = { cookie: login.cookies.map(cookie => `${cookie.name}=${cookie.value}`).join("; "), "x-csrf-token": login.json().csrfToken };
});
afterAll(async () => { await app.close(); await db.destroy(); rmSync(dir, { recursive: true, force: true }); });

it("checks provider, download, import and playback evidence independently without starting a download", async () => {
  const preferences = await app.inject({ method: "PUT", url: "/api/v1/onboarding/preferences", headers,
    payload: { mediaEnabled: true, acquisitionMode: "usenet", metadataQuery: "Alien", titleFileId: "file", downloadJobId: "job" } });
  expect(preferences.statusCode).toBe(200);
  const check = async (id: string) => {
    const result = await app.inject({ method: "POST", url: `/api/v1/onboarding/steps/${id}`, headers, payload: { action: "complete" } });
    expect(result.statusCode).toBe(200);
    return result.json();
  };
  await check("administrator"); await check("experience");
  expect((await check("libraries")).steps.libraries.status).toBe("done");
  expect((await check("acquisition")).steps.acquisition).toMatchObject({ status: "done", detail: expect.stringContaining("not yet verified") });
  expect((await check("metadata")).steps.metadata.status).toBe("failed");
  metadataMode = "hosted";
  expect((await check("metadata")).steps.metadata.status).toBe("done");
  expect((await check("first-title")).steps["first-title"].status).toBe("failed");
  downloadState = "completed";
  expect((await check("first-title")).steps["first-title"]).toMatchObject({ status: "done", detail: expect.stringContaining("Import and catalog") });
  expect((await check("playback")).steps.playback.status).toBe("failed");
  positionMs = 1000;
  expect((await check("playback")).steps.playback.status).toBe("done");
  expect((await check("final-health")).complete).toBe(true);
  expect(downloadsCreated).toBe(0);
});

it("does not save a check against choices changed in another tab", async () => {
  const service = new OnboardingService(db);
  const snapshot = await service.getState();
  await service.preferences({ metadataQuery: "Arrival" });
  await expect(service.setStep("metadata", "complete", { status: "done" }, snapshot)).rejects.toMatchObject({ statusCode: 409 });
});
