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

let db: Kysely<Db>;
let auth: AuthService;
let bus: EventBus;
let address = "";
let app: Awaited<ReturnType<typeof buildServer>>;
let dir: string;
const csrfTokenRef = { current: "" };
const cookieRef = { current: "" };

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "tantalar-http-"));
  db = await openDatabase({ dialect: "sqlite", sqlitePath: join(dir, "test.db") });
  await migrate(db);
  auth = new AuthService(db);
  bus = new EventBus(db);
  const container = new ServiceContainer();
  container.register({
    pluginId: "core",
    capability: "dev.tantalar.capability.event.emit",
    invoke: async () => ({ ok: true }),
  });
  const supervisor = {
    list: () => [],
  } as unknown as Supervisor;
  app = await buildServer({ auth, bus, supervisor, container, ready: () => true });
  await app.listen({ port: 0, host: "127.0.0.1" });
  address = (app.server.address() as { address: string; port: number }).address.includes(":")
    ? `http://127.0.0.1:${(app.server.address() as { port: number }).port}`
    : `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  await auth.createUser("admin", "password-admin-1", "admin");
});

afterAll(async () => {
  await app.close();
  await db.destroy();
});

async function post(path: string, body?: unknown, headers: Record<string, string> = {}) {
  return fetch(`${address}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

