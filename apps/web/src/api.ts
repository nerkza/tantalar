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
    request<{ plugins: ReadonlyArray<{ manifest: { id: string; version: string }; state: string; restartCount: number }> }>(
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
};
