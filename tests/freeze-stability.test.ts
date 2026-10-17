import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate, openDatabase, type Db } from "@tantalar/db";
import type { Kysely } from "kysely";
import { AuthService } from "../apps/server/src/auth.js";
import { EventBus } from "../apps/server/src/events.js";
import { ServiceContainer } from "../apps/server/src/container.js";
import { Scheduler } from "../apps/server/src/scheduler.js";
import { Supervisor } from "../apps/server/src/supervisor.js";
import { buildServer } from "../apps/server/src/http.js";

let db: Kysely<Db>;
let auth: AuthService;
let bus: EventBus;
let app: Awaited<ReturnType<typeof buildServer>>;
let address = "";
let cookie = "";
let csrf = "";

beforeAll(async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "tantalar-freeze-stability-"));
  db = await openDatabase({ dialect: "sqlite", sqlitePath: join(dataDir, "test.db") });
  await migrate(db);
  auth = new AuthService(db);
  bus = new EventBus(db);
  const container = new ServiceContainer();
  container.register({
    pluginId: "dev.tantalar.plugin.vpn-manager",
    capability: "dev.tantalar.capability.vpn-binding",
    invoke: async () => ({ ok: true }),
  });
  const supervisor = new Supervisor({
    bus,
    container,
    scheduler: new Scheduler(db),
    restartPolicy: {
      initialBackoffMs: 10,
      maxBackoffMs: 50,
      backoffMultiplier: 2,
      windowMs: 1_000,
      maxRestartsInWindow: 3,
    },
    resolveEntry: () => ({ command: "true", args: [], env: {} }),
  });
  app = await buildServer({
    auth,
    db,
    bus,
    supervisor,
    container,
    ready: () => true,
    ops: { auth, db, bus, supervisor, container, ready: () => true, dataDir },
  });
  await app.listen({ port: 0, host: "127.0.0.1" });
  address = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  await auth.createUser("admin", "password-admin-1", "admin");

  const login = await fetch(`${address}/api/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "password-admin-1" }),
  });
  const setCookie = login.headers.getSetCookie?.() ?? [];
  cookie = setCookie.map((value) => value.split(";")[0]).join("; ");
  csrf = ((await login.json()) as { csrfToken: string }).csrfToken;
});

afterAll(async () => {
  await app.close();
  await db.destroy();
});

function adminHeaders(): Record<string, string> {
  return { cookie, "x-csrf-token": csrf, "content-type": "application/json" };
}

describe("freeze-prevention HTTP boundaries", () => {
  it("validates, clamps, and returns the newest bounded event slice", async () => {
    for (const suffix of ["first", "second", "third"]) {
      await bus.publish({ type: `dev.tantalar.event.test.${suffix}`, producer: "test" });
    }
    const { key } = await auth.createApiKey("events-test", ["events.read"]);
    const headers = { authorization: `Bearer ${key}` };

    for (const limit of ["0", "-1", "not-a-number", "1.5"]) {
      const invalid = await fetch(`${address}/api/v1/events?limit=${encodeURIComponent(limit)}`, { headers });
      expect(invalid.status).toBe(400);
      expect(await invalid.json()).toEqual({ error: "limit must be a positive integer" });
    }

    const readSpy = vi.spyOn(bus, "read");
    const clamped = await fetch(`${address}/api/v1/events?limit=999999`, { headers });
    expect(clamped.status).toBe(200);
    expect(readSpy).toHaveBeenLastCalledWith(expect.objectContaining({ limit: 500, newestFirst: true }));

    const latest = await fetch(`${address}/api/v1/events?limit=2`, { headers });
    const events = (await latest.json() as { events: Array<{ type: string }> }).events;
    expect(events.map((event) => event.type)).toEqual([
      "dev.tantalar.event.test.third",
      "dev.tantalar.event.test.second",
    ]);
    readSpy.mockRestore();
  });

  it("stores one bounded, redacted admin client incident and deduplicates repeats", async () => {
    const incident = {
      kind: "window-error",
      fingerprint: "freeze-fingerprint-1",
      message: "UI failed token=super-secret-value",
      stack: "Error: password=admin123\n at control.js:1:1",
      route: "/#/control/audit?token=route-secret",
      appVersion: "0.0.1-alpha.0",
      occurredAt: new Date().toISOString(),
    };
    const first = await fetch(`${address}/api/v1/system/client-incidents`, {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify(incident),
    });
    expect(first.status).toBe(201);
    expect(await first.json()).toMatchObject({ recorded: true, duplicate: false });

    const duplicate = await fetch(`${address}/api/v1/system/client-incidents`, {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify(incident),
    });
    expect(duplicate.status).toBe(200);
    expect(await duplicate.json()).toEqual({ recorded: false, duplicate: true });

    const rows = await db
      .selectFrom("audit_log")
      .select(["action", "detail"])
      .where("action", "=", "client.incident.reported")
      .execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.detail).toContain("[REDACTED]");
    expect(rows[0]?.detail).not.toContain("super-secret-value");
    expect(rows[0]?.detail).not.toContain("admin123");
    expect(rows[0]?.detail).not.toContain("route-secret");
  });

  it("reports the capability actually provided by the VPN manager", async () => {
    const response = await fetch(`${address}/api/v1/system/diagnostics`, { headers: adminHeaders() });
    expect(response.status).toBe(200);
    expect((await response.json() as { network: { vpnCapabilityMounted: boolean } }).network)
      .toEqual({ vpnCapabilityMounted: true });
  });
});
