/**
 * Typed client for the Phase 5A serving HTTP surface.
 * All calls use cookie-session auth (same-origin through the Vite dev proxy
 * or the server's static hosting in production).
 */

export interface LibraryItem {
  readonly fileId: string;
  readonly itemKey: string;
  readonly title: string;
  readonly kind: "series" | "movie";
  readonly libraryId: string;
}

export interface Collection {
  readonly name: string;
  readonly fileIds: readonly string[];
}

export interface ContinueWatchingEntry {
  readonly fileId: string;
  readonly positionMs: number;
  readonly durationMs: number;
}

export interface BrowseResult {
  readonly items: readonly LibraryItem[];
  readonly collections: readonly Collection[];
  readonly continueWatching: readonly ContinueWatchingEntry[];
}

export type PlaybackDecision =
  | { readonly mode: "direct"; readonly streamUrl: string }
  | {
      readonly mode: "hls";
      readonly sessionId: string;
      readonly manifestUrl: string;
      readonly qualities: readonly string[];
    };

export interface SubtitleTrack {
  readonly trackId: string;
  readonly lang: string;
  readonly format: "srt" | "ass" | "pgs";
  readonly source: "embedded" | "external";
}

export interface ResumePoint {
  readonly userId: string;
  readonly fileId: string;
  readonly positionMs: number;
  readonly durationMs: number;
  readonly updatedAt: string;
}

/** Event envelope shape used by the Activity/Trajectory view. */
export interface TrajectoryEvent {
  readonly eventId: string;
  readonly type: string;
  readonly occurredAt: string;
  readonly producer: string;
  readonly subject?: string;
  readonly correlationId?: string;
  readonly causationId?: string;
  readonly payload: Record<string, unknown>;
}

/** Library definition row (wave 3 core service). */
export interface LibraryRecord {
  readonly id: string;
  readonly name: string;
  readonly rootPath: string;
  readonly kind: "series" | "movie" | "mixed";
  readonly enabled: boolean;
  readonly createdAt: string;
}

/** Imported media catalog row. */
export interface CatalogItem {
  readonly fileId: string;
  readonly libraryId: string;
  readonly itemKey: string;
  readonly path: string;
  readonly quality: string;
  readonly method: "hardlink" | "copy";
  readonly importedAt: string;
}

/** Redacted indexer record (apikey never leaves the server). */
export interface IndexerRecord {
  readonly id: string;
  readonly name: string;
  readonly protocol: "torznab" | "newznab";
  readonly baseUrl: string;
  readonly hasApiKey: boolean;
  readonly priority: number;
  readonly enabled: boolean;
  readonly limits: { maxSearchesPerWindow: number; windowMs: number; retentionDays: number };
}

/** ---- Wave 9 operations types (TAN-030–043) ---- */

