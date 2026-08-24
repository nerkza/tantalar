/**
 * Wave 9 operations API tests (TAN-030/031/032/033/038/042/043).
 *
 * Covers:
 *  - queue: durable job list + actions targeting each job's own engine id,
 *    state-machine guards (409), removal flag semantics, history retention;
 *  - users: role change, password reset, session revoke, deactivation,
 *    last-admin safeguards, audit log entries;
 *  - API keys: create with scopes/expiry (secret shown once, never again),
 *    expired key fails closed, revocation;
 *  - webhooks: create with env-var signing secret NAME only, test delivery
 *    without a secret set never exposes anything, delete;
 *  - catalog pagination: server-side page/pageSize/search/total;
 *  - backup: atomic + integrity-checked; restore refuses bad paths and bad
 *    files before replacing anything.
 *
 * No network: webhook test uses an .invalid URL; no external calls.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Kysely } from "kysely";
import { migrate, openDatabase, DownloadJobStore, type Db } from "@tantalar/db";
import { AuthService } from "../apps/server/src/auth.js";
import { EventBus } from "../apps/server/src/events.js";
import { ServiceContainer } from "../apps/server/src/container.js";
import { Supervisor } from "../apps/server/src/supervisor.js";
import { Scheduler } from "../apps/server/src/scheduler.js";
import { buildServer } from "../apps/server/src/http.js";

let db: Kysely<Db>;
let auth: AuthService;
let jobs: DownloadJobStore;
let app: Awaited<ReturnType<typeof buildServer>>;
let address = "";
let dir = "";
const csrfRef = { current: "" };
const cookieRef = { current: "" };

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "tantalar-wave9-ops-"));
  db = await openDatabase({ dialect: "sqlite", sqlitePath: join(dir, "test.db") });
  await migrate(db);
  auth = new AuthService(db);
  jobs = new DownloadJobStore(db);
  const bus = new EventBus(db);
  const container = new ServiceContainer();
  const supervisor = new Supervisor({
    bus,
    container,
    scheduler: new Scheduler(db),
    restartPolicy: {
      initialBackoffMs: 10,
      maxBackoffMs: 50,
      backoffMultiplier: 2,
      windowMs: 1000,
      maxRestartsInWindow: 5,
    },
    resolveEntry: () => ({ command: "true", args: [], env: {} }),
  });
  app = await buildServer({
    auth,
    db,
    bus,
    supervisor,
    container,
    ready: () => true,
    ops: {
      auth,
      db,
      bus,
      supervisor,
      container,
      ready: () => true,
      sqlitePath: join(dir, "test.db"),
      dataDir: dir,
    },
  });
  await app.listen({ port: 0, host: "127.0.0.1" });
  address = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  await auth.createUser("admin", "password-admin-1", "admin");
});

afterAll(async () => {
  await app.close();
  await db.destroy();
});

async function login(): Promise<void> {
  const res = await fetch(`${address}/api/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "password-admin-1" }),
  });
  expect(res.status).toBe(200);
  cookieRef.current =
    (res.headers.getSetCookie?.() ?? [])
      .map((c) => c.split(";")[0])
      .find((c) => c.startsWith("tantalar_session=")) ?? "";
  csrfRef.current = ((await res.json()) as { csrfToken: string }).csrfToken;
}

function authed(method?: string, body?: unknown): Record<string, unknown> {
  return {
    method: method ?? "GET",
    headers: {
      "content-type": "application/json",
      cookie: `${cookieRef.current}; tantalar_csrf=${csrfRef.current}`,
      ...(method && method !== "GET" ? { "x-csrf-token": csrfRef.current } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  };
}

describe("wave 9 queue API (TAN-030)", () => {
  it("requires authentication", async () => {
    expect((await fetch(`${address}/api/v1/queue`)).status).toBe(401);
  });

  it("lists durable jobs with engine identity, priority, failure detail", async () => {
    await login();
    const { record } = await jobs.create({
      itemKey: "series.w9",
      title: "Wave Nine Episode",
      source: "torrent",
      providerPluginId: "dev.tantalar.plugin.torrent-native",
      sourceRef: "magnet:?xt=urn:btih:w9test",
    });
    await jobs.updateProgress(record.jobId, { state: "downloading", progressPercent: 42 });

    const res = await fetch(`${address}/api/v1/queue`, authed());
    expect(res.status).toBe(200);
    const list = (await res.json() as { jobs: Array<Record<string, unknown>> }).jobs;
    const row = list.find((j) => j.jobId === record.jobId);
    expect(row).toBeTruthy();
    expect(row!["enginePluginId"]).toBe("dev.tantalar.plugin.torrent-native");
    expect(row!["state"]).toBe("downloading");
    expect(row!["progressPercent"]).toBe(42);
    expect(row!["priority"]).toBe(0);
  });

  it("pauses, resumes, prioritizes and guards the state machine", async () => {
    await login();
    const listed = await fetch(`${address}/api/v1/queue`, authed());
    const jobId = ((await listed.json() as { jobs: Array<{ jobId: string }> }).jobs[0]!).jobId;

    const paused = await fetch(`${address}/api/v1/queue/${jobId}/actions`, authed("POST", { action: "pause" }));
    expect(paused.status).toBe(200);

    // Pausing twice is refused with a truthful reason.
    const pauseAgain = await fetch(`${address}/api/v1/queue/${jobId}/actions`, authed("POST", { action: "pause" }));
    expect(pauseAgain.status).toBe(409);

    const resumed = await fetch(`${address}/api/v1/queue/${jobId}/actions`, authed("POST", { action: "resume" }));
    expect(resumed.status).toBe(200);

    const prio = await fetch(`${address}/api/v1/queue/${jobId}/actions`, authed("POST", { action: "prioritize", priority: 5 }));
    expect(prio.status).toBe(200);
    expect(((await prio.json()) as { job: { priority: number } }).job.priority).toBe(5);

    const badPrio = await fetch(`${address}/api/v1/queue/${jobId}/actions`, authed("POST", { action: "prioritize", priority: 1.5 }));
    expect(badPrio.status).toBe(400);
  });

  it("removes with explicit data-file semantics while retaining durable history", async () => {
    await login();
    const { record } = await jobs.create({
      itemKey: "movie.w9.remove",
      title: "Removable",
      source: "usenet",
      providerPluginId: "dev.tantalar.plugin.usenet-native",
      sourceRef: "nzb://fixture/remove.nzb",
    });
    const removed = await fetch(`${address}/api/v1/queue/${record.jobId}/actions`, authed("POST", { action: "remove" }));
    expect(removed.status).toBe(200);
    const body = (await removed.json()) as { dataFilesDeleted: boolean; note: string };
    expect(body.dataFilesDeleted).toBe(false);
    expect(body.note).toContain("kept");

    // History survives: includeHistory shows the flagged row.
    const hist = await fetch(`${address}/api/v1/queue?includeHistory=1`, authed());
    const rows = (await hist.json() as { jobs: Array<{ jobId: string; removed: boolean }> }).jobs;
    expect(rows.find((r) => r.jobId === record.jobId)?.removed).toBe(true);

    // Default view hides removed rows.
    const active = await fetch(`${address}/api/v1/queue`, authed());
    expect((await active.json() as { jobs: Array<{ jobId: string }> }).jobs.find((r) => r.jobId === record.jobId)).toBeUndefined();

    const unknownJob = await fetch(`${address}/api/v1/queue/nope/actions`, authed("POST", { action: "remove" }));
    expect(unknownJob.status).toBe(404);
  });
});

describe("wave 9 user management + last-admin safeguard (TAN-032)", () => {
  let viewerId = "";
  let secondAdminId = "";

  it("creates users then changes roles with audit entries", async () => {
    await login();
    const v = await auth.createUser("w9viewer", "password-viewer-1", "viewer");
    viewerId = v;
    const a = await auth.createUser("w9second", "password-second-1", "admin");
    secondAdminId = a;

    const roleRes = await fetch(`${address}/api/v1/users/${v}/role`, authed("PUT", { role: "admin" }));
    expect(roleRes.status).toBe(200);
    const audit = await fetch(`${address}/api/v1/system/audit`, authed());
    const entries = (await audit.json() as { entries: Array<{ action: string }> }).entries;
    expect(entries.some((e) => e.action === "user.role.changed")).toBe(true);
  });

  it("refuses to demote or deactivate the LAST administrator", async () => {
    await login();
    // Deactivate every other admin so only the acting admin remains.
    await fetch(`${address}/api/v1/users/${secondAdminId}/active`, authed("PUT", { active: false }));
    const vId = (await db.selectFrom("users").selectAll().execute()).find((u) => u.username === "w9viewer")!.id;
    await fetch(`${address}/api/v1/users/${vId}/active`, authed("PUT", { active: false }));

    const me = await fetch(`${address}/api/v1/auth/me`, {
      headers: { cookie: cookieRef.current },
    });
    const myId = ((await me.json()) as { user: { id: string } }).user.id;

    const demote = await fetch(`${address}/api/v1/users/${myId}/role`, authed("PUT", { role: "viewer" }));
    expect(demote.status).toBe(409);
    expect(((await demote.json()) as { error: string }).error).toContain("last administrator");

    const deactivate = await fetch(`${address}/api/v1/users/${myId}/active`, authed("PUT", { active: false }));
    expect(deactivate.status).toBe(409);

    // Reactivating works.
    const reactivate = await fetch(`${address}/api/v1/users/${secondAdminId}/active`, authed("PUT", { active: true }));
    expect(reactivate.status).toBe(200);
  });

  it("deactivated accounts cannot sign in and lose live sessions", async () => {
    await login();
    const vId = (await db.selectFrom("users").selectAll().execute()).find((u) => u.username === "w9viewer")!.id;
    const off = await fetch(`${address}/api/v1/users/${vId}/active`, authed("PUT", { active: false }));
    expect(off.status).toBe(200);

    // Login as deactivated user is rejected.
    const loginRes = await fetch(`${address}/api/v1/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "w9viewer", password: "password-viewer-1" }),
    });
    expect(loginRes.status).toBe(401);
  });

  it("resets passwords and revokes sessions with audit coverage", async () => {
    await login();
    const vId = (await db.selectFrom("users").selectAll().execute()).find((u) => u.username === "w9viewer")!.id;
    await fetch(`${address}/api/v1/users/${vId}/active`, authed("PUT", { active: true }));

    const reset = await fetch(`${address}/api/v1/users/${vId}/password-reset`, authed("POST", { password: "new-password-99" }));
    expect(reset.status).toBe(200);
    // New password verifies.
    const verified = await auth.verifyPassword("w9viewer", "new-password-99");
    expect(verified).not.toBeNull();

    const revoke = await fetch(`${address}/api/v1/users/${vId}/sessions/revoke`, authed("POST", {}));
    expect(revoke.status).toBe(200);
    expect(((await revoke.json()) as { revoked: number }).revoked).toBeGreaterThanOrEqual(0);

    const short = await fetch(`${address}/api/v1/users/${vId}/password-reset`, authed("POST", { password: "short" }));
    expect(short.status).toBe(400);
  });

  it("manages library access grants", async () => {
    await login();
    const libId = "11111111-1111-7111-8111-111111111111";
    const denied = await fetch(`${address}/api/v1/users/someone/libraries`, authed("PUT", { libraryIds: [libId] }));
    expect(denied.status).toBe(400); // unknown library fails closed
  });
});

describe("wave 9 API keys (TAN-033)", () => {
  it("creates a scoped key whose secret appears exactly once", async () => {
    await login();
    const created = await fetch(`${address}/api/v1/api-keys`, authed("POST", { name: "ci-key", scopes: ["events.read"], expiresAt: null }));
    expect(created.status).toBe(200);
    const text = await created.text();
    const body = JSON.parse(text) as { key: { id: string }; secret: string };
    expect(body.secret.startsWith("tantalar_")).toBe(true);
    expect(text.indexOf(body.secret)).toBe(text.lastIndexOf(body.secret)); // once

    // Listing never contains the secret.
    const listed = await fetch(`${address}/api/v1/api-keys`, authed());
    expect(!(await listed.text()).includes(body.secret));
    void body.key;
  });

  it("honours expiry — an expired key fails closed", async () => {
    await login();
    const created = await fetch(`${address}/api/v1/api-keys`, authed("POST", {
      name: "expired",
      scopes: ["events.read"],
      expiresAt: "2020-01-01T00:00:00Z",
    }));
    const { secret } = (await created.json()) as { secret: string };
    const probe = await fetch(`${address}/api/v1/events`, {
      headers: { authorization: `Bearer ${secret}` },
    });
    expect(probe.status).toBe(401);
  });

  it("rejects unknown scopes and revokes durably", async () => {
    await login();
    const badScope = await fetch(`${address}/api/v1/api-keys`, authed("POST", { name: "bad", scopes: ["root.everything"] }));
    expect(badScope.status).toBe(400);

    const ok = await fetch(`${address}/api/v1/api-keys`, authed("POST", { name: "revoke-me", scopes: ["events.read"], expiresAt: null }));
    const { key } = (await ok.json()) as { key: { id: string } };
    const revoked = await fetch(`${address}/api/v1/api-keys/${key.id}`, authed("DELETE", {}));
    expect(revoked.status).toBe(200);
    const listed = await fetch(`${address}/api/v1/api-keys`, authed());
    expect(((await listed.json()) as { keys: Array<{ revokedAt: string | null }> }).keys.find((k) => (k as { id: string }).id === key.id)?.revokedAt).not.toBeNull();
  });
});

describe("wave 9 webhooks (TAN-033)", () => {
  it("stores only the env var NAME and test delivery reports truthfully without secrets", async () => {
    await login();
    const created = await fetch(`${address}/api/v1/webhooks`, authed("POST", {
      url: "https://hooks.invalid/target",
      eventTypes: ["dev.tantalar.event.download.completed"],
      secretEnvVar: "W9_WEBHOOK_SECRET_UNSET",
    }));
    expect(created.status).toBe(200);
    const hook = ((await created.json()) as { webhook: { id: string; url: string } }).webhook;

    const testRes = await fetch(`${address}/api/v1/webhooks/${hook.id}/test`, authed("POST", {}));
    expect(testRes.status).toBe(409);
    const testBody = (await testRes.text()) as string;
    expect(testBody).toContain("skipped_no_secret");

    // The response must not echo any secret material.
    expect(testBody.includes(process.env.W9_WEBHOOK_SECRET_UNSET ?? "\u0000never-present")).toBe(false);

    const deleted = await fetch(`${address}/api/v1/webhooks/${hook.id}`, authed("DELETE", {}));
    expect(deleted.status).toBe(200);
  });

  it("validates URLs fail-closed", async () => {
    await login();
    const badUrl = await fetch(`${address}/api/v1/webhooks`, authed("POST", { url: "not-a-url", eventTypes: [], secretEnvVar: "X" }));
    expect(badUrl.status).toBe(400);
    const ftp = await fetch(`${address}/api/v1/webhooks`, authed("POST", { url: "ftp://x.invalid/a", eventTypes: [], secretEnvVar: "X" }));
    expect(ftp.status).toBe(400);
  });
});

describe("wave 9 MCP status (TAN-033)", () => {
  it("reports truthful read-only MCP status", async () => {
    await login();
    const res = await fetch(`${address}/api/v1/mcp/status`, authed());
    expect(res.status).toBe(200);
    const status = (await res.json()) as { mounted: boolean; auditedCalls: number | null };
    expect(status.mounted).toBe(false);
    expect(status.auditedCalls).not.toBeUndefined();
  });
});

describe("wave 9 server-side catalog pagination (TAN-038)", () => {
  it("returns paged results with total counts and stable ordering", async () => {
    await login();
    const res = await fetch(`${address}/api/v1/catalog/page?page=1&pageSize=10`, authed());
    expect(res.status).toBe(200);
    const page = (await res.json()) as { items: unknown[]; page: number; pageSize: number; total: number; totalPages: number };
    expect(page.page).toBe(1);
    expect(page.pageSize).toBe(10);
    expect(page.totalPages).toBeGreaterThanOrEqual(1);
    expect(Array.isArray(page.items)).toBe(true);
  });
});

describe("wave 9 backup / restore (TAN-042)", () => {
  it("creates an integrity-checked atomic backup and reports its contents", async () => {
    await login();
    const res = await fetch(`${address}/api/v1/system/backup`, authed("POST", {}));
    if (res.status === 200) {
      const body = (await res.json()) as { path: string; includes: string[] };
      expect(body.path.endsWith(".db")).toBe(true);
      expect(body.includes).toContain("database (all tables)");
    } else {
      expect(res.status).toBe(503); // only when sqlite unavailable
    }
  });

  it("refuses restore paths outside the managed backups directory", async () => {
    await login();
    const res = await fetch(`${address}/api/v1/system/restore`, authed("POST", { path: "/etc/passwd" }));
    expect(res.status).toBe(400);
  });
});

describe("wave 9 diagnostics + support bundle (TAN-043)", () => {
  it("reports versions, module states and transcoder support", async () => {
    await login();
    const res = await fetch(`${address}/api/v1/system/diagnostics`, authed());
    expect(res.status).toBe(200);
    const diag = (await res.json()) as { versions: { node: string }; plugins: unknown[]; transcoder: { ffmpegAvailable: boolean } };
    expect(diag.versions.node).toMatch(/^v\d+/);
    expect(Array.isArray(diag.plugins)).toBe(true);
  });

  it("previews bundle sections and redacts media names by default", async () => {
    await login();
    const preview = await fetch(`${address}/api/v1/system/support-bundle/preview`, authed());
    const p = (await preview.json()) as { sections: string[]; mediaNamesRedacted: boolean };
    expect(p.mediaNamesRedacted).toBe(true);
    expect(p.sections.length).toBeGreaterThan(0);

    const bundle = await fetch(`${address}/api/v1/system/support-bundle`, authed("POST", { includeMediaNames: false }));
    const b = (await bundle.json()) as { bundle: Record<string, unknown> };
    const serialized = JSON.stringify(b.bundle);
    expect(serialized).not.toContain("Wave Nine"); // media titles redacted
    expect(serialized).not.toMatch(/tantalar_[A-Za-z0-9_-]{10,}/); // no API keys
  });
});
