/**
 * Serving plugin (phase 5A, stories 13, 15–19, 21).
 *
 * Provides `dev.tantalar.capability.serving`:
 *  - library browsing with collections and continue-watching;
 *  - viewer accounts with per-library visibility (fail-closed);
 *  - browser capability negotiation → direct play vs HLS session decision;
 *  - resume points + watch history per viewer, last-write-wins with
 *    monotonic guard against out-of-order progress races;
 *  - subtitle inventory (embedded + external), never serving unregistered
 *    paths;
 *  - transcode-session orchestration over BOUNDED ffmpeg HLS workers:
 *    global worker cap, per-session idle timeout, hang watchdog kill,
 *    explicit cancel, and startup cleanup of orphaned workers.
 *
 * The plugin NEVER touches media bytes; core HTTP serves bytes after an
 * authorization check against this capability's `authorize` operation.
 * All synthetic fixtures: no real copyrighted media is parsed or shipped.
 */
import { runPlugin, definePlugin, type PluginDefinition } from "@tantalar/plugin-sdk";
import {
  PROTOCOL_VERSION,
  validateManifest,
  EventTypes,
  ServingError,
  isDirectPlayable,
  uuidv7,
  type LibraryEntry,
  type BrowserCapabilities,
  type PlaybackDecision,
  type ResumePoint,
} from "@tantalar/contracts";

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

const SERVING_CAPABILITY = "dev.tantalar.capability.serving";
const PLUGIN_ID = "dev.tantalar.plugin.serving";

const manifest = validateManifest({
  id: PLUGIN_ID,
  version: "0.1.0",
  protocolVersion: PROTOCOL_VERSION,
  provides: [SERVING_CAPABILITY],
  requires: ["dev.tantalar.capability.event.emit", "dev.tantalar.capability.log"],
  subscriptions: [],
  entry: { command: "node dist/plugin.js" },
});

// ---- In-process state ----------------------------------------------------------

const entries = new Map<string, LibraryEntry>(); // fileId -> entry
const viewers = new Map<string, Set<string>>(); // userId -> visible libraryIds
const resumes = new Map<string, ResumePoint>(); // `${userId}:${fileId}` -> point
/** Watch history keyed `${userId}:${fileId}`, newest-first per pair. */
const history = new Map<string, Array<{ startedAt: string; positionMs: number; completed: boolean }>>();
const externalSubtitles = new Map<string, Array<{ trackId: string; lang: string; format: string }>>();

/**
 * External subtitle CONTENT keyed by trackId. Content is supplied at
 * registration (upload) and served back by the `subtitle-content` operation;
 * only registered tracks are ever readable.
 */
const externalSubtitleContent = new Map<string, { fileId: string; content: string }>();
/** Embedded subtitle content declared at registration: trackId -> content. */
const embeddedSubtitleContent = new Map<string, { fileId: string; content: string }>();

/**
 * Optional JSON snapshot file for catalog/viewer state. The plugin owns no
 * database (SDK rule), so a remount after a crash restores its catalog,
 * viewer visibility, resume points, history and subtitle inventory from this
 * file when the operator configures `stateFile`.
 */
let stateFile: string | null = null;

function persistState(): void {
  if (!stateFile) return;
  try {
    const snapshot = {
      entries: [...entries.values()],
      viewers: [...viewers].map(([userId, libs]) => ({ userId, libraries: [...libs] })),
      resumes: [...resumes.values()],
      history: [...history].map(([key, list]) => ({ key, list })),
      externalSubtitles: [...externalSubtitles].map(([fileId, tracks]) => ({ fileId, tracks })),
      externalSubtitleContent: [...externalSubtitleContent].map(([trackId, v]) => ({ trackId, ...v })),
      embeddedSubtitleContent: [...embeddedSubtitleContent].map(([trackId, v]) => ({ trackId, ...v })),
      workers: [...durableWorkers].map(([sessionId, pid]) => ({ sessionId, pid })),
    };
    writeFileSync(stateFile, JSON.stringify(snapshot));
  } catch {
    /* best-effort persistence; serving continues from memory */
  }
}

