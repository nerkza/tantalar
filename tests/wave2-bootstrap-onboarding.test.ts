/**
 * Wave 2 (TAN-002 / TAN-003): secure one-time bootstrap + guided onboarding.
 * API-level coverage: transactional bootstrap fail-closed, concurrent
 * bootstrap requests, onboarding step lifecycle (complete, skip optional,
 * resume, required-not-skippable, final-health ordering), and durability
 * across a simulated restart (fresh service instance over the same DB).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate, openDatabase, type Db } from "@tantalar/db";
import { Kysely } from "kysely";
import { AuthService } from "../apps/server/src/auth.js";
import { EventBus } from "../apps/server/src/events.js";
import { ServiceContainer } from "../apps/server/src/container.js";
import type { Supervisor } from "../apps/server/src/supervisor.js";
import { buildServer } from "../apps/server/src/http.js";
import { OnboardingService, ONBOARDING_STEPS } from "../apps/server/src/onboarding.js";

let db: Kysely<Db>;
let auth: AuthService;
let bus: EventBus;
let address = "";
let app: Awaited<ReturnType<typeof buildServer>>;
let sessionCookie = "";
let csrfToken = "";

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), "tantalar-wave2-"));
  db = await openDatabase({ dialect: "sqlite", sqlitePath: join(dir, "test.db") });
  await migrate(db);
  auth = new AuthService(db);
  bus = new EventBus(db);
  const container = new ServiceContainer();
  const supervisor = { list: () => [] } as unknown as Supervisor;
  app = await buildServer({ auth, db, bus, supervisor, container, ready: () => true });
  await app.listen({ port: 0, host: "127.0.0.1" });
  address = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
});

afterAll(async () => {
  await app.close();
  await db.destroy();
});

async function post(path: string, body?: unknown) {
  return fetch(`${address}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

async function authenticated(path: string, init: RequestInit = {}) {
  return fetch(`${address}${path}`, {
    ...init,
    headers: {
      cookie: sessionCookie,
      "x-csrf-token": csrfToken,
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });
}

describe("TAN-002 secure bootstrap", () => {
  it("rejects weak credentials with a product-facing message", async () => {
    const before = await fetch(`${address}/api/v1/bootstrap/status`);
    expect(before.status).toBe(200);
    expect(await before.json()).toEqual({ required: true });

    const res = await post("/api/v1/bootstrap/admin", { username: "admin", password: "short" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/8 characters/);
    // Still open — no user was created.
    const probe = await post("/api/v1/bootstrap/admin", {
      username: "admin",
      password: "password-admin-1",
    });
    expect(probe.status).toBe(200);

    const after = await fetch(`${address}/api/v1/bootstrap/status`);
    expect(await after.json()).toEqual({ required: false });
  });

  it("creates exactly one administrator; later calls fail closed", async () => {
    // The previous test seeded the admin; every further call is closed.
    const again = await post("/api/v1/bootstrap/admin", {
      username: "attacker",
      password: "password-evil-1",
    });
    expect(again.status).toBe(403);
    expect(((await again.json()) as { error: string }).error).toMatch(/Sign in/);

    const users = await db.selectFrom("users").selectAll().execute();
    expect(users).toHaveLength(1);
    expect(users[0]?.role).toBe("admin");
    expect(users[0]?.username).toBe("admin");

    // The seeded admin can sign in.
    const login = await post("/api/v1/auth/login", {
      username: "admin",
      password: "password-admin-1",
    });
    expect(login.status).toBe(200);
    const setCookie = login.headers.getSetCookie?.() ?? [];
    sessionCookie = setCookie.map((c) => c.split(";")[0]).join("; ");
    csrfToken = ((await login.json()) as { csrfToken: string }).csrfToken;
  });

  it("survives concurrent bootstrap requests without creating two admins", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tantalar-wave2-race-"));
    const raceDb = await openDatabase({ dialect: "sqlite", sqlitePath: join(dir, "race.db") });
    await migrate(raceDb);
    const raceAuth = new AuthService(raceDb);
    try {
      const attempts = await Promise.all(
        Array.from({ length: 12 }, (_, i) =>
          raceAuth.createInitialAdmin(`racer${i === 0 ? "" : i}`, "password-racer-1"),
        ),
      );
      const created = attempts.filter((a) => a.ok);
      expect(created).toHaveLength(1);
      const users = await raceDb.selectFrom("users").selectAll().execute();
      expect(users).toHaveLength(1);
      // Every loser fails closed, never "invalid".
      for (const a of attempts.filter((x) => !x.ok)) {
        expect(a.reason).toBe("closed");
      }
    } finally {
      await raceDb.destroy();
    }
  });

  it("existing installs go to sign-in: bootstrap closed once any user exists", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tantalar-wave2-existing-"));
    const existingDb = await openDatabase({
      dialect: "sqlite",
      sqlitePath: join(dir, "existing.db"),
    });
    await migrate(existingDb);
    const existingAuth = new AuthService(existingDb);
    await existingAuth.createUser("ops", "password-ops-01", "viewer");
    const res = await existingAuth.createInitialAdmin("newcomer", "password-new-01");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("closed");
    await existingDb.destroy();
  });
});

describe("TAN-003 guided onboarding API", () => {
  it("first-run probe works without a session on a zero-user install", async () => {
    // Fresh server with no users: the unauthenticated read must succeed so
    // the web app can detect setup state (regression for review round 2).
    const dir = mkdtempSync(join(tmpdir(), "tantalar-wave2-probe-"));
    const probeDb = await openDatabase({ dialect: "sqlite", sqlitePath: join(dir, "probe.db") });
    await migrate(probeDb);
    const probeApp = await buildServer({
      auth: new AuthService(probeDb),
      db: probeDb,
      bus,
      supervisor: { list: () => [] } as unknown as Supervisor,
      container: new ServiceContainer(),
      ready: () => true,
    });
    await probeApp.listen({ port: 0, host: "127.0.0.1" });
    const probeAddress = `http://127.0.0.1:${
      (probeApp.server.address() as { port: number }).port
    }`;
    try {
      const res = await fetch(`${probeAddress}/api/v1/onboarding`);
      expect(res.status).toBe(200);
      const state = (await res.json()) as {
        steps: Record<string, { status: string }>;
        complete: boolean;
      };
      expect(state.complete).toBe(false);
      for (const id of ONBOARDING_STEPS) expect(state.steps[id].status).toBe("pending");
      // Mutations stay closed to anonymous callers.
      const mutation = await fetch(`${probeAddress}/api/v1/onboarding/steps/administrator`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "complete" }),
      });
      expect(mutation.status).toBe(401);
    } finally {
      await probeApp.close();
      await probeDb.destroy();
    }
  });

  it("rejects unauthenticated reads and mutations", async () => {
    expect((await fetch(`${address}/api/v1/onboarding`)).status).toBe(401);
    expect(
      (await post("/api/v1/onboarding/steps/administrator", { action: "complete" })).status,
    ).toBe(401);
  });

  it("starts all-pending and reports incomplete", async () => {
    const res = await authenticated("/api/v1/onboarding");
    expect(res.status).toBe(200);
    const state = (await res.json()) as {
      steps: Record<string, { status: string }>;
      complete: boolean;
    };
    for (const id of ONBOARDING_STEPS) {
      expect(state.steps[id].status).toBe("pending");
    }
    expect(state.complete).toBe(false);
  });

  it("unknown step ids get a product-facing 404", async () => {
    const res = await authenticated("/api/v1/onboarding/steps/not-a-step", {
      method: "POST",
      body: JSON.stringify({ action: "complete" }),
    });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toMatch(/not an onboarding step/);
  });

  it("required steps cannot be skipped", async () => {
    const res = await authenticated("/api/v1/onboarding/steps/administrator", {
      method: "POST",
      body: JSON.stringify({ action: "skip" }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/required/);
  });

  it("final health cannot complete while earlier steps are pending", async () => {
    const res = await authenticated("/api/v1/onboarding/steps/final-health", {
      method: "POST",
      body: JSON.stringify({ action: "complete" }),
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toMatch(/earlier setup steps/);
  });

  it("completes steps in order, skips optional ones, and finishes durably", async () => {
    const order = [
      ["administrator", "complete"],
      ["experience", "complete"],
      ["libraries", "skip"],
      ["acquisition", "skip"],
      ["metadata", "skip"],
      ["first-title", "skip"],
      ["final-health", "complete"],
    ] as const;
    let last: { complete: boolean } | null = null;
    for (const [stepId, action] of order) {
      const res = await authenticated(`/api/v1/onboarding/steps/${stepId}`, {
        method: "POST",
        body: JSON.stringify({ action }),
      });
      expect(res.status).toBe(200);
      last = (await res.json()) as { complete: boolean };
    }
    expect(last?.complete).toBe(true);

    const finalState = await authenticated("/api/v1/onboarding");
    const state = (await finalState.json()) as {
      steps: Record<string, { status: string }>;
      complete: boolean;
    };
    expect(state.complete).toBe(true);
    expect(state.steps["acquisition"].status).toBe("skipped");
    expect(state.steps["playback"].status).toBe("skipped");
  });

  it("completion state survives a restart (fresh service over the same DB)", async () => {
    const fresh = new OnboardingService(db);
    const state = await fresh.getState();
    expect(state.complete).toBe(true);
    // Re-completing a finished step is an idempotent no-op.
    const after = await fresh.setStep("administrator", "complete");
    expect(after.steps["administrator"].status).toBe("done");
    expect(after.complete).toBe(true);
  });

  it("keeps Media optional after setup and preserves completion when enabled later", async () => {
    const response = await authenticated("/api/v1/onboarding/preferences", {
      method: "PUT", body: JSON.stringify({ mediaEnabled: true }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ complete: true, mediaEnabled: true });
    expect(await new OnboardingService(db).getState()).toMatchObject({ complete: true, mediaEnabled: true });
  });

  it("rejects viewer and missing-CSRF preference changes and never stores secret fields", async () => {
    const noCsrf = await fetch(`${address}/api/v1/onboarding/preferences`, {
      method: "PUT", headers: { cookie: sessionCookie, "content-type": "application/json" }, body: JSON.stringify({ mediaEnabled: false }),
    });
    expect(noCsrf.status).toBe(403);
    await auth.createUser("setup-viewer", "password-viewer-1", "viewer");
    const login = await post("/api/v1/auth/login", { username: "setup-viewer", password: "password-viewer-1" });
    const cookie = login.headers.getSetCookie().map(value => value.split(";")[0]).join("; ");
    const { csrfToken: viewerCsrf } = await login.json() as { csrfToken: string };
    const viewer = await fetch(`${address}/api/v1/onboarding/preferences`, {
      method: "PUT", headers: { cookie, "x-csrf-token": viewerCsrf, "content-type": "application/json" }, body: JSON.stringify({ mediaEnabled: false }),
    });
    expect(viewer.status).toBe(403);
    await authenticated("/api/v1/onboarding/preferences", { method: "PUT", body: JSON.stringify({ password: "must-not-persist", apiKey: "must-not-persist", currentStep: "metadata" }) });
    const row = await db.selectFrom("onboarding_state").select("steps").executeTakeFirstOrThrow();
    expect(row.steps).not.toContain("must-not-persist");
    const invalid = await authenticated("/api/v1/onboarding/preferences", { method: "PUT", body: JSON.stringify({ currentStep: "unknown" }) });
    expect(invalid.status).toBe(400);
  });

  it("records a failed check and retains it when left for later", async () => {
    await authenticated("/api/v1/onboarding/preferences", { method: "PUT", body: JSON.stringify({ metadataQuery: "Alien", currentStep: "metadata" }) });
    const result = await authenticated("/api/v1/onboarding/steps/metadata", { method: "POST", body: JSON.stringify({ action: "complete" }) });
    expect(await result.json()).toMatchObject({ steps: { metadata: { status: "failed" } }, metadataQuery: "Alien" });
    const skipped = await authenticated("/api/v1/onboarding/steps/metadata", { method: "POST", body: JSON.stringify({ action: "skip" }) });
    expect(await skipped.json()).toMatchObject({ steps: { metadata: { status: "skipped", detail: expect.stringContaining("retry") } } });
  });

  it("migrates legacy records without forcing completed installs through setup or claiming playback", async () => {
    const legacyIds = ["administrator", "storage", "libraries", "download-engines", "indexers", "metadata", "vpn-policy", "final-health"];
    const legacy = Object.fromEntries(legacyIds.map(id => [id, { status: "done" }]));
    await db.updateTable("onboarding_state").set({ steps: JSON.stringify(legacy) }).where("id", "=", "global").execute();
    const service = new OnboardingService(db);
    expect(await service.getState()).toMatchObject({ complete: true, mediaEnabled: true, steps: { playback: { status: "skipped" }, libraries: { status: "configured" } } });
    legacy["final-health"] = { status: "pending" };
    legacy["libraries"] = { status: "pending" };
    legacy["metadata"] = { status: "skipped" };
    await db.updateTable("onboarding_state").set({ steps: JSON.stringify(legacy) }).where("id", "=", "global").execute();
    expect(await service.getState()).toMatchObject({ complete: false, currentStep: "experience", steps: { metadata: { status: "skipped" } } });
    await Promise.all([service.preferences({ mediaEnabled: true }), service.preferences({ metadataQuery: "Alien" })]);
    expect(await new OnboardingService(db).getState()).toMatchObject({ mediaEnabled: true, metadataQuery: "Alien" });
  });
});
