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
import { collectionPage, collectionFacets, mediaCollectionFields } from "./collection-page.js";
import { Type } from "@sinclair/typebox";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createMovieMetadataService } from "./movie-metadata.js";
import { mkdir, readFile, rename, rm, stat, statfs } from "node:fs/promises";
import { existsSync } from "node:fs";
import { freemem, loadavg, totalmem } from "node:os";
import { promisify } from "node:util";
import { getVersionMetadata } from "./version.js";
import { join, resolve } from "node:path";
import type { FastifyInstance } from "fastify";
import type { Kysely } from "kysely";
import { DownloadJobStore, ReleaseDecisionStore, PluginDocumentStore, humanReason, type Db } from "@tantalar/db";
import { uuidv7, EventTypes, validateDownloadRequest, validateDownloadStatus, type BrowserCapabilities, type DownloadJobRecord, type DownloadStatus, type PlaybackPolicy, type QualityProfile } from "@tantalar/contracts";
import { AuthService, type Role } from "./auth.js";
import type { Supervisor } from "./supervisor.js";
import type { ServiceContainer } from "./container.js";
import type { EventBus } from "./events.js";
import { GrabPipeline } from "./acquisition/pipeline.js";
import { listManagedWanted, normalizeQualityProfile, searchManagedReleases } from "./acquisition/managed-search.js";
import { releaseFingerprint } from "./acquisition/comparer.js";
import type { SecretStore } from "./secret-store.js";
import type { Scheduler } from "./scheduler.js";
import { registerJobRoutes } from "./job-routes.js";
import { refreshManagedMetadata } from "./managed-metadata-refresh.js";
import { QualitySettings, QualitySettingsBody, type QualityConfiguration } from "./quality-settings.js";
import { FileMaintenance } from "./file-maintenance.js";

export interface OpsDeps {
  library?: import("./library.js").LibraryService;
  auth: AuthService;
  db: Kysely<Db>;
  supervisor: Supervisor;
  container: ServiceContainer;
  bus: EventBus;
  ready?: () => boolean;
  readiness?: () => {
    ready: boolean;
    listening: boolean;
    missingCapabilities: string[];
  };
  /** SQLite database file path (backup/restore); absent on postgres. */
  sqlitePath?: string;
  /** Data directory used for backups and support bundles. */
  dataDir: string;
  secrets?: SecretStore;
  scheduler?: Scheduler;
  mcp?: {
    getDesiredConfig(): Record<string, unknown>;
    applyDesiredConfig(config: Record<string, unknown>): Promise<{
      state: string;
      restartCount: number;
      manifest: { id: string; version: string; provides: readonly string[] };
    }>;
  };
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
const MediaSearchQuery = Type.Object({
  query: Type.String({ minLength: 2, maxLength: 120 }),
  kind: Type.Optional(Type.Union([Type.Literal("movie"), Type.Literal("series"), Type.Literal("all")])),
});
const MetadataSettingsBody = Type.Object({
  apiKey: Type.String({ maxLength: 512, pattern: "^[^\\r\\n\\u0000]*$" }),
});
const ManagedMediaBody = Type.Object({
  kind: Type.Union([Type.Literal("movie"), Type.Literal("series")]),
  externalId: Type.String({ minLength: 1, maxLength: 200 }),
  provider: Type.String({ minLength: 1, maxLength: 80 }),
  title: Type.String({ minLength: 1, maxLength: 300 }),
  year: Type.Optional(Type.Union([Type.Integer({ minimum: 1800, maximum: 3000 }), Type.Null()])),
  overview: Type.Optional(Type.String({ maxLength: 5000 })),
  artworkUrl: Type.Optional(Type.String({ maxLength: 1000 })),
  availableAt: Type.Optional(Type.String({ maxLength: 32 })),
  monitored: Type.Optional(Type.Boolean()),
  destinationLibraryId: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  qualityProfile: Type.Optional(Type.Union([Type.Literal("any"), Type.Literal("hd"), Type.Literal("uhd")])),
  languages: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 40 }), { maxItems: 20 })),
  minimumAvailability: Type.Optional(Type.Union([Type.Literal("announced"), Type.Literal("in-cinemas"), Type.Literal("released")])),
  monitorMode: Type.Optional(Type.Union([Type.Literal("all"), Type.Literal("future"), Type.Literal("missing"), Type.Literal("none")])),
});
const ManagedMediaParams = Type.Object({
  kind: Type.Union([Type.Literal("movie"), Type.Literal("series")]),
  id: Type.String({ minLength: 1, maxLength: 300 }),
});
const ManagedMediaUpdateBody = Type.Object({
  title: Type.Optional(Type.String({ minLength: 1, maxLength: 300 })),
  year: Type.Optional(Type.Integer({ minimum: 1800, maximum: 3000 })),
  overview: Type.Optional(Type.Union([Type.String({ maxLength: 5000 }), Type.Null()])),
  artworkUrl: Type.Optional(Type.Union([Type.String({ maxLength: 1000 }), Type.Null()])),
  monitored: Type.Optional(Type.Boolean()),
  destinationLibraryId: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  qualityProfile: Type.Optional(Type.Union([Type.Literal("any"), Type.Literal("hd"), Type.Literal("uhd")])),
  languages: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 40 }), { maxItems: 20 })),
  minimumAvailability: Type.Optional(Type.Union([Type.Literal("announced"), Type.Literal("in-cinemas"), Type.Literal("released")])),
  monitorMode: Type.Optional(Type.Union([Type.Literal("all"), Type.Literal("future"), Type.Literal("missing"), Type.Literal("none")])),
});
const ManagedMediaMatchBody = Type.Object({
  fileId: Type.String({ minLength: 1, maxLength: 300 }),
  episodeKey: Type.Optional(Type.String({ pattern: "^S\\d{2,3}E\\d{2,4}$" })),
});
const GrabReleaseBody = Type.Object({
  query: Type.Optional(Type.String({ maxLength: 300 })),
  releaseId: Type.String({ pattern: "^[a-f0-9]{64}$" }),
  episodeKey: Type.Optional(Type.String({ pattern: "^S\\d{2,3}E\\d{2,4}$" })),
});
const ManagedReleaseQuery = Type.Object({
  query: Type.Optional(Type.String({ maxLength: 300 })),
  episodeKey: Type.Optional(Type.String({ pattern: "^S\\d{2,3}E\\d{2,4}$" })),
});

function managedQualityProfile(value: unknown, languages: readonly string[] = []): QualityProfile {
  const profile = value === "any"
    ? { name: "any", preferredQualities: [] }
    : value === "uhd"
      ? { name: "uhd", preferredQualities: ["2160p", "1080p"] }
      : { name: "hd", preferredQualities: ["1080p", "720p"] };
  const preferredLanguages = [...new Set(languages.map((language) => language.trim().toLowerCase()).filter(Boolean))];
  return { ...profile, ...(preferredLanguages.length > 0 ? { preferredLanguages } : {}) };
}
const LibraryAccessBody = Type.Object({
  libraryIds: Type.Array(Type.String(), { maxItems: 500 }),
});

function queueJobJson(j: DownloadJobRecord) {
  return {
    jobId: j.jobId,
    itemKey: j.itemKey,
    title: j.title,
    source: j.source,
    enginePluginId: j.providerPluginId,
    state: j.state,
    status: j.removed ? "removed" : j.state === "completed" ? j.importHandoffPath ? "imported" : "awaiting_import" : j.state,
    progressPercent: j.progressPercent,
    sizeBytes: j.sizeBytes,
    receivedBytes: j.receivedBytes,
    etaAt: j.etaAt,
    warnings: j.warnings,
    retryCount: j.retryCount,
    priority: j.priority,
    failureReason: j.failureReason ?? (!j.importHandoffPath ? j.warnings.findLast(warning => warning.startsWith("Import failed:")) ?? null : null),
    removed: j.removed,
    importHandoffPath: j.importHandoffPath,
    correlationId: j.correlationId,
    createdAt: j.createdAt,
    updatedAt: j.updatedAt,
  };
}
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
const McpConfigBody = Type.Object({
  http: Type.Object({
    enabled: Type.Boolean(),
    bind: Type.String({ minLength: 1, maxLength: 255 }),
    port: Type.Integer({ minimum: 1024, maximum: 65_535 }),
    tlsViaProxy: Type.Boolean(),
    clientEndpoint: Type.Optional(Type.String({ maxLength: 500 })),
  }, { additionalProperties: false }),
  mutatingToolsEnabled: Type.Boolean(),
  limits: Type.Object({
    timeoutMs: Type.Integer({ minimum: 1_000, maximum: 120_000 }),
    maxResultBytes: Type.Integer({ minimum: 4_096, maximum: 8_388_608 }),
    rateLimitPerMinute: Type.Integer({ minimum: 1, maximum: 10_000 }),
  }, { additionalProperties: false }),
}, { additionalProperties: false });
const McpTestBody = Type.Object({
  apiKey: Type.String({ minLength: 1, maxLength: 512 }),
}, { additionalProperties: false });
const ClientIncidentBody = Type.Object({
  kind: Type.Union([
    Type.Literal("window-error"),
    Type.Literal("unhandled-rejection"),
    Type.Literal("main-thread-stall"),
  ]),
  fingerprint: Type.String({ minLength: 1, maxLength: 128 }),
  message: Type.String({ minLength: 1, maxLength: 500 }),
  stack: Type.Optional(Type.String({ maxLength: 4_000 })),
  route: Type.String({ maxLength: 240 }),
  appVersion: Type.String({ maxLength: 80 }),
  occurredAt: Type.String({ maxLength: 48 }),
  durationMs: Type.Optional(Type.Integer({ minimum: 0, maximum: 120_000 })),
});
const PlaybackPolicyBody = Type.Object({
  preferDirectPlay: Type.Boolean(),
  localBitrateKbps: Type.Integer({ minimum: 500, maximum: 200_000 }),
  remoteBitrateKbps: Type.Integer({ minimum: 500, maximum: 200_000 }),
  maxConcurrentTranscodes: Type.Integer({ minimum: 1, maximum: 32 }),
  hardwareAcceleration: Type.String({ minLength: 2, maxLength: 32, pattern: "^[A-Za-z0-9_-]+$" }),
  defaultAudioLanguage: Type.String({ minLength: 2, maxLength: 8 }),
  defaultSubtitleLanguage: Type.String({ minLength: 2, maxLength: 8 }),
  subtitleMode: Type.Union([Type.Literal("manual"), Type.Literal("always"), Type.Literal("off")]),
  transcodeCacheMaxBytes: Type.Integer({ minimum: 268_435_456, maximum: 1_099_511_627_776 }),
  idleTimeoutMs: Type.Integer({ minimum: 10_000, maximum: 86_400_000 }),
});
const PlaybackPreviewBody = Type.Object({
  fileId: Type.String({ minLength: 1, maxLength: 200 }),
  network: Type.Optional(Type.Union([Type.Literal("local"), Type.Literal("remote")])),
  capabilities: Type.Object({
    canPlayContainers: Type.Array(Type.String(), { maxItems: 32 }),
    canPlayVideo: Type.Array(Type.String(), { maxItems: 32 }),
    canPlayAudio: Type.Array(Type.String(), { maxItems: 32 }),
    canDirectSubtitles: Type.Array(Type.String(), { maxItems: 32 }),
  }),
});

const execFileAsync = promisify(execFile);

async function probeFfmpeg() {
  try {
    const [{ stdout: versionOut }, { stdout: hardwareOut }, { stdout: encoderOut }] = await Promise.all([
      execFileAsync("ffmpeg", ["-hide_banner", "-version"], { timeout: 5_000, maxBuffer: 256_000 }),
      execFileAsync("ffmpeg", ["-hide_banner", "-hwaccels"], { timeout: 5_000, maxBuffer: 256_000 }),
      execFileAsync("ffmpeg", ["-hide_banner", "-encoders"], { timeout: 5_000, maxBuffer: 1_000_000 }),
    ]);
    const hardwareAcceleration = hardwareOut.split(/\r?\n/).map((line) => line.trim()).filter((line) => /^[a-z0-9_-]+$/i.test(line));
    const encoders = encoderOut.split(/\r?\n/).flatMap((line) => {
      const match = /^\s*[VAS]\S*\s+([a-z0-9_]+)/i.exec(line);
      return match?.[1] ? [match[1]] : [];
    });
    return {
      available: true,
      version: versionOut.split(/\r?\n/, 1)[0]?.slice(0, 200) ?? "FFmpeg",
      hardwareAcceleration,
      encoders: [...new Set(encoders)].slice(0, 200),
    };
  } catch {
    return { available: false, version: null, hardwareAcceleration: [] as string[], encoders: [] as string[] };
  }
}