function restoreState(): void {
  if (!stateFile || !existsSync(stateFile)) return;
  try {
    const snap = JSON.parse(readFileSync(stateFile, "utf8")) as {
      entries?: LibraryEntry[];
      viewers?: Array<{ userId: string; libraries: string[] }>;
      resumes?: ResumePoint[];
      history?: Array<{ key: string; list: Array<{ startedAt: string; positionMs: number; completed: boolean }> }>;
      externalSubtitles?: Array<{ fileId: string; tracks: Array<{ trackId: string; lang: string; format: string }> }>;
      externalSubtitleContent?: Array<{ trackId: string; fileId: string; content: string }>;
      embeddedSubtitleContent?: Array<{ trackId: string; fileId: string; content: string }>;
      workers?: Array<{ sessionId: string; pid: number }>;
    };
    for (const e of snap.entries ?? []) entries.set(e.fileId, e);
    for (const v of snap.viewers ?? []) viewers.set(v.userId, new Set(v.libraries));
    for (const r of snap.resumes ?? []) resumes.set(`${r.userId}:${r.fileId}`, r);
    for (const h of snap.history ?? []) history.set(h.key, h.list);
    for (const x of snap.externalSubtitles ?? []) externalSubtitles.set(x.fileId, x.tracks);
    for (const c of snap.externalSubtitleContent ?? []) externalSubtitleContent.set(c.trackId, { fileId: c.fileId, content: c.content });
    for (const c of snap.embeddedSubtitleContent ?? []) embeddedSubtitleContent.set(c.trackId, { fileId: c.fileId, content: c.content });
    // Worker records restore BEFORE cleanupOrphans runs at mount, so pids
    // recorded by a crashed instance are killed during startup.
    for (const w of snap.workers ?? []) durableWorkers.set(w.sessionId, w.pid);
  } catch {
    /* corrupt snapshot: start clean rather than fail the mount */
  }
}

let emitFn:
  | ((type: string, payload: Record<string, unknown>, opts?: { correlationId?: string }) => Promise<void>)
  | null = null;

// ---- Transcode worker pool -------------------------------------------------------

interface Worker {
  readonly sessionId: string;
  readonly child: ChildProcess;
  startedAt: number;
  lastProgressAt: number;
}

interface TranscodeConfig {
  /** Max concurrent ffmpeg workers across ALL sessions. */
  maxWorkers: number;
  /** Idle sessions are reaped after this many ms without segment requests. */
  idleTimeoutMs: number;
  /** A worker making no progress for this long is killed by the watchdog. */
  hangTimeoutMs: number;
  /** Command to spawn; tests substitute a fixture worker. */
  ffmpegCommand: string;
  ffmpegArgs: readonly string[];
  qualityLadder: readonly string[];
  /**
   * Directory where workers write their HLS output. When set together with
   * ffmpegArgs containing "{{sessionId}}", a REAL ffmpeg process is spawned
   * per session and the HTTP surface serves its produced segment files.
   * {{sessionIdPlaceholder}} inside an arg expands to
   * <segmentsDir>/<sessionId>.
   */
  segmentsDir: string | null;
}

let config: TranscodeConfig = {
  maxWorkers: 2,
  idleTimeoutMs: 60_000,
  hangTimeoutMs: 15_000,
  ffmpegCommand: "ffmpeg",
  ffmpegArgs: [],
  qualityLadder: ["1080p", "720p", "480p"],
  segmentsDir: null,
};

interface Session {
  readonly sessionId: string;
  readonly fileId: string;
  readonly userId: string;
  readonly qualities: readonly string[];
  createdAt: number;
  lastActivityAt: number;
  closed: boolean;
  closeReason?: string;
}

const sessions = new Map<string, Session>();
const workers = new Map<string, Worker>(); // sessionId -> worker
let watchdogTimer: ReturnType<typeof setInterval> | null = null;

function requireEntry(fileId: string): LibraryEntry {
  const e = entries.get(fileId);
  if (!e) throw new ServingError("not_found", `unknown fileId ${fileId}`);
  return e;
}

/** Fail-closed visibility check. Admin callers pass "*" implicitly upstream. */
function assertVisible(userId: string, libraryId: string): void {
  const libs = viewers.get(userId);
  if (!libs || !(libs.has("*") || libs.has(libraryId)))
    throw new ServingError("forbidden", `viewer may not access library ${libraryId}`);
}

function visibleEntries(userId: string): LibraryEntry[] {
  const libs = viewers.get(userId);
  if (!libs) return [];
  return [...entries.values()].filter((e) => libs.has("*") || libs.has(e.libraryId));
}

