/**
 * Phase 6 admin surface (stories 25–27): users management, per-user UI
 * preferences, theme storage, and system health for the admin UI.
 *
 * Security model:
 *  - every route authenticates through the session cookie;
 *  - ALL routes here are admin-only (role check) — ordinary viewers get 403;
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

const PreferencesBody = Type.Object({
  preferences: Type.Record(Type.String(), Type.Unknown()),
});
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
  method?: string;
  body?: unknown;
  params?: unknown;
  cookies?: Record<string, string | undefined>;
  headers?: Record<string, unknown>;
}

export function registerAdminRoutes(app: FastifyInstance, deps: AdminDeps): void {
  /**
   * Admin-only guard: 401 unauthenticated, 403 non-admin. Cookie mutations
   * require the CSRF double-submit token (same discipline as serving.ts).
   */
  const requireAdmin = async (
    request: Req,
    reply: { code: (n: number) => { send: (b: unknown) => unknown } },
  ): Promise<{ userId: string; role: string } | null> => {
    const token = request.cookies?.["tantalar_session"];
    if (!token) {
      void reply.code(401).send({ error: "unauthorized" });
      return null;
    }
    if (["POST", "PUT", "PATCH", "DELETE"].includes(request.method ?? "") && !request.headers?.authorization) {
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
    return { userId: session.userId, role: session.role };
  };

  // ---- Users management -------------------------------------------------
  app.get("/api/v1/users", async (request: Req, reply: any) => {
    const admin = await requireAdmin(request, reply);
    if (!admin) return;
    const rows = await deps.db
      .selectFrom("users")
      .select(["id", "username", "role", "createdAt"])
      .orderBy("createdAt asc")
      .execute();
    return { users: rows };
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
    const admin = await requireAdmin(request, reply);
    if (!admin) return;
    const id = String((request.params as { id?: string } | undefined)?.["id"] ?? "");
    const [row] = await deps.db.selectFrom("ui_preferences").selectAll().where("userId", "=", id).execute();
    return { preferences: row ? (JSON.parse(row.preferences) as Record<string, unknown>) : {} };
  });

  app.put("/api/v1/users/:id/ui-preferences", { schema: { body: PreferencesBody } }, async (request: Req, reply: any) => {
    const admin = await requireAdmin(request, reply);
    if (!admin) return;
    const id = String((request.params as { id?: string } | undefined)?.["id"] ?? "");
    const preferences = JSON.stringify((request.body as { preferences: Record<string, unknown> }).preferences ?? {});
    const row: UiPreferencesTable = { userId: id, preferences, updatedAt: new Date().toISOString() };
    await deps.db
      .insertInto("ui_preferences")
      .values(row)
      .onConflict((oc) => oc.column("userId").doUpdateSet({ preferences: row.preferences, updatedAt: row.updatedAt }))
      .execute();
    return { saved: true };
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
