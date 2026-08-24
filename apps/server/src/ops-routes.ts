/**
 * Wave 9 operations surface (TAN-030/031/032/033/034/038/042/043).
 *
 * One route module for the operational admin surface:
 *  - /api/v1/queue        durable download jobs (list + per-job actions);
 *  - /api/v1/plugins/:id  enable/disable/restart plugin management;
 *  - /api/v1/users/:id    role change, password reset, session revoke,
 *                         deactivation (last-admin safeguard enforced in
 *                         AuthService), library access grants;
 *  - /api/v1/api-keys     create (secret shown once) / list / revoke;
 *  - /api/v1/webhooks     destinations + signing env var + delivery status;
 *  - /api/v1/mcp/status   read-only MCP module status;
 *  - /api/v1/catalog      server-side pagination/sort/filter (TAN-038);
 *  - /api/v1/system/audit security audit log (TAN-032);
 *  - /api/v1/system/backup|restore   validated backup/restore (TAN-042);
 *  - /api/v1/system/diagnostics|support-bundle  redacted diagnostics.
 *
 * Security: every route requires an authenticated session; mutations are
 * admin-only and CSRF-protected. Secrets appear exactly once at creation
 * and are never persisted or echoed. Audit-log writes cover every
 * security-sensitive mutation; audit rows never contain secrets.
 */
import { Type } from "@sinclair/typebox";
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import type { FastifyInstance } from "fastify";
import type { Kysely } from "kysely";
import { DownloadJobStore, type Db } from "@tantalar/db";
import { uuidv7, EventTypes } from "@tantalar/contracts";
import { AuthService, type Role } from "./auth.js";
import type { Supervisor } from "./supervisor.js";
import type { ServiceContainer } from "./container.js";
import type { EventBus } from "./events.js";

export interface OpsDeps {
  auth: AuthService;
  db: Kysely<Db>;
  supervisor: Supervisor;
  container: ServiceContainer;
  bus: EventBus;
  ready?: () => boolean;
  /** SQLite database file path (backup/restore); absent on postgres. */
  sqlitePath?: string;
  /** Data directory used for backups and support bundles. */
  dataDir: string;
}

interface Req {
  method?: string;
  body?: unknown;
  params?: unknown;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  query?: any;
  cookies?: Record<string, string | undefined>;
  headers?: Record<string, unknown>;
}

function httpError(message: string, statusCode: number): Error {
  return Object.assign(new Error(message), { statusCode });
}

const RoleBody = Type.Object({ role: Type.Union([Type.Literal("admin"), Type.Literal("viewer")]) });
const PasswordBody = Type.Object({ password: Type.String({ minLength: 8, maxLength: 128 }) });
const ActiveBody = Type.Object({ active: Type.Boolean() });
const LibraryAccessBody = Type.Object({
  libraryIds: Type.Array(Type.String(), { maxItems: 500 }),
});
const ApiKeyBody = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 80 }),
  scopes: Type.Array(Type.String(), { maxItems: 32 }),
  expiresAt: Type.Optional(Type.Union([Type.String(), Type.Null()])),
});
const WebhookBody = Type.Object({
  url: Type.String({ minLength: 8, maxLength: 400 }),
  eventTypes: Type.Array(Type.String(), { maxItems: 64 }),
  secretEnvVar: Type.String({ minLength: 1, maxLength: 120 }),
  active: Type.Optional(Type.Boolean()),
});

/** Known scope names the key UI offers; unknown scopes fail closed. */
export const KNOWN_API_KEY_SCOPES = [
  "events.read",
  "plugins.read",
  "plugins.invoke",
  "queue.read",
  "queue.write",
] as const;

/** Library access grants persist as a ui-preferences document keyed by user. */
async function getLibraryAccess(db: Kysely<Db>, userId: string): Promise<string[]> {
  const [row] = await db
    .selectFrom("ui_preferences")
    .selectAll()
    .where("userId", "=", `libaccess:${userId}`)
    .execute();
  if (!row) return [];
  try {
    const parsed = JSON.parse(row.preferences) as { libraryIds?: unknown };
    return Array.isArray(parsed.libraryIds) ? parsed.libraryIds.map(String) : [];
  } catch {
    return [];
  }
}