function redactClientIncidentText(value: string, maxLength: number): string {
  return value
    .replace(/tantalar_[A-Za-z0-9_-]{10,}/g, "[REDACTED_API_KEY]")
    .replace(/([?&](?:api[_-]?key|authorization|cookie|password|secret|token)=)[^&#\s]+/gi, "$1[REDACTED]")
    .replace(/(password|token|cookie|authorization|secret)(["']?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,}]+)/gi, '$1$2"[REDACTED]"')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ")
    .slice(0, maxLength);
}

/** Known scope names the key UI offers; unknown scopes fail closed. */
export const KNOWN_API_KEY_SCOPES = [
  "events.read",
  "operations.read",
  "config.read",
  "plugins.read",
  "plugins.invoke",
  "queue.read",
  "queue.write",
] as const;

const MCP_PLUGIN_ID = "dev.tantalar.plugin.mcp";
const MCP_DEFAULT_CONFIG = {
  http: { enabled: true, bind: "127.0.0.1", port: 8642, tlsViaProxy: false },
  mutatingToolsEnabled: false,
  limits: { timeoutMs: 30_000, maxResultBytes: 1_048_576, rateLimitPerMinute: 120 },
};

interface McpConfig {
  http: {
    enabled: boolean;
    bind: string;
    port: number;
    tlsViaProxy: boolean;
    clientEndpoint?: string;
  };
  mutatingToolsEnabled: boolean;
  limits: { timeoutMs: number; maxResultBytes: number; rateLimitPerMinute: number };
}

function normalizeMcpConfig(value: unknown): McpConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw httpError("MCP configuration must be an object", 400);
  const input = value as Partial<McpConfig>;
  const http = input.http;
  const limits = input.limits;
  if (!http || !limits) throw httpError("MCP transport and limits are required", 400);
  const bind = String(http.bind ?? "").trim();
  if (!bind || !/^[A-Za-z0-9.:-]+$/.test(bind)) throw httpError("MCP bind address is invalid", 400);
  const port = Number(http.port);
  if (!Number.isInteger(port) || port < 1024 || port > 65_535) throw httpError("MCP port must be between 1024 and 65535", 400);
  const timeoutMs = Number(limits.timeoutMs);
  const maxResultBytes = Number(limits.maxResultBytes);
  const rateLimitPerMinute = Number(limits.rateLimitPerMinute);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 120_000) throw httpError("MCP timeout is outside the server bounds", 400);
  if (!Number.isInteger(maxResultBytes) || maxResultBytes < 4_096 || maxResultBytes > 8_388_608) throw httpError("MCP result limit is outside the server bounds", 400);
  if (!Number.isInteger(rateLimitPerMinute) || rateLimitPerMinute < 1 || rateLimitPerMinute > 10_000) throw httpError("MCP rate limit is outside the server bounds", 400);
  const loopback = bind === "127.0.0.1" || bind === "localhost" || bind === "::1";
  const clientEndpoint = String(http.clientEndpoint ?? "").trim();
  if (!loopback && http.tlsViaProxy !== true) throw httpError("Non-loopback MCP requires a trusted TLS reverse proxy", 400);
  if (!loopback && !clientEndpoint) throw httpError("Non-loopback MCP requires an HTTPS client endpoint", 400);
  if (clientEndpoint) {
    let endpoint: URL;
    try {
      endpoint = new URL(clientEndpoint);
    } catch {
      throw httpError("MCP client endpoint must be an absolute URL", 400);
    }
    if (!loopback && endpoint.protocol !== "https:") throw httpError("Non-loopback MCP client endpoint must use HTTPS", 400);
    if (loopback && endpoint.protocol !== "http:" && endpoint.protocol !== "https:") throw httpError("MCP client endpoint must use HTTP or HTTPS", 400);
  }
  return {
    http: {
      enabled: http.enabled !== false,
      bind,
      port,
      tlsViaProxy: http.tlsViaProxy === true,
      ...(clientEndpoint ? { clientEndpoint } : {}),
    },
    mutatingToolsEnabled: input.mutatingToolsEnabled === true,
    limits: { timeoutMs, maxResultBytes, rateLimitPerMinute },
  };
}

function mcpEndpoint(config: McpConfig): string | null {
  if (!config.http.enabled) return null;
  return config.http.clientEndpoint || `http://${config.http.bind === "::1" ? "[::1]" : config.http.bind}:${config.http.port}/`;
}

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

export function registerOpsRoutes(app: FastifyInstance, deps: OpsDeps, metadata = createMovieMetadataService(deps.container)): void {
  const db = deps.db;
  const qualitySettings = new QualitySettings(db);
  const titleTags = new PluginDocumentStore(db);
  const tagOwner = "dev.tantalar.core.media-tags";
  const readTags = async (kind: string, id: string): Promise<string[]> => {
    const value = (await titleTags.get(tagOwner, `${kind}:${id}`))?.doc;
    return Array.isArray(value) ? value.filter((tag): tag is string => typeof tag === "string") : [];
  };
  const recentClientIncidents = new Map<string, number>();

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

  app.post(
    "/api/v1/system/client-incidents",
    { schema: { body: ClientIncidentBody } },
    async (request: Req, reply: any) => {
      const admin = await requireAdmin(request, reply);
      if (!admin) return;
      const body = request.body as {
        kind: "window-error" | "unhandled-rejection" | "main-thread-stall";
        fingerprint: string;
        message: string;
        stack?: string;
        route: string;
        appVersion: string;
        occurredAt: string;
        durationMs?: number;
      };

      const now = Date.now();
      for (const [key, seenAt] of recentClientIncidents) {
        if (now - seenAt > 60_000) recentClientIncidents.delete(key);
      }
      const dedupeKey = `${admin.userId}:${body.kind}:${body.fingerprint}`;
      if (recentClientIncidents.has(dedupeKey)) {
        return { recorded: false, duplicate: true };
      }
      while (recentClientIncidents.size >= 200) {
        const oldest = recentClientIncidents.keys().next().value as string | undefined;
        if (!oldest) break;
        recentClientIncidents.delete(oldest);
      }
      recentClientIncidents.set(dedupeKey, now);

      const incidentId = uuidv7();
      await audit(admin, "client.incident.reported", "client-incident", incidentId, {
        kind: body.kind,
        fingerprint: redactClientIncidentText(body.fingerprint, 128),
        message: redactClientIncidentText(body.message, 500),
        ...(body.stack ? { stack: redactClientIncidentText(body.stack, 4_000) } : {}),
        route: redactClientIncidentText(body.route, 240),
        appVersion: redactClientIncidentText(body.appVersion, 80),
        clientOccurredAt: redactClientIncidentText(body.occurredAt, 48),
        ...(body.durationMs !== undefined ? { durationMs: body.durationMs } : {}),
      });
      return reply.code(201).send({ recorded: true, duplicate: false, incidentId });
    },
  );

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

  if (deps.scheduler) registerJobRoutes(app, deps.scheduler, requireAdmin, audit);
  if (deps.scheduler && deps.library) {
    const maintenance = new FileMaintenance(db, deps.library, deps.container, deps.scheduler, deps.bus);
    app.post("/api/v1/jobs/file-preview", { schema: { body: Type.Object({ libraryId: Type.String({ minLength: 1 }), kind: Type.Union([Type.Literal("rename"), Type.Literal("recycle")]), scheme: Type.Optional(Type.String({ maxLength: 120 })), page: Type.Optional(Type.Integer({ minimum: 1, maximum: 100000 })) }, { additionalProperties: false }) } }, async (request, reply) => {
      if (!await requireAdmin(request, reply)) return;
      const body = request.body as { libraryId: string; kind: "rename" | "recycle"; scheme?: string; page?: number };
      try { return await maintenance.preview(body.libraryId, body.kind, body.scheme, body.page); }
      catch (error) { return reply.code(409).send({ error: (error as Error).message }); }
    });
    app.post("/api/v1/jobs/file-apply", { schema: { body: Type.Object({ token: Type.String({ pattern: "^[a-f0-9-]{36}$" }) }, { additionalProperties: false }) } }, async (request, reply) => {
      const admin = await requireAdmin(request, reply);
      if (!admin) return;
      try {
        const runId = await maintenance.apply((request.body as { token: string }).token);
        await audit(admin, "file-maintenance.approved", "job-run", runId);
        return reply.code(202).send({ runId });
      } catch (error) { return reply.code(409).send({ error: (error as Error).message }); }
    });
  }
  app.get("/api/v1/quality", async (request, reply) => {
    if (!await requireAdmin(request, reply)) return;
    return qualitySettings.read();
  });
  app.put("/api/v1/quality", { schema: { body: QualitySettingsBody } }, async (request, reply) => {
    const admin = await requireAdmin(request, reply);
    if (!admin) return;
    try {
      await qualitySettings.save(request.body as QualityConfiguration);
      await audit(admin, "quality.updated", "quality", "settings");
      return { saved: true };
    } catch (error) { return reply.code((error as { statusCode?: number }).statusCode ?? 500).send({ error: (error as Error).message }); }
  });

  const jobs = new DownloadJobStore(db);
  const decisions = new ReleaseDecisionStore(db);
  const grabPipeline = new GrabPipeline({ bus: deps.bus, container: deps.container, jobs });
  const serving = () => deps.container.resolve("dev.tantalar.capability.serving");
  const metadataProvider = () => deps.container.resolve("dev.tantalar.capability.metadata-provider");
  const metadataSecretOwner = "dev.tantalar.plugin.metadata-tmdb-tvdb";
  const metadataSecretRef = "tmdb:api-key";
  const metadataFailure = (error: unknown) => {
    const code = error instanceof Error ? error.message.split(":")[0] : "unavailable";
    if (code === "unconfigured") return { status: 409, code, error: "Configure TMDB before searching titles." };
    if (code === "auth_failed") return { status: 422, code, error: "TMDB rejected the API key. Update it and retry." };
    if (code === "rate_limited") return { status: 503, code, error: "TMDB rate limit reached. Retry later." };
    return { status: 503, code: "unavailable", error: "TMDB is unavailable. Retry the connection." };
  };
  const moviesProvider = () => deps.container.resolve("dev.tantalar.capability.automation.movies");
  const seriesProvider = () => deps.container.resolve("dev.tantalar.capability.automation.series");
  const getManagedRecord = (kind: "movie" | "series", id: string) => kind === "movie"
    ? moviesProvider().invoke("get-movie", { movieId: id }) as Promise<Record<string, unknown>>
    : seriesProvider().invoke("get-series", { seriesId: id }) as Promise<Record<string, unknown>>;
  const validDestinationLibrary = async (kind: "movie" | "series", id: string): Promise<boolean> => {
    const library = await db.selectFrom("libraries").select(["kind", "enabled"]).where("id", "=", id).executeTakeFirst();
    return Boolean(library?.enabled && (library.kind === "mixed" || library.kind === kind));
  };
  const { safeArtworkSource, artworkSources, artworkPath, fetchArtwork, normalizeCandidate, publicMovieSnapshot, publicEpisode, episodeArtwork, resolveMovieSnapshot, artworkSource } = metadata;
  const managedEpisodes = (record: Record<string, unknown>) => Array.isArray(record.episodes) ? record.episodes.flatMap(value => {
    const episode = publicEpisode(value);
    const source = episode ? episodeArtwork(record, value as Record<string, unknown>) : null;
    return episode ? [{ ...episode, ...(source ? { artworkUrl: artworkPath(source) } : {}) }] : [];
  }) : [];
  app.get(
    "/api/v1/acquisition/artwork/:key",
    { schema: { params: Type.Object({ key: Type.String({ pattern: "^[a-f0-9]{64}$" }) }) } },
    async (request: Req, reply: any) => {
      if (!(await requireAdmin(request, reply))) return;
      const source = artworkSources.get(String((request.params as { key: string }).key));
      if (!source) return reply.code(404).send({ error: "artwork not found" });
      try {
        const image = await fetchArtwork(source);
        return reply.header("content-type", image.contentType).header("cache-control", "private, max-age=3600").send(image.body);
      } catch {
        return reply.code(404).send({ error: "artwork unavailable" });
      }
    },
  );

  app.get(
    "/api/v1/acquisition/metadata",
    async (request: Req, reply: any) => {
      if (!(await requireAdmin(request, reply))) return;
      try {
        const status = await metadataProvider().invoke("status", {}) as Record<string, unknown>;
        return {
          provider: "tmdb",
          state: status.state,
          configured: status.configured === true,
          mode: status.mode === "direct" || status.mode === "fixture" ? status.mode : "hosted",
          directKeyConfigured: status.directKeyConfigured === true,
          locale: typeof status.locale === "string" ? status.locale : "en-US",
          ...(status.lastError && typeof status.lastError === "object"
            ? { lastError: { code: String((status.lastError as Record<string, unknown>).code ?? "unavailable") } }
            : {}),
        };
      } catch {
        return reply.code(503).send({ code: "unavailable", error: "TMDB provider is unavailable." });
      }
    },
  );

  app.put(
    "/api/v1/acquisition/metadata",
    { schema: { body: MetadataSettingsBody } },
    async (request: Req, reply: any) => {
      const admin = await requireAdmin(request, reply);
      if (!admin) return;
      if (!deps.secrets) return reply.code(503).send({ code: "unavailable", error: "The server secret store is unavailable." });
      const apiKey = String((request.body as { apiKey: string }).apiKey).trim();
      const previous = await deps.secrets.get(metadataSecretOwner, metadataSecretRef);
      if (apiKey) await deps.secrets.set(metadataSecretOwner, metadataSecretRef, apiKey);
      else await deps.secrets.delete(metadataSecretOwner, metadataSecretRef);
      try {
        const status = await metadataProvider().invoke("configure", {}) as Record<string, unknown>;
        await audit(admin, apiKey ? "metadata.tmdb.configured" : "metadata.tmdb.direct-key-cleared", "plugin", metadataSecretOwner, {
          state: String(status.state ?? "ready"),
        });
        return {
          provider: "tmdb",
          state: status.state,
          mode: status.mode === "direct" || status.mode === "fixture" ? status.mode : "hosted",
          configured: true,
          directKeyConfigured: status.directKeyConfigured === true,
        };
      } catch (error) {
        if (previous === null) await deps.secrets.delete(metadataSecretOwner, metadataSecretRef);
        else await deps.secrets.set(metadataSecretOwner, metadataSecretRef, previous);
        await metadataProvider().invoke("configure", {}).catch(() => undefined);
        const failure = metadataFailure(error);
        return reply.code(failure.status).send({ code: failure.code, error: failure.error, rolledBack: true });
      }
    },
  );

  app.get(
    "/api/v1/acquisition/search",
    { schema: { querystring: MediaSearchQuery } },
    async (request: Req, reply: any) => {
      if (!(await requireAdmin(request, reply))) return;
      const query = String(request.query?.query ?? "").trim();
      const kinds = request.query?.kind === "movie" || request.query?.kind === "series"
        ? [request.query.kind] as const
        : ["movie", "series"] as const;
      try {
        const responses = await Promise.all(kinds.map((kind) => metadataProvider().invoke("search", { kind, query, limit: 10 })));
        const candidates = responses
          .flatMap((response) => {
            const rows = (response as { candidates?: unknown[] } | null)?.candidates;
            return Array.isArray(rows) ? rows : [];
          })
          .map(normalizeCandidate)
          .filter((candidate): candidate is NonNullable<ReturnType<typeof normalizeCandidate>> => candidate !== null);
        return { candidates: await Promise.all(candidates.map(async (candidate) => {
          const snapshot = await resolveMovieSnapshot(candidate).catch(() => null);
          if (!snapshot) return candidate;
          const poster = artworkSource({}, snapshot, "poster");
          const backdrop = artworkSource({}, snapshot, "backdrop");
          return {
            ...candidate,
            title: snapshot.name,
            year: snapshot.year,
            overview: snapshot.overview,
            ...(poster ? { artworkUrl: artworkPath(poster) } : {}),
            ...(backdrop ? { backdropUrl: artworkPath(backdrop) } : {}),
            metadataSnapshot: publicMovieSnapshot(snapshot),
          };
        })) };
      } catch (error) {
        const failure = metadataFailure(error);
        return reply.code(failure.status).send({ code: failure.code, error: failure.error });
      }
    },
  );

  app.get("/api/v1/acquisition/managed", async (request: Req, reply: any) => {
    if (!(await requireAdmin(request, reply))) return;
    try {
      const [movieResponse, seriesResponse] = await Promise.all([
        moviesProvider().invoke("list-movies", {}),
        seriesProvider().invoke("list-series", {}),
      ]);
      const movies = (movieResponse as { movies?: Array<Record<string, unknown>> } | null)?.movies ?? [];
      const series = (seriesResponse as { series?: Array<Record<string, unknown>> } | null)?.series ?? [];
      const movieItems = await Promise.all(movies.map(async (item) => ({
        item,
        tags: await readTags("movie", String(item.movieId)),
        snapshot: await resolveMovieSnapshot(item).catch(() => null),
      })));
      const seriesItems = await Promise.all(series.map(async item => ({
        item, tags: await readTags("series", String(item.seriesId)),
        snapshot: await resolveMovieSnapshot({ ...item, kind: "series" }).catch(() => null),
      })));
      const localFiles = await db.selectFrom("media_catalog").select("itemKey").execute();
      const fileCounts = new Map<string, number>();
      for (const file of localFiles) {
        const key = file.itemKey.split(":")[0]!;
        fileCounts.set(key, (fileCounts.get(key) ?? 0) + 1);
      }
      const result = {
        items: [
          ...movieItems.map(({ item, snapshot, tags }) => ({
            tags,
            id: String(item.movieId ?? ""),
            localFileCount: fileCounts.get(String(item.movieId)) ?? 0,
            title: String(item.title ?? "").slice(0, 300),
            kind: "movie" as const,
            monitored: item.monitored === true,
            ...(typeof item.year === "number" ? { year: Math.trunc(item.year) } : {}),
            ...(typeof item.provider === "string" ? { provider: item.provider.slice(0, 80) } : {}),
            ...(typeof item.externalId === "string" ? { externalId: item.externalId.slice(0, 200) } : {}),
            ...(typeof item.overview === "string" ? { overview: item.overview.slice(0, 5000) } : {}),
            ...(artworkSource(item, snapshot, "poster") ? { artworkUrl: `/api/v1/acquisition/managed/movie/${encodeURIComponent(String(item.movieId ?? ""))}/artwork` } : {}),
            manualFields: Array.isArray(item.manualFields) ? item.manualFields.map(String) : [],
            ...(typeof item.acquisitionState === "string" ? { acquisitionState: item.acquisitionState.slice(0, 40) } : {}),
            ...(typeof item.destinationLibraryId === "string" ? { destinationLibraryId: item.destinationLibraryId.slice(0, 200) } : {}),
            ...(typeof item.minimumAvailability === "string" ? { minimumAvailability: item.minimumAvailability.slice(0, 40) } : {}),
            ...(typeof item.availableAt === "string" ? { availableAt: item.availableAt.slice(0, 32) } : {}),
            preferredLanguages: normalizeQualityProfile(item.profile).preferredLanguages ?? [],
            ...(item.profile && typeof item.profile === "object" && typeof (item.profile as Record<string, unknown>).name === "string"
              ? { qualityProfile: String((item.profile as Record<string, unknown>).name).slice(0, 40) }
              : {}),
            ...(snapshot ? { metadataSnapshot: publicMovieSnapshot(snapshot) } : {}),
            ...(artworkSource(item, snapshot, "backdrop") ? { backdropUrl: `/api/v1/acquisition/managed/movie/${encodeURIComponent(String(item.movieId ?? ""))}/artwork?variant=backdrop` } : {}),
          })),
          ...seriesItems.map(({ item, snapshot, tags }) => ({
            tags,
            id: String(item.seriesId ?? ""),
            localFileCount: fileCounts.get(String(item.seriesId)) ?? 0,
            title: String(item.name ?? "").slice(0, 300),
            kind: "series" as const,
            monitored: item.monitored === true,
            ...(typeof item.year === "number" ? { year: Math.trunc(item.year) } : {}),
            ...(typeof item.provider === "string" ? { provider: item.provider.slice(0, 80) } : {}),
            ...(typeof item.externalId === "string" ? { externalId: item.externalId.slice(0, 200) } : {}),
            ...(typeof item.overview === "string" ? { overview: item.overview.slice(0, 5000) } : {}),
            ...(artworkSource(item, snapshot, "poster") ? { artworkUrl: `/api/v1/acquisition/managed/series/${encodeURIComponent(String(item.seriesId ?? ""))}/artwork` } : {}),
            ...(snapshot ? { metadataSnapshot: publicMovieSnapshot(snapshot) } : {}),
            ...(artworkSource(item, snapshot, "backdrop") ? { backdropUrl: `/api/v1/acquisition/managed/series/${encodeURIComponent(String(item.seriesId ?? ""))}/artwork?variant=backdrop` } : {}),
            manualFields: Array.isArray(item.manualFields) ? item.manualFields.map(String) : [],
            ...(typeof item.acquiredEpisodeCount === "number" ? { acquiredEpisodeCount: Math.max(0, Math.trunc(item.acquiredEpisodeCount)) } : {}),
            ...(typeof item.episodeCount === "number" ? { episodeCount: Math.max(0, Math.trunc(item.episodeCount)) } : {}),
            ...(typeof item.acquisitionState === "string" ? { acquisitionState: item.acquisitionState.slice(0, 40) } : {}),
            ...(typeof item.destinationLibraryId === "string" ? { destinationLibraryId: item.destinationLibraryId.slice(0, 200) } : {}),
            ...(typeof item.minimumAvailability === "string" ? { minimumAvailability: item.minimumAvailability.slice(0, 40) } : {}),
            ...(typeof item.monitorMode === "string" ? { monitorMode: item.monitorMode.slice(0, 40) } : {}),
            preferredLanguages: normalizeQualityProfile(item.profile).preferredLanguages ?? [],
            ...(item.profile && typeof item.profile === "object" && typeof (item.profile as Record<string, unknown>).name === "string"
              ? { qualityProfile: String((item.profile as Record<string, unknown>).name).slice(0, 40) }
              : {}),
          })),
        ].filter((item) => item.id && item.title),
      };
      const query = (request.query ?? {}) as Record<string, unknown>;
      if (query.explorer !== "1") return result;
      return {
        ...collectionPage(result.items, query, {
          ...mediaCollectionFields,
          tags: item => item.tags, qualityProfile: item => item.qualityProfile,
          localFileCount: item => item.localFileCount,
          acquisitionState: item => item.acquisitionState ?? (item.monitored ? "wanted" : "unmonitored"),
        }),
        facets: collectionFacets(result.items, { ...mediaCollectionFields, acquisitionState: item => item.acquisitionState ?? (item.monitored ? "wanted" : "unmonitored") }),
        tags: [...new Set(result.items.flatMap(item => item.tags))].sort(),
      };
    } catch {
      return reply.code(503).send({ error: "Managed media is unavailable." });
    }
  });

  app.get(
    "/api/v1/acquisition/managed/:kind/:id",
    { schema: { params: ManagedMediaParams } },
    async (request: Req, reply: any) => {
      if (!(await requireAdmin(request, reply))) return;
      const { kind, id } = request.params as { kind: "movie" | "series"; id: string };
      try {
        const [record, files] = await Promise.all([
          getManagedRecord(kind, id),
          (kind === "movie"
            ? db.selectFrom("media_catalog").selectAll().where("itemKey", "=", id)
            : db.selectFrom("media_catalog").selectAll().where("itemKey", "like", `${id}:%`)
          ).execute(),
        ]);
        const snapshot = await resolveMovieSnapshot({ ...record, kind }).catch(() => null);
        return {
          item: {
            id,
            kind,
            title: String((kind === "movie" ? record.title : record.name) ?? "").slice(0, 300),
            tags: await readTags(kind, id),
            ...(typeof record.year === "number" ? { year: Math.trunc(record.year) } : {}),
            monitored: record.monitored === true,
            ...(typeof record.overview === "string" ? { overview: record.overview.slice(0, 5000) } : {}),
            ...(artworkSource(record, snapshot, "poster") ? { artworkUrl: `/api/v1/acquisition/managed/${kind}/${encodeURIComponent(id)}/artwork` } : {}),
            ...(typeof record.provider === "string" ? { provider: record.provider.slice(0, 80) } : {}),
            ...(typeof record.externalId === "string" ? { externalId: record.externalId.slice(0, 200) } : {}),
            ...(typeof record.destinationLibraryId === "string" ? { destinationLibraryId: record.destinationLibraryId.slice(0, 200) } : {}),
            ...(typeof record.minimumAvailability === "string" ? { minimumAvailability: record.minimumAvailability.slice(0, 40) } : {}),
            ...(typeof record.availableAt === "string" ? { availableAt: record.availableAt.slice(0, 32) } : {}),
            preferredLanguages: normalizeQualityProfile(record.profile).preferredLanguages ?? [],
            ...(typeof record.monitorMode === "string" ? { monitorMode: record.monitorMode.slice(0, 40) } : {}),
            qualityProfile: normalizeQualityProfile(record.profile).name,
            manualFields: Array.isArray(record.manualFields) ? record.manualFields.map(String) : [],
            ...(snapshot ? { metadataSnapshot: publicMovieSnapshot(snapshot) } : {}),
            ...(artworkSource(record, snapshot, "backdrop") ? { backdropUrl: `/api/v1/acquisition/managed/${kind}/${encodeURIComponent(id)}/artwork?variant=backdrop` } : {}),
            episodes: managedEpisodes(record),
          },
          files: files.map((file) => ({
            fileId: file.fileId,
            libraryId: file.libraryId,
            itemKey: file.itemKey,
            path: file.path,
            quality: file.quality,
          })),
        };
      } catch {
        return reply.code(404).send({ error: "Managed item not found." });
      }
    },
  );

  app.get(
    "/api/v1/acquisition/managed/:kind/:id/artwork",
    { schema: { params: ManagedMediaParams, querystring: Type.Object({ variant: Type.Optional(Type.Union([Type.Literal("poster"), Type.Literal("backdrop")])) }) } },
    async (request: Req, reply: any) => {
      if (!(await requireAdmin(request, reply))) return;
      const { kind, id } = request.params as { kind: "movie" | "series"; id: string };
      try {
        const record = await getManagedRecord(kind, id);
        const snapshot = await resolveMovieSnapshot({ ...record, kind }).catch(() => null);
        const source = artworkSource(record, snapshot, request.query?.variant === "backdrop" ? "backdrop" : "poster");
        if (!source) return reply.code(404).send({ error: "artwork not found" });
        const image = await fetchArtwork(source);
        return reply.header("content-type", image.contentType).header("cache-control", "private, max-age=3600").send(image.body);
      } catch {
        return reply.code(404).send({ error: "artwork unavailable" });
      }
    },
  );

  app.post(
    "/api/v1/acquisition/managed",
    { schema: { body: ManagedMediaBody } },
    async (request: Req, reply: any) => {
      const admin = await requireAdmin(request, reply);
      if (!admin) return;
      const body = request.body as {
        kind: "movie" | "series";
        externalId: string;
        provider: string;
        title: string;
        year?: number | null;
        overview?: string;
        artworkUrl?: string;
        availableAt?: string;
        monitored?: boolean;
        destinationLibraryId?: string;
        qualityProfile?: "any" | "hd" | "uhd";
        languages?: string[];
        minimumAvailability?: "announced" | "in-cinemas" | "released";
        monitorMode?: "all" | "future" | "missing" | "none";
      };
      try {
        if (body.destinationLibraryId && !(await validDestinationLibrary(body.kind, body.destinationLibraryId))) {
          return reply.code(400).send({ error: "Choose an enabled library that accepts this media type." });
        }
        const quality = managedQualityProfile(body.qualityProfile ?? (body.kind === "movie" ? "uhd" : "hd"), body.languages);
        const snapshot = body.kind === "movie"
          ? await resolveMovieSnapshot({ externalId: body.externalId, provider: body.provider, title: body.title })
          : null;
        if (body.kind === "movie" && !snapshot) {
          return reply.code(409).send({ error: "Canonical movie metadata is unavailable; the title was not added." });
        }
        const artworkKey = /^\/api\/v1\/acquisition\/artwork\/([a-f0-9]{64})$/.exec(body.artworkUrl ?? "")?.[1];
        const artworkSource = snapshot?.artworkUrl ?? (artworkKey ? artworkSources.get(artworkKey) : safeArtworkSource(body.artworkUrl));
        const payload = {
          externalId: body.externalId,
          provider: body.provider,
          ...(typeof (snapshot?.year ?? body.year) === "number" ? { year: snapshot?.year ?? body.year } : {}),
          ...((snapshot?.overview ?? body.overview) !== undefined ? { overview: snapshot?.overview ?? body.overview } : {}),
          ...(artworkSource ? { artworkUrl: artworkSource } : {}),
          ...((snapshot?.releaseDate ?? body.availableAt) ? { availableAt: snapshot?.releaseDate ?? body.availableAt } : {}),
          ...(body.destinationLibraryId ? { destinationLibraryId: body.destinationLibraryId } : {}),
          minimumAvailability: body.minimumAvailability ?? "released",
          profile: quality,
          monitored: body.kind === "series" ? body.monitorMode !== "none" : body.monitored !== false,
          ...(body.kind === "series" ? { monitorMode: body.monitorMode ?? "all" } : {}),
        };
        let result: unknown;
        if (body.kind === "movie") {
          result = await moviesProvider().invoke("add-movie", { ...payload, title: snapshot!.name });
        } else {
          const details = await metadataProvider().invoke("details", {
            kind: "series",
            externalId: body.externalId,
            name: body.title,
          });
          const episodes = (details as { episodes?: unknown[] } | null)?.episodes;
          if (!Array.isArray(episodes) || episodes.length === 0) {
            return reply.code(409).send({ error: "Series episode metadata is unavailable; the title was not added." });
          }
          result = await seriesProvider().invoke("add-series", { ...payload, name: body.title, episodes });
        }
        const created = (result as { created?: unknown } | null)?.created === true;
        const id = String(
          body.kind === "movie"
            ? (result as { movieId?: unknown } | null)?.movieId ?? ""
            : (result as { seriesId?: unknown } | null)?.seriesId ?? "",
        );
        if (!id) throw new Error("managed media provider returned no id");
        await audit(admin, created ? "managed-media.added" : "managed-media.existing", body.kind, id, {
          provider: body.provider,
          externalId: body.externalId,
        });
        reply.code(created ? 201 : 200);
        return {
          item: {
            id,
            kind: body.kind,
            title: snapshot?.name ?? body.title,
            monitored: body.kind === "series" ? body.monitorMode !== "none" : body.monitored !== false,
            ...(body.destinationLibraryId ? { destinationLibraryId: body.destinationLibraryId } : {}),
            qualityProfile: quality.name,
            preferredLanguages: quality.preferredLanguages ?? [],
            minimumAvailability: body.minimumAvailability ?? "released",
            ...(body.kind === "series" ? { monitorMode: body.monitorMode ?? "all" } : {}),
          },
          created,
        };
      } catch {
        return reply.code(503).send({ error: "Managed media could not be saved." });
      }
    },
  );

  app.patch(
    "/api/v1/acquisition/managed/:kind/:id",
    { schema: { params: ManagedMediaParams, body: ManagedMediaUpdateBody } },
    async (request: Req, reply: any) => {
      const admin = await requireAdmin(request, reply);
      if (!admin) return;
      const { kind, id } = request.params as { kind: "movie" | "series"; id: string };
      const body = request.body as {
        title?: string;
        year?: number;
        overview?: string | null;
        artworkUrl?: string | null;
        monitored?: boolean;
        destinationLibraryId?: string;
        qualityProfile?: "any" | "hd" | "uhd";
        languages?: string[];
        minimumAvailability?: "announced" | "in-cinemas" | "released";
        monitorMode?: "all" | "future" | "missing" | "none";
      };
      try {
        if (body.destinationLibraryId && !(await validDestinationLibrary(kind, body.destinationLibraryId))) {
          return reply.code(400).send({ error: "Choose an enabled library that accepts this media type." });
        }
        const current = await getManagedRecord(kind, id);
        const currentProfile = normalizeQualityProfile(current.profile);
        const manualFields = new Set(Array.isArray(current.manualFields) ? current.manualFields.map(String) : []);
        for (const field of ["title", "year", "overview", "artworkUrl"] as const) {
          if (Object.prototype.hasOwnProperty.call(body, field)) manualFields.add(field);
        }
        let artworkUrl: string | null | undefined;
        if (body.artworkUrl === null) artworkUrl = null;
        else if (body.artworkUrl !== undefined) {
          artworkUrl = safeArtworkSource(body.artworkUrl);
          if (!artworkUrl) return reply.code(400).send({ error: "Artwork must use the supported HTTPS image host." });
        }
        const payload = {
          ...(kind === "movie" ? { movieId: id } : { seriesId: id }),
          ...(body.title !== undefined ? (kind === "movie" ? { title: body.title } : { name: body.title }) : {}),
          ...(body.year !== undefined ? { year: body.year } : {}),
          ...(body.overview !== undefined ? { overview: body.overview } : {}),
          ...(artworkUrl !== undefined ? { artworkUrl } : {}),
          ...(body.monitored !== undefined ? { monitored: body.monitored } : {}),
          ...(body.destinationLibraryId !== undefined ? { destinationLibraryId: body.destinationLibraryId } : {}),
          ...(body.qualityProfile !== undefined || body.languages !== undefined
            ? { profile: managedQualityProfile(body.qualityProfile ?? currentProfile.name, body.languages ?? currentProfile.preferredLanguages) }
            : {}),
          ...(body.minimumAvailability !== undefined ? { minimumAvailability: body.minimumAvailability } : {}),
          ...(body.monitorMode !== undefined ? { monitorMode: body.monitorMode } : {}),
          manualFields: [...manualFields],
        };
        await (kind === "movie" ? moviesProvider() : seriesProvider()).invoke(kind === "movie" ? "update-movie" : "update-series", payload);
        await audit(admin, "managed-media.updated", kind, id, { fields: Object.keys(body) });
        return { updated: true };
      } catch (error) {
        return reply.code(String((error as Error).message).startsWith("unknown ") ? 404 : 503).send({ error: "Managed media could not be updated." });
      }
    },
  );

  app.get("/api/v1/acquisition/managed/series/:id/episodes", async (request: Req, reply: any) => {
    if (!(await requireAdmin(request, reply))) return;
    try {
      const record = await getManagedRecord("series", String((request.params as { id: string }).id));
      const episodes = managedEpisodes(record);
      const fields = { title: (episode: typeof episodes[number]) => episode.title, episodeKey: (episode: typeof episodes[number]) => episode.episodeKey, airDate: (episode: typeof episodes[number]) => episode.airDate, runtimeMinutes: (episode: typeof episodes[number]) => episode.runtimeMinutes, season: (episode: typeof episodes[number]) => String(Number(/^S(\d+)/.exec(episode.episodeKey)?.[1])) };
      return { ...collectionPage(episodes, request.query as Record<string, unknown>, fields), facets: collectionFacets(episodes, { season: fields.season }) };
    } catch { return reply.code(404).send({ error: "Series episodes are unavailable." }); }
  });

  app.post(
    "/api/v1/acquisition/managed/:kind/:id/refresh",
    { schema: { params: ManagedMediaParams, body: Type.Object({ reviewToken: Type.Optional(Type.String({ pattern: "^[a-f0-9]{64}$" })) }, { additionalProperties: false }) } },
    async (request: Req, reply: any) => {
      const admin = await requireAdmin(request, reply);
      if (!admin) return;
      const { kind, id } = request.params as { kind: "movie" | "series"; id: string };
      try {
        const { provider, externalId } = await refreshManagedMetadata(deps.container, kind, id, (request.body as { reviewToken?: string } | undefined)?.reviewToken);
        await audit(admin, "managed-media.refreshed", kind, id, { provider, externalId });
        return { refreshed: true };
      } catch (error) {
        const known = error as { statusCode?: number; message?: string; review?: unknown };
        return reply.code(known.statusCode ?? 503).send({ error: known.statusCode ? known.message : "Metadata refresh is unavailable; existing metadata was kept.", ...(known.review ? { review: known.review } : {}) });
      }
    },
  );

  app.post(
    "/api/v1/acquisition/managed/:kind/:id/match",
    { schema: { params: ManagedMediaParams, body: ManagedMediaMatchBody } },
    async (request: Req, reply: any) => {
      const admin = await requireAdmin(request, reply);
      if (!admin) return;
      const { kind, id } = request.params as { kind: "movie" | "series"; id: string };
      const { fileId, episodeKey } = request.body as { fileId: string; episodeKey?: string };
      try {
        const [record, file] = await Promise.all([
          getManagedRecord(kind, id),
          db.selectFrom("media_catalog").selectAll().where("fileId", "=", fileId).executeTakeFirst(),
        ]);
        if (!file) return reply.code(404).send({ error: "Catalog file not found." });
        if (typeof record.destinationLibraryId === "string" && record.destinationLibraryId !== file.libraryId) {
          return reply.code(409).send({ error: "The file is outside this item's destination library." });
        }
        if (kind === "series" && !episodeKey) return reply.code(400).send({ error: "Choose the episode this file satisfies." });
        const itemKey = kind === "series" ? `${id}:${episodeKey}` : id;
        await (kind === "movie" ? moviesProvider() : seriesProvider()).invoke("mark-acquired", kind === "movie"
          ? { movieId: id, guid: `file:${fileId}` }
          : { seriesId: id, episodeKey });
        await db.updateTable("media_catalog").set({ itemKey, updatedAt: new Date().toISOString() }).where("fileId", "=", fileId).execute();
        await deps.library?.refreshCatalogEntry(fileId);
        await audit(admin, "managed-media.file.matched", kind, id, { fileId, ...(episodeKey ? { episodeKey } : {}) });
        return { matched: true, itemKey };
      } catch (error) {
        return reply.code(String((error as Error).message).startsWith("unknown ") ? 404 : 503).send({ error: "The catalog file could not be matched." });
      }
    },
  );

  app.put("/api/v1/acquisition/managed/:kind/:id/tags", {
    schema: { params: ManagedMediaParams, body: Type.Object({ tags: Type.Array(Type.String({ minLength: 1, maxLength: 40 }), { maxItems: 30 }) }, { additionalProperties: false }) },
  }, async (request: Req, reply: any) => {
    const admin = await requireAdmin(request, reply);
    if (!admin) return;
    const { kind, id } = request.params as { kind: "movie" | "series"; id: string };
    try { await getManagedRecord(kind, id); } catch { return reply.code(404).send({ error: "Managed title not found." }); }
    const tags = [...new Set((request.body as { tags: string[] }).tags.map(tag => tag.trim().toLowerCase()).filter(Boolean))].sort();
    await titleTags.put(tagOwner, `${kind}:${id}`, tags);
    await audit(admin, "managed-media.tags.updated", kind, id, { tags });
    return { tags };
  });

  app.delete(
    "/api/v1/acquisition/managed/:kind/:id",
    { schema: { params: ManagedMediaParams } },
    async (request: Req, reply: any) => {
      const admin = await requireAdmin(request, reply);
      if (!admin) return;
      const { kind, id } = request.params as { kind: "movie" | "series"; id: string };
      const provider = kind === "movie" ? moviesProvider() : seriesProvider();
      const result = await provider.invoke(kind === "movie" ? "delete-movie" : "delete-series", kind === "movie" ? { movieId: id } : { seriesId: id }) as { deleted?: boolean };
      if (!result.deleted) return reply.code(404).send({ error: "Managed item not found." });
      await audit(admin, "managed-media.deleted", kind, id, { filesDeleted: false });
      return reply.code(204).send();
    },
  );

  app.get("/api/v1/acquisition/wanted", async (request: Req, reply: any) => {
    if (!(await requireAdmin(request, reply))) return;
    try {
      const [wanted, queue] = await Promise.all([listManagedWanted(deps.container), jobs.list()]);
      const jobByItemKey = new Map<string, DownloadJobRecord>();
      for (const job of queue) jobByItemKey.set(job.itemKey, job);
      return {
        items: wanted.map((item) => {
          const job = jobByItemKey.get(item.itemKey);
          const recovery = !job
            ? { action: "search" as const, label: "Search releases" }
            : job.state === "paused"
              ? { action: "resume" as const, label: "Resume", jobId: job.jobId }
              : job.state === "failed"
                ? { action: "retry" as const, label: "Retry", jobId: job.jobId }
                : job.state === "cancelled"
                  ? { action: "remove" as const, label: "Remove", jobId: job.jobId }
                  : null;
          return {
            itemKey: item.itemKey,
            kind: item.kind,
            id: item.id,
            ...(item.episodeKey ? { episodeKey: item.episodeKey } : {}),
            title: item.query,
            state: job?.state ?? "missing",
            failureDetail: job?.failureReason ?? null,
            recovery,
          };
        }),
      };
    } catch {
      return reply.code(503).send({ error: "Wanted ledger is unavailable." });
    }
  });

  const runManagedReleaseSearch = (kind: "movie" | "series", id: string, episodeKey?: string, query?: string) =>
    searchManagedReleases(deps.container, decisions, kind, id, "interactive", episodeKey, deps.bus, query, undefined, qualitySettings);

  app.get(
    "/api/v1/acquisition/managed/:kind/:id/releases",
    { schema: { params: ManagedMediaParams, querystring: ManagedReleaseQuery } },
    async (request: Req, reply: any) => {
      if (!(await requireAdmin(request, reply))) return;
      const params = request.params as { kind: "movie" | "series"; id: string };
      const query = request.query as { episodeKey?: string; query?: string };
      try {
        const result = await runManagedReleaseSearch(params.kind, params.id, query.episodeKey, query.query);
        const assessments = new Map((result.verdict.assessments ?? []).map((assessment) => [assessment.guid, assessment]));
        const rank = new Map(result.verdict.rankedGuids.map((guid, index) => [guid, index]));
        return {
          item: { id: params.id, kind: params.kind, title: result.context.title, itemKey: result.context.itemKey },
          releases: result.candidates
            .map((candidate) => ({
              releaseId: releaseFingerprint(candidate),
              title: candidate.release.title,
              kind: candidate.release.kind,
              sizeBytes: candidate.release.sizeBytes,
              publishedAt: candidate.release.publishedAt,
              indexerId: candidate.release.indexerId,
              ...(candidate.release.seeders !== undefined ? { seeders: candidate.release.seeders } : {}),
              ...(candidate.release.language ? { language: candidate.release.language } : {}),
              quality: candidate.quality,
              accepted: assessments.get(candidate.release.guid)?.accepted ?? false,
              reasons: (assessments.get(candidate.release.guid)?.reasons ?? []).map((code) => ({
                code,
                message: humanReason(code, { quality: candidate.quality }),
              })),
              rank: rank.get(candidate.release.guid) ?? null,
            }))
            .sort((a, b) => (a.rank ?? Number.MAX_SAFE_INTEGER) - (b.rank ?? Number.MAX_SAFE_INTEGER)),
          failures: result.failures,
        };
      } catch (error) {
        const statusCode = typeof (error as { statusCode?: unknown }).statusCode === "number"
          ? Number((error as { statusCode: number }).statusCode)
          : 503;
        return reply.code(statusCode).send({ error: statusCode < 500 ? (error as Error).message : "Release search is unavailable." });
      }
    },
  );

  app.post(
    "/api/v1/acquisition/managed/:kind/:id/grab",
    { schema: { params: ManagedMediaParams, body: GrabReleaseBody } },
    async (request: Req, reply: any) => {
      const admin = await requireAdmin(request, reply);
      if (!admin) return;
      const params = request.params as { kind: "movie" | "series"; id: string };
      const body = request.body as { releaseId: string; episodeKey?: string; query?: string };
      try {
        const result = await runManagedReleaseSearch(params.kind, params.id, body.episodeKey, body.query);
        const chosen = result.candidates.find((candidate) =>
          releaseFingerprint(candidate) === body.releaseId,
        );
        if (!chosen) return reply.code(409).send({ error: "That release is no longer available. Search again." });
        if (!result.verdict.rankedGuids.includes(chosen.release.guid)) {
          const reasons = result.verdict.assessments?.find((item) => item.guid === chosen.release.guid)?.reasons
            ?? ["no_qualifying_release"];
          await decisions.record({
            itemKey: result.context.itemKey,
            mode: "interactive",
            outcome: "rejected",
            guid: chosen.release.guid,
            title: chosen.release.title,
            reasons: reasons.map((reason) => humanReason(reason, { quality: chosen.quality })),
          });
          return reply.code(409).send({
            error: "The release is rejected by the managed policy.",
            blockedReason: reasons[0],
            blockedReasons: reasons,
          });
        }
        const dispatched = await grabPipeline.decide({
          itemKey: result.context.itemKey,
          candidates: result.candidates,
          profile: result.context.profile,
          blacklistedGuids: result.blacklistedGuids,
          mode: "interactive",
          chosenGuid: chosen.release.guid,
          correlationId: result.correlationId,
        });
        const chosenReasons = dispatched.verdict.assessments?.find((item) => item.guid === chosen.release.guid)?.reasons;
        await decisions.record({
          itemKey: result.context.itemKey,
          mode: "interactive",
          outcome: dispatched.grabbed ? "accepted" : "rejected",
          guid: chosen.release.guid,
          title: chosen.release.title,
          reasons: (dispatched.grabbed ? chosenReasons ?? dispatched.verdict.reasons : [dispatched.blockedReason ?? "dispatch_failed"])
            .map((reason) => humanReason(reason, { quality: chosen.quality })),
        });
        await audit(admin, "release.grabbed", params.kind, params.id, {
          releaseId: body.releaseId,
          indexerId: chosen.release.indexerId,
          grabbed: dispatched.grabbed,
        });
        reply.code(dispatched.grabbed ? 202 : 409);
        return {
          grabbed: dispatched.grabbed,
          ...(dispatched.blockedReason ? { blockedReason: dispatched.blockedReason } : {}),
          ...(dispatched.download ? {
            download: {
              downloadId: dispatched.download.downloadId,
              itemKey: dispatched.download.itemKey,
              state: dispatched.download.state,
              progressPercent: dispatched.download.progressPercent,
              sizeBytes: dispatched.download.sizeBytes,
            },
          } : {}),
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : "";
        const reason = /no download roots configured/i.test(message) ? "Configure a download directory in Acquisition before grabbing releases."
          : /kill switch|tunnel.*health/i.test(message) ? "The VPN dispatch check blocked this release. Check Acquisition → VPN."
          : /no servers|credentials|authentication/i.test(message) ? "Check the Usenet server credentials in Acquisition."
          : /free.space|quota|disk space/i.test(message) ? "The download directory has insufficient free space or the release exceeds its quota."
          : /Indexer release fetch failed/i.test(message) ? "The indexer could not provide the release file. Test the indexer connection, then retry."
          : /metadata size limit/i.test(message) ? "The indexer release file exceeds the download client's metadata size limit."
          : "Dispatch failed. Check the download client and indexer connection in Acquisition, then retry.";
        return reply.code(503).send({ error: reason });
      }
    },
  );

  const usenetEngine = () => deps.container.resolveProvider(
    "dev.tantalar.capability.usenet.engine",
    "dev.tantalar.plugin.usenet-native",
  );
  const torrentEngine = () => deps.container.resolveProvider(
    "dev.tantalar.capability.torrent.engine",
    "dev.tantalar.plugin.torrent-native",
  );
  const vpnManager = () => deps.container.resolveProvider(
    "dev.tantalar.capability.vpn-binding",
    "dev.tantalar.plugin.vpn-manager",
  );

  app.get("/api/v1/playback", async (request: Req, reply: any) => {
    if (!(await requireAdmin(request, reply))) return;
    try {
      const [{ policy }, { sessions }, probe, volume] = await Promise.all([
        serving().invoke("playback-policy", {}) as Promise<{ policy: PlaybackPolicy }>,
        serving().invoke("playback-sessions", {}) as Promise<{ sessions: Array<Record<string, unknown>> }>,
        probeFfmpeg(),
        statfs(deps.dataDir).catch(() => null),
      ]);
      const userIds = [...new Set(sessions.map((session) => String(session.userId ?? "")).filter(Boolean))];
      const users = userIds.length === 0
        ? []
        : await db.selectFrom("users").select(["id", "username"]).where("id", "in", userIds).execute();
      const usernames = new Map(users.map((user) => [user.id, user.username]));
      return {
        policy,
        sessions: sessions.map((session) => ({
          ...session,
          viewer: usernames.get(String(session.userId ?? "")) ?? "Unknown viewer",
          userId: undefined,
        })),
        probe,
        storage: volume ? {
          contained: true,
          freeBytes: volume.bavail * volume.bsize,
          totalBytes: volume.blocks * volume.bsize,
        } : { contained: true, freeBytes: null, totalBytes: null },
      };
    } catch (err) {
      return reply.code(503).send({ error: (err as Error).message });
    }
  });

  app.put(
    "/api/v1/playback/policy",
    { schema: { body: PlaybackPolicyBody } },
    async (request: Req, reply: any) => {
      const admin = await requireAdmin(request, reply);
      if (!admin) return;
      const body = request.body as PlaybackPolicy;
      const probe = await probeFfmpeg();
      if (!probe.available) return reply.code(503).send({ error: "FFmpeg must be available before playback policy can be applied" });
      if (!["auto", "software"].includes(body.hardwareAcceleration)
        && !probe.hardwareAcceleration.includes(body.hardwareAcceleration)) {
        return reply.code(400).send({ error: `hardware acceleration ${body.hardwareAcceleration} is not supported by this FFmpeg build` });
      }
      const volume = await statfs(deps.dataDir).catch(() => null);
      if (!volume || volume.bavail * volume.bsize < 256 * 1024 * 1024) {
        return reply.code(409).send({ error: "The Tantalar data volume has less than 256 MB free for transcode output" });
      }
      try {
        const result = await serving().invoke("set-playback-policy", body as unknown as Record<string, unknown>);
        await audit(admin, "playback.policy.updated", "playback-policy", "global", {
          preferDirectPlay: body.preferDirectPlay,
          maxConcurrentTranscodes: body.maxConcurrentTranscodes,
          hardwareAcceleration: body.hardwareAcceleration,
        });
        return result;
      } catch (err) {
        return reply.code(Number((err as { statusCode?: number }).statusCode ?? 400)).send({ error: (err as Error).message });
      }
    },
  );

  app.post(
    "/api/v1/playback/preview",
    { schema: { body: PlaybackPreviewBody } },
    async (request: Req, reply: any) => {
      if (!(await requireAdmin(request, reply))) return;
      const body = request.body as { fileId: string; network?: "local" | "remote"; capabilities: BrowserCapabilities };
      try {
        return await serving().invoke("preview-decision", {
          fileId: body.fileId,
          network: body.network ?? "local",
          capabilities: body.capabilities,
        });
      } catch (err) {
        return reply.code(400).send({ error: (err as Error).message });
      }
    },
  );

  const stopPlayback = (transcodeOnly: boolean) => async (request: Req, reply: any) => {
    const admin = await requireAdmin(request, reply);
    if (!admin) return;
    const sessionId = String((request.params as { sessionId?: string } | undefined)?.sessionId ?? "");
    try {
      const result = await serving().invoke("close-session", {
        sessionId,
        reason: transcodeOnly ? "admin_stop_transcode" : "admin_stop_session",
      });
      await audit(
        admin,
        transcodeOnly ? "playback.transcode.stopped" : "playback.session.stopped",
        "playback-session",
        sessionId,
      );
      return result;
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  };

  app.post("/api/v1/playback/sessions/:sessionId/stop", stopPlayback(false));
  app.post("/api/v1/playback/sessions/:sessionId/stop-transcode", stopPlayback(true));

  const usenetSecretOwner = "dev.tantalar.plugin.usenet-native";
  const prepareUsenetServers = async (value: unknown) => {
    if (!Array.isArray(value)) throw httpError("servers must be an array", 400);
    const current = await usenetEngine().invoke("configuration-status", {}) as { servers?: Array<{ id?: unknown }> };
    const existingIds = new Set((current.servers ?? []).map((server) => String(server.id ?? "")).filter(Boolean));
    const rollbacks: Array<() => Promise<void>> = [];
    const servers = [] as Record<string, unknown>[];
    for (const serverValue of value) {
      if (!serverValue || typeof serverValue !== "object" || Array.isArray(serverValue)) throw httpError("server must be an object", 400);
      const raw = serverValue as Record<string, unknown>;
      const id = String(raw.id ?? "").trim();
      if (!id) throw httpError("server.id is required", 400);
      const password = typeof raw.password === "string" ? raw.password : "";
      const confirmPassword = typeof raw.confirmPassword === "string" ? raw.confirmPassword : "";
      const passwordEnv = typeof raw.passwordEnv === "string" ? raw.passwordEnv.trim() : "";
      const removePassword = raw.removePassword === true;
      if (password && password !== confirmPassword) throw httpError("Password confirmation does not match.", 400);
      if ([Boolean(password), Boolean(passwordEnv), removePassword].filter(Boolean).length > 1) {
        throw httpError("Choose one password source.", 400);
      }
      const ref = `usenet:${id}`;
      const { password: _password, confirmPassword: _confirm, removePassword: _remove, hasPassword: _has, passwordSource: _source, ...safe } = raw;
      if (password) {
        if (!deps.secrets) throw httpError("The server secret store is unavailable.", 503);
        const previous = await deps.secrets.get(usenetSecretOwner, ref);
        await deps.secrets.set(usenetSecretOwner, ref, password);
        rollbacks.push(() => previous === null
          ? deps.secrets!.delete(usenetSecretOwner, ref).then(() => undefined)
          : deps.secrets!.set(usenetSecretOwner, ref, previous));
        servers.push({ ...safe, passwordRef: ref });
      } else if (removePassword) {
        if (!deps.secrets) throw httpError("The server secret store is unavailable.", 503);
        const previous = await deps.secrets.get(usenetSecretOwner, ref);
        await deps.secrets.delete(usenetSecretOwner, ref);
        if (previous !== null) rollbacks.push(() => deps.secrets!.set(usenetSecretOwner, ref, previous));
        servers.push(safe);
      } else if (passwordEnv) {
        servers.push({ ...safe, passwordEnv });
      } else if (existingIds.has(id)) {
        servers.push(safe);
      } else {
        throw httpError("Password or deployment secret reference is required.", 400);
      }
    }
    return { servers, rollbacks, existingIds };
  };

  app.get("/api/v1/acquisition/usenet", async (request: Req, reply: any) => {
    if (!(await requireAdmin(request, reply))) return;
    try {
      return await usenetEngine().invoke("configuration-status", {});
    } catch (err) {
      return reply.code(503).send({ error: (err as Error).message });
    }
  });

  app.put("/api/v1/acquisition/usenet", async (request: Req, reply: any) => {
    const admin = await requireAdmin(request, reply);
    if (!admin) return;
    const body = (request.body ?? {}) as { servers?: unknown };
    let prepared: Awaited<ReturnType<typeof prepareUsenetServers>> | null = null;
    try {
      prepared = await prepareUsenetServers(body.servers);
      const result = await usenetEngine().invoke("configure", { servers: prepared.servers });
      if (deps.secrets) {
        const keptIds = new Set(prepared.servers.map((server) => String(server.id ?? "")));
        for (const id of prepared.existingIds) {
          const server = prepared.servers.find((value) => value.id === id);
          if (!keptIds.has(id) || typeof server?.passwordEnv === "string") {
            await deps.secrets.delete(usenetSecretOwner, `usenet:${id}`);
          }
        }
      }
      await audit(admin, "acquisition.usenet.configured", "plugin", "dev.tantalar.plugin.usenet-native", {
        serverCount: Array.isArray(body.servers) ? body.servers.length : 0,
      });
      return result;
    } catch (err) {
      if (prepared) await Promise.allSettled(prepared.rollbacks.reverse().map((rollback) => rollback()));
      const status = typeof (err as { statusCode?: unknown }).statusCode === "number" ? Number((err as { statusCode: number }).statusCode) : 400;
      return reply.code(status).send({ error: (err as Error).message });
    }
  });

  app.post("/api/v1/acquisition/usenet/test", async (request: Req, reply: any) => {
    const admin = await requireAdmin(request, reply);
    if (!admin) return;
    const body = (request.body ?? {}) as { server?: unknown };
    try {
      const prepared = await prepareUsenetServers([body.server]);
      const result = await usenetEngine().invoke("test-server", { server: prepared.servers[0] });
      const server = body.server && typeof body.server === "object" ? body.server as Record<string, unknown> : {};
      await audit(admin, "acquisition.usenet.server.tested", "plugin", "dev.tantalar.plugin.usenet-native", {
        serverId: String(server["id"] ?? "unknown").slice(0, 80),
      });
      return result;
    } catch (err) {
      return reply.code(502).send({ error: (err as Error).message });
    }
  });

  app.get("/api/v1/acquisition/torrent", async (request: Req, reply: any) => {
    if (!(await requireAdmin(request, reply))) return;
    try {
      return await torrentEngine().invoke("runtime-status", {});
    } catch (err) {
      return reply.code(503).send({ error: (err as Error).message });
    }
  });

  app.put("/api/v1/acquisition/torrent", async (request: Req, reply: any) => {
    const admin = await requireAdmin(request, reply);
    if (!admin) return;
    const body = (request.body ?? {}) as { downloadRoots?: unknown };
    try {
      const result = await torrentEngine().invoke("configure", { downloadRoots: body.downloadRoots });
      await audit(admin, "acquisition.torrent.configured", "plugin", "dev.tantalar.plugin.torrent-native", {
        rootCount: Array.isArray(body.downloadRoots) ? body.downloadRoots.length : 0,
      });
      return result;
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  app.get("/api/v1/acquisition/vpn", async (request: Req, reply: any) => {
    if (!(await requireAdmin(request, reply))) return;
    try {
      return await vpnManager().invoke("status", {});
    } catch (err) {
      return reply.code(503).send({ error: (err as Error).message });
    }
  });

  app.post("/api/v1/acquisition/vpn/preflight", async (request: Req, reply: any) => {
    const admin = await requireAdmin(request, reply);
    if (!admin) return;
    try {
      const result = await vpnManager().invoke("preflight", {});
      await audit(admin, "acquisition.vpn.preflight", "plugin", "dev.tantalar.plugin.vpn-manager");
      return result;
    } catch (err) {
      return reply.code(503).send({ error: (err as Error).message });
    }
  });

  app.get("/api/v1/queue", async (request: Req, reply: any) => {
    if (!(await requireAdmin(request, reply))) return;
    const includeHistory = request.query?.["includeHistory"] === "1" || request.query?.["includeHistory"] === "true";
    const records = await jobs.list({ includeHistory });
    // Metadata is optional; a missing manager must not hide active downloads.
    const [movieResult, seriesResult] = await Promise.allSettled([
      Promise.resolve().then(() => moviesProvider().invoke("list-movies", {})),
      Promise.resolve().then(() => seriesProvider().invoke("list-series", {})),
    ]);
    const movies = movieResult.status === "fulfilled" ? (movieResult.value as { movies?: Record<string, unknown>[] })?.movies ?? [] : [];
    const series = seriesResult.status === "fulfilled" ? (seriesResult.value as { series?: Record<string, unknown>[] })?.series ?? [] : [];
    const managed = new Map<string, { item: Record<string, unknown>; kind: "movie" | "series" }>([
      ...movies.map(item => [String(item.movieId), { item, kind: "movie" as const }] as const),
      ...series.map(item => [String(item.seriesId), { item, kind: "series" as const }] as const),
    ]);
    const enriched = records.map(job => {
      const episode = /:(S\d+E\d+)$/i.exec(job.itemKey);
      const id = episode ? job.itemKey.slice(0, episode.index) : job.itemKey;
      const match = managed.get(id);
      const media = match ? {
        title: String(match.item.title ?? match.item.name ?? job.title),
        kind: match.kind,
        ...(typeof match.item.year === "number" ? { year: match.item.year } : {}),
        ...(episode ? { episode: episode[1]!.toUpperCase() } : {}),
        artworkUrl: `/api/v1/acquisition/managed/${match.kind}/${encodeURIComponent(id)}/artwork`,
      } : undefined;
      return { ...queueJobJson(job), ...(media ? { media } : {}) };
    });
    if (!request.query?.page) return { jobs: enriched };
    const fields = {
      title: (job: typeof enriched[number]) => job.media?.title ?? job.title,
      release: (job: typeof enriched[number]) => job.title,
      state: (job: typeof enriched[number]) => job.status,
      source: (job: typeof enriched[number]) => job.source,
      progressPercent: (job: typeof enriched[number]) => job.progressPercent,
      retryCount: (job: typeof enriched[number]) => job.retryCount,
      priority: (job: typeof enriched[number]) => job.priority,
      failure: (job: typeof enriched[number]) => job.failureReason,
      handoff: (job: typeof enriched[number]) => job.importHandoffPath,
    };
    const page = collectionPage(enriched, request.query, fields);
    return { jobs: page.items, total: page.total, facets: collectionFacets(enriched, { state: fields.state, source: fields.source }) };
  });

  app.post("/api/v1/queue", async (request: Req, reply: any) => {
    const admin = await requireAdmin(request, reply);
    if (!admin) return;
    const body = (request.body ?? {}) as { kind?: unknown; title?: unknown; sourceUrl?: unknown };
    const fingerprint = createHash("sha256").update(String(body.sourceUrl ?? "")).digest("hex");
    const correlationId = uuidv7();
    let download;
    try {
      download = validateDownloadRequest({
        itemKey: `manual:${fingerprint}`,
        title: body.title,
        kind: body.kind === "usenet" ? "nzb" : body.kind,
        sourceUrl: body.sourceUrl,
        correlationId,
      });
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
    const source = download.kind === "nzb" ? "usenet" : "torrent";
    const providerId = download.kind === "torrent"
      ? "dev.tantalar.plugin.torrent-native"
      : "dev.tantalar.plugin.usenet-native";
    const existing = await jobs.findActive(download.itemKey, source);
    if (existing) return reply.code(200).send({ job: queueJobJson(existing), created: false });
    let provider;
    try {
      provider = deps.container.resolveProvider("dev.tantalar.capability.download-client", providerId);
      if (deps.container.hasProviders("dev.tantalar.capability.vpn-binding")) {
        const vpn = deps.container.resolve("dev.tantalar.capability.vpn-binding");
        const gate = await vpn.invoke("pre-dispatch-check", { clientId: providerId }) as { allowDispatch?: boolean; health?: string };
        await deps.bus.publish({
          type: EventTypes.DispatchGateChecked,
          producer: "core",
          correlationId,
          payload: { clientId: providerId, health: gate.health ?? "down", allowed: gate.allowDispatch === true },
        });
        if (!gate.allowDispatch) {
          return reply.code(409).send({ error: `VPN binding blocks dispatch (${String(gate.health ?? "down")})` });
        }
      } else {
        await deps.bus.publish({
          type: EventTypes.DispatchGateChecked,
          producer: "core",
          correlationId,
          payload: { clientId: providerId, health: "not_configured", allowed: true },
        });
      }
    } catch (err) {
      return reply.code(503).send({ error: (err as Error).message });
    }
    let status: DownloadStatus;
    try {
      status = validateDownloadStatus(
        await provider.invoke("add", download as unknown as Record<string, unknown>),
        { itemKey: download.itemKey },
      );
      await deps.bus.publish({
        type: EventTypes.ClientDispatch,
        producer: "core",
        correlationId,
        payload: { itemKey: download.itemKey, clientId: providerId, downloadId: status.downloadId },
      });
    } catch {
      return reply.code(502).send({ error: "Download provider rejected the job." });
    }
    let createdRecordId: string | null = null;
    let record: DownloadJobRecord;
    let created: boolean;
    try {
      ({ record, created } = await jobs.create({
        itemKey: download.itemKey,
        title: download.title,
        source,
        providerPluginId: providerId,
        providerJobId: status.downloadId,
        sourceRef: `sha256:${fingerprint}`,
        sizeBytes: status.sizeBytes,
        correlationId,
      }));
      if (!created) {
        if (record.providerJobId !== status.downloadId) {
          await provider.invoke("remove", { downloadId: status.downloadId, keepFiles: true }).catch(() => undefined);
        }
        return reply.code(200).send({ job: queueJobJson(record), created: false });
      }
      createdRecordId = record.jobId;
    } catch {
      const existingProvider = await jobs.findByProvider(providerId, status.downloadId).catch(() => null);
      if (!existingProvider) {
        await provider.invoke("remove", { downloadId: status.downloadId, keepFiles: true }).catch(() => undefined);
      }
      return reply.code(500).send({ error: "Could not persist the accepted download job." });
    }
    let next: DownloadJobRecord;
    try {
      next = await jobs.updateProgress(record.jobId, {
        state: status.state,
        progressPercent: status.progressPercent,
        sizeBytes: status.sizeBytes,
      });
    } catch {
      if (createdRecordId) await jobs.remove(createdRecordId).catch(() => undefined);
      await provider.invoke("remove", { downloadId: status.downloadId, keepFiles: true }).catch(() => undefined);
      return reply.code(500).send({ error: "Could not persist the accepted download job." });
    }
    await audit(admin, "queue.job.created", "download_job", next.jobId, { source, providerPluginId: providerId });
    return reply.code(created ? 201 : 200).send({ job: queueJobJson(next), created });
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
    if (!record.providerJobId) {
      return reply.code(409).send({ error: "This legacy job has no provider identity and cannot be controlled." });
    }
    let owner;
    try {
      owner = deps.container.resolveProvider("dev.tantalar.capability.download-client", record.providerPluginId);
    } catch (err) {
      return reply.code(503).send({ error: (err as Error).message });
    }
    const ownerPayload = { downloadId: record.providerJobId };
    const requireNetworkAllowed = async (): Promise<{ status: 409 | 503; error: string } | null> => {
      if (!deps.container.hasProviders("dev.tantalar.capability.vpn-binding")) return null;
      try {
        const vpn = deps.container.resolve("dev.tantalar.capability.vpn-binding");
        const gate = await vpn.invoke("pre-dispatch-check", { clientId: record.providerPluginId }) as { allowDispatch?: boolean; health?: string };
        return gate.allowDispatch ? null : { status: 409, error: `VPN binding blocks network activity (${String(gate.health ?? "down")})` };
      } catch (err) {
        return { status: 503, error: `VPN binding check unavailable: ${(err as Error).message}` };
      }
    };

    try {
      switch (body.action) {
      case "pause":
        if (record.state !== "downloading") return reply.code(409).send({ error: `cannot pause a ${record.state} job` });
        await owner.invoke("pause", ownerPayload);
        await jobs.updateProgress(jobId, { state: "paused" });
        break;
      case "resume":
        if (record.state !== "paused") return reply.code(409).send({ error: `cannot resume a ${record.state} job` });
        {
          const blocked = await requireNetworkAllowed();
          if (blocked) return reply.code(blocked.status).send({ error: blocked.error });
        }
        await owner.invoke("resume", ownerPayload);
        await jobs.updateProgress(jobId, { state: "downloading" });
        break;
      case "retry": {
        if (!(record.state === "failed" || record.state === "paused")) {
          return reply.code(409).send({ error: `only failed or paused jobs can be retried (state=${record.state})` });
        }
        try {
          const blocked = await requireNetworkAllowed();
          if (blocked) return reply.code(blocked.status).send({ error: blocked.error });
          await owner.invoke("retry", ownerPayload);
          await jobs.retry(jobId);
        } catch (err) {
          return reply.code(409).send({ error: (err as Error).message });
        }
        break;
      }
      case "prioritize": {
        if (!Number.isInteger(body.priority)) return reply.code(400).send({ error: "priority must be an integer" });
        const engineCapability = record.source === "torrent"
          ? "dev.tantalar.capability.torrent.engine"
          : "dev.tantalar.capability.usenet.engine";
        await jobs.updateProgress(jobId, { priority: body.priority });
        try {
          const engine = deps.container.resolveProvider(engineCapability, record.providerPluginId);
          await engine.invoke("queue-position", { ...ownerPayload, queuePosition: body.priority });
        } catch {
          await jobs.updateProgress(jobId, { priority: record.priority }).catch(() => undefined);
          return reply.code(503).send({ error: "Download provider priority update failed." });
        }
        break;
      }
      case "remove": {
        // Destructive intent is explicit: data deletion only happens when the
        // caller asked for it AND the engine confirms; the durable history
        // row always survives.
        const deletesData = body.deleteDataFiles === true;
        await owner.invoke("remove", { ...ownerPayload, keepFiles: !deletesData });
        await jobs.remove(jobId);
        await audit(admin, "queue.job.removed", "download_job", jobId, { deletesData });
        return {
          removed: true,
          dataFilesDeleted: deletesData ? "unknown" : false,
          note: deletesData
            ? "The owning engine accepted the deletion request; file removal is not independently verified."
            : "Removed from the queue; downloaded files were kept.",
        };
      }
      default:
        return reply.code(400).send({ error: "unknown action" });
      }
    } catch {
      return reply.code(502).send({ error: "Download provider action failed." });
    }
    const next = await jobs.get(jobId);
    await audit(admin, `queue.job.${body.action}`, "download_job", jobId, {});
    return { job: next ? queueJobJson(next) : null };
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

  // ---- MCP setup, desired state, protocol checks --------------------------

  const readMcpStatus = async () => {
    const mounted = deps.supervisor.get(MCP_PLUGIN_ID);
    let configError: string | null = null;
    let configuration: McpConfig;
    try {
      configuration = normalizeMcpConfig(deps.mcp?.getDesiredConfig() ?? MCP_DEFAULT_CONFIG);
    } catch (error) {
      configuration = normalizeMcpConfig(MCP_DEFAULT_CONFIG);
      configError = (error as Error).message;
    }
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
    type McpRuntimeStatus = {
      activeTransport?: string;
      endpoint?: string | null;
      mutatingToolsEnabled?: boolean;
      limits?: McpConfig["limits"];
      tools?: ReadonlyArray<{
        name: string;
        purpose: string;
        mutates: boolean;
        enabled: boolean;
        requiredScopes: readonly string[];
      }>;
    };
    let pluginStatus: McpRuntimeStatus | null = null;
    if (mounted) {
      try {
        pluginStatus = await deps.container
          .resolveProvider("dev.tantalar.capability.mcp.status", MCP_PLUGIN_ID)
          .invoke("status", {}) as McpRuntimeStatus;
      } catch {
        pluginStatus = null;
      }
    }
    return {
      mounted: Boolean(mounted),
      state: mounted?.state ?? null,
      healthy: mounted?.state === "healthy",
      version: mounted?.manifest.version ?? null,
      capabilities: mounted ? [...mounted.manifest.provides] : [],
      auditedCalls: callCount,
      defaultPolicy: "loopback bind, read-only tools, per-call immutable audit",
      activeTransport: mounted?.state === "healthy" ? (pluginStatus?.activeTransport ?? (configuration.http.enabled ? "Streamable HTTP" : "Disabled")) : null,
      endpoint: pluginStatus?.endpoint ?? mcpEndpoint(configuration),
      mutatingToolsEnabled: pluginStatus?.mutatingToolsEnabled ?? configuration.mutatingToolsEnabled,
      limits: pluginStatus?.limits ?? configuration.limits,
      tools: pluginStatus?.tools ?? [],
      configuration,
      configError,
      recovery: !mounted
        ? { code: "module_absent", action: "Apply the MCP configuration to mount the module." }
        : mounted.state !== "healthy"
          ? { code: "module_unhealthy", action: "Review the plugin state, then apply the last working configuration." }
          : configError
            ? { code: "invalid_configuration", action: "Correct the stored MCP configuration and apply it again." }
            : null,
    };
  };

  app.get("/api/v1/mcp/status", async (request: Req, reply: any) => {
    if (!(await requireAdmin(request, reply))) return;
    return readMcpStatus();
  });

  app.put("/api/v1/mcp/config", { schema: { body: McpConfigBody } }, async (request: Req, reply: any) => {
    const admin = await requireAdmin(request, reply);
    if (!admin) return;
    if (!deps.mcp) return reply.code(503).send({ error: "MCP configuration service is unavailable", code: "configuration_unavailable" });
    let configuration: McpConfig;
    try {
      configuration = normalizeMcpConfig(request.body);
    } catch (error) {
      const message = (error as Error).message;
      const code = /non-loopback|TLS|HTTPS/i.test(message) ? "unsafe_bind" : "invalid_configuration";
      await audit(admin, "mcp.configuration.rejected", "plugin", MCP_PLUGIN_ID, { code });
      return reply
        .code((error as Error & { statusCode?: number }).statusCode ?? 400)
        .send({ error: message, code });
    }
    try {
      await deps.mcp.applyDesiredConfig(configuration as unknown as Record<string, unknown>);
      await audit(admin, "mcp.configuration.applied", "plugin", MCP_PLUGIN_ID, {
        transportEnabled: configuration.http.enabled,
        loopback: ["127.0.0.1", "localhost", "::1"].includes(configuration.http.bind),
        mutatingToolsEnabled: configuration.mutatingToolsEnabled,
      });
      return { saved: true, status: await readMcpStatus() };
    } catch (error) {
      const message = (error as Error).message;
      const code = /EADDRINUSE|address already in use/i.test(message)
        ? "port_conflict"
        : /manifest not readable|not mounted/i.test(message)
          ? "module_absent"
          : /non-loopback|TLS|HTTPS/i.test(message)
            ? "unsafe_bind"
            : "restart_failed";
      const rolledBack = (error as Error & { rolledBack?: boolean }).rolledBack === true;
      await audit(admin, "mcp.configuration.failed", "plugin", MCP_PLUGIN_ID, { code, rolledBack });
      return reply.code(409).send({
        error: rolledBack
          ? "MCP could not start with the new configuration. The last working configuration was restored."
          : "MCP could not start, and automatic recovery did not complete.",
        code,
        rolledBack,
      });
    }
  });

  app.post("/api/v1/mcp/test", { schema: { body: McpTestBody } }, async (request: Req, reply: any) => {
    const admin = await requireAdmin(request, reply);
    if (!admin) return;
    const status = await readMcpStatus();
    const endpoint = status.endpoint;
    if (!status.mounted) {
      await audit(admin, "mcp.connection.tested", "plugin", MCP_PLUGIN_ID, { ok: false, code: "module_absent" });
      return { ok: false, code: "module_absent", checks: [] };
    }
    if (!endpoint) {
      await audit(admin, "mcp.connection.tested", "plugin", MCP_PLUGIN_ID, { ok: false, code: "transport_disabled" });
      return { ok: false, code: "transport_disabled", checks: [] };
    }
    const apiKey = (request.body as { apiKey: string }).apiKey;
    const checks: Array<{ name: "initialize" | "ping" | "tools/list"; ok: boolean }> = [];
    let code: string | null = null;
    let tools: unknown[] = [];
    try {
      const rpc = async (method: "initialize" | "ping" | "tools/list") => {
        let response: Response;
        try {
          response = await fetch(endpoint, {
            method: "POST",
            headers: { "content-type": "application/json", "x-tantalar-key": apiKey },
            body: JSON.stringify({ jsonrpc: "2.0", id: method, method, params: {} }),
            signal: AbortSignal.timeout(10_000),
          });
        } catch {
          throw Object.assign(new Error("transport request failed"), { code: "transport" });
        }
        if (!response.ok) throw Object.assign(new Error("transport request failed"), { code: "transport" });
        let body: { result?: Record<string, unknown>; error?: { message?: string } };
        try {
          body = await response.json() as typeof body;
        } catch {
          throw Object.assign(new Error("invalid JSON-RPC response"), { code: "protocol" });
        }
        if (body.error) {
          const message = String(body.error.message ?? "protocol error");
          const failureCode = /unauthorized/i.test(message)
            ? "authentication"
            : /scope|forbidden/i.test(message)
              ? "missing_scope"
              : "protocol";
          throw Object.assign(new Error(message), { code: failureCode });
        }
        if (!body.result || typeof body.result !== "object") throw Object.assign(new Error("invalid JSON-RPC result"), { code: "protocol" });
        return body.result;
      };
      const initialized = await rpc("initialize");
      if (typeof initialized.protocolVersion !== "string") throw Object.assign(new Error("initialize response is invalid"), { code: "protocol" });
      checks.push({ name: "initialize", ok: true });
      await rpc("ping");
      checks.push({ name: "ping", ok: true });
      const listed = await rpc("tools/list");
      if (!Array.isArray(listed.tools)) throw Object.assign(new Error("tools/list response is invalid"), { code: "protocol" });
      tools = listed.tools;
      checks.push({ name: "tools/list", ok: true });
    } catch (error) {
      code = String((error as Error & { code?: string }).code ?? "plugin_failure");
    }
    const ok = code === null;
    await audit(admin, "mcp.connection.tested", "plugin", MCP_PLUGIN_ID, { ok, ...(code ? { code } : {}), checks: checks.length });
    return { ok, code, checks, tools: ok ? tools : [] };
  });

  // ---- TAN-038: server-side paginated catalog -----------------------------

  app.get("/api/v1/catalog/page", async (request: Req, reply: any) => {
    if (!(await requireAdmin(request, reply))) return;
    const q = request.query ?? {};
    const page = Math.max(1, Math.trunc(Number(q["page"] ?? 1)) || 1);
    const pageSizeRaw = Math.trunc(Number(q["pageSize"] ?? 25)) || 25;
    const pageSize = Math.max(1, Math.min(200, pageSizeRaw));
    const search = (q["search"] ?? "").trim();
    const sortKey = q["sort"] === "title" ? "itemKey" : q["sort"] === "path" ? "path" : q["sort"] === "quality" ? "quality" : "importedAt";
    const sortDir = q["dir"] === "asc" ? "asc" : "desc";
    const libraryId = q["libraryId"];

    let base = db.selectFrom("media_catalog").selectAll();
    if (libraryId) base = base.where("libraryId", "=", libraryId);
    if (search) base = base.where(eb => eb.or([eb("itemKey", "like", `%${search}%`), eb("path", "like", `%${search}%`)]));
    if (q["quality"]) base = base.where("quality", "=", q["quality"]);
    const totalQuery = base;
    const [countRow] = await totalQuery.select((eb) => eb.fn.countAll<number>().as("n")).execute();
    const total = Number(countRow?.n ?? 0);
    const items = await base
      .orderBy(`${sortKey} ${sortDir}` as never)
      .limit(pageSize)
      .offset((page - 1) * pageSize)
      .execute();
    const resolvedItems = await metadata.enrichItems(items);
    return {
      items: resolvedItems,
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
    const unavailable: string[] = [];
    let eventCount: number | null = null;
    let recentIncidents: Array<{ id: string; type: string; occurredAt: string; subject: string | null }> = [];
    let lastLibraryScanAt: string | null = null;
    let playbackStarts: number | null = null;
    try {
      const incidentCutoff = new Date(Date.now() - 7 * 86_400_000).toISOString();
      const [eventRows, scanRows, playbackRows, failureRows, clientIncidentRows] = await Promise.all([
        db.selectFrom("events").select((eb) => eb.fn.countAll<number>().as("n")).execute(),
        db.selectFrom("events")
          .select("occurredAt")
          .where("type", "=", EventTypes.LibraryRescanCompleted)
          .orderBy("occurredAt", "desc")
          .limit(1)
          .execute(),
        db.selectFrom("events")
          .select((eb) => eb.fn.countAll<number>().as("n"))
          .where("type", "=", EventTypes.PlaybackStarted)
          .execute(),
        db.selectFrom("events")
          .select(["eventId as id", "type", "occurredAt", "subject"])
          .where("type", "in", [EventTypes.PluginFailed, EventTypes.DownloadFailed, EventTypes.ImportFailed])
          .where("occurredAt", ">=", incidentCutoff)
          .orderBy("occurredAt", "desc")
          .limit(5)
          .execute(),
        db.selectFrom("audit_log")
          .select(["id", "action as type", "occurredAt", "targetId as subject"])
          .where("action", "=", "client.incident.reported")
          .where("occurredAt", ">=", incidentCutoff)
          .orderBy("occurredAt", "desc")
          .limit(5)
          .execute(),
      ]);
      eventCount = Number(eventRows[0]?.n ?? 0);
      lastLibraryScanAt = scanRows[0]?.occurredAt ?? null;
      playbackStarts = Number(playbackRows[0]?.n ?? 0);
      recentIncidents = [...failureRows, ...clientIncidentRows]
        .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt))
        .slice(0, 5);
    } catch {
      unavailable.push("Event history is unavailable.");
    }

    let libraries: {
      configured: number | null;
      enabled: number | null;
      byKind: { movie: number; series: number; mixed: number } | null;
      catalog: { files: number; items: number; movies: number; series: number; mixed: number } | null;
      unavailableReason: string | null;
    } = { configured: null, enabled: null, byKind: null, catalog: null, unavailableReason: "Library data is unavailable." };
    try {
      const [libraryRows, catalogRows] = await Promise.all([
        db.selectFrom("libraries").select(["kind", "enabled"]).execute(),
        db.selectFrom("media_catalog as media")
          .innerJoin("libraries as library", "library.id", "media.libraryId")
          .select("library.kind as kind")
          .select((eb) => [
            eb.fn.countAll<number>().as("files"),
            eb.fn.count<number>("media.itemKey").distinct().as("items"),
          ])
          .groupBy("library.kind")
          .execute(),
      ]);
      const byKind = { movie: 0, series: 0, mixed: 0 };
      for (const library of libraryRows) byKind[library.kind] += 1;
      const catalog = { files: 0, items: 0, movies: 0, series: 0, mixed: 0 };
      for (const row of catalogRows) {
        const files = Number(row.files);
        const items = Number(row.items);
        catalog.files += files;
        catalog.items += items;
        catalog[row.kind === "movie" ? "movies" : row.kind] += items;
      }
      libraries = {
        configured: libraryRows.length,
        enabled: libraryRows.filter((library) => library.enabled === 1).length,
        byKind,
        catalog,
        unavailableReason: null,
      };
    } catch {
      unavailable.push("Library data is unavailable.");
    }

    let queue: { queued: number; downloading: number; paused: number; failed: number } | null = null;
    try {
      const queueRows = await db.selectFrom("download_jobs")
        .select("state")
        .select((eb) => eb.fn.countAll<number>().as("n"))
        .where("removed", "=", 0)
        .where("state", "in", ["queued", "downloading", "paused", "failed"])
        .groupBy("state")
        .execute();
      queue = { queued: 0, downloading: 0, paused: 0, failed: 0 };
      for (const row of queueRows) {
        if (row.state in queue) queue[row.state as keyof typeof queue] = Number(row.n);
      }
    } catch {
      unavailable.push("Acquisition queue data is unavailable.");
    }

    let dataVolume: { totalBytes: number; usedBytes: number; freeBytes: number; unavailableReason: null } | {
      totalBytes: null; usedBytes: null; freeBytes: null; unavailableReason: string;
    };
    try {
      const volume = await statfs(deps.dataDir);
      const totalBytes = volume.blocks * volume.bsize;
      const freeBytes = volume.bavail * volume.bsize;
      dataVolume = { totalBytes, usedBytes: totalBytes - freeBytes, freeBytes, unavailableReason: null };
    } catch {
      dataVolume = { totalBytes: null, usedBytes: null, freeBytes: null, unavailableReason: "Data volume usage is unavailable." };
      unavailable.push(dataVolume.unavailableReason);
    }

    const memory = process.memoryUsage();
    const cpu = process.cpuUsage();
    const hostTotalMemory = totalmem();
    const hostFreeMemory = freemem();
    const readiness = deps.readiness?.();
    const ffmpegProbe = await probeFfmpeg();
    let activeStreams: number | null = null;
    let activeTranscodes: number | null = null;
    let activePlaybackReason: string | null = null;
    try {
      const snapshot = await serving().invoke("playback-sessions", {}) as { sessions: Array<{ state: string; mode: string; workerAlive: boolean }> };
      const active = snapshot.sessions.filter((session) => session.state !== "ended");
      activeStreams = active.length;
      activeTranscodes = active.filter((session) => session.mode === "hls" && session.workerAlive).length;
    } catch {
      activePlaybackReason = "The serving runtime does not expose a playback session snapshot.";
    }
    return {
      versions: {
        tantalar: getVersionMetadata(),
        node: process.version,
        platform: process.platform,
        arch: process.arch,
      },
      ready: readiness?.ready ?? deps.ready?.() ?? null,
      plugins,
      eventCount,
      missingCapabilities: readiness?.missingCapabilities ?? [],
      resources: {
        uptimeSeconds: Math.floor(process.uptime()),
        startedAt: new Date(Date.now() - process.uptime() * 1_000).toISOString(),
        process: {
          rssBytes: memory.rss,
          heapUsedBytes: memory.heapUsed,
          cpuUserSeconds: cpu.user / 1_000_000,
          cpuSystemSeconds: cpu.system / 1_000_000,
        },
        host: {
          totalMemoryBytes: hostTotalMemory,
          freeMemoryBytes: hostFreeMemory,
          usedMemoryBytes: hostTotalMemory - hostFreeMemory,
          loadAverage: loadavg(),
        },
      },
      storage: {
        dataVolume,
        catalogKnownBytes: null,
        catalogKnownBytesReason: "Catalog file sizes are not stored yet.",
      },
      libraries: { ...libraries, lastScanAt: lastLibraryScanAt },
      work: {
        queue,
        queueUnavailableReason: queue ? null : "Acquisition queue data is unavailable.",
        playbackStarts,
        activeStreams,
        activeStreamsReason: activePlaybackReason,
        activeTranscodes,
        activeTranscodesReason: activePlaybackReason,
      },
      capabilities: {
        indexerMounted: deps.container.hasProviders("dev.tantalar.capability.indexer"),
        downloadClientMounted: deps.container.hasProviders("dev.tantalar.capability.download-client"),
        torrentEngineMounted: deps.container.hasProviders("dev.tantalar.capability.torrent.engine"),
        usenetEngineMounted: deps.container.hasProviders("dev.tantalar.capability.usenet.engine"),
        vpnMounted: deps.container.hasProviders("dev.tantalar.capability.vpn-binding"),
      },
      recentIncidents,
      incidentsUnavailableReason: eventCount === null ? "Recent incidents are unavailable." : null,
      unavailable,
      transcoder: {
        ffmpegAvailable: ffmpegProbe.available,
      },
      network: {
        vpnCapabilityMounted: deps.container.hasProviders("dev.tantalar.capability.vpn-binding"),
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
    const ffmpegProbe = await probeFfmpeg();
    const bundle = {
      generatedAt: new Date().toISOString(),
      versions: {
        tantalar: getVersionMetadata(),
        node: process.version,
        platform: process.platform,
        arch: process.arch,
      },
      moduleStates: deps.supervisor.list().map((p) => ({ id: p.manifest.id, state: p.state, restarts: p.restartCount })),
      configurationShape: configShape,
      recentEventsRedacted: redactSupportText(recentEvents),
      storage: {
        dataDir: deps.dataDir,
        dialect: deps.sqlitePath ? "sqlite" : "postgres-or-unavailable",
      },
      transcoder: { ffmpegAvailable: ffmpegProbe.available },
      mediaNames,
    };
    await audit(admin, "system.support-bundle.exported", "system", "support-bundle", {
      includeMediaNames: body.includeMediaNames === true,
    });
    return { bundle };
  });

}