// ---- Negotiation ------------------------------------------------------------------

function negotiate(entry: LibraryEntry, caps: BrowserCapabilities, userId: string): PlaybackDecision {
  if (
    caps &&
    typeof caps === "object" &&
    Array.isArray(caps.canPlayContainers) &&
    isDirectPlayable(entry, caps)
  ) {
    return { mode: "direct", streamUrl: `/api/v1/stream/${entry.fileId}` };
  }
  // Unsupported combo → HLS session with selectable qualities.
  return openSession(entry.fileId, "negotiate", config.qualityLadder, userId);
}

// ---- Transcode lifecycle ------------------------------------------------------------

function spawnWorker(session: Session): void {
  if (workers.has(session.sessionId)) return;
  if (workers.size >= config.maxWorkers)
    throw new ServingError("session_limit", `worker cap reached (${config.maxWorkers})`);
  const dir = config.segmentsDir ? `${config.segmentsDir}/${session.sessionId}` : null;
  if (dir) {
    try {
      mkdirSync(dir, { recursive: true });
    } catch {
      /* worker output will fail visibly if this cannot be created */
    }
  }
  const args = config.ffmpegArgs.map((a) =>
    dir && a.includes("{{sessionIdPlaceholder}}")
      ? a.replaceAll("{{sessionIdPlaceholder}}", dir)
      : a === "{{sessionId}}"
        ? session.sessionId
        : a,
  );
  let child: ChildProcess;
  try {
    child = spawn(config.ffmpegCommand, args, { stdio: "ignore" });
  } catch (err) {
    throw new ServingError("no_worker", `failed to spawn worker: ${(err as Error).message}`);
  }
  // Durable worker record: survives a kill -9 of the server so the next
  // mount can SIGKILL the orphaned pid (stateFile snapshot).
  recordWorker({ sessionId: session.sessionId, pid: child.pid ?? 0 });
  child.on("error", () => {
    // Spawn failure surfaces asynchronously on some platforms.
    void closeSession(session.sessionId, "worker_error");
  });
  workers.set(session.sessionId, {
    sessionId: session.sessionId,
    child,
    startedAt: Date.now(),
    lastProgressAt: Date.now(),
  });
}

function openSession(
  fileId: string,
  reason: string,
  qualities: readonly string[],
  userId: string,
): { mode: "hls"; sessionId: string; manifestUrl: string; qualities: readonly string[] } & { reason: string } {
  const sessionId = uuidv7();
  if (!userId) throw new ServingError("invalid_request", "userId required to open a session");
  const session: Session = {
    sessionId,
    fileId,
    userId,
    qualities,
    createdAt: Date.now(),
    lastActivityAt: Date.now(),
    closed: false,
  };
  sessions.set(sessionId, session);
  void emitFn?.(EventTypes.TranscodeSessionOpened, {
    sessionId,
    fileId,
    reason,
    qualities: [...qualities],
    activeSessions: countActiveSessions(),
  });
  ensureWatchdog();
  return {
    mode: "hls",
    sessionId,
    manifestUrl: `/api/v1/hls/${sessionId}/manifest.m3u8`,
    qualities: [...qualities],
    reason,
  };
}

function countActiveSessions(): number {
  let n = 0;
  for (const s of sessions.values()) if (!s.closed) n++;
  return n;
}

/** Durable worker records: sessionId -> pid, persisted in the state file. */
const durableWorkers = new Map<string, number>();

function recordWorker(rec: { sessionId: string; pid: number }): void {
  durableWorkers.set(rec.sessionId, rec.pid);
  persistState();
}

function forgetWorker(sessionId: string): void {
  if (durableWorkers.delete(sessionId)) persistState();
}

