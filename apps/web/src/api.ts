/**
 * Typed client for the Phase 5A serving HTTP surface.
 * All calls use cookie-session auth (same-origin through the Vite dev proxy
 * or the server's static hosting in production).
 */

import type { EpisodeMetadata, MediaMetadataSnapshot } from "@tantalar/contracts";

export interface MetadataReview {
  readonly token: string;
  readonly changes: ReadonlyArray<{ label: string; before: string; after: string }>;
}

export type EpisodePresentation = Partial<EpisodeMetadata> & { readonly episodeKey: string; readonly title: string; readonly artworkUrl?: string };

function explorerParams(query: import("./admin/DenseGrid").ExplorerQuery) {
  return new URLSearchParams({ explorer: "1", search: query.search, sort: query.sort, desc: String(query.desc), page: String(query.page), pageSize: String(query.pageSize), ...Object.fromEntries(Object.entries(query.filters).map(([key, value]) => [`filter_${key}`, value])) });
}

export interface MoviePresentation {
  readonly episode?: EpisodePresentation;
  readonly qualityProfile?: string;
  readonly year?: number | null;
  readonly overview?: string;
  readonly artworkUrl?: string;
  readonly backdropUrl?: string;
  readonly metadataSnapshot?: Omit<MediaMetadataSnapshot, "artworkUrl">;
}

export interface LibraryItem extends MoviePresentation {
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
  readonly total?: number;
  readonly facets?: Record<string, string[]>;
  readonly items: readonly LibraryItem[];
  readonly collections: readonly Collection[];
  readonly continueWatching: readonly ContinueWatchingEntry[];
}

export interface WatchHistoryEntry {
  readonly fileId: string;
  readonly title: string;
  readonly kind: "series" | "movie";
  readonly positionMs: number;
  readonly durationMs: number;
  readonly completed: boolean;
  readonly lastWatchedAt: string;
  readonly artworkUrl: string | null;
}

export interface WatchHistoryResult {
  readonly history: readonly WatchHistoryEntry[];
}

export type PlaybackDecision =
  | { readonly mode: "direct"; readonly sessionId: string; readonly streamUrl: string; readonly reason: string; readonly audioLanguage?: string; readonly subtitleTrackId?: string }
  | {
      readonly mode: "hls";
      readonly sessionId: string;
      readonly manifestUrl: string;
      readonly qualities: readonly string[];
      readonly reason: string;
      readonly audioLanguage?: string;
      readonly subtitleTrackId?: string;
    };

export interface PlaybackPolicy {
  readonly preferDirectPlay: boolean;
  readonly localBitrateKbps: number;
  readonly remoteBitrateKbps: number;
  readonly maxConcurrentTranscodes: number;
  readonly hardwareAcceleration: string;
  readonly defaultAudioLanguage: string;
  readonly defaultSubtitleLanguage: string;
  readonly subtitleMode: "manual" | "always" | "off";
  readonly transcodeCacheMaxBytes: number;
  readonly idleTimeoutMs: number;
}

export interface PlaybackAdminSession {
  readonly sessionId: string;
  readonly fileId: string;
  readonly title: string;
  readonly viewer: string;
  readonly client: string;
  readonly network: "local" | "remote";
  readonly mode: "direct" | "hls";
  readonly state: "playing" | "waiting" | "transcoding" | "ended";
  readonly positionMs: number;
  readonly durationMs: number;
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly closeReason: string | null;
  readonly workerAlive: boolean;
  readonly maxBitrateKbps: number;
}

export interface PlaybackAdminSnapshot {
  readonly policy: PlaybackPolicy;
  readonly sessions: readonly PlaybackAdminSession[];
  readonly probe: {
    readonly available: boolean;
    readonly version: string | null;
    readonly hardwareAcceleration: readonly string[];
    readonly encoders: readonly string[];
  };
  readonly storage: { readonly contained: boolean; readonly freeBytes: number | null; readonly totalBytes: number | null };
}

export interface PlaybackDecisionPreview {
  readonly fileId: string;
  readonly title: string;
  readonly mode: "direct" | "hls";
  readonly reason: string;
  readonly video: string;
  readonly audio: string;
  readonly subtitles: PlaybackPolicy["subtitleMode"];
  readonly maxBitrateKbps: number;
  readonly network: "local" | "remote";
}

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
export interface CatalogItem extends MoviePresentation {
  readonly title?: string;
  readonly fileId: string;
  readonly libraryId: string;
  readonly itemKey: string;
  readonly path: string;
  readonly quality: string;
  readonly method: "hardlink" | "copy" | "existing";
  readonly importedAt: string;
}

