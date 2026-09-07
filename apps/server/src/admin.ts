/**
 * Phase 6 admin surface (stories 25–27): users management, per-user UI
 * preferences, theme storage, and system health for the admin UI.
 *
 * Security model:
 *  - every route authenticates through the session cookie;
 *  - preference routes allow self access; administrators can access any user;
 *  - all other routes are admin-only — ordinary viewers get 403;
 *  - cookie-authenticated mutations require the CSRF double-submit token;
 *  - theme values are token-value strings only: the server enforces the same
 *    `--tantalar-*` token grammar as the client sanitizer so no script,
 *    url(), expression(), or at-rule can ever be stored or served back.
 */
import type { FastifyInstance } from "fastify";
import { Type } from "@sinclair/typebox";
import { uuidv7 } from "@tantalar/contracts";
import type { Kysely } from "kysely";
import { AuthService, type Role } from "./auth.js";
import type { Db, UiPreferencesTable, ThemesTable } from "@tantalar/db";
import { collectionPage } from "./collection-page.js";
import { AVATAR_PRESETS, normalizeAvatar, userAvatar } from "./user-avatar.js";

const NOTICE_OWNER = "dev.tantalar.core.notification-history";
const NoticeBody = Type.Object({
  id: Type.String({ minLength: 1, maxLength: 180, pattern: "^[A-Za-z0-9:_-]+$" }),
  severity: Type.Union([Type.Literal("success"), Type.Literal("warning"), Type.Literal("error")]),
  title: Type.String({ minLength: 1, maxLength: 300 }),
  message: Type.Optional(Type.String({ maxLength: 2000 })),
  createdAt: Type.String({ format: "date-time" }),
  count: Type.Integer({ minimum: 1, maximum: 1000000 }),
}, { additionalProperties: false });
interface NoticeRecord { id: string; severity: string; title: string; message?: string; createdAt: string; count: number }

export interface AdminDeps {
  auth: AuthService;
  db: Kysely<Db>;
  supervisorList: () => Array<{ manifest: { id: string; version: string }; state: string; restartCount: number }>;
  ready: () => boolean;
}

const TOKEN_NAME_RE = /^--tantalar-[a-z0-9-]+$/;
/** Values are restricted to safe CSS token-value characters; no functions. */
const TOKEN_VALUE_RE = /^[#%(),.\s/a-z0-9-]{0,120}$/i;
const FORBIDDEN_VALUE_RE = /(url\s*\(|expression|@import|@media|javascript:|<|>|;|\\|\{|\})/i;

/** Server-side mirror of the client sanitizer: fail closed on anything odd. */
export function sanitizeThemeTokens(input: unknown): Record<string, string> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw httpError("theme must be an object of token values", 400);
  }
  const out: Record<string, string> = {};
  for (const [rawName, rawValue] of Object.entries(input as Record<string, unknown>)) {
    const name = String(rawName);
    const value = String(rawValue ?? "");
    if (!TOKEN_NAME_RE.test(name) || FORBIDDEN_VALUE_RE.test(value) || !TOKEN_VALUE_RE.test(value)) {
      throw httpError(`unsafe theme token: ${name}`, 400);
    }
    out[name] = value;
  }
  return out;
}

function httpError(message: string, statusCode: number): Error {
  return Object.assign(new Error(message), { statusCode });
}

const DurationMs = Type.Integer({ minimum: 1_000, maximum: 300_000 });
const NotificationsPreferences = Type.Object({
  enabled: Type.Optional(Type.Boolean()),
  corner: Type.Optional(Type.Union([
    Type.Literal("top-left"),
    Type.Literal("top-right"),
    Type.Literal("bottom-left"),
    Type.Literal("bottom-right"),
  ])),
  maxVisible: Type.Optional(Type.Integer({ minimum: 1, maximum: 5 })),
  minimumSeverity: Type.Optional(Type.Union([
    Type.Literal("success"),
    Type.Literal("warning"),
    Type.Literal("error"),
  ])),
  durations: Type.Optional(Type.Object({
    success: Type.Optional(DurationMs),
    warning: Type.Optional(DurationMs),
    error: Type.Optional(DurationMs),
  }, { additionalProperties: false })),
  events: Type.Optional(Type.Object({
    downloads: Type.Optional(Type.Boolean()),
    imports: Type.Optional(Type.Boolean()),
    plugins: Type.Optional(Type.Boolean()),
    vpn: Type.Optional(Type.Boolean()),
    indexers: Type.Optional(Type.Boolean()),
  }, { additionalProperties: false })),
}, { additionalProperties: false });
const PreferencesBody = Type.Object({
  preferences: Type.Object({
    notifications: Type.Optional(NotificationsPreferences),
  }, { additionalProperties: true }),
}, { additionalProperties: false });
const ThemeBody = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 80 }),
  tokens: Type.Record(Type.String(), Type.String()),
});
const CreateUserBody = Type.Object({
  username: Type.String({ minLength: 1, maxLength: 64 }),
  password: Type.String({ minLength: 8, maxLength: 128 }),
  role: Type.Union([Type.Literal("admin"), Type.Literal("viewer")]),
});