describe("HTTP auth boundaries", () => {
  it("health endpoints respond without auth", async () => {
    expect((await fetch(`${address}/healthz`)).status).toBe(200);
    const ready = await fetch(`${address}/readyz`);
    expect(ready.status).toBe(200);
    expect(((await ready.json()) as { ok: boolean }).ok).toBe(true);
  });

  it("login sets opaque session + CSRF cookies; wrong password rejected", async () => {
    const bad = await post("/api/v1/auth/login", { username: "admin", password: "nope" });
    expect(bad.status).toBe(401);

    const res = await post("/api/v1/auth/login", { username: "admin", password: "password-admin-1" });
    expect(res.status).toBe(200);
    const setCookie = res.headers.getSetCookie?.() ?? [];
    cookieRef.current = setCookie.map((c) => c.split(";")[0]).join("; ");
    const sessionCookie = setCookie.find((c) => c.startsWith("tantalar_session="));
    expect(sessionCookie).toMatch(/HttpOnly/i);
    expect(sessionCookie).toMatch(/SameSite=Lax/i);
    csrfTokenRef.current = ((await res.json()) as { csrfToken: string }).csrfToken;
  });

  it("protected routes reject unauthenticated requests", async () => {
    expect((await fetch(`${address}/api/v1/events`)).status).toBe(401);
    expect((await fetch(`${address}/api/v1/plugins`)).status).toBe(401);
  });

  it("cookie-authenticated mutation without CSRF is rejected (403)", async () => {
    const res = await fetch(`${address}/api/v1/auth/logout`, {
      method: "POST",
      headers: { cookie: cookieRef.current },
    });
    expect(res.status).toBe(403);
  });

  it("cookie-authenticated mutation with matching CSRF header succeeds", async () => {
    // Re-login to get a fresh session (the previous one is still valid).
    const res = await post("/api/v1/auth/login", { username: "admin", password: "password-admin-1" });
    const setCookie = res.headers.getSetCookie?.() ?? [];
    const cookies = setCookie.map((c) => c.split(";")[0]).join("; ");
    const csrf = ((await res.json()) as { csrfToken: string }).csrfToken;
    const out = await fetch(`${address}/api/v1/auth/logout`, {
      method: "POST",
      headers: { cookie: cookies, "x-csrf-token": csrf },
    });
    expect(out.status).toBe(200);
  });

  it("scoped API keys authenticate machine calls; bad keys rejected", async () => {
    const { key } = await auth.createApiKey("ci", ["events.read"]);
    expect(
      (
        await fetch(`${address}/api/v1/events`, {
          headers: { authorization: `Bearer ${key}` },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await fetch(`${address}/api/v1/events`, {
          headers: { authorization: "Bearer tantalar_bogus" },
        })
      ).status,
    ).toBe(401);
  });

  it("API key without plugins.invoke scope gets 403 on capability invocation", async () => {
    const { key } = await auth.createApiKey("read-only", ["events.read"]);
    const res = await post(
      "/api/v1/plugins/core/capabilities/dev.tantalar.capability.event.emit/emit",
      {},
      { authorization: `Bearer ${key}` },
    );
    expect(res.status).toBe(403);
  });

  it("API key with plugins.invoke scope can invoke capabilities", async () => {
    const { key } = await auth.createApiKey("invoker", ["plugins.invoke"]);
    const res = await post(
      "/api/v1/plugins/core/capabilities/dev.tantalar.capability.event.emit/emit",
      {},
      { authorization: `Bearer ${key}` },
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { result: { ok: boolean } }).result.ok).toBe(true);
  });

  it("events.read-only key cannot list plugins (403); plugins.read key cannot read events (403)", async () => {
    const reader = await auth.createApiKey("reader-only", ["events.read"]);
    const pluginsRes = await fetch(`${address}/api/v1/plugins`, {
      headers: { authorization: `Bearer ${reader.key}` },
    });
    expect(pluginsRes.status).toBe(403);

    const pluginReader = await auth.createApiKey("plugin-reader", ["plugins.read"]);
    const eventsRes = await fetch(`${address}/api/v1/events`, {
      headers: { authorization: `Bearer ${pluginReader.key}` },
    });
    expect(eventsRes.status).toBe(403);
  });

  it("WS feed closes with 4403 for a valid key lacking events.read and never streams events", async () => {
    const { WebSocket } = await import("ws");
    const port = (app.server.address() as { port: number }).port;
    const { key } = await auth.createApiKey("no-scope", []);
    const url = `ws://127.0.0.1:${port}/api/v1/events/feed`;
    const received: unknown[] = [];
    const code = await new Promise<number | undefined>((resolve, reject) => {
      const ws = new WebSocket(url, { headers: { authorization: `Bearer ${key}` } });
      ws.on("message", (m) => received.push(m));
      ws.on("close", (c) => resolve(c));
      ws.on("error", reject);
      setTimeout(() => reject(new Error("socket was not closed")), 3000).unref();
    });
    // Publish after connection attempt; a subscribed socket would receive this.
    await bus.publish({
      type: "dev.tantalar.event.http.wstest",
      producer: "core",
      subject: "ws-scope-test",
      payload: {},
    });
    await new Promise((r) => setTimeout(r, 100));
    expect(code).toBe(4403);
    expect(received).toHaveLength(0);

    // Control: an events.read key stays open and receives published events.
    const reader = await auth.createApiKey("ws-reader", ["events.read"]);
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(url, { headers: { authorization: `Bearer ${reader.key}` } });
      ws.on("message", (m) => {
        try {
          const env = JSON.parse(String(m)) as { type?: string };
          if (env.type === "dev.tantalar.event.http.wscontrol") {
            ws.close();
            resolve();
          }
        } catch (err) {
          reject(err);
        }
      });
      ws.on("error", reject);
      ws.on("open", () => {
        void bus
          .publish({
            type: "dev.tantalar.event.http.wscontrol",
            producer: "core",
            subject: "ws-control",
            payload: {},
          })
          .catch(reject);
      });
      setTimeout(() => reject(new Error("authorized socket received nothing")), 3000).unref();
    });
  });
});

describe("events REST API", () => {
  it("replay endpoint returns appended events with filters", async () => {
    await bus.publish({
      type: "dev.tantalar.event.http.test",
      producer: "core",
      subject: "http-test",
      payload: { k: 1 },
    });
    const { key } = await auth.createApiKey("reader", ["events.read"]);
    const res = await fetch(`${address}/api/v1/events?subject=http-test&typePrefix=dev.tantalar.event.http.`, {
      headers: { authorization: `Bearer ${key}` },
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { events: Array<{ type: string; subject?: string }> };
    expect(data.events.length).toBeGreaterThanOrEqual(1);
    expect(data.events[0]?.type).toBe("dev.tantalar.event.http.test");
  });

  it("openapi.json is served and lists the API surface", async () => {
    const doc = (await (await fetch(`${address}/openapi.json`)).json()) as {
      openapi: string;
      paths: Record<string, unknown>;
    };
    expect(doc.openapi.startsWith("3.")).toBe(true);
    expect(Object.keys(doc.paths)).toContain("/api/v1/auth/login");
  });
});