/** Redacted indexer record (apikey never leaves the server). */
export interface IndexerRecord {
  readonly searchModes: { readonly interactive: boolean; readonly automatic: boolean };
  readonly categories: readonly number[];
  readonly tags: readonly string[];
  readonly capabilities?: {
    readonly searchModes: readonly string[];
    readonly categories: ReadonlyArray<{ readonly id: number; readonly name: string }>;
    readonly testedAt: string;
  };
  readonly id: string;
  readonly name: string;
  readonly protocol: "torznab" | "newznab";
  readonly baseUrl: string;
  readonly hasApiKey: boolean;
  readonly priority: number;
  readonly enabled: boolean;
  readonly limits: { maxSearchesPerWindow: number; windowMs: number; retentionDays: number };
}

export interface IndexerWriteInput {
  readonly name: string;
  readonly protocol: IndexerRecord["protocol"];
  readonly baseUrl: string;
  readonly apiKey?: string;
  readonly priority?: number;
  readonly enabled?: boolean;
  readonly searchModes?: Partial<IndexerRecord["searchModes"]>;
  readonly categories?: readonly number[];
  readonly tags?: readonly string[];
  readonly limits?: Partial<IndexerRecord["limits"]>;
}

export type IndexerUpdateInput = Partial<IndexerWriteInput>;

export interface UsenetServerConfig {
  readonly id: string;
  readonly name: string;
  readonly host: string;
  readonly port: number;
  readonly tls: "implicit" | "starttls";
  readonly username: string;
  readonly priority: number;
  readonly connections: number;
  readonly hasPassword: boolean;
  readonly passwordSource: "stored" | "environment";
}

export type UsenetServerWrite = Omit<UsenetServerConfig, "hasPassword" | "passwordSource"> & {
  readonly password?: string;
  readonly confirmPassword?: string;
  readonly passwordEnv?: string;
  readonly removePassword?: boolean;
};

export interface UsenetConfigurationStatus {
  readonly ready: boolean;
  readonly servers: ReadonlyArray<UsenetServerConfig>;
  readonly downloadRoots: readonly string[];
  readonly limitations: { readonly starttls: false; readonly par2: boolean; readonly archives: boolean };
}

export interface VpnPreflight {
  readonly platform: string;
  readonly tools: Readonly<Record<string, boolean>>;
  readonly tunDevice: boolean;
  readonly netAdmin: boolean;
  readonly supported: boolean;
  readonly missing: readonly string[];
  readonly checkedAt: string;
  readonly lifecycleControlReady?: boolean;
  readonly enforcementReady?: boolean;
}

export interface VpnStatus {
  readonly host: VpnPreflight;
  readonly lifecycleControlReady: boolean;
  readonly enforcementReady: boolean;
  readonly openvpnApplySupported: false;
  readonly profiles: ReadonlyArray<Record<string, unknown>>;
  readonly bindings: ReadonlyArray<{ readonly clientId: string; readonly profileId: string; readonly blocked: boolean }>;
  readonly checkedAt: string;
}

export interface TorrentRuntimeStatus {
  readonly ready: boolean;
  readonly engine: string;
  readonly dhtEnabled: false;
  readonly publicDiscoveryEnabled: false;
  readonly downloadRootsConfigured: boolean;
  readonly activeJobs: number;
  readonly limitations: readonly string[];
}

export interface MediaSearchCandidate extends MoviePresentation {
  readonly kind: "movie" | "series";
  readonly externalId: string;
  readonly provider: string;
  readonly title: string;
  readonly year: number | null;
  readonly overview: string;
  readonly artworkUrl?: string;
  readonly availableAt?: string;
}

export interface MetadataProviderStatus {
  readonly provider: "tmdb";
  readonly state: "ready" | "rate-limited" | "unavailable";
  readonly mode: "hosted" | "direct" | "fixture";
  readonly configured: boolean;
  readonly directKeyConfigured: boolean;
  readonly locale?: string;
  readonly lastError?: { readonly code: string };
}

export interface ManagedMediaItem extends MoviePresentation {
  readonly localFileCount?: number;
  readonly tags?: readonly string[];
  readonly id: string;
  readonly kind: "movie" | "series";
  readonly title: string;
  readonly year?: number;
  readonly monitored: boolean;
  readonly provider?: string;
  readonly externalId?: string;
  readonly overview?: string;
  readonly artworkUrl?: string;
  readonly acquisitionState?: string;
  readonly destinationLibraryId?: string;
  readonly qualityProfile?: string;
  readonly minimumAvailability?: string;
  readonly preferredLanguages?: readonly string[];
  readonly monitorMode?: string;
  readonly manualFields?: readonly string[];
  readonly episodeCount?: number;
  readonly acquiredEpisodeCount?: number;
}

export interface ManagedMediaPolicy {
  readonly destinationLibraryId?: string;
  readonly qualityProfile: "any" | "hd" | "uhd";
  readonly minimumAvailability: "announced" | "in-cinemas" | "released";
  readonly monitorMode: "all" | "future" | "missing" | "none";
  readonly monitored: boolean;
  readonly languages: string;
}

export interface ManagedRelease {
  readonly releaseId: string;
  readonly title: string;
  readonly kind: "torrent" | "nzb";
  readonly sizeBytes: number;
  readonly publishedAt: string;
  readonly indexerId: string;
  readonly seeders?: number;
  readonly language?: string;
  readonly quality: string;
  readonly accepted: boolean;
  readonly reasons: ReadonlyArray<{ readonly code: string; readonly message: string }>;
  readonly rank: number | null;
}

