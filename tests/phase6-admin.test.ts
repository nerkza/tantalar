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
let adminCookie = "";
let adminCsrf = "";

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
  await auth.createUser("admin", "password-admin-1", "admin");
  await auth.createUser("viewer", "password-viewer-1", "viewer");

  // Admin session.
  const res = await fetch(`${address}/api/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "password-admin-1" }),
  });
  const setCookie = res.headers.getSetCookie?.() ?? [];
  adminCookie = setCookie.map((c) => c.split(";")[0]).join("; ");
  adminCsrf = ((await res.json()) as { csrfToken: string }).csrfToken;
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

describe("admin API security boundaries", () => {
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
    const res = await fetch(`${address}/api/v1/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "viewer", password: "password-viewer-1" }),
    });
    const setCookie = res.headers.getSetCookie?.() ?? [];
    const cookie = setCookie.map((c) => c.split(";")[0]).join("; ");
    const csrf = ((await res.json()) as { csrfToken: string }).csrfToken;
    const usersRes = await fetch(`${address}/api/v1/users`, {
      headers: { cookie, "x-csrf-token": csrf },
    });
    expect(usersRes.status).toBe(403);
  });
});

describe("users + preferences + themes", () => {
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
    const [adminRow] = await db.selectFrom("users").select("id").where("username", "=", "admin").execute();
    const uid = adminRow!.id;
    await adminFetch(`/api/v1/users/${uid}/ui-preferences`, {
      method: "PUT",
      body: JSON.stringify({ preferences: { gridDensity: "comfortable", hiddenColumns: ["state"] } }),
    });
    const res = await adminFetch(`/api/v1/users/${uid}/ui-preferences`);
    const body = (await res.json()) as { preferences: Record<string, unknown> };
    expect(body.preferences.gridDensity).toBe("comfortable");
    expect(body.preferences.hiddenColumns).toEqual(["state"]);
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
