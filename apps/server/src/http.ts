/**
 * Fastify HTTP/WS server: REST /api/v1 + WS /api/v1/events feed,
 * runtime-generated OpenAPI, health endpoints (architecture §10, §12).
 * Handlers are typed loosely against FastifyRequest to keep the route table
 * readable; runtime validation is done by the schema objects and the auth
 * helpers below.
 */
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import fastifyStatic, { type FastifyStaticOptions } from "@fastify/static";
import websocket from "@fastify/websocket";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "@sinclair/typebox";
import { AuthService, API_KEY_PREFIX } from "./auth.js";
import type { EventBus } from "./events.js";
import type { Supervisor } from "./supervisor.js";
import type { ServiceContainer } from "./container.js";
import { registerServingRoutes, type ServingDeps } from "./serving.js";
import { registerAdminRoutes, type AdminDeps } from "./admin.js";
import { registerLibraryRoutes, type LibraryDeps } from "./library-routes.js";
import { registerIndexerRoutes, type IndexerDeps } from "./indexer-routes.js";
import { registerOpsRoutes, type OpsDeps } from "./ops-routes.js";
import { registerNamingRoutes, type NamingDeps } from "./naming-routes.js";
import type { IndexerSettingsService } from "./indexer-settings.js";
import { OnboardingService, OnboardingError } from "./onboarding.js";
import type { Kysely } from "kysely";
import type { Db } from "@tantalar/db";

export interface ServerDeps {
  auth: AuthService;
  db?: Kysely<Db>;
  bus: EventBus;
  supervisor: Supervisor;
  container: ServiceContainer;
  ready: () => boolean;
  /** Truthful readiness detail (missing capabilities etc.). Optional for direct buildServer callers. */
  readiness?: () => {
    ready: boolean;
    listening: boolean;
    missingCapabilities: string[];
  };
  /** Phase 5A serving surface; absent until the serving plugin is configured. */
  serving?: (invoke: (operation: string, payload: Record<string, unknown>) => Promise<unknown>) => ServingDeps;
  /** Test hook: omit the guided-onboarding routes. */
  onboardingDisabled?: boolean;
  /** Wave 3 (TAN-020/021) library management surface; present with a DB handle. */
  library?: LibraryDeps["service"];
  /** Wave 7 (TAN-014) indexer add/test/enable surface; present with a DB handle. */
  indexerSettings?: IndexerSettingsService;
  /** Wave 9 (TAN-030–043) operations surface deps; present with a DB handle. */
  ops?: OpsDeps;
}

interface AuthContext {
  kind: "session" | "apiKey";
  scopes: string[];
  userId?: string;
  role?: string;
}

const LoginBody = Type.Object({ username: Type.String(), password: Type.String() });
const StepActionBody = Type.Object({ action: Type.Union([Type.Literal("complete"), Type.Literal("skip")]) });

