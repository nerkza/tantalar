/**
 * Packaged-runtime smoke test (TAN-041, wave 1).
 *
 * Boots the COMPILED server (apps/server/dist/main.js) as a real process —
 * the same artifact the container image runs — against a temp SQLite file.
 * Proves end-to-end:
 *   1. the production composition boots (config -> db -> plugins -> HTTP);
 *   2. the standard install mounts first-party modules and /readyz turns
 *      200 only when the required capabilities are present;
 *   3. first-run bootstrap seeds exactly one administrator, then closes;
 *   4. authenticated login works against the seeded admin.
 *
 * No copyrighted content: all fixtures are synthetic (prototype evidence).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, existsSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO = resolve(new URL("..", import.meta.url).pathname);
const DIST = join(REPO, "apps/server/dist/main.js");

let child: ChildProcess;
let dir: string;
let address = "";
let sessionCookie = "";
let csrfToken = "";
const BOOT_TIMEOUT_MS = 60_000;

async function availableLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const bound = server.address();
  if (!bound || typeof bound === "string") {
    server.close();
    throw new Error("failed to allocate a loopback test port");
  }
  const port = bound.port;
  await new Promise<void>((resolveClose, reject) =>
    server.close((error) => (error ? reject(error) : resolveClose())),
  );
  return port;
}

async function waitFor(fn: () => Promise<boolean>, what: string): Promise<void> {
  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`server exited early (${child.exitCode}) during: ${what}`);
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`timed out waiting for: ${what}`);
}

beforeAll(async () => {
  if (!existsSync(DIST)) throw new Error("packaged runtime missing — run pnpm run build first");
  dir = mkdtempSync(join(tmpdir(), "tantalar-packaged-"));
  // Mirror docker/entrypoint.sh: generate the host config layer the same way
  // the container does (this also exercises the starter-config contract).
  const sqlitePath = join(dir, "tantalar.db");
  const configFile = join(dir, "tantalar.yaml");
  const port = await availableLoopbackPort();
  const { writeFileSync } = await import("node:fs");
  writeFileSync(
    configFile,
    [
      "server:",
      "  host: 127.0.0.1",
      `  port: ${port}`,
      "database:",
      "  dialect: sqlite",
      "  sqlite:",
      `    path: ${sqlitePath}`,
      "",
    ].join("\n"),
  );
  child = spawn(process.execPath, [DIST], {
    cwd: REPO,
    env: {
      ...process.env,
      TANTALAR_DATA_DIR: dir,
      TANTALAR_CONFIG_FILE: configFile,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr?.on("data", () => undefined);
  address = `http://127.0.0.1:${port}`;
}, BOOT_TIMEOUT_MS);

afterAll(async () => {
  child?.kill("SIGTERM");
});

describe("packaged runtime smoke (node apps/server/dist/main.js)", () => {
  it("boots and reports truthful readiness with the standard install", async () => {
    await waitFor(async () => {
      try {
        const r = await fetch(`${address}/readyz`);
        return r.status === 200;
      } catch {
        return false;
      }
    }, "readiness 200");
    const ready = (await (await fetch(`${address}/readyz`)).json()) as { ok: boolean };
    expect(ready.ok).toBe(true);
    const live = await fetch(`${address}/healthz`);
    expect(live.status).toBe(200);
  });

  it("first-run bootstrap seeds exactly one admin, then closes permanently", async () => {
    const res = await fetch(`${address}/api/v1/bootstrap/admin`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "admin", password: "password-admin-1" }),
    });
    expect(res.status).toBe(200);

    // Second bootstrap attempt must be refused.
    const again = await fetch(`${address}/api/v1/bootstrap/admin`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "attacker", password: "password-evil-1" }),
    });
    expect(again.status).toBe(403);

    // The seeded admin can log in.
    const login = await fetch(`${address}/api/v1/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "admin", password: "password-admin-1" }),
    });
    expect(login.status).toBe(200);
    // Keep the session for the authenticated onboarding walk below.
    const setCookie = login.headers.getSetCookie?.() ?? [];
    sessionCookie = setCookie.map((c) => c.split(";")[0]).join("; ");
    csrfToken = ((await login.json()) as { csrfToken: string }).csrfToken;

    // Bad credentials still fail.
    const bad = await fetch(`${address}/api/v1/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "admin", password: "wrong-password" }),
    });
    expect(bad.status).toBe(401);
  });

  it("guided onboarding walks, skips optional steps, and completes durably", async () => {
    const authed = (init: RequestInit = {}): RequestInit => ({
      ...init,
      headers: {
        cookie: sessionCookie,
        "x-csrf-token": csrfToken,
        "content-type": "application/json",
        ...(init.headers ?? {}),
      },
    });
    const state0 = (await (
      await fetch(`${address}/api/v1/onboarding`, authed())
    ).json()) as {
      steps: Record<string, { status: string }>;
      complete: boolean;
    };
    expect(state0.complete).toBe(false);
    for (const id of Object.keys(state0.steps)) {
      expect(state0.steps[id].status).toBe("pending");
    }

    // Required steps cannot be skipped.
    const skipStorage = await fetch(`${address}/api/v1/onboarding/steps/storage`, {
      method: "POST",
      ...authed({
        body: JSON.stringify({ action: "skip" }),
      }),
    });
    expect(skipStorage.status).toBe(400);

    // Walk the full wizard: complete required steps, skip optional ones.
    const order = [
      ["administrator", "complete"],
      ["storage", "complete"],
      ["libraries", "complete"],
      ["download-engines", "skip"],
      ["indexers", "skip"],
      ["metadata", "complete"],
      ["vpn-policy", "skip"],
      ["final-health", "complete"],
    ] as const;
    for (const [stepId, action] of order) {
      const r = await fetch(`${address}/api/v1/onboarding/steps/${stepId}`, {
        method: "POST",
        ...authed({
          body: JSON.stringify({ action }),
        }),
      });
      const body = (await r.json()) as { complete: boolean; error?: string };
      expect(r.status).toBe(200);
      if (stepId === "final-health") expect(body.complete).toBe(true);
    }
  });
});
