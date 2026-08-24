/**
 * Wave 10 (TAN-022) HTTP surface: /api/v1/naming — import and naming
 * settings. Live template previews, fail-closed validation, bulk rename
 * review plans, and recovery guidance. Guard chain matches library routes:
 * reads for any signed-in user; mutations admin-only with CSRF.
 *
 * All work happens inside the library plugin via its public capability; the
 * routes are a thin, auditable HTTP boundary. Bulk plans NEVER move files —
 * they only describe what WOULD change, so operators review first.
 */
import type { FastifyInstance } from "fastify";
import { Type } from "@sinclair/typebox";

export interface NamingDeps {
  invoke: (operation: string, payload: Record<string, unknown>) => Promise<unknown>;
  requireUser: (
    request: unknown,
    reply: unknown,
  ) => Promise<{ userId: string; role: string } | null>;
  requireAdmin: (
    request: unknown,
    reply: unknown,
  ) => Promise<{ userId: string; role: string } | null>;
  csrfOk: (request: { method?: string; headers?: Record<string, unknown> }) => boolean;
}

const SchemeBody = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 120 }),
  episodeTemplate: Type.String({ minLength: 1 }),
  movieTemplate: Type.String({ minLength: 1 }),
});

const PreviewBody = Type.Object({
  kind: Type.Union([Type.Literal("series"), Type.Literal("movie")]),
  title: Type.String({ minLength: 1 }),
  scheme: Type.Optional(Type.String()),
  episodeTemplate: Type.Optional(Type.String()),
  movieTemplate: Type.Optional(Type.String()),
  series: Type.Optional(Type.String()),
  season: Type.Optional(Type.Number()),
  episode: Type.Optional(Type.Number()),
  year: Type.Optional(Type.Number()),
  quality: Type.Optional(Type.String()),
  codec: Type.Optional(Type.String()),
  language: Type.Optional(Type.String()),
  edition: Type.Optional(Type.String()),
});

interface Req {
  body?: unknown;
  params?: unknown;
}

function statusOf(err: unknown): number {
  const code = (err as { code?: string }).code;
  if (code === "invalid_template" || code === "path_escape") return 400;
  // Plugin errors cross the IPC boundary as plain Errors; the code survives
  // only inside the message, so map on both.
  const msg = (err as Error)?.message ?? String(err);
  if (/unknown placeholder|must not traverse|non-empty string|template/i.test(msg)) return 400;
  const sc = (err as { statusCode?: number }).statusCode;
  return typeof sc === "number" ? sc : 500;
}

const RECOVERY_GUIDANCE = [
  "Bulk renames are preview-only in Tantalar: a rename plan lists every item whose path would change, and no file moves until an operator applies each change through the import pipeline.",
  "Before a bulk rename, take a backup from Settings > System > Backup so the catalog can be restored.",
  "Hardlink imports never duplicate data; a rename plan that only changes paths can be re-imported safely because import is idempotent per itemKey and content hash.",
  "If a rename left orphaned files, remove the library definition (media is never deleted) and re-import from the source root.",
] as const;

export function registerNamingRoutes(app: FastifyInstance, deps: NamingDeps): void {
  app.get("/api/v1/naming/schemes", async (request: any, reply: any) => {
    const auth = await deps.requireUser(request, reply);
    if (!auth) return;
    return deps.invoke("list-schemes", {});
  });

  app.post("/api/v1/naming/schemes", { schema: { body: SchemeBody } }, async (request: any, reply: any) => {
    const auth = await deps.requireAdmin(request, reply);
    if (!auth) return;
    if (!deps.csrfOk(request)) return reply.code(403).send({ error: "csrf required" });
    try {
      // set-scheme validates both templates fail-closed before saving.
      return await deps.invoke("set-scheme", request.body as Record<string, unknown>);
    } catch (err) {
      return reply.code(statusOf(err)).send({ error: (err as Error).message });
    }
  });

  // Live preview of the output path for a template + candidate item.
  app.post("/api/v1/naming/preview", { schema: { body: PreviewBody } }, async (request: any, reply: any) => {
    const auth = await deps.requireUser(request, reply);
    if (!auth) return;
    try {
      return await deps.invoke("preview-rename", request.body as Record<string, unknown>);
    } catch (err) {
      return reply.code(statusOf(err)).send({ error: (err as Error).message });
    }
  });

  // Bulk review plan: every imported item re-rendered under a scheme.
  app.get("/api/v1/naming/rename-plan", async (request: any, reply: any) => {
    const auth = await deps.requireAdmin(request, reply);
    if (!auth) return;
    try {
      return await deps.invoke("rename-plan", { scheme: (request.query as Record<string, string>)?.["scheme"] });
    } catch (err) {
      return reply.code(statusOf(err)).send({ error: (err as Error).message });
    }
  });

  // Recovery guidance for bulk operations (static, versioned with the app).
  app.get("/api/v1/naming/recovery-guidance", async (request: any, reply: any) => {
    const auth = await deps.requireUser(request, reply);
    if (!auth) return;
    return { guidance: RECOVERY_GUIDANCE };
  });
}