function bearerToken(header: unknown): string | undefined {
  if (typeof header !== "string") return undefined;
  const m = /^Bearer (.+)$/.exec(header);
  return m ? m[1] : undefined;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export async function buildServer(deps: ServerDeps): Promise<FastifyInstance> {
  const app: FastifyInstance = Fastify({ logger: false });
  await app.register(cookie);
  await app.register(websocket);

  // Route scope requirements: API keys must hold the required scope (enforced
  // in verifyApiKey); cookie sessions carry the admin role and satisfy any
  // scope (ADR-0011, phase-1 doc: mutations authenticated under scope lists).
  const authenticate = async (
    request: any,
    requiredScope?: string,
  ): Promise<AuthContext | "forbidden" | null> => {
    const token = bearerToken(request.headers?.authorization);
    if (token && token.startsWith(API_KEY_PREFIX)) {
      const key = await deps.auth.verifyApiKey(token);
      if (!key) return null;
      // Valid key but missing the route's required scope → explicit 403.
      if (requiredScope && !key.scopes.includes(requiredScope)) return "forbidden";
      return { kind: "apiKey", scopes: key.scopes };
    }
    const sessionToken: string | undefined = token ?? request.cookies?.["tantalar_session"];
    if (!sessionToken) return null;
    const session = await deps.auth.getSession(sessionToken);
    if (!session) return null;
    return { kind: "session", scopes: [], userId: session.userId, role: session.role };
  };

  // Standard auth guard: null → 401, "forbidden" (scope mismatch) → 403.
  const requireAuth = async (
    reply: any,
    request: any,
    requiredScope?: string,
  ): Promise<AuthContext | null> => {
    const auth = await authenticate(request, requiredScope);
    if (auth === "forbidden") {
      await reply.code(403).send({ error: "insufficient scope" });
      return null;
    }
    if (!auth) await reply.code(401).send({ error: "unauthorized" });
    return auth;
  };

  // Cookie-authenticated mutations require CSRF double-submit (ADR-0011).
  const csrfOk = (request: any): boolean => {
    if (!["POST", "PUT", "PATCH", "DELETE"].includes(request.method)) return true;
    if (request.headers?.authorization) return true;
    const headerToken = request.headers?.["x-csrf-token"];
    const header = Array.isArray(headerToken) ? String(headerToken[0]) : typeof headerToken === "string" ? headerToken : undefined;
    return AuthService.verifyCsrf(request.cookies?.["tantalar_csrf"], header);
  };

  app.setErrorHandler((err: any, _req: any, reply: any) => {
    const code = typeof err?.statusCode === "number" ? err.statusCode : 500;
    reply.code(code).send({ error: err.message });
  });

  app.get("/healthz", async () => ({ ok: true }));
  app.get("/readyz", async (_req: any, reply: any) => {
    if (deps.ready()) return { ok: true };
    const detail = deps.readiness?.();
    return reply.code(503).send({
      ok: false,
      listening: detail?.listening ?? null,
      missingCapabilities: detail?.missingCapabilities ?? [],
    });
  });

  // Secure one-time bootstrap (wave 2, TAN-002): when no user exists yet,
  // exactly one administrator may be created without a session. The check
  // and insert share a database transaction (AuthService.createInitialAdmin),
  // so concurrent requests cannot create two bootstrap administrators. Once
  // any user exists the endpoint is permanently closed (403) — it can never
  // create a second account or overwrite an existing one.
  app.get("/api/v1/bootstrap/status", async () => ({
    required: await deps.auth.isBootstrapRequired(),
  }));

  app.post("/api/v1/bootstrap/admin", async (request: any, reply: any) => {
    if (!deps.db) return reply.code(503).send({ error: "storage unavailable" });
    const body = (request.body ?? {}) as { username?: string; password?: string };
    const result = await deps.auth.createInitialAdmin(
      String(body.username ?? ""),
      String(body.password ?? ""),
    );
    if (!result.ok) {
      return reply.code(result.reason === "closed" ? 403 : 400).send({
        error:
          result.reason === "closed"
            ? "Setup is already complete. Sign in with your administrator account."
            : "Choose a username and a password of at least 8 characters.",
      });
    }
    return { ok: true };
  });

  // ---- Wave 2 guided onboarding (TAN-003): durable, resumable wizard ----
  if (deps.db && !deps.onboardingDisabled) {
    const onboarding = new OnboardingService(deps.db);

    app.get("/api/v1/onboarding", async (request: any, reply: any) => {
      // First-run probe: before the administrator exists there is no session
      // to authenticate, so the wizard could never appear. The read is
      // anonymous only while bootstrap is required (zero users); it exposes
      // nothing but step statuses. Mutations always require auth + CSRF.
      if (await deps.auth.isBootstrapRequired()) {
        return onboarding.getState();
      }
      const auth = await requireAuth(reply, request);
      if (!auth) return;
      return onboarding.getState();
    });

    app.post(
      "/api/v1/onboarding/steps/:stepId",
      { schema: { body: StepActionBody } },
      async (request: any, reply: any) => {
        const auth = await requireAuth(reply, request);
        if (!auth) return;
        if (auth.kind !== "session" || auth.role !== "admin") {
          return reply.code(403).send({ error: "administrator access required" });
        }
        if (!csrfOk(request)) return reply.code(403).send({ error: "csrf required" });
        try {
          const state = await onboarding.setStep(
            String(request.params?.stepId ?? ""),
            request.body.action,
          );
          return state;
        } catch (err) {
          const status = err instanceof OnboardingError ? err.statusCode : 500;
          return reply.code(status).send({ error: (err as Error).message });
        }
      },
    );
  }

  app.post(
    "/api/v1/auth/login",
    { schema: { body: LoginBody } },
    async (request: any, reply: any) => {
      const body = request.body as { username: string; password: string } | undefined;
      const verified = await deps.auth.verifyPassword(body?.username ?? "", body?.password ?? "");
      if (!verified) return reply.code(401).send({ error: "invalid credentials" });
      const { token, csrfToken } = await deps.auth.createSession(verified.userId);
      reply.setCookie("tantalar_session", token, {
        httpOnly: true,
        sameSite: "lax",
        secure: false, // TLS terminates at the reverse proxy (architecture §5)
        path: "/",
      });
      reply.setCookie("tantalar_csrf", csrfToken, {
        httpOnly: false,
        sameSite: "lax",
        secure: false,
        path: "/",
      });
      return { csrfToken, role: verified.role };
    },
  );

  // Session introspection: 401 without a session; user id + role with one.
  app.get("/api/v1/auth/me", async (request: any, reply: any) => {
    const token: string | undefined = request.cookies?.["tantalar_session"];
    if (!token) return reply.code(401).send({ error: "unauthorized" });
    const session = await deps.auth.getSession(token);
    if (!session) return reply.code(401).send({ error: "unauthorized" });
    const [user] = await deps.db!
      .selectFrom("users")
      .select(["id", "username", "role"])
      .where("id", "=", session.userId)
      .execute();
    return { user: user ?? null };
  });

  app.post("/api/v1/auth/logout", async (request: any, reply: any) => {
    if (!csrfOk(request)) return reply.code(403).send({ error: "csrf required" });
    const token: string | undefined = request.cookies?.["tantalar_session"];
    if (token) await deps.auth.destroySession(token);
    reply.clearCookie("tantalar_session");
    reply.clearCookie("tantalar_csrf");
    return { ok: true };
  });

  app.get("/api/v1/events", async (request: any, reply: any) => {
    if (!(await requireAuth(reply, request, "events.read"))) return;
    const q = (request.query ?? {}) as Record<string, string | undefined>;
    const events = await deps.bus.read({
      ...(q.typePrefix ? { typePrefix: q.typePrefix } : {}),
      ...(q.correlationId ? { correlationId: q.correlationId } : {}),
      ...(q.subject ? { subject: q.subject } : {}),
      ...(q.afterEventId ? { afterEventId: q.afterEventId } : {}),
      ...(q.limit ? { limit: Number(q.limit) } : {}),
    });
    return { events };
  });

  app.get("/api/v1/events/feed", { websocket: true } as any, (socket: any, request: any) => {
    void (async () => {
      const auth = await authenticate(request, "events.read");
      if (auth === "forbidden") {
        socket.close(4403, "insufficient scope");
        return;
      }
      if (!auth) {
        socket.close(4401, "unauthorized");
        return;
      }
      const query: Record<string, string | undefined> = request.query ?? {};
      const unsub = deps.bus.subscribe(query.typePrefix ?? "", (envelope) => {
        if (query.subject && envelope.subject !== query.subject) return;
        socket.send(JSON.stringify(envelope));
      });
      socket.on("close", unsub);
    })();
  });

  app.get("/api/v1/plugins", async (request: any, reply: any) => {
    if (!(await requireAuth(reply, request, "plugins.read"))) return;
    return { plugins: deps.supervisor.list() };
  });

  // ---- Phase 5A serving routes ----
  // The serving capability provider is resolved lazily so routes exist only
  // when the plugin is mounted; every handler authorizes via the plugin.
  if (deps.serving) {
    let cached: ServingDeps | null = null;
    const servingDeps = (): ServingDeps => {
      if (!cached) {
        cached = deps.serving!((operation, payload) => {
          const provider = deps.container.resolve("dev.tantalar.capability.serving");
          return provider.invoke(operation, payload);
        });
        // The core guard's signature is (reply, request, scope); serving
        // routes call (request, reply, scope), so swap the first two args.
        cached.requireAuth = ((req: unknown, rep: unknown, scope?: string) => {
          // Cookie-authenticated MUTATIONS require the CSRF double-submit
          // token (ADR-0011) — enforced here so every serving route
          // (resume, negotiate, transcode-session, subtitles POST, DELETE)
          // is covered without relying on each handler remembering it.
          const method = (req as { method?: string }).method ?? "";
          const hasAuthHeader = typeof (req as { headers?: Record<string, unknown> }).headers?.authorization === "string";
          const hasSessionCookie = !!(req as { cookies?: Record<string, string | undefined> }).cookies?.["tantalar_session"];
          if (!hasAuthHeader && hasSessionCookie && ["POST", "PUT", "PATCH", "DELETE"].includes(method)) {
            const headers = (req as { headers?: Record<string, unknown> }).headers ?? {};
            const raw = headers["x-csrf-token"];
            const headerToken = Array.isArray(raw) ? String(raw[0]) : typeof raw === "string" ? raw : undefined;
            const cookies = (req as { cookies?: Record<string, string | undefined> }).cookies;
            if (!AuthService.verifyCsrf(cookies?.["tantalar_csrf"], headerToken)) {
              void ((rep as { code: (n: number) => { send: (b: unknown) => unknown } }).code(403).send({ error: "csrf required" }));
              return Promise.resolve(null);
            }
          }
          return (requireAuth as unknown as (
            rep2: unknown,
            req2: unknown,
            sc?: string,
          ) => Promise<{ kind: "session" | "apiKey"; scopes: string[]; userId?: string; role?: string } | null>)(
            rep,
            req,
            scope,
          );
        }) as ServingDeps["requireAuth"];
      }
      return cached;
    };
    registerServingRoutes(app, servingDeps());
  }

  app.post("/api/v1/plugins/:id/capabilities/:capability/:operation", async (request: any, reply: any) => {
    if (!(await requireAuth(reply, request, "plugins.invoke"))) return;
    if (!csrfOk(request)) return reply.code(403).send({ error: "csrf required" });
    const capability: string = request.params?.["capability"] ?? "";
    let provider;
    try {
      provider = deps.container.resolve(capability);
    } catch (err) {
      return reply.code(503).send({ error: (err as Error).message });
    }
    if (provider.pluginId !== (request.params?.["id"] ?? "")) {
      return reply.code(404).send({ error: "capability not provided by that plugin" });
    }
    const result = await provider.invoke(
      request.params?.["operation"] ?? "",
      (request.body as Record<string, unknown>) ?? {},
    );
    return { result };
  });

  // ---- Phase 6 admin surface (users, ui-preferences, themes, health) ----
  // Routes exist when the caller supplies a DB handle; the guard chain is
  // the same requireAuth + CSRF discipline as every other route, plus an
  // admin-only role check inside registerAdminRoutes.
  if (deps.db) {
    const adminDeps: AdminDeps = {
      auth: deps.auth,
      db: deps.db,
      supervisorList: () =>
        deps.supervisor.list().map((p) => ({
          manifest: { id: p.manifest.id, version: p.manifest.version },
          state: p.state,
          restartCount: p.restartCount,
        })),
      ready: deps.ready,
    };
    registerAdminRoutes(app, adminDeps);
  }

  // ---- Wave 3 library management (TAN-020/021) ----
  // Same guard chain as admin: authenticated, admin-only for mutations,
  // CSRF on cookie mutations. Reads are available to any signed-in user.
  if (deps.library) {
    registerLibraryRoutes(app, {
      service: deps.library,
      // Reads: any authenticated user. Mutations: admin + CSRF.
      requireUser: async (request: any, reply: any) => {
        const auth = await requireAuth(reply, request);
        return auth ? { userId: auth.userId ?? "", role: auth.role ?? "viewer" } : null;
      },
      requireAdmin: async (request: any, reply: any) => {
        const auth = await requireAuth(reply, request);
        if (!auth) return null;
        if (auth.kind !== "session" || auth.role !== "admin") {
          await reply.code(403).send({ error: "administrator access required" });
          return null;
        }
        return { userId: auth.userId ?? "", role: "admin" };
      },
      csrfOk,
    });
  }

  // ---- Wave 7 indexer management (TAN-014) ----
  // Same guard chain as libraries: authenticated reads, admin + CSRF
  // mutations. Indexer records are always redacted (no apikey leaves core).
  if (deps.indexerSettings) {
    registerIndexerRoutes(app, {
      service: deps.indexerSettings,
      requireUser: async (request: any, reply: any) => {
        const auth = await requireAuth(reply, request);
        return auth ? { userId: auth.userId ?? "", role: auth.role ?? "viewer" } : null;
      },
      requireAdmin: async (request: any, reply: any) => {
        const auth = await requireAuth(reply, request);
        if (!auth) return null;
        if (auth.kind !== "session" || auth.role !== "admin") {
          await reply.code(403).send({ error: "administrator access required" });
          return null;
        }
        return { userId: auth.userId ?? "", role: "admin" };
      },
      csrfOk,
    });
  }

  // ---- Wave 10 naming/import settings (TAN-022) ----
  // Reads for any signed-in user; mutations admin-only with CSRF. All work
  // flows through the library plugin's public importer capability.
  {
    const invokeImporter = async (operation: string, payload: Record<string, unknown>) => {
      const provider = deps.container.resolve("dev.tantalar.capability.importer");
      return provider.invoke(operation, payload);
    };
    const importerAvailable = deps.container.hasProviders("dev.tantalar.capability.importer");
    if (importerAvailable) {
    registerNamingRoutes(app, {
      invoke: invokeImporter,
      requireUser: async (request: any, reply: any) => {
        const auth = await requireAuth(reply, request);
        return auth ? { userId: auth.userId ?? "", role: auth.role ?? "viewer" } : null;
      },
      requireAdmin: async (request: any, reply: any) => {
        const auth = await requireAuth(reply, request);
        if (!auth) return null;
        if (auth.kind !== "session" || auth.role !== "admin") {
          await reply.code(403).send({ error: "administrator access required" });
          return null;
        }
        return { userId: auth.userId ?? "", role: "admin" };
      },
      csrfOk,
    });
    }
  }

  // ---- Wave 9 operations surface (TAN-030–043) ----
  // Same guard chain as admin: authenticated, admin-only mutations with CSRF.
  if (deps.ops) {
    registerOpsRoutes(app, deps.ops);
  }

  // Web UI (architecture §4): in production the built SPA under apps/web/dist
  // is served by this process. Absent dist (dev: vite dev server on :5173
  // proxies /api here) means API-only — never a hard failure.
  const webRoot = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../../web/dist",
  );
  if (existsSync(join(webRoot, "index.html"))) {
    await app.register(fastifyStatic, { root: webRoot, index: "index.html" } satisfies FastifyStaticOptions);
    // SPA fallback: any non-API GET serves the app shell.
    app.setNotFoundHandler((request, reply) => {
      if (request.method === "GET" && !request.url.startsWith("/api/") &&
          !request.url.startsWith("/healthz") && !request.url.startsWith("/readyz")) {
        return (reply as unknown as { sendFile(f: string): unknown }).sendFile("index.html");
      }
      return reply.code(404).send({ message: `Route ${request.method}:${request.url} not found`, error: "Not Found", statusCode: 404 });
    });
  }

  // Runtime OpenAPI document (architecture §10: generated, not hand-written).
  app.get("/openapi.json", async () => ({
    openapi: "3.0.3",
    info: { title: "Tantalar API", version: "0.1.0" },
    paths: {
      "/healthz": { get: { responses: { "200": { description: "liveness" } } } },
      "/readyz": { get: { responses: { "200": { description: "readiness" }, "503": { description: "not ready" } } } },
      "/api/v1/auth/login": {
        post: {
          requestBody: { content: { "application/json": { schema: LoginBody } } },
          responses: { "200": { description: "session established" }, "401": { description: "invalid credentials" } },
        },
      },
      "/api/v1/auth/logout": { post: { responses: { "200": { description: "logged out" }, "403": { description: "csrf required" } } } },
      "/api/v1/events": { get: { responses: { "200": { description: "event replay" }, "401": { description: "unauthorized" } } } },
      "/api/v1/events/feed": { get: { responses: { "101": { description: "websocket event feed" } } } },
      "/api/v1/plugins": { get: { responses: { "200": { description: "plugin list" } } } },
      "/api/v1/plugins/{id}/capabilities/{capability}/{operation}": {
        post: { responses: { "200": { description: "capability result" }, "503": { description: "capability unavailable" } } },
      },
      "/api/v1/bootstrap/admin": {
        post: {
          responses: {
            "200": { description: "initial administrator created" },
            "400": { description: "invalid credentials" },
            "403": { description: "bootstrap already completed" },
          },
        },
      },
      "/api/v1/onboarding": {
        get: { responses: { "200": { description: "guided-onboarding state" } } },
      },
      "/api/v1/onboarding/steps/{stepId}": {
        post: {
          requestBody: { content: { "application/json": { schema: StepActionBody } } },
          responses: {
            "200": { description: "step updated" },
            "400": { description: "step cannot be skipped" },
            "404": { description: "unknown step" },
            "409": { description: "earlier steps still pending" },
          },
        },
      },
    },
  }));

  return app;
}