/** Durable download job row (queue + history). */
export interface DownloadJob {
  readonly jobId: string;
  readonly itemKey: string;
  readonly title: string;
  readonly source: "torrent" | "usenet";
  readonly enginePluginId: string;
  readonly state: "queued" | "downloading" | "paused" | "completed" | "failed" | "cancelled";
  readonly progressPercent: number;
  readonly sizeBytes: number;
  readonly receivedBytes: number;
  readonly etaAt: string | null;
  readonly warnings: readonly string[];
  readonly retryCount: number;
  readonly priority: number;
  readonly failureReason: string | null;
  readonly removed: boolean;
  readonly importHandoffPath: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface AuditEntry {
  readonly id: string;
  readonly actorUserId: string | null;
  readonly actorUsername: string | null;
  readonly action: string;
  readonly targetType: string;
  readonly targetId: string;
  readonly detail: Record<string, unknown>;
  readonly occurredAt: string;
}

/** API key as stored server-side — never contains the secret. */
export interface ApiKeyRecord {
  readonly id: string;
  readonly name: string;
  readonly scopes: readonly string[];
  readonly createdAt: string;
  readonly revokedAt: string | null;
  readonly expiresAt: string | null;
}

export interface WebhookRecord {
  readonly id: string;
  readonly url: string;
  readonly eventTypes: readonly string[];
  /** True when a signing env var NAME is configured (never the value). */
  readonly secretEnvVarConfigured: boolean;
  /** True when that env var is set in the server environment. */
  readonly secretEnvVarNameSetInEnv: boolean;
  readonly active: boolean;
  readonly createdAt: string;
  readonly lastStatus: string | null;
  readonly lastDeliveryAt: string | null;
  readonly lastDetail: string | null;
}

export interface CatalogPageResult {
  readonly items: ReadonlyArray<CatalogItem>;
  readonly page: number;
  readonly pageSize: number;
  readonly total: number;
  readonly totalPages: number;
}

export interface DiagnosticsReport {
  readonly versions: { node: string; platform: string; arch: string };
  readonly ready: boolean | null;
  readonly plugins: ReadonlyArray<{ id: string; version: string; state: string; restarts: number; provides: readonly string[] }>;
  readonly eventCount: number | null;
  readonly missingCapabilities: readonly string[];
  readonly transcoder: { ffmpegAvailable: boolean };
  readonly network: { vpnCapabilityMounted: boolean };
}

/** Browser capabilities the web player declares during negotiation. */
export const WEB_CAPABILITIES = {
  canPlayContainers: ["mp4"],
  canPlayVideo: ["h264"],
  canPlayAudio: ["aac", "mp3"],
  canDirectSubtitles: ["srt", "vtt"],
} as const;

/** CSRF double-submit token for cookie-authenticated mutations. */
function csrfHeader(): Record<string, string> {
  const m = /(?:^|;\s*)tantalar_csrf=([^;]+)/.exec(document.cookie);
  return m?.[1] ? { "x-csrf-token": decodeURIComponent(m[1]) } : {};
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...csrfHeader(),
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw Object.assign(new Error(body.error ?? `request failed: ${res.status}`), {
      status: res.status,
    });
  }
  return (await res.json()) as T;
}