export interface ManagedReleaseSearch {
  readonly item: Pick<ManagedMediaItem, "id" | "kind" | "title"> & { readonly itemKey: string };
  readonly releases: ReadonlyArray<ManagedRelease>;
  readonly failures: ReadonlyArray<{ readonly indexerId: string; readonly reason: string }>;
}

export interface WantedLedgerItem {
  readonly itemKey: string;
  readonly kind: "movie" | "series";
  readonly id: string;
  readonly episodeKey?: string;
  readonly title: string;
  readonly state: "missing" | DownloadJob["state"];
  readonly failureDetail: string | null;
  readonly recovery: null | {
    readonly action: "search" | "resume" | "retry" | "remove";
    readonly label: string;
    readonly jobId?: string;
  };
}

export interface ManagedMediaDetail {
  readonly item: ManagedMediaItem & {
    readonly episodes: ReadonlyArray<EpisodePresentation>;
  };
  readonly files: ReadonlyArray<Pick<CatalogItem, "fileId" | "libraryId" | "itemKey" | "path" | "quality">>;
}

export interface ManagedMediaUpdate {
  readonly title?: string;
  readonly year?: number;
  readonly overview?: string | null;
  readonly artworkUrl?: string | null;
  readonly monitored?: boolean;
  readonly destinationLibraryId?: string;
  readonly qualityProfile?: ManagedMediaPolicy["qualityProfile"];
  readonly languages?: readonly string[];
  readonly minimumAvailability?: ManagedMediaPolicy["minimumAvailability"];
  readonly monitorMode?: ManagedMediaPolicy["monitorMode"];
}

/** ---- Wave 9 operations types (TAN-030–043) ---- */

/** Account-owned history of received in-app notices. */
export interface NotificationHistoryEntry {
  id: string;
  severity: "success" | "warning" | "error";
  title: string;
  message?: string;
  createdAt: string;
  count: number;
}

