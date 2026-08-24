/**
 * Docker entrypoint durability (TAN-007, wave 1).
 *
 * Proves the starter-config contract by executing the real entrypoint
 * script with sh in a sandboxed temp root:
 *   - first `server` invocation writes the starter config;
 *   - a second invocation PRESERVES operator edits (no overwrite);
 *   - TANTALAR_RESET_CONFIG=1 regenerates deliberately;
 *   - default port constant is 8790; TANTALAR_PORT overrides.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ENTRYPOINT = resolve("docker/entrypoint.sh");
let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "tantalar-entrypoint-"));
  mkdirSync(join(dir, "data"), { recursive: true });
  chmodSync(ENTRYPOINT, 0o755);
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function runServer(extraEnv: Record<string, string> = {}): void {
  // The entrypoint execs node main.js on success; stub node resolution by
  // overriding PATH so the exec target is a no-op script.
  const bin = join(dir, "bin");
  mkdirSync(bin, { recursive: true });
  const stub = join(bin, "node");
  writeFileSync(stub, "#!/bin/sh\nexit 0\n");
  chmodSync(stub, 0o755);
  execFileSync(ENTRYPOINT, ["server"], {
    env: {
      ...process.env,
      PATH: `${bin}:${process.env["PATH"]}`,
      TANTALAR_CONFIG_FILE: join(dir, "tantalar.yaml"),
      TANTALAR_DATA_DIR: join(dir, "data"),
      ...extraEnv,
    },
  });
}

const configPath = () => join(dir, "tantalar.yaml");

describe("entrypoint starter-config durability", () => {
  it("writes the starter config when absent, defaulting to port 8790", () => {
    runServer();
    const text = readFileSync(configPath(), "utf8");
    expect(text).toContain("port: 8790");
    expect(text).toContain("dialect: sqlite");
  });

  it("does NOT overwrite an existing config across restarts (operator edits survive)", () => {
    const edited = readFileSync(configPath(), "utf8").replace("8790", "9999");
    writeFileSync(configPath(), edited);
    runServer();
    expect(readFileSync(configPath(), "utf8")).toContain("port: 9999");
  });

  it("regenerates the starter config only when TANTALAR_RESET_CONFIG=1", () => {
    runServer({ TANTALAR_RESET_CONFIG: "1" });
    expect(readFileSync(configPath(), "utf8")).toContain("port: 8790");
  });

  it("TANTALAR_PORT overrides the starter port on a fresh install", () => {
    const bin = join(dir, "bin2");
    mkdirSync(bin, { recursive: true });
    const stub = join(bin, "node");
    writeFileSync(stub, "#!/bin/sh\nexit 0\n");
    chmodSync(stub, 0o755);
    const fresh = join(dir, "fresh.yaml");
    execFileSync(ENTRYPOINT, ["server"], {
      env: {
        ...process.env,
        PATH: `${bin}:${process.env["PATH"]}`,
        TANTALAR_CONFIG_FILE: fresh,
        TANTALAR_DATA_DIR: join(dir, "data"),
        TANTALAR_PORT: "7654",
      },
    });
    expect(readFileSync(fresh, "utf8")).toContain("port: 7654");
  });
});
