/**
 * Phase 1 exit evidence: hello-world out-of-process plugin mounts, resolves
 * declared capabilities, emits events into the log, survives kill -9 with
 * policy-driven restart, unmounts reversibly, and its activity reconstructs
 * from the event-log replay API.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate, openDatabase, type Db } from "@tantalar/db";
import { Kysely } from "kysely";
import { EventBus } from "../apps/server/src/events.js";
import { ServiceContainer } from "../apps/server/src/container.js";
import { Scheduler } from "../apps/server/src/scheduler.js";
import { Supervisor, type RestartPolicy } from "../apps/server/src/supervisor.js";
import { CapabilityResolutionError } from "../apps/server/src/container.js";
import type { PluginManifest } from "@tantalar/contracts";
import { resolve } from "node:path";

const PLUGIN_ENTRY = "node " + resolve("plugins/hello-world/dist/plugin.js");

const manifest: PluginManifest = {
  id: "dev.tantalar.plugin.hello-world",
  version: "0.1.0",
  protocolVersion: 1,
  provides: ["dev.tantalar.capability.hello.greet"],
  requires: ["dev.tantalar.capability.event.emit"],
  subscriptions: [],
  entry: { command: PLUGIN_ENTRY },
};

const policy: RestartPolicy = {
  initialBackoffMs: 100,
  maxBackoffMs: 1000,
  backoffMultiplier: 2,
  windowMs: 60_000,
  maxRestartsInWindow: 5,
};

let db: Kysely<Db>;
let bus: EventBus;
let container: ServiceContainer;
let scheduler: Scheduler;
let supervisor: Supervisor;
let dir: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "tantalar-sup-"));
  db = await openDatabase({ dialect: "sqlite", sqlitePath: join(dir, "test.db") });
  await migrate(db);
  bus = new EventBus(db);
  container = new ServiceContainer();
  scheduler = new Scheduler(db);
  // Core providers so the plugin's requires can resolve (mirrors kernel boot).
  container.register({
    pluginId: "core",
    capability: "dev.tantalar.capability.event.emit",
    invoke: async () => ({ ok: true }),
  });
  container.register({
    pluginId: "core",
    capability: "dev.tantalar.capability.log",
    invoke: async () => ({ ok: true }),
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
});

afterAll(async () => {
  await supervisor.stopAll();
  await db.destroy();
});

describe("hello-world plugin lifecycle (Phase 1 exit)", () => {
  it("fails to mount when a required capability is missing", async () => {
    const bad = { ...manifest, requires: ["dev.tantalar.capability.does.not.exist"] };
    await expect(supervisor.mount(bad)).rejects.toThrow(CapabilityResolutionError);
    expect(supervisor.get(manifest.id)).toBeUndefined(); // no partial state
  });

  it("mounts out-of-process, registers capabilities reversibly, and emits events", async () => {
    const rt = await supervisor.mount(manifest, {});
    expect(rt.state).toBe("healthy");

    // Declared capability resolves and invokes across the process boundary.
    const provider = container.resolve("dev.tantalar.capability.hello.greet");
    const result = (await provider.invoke("greet", { name: "Tantalar" })) as { greeting: string };
    expect(result.greeting).toBe("hello, Tantalar");

    // The mount emitted an event through the bus into the persisted log.
    const events = await bus.read({ typePrefix: "dev.tantalar.event.hello." });
    expect(events.length).toBe(1);
    expect(events[0]?.producer).toBe(manifest.id);
  });

  it("survives kill -9; server stays healthy and restarts under policy", async () => {
    const rt0 = supervisor.get(manifest.id);
    expect(rt0?.state).toBe("healthy");

    // Kill -9 the plugin process directly (test hook).
    const handle = supervisor.testGetProc(manifest.id);
    expect(handle).toBeTruthy();
    handle!.kill("SIGKILL");

    // Wait for restart-with-backoff.
    await new Promise((r) => setTimeout(r, 1500));
    const after = supervisor.get(manifest.id);
    expect(after?.state).toBe("healthy");
    expect(after!.restartCount).toBeGreaterThanOrEqual(1);

    // Server-side components unaffected.
    expect(container.hasProviders("dev.tantalar.capability.hello.greet")).toBe(true);

    // Crash + restart were recorded as events.
    const crashed = await bus.read({ typePrefix: "dev.tantalar.event.plugin.crashed" });
    expect(crashed.length).toBe(1);
    const restarted = await bus.read({ typePrefix: "dev.tantalar.event.plugin.restarted" });
    expect(restarted.length).toBe(1);
  });

  it("unmounts reversibly: capability gone, events reconstruct history", async () => {
    await supervisor.unmount(manifest.id);
    expect(container.hasProviders("dev.tantalar.capability.hello.greet")).toBe(false);
    expect(supervisor.get(manifest.id)).toBeUndefined();

    const unmounted = await bus.read({ typePrefix: "dev.tantalar.event.plugin.unmounted" });
    expect(unmounted.length).toBe(1);

    // Replay API reconstructs the full lifecycle story.
    const story = await bus.read({ subject: manifest.id });
    const types = story.map((e) => e.type);
    expect(types).toContain("dev.tantalar.event.plugin.mounted");
    expect(types).toContain("dev.tantalar.event.plugin.crashed");
    expect(types).toContain("dev.tantalar.event.plugin.restarted");
    expect(types).toContain("dev.tantalar.event.plugin.unmounted");
    expect(types.indexOf("dev.tantalar.event.plugin.mounted"))
      .toBeLessThan(types.indexOf("dev.tantalar.event.plugin.unmounted"));
  });

  it("rejects requests immediately when the plugin control pipe closes", async () => {
    const ioSup = new Supervisor({
      bus,
      container,
      scheduler,
      restartPolicy: policy,
      healthIntervalMs: 5000,
      resolveEntry: (m) => {
        const [cmd, ...rest] = m.entry.command.split(" ");
        return { command: cmd ?? "node", args: rest.filter(Boolean), env: {} };
      },
    });
    await ioSup.mount(manifest, {});
    const provider = container.resolve("dev.tantalar.capability.hello.greet");
    const handle = ioSup.testGetProc(manifest.id);
    expect(handle?.stdin).toBeTruthy();
    handle!.stdin!.end();

    const outcome = await Promise.race([
      provider.invoke("greet", { name: "closed-pipe" }).then(
        () => "resolved",
        (error: unknown) => error,
      ),
      new Promise<string>((resolveTimeout) => setTimeout(() => resolveTimeout("timed-out"), 500)),
    ]);
    expect(outcome).toBeInstanceOf(Error);
    await ioSup.stopAll().catch(() => undefined);
  });

  it("marks failed when restarts exceed the window policy", async () => {
    const crashy: PluginManifest = {
      id: "dev.tantalar.plugin.crashy",
      version: "0.1.0",
      protocolVersion: 1,
      provides: ["dev.tantalar.capability.crashy.noop"], // non-empty per contract
      requires: [],
      subscriptions: [],
      entry: { command: "node --bad-flag-crashy" }, // exits immediately every time
    };
    const tight: RestartPolicy = {
      initialBackoffMs: 10,
      maxBackoffMs: 20,
      backoffMultiplier: 1,
      windowMs: 60_000,
      maxRestartsInWindow: 2,
    };
    const sup = new Supervisor({
      bus,
      container,
      scheduler,
      restartPolicy: tight,
      healthIntervalMs: 5000,
      resolveEntry: (m) => {
        const [cmd, ...rest] = m.entry.command.split(" ");
        return { command: cmd ?? "node", args: rest.filter(Boolean), env: {} };
      },
    });
    await sup.mount(crashy, {});
    await new Promise((r) => setTimeout(r, 800));
    expect(sup.get(crashy.id)?.state).toBe("failed");
    const failed = await bus.read({ typePrefix: "dev.tantalar.event.plugin.failed" });
    expect(failed.some((e) => e.subject === crashy.id)).toBe(true);
    await sup.stopAll().catch(() => undefined);
  });
});