/** Durable download job row (queue + history). */
export interface DownloadJob {
  readonly jobId: string;
  readonly itemKey: string;
  readonly title: string;
  readonly source: "torrent" | "usenet";
  readonly enginePluginId: string;
  readonly state: "queued" | "downloading" | "paused" | "completed" | "failed" | "cancelled";
  readonly status?: DownloadJob["state"] | "imported" | "awaiting_import" | "removed";
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
  readonly correlationId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly media?: { title: string; kind: "movie" | "series"; year?: number; episode?: string; quality?: string; artworkUrl?: string };
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

export interface McpLimits {
  readonly timeoutMs: number;
  readonly maxResultBytes: number;
  readonly rateLimitPerMinute: number;
}

export interface McpConfiguration {
  readonly http: {
    readonly enabled: boolean;
    readonly bind: string;
    readonly port: number;
    readonly tlsViaProxy: boolean;
    readonly clientEndpoint?: string;
  };
  readonly mutatingToolsEnabled: boolean;
  readonly limits: McpLimits;
}

export interface McpToolStatus {
  readonly name: string;
  readonly purpose: string;
  readonly mutates: boolean;
  readonly enabled: boolean;
  readonly requiredScopes: readonly string[];
}

export interface McpStatus {
  readonly mounted: boolean;
  readonly state: string | null;
  readonly healthy: boolean;
  readonly version: string | null;
  readonly capabilities: readonly string[];
  readonly auditedCalls: number | null;
  readonly defaultPolicy: string;
  readonly activeTransport: string | null;
  readonly endpoint: string | null;
  readonly mutatingToolsEnabled: boolean;
  readonly limits: McpLimits;
  readonly tools: readonly McpToolStatus[];
  readonly configuration: McpConfiguration;
  readonly configError: string | null;
  readonly recovery: { readonly code: string; readonly action: string } | null;
}

export interface McpConnectionTestResult {
  readonly ok: boolean;
  readonly code: string | null;
  readonly checks: ReadonlyArray<{
    readonly name: "initialize" | "ping" | "tools/list";
    readonly ok: boolean;
  }>;
  readonly tools: readonly unknown[];
}

export interface CatalogPageResult {
  readonly items: ReadonlyArray<CatalogItem>;
  readonly page: number;
  readonly pageSize: number;
  readonly total: number;
  readonly totalPages: number;
}

export interface VersionMetadata {
  readonly version: string;
  readonly label: string;
  readonly channel: string;
  readonly build: {
    readonly version: string | null;
    readonly commit: string | null;
    readonly builtAt: string | null;
  };
}

export interface DiagnosticsReport {
  readonly versions: {
    tantalar: VersionMetadata;
    node: string;
    platform: string;
    arch: string;
  };
  readonly ready: boolean | null;
  readonly plugins: ReadonlyArray<{ id: string; version: string; state: string; restarts: number; provides: readonly string[] }>;
  readonly eventCount: number | null;
  readonly missingCapabilities: readonly string[];
  readonly resources: {
    uptimeSeconds: number;
    startedAt: string;
    process: { rssBytes: number; heapUsedBytes: number; cpuUserSeconds: number; cpuSystemSeconds: number };
    host: { totalMemoryBytes: number; freeMemoryBytes: number; usedMemoryBytes: number; loadAverage: readonly number[] };
  };
  readonly storage: {
    dataVolume: {
      totalBytes: number | null;
      usedBytes: number | null;
      freeBytes: number | null;
      unavailableReason: string | null;
    };
    catalogKnownBytes: null;
    catalogKnownBytesReason: string;
  };
  readonly libraries: {
    configured: number | null;
    enabled: number | null;
    byKind: { movie: number; series: number; mixed: number } | null;
    catalog: { files: number; items: number; movies: number; series: number; mixed: number } | null;
    unavailableReason: string | null;
    lastScanAt: string | null;
  };
  readonly work: {
    queue: { queued: number; downloading: number; paused: number; failed: number } | null;
    queueUnavailableReason: string | null;
    playbackStarts: number | null;
    activeStreams: number | null;
    activeStreamsReason: string | null;
    activeTranscodes: number | null;
    activeTranscodesReason: string | null;
  };
  readonly capabilities: {
    indexerMounted: boolean;
    downloadClientMounted: boolean;
    torrentEngineMounted: boolean;
    usenetEngineMounted: boolean;
    vpnMounted: boolean;
  };
  readonly recentIncidents: ReadonlyArray<{ id: string; type: string; occurredAt: string; subject: string | null }>;
  readonly incidentsUnavailableReason: string | null;
  readonly unavailable: readonly string[];
  readonly transcoder: { ffmpegAvailable: boolean };
  readonly network: { vpnCapabilityMounted: boolean };
}

export type ClientIncidentKind = "window-error" | "unhandled-rejection" | "main-thread-stall";

export interface ClientIncidentReport {
  readonly kind: ClientIncidentKind;
  readonly fingerprint: string;
  readonly message: string;
  readonly stack?: string;
  readonly route: string;
  readonly appVersion: string;
  readonly occurredAt: string;
  readonly durationMs?: number;
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

const DEFAULT_API_TIMEOUT_MS = 15_000;

interface TantalarRequestInit extends RequestInit {
  timeoutMs?: number;
}

async function request<T>(path: string, init?: TantalarRequestInit): Promise<T> {
  const { timeoutMs = DEFAULT_API_TIMEOUT_MS, signal: callerSignal, ...fetchInit } = init ?? {};
  const controller = new AbortController();
  let timedOut = false;
  const timeout = window.setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const abortFromCaller = () => controller.abort(callerSignal?.reason);
  if (callerSignal?.aborted) abortFromCaller();
  else callerSignal?.addEventListener("abort", abortFromCaller, { once: true });

  try {
    const res = await fetch(path, {
      ...fetchInit,
      signal: controller.signal,
      headers: {
        ...(fetchInit.body === undefined ? {} : { "content-type": "application/json" }),
        ...csrfHeader(),
        ...(fetchInit.headers ?? {}),
      },
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as {
        error?: string;
        code?: string;
        rolledBack?: boolean;
        review?: MetadataReview;
      };
      throw Object.assign(new Error(body.error ?? `request failed: ${res.status}`), {
        status: res.status,
        ...(body.code === undefined ? {} : { code: body.code }),
        ...(body.rolledBack === undefined ? {} : { rolledBack: body.rolledBack }),
        ...(body.review === undefined ? {} : { review: body.review }),
      });
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  } catch (error) {
    if (timedOut) {
      throw Object.assign(new Error("Tantalar took too long to respond. Please try again."), {
        status: 408,
        code: "timeout",
      });
    }
    if (callerSignal?.aborted) throw error;
    if (error instanceof Error && "status" in error) throw error;
    throw Object.assign(new Error("Could not reach Tantalar. Check that the server is running and try again."), {
      code: "network",
      cause: error,
    });
  } finally {
    window.clearTimeout(timeout);
    callerSignal?.removeEventListener("abort", abortFromCaller);
  }
}

export interface UserAvatar { preset: string | null; url?: string }
export interface JobRun {
  traceAvailable?: boolean;
  id: string; jobKey: string; name: string; scope: string; state: string; trigger: string;
  startedAt: string; finishedAt: string | null; durationMs: number | null;
  outcome: string | null; error: string | null; details: string | null; retryOf: string | null;
}
export interface QualityConfiguration {
  profiles: Array<{ name: string; preferredQualities: readonly string[]; upgradeAllowed: boolean; cutoff: string; preferProperRepack: boolean }>;
  sizes: Record<"movie" | "series", Record<string, { min: number; preferred: number | null; max: number | null }>>;
  recycleBinDays: number;
}
export interface FileMaintenancePreview {
  token: string; libraryId: string; kind: "rename" | "recycle";
  items: Array<{ fileId: string; source: string; destination: string; error?: string }>;
  entries: Array<{ id: string; name: string; recycledAt: string; size: number; expired: boolean }>;
}
export interface ScheduledJob {
  id: string; jobKey: string; name: string; scope: string; schedule: string; defaultSchedule: string | null;
  enabled: number; protected: boolean; manualOnly: boolean; registered: boolean; state: string;
  lastRunAt: string | null; nextRunAt: string | null; lockedAt: string | null; latestRun: JobRun | null;
}
export interface UserAccount { id: string; username: string; role: string; createdAt: string; active: boolean; avatar: UserAvatar }

export const api = {
  filePreview: (input: { libraryId: string; kind: "rename" | "recycle"; scheme?: string; page?: number }) => request<FileMaintenancePreview>("/api/v1/jobs/file-preview", { method: "POST", body: JSON.stringify(input), timeoutMs: 120000 }),
  applyFilePreview: (token: string) => request<{ runId: string }>("/api/v1/jobs/file-apply", { method: "POST", body: JSON.stringify({ token }) }),
  quality: () => request<QualityConfiguration>("/api/v1/quality"),
  saveQuality: (value: QualityConfiguration) => request("/api/v1/quality", { method: "PUT", body: JSON.stringify(value) }),
  jobs: (query = "") => request<{ items: ScheduledJob[]; total: number }>(`/api/v1/jobs${query}`),
  jobRuns: (query = "") => request<{ runs: JobRun[]; total: number }>(`/api/v1/jobs/runs${query}`),
  updateJob: (key: string, input: { schedule?: string; enabled?: boolean; restoreDefault?: boolean }) => request(`/api/v1/jobs/${encodeURIComponent(key)}`, { method: "PATCH", body: JSON.stringify(input) }),
  runJob: (key: string) => request<{ runId: string }>(`/api/v1/jobs/${encodeURIComponent(key)}/run`, { method: "POST" }),
  retryJob: (id: string) => request<{ runId: string }>(`/api/v1/jobs/runs/${encodeURIComponent(id)}/retry`, { method: "POST" }),
  version: () => request<VersionMetadata>("/api/v1/version"),
  login: (username: string, password: string) =>
    request<{ ok: boolean }>("/api/v1/auth/login", {
      method: "POST",
      body: JSON.stringify({ username, password }),
    }),
  logout: () => request<{ ok: boolean }>("/api/v1/auth/logout", { method: "POST" }),
  me: () => request<{ user: { id: string; username: string; role: string; avatar?: UserAvatar } | null }>("/api/v1/auth/me"),
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
  browsePage: (query: import("./admin/DenseGrid").ExplorerQuery, signal?: AbortSignal) => request<BrowseResult>(`/api/v1/library?${explorerParams(query)}`, { signal }),
  resumePoint: (fileId: string) =>
    request<{ resumePoint: ResumePoint | null }>(`/api/v1/library/${encodeURIComponent(fileId)}/resume`),
  setResume: (fileId: string, positionMs: number, durationMs?: number, allowRewind?: boolean) =>
    request<{ accepted: boolean; resumePoint: ResumePoint }>(`/api/v1/library/${encodeURIComponent(fileId)}/resume`, {
      method: "POST",
      body: JSON.stringify({ positionMs, ...(durationMs !== undefined ? { durationMs } : {}), allowRewind }),
    }),
  history: () => request<WatchHistoryResult>("/api/v1/history"),
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
  startTranscodeSession: (sessionId: string) =>
    request<{ started: string; ready: boolean }>(`/api/v1/hls/${encodeURIComponent(sessionId)}/start`, {
      method: "POST",
    }),
  closePlaybackSession: (sessionId: string, keepalive = false) =>
    request<{ closed: boolean }>(`/api/v1/playback-session/${encodeURIComponent(sessionId)}`, {
      method: "DELETE",
      keepalive,
    }),
  cancelTranscodeSession: (sessionId: string) =>
    request<{ closed: boolean }>(`/api/v1/playback-session/${encodeURIComponent(sessionId)}`, { method: "DELETE" }),
  touchPlaybackSession: (sessionId: string, positionMs: number, durationMs: number) =>
    request<{ touched: string }>(`/api/v1/playback-session/${encodeURIComponent(sessionId)}/touch`, {
      method: "POST",
      body: JSON.stringify({ positionMs, durationMs }),
    }),
  // ---- Phase 6 admin surface ----
  events: (
    filters: { typePrefix?: string; subject?: string; correlationId?: string; limit?: number } = {},
    options: { signal?: AbortSignal } = {},
  ) => {
    const q = new URLSearchParams();
    if (filters.typePrefix) q.set("typePrefix", filters.typePrefix);
    if (filters.subject) q.set("subject", filters.subject);
    if (filters.correlationId) q.set("correlationId", filters.correlationId);
    if (filters.limit) q.set("limit", String(filters.limit));
    const qs = q.toString();
    return request<{ events: TrajectoryEvent[] }>(`/api/v1/events${qs ? `?${qs}` : ""}`, {
      signal: options.signal,
    });
  },
  playbackAdmin: (options: { signal?: AbortSignal } = {}) =>
    request<PlaybackAdminSnapshot>("/api/v1/playback", { signal: options.signal }),
  updatePlaybackPolicy: (policy: PlaybackPolicy) =>
    request<{ policy: PlaybackPolicy }>("/api/v1/playback/policy", {
      method: "PUT",
      body: JSON.stringify(policy),
    }),
  previewPlaybackDecision: (fileId: string, network: "local" | "remote" = "local", capabilities = WEB_CAPABILITIES) =>
    request<PlaybackDecisionPreview>("/api/v1/playback/preview", {
      method: "POST",
      body: JSON.stringify({ fileId, network, capabilities }),
    }),
  stopPlaybackSession: (sessionId: string, transcodeOnly = false) =>
    request<{ closed: boolean }>(`/api/v1/playback/sessions/${encodeURIComponent(sessionId)}/${transcodeOnly ? "stop-transcode" : "stop"}`, {
      method: "POST",
    }),
  plugins: () =>
    request<{ plugins: ReadonlyArray<{ manifest: { id: string; version: string; provides: readonly string[] }; state: string; restartCount: number }> }>(
      "/api/v1/plugins",
    ),
  invokeCapability: (pluginId: string, capability: string, operation: string, payload: Record<string, unknown> = {}) =>
    request<{ result: unknown }>(
      `/api/v1/plugins/${encodeURIComponent(pluginId)}/capabilities/${encodeURIComponent(capability)}/${encodeURIComponent(operation)}`,
      { method: "POST", body: JSON.stringify(payload) },
    ),
  users: (query?: import("./admin/DenseGrid").ExplorerQuery) => request<{ users: UserAccount[]; total: number }>(`/api/v1/users${query ? `?${explorerParams(query)}` : ""}`),
  userProfile: (id: string) => request<{ user: UserAccount }>(`/api/v1/users/${encodeURIComponent(id)}/profile`),
  saveUserAvatar: (id: string, avatar: { preset: string } | { image: string }) => request<{ avatar: UserAvatar }>(`/api/v1/users/${encodeURIComponent(id)}/avatar`, { method: "PUT", body: JSON.stringify(avatar) }),
  createUser: (username: string, password: string, role: "admin" | "viewer") =>
    request<{ user: { id: string; username: string; role: string } }>("/api/v1/users", {
      method: "POST",
      body: JSON.stringify({ username, password, role }),
    }),
  uiPreferences: (userId: string) =>
    request<{ preferences: Record<string, unknown> }>(`/api/v1/users/${encodeURIComponent(userId)}/ui-preferences`),
  notificationHistory: (query: import("./admin/DenseGrid").ExplorerQuery) => request<{ items: NotificationHistoryEntry[]; total: number }>(`/api/v1/notifications?${explorerParams(query)}`),
  saveNotification: (notice: NotificationHistoryEntry) => request<{ saved: boolean }>("/api/v1/notifications", { method: "POST", body: JSON.stringify(notice) }),
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
  systemHealth: ({ signal }: { signal?: AbortSignal } = {}) =>
    request<DiagnosticsReport>("/api/v1/system/diagnostics", { signal }),
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
  createLibrary: (input: Pick<LibraryRecord, "name" | "rootPath" | "kind">) =>
    request<{ library: LibraryRecord }>("/api/v1/libraries", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  updateLibrary: (id: string, input: Partial<Pick<LibraryRecord, "name" | "rootPath" | "kind">>) =>
    request<{ library: LibraryRecord }>(`/api/v1/libraries/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    }),
  setLibraryEnabled: (id: string, enabled: boolean) =>
    request<{ library: LibraryRecord }>(`/api/v1/libraries/${encodeURIComponent(id)}/enabled`, {
      method: "PUT",
      body: JSON.stringify({ enabled }),
    }),
  removeLibrary: (id: string) =>
    request<{ removed: true; mediaFilesDeleted: false }>(`/api/v1/libraries/${encodeURIComponent(id)}`, {
      method: "DELETE",
    }),
  validateLibrary: (id: string) =>
    request<{ results: ReadonlyArray<{ library: LibraryRecord; ok: boolean; issues: ReadonlyArray<{ code: string; detail: string }>; device?: number }> }>(
      `/api/v1/libraries/validate?libraryId=${encodeURIComponent(id)}`,
    ),
  rescanLibrary: (id: string) =>
    request<{
      checked: number;
      discovered: number;
      existing: number;
      missingRemoved: number;
      skipped: number;
      errors: string[];
    }>(`/api/v1/libraries/${encodeURIComponent(id)}/rescan`, { method: "POST" }),
  freeSpace: (id: string) =>
    request<{ availableBytes: number | null }>(`/api/v1/libraries/${encodeURIComponent(id)}/free-space`),
  /** Imported media catalog rows (per library or all). */
  catalog: (libraryId?: string) =>
    request<{ items: ReadonlyArray<CatalogItem> }>(
      `/api/v1/catalog${libraryId ? `?libraryId=${encodeURIComponent(libraryId)}` : ""}`,
    ),
  /** Indexer management (admin). */
  indexers: () => request<{ indexers: ReadonlyArray<IndexerRecord> }>("/api/v1/indexers"),
  createIndexer: (input: IndexerWriteInput) =>
    request<{ indexer: IndexerRecord }>("/api/v1/indexers", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  updateIndexer: (id: string, input: IndexerUpdateInput) =>
    request<{ indexer: IndexerRecord }>(`/api/v1/indexers/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    }),
  deleteIndexer: (id: string) =>
    request<void>(`/api/v1/indexers/${encodeURIComponent(id)}`, {
      method: "DELETE",
      body: "{}",
    }),
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
  metadataStatus: () => request<MetadataProviderStatus>("/api/v1/acquisition/metadata"),
  configureMetadata: (apiKey: string) =>
    request<MetadataProviderStatus>("/api/v1/acquisition/metadata", {
      method: "PUT",
      body: JSON.stringify({ apiKey }),
    }),
  searchMedia: (query: string, kind: "movie" | "series" | "all", signal?: AbortSignal) =>
    request<{ candidates: ReadonlyArray<MediaSearchCandidate> }>(
      `/api/v1/acquisition/search?query=${encodeURIComponent(query)}&kind=${encodeURIComponent(kind)}`,
      { signal },
    ),
  managedMediaPage: (query: import("./admin/DenseGrid").ExplorerQuery, signal?: AbortSignal) => request<{ items: ReadonlyArray<ManagedMediaItem>; total: number; tags: string[]; facets?: Record<string, string[]> }>(`/api/v1/acquisition/managed?${explorerParams(query)}`, { signal }),
  managedMedia: (signal?: AbortSignal) =>
    request<{ items: ReadonlyArray<ManagedMediaItem> }>("/api/v1/acquisition/managed", { signal }),
  managedMediaDetail: (kind: ManagedMediaItem["kind"], id: string, signal?: AbortSignal) =>
    request<ManagedMediaDetail>(`/api/v1/acquisition/managed/${encodeURIComponent(kind)}/${encodeURIComponent(id)}`, { signal }),
  addManagedMedia: (candidate: MediaSearchCandidate, policy: ManagedMediaPolicy) =>
    request<{ item: ManagedMediaItem; created: boolean }>("/api/v1/acquisition/managed", {
      method: "POST",
      body: JSON.stringify({
        kind: candidate.kind,
        externalId: candidate.externalId,
        provider: candidate.provider,
        title: candidate.title,
        year: candidate.year,
        overview: candidate.overview,
        artworkUrl: candidate.artworkUrl,
        availableAt: candidate.availableAt,
        ...policy,
        languages: policy.languages.split(",").map((value) => value.trim()).filter(Boolean),
      }),
    }),
  updateManagedMedia: (kind: ManagedMediaItem["kind"], id: string, update: ManagedMediaUpdate) =>
    request<{ updated: true }>(`/api/v1/acquisition/managed/${encodeURIComponent(kind)}/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(update),
    }),
  managedEpisodes: (id: string, query: import("./admin/DenseGrid").ExplorerQuery, signal?: AbortSignal) =>
    request<{ items: EpisodePresentation[]; total: number; facets: Record<string, string[]> }>(`/api/v1/acquisition/managed/series/${encodeURIComponent(id)}/episodes?${explorerParams(query)}`, { signal }),
  refreshManagedMedia: (kind: ManagedMediaItem["kind"], id: string, reviewToken?: string) =>
    request<{ refreshed: true }>(`/api/v1/acquisition/managed/${encodeURIComponent(kind)}/${encodeURIComponent(id)}/refresh`, {
      method: "POST",
      body: JSON.stringify({ ...(reviewToken ? { reviewToken } : {}) }),
    }),
  matchManagedMedia: (kind: ManagedMediaItem["kind"], id: string, fileId: string, episodeKey?: string) =>
    request<{ matched: true; itemKey: string }>(`/api/v1/acquisition/managed/${encodeURIComponent(kind)}/${encodeURIComponent(id)}/match`, {
      method: "POST",
      body: JSON.stringify({ fileId, ...(episodeKey ? { episodeKey } : {}) }),
    }),
  deleteManagedMedia: (kind: ManagedMediaItem["kind"], id: string) =>
    request<void>(`/api/v1/acquisition/managed/${encodeURIComponent(kind)}/${encodeURIComponent(id)}`, {
      method: "DELETE",
      body: "{}",
    }),
  setManagedTags: (kind: ManagedMediaItem["kind"], id: string, tags: string[]) =>
    request<{ tags: string[] }>(`/api/v1/acquisition/managed/${kind}/${encodeURIComponent(id)}/tags`, { method: "PUT", body: JSON.stringify({ tags }) }),
  managedReleases: (kind: ManagedMediaItem["kind"], id: string, signal?: AbortSignal, episodeKey?: string, query?: string) =>
    request<ManagedReleaseSearch>(
      `/api/v1/acquisition/managed/${encodeURIComponent(kind)}/${encodeURIComponent(id)}/releases?${new URLSearchParams({ ...(episodeKey ? { episodeKey } : {}), ...(query ? { query } : {}) })}`,
      { signal },
    ),
  grabManagedRelease: (kind: ManagedMediaItem["kind"], id: string, releaseId: string, episodeKey?: string, query?: string) =>
    request<{ download: { readonly downloadId: string; readonly itemKey: string; readonly state: string } }>(
      `/api/v1/acquisition/managed/${encodeURIComponent(kind)}/${encodeURIComponent(id)}/grab`,
      { method: "POST", body: JSON.stringify({ releaseId, ...(episodeKey ? { episodeKey } : {}), ...(query ? { query } : {}) }) },
    ),
  usenetConfiguration: () =>
    request<UsenetConfigurationStatus>("/api/v1/acquisition/usenet"),
  configureUsenet: (servers: ReadonlyArray<UsenetServerWrite>) =>
    request<UsenetConfigurationStatus>("/api/v1/acquisition/usenet", {
      method: "PUT",
      body: JSON.stringify({ servers }),
    }),
  testUsenetServer: (server: UsenetServerWrite) =>
    request<{ ok: true; server: UsenetServerConfig }>("/api/v1/acquisition/usenet/test", {
      method: "POST",
      body: JSON.stringify({ server }),
    }),
  torrentStatus: () => request<TorrentRuntimeStatus>("/api/v1/acquisition/torrent"),
  configureTorrent: (downloadRoots: readonly string[]) => request<TorrentRuntimeStatus>("/api/v1/acquisition/torrent", {
    method: "PUT",
    body: JSON.stringify({ downloadRoots }),
  }),
  vpnStatus: () => request<VpnStatus>("/api/v1/acquisition/vpn"),
  vpnPreflight: () => request<VpnPreflight>("/api/v1/acquisition/vpn/preflight", { method: "POST" }),
  // ---- Wave 9 operations surface (TAN-030–043) ----
  queue: (includeHistory = false, query?: import("./admin/DenseGrid").ExplorerQuery) =>
    request<{ jobs: ReadonlyArray<DownloadJob>; total?: number; facets?: Record<string, string[]> }>(
      `/api/v1/queue?includeHistory=${includeHistory ? "1" : "0"}${query ? `&${explorerParams(query)}` : ""}`,
    ),
  wanted: () => request<{ items: ReadonlyArray<WantedLedgerItem> }>("/api/v1/acquisition/wanted"),
  createDownload: (input: { kind: "torrent" | "usenet"; title: string; sourceUrl: string }) =>
    request<{ job: DownloadJob; created: boolean }>("/api/v1/queue", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  queueAction: (
    jobId: string,
    action: "pause" | "resume" | "retry" | "remove",
    opts: { priority?: number; deleteDataFiles?: boolean } = {},
  ) =>
    request<{ job?: DownloadJob; removed?: boolean; dataFilesDeleted?: boolean | "unknown"; note?: string }>(
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
  auditLog: (limit = 100, options: { signal?: AbortSignal } = {}) =>
    request<{ entries: ReadonlyArray<AuditEntry> }>(`/api/v1/system/audit?limit=${limit}`, {
      signal: options.signal,
    }),
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
  mcpStatus: () => request<McpStatus>("/api/v1/mcp/status"),
  updateMcpConfig: (configuration: McpConfiguration) =>
    request<{ saved: boolean; status: McpStatus }>("/api/v1/mcp/config", {
      method: "PUT",
      body: JSON.stringify(configuration),
      timeoutMs: 30_000,
    }),
  testMcpConnection: (apiKey: string) =>
    request<McpConnectionTestResult>("/api/v1/mcp/test", {
      method: "POST",
      body: JSON.stringify({ apiKey }),
      timeoutMs: 40_000,
    }),
  catalogPage: (opts: { page?: number; pageSize?: number; search?: string; sort?: string; dir?: string; libraryId?: string; quality?: string } = {}) => {
    const q = new URLSearchParams();
    if (opts.page) q.set("page", String(opts.page));
    if (opts.pageSize) q.set("pageSize", String(opts.pageSize));
    if (opts.search) q.set("search", opts.search);
    if (opts.sort) q.set("sort", opts.sort);
    if (opts.quality) q.set("quality", opts.quality);
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
  diagnostics: ({ signal }: { signal?: AbortSignal } = {}) => request<DiagnosticsReport>("/api/v1/system/diagnostics", { signal }),
  reportClientIncident: (incident: ClientIncidentReport) =>
    request<{ recorded: boolean; duplicate: boolean; incidentId?: string }>("/api/v1/system/client-incidents", {
      method: "POST",
      body: JSON.stringify(incident),
      timeoutMs: 5_000,
    }),
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
