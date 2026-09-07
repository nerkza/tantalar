/**
 * Phase 6 admin API tests (stories 25–27 server side): users management,
 * ui-preferences, theme storage with malicious-CSS rejection, system health.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate, openDatabase, type Db } from "@tantalar/db";
import { Kysely } from "kysely";
import { AuthService } from "../apps/server/src/auth.js";
import { EventBus } from "../apps/server/src/events.js";
import { ServiceContainer } from "../apps/server/src/container.js";
import { Scheduler } from "../apps/server/src/scheduler.js";
import type { Supervisor } from "../apps/server/src/supervisor.js";
import { buildServer } from "../apps/server/src/http.js";
import { sanitizeThemeTokens } from "../apps/server/src/admin.js";

let db: Kysely<Db>;
let auth: AuthService;
let bus: EventBus;
let address = "";
let app: Awaited<ReturnType<typeof buildServer>>;
let adminId = "";
let viewerId = "";
let adminCookie = "";
let adminCsrf = "";
let viewerCookie = "";
let viewerCsrf = "";

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), "tantalar-admin-"));
  db = await openDatabase({ dialect: "sqlite", sqlitePath: join(dir, "test.db") });
  await migrate(db);
  auth = new AuthService(db);
  bus = new EventBus(db);
  const container = new ServiceContainer();
  const supervisor = { list: () => [] } as unknown as Supervisor;
  app = await buildServer({ auth, db, bus, supervisor, container, ready: () => true });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const port = (app.server.address() as { port: number }).port;
  address = `http://127.0.0.1:${port}`;
  adminId = await auth.createUser("admin", "password-admin-1", "admin");
  viewerId = await auth.createUser("viewer", "password-viewer-1", "viewer");

  // Admin session.
  const res = await fetch(`${address}/api/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "password-admin-1" }),
  });
  const setCookie = res.headers.getSetCookie?.() ?? [];
  adminCookie = setCookie.map((c) => c.split(";")[0]).join("; ");
  adminCsrf = ((await res.json()) as { csrfToken: string }).csrfToken;

  const viewerRes = await fetch(`${address}/api/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "viewer", password: "password-viewer-1" }),
  });
  viewerCookie = (viewerRes.headers.getSetCookie?.() ?? []).map((cookie) => cookie.split(";")[0]).join("; ");
  viewerCsrf = ((await viewerRes.json()) as { csrfToken: string }).csrfToken;
});

afterAll(async () => {
  await app.close();
  await db.destroy();
});

async function adminFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const headers: Record<string, string> = {
    cookie: adminCookie,
    "x-csrf-token": adminCsrf,
    ...((init.headers as Record<string, string>) ?? {}),
  };
  // Only send a JSON content-type when there is a body (Fastify rejects
  // empty bodies that declare application/json).
  if (init.body !== undefined) headers["content-type"] = "application/json";
  return fetch(`${address}${path}`, { ...init, headers });
}

async function viewerFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const headers: Record<string, string> = {
    cookie: viewerCookie,
    "x-csrf-token": viewerCsrf,
    ...((init.headers as Record<string, string>) ?? {}),
  };
  if (init.body !== undefined) headers["content-type"] = "application/json";
  return fetch(`${address}${path}`, { ...init, headers });
}

describe("admin API security boundaries", () => {
  it("persists bounded notification history per account with filtering, deduplication and CSRF", async () => {
    const path = "/api/v1/notifications";
    const notice = { id: "notice-one", severity: "error", title: "Download failed", message: "Retry the download.", count: 1, createdAt: "2026-09-06T12:00:00.000Z" };
    expect((await fetch(`${address}${path}`)).status).toBe(401);
    expect((await fetch(`${address}${path}`, { method: "POST", headers: { cookie: adminCookie, "content-type": "application/json" }, body: JSON.stringify(notice) })).status).toBe(403);
    expect((await adminFetch(path, { method: "POST", body: JSON.stringify(notice) })).status).toBe(200);
    expect((await adminFetch(path, { method: "POST", body: JSON.stringify({ ...notice, count: 2 }) })).status).toBe(200);
    expect(await (await adminFetch(`${path}?search=download&filter_severity=error`)).json()).toMatchObject({ total: 1, items: [{ id: "notice-one", count: 2 }] });
    expect(await (await viewerFetch(path)).json()).toMatchObject({ total: 0 });
    expect((await viewerFetch(path, { method: "POST", body: JSON.stringify({ ...notice, title: "Viewer notice" }) })).status).toBe(200);
    expect(await (await viewerFetch(path)).json()).toMatchObject({ total: 1, items: [{ title: "Viewer notice" }] });
    expect(await (await adminFetch(path)).json()).toMatchObject({ total: 1 });
    expect((await adminFetch(path, { method: "POST", body: JSON.stringify({ ...notice, id: "../invalid" }) })).status).toBe(400);
    const entries = Array.from({ length: 500 }, (_, index) => ({ pluginId: "dev.tantalar.core.notification-history", docKey: `${adminId}:retained-${index}`, doc: JSON.stringify({ ...notice, id: `retained-${index}`, createdAt: "2026-09-06T13:00:00.000Z" }), updatedAt: "2026-09-06T13:00:00.000Z" }));
    await db.insertInto("plugin_documents").values(entries).execute();
    await adminFetch(path, { method: "POST", body: JSON.stringify({ ...notice, id: "latest", createdAt: "2026-09-06T14:00:00.000Z" }) });
    const page = await (await adminFetch(`${path}?pageSize=2`)).json() as { items: { id: string }[]; total: number };
    expect(page.total).toBe(500);
    expect(page.items).toHaveLength(2);
    expect(page.items[0]?.id).toBe("latest");
  });
  it("rejects unauthenticated access", async () => {
    expect((await fetch(`${address}/api/v1/users`)).status).toBe(401);
    expect((await fetch(`${address}/api/v1/themes`)).status).toBe(401);
    expect((await fetch(`${address}/api/v1/system/health`)).status).toBe(401);
  });

  it("rejects cookie mutation without CSRF", async () => {
    const res = await fetch(`${address}/api/v1/themes`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: adminCookie },
      body: JSON.stringify({ name: "x", tokens: {} }),
    });
    expect(res.status).toBe(403);
  });

  it("rejects non-admin viewers with 403", async () => {
    const usersRes = await viewerFetch("/api/v1/users");
    expect(usersRes.status).toBe(403);
  });
});

describe("users + preferences + themes", () => {
  it("stores private profile pictures, rejects unsafe uploads, and pages people", async () => {
    const path = `/api/v1/users/${viewerId}/avatar`;
    expect((await fetch(`${address}${path}`)).status).toBe(401);
    expect((await viewerFetch(`/api/v1/users/${adminId}/avatar`, { method: "PUT", body: JSON.stringify({ preset: "cat" }) })).status).toBe(403);
    expect((await fetch(`${address}${path}`, { method: "PUT", headers: { cookie: viewerCookie, "content-type": "application/json" }, body: JSON.stringify({ preset: "cat" }) })).status).toBe(403);
    expect((await viewerFetch(path, { method: "PUT", body: JSON.stringify({ preset: "cat" }) })).status).toBe(200);
    const profile = await (await viewerFetch(`/api/v1/users/${viewerId}/profile`)).json() as { user: { avatar: { preset: string } } };
    expect(profile.user.avatar.preset).toBe("cat");
    expect((await viewerFetch(`/api/v1/users/${adminId}/profile`)).status).toBe(403);
    for (const body of [{ preset: "unknown" }, { image: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>').toString("base64") }, { image: "bm90LWFuLWltYWdl" }, { image: "A".repeat(2_796_208) }]) {
      expect((await viewerFetch(path, { method: "PUT", body: JSON.stringify(body) })).status).toBe(400);
    }
    const png = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEklEQVQImWMwTptpnDaTAUIBAB/uBMm6iK1UAAAAAElFTkSuQmCC";
    const upload = await viewerFetch(path, { method: "PUT", body: JSON.stringify({ image: png }) });
    expect(upload.status).toBe(200);
    const uploaded = await upload.json() as { avatar: { url: string; preset: null } };
    expect(uploaded.avatar.preset).toBeNull();
    const image = await adminFetch(uploaded.avatar.url);
    expect(image.headers.get("content-type")).toBe("image/webp");
    expect(Buffer.from(await image.arrayBuffer()).toString("ascii", 8, 12)).toBe("WEBP");
    expect((await db.selectFrom("users").select("avatar").where("id", "=", viewerId).executeTakeFirst())?.avatar).toMatch(/^data:image\/webp;base64,/);
    const list = await (await adminFetch("/api/v1/users?search=viewer&pageSize=1")).json() as { users: Array<{ username: string; active: boolean; avatar: { url: string } }>; total: number };
    expect(list.users).toHaveLength(1);
    expect(list.users[0]).toMatchObject({ username: "viewer", active: true, avatar: uploaded.avatar });
    expect(list.total).toBe(1);
    expect((await adminFetch(`/api/v1/users/${viewerId}/avatar`, { method: "PUT", body: JSON.stringify({ preset: "owl" }) })).status).toBe(200);
    expect((await viewerFetch(path)).status).toBe(404);
  });
  it("creates a viewer user and lists users", async () => {
    const res = await adminFetch("/api/v1/users", {
      method: "POST",
      body: JSON.stringify({ username: "kid", password: "password-kid-123", role: "viewer" }),
    });
    expect(res.status).toBe(201);
    const list = await adminFetch("/api/v1/users");
    const users = ((await list.json()) as { users: Array<{ username: string }> }).users;
    expect(users.some((u) => u.username === "kid")).toBe(true);
  });

  it("persists and returns ui-preferences (grid layout persistence)", async () => {
    await adminFetch(`/api/v1/users/${adminId}/ui-preferences`, {
      method: "PUT",
      body: JSON.stringify({ preferences: { gridDensity: "comfortable", hiddenColumns: ["state"], themeId: "blue" } }),
    });
    const updated = await adminFetch(`/api/v1/users/${adminId}/ui-preferences`, {
      method: "PUT",
      body: JSON.stringify({ preferences: { notifications: { enabled: true, durations: { success: 5_000 } } } }),
    });
    const updatedBody = await updated.json() as { saved: boolean; preferences: Record<string, unknown> };
    expect(updatedBody.saved).toBe(true);
    expect(updatedBody.preferences.themeId).toBe("blue");
    const res = await adminFetch(`/api/v1/users/${adminId}/ui-preferences`);
    const body = (await res.json()) as { preferences: Record<string, unknown> };
    expect(body.preferences.gridDensity).toBe("comfortable");
    expect(body.preferences.hiddenColumns).toEqual(["state"]);
    expect(body.preferences.notifications).toEqual({ enabled: true, durations: { success: 5_000 } });
    await Promise.all([
      adminFetch(`/api/v1/users/${adminId}/ui-preferences`, { method: "PUT", body: JSON.stringify({ preferences: { "collection:managed": { view: "large", hiddenColumns: ["year"] } } }) }),
      adminFetch(`/api/v1/users/${adminId}/ui-preferences`, { method: "PUT", body: JSON.stringify({ preferences: { "collection:movies": { view: "list" } } }) }),
      adminFetch(`/api/v1/users/${adminId}/ui-preferences`, { method: "PUT", body: JSON.stringify({ preferences: { colorScheme: "light" } }) }),
    ]);
    const combined = await (await adminFetch(`/api/v1/users/${adminId}/ui-preferences`)).json() as { preferences: Record<string, unknown> };
    expect(combined.preferences["collection:managed"]).toEqual({ view: "large", hiddenColumns: ["year"] });
    expect(combined.preferences["collection:movies"]).toEqual({ view: "list" });
    expect(combined.preferences.colorScheme).toBe("light");
  });

  it("allows self preferences, rejects cross-user viewers, and requires CSRF", async () => {
    const withoutCsrf = await fetch(`${address}/api/v1/users/${viewerId}/ui-preferences`, {
      method: "PUT",
      headers: { cookie: viewerCookie, "content-type": "application/json", authorization: "ignored" },
      body: JSON.stringify({ preferences: { notifications: { enabled: true } } }),
    });
    expect(withoutCsrf.status).toBe(403);

    const saved = await viewerFetch(`/api/v1/users/${viewerId}/ui-preferences`, {
      method: "PUT",
      body: JSON.stringify({ preferences: {
        colorScheme: "dark",
        notifications: {
          enabled: true,
          events: { downloads: true, imports: true },
          durations: { error: 12_000 },
        },
      } }),
    });
    expect(saved.status).toBe(200);
    await viewerFetch(`/api/v1/users/${viewerId}/ui-preferences`, {
      method: "PUT",
      body: JSON.stringify({ preferences: { notifications: { events: { downloads: false } } } }),
    });
    const own = await viewerFetch(`/api/v1/users/${viewerId}/ui-preferences`);
    expect(own.status).toBe(200);
    expect((await own.json() as { preferences: Record<string, unknown> }).preferences).toEqual({
      colorScheme: "dark",
      notifications: {
        enabled: true,
        events: { downloads: false, imports: true },
        durations: { error: 12_000 },
      },
    });
    expect((await viewerFetch(`/api/v1/users/${adminId}/ui-preferences`)).status).toBe(403);
    expect((await viewerFetch(`/api/v1/users/${adminId}/ui-preferences`, {
      method: "PUT",
      body: JSON.stringify({ preferences: { notifications: { enabled: false } } }),
    })).status).toBe(403);
    expect((await adminFetch(`/api/v1/users/${viewerId}/ui-preferences`)).status).toBe(200);
  });

  it("rejects invalid notification preferences", async () => {
    const res = await viewerFetch(`/api/v1/users/${viewerId}/ui-preferences`, {
      method: "PUT",
      body: JSON.stringify({ preferences: { notifications: { maxVisible: 6, unknown: true } } }),
    });
    expect(res.status).toBe(400);
  });

  it("stores a theme and rejects malicious CSS token values", async () => {
    const ok = await adminFetch("/api/v1/themes", {
      method: "POST",
      body: JSON.stringify({ name: "blue", tokens: { "--tantalar-color-primary": "#0066ff" } }),
    });
    expect(ok.status).toBe(201);
    const themeId = ((await ok.json()) as { theme: { id: string } }).theme.id;

    for (const bad of [
      "url(javascript:alert(1))",
      "expression(alert(1))",
      "@import 'evil.css'",
      "<script>alert(1)</script>",
      "{position:absolute}",
      "red;background:url(x)",
    ]) {
      const res = await adminFetch("/api/v1/themes", {
        method: "POST",
        body: JSON.stringify({ name: "bad", tokens: { "--tantalar-color-bg": bad } }),
      });
      expect(res.status).toBe(400);
    }

    // Update + delete round-trip.
    const upd = await adminFetch(`/api/v1/themes/${themeId}`, {
      method: "PUT",
      body: JSON.stringify({ name: "blue-2", tokens: { "--tantalar-color-primary": "#0055ee" } }),
    });
    expect(upd.status).toBe(200);
    const del = await adminFetch(`/api/v1/themes/${themeId}`, { method: "DELETE" });
    expect(del.status).toBe(200);
  });

  it("reports system health with plugin list", async () => {
    const res = await adminFetch("/api/v1/system/health");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ready: boolean; plugins: unknown[]; eventCount: number | null };
    expect(body.ready).toBe(true);
    expect(Array.isArray(body.plugins)).toBe(true);
    expect(typeof body.eventCount).toBe("number");
  });
});

describe("sanitizeThemeTokens (server-side mirror)", () => {
  it("mirrors the client sanitizer fail-closed", () => {
    expect(sanitizeThemeTokens({ "--tantalar-space-unit": "8px" })).toEqual({ "--tantalar-space-unit": "8px" });
    expect(() => sanitizeThemeTokens({ "color-bg": "url(http://x)" })).toThrow();
    expect(() => sanitizeThemeTokens("not an object" as unknown as Record<string, string>)).toThrow();
  });
});
