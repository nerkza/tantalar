import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { boot, type Kernel } from "../apps/server/src/kernel.js";

let kernel: Kernel;
let dir: string;
let address = "";

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "tantalar-kernel-"));
  // Standard install: default first-party plugin set mounts from the repo
  // root; the required capabilities must be present before /readyz is 200.
  kernel = await boot({
    env: {},
    cliOverrides: {
      server: { port: 0 },
      database: { dialect: "sqlite", sqlite: { path: join(dir, "boot.db") } },
    },
  });
  address = await kernel.listen("127.0.0.1", 0);
});

afterAll(async () => {
  await kernel.shutdown();
});

describe("kernel boot sequence (config -> migrate -> log -> container -> supervisor -> HTTP)", () => {
  it("boots the standard install and readiness reflects capability presence", async () => {
    const report = kernel.readiness();
    expect(report.ready).toBe(true);
    expect(report.missingCapabilities).toEqual([]);
    const res = await fetch(`${address}/readyz`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { ok: boolean }).ok).toBe(true);
    const healthz = await fetch(`${address.replace(/\/$/, "")}/healthz`);
    expect(healthz.status).toBe(200);
  });

  it("first-party modules mounted through the manifest loader are healthy", () => {
    const mounted = kernel.supervisor.list();
    const byId = new Map(mounted.map((p) => [p.manifest.id, p]));
    expect(byId.get("dev.tantalar.plugin.serving")?.state).toBe("healthy");
    expect(byId.get("dev.tantalar.plugin.fixture-indexer")?.state).toBe("healthy");
    expect(byId.get("dev.tantalar.plugin.library")?.state).toBe("healthy");
  });

  it("records a boot event in the append-only log", async () => {
    const booted = await kernel.bus.read({ typePrefix: "dev.tantalar.event.server.booted" });
    expect(booted.length).toBe(1);
  });

  it("migrations are idempotent across boots on the same database", async () => {
    // Booting again against the same sqlite file must not fail.
    const k2 = await boot({
      env: {},
      skipConfigPlugins: true,
      cliOverrides: {
        server: { port: 0 },
        database: { dialect: "sqlite", sqlite: { path: join(dir, "boot.db") } },
        // No required capabilities in this probe boot: it only proves the
        // migrate path is idempotent.
        plugins: { set: {}, requiredCapabilities: [] } as never,
      },
    });
    await k2.shutdown();
  });

  it("a missing required capability fails readiness with detail (mount completion is not readiness)", async () => {
    const k3 = await boot({
      env: {},
      skipConfigPlugins: true,
      cliOverrides: {
        server: { port: 0 },
        database: { dialect: "sqlite", sqlite: { path: join(dir, "probe.db") } },
        plugins: {
          set: {},
          requiredCapabilities: ["dev.tantalar.capability.indexer"],
        } as never,
      },
    });
    const addr = await k3.listen("127.0.0.1", 0);
    const report = k3.readiness();
    expect(report.ready).toBe(false);
    expect(report.listening).toBe(true);
    expect(report.missingCapabilities).toEqual(["dev.tantalar.capability.indexer"]);
    const res = await fetch(`${addr}/readyz`);
    expect(res.status).toBe(503);
    const body = (await res.json()) as { missingCapabilities: string[] };
    expect(body.missingCapabilities).toEqual(["dev.tantalar.capability.indexer"]);
    await k3.shutdown();
  });

  it("--dump-config output is redacted and parseable as an input layer", async () => {
    const { loadConfig, dumpConfig, parseConfigYaml } = await import("@tantalar/config");
    const loaded = loadConfig({ env: { TANTALAR_SECRET_DATABASE__POSTGRES__URL: "postgres://u:secretpw@h/d" } });
    const dumped = dumpConfig(loaded.config);
    expect(dumped).not.toContain("secretpw");
    expect(dumped).toContain("[REDACTED]");
    // Redacted dump is still a structurally valid config layer.
    const reparsed = parseConfigYaml(dumped);
    expect(typeof reparsed).toBe("object");
  });

  it("default port is 8790 and TANTALAR-style config still overrides", async () => {
    const { loadConfig } = await import("@tantalar/config");
    const loaded = loadConfig({ env: {} });
    expect((loaded.config.server as { port: number }).port).toBe(8790);
    const overridden = loadConfig({
      cliOverrides: { server: { port: 9999 } },
    });
    expect((overridden.config.server as { port: number }).port).toBe(9999);
  });
});
