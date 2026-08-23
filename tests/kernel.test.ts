import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { boot, type Kernel } from "../apps/server/src/kernel.js";
import { resolve } from "node:path";

let kernel: Kernel;
let dir: string;
let address = "";

const PLUGIN_ENTRY = "node " + resolve("plugins/hello-world/dist/plugin.js");

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "tantalar-kernel-"));
  kernel = await boot({
    env: {},
    skipConfigPlugins: false,
    cliOverrides: {
      server: { port: 0 },
      database: { dialect: "sqlite", sqlite: { path: join(dir, "boot.db") } },
      plugins: {
        set: {
          "dev.tantalar.plugin.hello-world": {
            enabled: true,
            manifestPath: undefined,
          },
        },
      },
    },
  });
  address = await kernel.listen("127.0.0.1", 0);
});

afterAll(async () => {
  await kernel.shutdown();
});

describe("kernel boot sequence (config -> migrate -> log -> container -> supervisor -> HTTP)", () => {
  it("boots healthy and serves readiness", async () => {
    const res = await fetch(`${address}/readyz`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { ok: boolean }).ok).toBe(true);
    const healthz = await fetch(`${address.replace(/\/$/, "")}/healthz`);
    expect(healthz.status).toBe(200);
  });

  it("records a boot event in the append-only log", async () => {
    const booted = await kernel.bus.read({ typePrefix: "dev.tantalar.event.server.booted" });
    expect(booted.length).toBe(1);
  });

  it("migrations are idempotent across boots on the same database", async () => {
    // Re-open the same DB path; migrate must be a no-op success.
    const second = kernel.db;
    void second;
    // Booting again against the same sqlite file must not fail.
    const k2 = await boot({
      env: {},
      skipConfigPlugins: true,
      cliOverrides: {
        server: { port: 0 },
        database: { dialect: "sqlite", sqlite: { path: join(dir, "boot.db") } },
      },
    });
    await k2.shutdown();
  });

  it("--dump-config output is redacted and parseable as an input layer", async () => {
    const { loadConfig, dumpConfig, parseConfigYaml } = await import("@tantalar/config");
    const loaded = loadConfig({ env: { TANTALAR_SECRET_DATABASE__POSTGRES__URL: "postgres://u:pw123@h/d" } });
    const dumped = dumpConfig(loaded.config);
    expect(dumped).not.toContain("secretpw");
    expect(dumped).toContain("[REDACTED]");
    // Redacted dump is still a structurally valid config layer.
    const reparsed = parseConfigYaml(dumped);
    expect(typeof reparsed).toBe("object");
  });
});