/** Shape of the Fastify request pieces the handlers touch. */
interface Req {
  query?: unknown;
  method?: string;
  body?: unknown;
  params?: unknown;
  cookies?: Record<string, string | undefined>;
  headers?: Record<string, unknown>;
}

export function registerAdminRoutes(app: FastifyInstance, deps: AdminDeps): void {
  /**
   * Session guard: 401 unauthenticated. Cookie mutations require the CSRF
   * double-submit token (same discipline as serving.ts).
   */
  const requireSession = async (
    request: Req,
    reply: { code: (n: number) => { send: (b: unknown) => unknown } },
  ): Promise<{ userId: string; role: string } | null> => {
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
    return { userId: session.userId, role: session.role };
  };

  const requireAdmin = async (
    request: Req,
    reply: { code: (n: number) => { send: (b: unknown) => unknown } },
  ): Promise<{ userId: string; role: string } | null> => {
    const session = await requireSession(request, reply);
    if (!session) return null;
    if (session.role !== "admin") {
      void reply.code(403).send({ error: "admin only" });
      return null;
    }
    return session;
  };

  // Bounded, account-owned history reuses the durable document store.
  app.get("/api/v1/notifications", async (request: Req, reply: any) => {
    const actor = await requireSession(request, reply);
    if (!actor) return;
    const rows = await deps.db.selectFrom("plugin_documents").select("doc")
      .where("pluginId", "=", NOTICE_OWNER).where("docKey", "like", `${actor.userId}:%`)
      .orderBy("updatedAt", "desc").orderBy("docKey", "desc").limit(500).execute();
    const notices = rows.map(row => JSON.parse(row.doc) as NoticeRecord);
    return collectionPage(notices, (request as { query?: Record<string, unknown> }).query ?? {}, {
      title: notice => notice.title, message: notice => notice.message, severity: notice => notice.severity,
      createdAt: notice => notice.createdAt, count: notice => notice.count,
    });
  });
  app.post("/api/v1/notifications", { schema: { body: NoticeBody } }, async (request: Req, reply: any) => {
    const actor = await requireSession(request, reply);
    if (!actor) return;
    const notice = request.body as NoticeRecord;
    await deps.db.transaction().execute(async transaction => {
      const row = { pluginId: NOTICE_OWNER, docKey: `${actor.userId}:${notice.id}`, doc: JSON.stringify(notice), updatedAt: notice.createdAt };
      await transaction.insertInto("plugin_documents").values(row)
        .onConflict(conflict => conflict.columns(["pluginId", "docKey"]).doUpdateSet({ doc: row.doc })).execute();
      const old = await transaction.selectFrom("plugin_documents").select("docKey")
        .where("pluginId", "=", NOTICE_OWNER).where("docKey", "like", `${actor.userId}:%`)
        .orderBy("updatedAt", "desc").orderBy("docKey", "desc").offset(500).limit(500).execute();
      if (old.length) await transaction.deleteFrom("plugin_documents").where("pluginId", "=", NOTICE_OWNER)
        .where("docKey", "in", old.map(item => item.docKey)).execute();
    });
    return { saved: true };
  });

  // ---- Users management -------------------------------------------------
  app.get("/api/v1/users", async (request: Req, reply: any) => {
    const admin = await requireAdmin(request, reply);
    if (!admin) return;
    const rows = await deps.db
      .selectFrom("users")
      .select(["id", "username", "role", "createdAt", "active", "avatar"])
      .orderBy("createdAt asc")
      .execute();
    const users = rows.map(row => ({ ...row, active: row.active !== 0, avatar: userAvatar(row.id, row.avatar) }));
    const page = collectionPage(users, (request.query ?? {}) as Record<string, unknown>, {
      username: user => user.username, role: user => user.role,
      state: user => user.active ? "Active" : "Inactive", createdAt: user => user.createdAt,
    });
    return { ...page, users: page.items };
  });

  app.get("/api/v1/users/:id/profile", async (request: Req, reply: any) => {
    const actor = await requireSession(request, reply);
    if (!actor) return;
    const { id } = request.params as { id: string };
    if (actor.role !== "admin" && actor.userId !== id) return reply.code(403).send({ error: "forbidden" });
    const user = await deps.db.selectFrom("users").select(["id", "username", "role", "createdAt", "active", "avatar"]).where("id", "=", id).executeTakeFirst();
    if (!user) return reply.code(404).send({ error: "User not found." });
    return { user: { ...user, active: user.active !== 0, avatar: userAvatar(id, user.avatar) } };
  });

  app.put("/api/v1/users/:id/avatar", {
    bodyLimit: 3 * 1024 * 1024,
    schema: { body: Type.Union([
      Type.Object({ preset: Type.Union(AVATAR_PRESETS.map(preset => Type.Literal(preset))) }, { additionalProperties: false }),
      Type.Object({ image: Type.String({ minLength: 4, maxLength: 2_796_204 }) }, { additionalProperties: false }),
    ]) },
  }, async (request: Req, reply: any) => {
    const actor = await requireSession(request, reply);
    if (!actor) return;
    const { id } = request.params as { id: string };
    if (actor.role !== "admin" && actor.userId !== id) return reply.code(403).send({ error: "forbidden" });
    const user = await deps.db.selectFrom("users").select("id").where("id", "=", id).executeTakeFirst();
    if (!user) return reply.code(404).send({ error: "User not found." });
    const body = request.body as { preset: string } | { image: string };
    let avatar: string;
    try { avatar = "preset" in body ? body.preset : await normalizeAvatar(body.image); }
    catch { return reply.code(400).send({ error: "Choose a valid JPEG, PNG, or WebP image under 2 MB and 16 megapixels." }); }
    await deps.db.updateTable("users").set({ avatar }).where("id", "=", id).execute();
    return { avatar: userAvatar(id, avatar) };
  });

  app.get("/api/v1/users/:id/avatar", async (request: Req, reply: any) => {
    const actor = await requireSession(request, reply);
    if (!actor) return;
    const { id } = request.params as { id: string };
    if (actor.role !== "admin" && actor.userId !== id) return reply.code(403).send({ error: "forbidden" });
    const user = await deps.db.selectFrom("users").select("avatar").where("id", "=", id).executeTakeFirst();
    if (!user?.avatar?.startsWith("data:image/webp;base64,")) return reply.code(404).send({ error: "No uploaded picture." });
    return reply.header("content-type", "image/webp").header("x-content-type-options", "nosniff")
      .header("cache-control", "private, no-cache").send(Buffer.from(user.avatar.slice("data:image/webp;base64,".length), "base64"));
  });

  app.post("/api/v1/users", { schema: { body: CreateUserBody } }, async (request: Req, reply: any) => {
    const admin = await requireAdmin(request, reply);
    if (!admin) return;
    const body = request.body as { username: string; password: string; role: Role };
    const [existing] = await deps.db.selectFrom("users").select("id").where("username", "=", body.username).execute();
    if (existing) return reply.code(409).send({ error: "username already exists" });
    const id = await deps.auth.createUser(body.username, body.password, body.role);
    return reply.code(201).send({ user: { id, username: body.username, role: body.role } });
  });

  app.get("/api/v1/users/:id/ui-preferences", async (request: Req, reply: any) => {
    const id = String((request.params as { id?: string } | undefined)?.["id"] ?? "");
    const actor = await requireSession(request, reply);
    if (!actor) return;
    if (actor.role !== "admin" && actor.userId !== id) return reply.code(403).send({ error: "forbidden" });
    const [row] = await deps.db.selectFrom("ui_preferences").selectAll().where("userId", "=", id).execute();
    return { preferences: row ? (JSON.parse(row.preferences) as Record<string, unknown>) : {} };
  });

  app.put("/api/v1/users/:id/ui-preferences", { schema: { body: PreferencesBody } }, async (request: Req, reply: any) => {
    const id = String((request.params as { id?: string } | undefined)?.["id"] ?? "");
    const actor = await requireSession(request, reply);
    if (!actor) return;
    if (actor.role !== "admin" && actor.userId !== id) return reply.code(403).send({ error: "forbidden" });
    const incoming = (request.body as { preferences: Record<string, unknown> }).preferences ?? {};
    return deps.db.transaction().execute(async transaction => {
      const [existing] = await transaction.selectFrom("ui_preferences").select("preferences").where("userId", "=", id).execute();
      const current = existing ? JSON.parse(existing.preferences) as Record<string, unknown> : {};
      const merged = { ...current, ...incoming };
      const currentNotifications = current.notifications && typeof current.notifications === "object" && !Array.isArray(current.notifications)
        ? current.notifications as Record<string, unknown>
        : {};
      const incomingNotifications = incoming.notifications && typeof incoming.notifications === "object" && !Array.isArray(incoming.notifications)
        ? incoming.notifications as Record<string, unknown>
        : null;
      if (incomingNotifications) {
        merged.notifications = {
          ...currentNotifications,
          ...incomingNotifications,
          ...(incomingNotifications.durations && typeof incomingNotifications.durations === "object"
            ? { durations: { ...(currentNotifications.durations as Record<string, unknown> | undefined), ...incomingNotifications.durations as Record<string, unknown> } }
            : {}),
          ...(incomingNotifications.events && typeof incomingNotifications.events === "object"
            ? { events: { ...(currentNotifications.events as Record<string, unknown> | undefined), ...incomingNotifications.events as Record<string, unknown> } }
            : {}),
        };
      }
      const row: UiPreferencesTable = { userId: id, preferences: JSON.stringify(merged), updatedAt: new Date().toISOString() };
      await transaction
        .insertInto("ui_preferences")
        .values(row)
        .onConflict((oc) => oc.column("userId").doUpdateSet({ preferences: row.preferences, updatedAt: row.updatedAt }))
        .execute();
      return { saved: true, preferences: merged };
    });
  });

  // ---- Themes ------------------------------------------------------------
  app.get("/api/v1/themes", async (request: Req, reply: any) => {
    const admin = await requireAdmin(request, reply);
    if (!admin) return;
    const rows = await deps.db.selectFrom("themes").selectAll().orderBy("updatedAt asc").execute();
    return {
      themes: rows.map((t) => ({ id: t.id, name: t.name, tokens: JSON.parse(t.tokens) as Record<string, string> })),
    };
  });

  app.post("/api/v1/themes", { schema: { body: ThemeBody } }, async (request: Req, reply: any) => {
    const admin = await requireAdmin(request, reply);
    if (!admin) return;
    const body = request.body as { name: string; tokens: Record<string, string> };
    let tokens: Record<string, string>;
    try {
      tokens = sanitizeThemeTokens(body.tokens);
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
    const id = uuidv7();
    const row: ThemesTable = { id, name: body.name, tokens: JSON.stringify(tokens), updatedAt: new Date().toISOString() };
    await deps.db.insertInto("themes").values(row).execute();
    return reply.code(201).send({ theme: { id, name: body.name, tokens } });
  });

  app.put("/api/v1/themes/:id", { schema: { body: ThemeBody } }, async (request: Req, reply: any) => {
    const admin = await requireAdmin(request, reply);
    if (!admin) return;
    const id = String((request.params as { id?: string } | undefined)?.["id"] ?? "");
    const body = request.body as { name: string; tokens: Record<string, string> };
    let tokens: Record<string, string>;
    try {
      tokens = sanitizeThemeTokens(body.tokens);
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
    const updatedAt = new Date().toISOString();
    const result = await deps.db
      .updateTable("themes")
      .set({ name: body.name, tokens: JSON.stringify(tokens), updatedAt })
      .where("id", "=", id)
      .executeTakeFirst();
    if (Number(result?.numUpdatedRows ?? 0n) === 0) return reply.code(404).send({ error: "unknown theme" });
    return { saved: true };
  });

  app.delete("/api/v1/themes/:id", async (request: Req, reply: any) => {
    const admin = await requireAdmin(request, reply);
    if (!admin) return;
    const id = String((request.params as { id?: string } | undefined)?.["id"] ?? "");
    const result = await deps.db.deleteFrom("themes").where("id", "=", id).executeTakeFirst();
    if (Number(result?.numDeletedRows ?? 0n) === 0) return reply.code(404).send({ error: "unknown theme" });
    return { deleted: true };
  });

  // ---- System health ------------------------------------------------------
  app.get("/api/v1/system/health", async (request: Req, reply: any) => {
    const admin = await requireAdmin(request, reply);
    if (!admin) return;
    let eventCount: number | null = null;
    try {
      const [row] = await deps.db.selectFrom("events").select((eb) => eb.fn.countAll<number>().as("n")).execute();
      eventCount = Number(row?.n ?? 0);
    } catch {
      eventCount = null; // degraded: report null rather than fail the view
    }
    return {
      ready: deps.ready(),
      plugins: deps.supervisorList().map((p) => ({
        id: p.manifest.id,
        version: p.manifest.version,
        state: p.state,
        restarts: p.restartCount,
      })),
      eventCount,
    };
  });
}
