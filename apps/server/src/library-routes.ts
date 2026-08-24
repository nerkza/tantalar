/**
 * Wave 3 (TAN-020/021) HTTP surface: /api/v1/libraries.
 *
 * Guard chain (wired by http.ts, same discipline as admin routes):
 *  - every route requires authentication;
 *  - ALL mutations are admin-only and CSRF-checked for cookie sessions;
 *  - reads are available to any signed-in user.
 *
 * Removal semantics mirror the service: DELETE /libraries/:id removes only
 * the definition; media deletion is a separate POST .../media/delete with
 * explicit { confirmDelete: true }.
 */
import type { FastifyInstance } from "fastify";
import { Type } from "@sinclair/typebox";
import { LibraryError, type LibraryService } from "./library.js";

export interface LibraryDeps {
  service: LibraryService;
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

const CreateBody = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 120 }),
  rootPath: Type.String({ minLength: 1 }),
  kind: Type.Union([Type.Literal("series"), Type.Literal("movie"), Type.Literal("mixed")]),
});
const EditBody = Type.Partial(CreateBody);
const EnabledBody = Type.Object({ enabled: Type.Boolean() });
const MediaDeleteBody = Type.Object({ confirmDelete: Type.Boolean() });

interface Req {
  body?: unknown;
  params?: unknown;
  query?: Record<string, string | undefined>;
}

function statusOf(err: unknown): number {
  if (err instanceof LibraryError) return err.statusCode;
  const code = (err as { statusCode?: number }).statusCode;
  return typeof code === "number" ? code : 500;
}

export function registerLibraryRoutes(app: FastifyInstance, deps: LibraryDeps): void {
  const id = (request: Req): string => String((request.params as { id?: string } | undefined)?.["id"] ?? "");

  app.get("/api/v1/libraries", async (request: any, reply: any) => {
    const auth = await deps.requireUser(request, reply);
    if (!auth) return;
    return { libraries: await deps.service.list() };
  });

  app.post("/api/v1/libraries", { schema: { body: CreateBody } }, async (request: any, reply: any) => {
    const auth = await deps.requireAdmin(request, reply);
    if (!auth) return;
    if (!deps.csrfOk(request)) return reply.code(403).send({ error: "csrf required" });
    const body = request.body as { name: string; rootPath: string; kind: "series" | "movie" | "mixed" };
    try {
      const record = await deps.service.create(body);
      return reply.code(201).send({ library: record });
    } catch (err) {
      return reply.code(statusOf(err)).send({ error: (err as Error).message });
    }
  });

  app.get("/api/v1/libraries/:id", async (request: any, reply: any) => {
    const auth = await deps.requireUser(request, reply);
    if (!auth) return;
    try {
      return { library: await deps.service.get(id(request)) };
    } catch (err) {
      return reply.code(statusOf(err)).send({ error: (err as Error).message });
    }
  });

  app.patch("/api/v1/libraries/:id", { schema: { body: EditBody } }, async (request: any, reply: any) => {
    const auth = await deps.requireAdmin(request, reply);
    if (!auth) return;
    if (!deps.csrfOk(request)) return reply.code(403).send({ error: "csrf required" });
    try {
      const library = await deps.service.edit(id(request), request.body as Record<string, never>);
      return { library };
    } catch (err) {
      return reply.code(statusOf(err)).send({ error: (err as Error).message });
    }
  });

  app.put("/api/v1/libraries/:id/enabled", { schema: { body: EnabledBody } }, async (request: any, reply: any) => {
    const auth = await deps.requireAdmin(request, reply);
    if (!auth) return;
    if (!deps.csrfOk(request)) return reply.code(403).send({ error: "csrf required" });
    const body = request.body as { enabled: boolean };
    try {
      return { library: await deps.service.setEnabled(id(request), body.enabled) };
    } catch (err) {
      return reply.code(statusOf(err)).send({ error: (err as Error).message });
    }
  });

  // Removal NEVER deletes media; the response states that explicitly.
  app.delete("/api/v1/libraries/:id", async (request: any, reply: any) => {
    const auth = await deps.requireAdmin(request, reply);
    if (!auth) return;
    if (!deps.csrfOk(request)) return reply.code(403).send({ error: "csrf required" });
    try {
      return await deps.service.remove(id(request));
    } catch (err) {
      return reply.code(statusOf(err)).send({ error: (err as Error).message });
    }
  });

  // Explicit media deletion — the ONLY path that touches files on disk.
  app.post("/api/v1/libraries/:id/media/delete", { schema: { body: MediaDeleteBody } }, async (request: any, reply: any) => {
    const auth = await deps.requireAdmin(request, reply);
    if (!auth) return;
    if (!deps.csrfOk(request)) return reply.code(403).send({ error: "csrf required" });
    const body = request.body as { confirmDelete: boolean };
    try {
      return await deps.service.removeMedia(id(request), body.confirmDelete);
    } catch (err) {
      return reply.code(statusOf(err)).send({ error: (err as Error).message });
    }
  });

  app.get("/api/v1/libraries/validate", async (request: any, reply: any) => {
    const auth = await deps.requireAdmin(request, reply);
    if (!auth) return;
    try {
      return { results: await deps.service.validate(request.query?.["libraryId"]) };
    } catch (err) {
      return reply.code(statusOf(err)).send({ error: (err as Error).message });
    }
  });

  app.post("/api/v1/libraries/:id/rescan", async (request: any, reply: any) => {
    const auth = await deps.requireAdmin(request, reply);
    if (!auth) return;
    if (!deps.csrfOk(request)) return reply.code(403).send({ error: "csrf required" });
    try {
      return await deps.service.rescan(id(request));
    } catch (err) {
      return reply.code(statusOf(err)).send({ error: (err as Error).message });
    }
  });

  app.get("/api/v1/libraries/:id/free-space", async (request: any, reply: any) => {
    const auth = await deps.requireUser(request, reply);
    if (!auth) return;
    try {
      await deps.service.get(id(request)); // 404 when unknown
      return deps.service.freeSpace(id(request));
    } catch (err) {
      return reply.code(statusOf(err)).send({ error: (err as Error).message });
    }
  });

  app.get("/api/v1/catalog", async (request: any, reply: any) => {
    const auth = await deps.requireUser(request, reply);
    if (!auth) return;
    return { items: await deps.service.catalogList(request.query?.["libraryId"]) };
  });
}
