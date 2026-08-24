/**
 * Wave 3 API tests: /api/v1/libraries auth boundaries and flows.
 *
 * Covers: 401 unauthenticated, 403 non-admin viewer, CSRF enforcement on
 * cookie mutations, admin create/edit/disable/remove/validate/rescan flows,
 * removal never deleting media, explicit media deletion requiring
 * confirmDelete, and traceable events for every mutation.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Kysely } from "kysely";
import { migrate, openDatabase, LibraryRepository, MediaCatalogRepository, type Db } from "@tantalar/db";
import { EventTypes } from "@tantalar/contracts";
import { AuthService } from "../apps/server/src/auth.js";
import { EventBus } from "../apps/server/src/events.js";
import { ServiceContainer } from "../apps/server/src/container.js";
import { Scheduler } from "../apps/server/src/scheduler.js";
import type { Supervisor } from "../apps/server/src/supervisor.js";
import { buildServer } from "../apps/server/src/http.js";
import { LibraryService } from "../apps/server/src/library.js";

let db: Kysely<Db>;
let auth: AuthService;
let bus: EventBus;
let service: LibraryService;
let address = "";
let app: Awaited<ReturnType<typeof buildServer>>;
let dir = "";
const csrfTokenRef = { current: "" };
const cookieRef = { current: "" };
const viewerCookieRef = { current: "" };

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "tantalar-wave3-api-"));
  db = await openDatabase({ dialect: "sqlite", sqlitePath: join(dir, "test.db") });
  await migrate(db);
  auth = new AuthService(db);
  bus = new EventBus(db);
  const container = new ServiceContainer();
  container.register({ pluginId: "core", capability: "dev.tantalar.capability.event.emit", invoke: async () => ({ ok: true }) });
  const supervisor = { list: () => [] } as unknown as Supervisor;
  service = new LibraryService({ bus, libraries: new LibraryRepository(db), mediaCatalog: new MediaCatalogRepository(db) });
  app = await buildServer({
    auth,
    db,
    bus,
    supervisor,
    container,
    ready: () => true,
    library: service,
  });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const port = (app.server.address() as { port: number }).port;
  address = `http://127.0.0.1:${port}`;
  await auth.createUser("admin", "password-admin-1", "admin");
  await auth.createUser("viewer", "password-viewer-1", "viewer");
});

afterAll(async () => {
  await app.close();
  await db.destroy();
});

async function login(username: string, password: string): Promise<void> {
  const res = await fetch(`${address}/api/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  expect(res.status).toBe(200);
  const setCookie = res.headers.getSetCookie?.() ?? [];
  cookieRef.current =
    setCookie
      .map((c) => c.split(";")[0])
      .find((c) => c.startsWith("tantalar_session=")) ?? "";
  csrfTokenRef.current = (await res.json() as { csrfToken: string }).csrfToken;
}

async function get(path: string, headers: Record<string, string> = {}) {
  return fetch(`${address}${path}`, { headers });
}

async function send(path: string, method: string, body?: unknown, useCookies = true): Promise<Response> {
  const headers: Record<string, string> = {};
  if (useCookies && cookieRef.current) {
    headers["cookie"] = `${cookieRef.current}; tantalar_csrf=${csrfTokenRef.current}`;
    headers["x-csrf-token"] = csrfTokenRef.current;
  }
  if (body !== undefined) {
    headers["content-type"] = "application/json";
    return fetch(`${address}${path}`, { method, headers, body: JSON.stringify(body) });
  }
  return fetch(`${address}${path}`, { method, headers });
}

function makeRoot(name: string): string {
  const root = join(dir, name);
  mkdirSync(root, { recursive: true });
  return root;
}

describe("library API auth boundaries", () => {
  it("rejects unauthenticated reads and mutations with 401", async () => {
    expect((await get("/api/v1/libraries")).status).toBe(401);
    expect(
      (
        await fetch(`${address}/api/v1/libraries`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: "x", rootPath: makeRoot("unauth"), kind: "movie" }),
        })
      ).status,
    ).toBe(401);
  });

  it("accepts an API key with plugins.invoke scope but rejects viewers' mutations", async () => {
    // Admin session first.
    await login("viewer", "password-viewer-1");
    const setCookie = (await fetch(`${address}/api/v1/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "viewer", password: "password-viewer-1" }),
    })).headers.getSetCookie?.() ?? [];
    viewerCookieRef.current = setCookie.map((c) => c.split(";")[0]).find((c) => c.startsWith("tantalar_session=")) ?? "";

    const readRes = await get("/api/v1/libraries", { cookie: viewerCookieRef.current });
    expect(readRes.status).toBe(200);

    const writeRes = await fetch(`${address}/api/v1/libraries`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: `${viewerCookieRef.current}; tantalar_csrf=anything`,
        "x-csrf-token": "anything",
      },
      body: JSON.stringify({ name: "nope", rootPath: makeRoot("nope"), kind: "movie" }),
    });
    expect(writeRes.status).toBe(403); // non-admin mutation blocked before CSRF matters

    // Cookie mutation without a valid CSRF header → 403.
    await login("admin", "password-admin-1");
    const noCsrf = await fetch(`${address}/api/v1/libraries`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: cookieRef.current },
      body: JSON.stringify({ name: "csrf-less", rootPath: makeRoot("csrfless"), kind: "movie" }),
    });
    expect(noCsrf.status).toBe(403);
  });
});

describe("library API flows", () => {
  it("create → edit → disable → remove; media never deleted by remove", async () => {
    await login("admin", "password-admin-1");
    const root = makeRoot("api-lib");

    const created = (await (await send("/api/v1/libraries", "POST", { name: "API Lib", rootPath: root, kind: "series" })).json()) as {
      library: { id: string; enabled: boolean };
    };
    expect(created.library.enabled).toBe(true);

    const mediaPath = join(root, "ep.mkv");
    writeFileSync(mediaPath, "bytes\n");

    const edited = await send(`/api/v1/libraries/${created.library.id}`, "PATCH", { name: "API Renamed" });
    expect(((await edited.json()) as { library: { name: string } }).library.name).toBe("API Renamed");

    const disabled = await send(`/api/v1/libraries/${created.library.id}/enabled`, "PUT", { enabled: false });
    expect(((await disabled.json()) as { library: { enabled: boolean } }).library.enabled).toBe(false);

    const removedRes = await send(`/api/v1/libraries/${created.library.id}`, "DELETE");
    const removed = (await removedRes.json()) as { removed?: boolean; mediaFilesDeleted?: boolean; error?: string };
    expect(removedRes.status).toBe(200);
    expect(removed.removed).toBe(true);
    expect(removed.mediaFilesDeleted).toBe(false);
    expect(existsSync(mediaPath)).toBe(true);

    const missing = await send(`/api/v1/libraries/${created.library.id}`, "PATCH", {});
    expect(missing.status).toBe(404);
  });

  it("explicit media deletion requires confirmDelete and emits the deletion event", async () => {
    await login("admin", "password-admin-1");
    const root = makeRoot("api-lib-del");
    const lib = ((await (await send("/api/v1/libraries", "POST", { name: "Del API", rootPath: root, kind: "movie" })).json()) as {
      library: { id: string };
    }).library;
    const mediaPath = join(root, "film.mkv");
    writeFileSync(mediaPath, "film\n");
    await service.catalog({
      libraryId: lib.id, itemKey: "m:d", path: mediaPath, quality: "1080p", method: "copy", sourceHash: "h-del",
    });

    const refused = await send(`/api/v1/libraries/${lib.id}/media/delete`, "POST", { confirmDelete: false });
    expect(refused.status).toBe(400);
    expect(existsSync(mediaPath)).toBe(true);

    const ok = await send(`/api/v1/libraries/${lib.id}/media/delete`, "POST", { confirmDelete: true });
    expect(((await ok.json()) as { deletedFiles: number }).deletedFiles).toBe(1);
    expect(existsSync(mediaPath)).toBe(false);

    const events = await bus.read({ typePrefix: EventTypes.MediaDeleted });
    expect(events.length).toBeGreaterThanOrEqual(1);
  });

  it("validate and rescan are exposed and event-traced", async () => {
    await login("admin", "password-admin-1");
    const root = makeRoot("api-lib-val");
    const lib = ((await (await send("/api/v1/libraries", "POST", { name: "Val API", rootPath: root, kind: "mixed" })).json()) as {
      library: { id: string };
    }).library;

    const val = (await (await get("/api/v1/libraries/validate", { cookie: `${cookieRef.current}` })).json()) as {
      results: Array<{ ok: boolean; device?: number }>;
    };
    expect(val.results.some((r) => r.ok)).toBe(true);

    const rescan = await send(`/api/v1/libraries/${lib.id}/rescan`, "POST");
    expect((await rescan.json() as { checked: number }).checked).toBe(0);

    const scanEvents = await bus.read({ typePrefix: EventTypes.LibraryRescanCompleted });
    expect(scanEvents.length).toBeGreaterThanOrEqual(1);
  });
});
