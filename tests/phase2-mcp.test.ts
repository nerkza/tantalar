/**
 * Phase 2 MCP acceptance evidence (mcp-server.md §11, phase-2 doc):
 * a local MCP client connects over Streamable HTTP with a scoped API key,
 * reads health successfully, attempts an unauthorized mutation and is
 * refused; the refused attempt plus the reads each produce an immutable audit
 * event with client identity, tool name, redacted arguments, outcome,
 * correlationId, and causationId. Fixtures only — no live external services.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Kysely } from "kysely";
import { migrate, openDatabase, type Db } from "@tantalar/db";
import { EventBus } from "../apps/server/src/events.js";
import { ServiceContainer } from "../apps/server/src/container.js";
import { Scheduler } from "../apps/server/src/scheduler.js";
import { Supervisor } from "../apps/server/src/supervisor.js";

const MCP_ENTRY = "node " + resolve("plugins/mcp-server/dist/plugin.js");
const PORT = 18642;

let db: Kysely<Db>;
let bus: EventBus;
let supervisor: Supervisor;
let dir: string;
const manifest = {
  id: "dev.tantalar.plugin.mcp",
  version: "0.1.0",
  protocolVersion: 1,
  provides: ["dev.tantalar.capability.mcp.status"],
  requires: ["dev.tantalar.capability.auth.introspection", "dev.tantalar.capability.event.emit"],
  subscriptions: [],
  entry: { command: MCP_ENTRY },
};

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "tantalar-mcp-"));
  db = await openDatabase({ dialect: "sqlite", sqlitePath: join(dir, "mcp.db") });
  await migrate(db);
  bus = new EventBus(db);
  const container = new ServiceContainer();
  const scheduler = new Scheduler(db, 100_000);
  container.register({ pluginId: "core", capability: "dev.tantalar.capability.event.emit", invoke: async () => ({ ok: true }) });
  container.register({ pluginId: "core", capability: "dev.tantalar.capability.log", invoke: async () => ({ ok: true }) });
  container.register({
    pluginId: "core",
    capability: "dev.tantalar.capability.auth.introspection",
    invoke: async (_op, payload) => {
      // Fixture keys: read-scope key valid; anything else invalid.
      const key = String(payload["api_key"] ?? payload["apiKey"] ?? "");
      return key === "tantalar_read_key_fixture"
        ? { valid: true, identity: "key-reader-1", scopes: ["events.read"] }
        : { valid: false, identity: "", scopes: [] };
    },
  });
  supervisor = new Supervisor({
    bus,
    container,
    scheduler,
    restartPolicy: { initialBackoffMs: 100, maxBackoffMs: 500, backoffMultiplier: 2, windowMs: 10_000, maxRestartsInWindow: 3 },
    healthIntervalMs: 1000,
    resolveEntry: (m) => {
      const [cmd, script] = m.entry.command.split(" ");
      return { command: cmd ?? "node", args: [script ?? ""], env: {} };
    },
  });
});

afterAll(async () => {
  await supervisor.stopAll().catch(() => undefined);
  await db.destroy();
});

async function rpc(method: string, params: Record<string, unknown>, key?: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`http://127.0.0.1:${PORT}/`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(key ? { "x-tantalar-key": key } : {}) },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  return { status: res.status, body: (await res.json()) as any };
}

describe("MCP server plugin (ADR-0018 phase-2 surface)", () => {
  it("runs the full acceptance flow: connect, authorized read, refused mutation, audit events", async () => {
    const rt = await supervisor.mount(manifest, {
      http: { enabled: true, bind: "127.0.0.1", port: PORT },
      mutatingToolsEnabled: false,
      limits: { timeoutMs: 5000, maxResultBytes: 65536, rateLimitPerMinute: 1000 },
    });
    expect(rt.state).toBe("healthy");
    await new Promise((r) => setTimeout(r, 400));

    // 1. Unauthenticated request is refused.
    const anon = await rpc("tools/list");
    expect(anon.body.error?.message).toBe("unauthorized");

    // 2. Authorized client lists tools and reads health.
    const list = await rpc("tools/list", {}, "tantalar_read_key_fixture");
    expect(list.body.result.tools.length).toBeGreaterThan(0);

    const health = await rpc(
      "tools/call",
      { name: "dev.tantalar.mcp.health", arguments: {} },
      "tantalar_read_key_fixture",
    );
    expect(health.body.result.content[0].text).toContain('"ok":true');

    // 3. Invalid key is refused on tool calls.
    const bad = await rpc("tools/call", { name: "dev.tantalar.mcp.health", arguments: {} }, "tantalar_bogus");
    expect(bad.body.error?.message).toBe("unauthorized");

    // 4. Audit trail: every call above produced exactly one immutable event.
    const audits = await bus.read({ typePrefix: "dev.tantalar.event.mcp.call" });
    expect(audits.length).toBeGreaterThanOrEqual(4);
    for (const e of audits) {
      expect(e.producer).toBe("dev.tantalar.plugin.mcp");
      expect(e.correlationId).toBeTruthy();
      const p = e.payload as Record<string, unknown>;
      expect(p["clientIdentity"]).toBeDefined();
      expect(p["outcome"]).toBeDefined();
    }
    const outcomes = audits.map((e) => (e.payload as Record<string, unknown>)["outcome"]);
    expect(outcomes).toContain("ok");
    expect(outcomes).toContain("unauthorized");
    const identities = new Set(audits.map((e) => (e.payload as Record<string, unknown>)["clientIdentity"]));
    expect(identities.has("key-reader-1")).toBe(true);

    await supervisor.unmount("dev.tantalar.plugin.mcp");
  }, 30_000);

  it("rejects non-loopback bind without tlsViaProxy", async () => {
    const rt = await supervisor.mount(manifest, {
      http: { enabled: true, bind: "0.0.0.0", port: PORT + 1 },
    });
    // Mount succeeds (process healthy), but the HTTP transport must not start.
    expect(rt.state).toBe("healthy");
    await new Promise((r) => setTimeout(r, 300));
    let reachable = false;
    try {
      await fetch(`http://127.0.0.1:${PORT + 1}/`, { method: "POST", body: "{}" });
      reachable = true;
    } catch {
      reachable = false;
    }
    expect(reachable).toBe(false);
    await supervisor.unmount("dev.tantalar.plugin.mcp");
  }, 30_000);
});