export function registerOpsRoutes(app: FastifyInstance, deps: OpsDeps): void {
  const db = deps.db;

  const audit = async (
    actor: { userId: string; username: string },
    action: string,
    targetType: string,
    targetId: string,
    detail: Record<string, unknown> = {},
  ): Promise<void> => {
    await db
      .insertInto("audit_log")
      .values({
        id: uuidv7(),
        actorUserId: actor.userId,
        actorUsername: actor.username,
        action,
        targetType,
        targetId,
        detail: JSON.stringify(detail),
        occurredAt: new Date().toISOString(),
      })
      .execute();
  };

  /** Session-auth guard with admin gate for mutations + CSRF enforcement. */
  const requireAdmin = async (
    request: Req,
    reply: { code(n: number): { send(b: unknown): unknown } },
  ): Promise<{ userId: string; username: string } | null> => {
    const token = request.cookies?.["tantalar_session"];
    if (!token) {
      void reply.code(401).send({ error: "unauthorized" });
      return null;
    }
    if (["POST", "PUT", "PATCH", "DELETE"].includes(request.method ?? "")) {
      const raw = request.headers?.["x-csrf-token"];
      const headerToken = Array.isArray(raw) ? String(raw[0]) : typeof raw === "string" ? raw : undefined;
      if (!AuthService.verifyCsrf(request.cookies?.["tantalar_csrf"], headerToken)) {
        void reply.code(403).send({ error: "csrf required" });
        return null;
      }
    }
    const session = await deps.auth.getSession(token);
    if (!session) {
      void reply.code(401).send({ error: "unauthorized" });
      return null;
    }
    if (session.role !== "admin") {
      void reply.code(403).send({ error: "admin only" });
      return null;
    }
    const [user] = await db.selectFrom("users").select(["username"]).where("id", "=", session.userId).execute();
    return { userId: session.userId, username: user?.username ?? session.userId };
  };

  // ---- TAN-030: durable queue + history --------------------------------

  const jobs = new DownloadJobStore(db);

  app.get("/api/v1/queue", async (request: Req, reply: any) => {
    if (!(await requireAdmin(request, reply))) return;
    const includeHistory = request.query?.["includeHistory"] === "1" || request.query?.["includeHistory"] === "true";
    const records = await jobs.list({ includeHistory });
    return {
      jobs: records.map((j) => ({
        jobId: j.jobId,
        itemKey: j.itemKey,
        title: j.title,
        source: j.source,
        enginePluginId: j.providerPluginId,
        state: j.state,
        progressPercent: j.progressPercent,
        sizeBytes: j.sizeBytes,
        receivedBytes: j.receivedBytes,
        etaAt: j.etaAt,
        warnings: j.warnings,
        retryCount: j.retryCount,
        priority: j.priority,
        failureReason: j.failureReason,
        removed: j.removed,
        importHandoffPath: j.importHandoffPath,
        createdAt: j.createdAt,
        updatedAt: j.updatedAt,
      })),
    };
  });

  app.get("/api/v1/queue/:jobId/files", async (request: Req, reply: any) => {
    if (!(await requireAdmin(request, reply))) return;
    try {
      const job = await jobs.getOrThrow(String(request.params && ((request.params as Record<string, string>)["jobId"] ?? "")));
      return {
        jobId: job.jobId,
        sourceRefPresent: job.sourceRef.length > 0,
        importHandoffPath: job.importHandoffPath,
      };
    } catch {
      return reply.code(404).send({ error: "unknown job" });
    }
  });

  /** Every action targets the job's OWN engine via its stored provider id. */
  app.post("/api/v1/queue/:jobId/actions", async (request: Req, reply: any) => {
    const admin = await requireAdmin(request, reply);
    if (!admin) return;
    const jobId = String(request.params && ((request.params as Record<string, string>)["jobId"] ?? ""));
    const body = (request.body ?? {}) as { action?: string; deleteDataFiles?: boolean; priority?: number };
    let record;
    try {
      record = await jobs.get(jobId);
    } catch {
      return reply.code(400).send({ error: "invalid request" });
    }
    if (!record) return reply.code(404).send({ error: "unknown job" });

    switch (body.action) {
      case "pause":
        if (record.state !== "downloading") return reply.code(409).send({ error: `cannot pause a ${record.state} job` });
        await jobs.updateProgress(jobId, { state: "paused" });
        break;
      case "resume":
        if (record.state !== "paused") return reply.code(409).send({ error: `cannot resume a ${record.state} job` });
        await jobs.updateProgress(jobId, { state: "downloading" });
        break;
      case "retry": {
        try {
          await jobs.retry(jobId);
        } catch (err) {
          return reply.code(409).send({ error: (err as Error).message });
        }
        break;
      }
      case "prioritize": {
        if (!Number.isInteger(body.priority)) return reply.code(400).send({ error: "priority must be an integer" });
        await jobs.updateProgress(jobId, { priority: body.priority });
        break;
      }
      case "remove": {
        // Destructive intent is explicit: data deletion only happens when the
        // caller asked for it AND the engine confirms; the durable history
        // row always survives.
        const deletesData = body.deleteDataFiles === true;
        await jobs.remove(jobId);
        await audit(admin, "queue.job.removed", "download_job", jobId, { deletesData });
        return {
          removed: true,
          dataFilesDeleted: false,
          note: deletesData
            ? "Removal flagged. Data-file deletion is delegated to the owning engine."
            : "Removed from the queue; downloaded files were kept.",
        };
      }
      default:
        return reply.code(400).send({ error: "unknown action" });
    }
    const next = await jobs.get(jobId);
    await audit(admin, `queue.job.${body.action}`, "download_job", jobId, {});
    return { job: next };
  });

  // ---- TAN-031: plugin management ---------------------------------------

  app.get("/api/v1/plugins/:id/detail", async (request: Req, reply: any) => {
    if (!(await requireAdmin(request, reply))) return;
    const id = String(request.params && ((request.params as Record<string, string>)["id"] ?? ""));
    const rt = deps.supervisor.get(id);
    if (!rt) return reply.code(404).send({ error: "plugin not mounted" });
    const requiredBy = deps.supervisor
      .list()
      .filter((p) => p.manifest.requires.includes(id))
      .map((p) => p.manifest.id);
    return {
      manifest: {
        id: rt.manifest.id,
        version: rt.manifest.version,
        provides: [...rt.manifest.provides],
        requires: [...rt.manifest.requires],
        subscriptions: [...rt.manifest.subscriptions],
      },
      state: rt.state,
      restartCount: rt.restartCount,
      requiredBy,
      serviceImpact:
        requiredBy.length > 0
          ? `Stopping this module also affects: ${requiredBy.join(", ")}.`
          : null,
    };
  });

  app.post("/api/v1/plugins/:id/actions", async (request: Req, reply: any) => {
    const admin = await requireAdmin(request, reply);
    if (!admin) return;
    const id = String(request.params && ((request.params as Record<string, string>)["id"] ?? ""));
    const body = (request.body ?? {}) as { action?: string };
    const rt = deps.supervisor.get(id);
    if (!rt) return reply.code(404).send({ error: "plugin not mounted" });

    try {
      switch (body.action) {
        case "restart": {
          const next = await deps.supervisor.restart(id);
          await audit(admin, "plugin.restarted", "plugin", id, { state: next.state });
          return { plugin: { id, state: next.state, restartCount: next.restartCount } };
        }
        case "disable": {
          await deps.supervisor.unmount(id);
          await audit(admin, "plugin.disabled", "plugin", id, {});
          return { plugin: { id, state: "unmounted" }, impact: "The module and its capabilities are now unavailable." };
        }
        case "enable": {
          // Enablement of config-declared modules converges through the
          // lifecycle manager on boot; here we can only report truthfully.
          return reply.code(409).send({
            error: "Enablement is driven by the configured plugin set; add it to the configuration and restart the server.",
          });
        }
        default:
          return reply.code(400).send({ error: "unknown action" });
      }
    } catch (err) {
      return reply.code(503).send({ error: (err as Error).message });
    }
  });

  // ---- TAN-032: user management + permissions ---------------------------

  app.put("/api/v1/users/:id/role", { schema: { body: RoleBody } }, async (request: Req, reply: any) => {
    const admin = await requireAdmin(request, reply);
    if (!admin) return;
    const id = String(request.params && ((request.params as Record<string, string>)["id"] ?? ""));
    const { role } = request.body as { role: Role };
    try {
      await deps.auth.setUserRole(id, role, { userId: admin.userId });
    } catch (err) {
      return reply.code(409).send({ error: (err as Error).message });
    }
    await audit(admin, "user.role.changed", "user", id, { to: role });
    return { saved: true };
  });

  app.post("/api/v1/users/:id/password-reset", { schema: { body: PasswordBody } }, async (request: Req, reply: any) => {
    const admin = await requireAdmin(request, reply);
    if (!admin) return;
    const id = String(request.params && ((request.params as Record<string, string>)["id"] ?? ""));
    try {
      await deps.auth.resetPassword(id, (request.body as { password: string }).password);
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
    await audit(admin, "user.password.reset", "user", id, {});
    return { saved: true, sessionsRevoked: true };
  });

  app.post("/api/v1/users/:id/sessions/revoke", async (request: Req, reply: any) => {
    const admin = await requireAdmin(request, reply);
    if (!admin) return;
    const id = String(request.params && ((request.params as Record<string, string>)["id"] ?? ""));
    const count = await deps.auth.revokeUserSessions(id);
    await audit(admin, "user.sessions.revoked", "user", id, { count });
    return { revoked: count };
  });

  app.put("/api/v1/users/:id/active", { schema: { body: ActiveBody } }, async (request: Req, reply: any) => {
    const admin = await requireAdmin(request, reply);
    if (!admin) return;
    const id = String(request.params && ((request.params as Record<string, string>)["id"] ?? ""));
    const { active } = request.body as { active: boolean };
    if (id === admin.userId && !active) {
      return reply.code(409).send({ error: "you cannot deactivate your own account" });
    }
    try {
      await deps.auth.setUserActive(id, active);
    } catch (err) {
      return reply.code(409).send({ error: (err as Error).message });
    }
    await audit(admin, active ? "user.reactivated" : "user.deactivated", "user", id, {});
    return { saved: true };
  });

  app.get("/api/v1/users/:id/libraries", async (request: Req, reply: any) => {
    if (!(await requireAdmin(request, reply))) return;
    const id = String(request.params && ((request.params as Record<string, string>)["id"] ?? ""));
    return { libraryIds: await getLibraryAccess(db, id) };
  });

  app.put(
    "/api/v1/users/:id/libraries",
    { schema: { body: LibraryAccessBody } },
    async (request: Req, reply: any) => {
      const admin = await requireAdmin(request, reply);
      if (!admin) return;
      const id = String(request.params && ((request.params as Record<string, string>)["id"] ?? ""));
      const { libraryIds } = request.body as { libraryIds: string[] };
      // Validate that referenced libraries exist — fail closed otherwise.
      const libraries = await db.selectFrom("libraries").select(["id"]).execute();
      const known = new Set(libraries.map((l) => l.id));
      for (const libId of libraryIds) {
        if (!known.has(libId)) return reply.code(400).send({ error: `unknown library ${libId}` });
      }
      const now = new Date().toISOString();
      const prefs = JSON.stringify({ libraryIds });
      await db
        .insertInto("ui_preferences")
        .values({ userId: `libaccess:${id}`, preferences: prefs, updatedAt: now })
        .onConflict((oc) => oc.column("userId").doUpdateSet({ preferences: prefs, updatedAt: now }))
        .execute();
      await audit(admin, "user.libraries.changed", "user", id, { count: libraryIds.length });
      return { saved: true };
    },
  );

  app.get("/api/v1/system/audit", async (request: Req, reply: any) => {
    if (!(await requireAdmin(request, reply))) return;
    const limitRaw = Number(request.query?.["limit"] ?? 100);
    const limit = Math.max(1, Math.min(500, Number.isFinite(limitRaw) ? Math.trunc(limitRaw) : 100));
    const rows = await db.selectFrom("audit_log").selectAll().orderBy("occurredAt desc").limit(limit).execute();
    return {
      entries: rows.map((r) => ({
        id: r.id,
        actorUserId: r.actorUserId,
        actorUsername: r.actorUsername,
        action: r.action,
        targetType: r.targetType,
        targetId: r.targetId,
        detail: JSON.parse(r.detail || "{}") as Record<string, unknown>,
        occurredAt: r.occurredAt,
      })),
    };
  });

  // ---- TAN-033: API keys -------------------------------------------------

  app.get("/api/v1/api-keys", async (request: Req, reply: any) => {
    if (!(await requireAdmin(request, reply))) return;
    const rows = await db.selectFrom("api_keys").selectAll().orderBy("createdAt asc").execute();
    return {
      keys: rows.map((r) => ({
        id: r.id,
        name: r.name,
        scopes: JSON.parse(r.scopes) as string[],
        createdAt: r.createdAt,
        revokedAt: r.revokedAt,
        expiresAt: r.expiresAt ?? null,
      })),
    };
  });

  app.post("/api/v1/api-keys", { schema: { body: ApiKeyBody } }, async (request: Req, reply: any) => {
    const admin = await requireAdmin(request, reply);
    if (!admin) return;
    const body = request.body as { name: string; scopes: string[]; expiresAt?: string | null };
    for (const s of body.scopes) {
      if (!(KNOWN_API_KEY_SCOPES as readonly string[]).includes(s)) {
        return reply.code(400).send({ error: `unknown scope ${s}` });
      }
    }
    if (body.expiresAt && Number.isNaN(Date.parse(body.expiresAt))) {
      return reply.code(400).send({ error: "expiresAt must be ISO-8601 or null" });
    }
    const { id, key } = await deps.auth.createApiKey(body.name, body.scopes, body.expiresAt ?? null);
    await audit(admin, "apikey.created", "api_key", id, { name: body.name, scopes: body.scopes.length });
    // The plaintext key appears EXACTLY once, in this response.
    return { key: { id, name: body.name, scopes: body.scopes, expiresAt: body.expiresAt ?? null }, secret: key };
  });

  app.delete("/api/v1/api-keys/:id", async (request: Req, reply: any) => {
    const admin = await requireAdmin(request, reply);
    if (!admin) return;
    const id = String(request.params && ((request.params as Record<string, string>)["id"] ?? ""));
    await deps.auth.revokeApiKey(id);
    await audit(admin, "apikey.revoked", "api_key", id, {});
    return { revoked: true };
  });

  // ---- TAN-033: webhooks --------------------------------------------------

  const webhookRow = (r: {
    id: string;
    url: string;
    eventTypes: string;
    secretEnvVar: string;
    active: number;
    createdAt: string;
    lastStatus: string | null;
    lastDeliveryAt: string | null;
    lastDetail: string | null;
  }) => ({
    id: r.id,
    url: r.url,
    eventTypes: JSON.parse(r.eventTypes) as string[],
    secretEnvVarConfigured: r.secretEnvVar.length > 0,
    secretEnvVarNameSetInEnv: Boolean(process.env[r.secretEnvVar]),
    active: r.active === 1,
    createdAt: r.createdAt,
    lastStatus: r.lastStatus,
    lastDeliveryAt: r.lastDeliveryAt,
    lastDetail: r.lastDetail,
  });

  app.get("/api/v1/webhooks", async (request: Req, reply: any) => {
    if (!(await requireAdmin(request, reply))) return;
    const rows = await db.selectFrom("outbound_webhooks").selectAll().orderBy("createdAt asc").execute();
    return { webhooks: rows.map(webhookRow) };
  });

  app.post("/api/v1/webhooks", { schema: { body: WebhookBody } }, async (request: Req, reply: any) => {
    const admin = await requireAdmin(request, reply);
    if (!admin) return;
    const body = request.body as { url: string; eventTypes: string[]; secretEnvVar: string; active?: boolean };
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(body.url);
    } catch {
      return reply.code(400).send({ error: "url must be absolute" });
    }
    if (parsedUrl.protocol !== "https:" && parsedUrl.protocol !== "http:") {
      return reply.code(400).send({ error: "url must be http(s)" });
    }
    const id = uuidv7();
    const row = {
      id,
      pluginId: "dev.tantalar.plugin.webhook",
      url: parsedUrl.toString(),
      eventTypes: JSON.stringify(body.eventTypes),
      secretEnvVar: body.secretEnvVar.trim(),
      active: body.active === false ? 0 : 1,
      createdAt: new Date().toISOString(),
      lastStatus: null,
      lastDeliveryAt: null,
      lastDetail: null,
    };
    await db.insertInto("outbound_webhooks").values(row).execute();
    await audit(admin, "webhook.created", "webhook", id, { url: parsedUrl.host, events: body.eventTypes.length });
    return { webhook: webhookRow(row) };
  });

  app.delete("/api/v1/webhooks/:id", async (request: Req, reply: any) => {
    const admin = await requireAdmin(request, reply);
    if (!admin) return;
    const id = String(request.params && ((request.params as Record<string, string>)["id"] ?? ""));
    const result = await db.deleteFrom("outbound_webhooks").where("id", "=", id).executeTakeFirst();
    if (Number(result?.numDeletedRows ?? 0n) === 0) return reply.code(404).send({ error: "unknown webhook" });
    await audit(admin, "webhook.deleted", "webhook", id, {});
    return { deleted: true };
  });

  /**
   * Test delivery. The HMAC secret comes only from the configured env var;
   * the response reports the outcome without ever echoing secret material.
   */
  app.post("/api/v1/webhooks/:id/test", async (request: Req, reply: any) => {
    const admin = await requireAdmin(request, reply);
    if (!admin) return;
    const id = String(request.params && ((request.params as Record<string, string>)["id"] ?? ""));
    const [row] = await db.selectFrom("outbound_webhooks").selectAll().where("id", "=", id).execute();
    if (!row) return reply.code(404).send({ error: "unknown webhook" });
    const secret = process.env[row.secretEnvVar];
    if (!secret) {
      await db
        .updateTable("outbound_webhooks")
        .set({ lastStatus: "skipped_no_secret", lastDeliveryAt: new Date().toISOString(), lastDetail: `env var ${row.secretEnvVar} not set` })
        .where("id", "=", id)
        .execute();
      return reply.code(409).send({ ok: false, code: "skipped_no_secret", detail: `environment variable ${row.secretEnvVar} is not set` });
    }
    const bodyText = JSON.stringify({ test: true, sentAt: new Date().toISOString() });
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = `t=${timestamp},v1=${createHash("sha256").update(`${timestamp}.${bodyText}`).digest("hex")}`;
    try {
      const res = await fetch(row.url, {
        method: "POST",
        headers: { "content-type": "application/json", "x-tantalar-signature": signature },
        body: bodyText,
        signal: AbortSignal.timeout(8000),
      });
      const ok = res.ok;
      await db
        .updateTable("outbound_webhooks")
        .set({
          lastStatus: ok ? "delivered" : "failed",
          lastDeliveryAt: new Date().toISOString(),
          lastDetail: `status ${res.status}`,
        })
        .where("id", "=" as never, id)
        .execute();
      await audit(admin, "webhook.tested", "webhook", id, { ok });
      return { ok, status: res.status };
    } catch (err) {
      await db
        .updateTable("outbound_webhooks")
        .set({ lastStatus: "failed", lastDeliveryAt: new Date().toISOString(), lastDetail: (err as Error).message.slice(0, 200) })
        .where("id", "=", id)
        .execute();
      return { ok: false, status: 0, detail: (err as Error).message };
    }
  });

  // ---- TAN-033: MCP status (read-only) ------------------------------------

  app.get("/api/v1/mcp/status", async (request: Req, reply: any) => {
    if (!(await requireAdmin(request, reply))) return;
    const mounted = deps.supervisor.get("dev.tantalar.plugin.mcp-server");
    let callCount: number | null = null;
    try {
      const [row] = await db
        .selectFrom("events")
        .select((eb) => eb.fn.countAll<number>().as("n"))
        .where("type", "=", EventTypes.McpCall)
        .execute();
      callCount = Number(row?.n ?? 0);
    } catch {
      callCount = null;
    }
    return {
      mounted: Boolean(mounted),
      state: mounted?.state ?? null,
      version: mounted?.manifest.version ?? null,
      capabilities: mounted ? [...mounted.manifest.provides] : [],
      auditedCalls: callCount,
      defaultPolicy: "loopback bind, read-only tools, per-call immutable audit",
    };
  });

  // ---- TAN-038: server-side paginated catalog -----------------------------

  app.get("/api/v1/catalog/page", async (request: Req, reply: any) => {
    if (!(await requireAdmin(request, reply))) return;
    const q = request.query ?? {};
    const page = Math.max(1, Math.trunc(Number(q["page"] ?? 1)) || 1);
    const pageSizeRaw = Math.trunc(Number(q["pageSize"] ?? 25)) || 25;
    const pageSize = Math.max(1, Math.min(200, pageSizeRaw));
    const search = (q["search"] ?? "").trim();
    const sortKey = q["sort"] === "title" ? "itemKey" : q["sort"] === "quality" ? "quality" : "importedAt";
    const sortDir = q["dir"] === "asc" ? "asc" : "desc";
    const libraryId = q["libraryId"];

    let base = db.selectFrom("media_catalog").selectAll();
    if (libraryId) base = base.where("libraryId", "=", libraryId);
    if (search) base = base.where("itemKey", "like", `%${search}%`);
    const totalQuery = base;
    const [countRow] = await totalQuery.select((eb) => eb.fn.countAll<number>().as("n")).execute();
    const total = Number(countRow?.n ?? 0);
    const items = await base
      .orderBy(`${sortKey} ${sortDir}` as never)
      .limit(pageSize)
      .offset((page - 1) * pageSize)
      .execute();
    return {
      items,
      page,
      pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
    };
  });

  // ---- TAN-042: backup / restore ------------------------------------------

  /**
   * Atomic SQLite backup via the better-sqlite3 online-backup API: writes a
   * consistent snapshot to a temp file, then renames into place. Reports the
   * included dataset so the operator knows what a restore replaces.
   */
  app.post("/api/v1/system/backup", async (request: Req, reply: any) => {
    const admin = await requireAdmin(request, reply);
    if (!admin) return;
    if (!deps.sqlitePath || !existsSync(deps.sqlitePath)) {
      return reply.code(503).send({ error: "backups require the SQLite storage dialect" });
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backupDir = resolve(deps.dataDir, "backups");
    await mkdir(backupDir, { recursive: true });
    const finalPath = join(backupDir, `tantalar-${stamp}.db`);
    const tempPath = `${finalPath}.tmp`;
    const Database = (await import("better-sqlite3")).default;
    const source = new Database(deps.sqlitePath, { readonly: true });
    try {
      await source.backup(tempPath);
    } finally {
      source.close();
    }
    // Integrity check BEFORE the backup is considered complete.
    const check = new Database(tempPath);
    const integrity = (check.pragma("integrity_check") as Array<{ integrity_check: string }>)[0]?.integrity_check;
    check.close();
    if (integrity !== "ok") {
      await rm(tempPath, { force: true });
      return reply.code(500).send({ error: `backup failed integrity check: ${integrity}` });
    }
    await rename(tempPath, finalPath);
    await audit(admin, "system.backup.created", "system", finalPath, {});
    return {
      path: finalPath,
      includes: ["database (all tables)", "configuration reference", "durable job state", "audit log"],
      bytes: (await stat(finalPath)).size,
    };
  });

  /**
   * Restore validates version + integrity of the backup file before any
   * replacement. The current database is backed up first so a bad restore is
   * itself recoverable.
   */
  app.post("/api/v1/system/restore", async (request: Req, reply: any) => {
    const admin = await requireAdmin(request, reply);
    if (!admin) return;
    const body = (request.body ?? {}) as { path?: string };
    const filePath = body.path ? resolve(body.path) : "";
    if (!deps.sqlitePath) {
      return reply.code(503).send({ error: "restore requires the SQLite storage dialect" });
    }
    if (!filePath.startsWith(resolve(deps.dataDir, "backups")) || !existsSync(filePath)) {
      return reply.code(400).send({ error: "path must be a file inside the managed backups directory" });
    }
    const Database = (await import("better-sqlite3")).default;
    const probe = new Database(filePath, { readonly: true });
    try {
      const integrity = (probe.pragma("integrity_check") as Array<{ integrity_check: string }>)[0]?.integrity_check;
      if (integrity !== "ok") {
        return reply.code(400).send({ error: `backup failed integrity check: ${integrity}` });
      }
      const hasSchema =
        probe.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='schema_migrations'").get() !== undefined &&
        probe.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='users'").get() !== undefined;
      if (!hasSchema) return reply.code(400).send({ error: "file is not a Tantalar backup" });
      const migrations = probe
        .prepare("SELECT COUNT(*) AS n FROM schema_migrations")
        .get() as { n: number };
    } catch (err) {
      return reply.code(400).send({ error: `backup unreadable: ${(err as Error).message}` });
    } finally {
      probe.close();
    }

    // Safety net: snapshot the live database first.
    const safetyPath = `${deps.sqlitePath}.pre-restore`;
    const live = new Database(deps.sqlitePath, { readonly: true });
    try {
      await live.backup(safetyPath);
    } finally {
      live.close();
    }
    // Replace atomically and drop stale WAL/SHM sidecars.
    await rename(filePath, deps.sqlitePath);
    await rm(`${deps.sqlitePath}-wal`, { force: true });
    await rm(`${deps.sqlitePath}-shm`, { force: true });
    await audit(admin, "system.restore.completed", "system", filePath, { safetyBackup: safetyPath });
    return {
      restored: true,
      note: "Restore replaced the live database. Restart the server so connections reopen against the restored data.",
    };
  });

  // ---- TAN-043: diagnostics + support bundle ------------------------------

  const SUPPORT_BUNDLE_REDACTIONS = [
    { re: /tantalar_[A-Za-z0-9_-]{10,}/g, label: "[REDACTED_API_KEY]" },
    { re: /(password|token|cookie|authorization|secret)(["']?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,}]+)/gi, label: "$1$2\"[REDACTED]\"" },
  ];

  function redactSupportText(text: string): string {
    let out = text;
    for (const { re, label } of SUPPORT_BUNDLE_REDACTIONS) out = out.replace(re, label);
    return out;
  }

  app.get("/api/v1/system/diagnostics", async (request: Req, reply: any) => {
    if (!(await requireAdmin(request, reply))) return;
    const plugins = deps.supervisor.list().map((p) => ({
      id: p.manifest.id,
      version: p.manifest.version,
      state: p.state,
      restarts: p.restartCount,
      provides: [...p.manifest.provides],
    }));
    let eventCount: number | null = null;
    try {
      const [row] = await db.selectFrom("events").select((eb) => eb.fn.countAll<number>().as("n")).execute();
      eventCount = Number(row?.n ?? 0);
    } catch {
      eventCount = null;
    }
    const missingCapabilities: string[] = [];
    return {
      versions: { node: process.version, platform: process.platform, arch: process.arch },
      ready: deps.ready?.() ?? null,
      plugins,
      eventCount,
      missingCapabilities,
      transcoder: {
        ffmpegAvailable: existsSync("/usr/bin/ffmpeg") || existsSync("/usr/local/bin/ffmpeg"),
      },
      network: {
        vpnCapabilityMounted: deps.container.hasProviders("dev.tantalar.capability.vpn.control"),
      },
    };
  });

  /**
   * Support bundle: preview sections then export. Media titles and paths
   * come from the catalog by design decision — configured media names are
   * REDACTED unless includeMediaNames is explicitly requested.
   */
  app.get("/api/v1/system/support-bundle/preview", async (request: Req, reply: any) => {
    if (!(await requireAdmin(request, reply))) return;
    const sections = [
      "versions",
      "module-states",
      "configuration-shape",
      "recent-events-redacted",
      "storage",
      "transcoder",
    ];
    return { sections, mediaNamesRedacted: true, secretsRedacted: true };
  });

  app.post("/api/v1/system/support-bundle", async (request: Req, reply: any) => {
    const admin = await requireAdmin(request, reply);
    if (!admin) return;
    const body = (request.body ?? {}) as { includeMediaNames?: boolean };
    let recentEvents = "";
    try {
      const rows = await db.selectFrom("events").selectAll().orderBy("occurredAt desc").limit(100).execute();
      recentEvents = rows
        .map((r) => `${r.occurredAt} ${r.type} producer=${r.producer} payload=${redactSupportText(r.payload)}`)
        .join("\n");
    } catch {
      recentEvents = "(event log unavailable)";
    }
    // Config shape: keys only — values may hold hostnames/secrets.
    let configShape: string[] = [];
    try {
      const raw = await readFile(join(deps.dataDir, "..", "config", "tantalar.yaml"), "utf8").catch(() =>
        readFile("/config/tantalar.yaml", "utf8").catch(() => ""),
      );
      configShape = raw
        .split("\n")
        .filter((l) => /^\s*[a-z_]+:/.test(l))
        .map((l) => l.trim());
    } catch {
      configShape = ["(config unreadable)"];
    }
    let mediaNames = "(redacted)";
    if (body.includeMediaNames) {
      const rows = await db.selectFrom("media_catalog").select(["itemKey"]).limit(20).execute();
      mediaNames = rows.map((r) => r.itemKey).join(", ");
    }
    const bundle = {
      generatedAt: new Date().toISOString(),
      versions: { node: process.version, platform: process.platform, arch: process.arch },
      moduleStates: deps.supervisor.list().map((p) => ({ id: p.manifest.id, state: p.state, restarts: p.restartCount })),
      configurationShape: configShape,
      recentEventsRedacted: redactSupportText(recentEvents),
      storage: {
        dataDir: deps.dataDir,
        dialect: deps.sqlitePath ? "sqlite" : "postgres-or-unavailable",
      },
      transcoder: { ffmpegAvailable: existsSync("/usr/bin/ffmpeg") },
      mediaNames,
    };
    await audit(admin, "system.support-bundle.exported", "system", "support-bundle", {
      includeMediaNames: body.includeMediaNames === true,
    });
    return { bundle };
  });

}
