/**
 * Wave 7 API tests (TAN-014): /api/v1/indexers — add, list/get, test, enable.
 *
 * Covers:
 *  - 401 unauthenticated, 403 non-admin viewer, CSRF enforcement on cookie
 *    mutations;
 *  - admin add with validation (bad baseUrl/protocol rejected fail-closed),
 *    duplicate-name conflict, and redaction: an apikey NEVER appears in any
 *    response;
 *  - connection test through an injected transport seam: caps ok, auth
 *    failure, provider outage, unparsable body;
 *  - enable/disable flow and unknown-id 404s.
 *
 * No network: provider responses are synthetic legal fixtures (.invalid
 * hosts, invented ids).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Kysely } from "kysely";
import { migrate, openDatabase, type Db } from "@tantalar/db";
import { AuthService } from "../apps/server/src/auth.js";
import { EventBus } from "../apps/server/src/events.js";
import { ServiceContainer } from "../apps/server/src/container.js";
import type { Supervisor } from "../apps/server/src/supervisor.js";
import { buildServer } from "../apps/server/src/http.js";
import { IndexerSettingsService } from "../apps/server/src/indexer-settings.js";

const CAPS_XML = `<?xml version="1.0" encoding="UTF-8"?>
<caps>
  <categories>
    <category id="2000" name="Movies"/>
  </categories>
  <searching>
    <search available="yes"/>
    <tv-search available="yes"/>
  </searching>
</caps>`;

let db: Kysely<Db>;
let auth: AuthService;
let service: IndexerSettingsService;
let address = "";
let app: Awaited<ReturnType<typeof buildServer>>;
let dir = "";
const csrfTokenRef = { current: "" };
const cookieRef = { current: "" };
const viewerCookieRef = { current: "" };

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "tantalar-wave7-indexers-"));
  db = await openDatabase({ dialect: "sqlite", sqlitePath: join(dir, "test.db") });
  await migrate(db);
  auth = new AuthService(db);
  const bus = new EventBus(db);
  const container = new ServiceContainer();
  container.register({ pluginId: "core", capability: "dev.tantalar.capability.event.emit", invoke: async () => ({ ok: true }) });
  const supervisor = { list: () => [] } as unknown as Supervisor;
  service = new IndexerSettingsService(db);
  // Injected transport seam: no network. .invalid host never resolves.
  let mode: "ok" | "auth" | "outage" | "garbage" = "ok";
  const setMode = (m: typeof mode) => {
    mode = m;
  };
  (globalThis as Record<string, unknown>).__setCapsMode = setMode;
  service.setTransport(async () => {
    if (mode === "auth") return { status: 401, body: "unauthorized" };
    if (mode === "outage") return { status: 503, body: "down" };
    if (mode === "garbage") return { status: 200, body: "<html>not caps</html>" };
    return { status: 200, body: CAPS_XML };
  });
  app = await buildServer({
    auth,
    db,
    bus,
    supervisor,
    container,
    ready: () => true,
    indexerSettings: service,
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

function setCapsMode(mode: string): void {
  (globalThis as Record<string, unknown>).__setCapsMode?.(mode);
}

async function login(username: string, password: string): Promise<void> {
  const res = await fetch(`${address}/api/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  expect(res.status).toBe(200);
  const setCookie = res.headers.getSetCookie?.() ?? [];
  const cookie =
    setCookie
      .map((c) => c.split(";")[0])
      .find((c) => c.startsWith("tantalar_session=")) ?? "";
  csrfTokenRef.current = (await res.json() as { csrfToken: string }).csrfToken;
  if (username === "admin") cookieRef.current = cookie;
  else viewerCookieRef.current = cookie;
}

function authed(opts: { method?: string; body?: string; useViewer?: boolean; noCsrf?: boolean; bearer?: string }): Record<string, unknown> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.bearer) headers.authorization = `Bearer ${opts.bearer}`;
  else {
    headers.cookie = `${opts.useViewer ? viewerCookieRef.current : cookieRef.current}; tantalar_csrf=${csrfTokenRef.current}`;
    if (!opts.noCsrf && opts.method && opts.method !== "GET") {
      headers["x-csrf-token"] = csrfTokenRef.current;
    }
  }
  return { method: opts.method ?? "GET", headers, ...(opts.body !== undefined ? { body: opts.body } : {}) };
}

describe("indexer settings API (TAN-014)", () => {
  it("rejects unauthenticated reads", async () => {
    const res = await fetch(`${address}/api/v1/indexers`);
    expect(res.status).toBe(401);
  });

  it("forbids non-admin mutations and enforces CSRF on cookie mutations", async () => {
    await login("admin", "password-admin-1");
    await login("viewer", "password-viewer-1");
    const viewerRes = await fetch(`${address}/api/v1/indexers`, {
      method: "POST",
      ...authed({
        method: "POST",
        useViewer: true,
        body: JSON.stringify({ name: "Nope", protocol: "torznab", baseUrl: "https://indexer.invalid" }),
      }),
    });
    expect(viewerRes.status).toBe(403);

    const noCsrf = await fetch(`${address}/api/v1/indexers`, {
      method: "POST",
      ...authed({
        method: "POST",
        noCsrf: true,
        body: JSON.stringify({ name: "Nope", protocol: "torznab", baseUrl: "https://indexer.invalid" }),
      }),
    });
    expect(noCsrf.status).toBe(403);
  });

  it("adds an indexer with validation and never echoes the apikey", async () => {
    const badUrl = await fetch(`${address}/api/v1/indexers`, {
      method: "POST",
      ...authed({ method: "POST", body: JSON.stringify({ name: "Bad", protocol: "torznab", baseUrl: "not a url" }) }),
    });
    expect(badUrl.status).toBe(400);

    const badProto = await fetch(`${address}/api/v1/indexers`, {
      method: "POST",
      ...authed({ method: "POST", body: JSON.stringify({ name: "Bad", protocol: "irc", baseUrl: "https://indexer.invalid" }) }),
    });
    expect(badProto.status).toBe(400);

    const created = await fetch(`${address}/api/v1/indexers`, {
      method: "POST",
      ...authed({
        method: "POST",
        body: JSON.stringify({
          name: "Synthetic Torznab",
          protocol: "torznab",
          baseUrl: "https://indexer.invalid",
          apiKey: "sekret-tan014",
        }),
      }),
    });
    expect(created.status).toBe(201);
    const createdText = await created.text();
    const body = JSON.parse(createdText) as { indexer: Record<string, unknown> };
    expect(createdText.includes("sekret-tan014")).toBe(false);
    expect(body.indexer.name).toBe("Synthetic Torznab");
    expect(body.indexer.hasApiKey).toBe(true);
    expect(body.indexer.enabled).toBe(true);
    expect(JSON.stringify(body)).not.toContain("apiKey");

    const dup = await fetch(`${address}/api/v1/indexers`, {
      method: "POST",
      ...authed({ method: "POST", body: JSON.stringify({ name: "synthetic torznab", protocol: "newznab", baseUrl: "https://indexer.invalid" }) }),
    });
    expect(dup.status).toBe(409);

    const listed = await fetch(`${address}/api/v1/indexers`, authed({}));
    expect(listed.status).toBe(200);
    const listText = await listed.text();
    expect(listText).toContain("Synthetic Torznab");
    expect(listText.includes("sekret-tan014")).toBe(false);
  });

  it("tests the connection through the injected seam with truthful codes", async () => {
    const listed = await fetch(`${address}/api/v1/indexers`, authed({}));
    const indexers = (JSON.parse(await listed.text()) as { indexers: Array<{ id: string }> }).indexers;
    const id = indexers[0]!.id;

    setCapsMode("ok");
    const okRes = await fetch(`${address}/api/v1/indexers/${id}/test`, {
      method: "POST",
      ...authed({ method: "POST", body: "{}" }),
    });
    expect(okRes.status).toBe(200);
    const okText = await okRes.text();
    const ok = JSON.parse(okText) as { ok: boolean; categoryCount?: number; probedUrl: string };
    expect(ok.ok).toBe(true);
    expect(ok.categoryCount).toBe(1);
    expect(okText.includes("sekret-tan014")).toBe(false);
    expect(ok.probedUrl).toContain("apikey=[REDACTED]");

    setCapsMode("auth");
    const authRes = await fetch(`${address}/api/v1/indexers/${id}/test`, {
      method: "POST",
      ...authed({ method: "POST", body: "{}" }),
    });
    const authBody = JSON.parse(await authRes.text()) as { ok: boolean; code?: string };
    expect(authBody.ok).toBe(false);
    expect(authBody.code).toBe("auth_failed");

    setCapsMode("outage");
    const outage = JSON.parse(
      await (
        await fetch(`${address}/api/v1/indexers/${id}/test`, { method: "POST", ...authed({ method: "POST", body: "{}" }) })
      ).text(),
    ) as { ok: boolean; code?: string };
    expect(outage.ok).toBe(false);
    expect(outage.code).toBe("unavailable");

    setCapsMode("garbage");
    const garbage = JSON.parse(
      await (
        await fetch(`${address}/api/v1/indexers/${id}/test`, { method: "POST", ...authed({ method: "POST", body: "{}" }) })
      ).text(),
    ) as { ok: boolean; code?: string };
    expect(garbage.ok).toBe(false);
    expect(garbage.code).toBe("parse_error");

    const unknown = await fetch(`${address}/api/v1/indexers/nope/test`, {
      method: "POST",
      ...authed({ method: "POST", body: "{}" }),
    });
    expect(unknown.status).toBe(404);
  });

  it("enables and disables an indexer durably", async () => {
    const listed = await fetch(`${address}/api/v1/indexers`, authed({}));
    const id = (JSON.parse(await listed.text()) as { indexers: Array<{ id: string }> }).indexers[0]!.id;

    const off = await fetch(`${address}/api/v1/indexers/${id}/enabled`, {
      method: "PUT",
      ...authed({ method: "PUT", body: JSON.stringify({ enabled: false }) }),
    });
    expect(off.status).toBe(200);
    expect(((await off.json()) as { indexer: { enabled: boolean } }).indexer.enabled).toBe(false);

    const fetched = await fetch(`${address}/api/v1/indexers/${id}`, authed({}));
    expect(((await fetched.json()) as { indexer: { enabled: boolean } }).indexer.enabled).toBe(false);

    const on = await fetch(`${address}/api/v1/indexers/${id}/enabled`, {
      method: "PUT",
      ...authed({ method: "PUT", body: JSON.stringify({ enabled: true }) }),
    });
    expect(on.status).toBe(200);
    expect(((await on.json()) as { indexer: { enabled: boolean } }).indexer.enabled).toBe(true);

    const missing = await fetch(`${address}/api/v1/indexers/nope/enabled`, {
      method: "PUT",
      ...authed({ method: "PUT", body: JSON.stringify({ enabled: true }) }),
    });
    expect(missing.status).toBe(404);
  });

  it("keeps records durable across a full database close/reopen", async () => {
    const path = join(dir, "test.db");
    await db.destroy();
    db = await openDatabase({ dialect: "sqlite", sqlitePath: path });
    const revived = new IndexerSettingsService(db);
    const list = await revived.list();
    expect(list.map((i) => i.name)).toContain("Synthetic Torznab");
  });
});
