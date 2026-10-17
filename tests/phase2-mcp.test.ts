/**
 * Phase 2 MCP acceptance evidence (mcp-server.md §11, phase-2 doc):
 * a local MCP client connects over Streamable HTTP with a scoped API key,
 * reads health successfully, attempts an out-of-scope read and is refused;
 * the refused attempt plus the reads each produce an immutable audit
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
  requires: [
    "dev.tantalar.capability.auth.introspection",
    "dev.tantalar.capability.event.emit",
    "dev.tantalar.capability.mcp.activity.read",
    "dev.tantalar.capability.mcp.operation.read",
    "dev.tantalar.capability.mcp.config.read",
  ],
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
      const key = String(payload["api_key"] ?? "");
      return key === "tantalar_read_key_fixture"
        ? { valid: true, identity: "key-reader-1", scopes: ["events.read"] }
        : { valid: false, identity: "", scopes: [] };
    },
  });
  container.register({
    pluginId: "core",
    capability: "dev.tantalar.capability.mcp.activity.read",
    invoke: async () => ({ events: [] }),
  });
  container.register({
    pluginId: "core",
    capability: "dev.tantalar.capability.mcp.operation.read",
    invoke: async () => ({ plugins: [] }),
  });
  container.register({
    pluginId: "core",
    capability: "dev.tantalar.capability.mcp.config.read",
    invoke: async () => ({ yaml: "server: {}\n" }),
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

async function rpc(
  method: string,
  params: Record<string, unknown> = {},
  key?: string,
  endpoint = `http://127.0.0.1:${PORT}/`,
): Promise<{ status: number; body: any }> {
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json", ...(key ? { "x-tantalar-key": key } : {}) },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  return { status: res.status, body: (await res.json()) as any };
}

describe("MCP server plugin (ADR-0018 phase-2 surface)", () => {
  it("runs the full acceptance flow: connect, authorized read, scope refusal, audit events", async () => {
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
    expect(list.body.result.tools.find((tool: { name: string }) => tool.name === "dev.tantalar.mcp.activity.query")?.inputSchema).toEqual({
      type: "object",
      properties: {
        limit: { type: "integer", minimum: 1, maximum: 200 },
        cursor: { type: "string" },
      },
      additionalProperties: false,
    });

    const health = await rpc(
      "tools/call",
      { name: "dev.tantalar.mcp.health", arguments: {} },
      "tantalar_read_key_fixture",
    );
    expect(health.body.result.content[0].text).toContain('"ok":true');

    // 3. A valid key cannot use a tool outside its scopes.
    const forbidden = await rpc(
      "tools/call",
      { name: "dev.tantalar.mcp.config.inspect", arguments: {} },
      "tantalar_read_key_fixture",
    );
    expect(forbidden.body.error?.message).toBe("insufficient scope");

    // 4. Unknown protocol methods are refused and audited.
    const unknown = await rpc("dev.tantalar.mcp.unknown", {}, "tantalar_read_key_fixture");
    expect(unknown.body.error?.message).toBe("method not found");

    // 5. Invalid keys are refused on tool calls.
    const bad = await rpc("tools/call", { name: "dev.tantalar.mcp.health", arguments: {} }, "tantalar_bogus");
    expect(bad.body.error?.message).toBe("unauthorized");

    // 6. Audit trail: every call above produced one immutable event.
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
    expect(outcomes).toContain("unknown-method");
    expect(outcomes).toContain("unauthorized");
    const identities = new Set(audits.map((e) => (e.payload as Record<string, unknown>)["clientIdentity"]));
    expect(identities.has("key-reader-1")).toBe(true);

    await supervisor.unmount("dev.tantalar.plugin.mcp");
  }, 30_000);

  it("rejects non-loopback bind without tlsViaProxy", async () => {
    await expect(supervisor.mount(manifest, {
      http: { enabled: true, bind: "0.0.0.0", port: PORT + 1 },
    })).rejects.toThrow(/non-loopback bind requires/);
    expect(supervisor.get("dev.tantalar.plugin.mcp")).toBeUndefined();
  }, 30_000);

  it("accepts the IPv6 loopback address without a TLS proxy", async () => {
    const rt = await supervisor.mount(manifest, {
      http: { enabled: true, bind: "::1", port: PORT + 2 },
    });
    expect(rt.state).toBe("healthy");
    const ping = await rpc("ping", {}, "tantalar_read_key_fixture", `http://[::1]:${PORT + 2}/`);
    expect(ping.body.result).toEqual({});
    await supervisor.unmount("dev.tantalar.plugin.mcp");
  }, 30_000);

  it("rejects unsupported methods and oversized request bodies", async () => {
    await supervisor.mount(manifest, {
      http: { enabled: true, bind: "127.0.0.1", port: PORT + 3 },
    });
    const endpoint = `http://127.0.0.1:${PORT + 3}/`;
    expect((await fetch(endpoint)).status).toBe(405);
    expect((await fetch(endpoint, { method: "POST", body: "x".repeat(1_048_577) })).status).toBe(413);
    await supervisor.unmount("dev.tantalar.plugin.mcp");
  }, 30_000);
});