export const api = {
  login: (username: string, password: string) =>
    request<{ ok: boolean }>("/api/v1/auth/login", {
      method: "POST",
      body: JSON.stringify({ username, password }),
    }),
  logout: () => request<{ ok: boolean }>("/api/v1/auth/logout", { method: "POST" }),
  me: () => request<{ user: { id: string; username: string; role: string } | null }>("/api/v1/auth/me"),
  // ---- Wave 2 bootstrap + guided onboarding ----
  bootstrapStatus: () => request<{ required: boolean }>("/api/v1/bootstrap/status"),
  bootstrapAdmin: (username: string, password: string) =>
    request<{ ok: boolean }>("/api/v1/bootstrap/admin", {
      method: "POST",
      body: JSON.stringify({ username, password }),
    }),
  onboarding: () =>
    request<{ steps: Record<string, { status: "pending" | "done" | "skipped" }>; complete: boolean }>("/api/v1/onboarding"),
  onboardStep: (stepId: string, action: "complete" | "skip") =>
    request<{ steps: Record<string, { status: "pending" | "done" | "skipped" }>; complete: boolean }>(
      `/api/v1/onboarding/steps/${encodeURIComponent(stepId)}`,
      { method: "POST", body: JSON.stringify({ action }) },
    ),
  browse: () => request<BrowseResult>("/api/v1/library"),
  resumePoint: (fileId: string) =>
    request<{ resumePoint: ResumePoint | null }>(`/api/v1/library/${encodeURIComponent(fileId)}/resume`),
  setResume: (fileId: string, positionMs: number, durationMs?: number, allowRewind?: boolean) =>
    request<{ accepted: boolean; resumePoint: ResumePoint }>(`/api/v1/library/${encodeURIComponent(fileId)}/resume`, {
      method: "POST",
      body: JSON.stringify({ positionMs, ...(durationMs !== undefined ? { durationMs } : {}), allowRewind }),
    }),
  history: () => request<{ history: unknown[] }>("/api/v1/history"),
  negotiate: (fileId: string, capabilities = WEB_CAPABILITIES) =>
    request<{ decision: PlaybackDecision }>(`/api/v1/negotiate/${encodeURIComponent(fileId)}`, {
      method: "POST",
      body: JSON.stringify(capabilities),
    }),
  subtitles: (fileId: string) =>
    request<{ tracks: readonly SubtitleTrack[] }>(`/api/v1/library/${encodeURIComponent(fileId)}/subtitles`),
  openTranscodeSession: (fileId: string, qualities?: readonly string[]) =>
    request<{ sessionId: string; manifestUrl: string; qualities: readonly string[] }>(
      "/api/v1/transcode-session",
      { method: "POST", body: JSON.stringify({ fileId, ...(qualities ? { qualities } : {}) }) },
    ),
  cancelTranscodeSession: (sessionId: string) =>
    request<{ cancelled: boolean }>(`/api/v1/transcode-session/${encodeURIComponent(sessionId)}`, {
      method: "DELETE",
    }),
  // ---- Phase 6 admin surface ----
  events: (filters: { typePrefix?: string; subject?: string; correlationId?: string; limit?: number } = {}) => {
    const q = new URLSearchParams();
    if (filters.typePrefix) q.set("typePrefix", filters.typePrefix);
    if (filters.subject) q.set("subject", filters.subject);
    if (filters.correlationId) q.set("correlationId", filters.correlationId);
    if (filters.limit) q.set("limit", String(filters.limit));
    const qs = q.toString();
    return request<{ events: TrajectoryEvent[] }>(`/api/v1/events${qs ? `?${qs}` : ""}`);
  },
  plugins: () =>
    request<{ plugins: ReadonlyArray<{ manifest: { id: string; version: string; provides: readonly string[] }; state: string; restartCount: number }> }>(
      "/api/v1/plugins",
    ),
  invokeCapability: (pluginId: string, capability: string, operation: string, payload: Record<string, unknown> = {}) =>
    request<{ result: unknown }>(
      `/api/v1/plugins/${encodeURIComponent(pluginId)}/capabilities/${encodeURIComponent(capability)}/${encodeURIComponent(operation)}`,
      { method: "POST", body: JSON.stringify(payload) },
    ),
  users: () => request<{ users: ReadonlyArray<{ id: string; username: string; role: string; createdAt: string }> }>("/api/v1/users"),
  createUser: (username: string, password: string, role: "admin" | "viewer") =>
    request<{ user: { id: string; username: string; role: string } }>("/api/v1/users", {
      method: "POST",
      body: JSON.stringify({ username, password, role }),
    }),
  uiPreferences: (userId: string) =>
    request<{ preferences: Record<string, unknown> }>(`/api/v1/users/${encodeURIComponent(userId)}/ui-preferences`),
  saveUiPreferences: (userId: string, preferences: Record<string, unknown>) =>
    request<{ saved: boolean }>(`/api/v1/users/${encodeURIComponent(userId)}/ui-preferences`, {
      method: "PUT",
      body: JSON.stringify({ preferences }),
    }),
  themes: () =>
    request<{ themes: ReadonlyArray<{ id: string; name: string; tokens: Record<string, string> }> }>("/api/v1/themes"),
  saveTheme: (id: string | null, name: string, tokens: Record<string, string>) =>
    (id === null
      ? request<{ theme: { id: string; name: string } }>("/api/v1/themes", {
          method: "POST",
          body: JSON.stringify({ name, tokens }),
        })
      : request<{ saved: boolean }>(`/api/v1/themes/${encodeURIComponent(id)}`, {
          method: "PUT",
          body: JSON.stringify({ name, tokens }),
        })),
  deleteTheme: (id: string) =>
    request<{ deleted: boolean }>(`/api/v1/themes/${encodeURIComponent(id)}`, { method: "DELETE" }),
  systemHealth: () =>
    request<{
      ready: boolean;
      plugins: ReadonlyArray<{ id: string; version: string; state: string; restarts: number }>;
      eventCount: number | null;
    }>("/api/v1/system/health"),
  // ---- Wave 10 naming/import settings (TAN-022) ----
  namingSchemes: () =>
    request<{ schemes: ReadonlyArray<{ name: string; episodeTemplate: string; movieTemplate: string }>; roots: readonly string[] }>(
      "/api/v1/naming/schemes",
    ),
  saveNamingScheme: (name: string, episodeTemplate: string, movieTemplate: string) =>
    request<{ set: string }>("/api/v1/naming/schemes", {
      method: "POST",
      body: JSON.stringify({ name, episodeTemplate, movieTemplate }),
    }),
  previewNaming: (input: Record<string, unknown>) =>
    request<{ path: string; scheme: string; kind: string }>("/api/v1/naming/preview", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  renamePlan: (scheme: string) =>
    request<{
      scheme: string;
      total: number;
      changed: number;
      plan: ReadonlyArray<{ itemKey: string; currentPath: string; newPath: string; changes: boolean }>;
    }>(`/api/v1/naming/rename-plan?scheme=${encodeURIComponent(scheme)}`),
  namingRecoveryGuidance: () =>
    request<{ guidance: readonly string[] }>("/api/v1/naming/recovery-guidance"),
  // ---- Wave 8 product surface ----
  /** Library definitions (admin management; reads for any signed-in user). */
  libraries: () =>
    request<{ libraries: ReadonlyArray<LibraryRecord> }>("/api/v1/libraries"),
  validateLibrary: (id: string) =>
    request<{ results: ReadonlyArray<{ library: LibraryRecord; ok: boolean; issues: ReadonlyArray<{ code: string; detail: string }>; device?: number }> }>(
      `/api/v1/libraries/validate?libraryId=${encodeURIComponent(id)}`,
    ),
  rescanLibrary: (id: string) =>
    request<{ checked: number; missingRemoved: number }>(`/api/v1/libraries/${encodeURIComponent(id)}/rescan`, { method: "POST" }),
  freeSpace: (id: string) =>
    request<{ availableBytes: number | null }>(`/api/v1/libraries/${encodeURIComponent(id)}/free-space`),
  /** Imported media catalog rows (per library or all). */
  catalog: (libraryId?: string) =>
    request<{ items: ReadonlyArray<CatalogItem> }>(
      `/api/v1/catalog${libraryId ? `?libraryId=${encodeURIComponent(libraryId)}` : ""}`,
    ),
  /** Indexer management (admin). */
  indexers: () => request<{ indexers: ReadonlyArray<IndexerRecord> }>("/api/v1/indexers"),
  testIndexer: (id: string) =>
    request<{ ok: boolean; code?: string; detail?: string; categoryCount?: number; searchModes?: readonly string[]; probedUrl?: string }>(
      `/api/v1/indexers/${encodeURIComponent(id)}/test`,
      { method: "POST" },
    ),
  setIndexerEnabled: (id: string, enabled: boolean) =>
    request<{ indexer: IndexerRecord }>(`/api/v1/indexers/${encodeURIComponent(id)}/enabled`, {
      method: "PUT",
      body: JSON.stringify({ enabled }),
    }),
  // ---- Wave 9 operations surface (TAN-030–043) ----
  queue: (includeHistory = false) =>
    request<{ jobs: ReadonlyArray<DownloadJob> }>(
      `/api/v1/queue${includeHistory ? "?includeHistory=1" : ""}`,
    ),
  queueAction: (
    jobId: string,
    action: "pause" | "resume" | "retry" | "remove",
    opts: { priority?: number; deleteDataFiles?: boolean } = {},
  ) =>
    request<{ job?: DownloadJob; removed?: boolean; dataFilesDeleted?: boolean; note?: string }>(
      `/api/v1/queue/${encodeURIComponent(jobId)}/actions`,
      { method: "POST", body: JSON.stringify({ action, ...opts }) },
    ),
  pluginDetail: (id: string) =>
    request<{
      manifest: { id: string; version: string; provides: readonly string[]; requires: readonly string[] };
      state: string;
      restartCount: number;
      requiredBy: readonly string[];
      serviceImpact: string | null;
    }>(`/api/v1/plugins/${encodeURIComponent(id)}/detail`),
  pluginAction: (id: string, action: "restart" | "disable" | "enable") =>
    request<{ plugin?: { id: string; state: string }; impact?: string; error?: string }>(
      `/api/v1/plugins/${encodeURIComponent(id)}/actions`,
      { method: "POST", body: JSON.stringify({ action }) },
    ),
  setUserRole: (id: string, role: "admin" | "viewer") =>
    request<{ saved: boolean }>(`/api/v1/users/${encodeURIComponent(id)}/role`, {
      method: "PUT",
      body: JSON.stringify({ role }),
    }),
  resetUserPassword: (id: string, password: string) =>
    request<{ saved: boolean }>(`/api/v1/users/${encodeURIComponent(id)}/password-reset`, {
      method: "POST",
      body: JSON.stringify({ password }),
    }),
  revokeUserSessions: (id: string) =>
    request<{ revoked: number }>(`/api/v1/users/${encodeURIComponent(id)}/sessions/revoke`, { method: "POST" }),
  setUserActive: (id: string, active: boolean) =>
    request<{ saved: boolean }>(`/api/v1/users/${encodeURIComponent(id)}/active`, {
      method: "PUT",
      body: JSON.stringify({ active }),
    }),
  userLibraries: (id: string) =>
    request<{ libraryIds: readonly string[] }>(`/api/v1/users/${encodeURIComponent(id)}/libraries`),
  setUserLibraries: (id: string, libraryIds: readonly string[]) =>
    request<{ saved: boolean }>(`/api/v1/users/${encodeURIComponent(id)}/libraries`, {
      method: "PUT",
      body: JSON.stringify({ libraryIds }),
    }),
  auditLog: (limit = 100) =>
    request<{ entries: ReadonlyArray<AuditEntry> }>(`/api/v1/system/audit?limit=${limit}`),
  apiKeys: () => request<{ keys: ReadonlyArray<ApiKeyRecord> }>("/api/v1/api-keys"),
  createApiKey: (name: string, scopes: readonly string[], expiresAt?: string | null) =>
    request<{ key: ApiKeyRecord; secret: string }>("/api/v1/api-keys", {
      method: "POST",
      body: JSON.stringify({ name, scopes, ...(expiresAt !== undefined ? { expiresAt } : {}) }),
    }),
  revokeApiKey: (id: string) =>
    request<{ revoked: boolean }>(`/api/v1/api-keys/${encodeURIComponent(id)}`, { method: "DELETE" }),
  webhooks: () => request<{ webhooks: ReadonlyArray<WebhookRecord> }>("/api/v1/webhooks"),
  createWebhook: (url: string, eventTypes: readonly string[], secretEnvVar: string) =>
    request<{ webhook: WebhookRecord }>("/api/v1/webhooks", {
      method: "POST",
      body: JSON.stringify({ url, eventTypes, secretEnvVar }),
    }),
  deleteWebhook: (id: string) =>
    request<{ deleted: boolean }>(`/api/v1/webhooks/${encodeURIComponent(id)}`, { method: "DELETE" }),
  testWebhook: (id: string) =>
    request<{ ok: boolean; status?: number; code?: string; detail?: string }>(
      `/api/v1/webhooks/${encodeURIComponent(id)}/test`,
      { method: "POST", body: "{}" },
    ),
  mcpStatus: () =>
    request<{
      mounted: boolean;
      state: string | null;
      version: string | null;
      capabilities: readonly string[];
      auditedCalls: number | null;
      defaultPolicy: string;
    }>("/api/v1/mcp/status"),
  catalogPage: (opts: { page?: number; pageSize?: number; search?: string; sort?: string; dir?: string; libraryId?: string } = {}) => {
    const q = new URLSearchParams();
    if (opts.page) q.set("page", String(opts.page));
    if (opts.pageSize) q.set("pageSize", String(opts.pageSize));
    if (opts.search) q.set("search", opts.search);
    if (opts.sort) q.set("sort", opts.sort);
    if (opts.dir) q.set("dir", opts.dir);
    if (opts.libraryId) q.set("libraryId", opts.libraryId);
    const qs = q.toString();
    return request<CatalogPageResult>(`/api/v1/catalog/page${qs ? `?${qs}` : ""}`);
  },
  backup: () => request<{ path: string; includes: readonly string[] }>("/api/v1/system/backup", { method: "POST", body: "{}" }),
  restore: (path: string) =>
    request<{ restored: boolean; note: string }>("/api/v1/system/restore", {
      method: "POST",
      body: JSON.stringify({ path }),
    }),
  diagnostics: () => request<DiagnosticsReport>("/api/v1/system/diagnostics"),
  supportBundlePreview: () =>
    request<{ sections: readonly string[]; mediaNamesRedacted: boolean; secretsRedacted: boolean }>(
      "/api/v1/system/support-bundle/preview",
    ),
  supportBundle: (includeMediaNames: boolean) =>
    request<{ bundle: Record<string, unknown> }>("/api/v1/system/support-bundle", {
      method: "POST",
      body: JSON.stringify({ includeMediaNames }),
    }),
};
