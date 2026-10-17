/**
 * Wave 7 (TAN-014) HTTP surface: /api/v1/indexers — add, list/get, edit,
 * test, enable, and delete. Guard chain matches the Wave 3 library routes: reads for any
 * signed-in user; mutations admin-only with CSRF on cookie sessions.
 * Indexer records are redacted — an apikey is never returned by any route.
 */
import type { FastifyInstance } from "fastify";
import { Type } from "@sinclair/typebox";
import { IndexerSettingsService, type IndexerSettingsError } from "./indexer-settings.js";

export interface IndexerDeps {
  service: IndexerSettingsService;
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

const LimitsBody = Type.Object({
  maxSearchesPerWindow: Type.Optional(Type.Integer({ minimum: 0 })),
  windowMs: Type.Optional(Type.Integer({ minimum: 0 })),
  retentionDays: Type.Optional(Type.Integer({ minimum: 0 })),
});
const SearchModesBody = Type.Object({
  interactive: Type.Optional(Type.Boolean()),
  automatic: Type.Optional(Type.Boolean()),
});
const CategoriesBody = Type.Array(Type.Integer({ minimum: 1 }), { maxItems: 100 });
const TagsBody = Type.Array(Type.String({ minLength: 1, maxLength: 40 }), { maxItems: 20 });

const AddBody = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 120 }),
  protocol: Type.Union([Type.Literal("torznab"), Type.Literal("newznab")]),
  baseUrl: Type.String({ minLength: 1 }),
  apiKey: Type.Optional(Type.String()),
  priority: Type.Optional(Type.Number()),
  enabled: Type.Optional(Type.Boolean()),
  searchModes: Type.Optional(SearchModesBody),
  categories: Type.Optional(CategoriesBody),
  tags: Type.Optional(TagsBody),
  limits: Type.Optional(LimitsBody),
});
const UpdateBody = Type.Object({
  name: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
  protocol: Type.Optional(Type.Union([Type.Literal("torznab"), Type.Literal("newznab")])),
  baseUrl: Type.Optional(Type.String({ minLength: 1 })),
  apiKey: Type.Optional(Type.String()),
  priority: Type.Optional(Type.Number()),
  enabled: Type.Optional(Type.Boolean()),
  searchModes: Type.Optional(SearchModesBody),
  categories: Type.Optional(CategoriesBody),
  tags: Type.Optional(TagsBody),
  limits: Type.Optional(LimitsBody),
});
const EnabledBody = Type.Object({ enabled: Type.Boolean() });

interface Req {
  body?: unknown;
  params?: unknown;
}

function statusOf(err: unknown): number {
  if (err && typeof err === "object" && "statusCode" in err) {
    const code = (err as { statusCode?: number }).statusCode;
    if (typeof code === "number") return code;
  }
  return 500;
}

const idOf = (request: Req): string =>
  String((request.params as { id?: string } | undefined)?.["id"] ?? "");

export function registerIndexerRoutes(app: FastifyInstance, deps: IndexerDeps): void {
  app.get("/api/v1/indexers", async (request: any, reply: any) => {
    const auth = await deps.requireUser(request, reply);
    if (!auth) return;
    return { indexers: await deps.service.list() };
  });

  app.post("/api/v1/indexers", { schema: { body: AddBody } }, async (request: any, reply: any) => {
    const auth = await deps.requireAdmin(request, reply);
    if (!auth) return;
    if (!deps.csrfOk(request)) return reply.code(403).send({ error: "csrf required" });
    try {
      const indexer = await deps.service.add(request.body as never);
      return reply.code(201).send({ indexer });
    } catch (err) {
      return reply.code(statusOf(err)).send({ error: (err as Error).message });
    }
  });

  app.get("/api/v1/indexers/:id", async (request: any, reply: any) => {
    const auth = await deps.requireUser(request, reply);
    if (!auth) return;
    try {
      return { indexer: await deps.service.get(idOf(request)) };
    } catch (err) {
      return reply.code(statusOf(err)).send({ error: (err as Error).message });
    }
  });

  app.patch("/api/v1/indexers/:id", { schema: { body: UpdateBody } }, async (request: any, reply: any) => {
    const auth = await deps.requireAdmin(request, reply);
    if (!auth) return;
    if (!deps.csrfOk(request)) return reply.code(403).send({ error: "csrf required" });
    try {
      return { indexer: await deps.service.update(idOf(request), request.body as never) };
    } catch (err) {
      return reply.code(statusOf(err)).send({ error: (err as Error).message });
    }
  });

  app.delete("/api/v1/indexers/:id", async (request: any, reply: any) => {
    const auth = await deps.requireAdmin(request, reply);
    if (!auth) return;
    if (!deps.csrfOk(request)) return reply.code(403).send({ error: "csrf required" });
    try {
      await deps.service.delete(idOf(request));
      return reply.code(204).send();
    } catch (err) {
      return reply.code(statusOf(err)).send({ error: (err as Error).message });
    }
  });

  // Test connection: real caps probe against the provider.
  app.post("/api/v1/indexers/:id/test", async (request: any, reply: any) => {
    const auth = await deps.requireAdmin(request, reply);
    if (!auth) return;
    if (!deps.csrfOk(request)) return reply.code(403).send({ error: "csrf required" });
    try {
      return await deps.service.test(idOf(request));
    } catch (err) {
      return reply.code(statusOf(err)).send({ error: (err as Error).message });
    }
  });

  // Enable / disable one indexer.
  app.put("/api/v1/indexers/:id/enabled", { schema: { body: EnabledBody } }, async (request: any, reply: any) => {
    const auth = await deps.requireAdmin(request, reply);
    if (!auth) return;
    if (!deps.csrfOk(request)) return reply.code(403).send({ error: "csrf required" });
    const body = request.body as { enabled: boolean };
    try {
      return { indexer: await deps.service.setEnabled(idOf(request), body.enabled) };
    } catch (err) {
      return reply.code(statusOf(err)).send({ error: (err as Error).message });
    }
  });
}
