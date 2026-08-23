import { describe, expect, it } from "vitest";
import {
  DEFAULT_CONFIG,
  deepMerge,
  dumpConfig,
  loadConfig,
  parseConfigYaml,
  redact,
  unknownKeys,
  unsecret,
} from "@tantalar/config";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("config layering (ADR-0010)", () => {
  it("defaults load without warnings", () => {
    const { config, warnings } = loadConfig({ env: {} });
    expect(config).toEqual(DEFAULT_CONFIG);
    expect(warnings).toEqual([]);
  });

  it("later layers deep-merge over earlier ones", () => {
    const merged = deepMerge(DEFAULT_CONFIG, {
      server: { port: 9999 },
    });
    expect((merged.server as Record<string, unknown>).port).toBe(9999);
    expect((merged.server as Record<string, unknown>).host).toBe("127.0.0.1");
  });

  it("lists replace unless the key ends in +", () => {
    const base = { items: ["a"], tags: ["x"] };
    const merged = deepMerge(base, { items: ["b"], "tags+": ["y"] });
    expect(merged.items).toEqual(["b"]);
    expect(merged.tags).toEqual(["x", "y"]);
  });

  it("profile and host files compose with precedence", () => {
    const dir = mkdtempSync(join(tmpdir(), "tantalar-cfg-"));
    const profile = join(dir, "profile.yaml");
    const host = join(dir, "host.yaml");
    writeFileSync(profile, "server:\n  port: 8000\nlogging:\n  level: debug\n");
    writeFileSync(host, "server:\n  port: 9000\n");
    const { config } = loadConfig({ profileFile: profile, hostFile: host, env: {} });
    const server = config.server as Record<string, unknown>;
    expect(server.port).toBe(9000); // host beats profile
    expect((config.logging as Record<string, unknown>).level).toBe("debug");
  });

  it("env secrets apply under their path", () => {
    const loaded = loadConfig({
      env: { TANTALAR_SECRET_DATABASE__POSTGRES__URL: "postgres://secret" },
    });
    // Raw config holds the secret wrapper; unsecret() resolves real values.
    const resolved = unsecret(loaded.config) as { database: { postgres?: { url: string } } };
    expect(resolved.database.postgres?.url).toBe("postgres://secret");
  });
  it("unknown keys warn but do not fail", () => {
    const dir = mkdtempSync(join(tmpdir(), "tantalar-cfg-"));
    const file = join(dir, "host.yaml");
    writeFileSync(file, "server:\n  port: 1\n  bogusKey: 2\n");
    const { warnings } = loadConfig({ hostFile: file, env: {} });
    expect(warnings.some((w) => w.message.includes("server.bogusKey"))).toBe(true);
  });

  it("dumpConfig redacts secrets and output is a valid input layer", () => {
    const cfg = deepMerge(DEFAULT_CONFIG, {
      database: { postgres: { url: "postgres://user:pw123@h/db" } },
      auth: { password: "hunter2" },
    });
    const dumped = dumpConfig(cfg);
    expect(dumped).not.toContain("hunter2"); // secret-shaped key name
    // Non-secret key names are masked only when supplied via TANTALAR_SECRET_*:
    const loaded = loadConfig({
      env: { TANTALAR_SECRET_DATABASE__POSTGRES__URL: "plain-secret-value" },
    });
    const envDump = dumpConfig(loaded.config);
    expect(envDump).not.toContain("plain-secret-value");
    expect(envDump).toContain("[REDACTED]");
    expect(dumped).toContain("[REDACTED]");
    // The redacted dump is structurally a valid layer.
    const reparsed = parseConfigYaml(envDump);
    // The dump contains only sections that exist in the defaults schema
    // (database.postgres is an optional extension of the sqlite default).
    expect(Object.keys(reparsed).sort()).toEqual(
      Object.keys(DEFAULT_CONFIG).sort(),
    );
    expect(redact({ nested: { apiKey: "k" } })).toEqual({ nested: { apiKey: "[REDACTED]" } });
  });
});