async function closeSession(sessionId: string, reason: string): Promise<{ closed: boolean }> {
  const session = sessions.get(sessionId);
  if (!session) throw new ServingError("not_found", `unknown session ${sessionId}`);
  if (session.closed) return { closed: true };
  session.closed = true;
  session.closeReason = reason;
  const worker = workers.get(sessionId);
  if (worker) {
    workers.delete(sessionId);
    try {
      worker.child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }
  forgetWorker(sessionId);
  await emitFn?.(EventTypes.TranscodeSessionClosed, {
    sessionId,
    fileId: session.fileId,
    reason,
    lifetimeMs: Date.now() - session.createdAt,
  });
  return { closed: true };
}

/** Kill -9 recovery: at boot every recorded worker is presumed orphaned. */
async function cleanupOrphans(): Promise<number> {
  let killed = 0;
  for (const [sessionId, worker] of [...workers]) {
    try {
      worker.child.kill("SIGKILL");
    } catch {
      /* best effort */
    }
    workers.delete(sessionId);
    killed++;
  }
  // Durable records: pids written to the state file by a PREVIOUS (crashed)
  // instance. SIGKILL each recorded pid so no orphaned ffmpeg survives a
  // kill -9 of the server itself.
  for (const [sessionId, pid] of [...durableWorkers]) {
    if (pid > 0) {
      try {
        process.kill(pid, "SIGKILL");
        killed++;
      } catch {
        /* already gone — still drop the stale record */
      }
    }
    durableWorkers.delete(sessionId);
  }
  // Sessions with no live worker but stale activity are also swept once at
  // mount so a crashed server never leaves phantom sessions behind.
  for (const s of [...sessions.values()]) {
    if (!s.closed && !workers.has(s.sessionId)) {
      s.closed = true;
      s.closeReason = "startup_cleanup";
      await emitFn?.(EventTypes.TranscodeSessionClosed, {
        sessionId: s.sessionId,
        fileId: s.fileId,
        reason: "startup_cleanup",
      });
    }
  }
  return killed;
}

function ensureWatchdog(): void {
  if (watchdogTimer) return;
  watchdogTimer = setInterval(() => {
    const now = Date.now();
    for (const s of [...sessions.values()]) {
      if (s.closed) {
        // Keep closed sessions queryable for a grace period so clients can
        // observe WHY their session ended (idle/hang/cancel); prune only
        // long-stale ones.
        if (now - s.lastActivityAt > config.idleTimeoutMs * 10 + 60_000) sessions.delete(s.sessionId);
        continue;
      }
      if (now - s.lastActivityAt > config.idleTimeoutMs) {
        void closeSession(s.sessionId, "idle_timeout");
        continue;
      }
      const w = workers.get(s.sessionId);
      if (w && now - w.lastProgressAt > config.hangTimeoutMs) {
        void closeSession(s.sessionId, "hang_watchdog");
      }
    }
  }, 1000);
  // Never hold the event loop open on shutdown.
  watchdogTimer.unref?.();
}

// ---- Handlers ------------------------------------------------------------------------

const plugin: PluginDefinition = definePlugin({
  manifest,
  async mount(ctx) {
    emitFn = async (type, payload, opts) => ctx.emit(type, payload, opts);
    ensureRoots(ctx.config);
    if (typeof ctx.config["stateFile"] === "string" && ctx.config["stateFile"]) {
      stateFile = ctx.config["stateFile"];
      restoreState();
    }
    const orphans = await cleanupOrphans();
    ctx.log("info", `serving mounted; cleaned ${orphans} orphaned worker record(s)`);
  },
  async unmount(ctx) {
    // Cancel every live session and worker on unmount.
    for (const s of [...sessions.values()]) {
      if (!s.closed) await closeSession(s.sessionId, "unmount");
    }
    if (watchdogTimer) {
      clearInterval(watchdogTimer);
      watchdogTimer = null;
    }
    persistState();
    emitFn = null;
    ctx.log("info", "serving unmounted");
  },
  handlers: {
    [SERVING_CAPABILITY]: async (operation, payload) => {
      switch (operation) {
        case "configure": {
          const c = payload as Partial<TranscodeConfig>;
          if (typeof c.maxWorkers === "number" && Number.isInteger(c.maxWorkers) && c.maxWorkers >= 1)
            config.maxWorkers = c.maxWorkers;
          if (typeof c.idleTimeoutMs === "number" && c.idleTimeoutMs > 0) config.idleTimeoutMs = c.idleTimeoutMs;
          if (typeof c.hangTimeoutMs === "number" && c.hangTimeoutMs > 0) config.hangTimeoutMs = c.hangTimeoutMs;
          if (typeof c.ffmpegCommand === "string" && c.ffmpegCommand.length > 0)
            config.ffmpegCommand = c.ffmpegCommand;
          if (Array.isArray(c.ffmpegArgs))
            config.ffmpegArgs = (c.ffmpegArgs as unknown[]).map((a) => String(a));
          if (Array.isArray(c.qualityLadder)) config.qualityLadder = (c.qualityLadder as unknown[]).map((a) => String(a));
          if (typeof c.segmentsDir === "string" && c.segmentsDir.length > 0) config.segmentsDir = c.segmentsDir;
          if (c.segmentsDir === null) config.segmentsDir = null;
          return { configured: true, maxWorkers: config.maxWorkers };
        }

        // ---- Catalog registration (synthetic fixtures in tests) ----
        case "register-entry": {
          const e = payload as unknown as LibraryEntry;
          if (!e || typeof e !== "object") throw new ServingError("invalid_request", "entry required");
          for (const k of ["fileId", "itemKey", "title", "libraryId"] as const)
            if (typeof e[k] !== "string" || !(e[k] as string).length)
              throw new ServingError("invalid_request", `${k} required`);
          entries.set(e.fileId, e);
          // Embedded subtitle content may be declared inline at registration:
          // each track with a `content` field becomes servable by trackId.
          for (const t of e.subtitles ?? []) {
            const content = (t as unknown as { content?: unknown }).content;
            if (typeof content === "string" && typeof t.trackId === "string")
              embeddedSubtitleContent.set(t.trackId, { fileId: e.fileId, content });
          }
          persistState();
          return { registered: e.fileId };
        }
        case "remove-entry": {
          const fileId = String(payload.fileId ?? "");
          if (!entries.delete(fileId)) throw new ServingError("not_found", `unknown fileId ${fileId}`);
          return { removed: fileId };
        }

        // ---- Viewer accounts / visibility ----
        case "set-viewer": {
          const userId = String(payload.userId ?? "");
          if (!userId) throw new ServingError("invalid_request", "userId required");
          const libs = Array.isArray(payload.libraries) ? (payload.libraries as unknown[]).map(String) : [];
          viewers.set(userId, new Set(libs));
          persistState();
          return { userId, libraries: libs };
        }

        case "browse": {
          const userId = String(payload.userId ?? "");
          if (!userId) throw new ServingError("invalid_request", "userId required");
          const items = visibleEntries(userId).map((e) => ({
            fileId: e.fileId,
            itemKey: e.itemKey,
            title: e.title,
            kind: e.kind,
            libraryId: e.libraryId,
          }));
          // Collections: group by kind, plus continue-watching rows.
          const collections = [
            ...new Set(visibleEntries(userId).map((e) => e.kind)),
          ].map((kind) => ({ name: kind === "series" ? "Series" : "Movies", fileIds: items.filter((i) => i.kind === kind).map((i) => i.fileId) }));
          const continueWatching = [...resumes.values()]
            .filter(
              (r) =>
                r.userId === userId &&
                r.positionMs > 0 &&
                r.positionMs < r.durationMs * 0.95 &&
                visibleEntries(userId).some((e) => e.fileId === r.fileId),
            )
            .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
            .slice(0, 20)
            .map((r) => ({ fileId: r.fileId, positionMs: r.positionMs, durationMs: r.durationMs }));
          return { items, collections, continueWatching };
        }

        case "authorize": {
          // Single choke point used by core HTTP before ANY byte leaves:
          // metadata, media, subtitles, playlists, segments, WS updates.
          const userId = String(payload.userId ?? "");
          const fileId = String(payload.fileId ?? "");
          if (!fileId) throw new ServingError("invalid_request", "fileId required");
          const entry = requireEntry(fileId);
          if (!userId) throw new ServingError("invalid_request", "userId required");
          assertVisible(userId, entry.libraryId);
          return { allowed: true, libraryId: entry.libraryId };
        }

        // ---- Negotiation ----
        case "negotiate": {
          const userId = String(payload.userId ?? "");
          const entry = requireEntry(String(payload.fileId ?? ""));
          assertVisible(userId, entry.libraryId);
          const caps = payload.capabilities as BrowserCapabilities;
          const decision = negotiate(entry, caps, userId);
          if (decision.mode === "direct") {
            await emitFn?.(EventTypes.PlaybackStarted, {
              userId,
              fileId: entry.fileId,
              mode: "direct",
            });
          }
          return { decision };
        }

        // ---- Watch state ----
        case "resume-point": {
          const userId = String(payload.userId ?? "");
          const fileId = String(payload.fileId ?? "");
          const entry = requireEntry(fileId);
          assertVisible(userId, entry.libraryId);
          const key = `${userId}:${fileId}`;
          const existing = resumes.get(key);
          return {
            resumePoint: existing ?? null,
          };
        }
        case "set-resume": {
          const userId = String(payload.userId ?? "");
          const fileId = String(payload.fileId ?? "");
          const entry = requireEntry(fileId);
          assertVisible(userId, entry.libraryId);
          const positionMs = Number(payload.positionMs);
          if (!Number.isFinite(positionMs) || positionMs < 0)
            throw new ServingError("invalid_request", "positionMs must be >= 0");
          const key = `${userId}:${fileId}`;
          const prev = resumes.get(key);
          const durationMs =
            payload.durationMs !== undefined
              ? Number(payload.durationMs)
              : // Fall back to the duration already recorded for this item so
                // progress updates that omit it stay comparable.
                prev?.durationMs && prev.durationMs > 0
                ? prev.durationMs
                : requireEntryDuration(fileId);
          if (!Number.isFinite(durationMs) || durationMs < 0)
            throw new ServingError("invalid_request", "durationMs must be >= 0");
          // Monotonic guard EXCEPT explicit rewind (user seeked back):
          // a late-arriving older progress event must not clobber newer.
          const isRewind = payload.allowRewind === true;
          if (prev && !isRewind && positionMs < prev.positionMs - 1000) {
            return { accepted: false, resumePoint: prev };
          }
          const point: ResumePoint = {
            userId,
            fileId,
            positionMs,
            durationMs,
            updatedAt: new Date().toISOString(),
          };
          resumes.set(key, point);
          persistState();
          const completed = durationMs > 0 && positionMs >= durationMs * 0.95;
          const list = history.get(key) ?? [];
          const startedAt = list[0]?.startedAt ?? new Date().toISOString();
          if (list.length === 0)
            await emitFn?.(EventTypes.PlaybackStarted, { userId, fileId, mode: "resume-store" });
          list.unshift({ startedAt, positionMs, completed });
          history.set(key, list.slice(0, 100));
          await emitFn?.(EventTypes.PlaybackProgress, { userId, fileId, positionMs, completed });
          return { accepted: true, resumePoint: point };
        }
        case "history": {
          const userId = String(payload.userId ?? "");
          const fileId = payload.fileId !== undefined ? String(payload.fileId) : null;
          const out: Array<Record<string, unknown>> = [];
          for (const [key, list] of history) {
            if (!key.startsWith(`${userId}:`)) continue;
            const fid = key.split(":").slice(1).join(":");
            if (fileId !== null && fid !== fileId) continue;
            for (const h of list)
              out.push({ userId, fileId: fid, startedAt: h.startedAt, positionMs: h.positionMs, completed: h.completed });
          }
          return { history: out };
        }

        // ---- Subtitles ----
        case "subtitle-inventory": {
          const userId = String(payload.userId ?? "");
          const entry = requireEntry(String(payload.fileId ?? ""));
          assertVisible(userId, entry.libraryId);
          const external = externalSubtitles.get(entry.fileId) ?? [];
          const tracks = [...entry.subtitles, ...external.map((t) => ({ ...t, source: "external" as const }))];
          return { tracks };
        }
        case "add-external-subtitle": {
          const fileId = String(payload.fileId ?? "");
          requireEntry(fileId);
          const lang = String(payload.lang ?? "");
          const format = String(payload.format ?? "");
          if (!["srt", "ass", "pgs"].includes(format))
            throw new ServingError("invalid_request", "format must be srt|ass|pgs");
          if (!lang) throw new ServingError("invalid_request", "lang required");
          const trackId = uuidv7();
          // Optional inline content: when supplied, the route
          // /api/v1/library/subtitles/:trackId serves it back.
          const content = typeof payload.content === "string" ? payload.content : null;
          if (content !== null) externalSubtitleContent.set(trackId, { fileId, content });
          const list = externalSubtitles.get(fileId) ?? [];
          list.push({ trackId, lang, format });
          externalSubtitles.set(fileId, list);
          persistState();
          return { trackId };
        }
        case "subtitle-content": {
          // Serves the CONTENT of one registered subtitle track. Visibility is
          // enforced against the file the track belongs to (fail-closed).
          const userId = String(payload.userId ?? "");
          const trackId = String(payload.trackId ?? "");
          if (!trackId) throw new ServingError("invalid_request", "trackId required");
          const loc = externalSubtitleContent.get(trackId) ?? embeddedSubtitleContent.get(trackId);
          if (!loc) throw new ServingError("not_found", `unknown subtitle track ${trackId}`);
          const entry = requireEntry(loc.fileId);
          assertVisible(userId, entry.libraryId);
          return { trackId, format: "srt", content: loc.content };
        }

        // ---- Transcode sessions ----
        case "open-session": {
          const userId = String(payload.userId ?? "");
          const entry = requireEntry(String(payload.fileId ?? ""));
          assertVisible(userId, entry.libraryId);
          const qualities = Array.isArray(payload.qualities)
            ? (payload.qualities as unknown[]).map(String)
            : config.qualityLadder;
          const out = openSession(entry.fileId, String(payload.reason ?? "manual"), qualities, userId);
          // Explicit sessions stay lazy like negotiation placeholders; both
          // claim their bounded worker at first client contact (manifest or
          // segment fetch) via start-worker/session-touch.
          return out;
        }
        case "close-session":
          return closeSession(String(payload.sessionId ?? ""), String(payload.reason ?? "client_close"));
        case "session-touch": {
          // Segment/manifest request keeps the session alive + feeds watchdog.
          const sessionId = String(payload.sessionId ?? "");
          const s = sessions.get(sessionId);
          if (!s || s.closed) throw new ServingError("not_found", `session ${sessionId} not active`);
          s.lastActivityAt = Date.now();
          const w = workers.get(sessionId);
          if (w) w.lastProgressAt = Date.now();
          return { touched: sessionId };
        }
        case "start-worker": {
          const sessionId = String(payload.sessionId ?? "");
          const s = sessions.get(sessionId);
          if (!s || s.closed) throw new ServingError("not_found", `session ${sessionId} not active`);
          // Bounded pool: each live session reserves a slot for its lifetime.
          // A spawn is refused once live sessions already saturate the pool
          // (the cold-start case — no worker running yet — is always allowed
          // so a lone viewer can always start playback).
          if (workers.size > 0 && !workers.has(sessionId)) {
            let live = 0;
            for (const other of sessions.values()) if (!other.closed) live++;
            if (live >= config.maxWorkers)
              throw new ServingError("session_limit", `worker cap reached (${config.maxWorkers})`);
          }
          spawnWorker(s);
          return { started: sessionId, workers: workers.size };
        }
        case "cancel-session":
          return closeSession(String(payload.sessionId ?? ""), "cancelled");
        case "session-state": {
          const sessionId = String(payload.sessionId ?? "");
          const s = sessions.get(sessionId);
          if (!s) throw new ServingError("not_found", `unknown session ${sessionId}`);
          return {
            sessionId,
            closed: s.closed,
            closeReason: s.closeReason ?? null,
            workerAlive: workers.has(sessionId),
            qualities: s.qualities,
            userId: s.userId,
          };
        }

        case "conformance-probe":
          return { ok: true };

        default:
          throw new Error(`unknown operation ${operation}`);
      }
    },
  },
});

function requireEntryDuration(fileId: string): number {
  const stored = (entries.get(fileId) as unknown as { durationMs?: number })?.durationMs;
  return typeof stored === "number" ? stored : 0;
}

function ensureRoots(cfg: Record<string, unknown>): void {
  const c = cfg as Partial<TranscodeConfig>;
  if (typeof c.maxWorkers === "number" && c.maxWorkers >= 1) config.maxWorkers = c.maxWorkers;
  if (typeof c.idleTimeoutMs === "number" && c.idleTimeoutMs > 0) config.idleTimeoutMs = c.idleTimeoutMs;
  if (typeof c.hangTimeoutMs === "number" && c.hangTimeoutMs > 0) config.hangTimeoutMs = c.hangTimeoutMs;
  if (typeof c.ffmpegCommand === "string") config.ffmpegCommand = c.ffmpegCommand;
  if (Array.isArray(c.ffmpegArgs)) config.ffmpegArgs = (c.ffmpegArgs as unknown[]).map((a) => String(a));
  if (typeof c.segmentsDir === "string" && c.segmentsDir.length > 0) config.segmentsDir = c.segmentsDir;
}

runPlugin(plugin);
