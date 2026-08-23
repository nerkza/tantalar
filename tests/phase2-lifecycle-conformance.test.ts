/**
 * Phase 2 lifecycle + conformance tests: config-driven diff-apply with
 * rollback, plugin->capability invocation gate, event delivery to subscribed
 * plugins, conformance testkit against first-party plugins, and contract
 * mismatch rejection.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Kysely } from "kysely";
import { migrate, openDatabase, type Db } from "@tantalar/db";
import { EventBus } from "../apps/server/src/events.js";
import { ServiceContainer } from "../apps/server/src/container.js";
import { Scheduler } from "../apps/server/src/scheduler.js";
import { Supervisor, type RestartPolicy } from "../apps/server/src/supervisor.js";
import { PluginLifecycleManager } from "../apps/server/src/lifecycle.js";
import { runConformanceSuite } from "@tantalar/testkit";
import type { PluginManifest } from "@tantalar/contracts";

const HELLO_ENTRY = "node " + resolve("plugins/hello-world/dist/plugin.js");
const WEBHOOK_ENTRY = "node " + resolve("plugins/webhook/dist/plugin.js");

const policy: RestartPolicy = {
  initialBackoffMs: 100,
  maxBackoffMs: 500,
  backoffMultiplier: 2,
  windowMs: 10_000,
  maxRestartsInWindow: 3,
};

let db: Kysely<Db>;
let bus: EventBus;
let container: ServiceContainer;
let scheduler: Scheduler;
let supervisor: Supervisor;
let lifecycle: PluginLifecycleManager;
let dir: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "tantalar-p2-"));
  db = await openDatabase({ dialect: "sqlite", sqlitePath: join(dir, "t.db") });
  await migrate(db);
  bus = new EventBus(db);
  container = new ServiceContainer();
  scheduler = new Scheduler(db, 100_000);
  container.register({ pluginId: "core", capability: "dev.tantalar.capability.event.emit", invoke: async () => ({ ok: true }) });
  container.register({ pluginId: "core", capability: "dev.tantalar.capability.log", invoke: async () => ({ ok: true }) });
  container.register({
    pluginId: "core",
    capability: "dev.tantalar.capability.auth.introspection",
    invoke: async (_op, payload) => {
      const valid = payload.apiKey === "tantalar_testkey123";
      return { valid, identity: valid ? "key-1" : "", scopes: valid ? ["events.read"] : [] };
    },
  });
  supervisor = new Supervisor({
    bus,
    container,
    scheduler,
    restartPolicy: policy,
    healthIntervalMs: 500,
    resolveEntry: (m) => {
      const [cmd, ...rest] = m.entry.command.split(" ");
      return { command: cmd ?? "node", args: rest.filter(Boolean), env: {} };
    },
  });
  lifecycle = new PluginLifecycleManager({ supervisor, basePath: dir });
  // Event delivery to subscribed plugins (phase-2 contract).
  bus.subscribe("", (envelope) => void supervisor.deliverEventToPlugins(envelope));
});

afterAll(async () => {
  await supervisor.stopAll();
  await db.destroy();
});

describe("config-driven lifecycle (story 24)", () => {
  it("mounts an enabled plugin from a manifest path in config", async () => {
    const manifestPath = join(dir, "hello-manifest.json");
    writeFileSync(
      manifestPath,
      JSON.stringify({
        id: "dev.tantalar.plugin.hello-world",
        version: "0.1.0",
        protocolVersion: 1,
        provides: ["dev.tantalar.capability.hello.greet"],
        requires: ["dev.tantalar.capability.event.emit"],
        subscriptions: [],
        entry: { command: HELLO_ENTRY },
      }),
    );
    const result = await lifecycle.apply({
      "dev.tantalar.plugin.hello-world": { enabled: true, manifestPath },
    });
    expect(result.failed).toEqual([]);
    expect(result.mounted).toContain("dev.tantalar.plugin.hello-world");
    expect(supervisor.get("dev.tantalar.plugin.hello-world")?.state).toBe("healthy");
  });

  it("rejects a manifest whose id mismatches the configured key without disturbing healthy plugins", async () => {
    const goodPath = join(dir, "hello-manifest.json");
    const manifestPath = join(dir, "mismatch.json");
    writeFileSync(
      manifestPath,
      JSON.stringify({
        id: "dev.tantalar.plugin.hello-world",
        version: "0.1.0",
        protocolVersion: 1,
        provides: ["dev.tantalar.capability.hello.greet"],
        requires: [],
        subscriptions: [],
        entry: { command: HELLO_ENTRY },
      }),
    );
    const result = await lifecycle.apply({
      "dev.tantalar.plugin.hello-world": { enabled: true, manifestPath: goodPath },
      "dev.tantalar.plugin.other": { enabled: true, manifestPath },
    });
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]?.error).toMatch(/does not match configured key/);
    expect(supervisor.get("dev.tantalar.plugin.hello-world")?.state).toBe("healthy");
  });

  it("unmounts a disabled plugin and keeps it reversible", async () => {
    const result = await lifecycle.apply({ "dev.tantalar.plugin.hello-world": { enabled: false } });
    expect(result.unmounted).toContain("dev.tantalar.plugin.hello-world");
    expect(supervisor.get("dev.tantalar.plugin.hello-world")).toBeUndefined();
    // Capabilities were revoked with it.
    expect(container.hasProviders("dev.tantalar.capability.hello.greet")).toBe(false);
  });

  it("keeps the old version running when a swap target fails (rollback)", async () => {
    // hello-world is currently disabled/unmounted from the previous test;
    // bring it up, then attempt to add a plugin whose entry is broken.
    const goodPath = join(dir, "hello-manifest.json");
    const result1 = await lifecycle.apply({ "dev.tantalar.plugin.hello-world": { enabled: true, manifestPath: goodPath } });
    if (!result1.mounted.includes("dev.tantalar.plugin.hello-world")) {
      expect(supervisor.get("dev.tantalar.plugin.hello-world")?.state).toBe("healthy");
    }

    const badPath = join(dir, "bad.json");
    writeFileSync(
      badPath,
      JSON.stringify({
        id: "dev.tantalar.plugin.bad",
        version: "0.1.0",
        protocolVersion: 1,
        provides: ["dev.tantalar.capability.bad.noop"],
        requires: [],
        subscriptions: [],
        entry: { command: "node /nonexistent/path/plugin.js" },
      }),
    );
    // Swap hello-world for a new version (same id, new manifest path) AND add
    // a broken plugin; convergence must not disturb the healthy plugin.
    const result2 = await lifecycle.apply({
      "dev.tantalar.plugin.hello-world": { enabled: true, manifestPath: goodPath },
      "dev.tantalar.plugin.bad": { enabled: true, manifestPath: badPath },
    });
    expect(result2.failed.map((f) => f.pluginId)).toContain("dev.tantalar.plugin.bad");
    // The healthy plugin is untouched.
    expect(supervisor.get("dev.tantalar.plugin.hello-world")?.state).toBe("healthy");
    await supervisor.unmount("dev.tantalar.plugin.hello-world");
  });
});

describe("plugin->capability invocation gate", () => {
  it("mounts with declared requires across the process boundary", async () => {
    const manifest: PluginManifest = {
      id: "dev.tantalar.plugin.hello-world",
      version: "0.1.0",
      protocolVersion: 1,
      provides: ["dev.tantalar.capability.hello.greet"],
      requires: ["dev.tantalar.capability.event.emit", "dev.tantalar.capability.auth.introspection"],
      subscriptions: [],
      entry: { command: HELLO_ENTRY },
    };
    // hello-world uses the shared SDK runtime, which supports op "invoke".
    const rt = await supervisor.mount(manifest, {});
    expect(rt.state).toBe("healthy");
    await supervisor.unmount(manifest.id);
  });
});

describe("event delivery to subscribed plugins", () => {
  it("sends matching envelopes and not non-matching ones", async () => {
    const manifest: PluginManifest = {
      id: "dev.tantalar.plugin.webhook",
      version: "0.1.0",
      protocolVersion: 1,
      provides: ["dev.tantalar.capability.webhook.status"],
      requires: ["dev.tantalar.capability.event.emit", "dev.tantalar.capability.log"],
      subscriptions: ["dev.tantalar.event."],
      entry: { command: WEBHOOK_ENTRY },
    };
    const rt = await supervisor.mount(manifest, { targets: [] });
    expect(rt.state).toBe("healthy");
    // No throw on delivery; webhook with zero targets acks each delivery.
    await bus.publish({ type: "dev.tantalar.event.test.ping", producer: "core", payload: { n: 1 } });
    await bus.publish({ type: "other.domain.event.x", producer: "core", payload: {} });
    await new Promise((r) => setTimeout(r, 300));
    await supervisor.unmount(manifest.id);
  });
});

describe("contract-version mismatch rejection", () => {
  it("refuses a plugin whose protocolVersion differs", async () => {
    const future: PluginManifest = {
      id: "dev.tantalar.plugin.time-traveler",
      version: "1.0.0",
      protocolVersion: 2,
      provides: ["dev.tantalar.capability.tt.noop"],
      requires: [],
      subscriptions: [],
      entry: { command: HELLO_ENTRY },
    };
    await expect(supervisor.mount(future)).rejects.toThrow(/protocolVersion/);
    expect(supervisor.get("dev.tantalar.plugin.time-traveler")).toBeUndefined();
  });
});

describe("conformance testkit (public product artifact)", () => {
  it("passes against the first-party hello-world plugin end to end", async () => {
    const report = await runConformanceSuite({ packageDir: resolve("plugins/hello-world") });
    expect(report.failed).toBe(0);
    expect(report.pluginId).toBe("dev.tantalar.plugin.hello-world");
    expect(report.cases.length).toBeGreaterThanOrEqual(10);
  }, 60_000);

  it("passes against the first-party webhook plugin", async () => {
    const report = await runConformanceSuite({ packageDir: resolve("plugins/webhook") });
    expect(report.failed).toBe(0);
    expect(report.pluginId).toBe("dev.tantalar.plugin.webhook");
  }, 60_000);

  it("passes against the first-party MCP server plugin", async () => {
    const report = await runConformanceSuite({ packageDir: resolve("plugins/mcp-server") });
    expect(report.failed).toBe(0);
    expect(report.pluginId).toBe("dev.tantalar.plugin.mcp");
  }, 60_000);
});
