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
  type PlaybackPolicy,
  type ResumePoint,
} from "@tantalar/contracts";

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";

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

const DEFAULT_PLAYBACK_POLICY: PlaybackPolicy = {
  preferDirectPlay: true,
  localBitrateKbps: 40_000,
  remoteBitrateKbps: 8_000,
  maxConcurrentTranscodes: 2,
  hardwareAcceleration: "auto",
  defaultAudioLanguage: "und",
  defaultSubtitleLanguage: "und",
  subtitleMode: "manual",
  transcodeCacheMaxBytes: 10 * 1024 * 1024 * 1024,
  idleTimeoutMs: 60_000,
};
let playbackPolicy: PlaybackPolicy = { ...DEFAULT_PLAYBACK_POLICY };

/**
 * Optional JSON snapshot file for catalog/viewer state. The plugin owns no
 * database (SDK rule), so a remount after a crash restores its catalog,
 * viewer visibility, resume points, history and subtitle inventory from this
 * file when the operator configures `stateFile`.
 */
let stateFile: string | null = null;

/**
 * Wave 3 (TAN-013): durable storage bridge. When core provides one, catalog
 * state lands in the server database (survives restarts without a shared
 * filesystem path). The legacy JSON `stateFile` remains as a fallback for
 * mounts without a document store.
 */
type StorageBridge = {
  get(key: string): Promise<{ doc: unknown; updatedAt: string } | null>;
  put(key: string, doc: unknown): Promise<void>;
  delete(key: string): Promise<boolean>;
};
const STATE_DOC_KEY = "state";
let storeBridge: StorageBridge | null = null;
let startupPromise: Promise<void> | null = null;
const buildSnapshot = () => ({
  entries: [...entries.values()],
  viewers: [...viewers].map(([userId, libs]) => ({ userId, libraries: [...libs] })),
  resumes: [...resumes.values()],
  history: [...history].map(([key, list]) => ({ key, list })),
  externalSubtitles: [...externalSubtitles].map(([fileId, tracks]) => ({ fileId, tracks })),
  externalSubtitleContent: [...externalSubtitleContent].map(([trackId, v]) => ({ trackId, ...v })),
  embeddedSubtitleContent: [...embeddedSubtitleContent].map(([trackId, v]) => ({ trackId, ...v })),
  workers: [...durableWorkers].map(([sessionId, pid]) => ({ sessionId, pid })),
  playbackPolicy,
});

function applySnapshot(snap: Record<string, unknown>): void {
  const s = snap as {
    entries?: LibraryEntry[];
    viewers?: Array<{ userId: string; libraries: string[] }>;
    resumes?: ResumePoint[];
    history?: Array<{ key: string; list: Array<{ startedAt: string; positionMs: number; completed: boolean }> }>;
    externalSubtitles?: Array<{ fileId: string; tracks: Array<{ trackId: string; lang: string; format: string }> }>;
    externalSubtitleContent?: Array<{ trackId: string; fileId: string; content: string }>;
    embeddedSubtitleContent?: Array<{ trackId: string; fileId: string; content: string }>;
    workers?: Array<{ sessionId: string; pid: number }>;
    playbackPolicy?: PlaybackPolicy;
  };
  for (const e of s.entries ?? []) entries.set(e.fileId, e);
  for (const v of s.viewers ?? []) viewers.set(v.userId, new Set(v.libraries));
  for (const r of s.resumes ?? []) resumes.set(`${r.userId}:${r.fileId}`, r);
  for (const h of s.history ?? []) history.set(h.key, h.list);
  for (const x of s.externalSubtitles ?? []) externalSubtitles.set(x.fileId, x.tracks);
  for (const c of s.externalSubtitleContent ?? []) externalSubtitleContent.set(c.trackId, { fileId: c.fileId, content: c.content });
  for (const c of s.embeddedSubtitleContent ?? []) embeddedSubtitleContent.set(c.trackId, { fileId: c.fileId, content: c.content });
  // Worker records restore BEFORE cleanupOrphans runs at mount, so pids
  // recorded by a crashed instance are killed during startup.
  for (const w of s.workers ?? []) durableWorkers.set(w.sessionId, w.pid);
  if (s.playbackPolicy) setPlaybackPolicy(s.playbackPolicy, false);
}

function persistState(): void {
  const snapshot = buildSnapshot();
  if (stateFile) {
    try {
      writeFileSync(stateFile, JSON.stringify(snapshot));
    } catch {
      /* best-effort persistence; serving continues from memory */
    }
  }
  void storeBridge?.put(STATE_DOC_KEY, snapshot).catch(() => undefined);
}

async function restoreState(): Promise<void> {
  // Durable document store wins when present; fall back to the file.
  if (storeBridge) {
    try {
      const hit = await storeBridge.get(STATE_DOC_KEY);
      if (hit && hit.doc && typeof hit.doc === "object") applySnapshot(hit.doc as Record<string, unknown>);
      else restoreFromFile();
    } catch {
      restoreFromFile();
    }
    return;
  }
  restoreFromFile();
}

function restoreFromFile(): void {
  if (!stateFile || !existsSync(stateFile)) return;
  try {
    const snap = JSON.parse(readFileSync(stateFile, "utf8")) as Record<string, unknown>;
    applySnapshot(snap);
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
   * ffmpegArgs containing "{{sessionIdPlaceholder}}", a REAL ffmpeg process is spawned
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
  readonly mode: "direct" | "hls";
  readonly reason: string;
  readonly client: string;
  readonly network: "local" | "remote";
  readonly maxBitrateKbps: number;
  readonly qualities: readonly string[];
  readonly audioStreamIndex: number | null;
  readonly audioLanguage: string | null;
  readonly subtitleTrackId: string | null;
  createdAt: number;
  lastActivityAt: number;
  positionMs: number;
  durationMs: number;
  closed: boolean;
  closeReason?: string;
  endedAt?: number;
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

interface TrackSelection {
  audioStreamIndex: number | null;
  audioLanguage: string | null;
  subtitleTrackId: string | null;
}

function selectTracks(entry: LibraryEntry, caps: BrowserCapabilities): TrackSelection {
  const audioTracks = entry.audioTracks ?? [];
  const defaultAudio = audioTracks.find((track) => track.default) ?? audioTracks[0];
  const requestedAudio = playbackPolicy.defaultAudioLanguage.toLowerCase();
  const audio = requestedAudio === "und"
    ? defaultAudio
    : audioTracks.find((track) => track.lang.toLowerCase() === requestedAudio) ?? defaultAudio;
  const requestedSubtitle = playbackPolicy.defaultSubtitleLanguage.toLowerCase();
  const directSubtitles = caps?.canDirectSubtitles ?? [];
  const subtitle = playbackPolicy.subtitleMode === "always"
    ? entry.subtitles.find((track) => track.lang.toLowerCase() === requestedSubtitle
      && directSubtitles.includes(track.format))
      ?? entry.subtitles.find((track) => track.default && directSubtitles.includes(track.format))
    : undefined;
  return {
    audioStreamIndex: audio?.streamIndex ?? null,
    audioLanguage: audio?.lang ?? null,
    subtitleTrackId: subtitle?.trackId ?? null,
  };
}

function directPlayEligible(entry: LibraryEntry, caps: BrowserCapabilities, selection: TrackSelection): boolean {
  const defaultAudio = entry.audioTracks?.find((track) => track.default) ?? entry.audioTracks?.[0];
  return Boolean(
    caps &&
    typeof caps === "object" &&
    Array.isArray(caps.canPlayContainers) &&
    isDirectPlayable(entry, caps)
    && (selection.audioStreamIndex === null || selection.audioStreamIndex === defaultAudio?.streamIndex)
  );
}

function playbackReason(entry: LibraryEntry, caps: BrowserCapabilities, mode: "direct" | "hls"): string {
  if (mode === "direct") return "The browser supports the file container, video codec and audio codec.";
  if (!playbackPolicy.preferDirectPlay) return "Playback policy prefers transcoding.";
  if (!caps?.canPlayContainers?.includes(entry.container)) return `The browser does not support the ${entry.container} container.`;
  if (!caps?.canPlayVideo?.includes(entry.videoCodec)) return `The browser does not support ${entry.videoCodec} video.`;
  if (!caps?.canPlayAudio?.includes(entry.audioCodec)) return `The browser does not support ${entry.audioCodec} audio.`;
  return "The file requires a browser-compatible HLS rendition.";
}

function negotiate(
  entry: LibraryEntry,
  caps: BrowserCapabilities,
  userId: string,
  client: string,
  network: "local" | "remote",
): PlaybackDecision {
  const selection = selectTracks(entry, caps);
  const direct = playbackPolicy.preferDirectPlay && directPlayEligible(entry, caps, selection);
  const reason = playbackReason(entry, caps, direct ? "direct" : "hls");
  if (direct) {
    const session = openSession(entry.fileId, "direct", reason, [], userId, client, network, selection);
    void emitFn?.(EventTypes.PlaybackStarted, {
      sessionId: session.sessionId,
      userId,
      fileId: entry.fileId,
      mode: "direct",
    }, { correlationId: session.sessionId });
    return session;
  }
  return openSession(entry.fileId, "hls", reason, config.qualityLadder, userId, client, network, selection);
}

// ---- Transcode lifecycle ------------------------------------------------------------

function spawnWorker(session: Session, inputPath?: string): void {
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
  if (config.ffmpegArgs.some((arg) => arg.includes("{{inputPath}}")) && !inputPath) {
    throw new ServingError("no_worker", "transcoder input path was not supplied");
  }
  const args = config.ffmpegArgs.map((arg, index) => {
    let resolved = arg;
    if (dir) resolved = resolved.replaceAll("{{sessionIdPlaceholder}}", dir);
    if (inputPath) resolved = resolved.replaceAll("{{inputPath}}", inputPath);
    if (resolved === "0:a:0?" && session.audioStreamIndex !== null) resolved = `0:${session.audioStreamIndex}?`;
    if (config.ffmpegArgs[index - 1] === "-maxrate") resolved = `${session.maxBitrateKbps}k`;
    if (config.ffmpegArgs[index - 1] === "-bufsize") resolved = `${session.maxBitrateKbps * 2}k`;
    return resolved === "{{sessionId}}" ? session.sessionId : resolved;
  });
  const inputIndex = args.indexOf("-i");
  if (inputIndex >= 0 && playbackPolicy.hardwareAcceleration !== "software") {
    args.splice(inputIndex, 0, "-hwaccel", playbackPolicy.hardwareAcceleration);
  }
  if (args.includes("hls")) {
    const outputIndex = Math.max(0, args.length - 1);
    args.splice(outputIndex, 0, "-fs", String(playbackPolicy.transcodeCacheMaxBytes));
  }
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
  mode: "direct" | "hls",
  reason: string,
  qualities: readonly string[],
  userId: string,
  client = "Unknown web client",
  network: "local" | "remote" = "remote",
  selection: TrackSelection = { audioStreamIndex: null, audioLanguage: null, subtitleTrackId: null },
): PlaybackDecision & { reason: string } {
  const sessionId = uuidv7();
  if (!userId) throw new ServingError("invalid_request", "userId required to open a session");
  const session: Session = {
    sessionId,
    fileId,
    userId,
    mode,
    reason,
    client: client.slice(0, 160),
    network,
    maxBitrateKbps: network === "local" ? playbackPolicy.localBitrateKbps : playbackPolicy.remoteBitrateKbps,
    qualities,
    audioStreamIndex: selection.audioStreamIndex,
    audioLanguage: selection.audioLanguage,
    subtitleTrackId: selection.subtitleTrackId,
    createdAt: Date.now(),
    lastActivityAt: Date.now(),
    positionMs: 0,
    durationMs: 0,
    closed: false,
  };
  sessions.set(sessionId, session);
  if (mode === "hls") {
    void emitFn?.(EventTypes.TranscodeSessionOpened, {
      sessionId,
      fileId,
      reason,
      qualities: [...qualities],
      activeSessions: countActiveSessions(),
    }, { correlationId: sessionId });
  }
  ensureWatchdog();
  const selected = {
    ...(selection.audioLanguage ? { audioLanguage: selection.audioLanguage } : {}),
    ...(selection.subtitleTrackId ? { subtitleTrackId: selection.subtitleTrackId } : {}),
  };
  if (mode === "direct") return { mode: "direct", sessionId, streamUrl: `/api/v1/stream/${fileId}?sessionId=${encodeURIComponent(sessionId)}`, reason, ...selected };
  return {
    mode: "hls",
    sessionId,
    manifestUrl: `/api/v1/hls/${sessionId}/manifest.m3u8`,
    qualities: [...qualities],
    reason,
    ...selected,
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
  session.endedAt = Date.now();
  session.lastActivityAt = session.endedAt;
  const worker = workers.get(sessionId);
  const removeOutput = () => {
    if (!config.segmentsDir) return;
    try {
      rmSync(`${config.segmentsDir}/${sessionId}`, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup after the worker exits */
    }
  };
  if (worker) {
    workers.delete(sessionId);
    if (worker.child.exitCode !== null) {
      removeOutput();
    } else {
      worker.child.once("exit", removeOutput);
      try {
        worker.child.kill("SIGKILL");
      } catch {
        /* already gone */
        removeOutput();
      }
    }
  } else {
    removeOutput();
  }
  forgetWorker(sessionId);
  if (session.mode === "hls") {
    await emitFn?.(EventTypes.TranscodeSessionClosed, {
      sessionId,
      fileId: session.fileId,
      reason,
      lifetimeMs: Date.now() - session.createdAt,
    }, { correlationId: sessionId });
  }
  await emitFn?.(EventTypes.PlaybackEnded, {
    sessionId,
    fileId: session.fileId,
    userId: session.userId,
    mode: session.mode,
    reason,
    positionMs: session.positionMs,
    durationMs: session.durationMs,
  }, { correlationId: sessionId });
  return { closed: true };
}

function assertPolicy(input: PlaybackPolicy): PlaybackPolicy {
  const integer = (value: number, min: number, max: number, name: string) => {
    if (!Number.isInteger(value) || value < min || value > max) throw new ServingError("invalid_request", `${name} is out of range`);
    return value;
  };
  const language = (value: string, name: string) => {
    if (!/^(?:und|[a-z]{2,3}(?:-[A-Z]{2})?)$/.test(value)) throw new ServingError("invalid_request", `${name} is invalid`);
    return value;
  };
  if (!["manual", "always", "off"].includes(input.subtitleMode)) throw new ServingError("invalid_request", "subtitleMode is invalid");
  if (!/^[a-z0-9_-]{2,32}$/i.test(input.hardwareAcceleration)) throw new ServingError("invalid_request", "hardwareAcceleration is invalid");
  return {
    preferDirectPlay: input.preferDirectPlay === true,
    localBitrateKbps: integer(input.localBitrateKbps, 500, 200_000, "localBitrateKbps"),
    remoteBitrateKbps: integer(input.remoteBitrateKbps, 500, 200_000, "remoteBitrateKbps"),
    maxConcurrentTranscodes: integer(input.maxConcurrentTranscodes, 1, 32, "maxConcurrentTranscodes"),
    hardwareAcceleration: input.hardwareAcceleration,
    defaultAudioLanguage: language(input.defaultAudioLanguage, "defaultAudioLanguage"),
    defaultSubtitleLanguage: language(input.defaultSubtitleLanguage, "defaultSubtitleLanguage"),
    subtitleMode: input.subtitleMode,
    transcodeCacheMaxBytes: integer(input.transcodeCacheMaxBytes, 256 * 1024 * 1024, 1024 * 1024 * 1024 * 1024, "transcodeCacheMaxBytes"),
    idleTimeoutMs: integer(input.idleTimeoutMs, 10_000, 24 * 60 * 60 * 1000, "idleTimeoutMs"),
  };
}

function setPlaybackPolicy(input: PlaybackPolicy, persist = true): PlaybackPolicy {
  playbackPolicy = assertPolicy(input);
  config.maxWorkers = playbackPolicy.maxConcurrentTranscodes;
  config.idleTimeoutMs = playbackPolicy.idleTimeoutMs;
  if (persist) persistState();
  return playbackPolicy;
}

function sessionRecord(session: Session) {
  const entry = entries.get(session.fileId);
  return {
    sessionId: session.sessionId,
    fileId: session.fileId,
    title: entry?.title ?? "Unknown title",
    userId: session.userId,
    client: session.client,
    network: session.network,
    mode: session.mode,
    state: session.closed ? "ended" : workers.has(session.sessionId) ? "transcoding" : session.mode === "hls" ? "waiting" : "playing",
    positionMs: session.positionMs,
    durationMs: session.durationMs,
    startedAt: new Date(session.createdAt).toISOString(),
    endedAt: session.endedAt ? new Date(session.endedAt).toISOString() : null,
    closeReason: session.closeReason ?? null,
    workerAlive: workers.has(session.sessionId),
    maxBitrateKbps: session.maxBitrateKbps,
    audioLanguage: session.audioLanguage,
    subtitleTrackId: session.subtitleTrackId,
  };
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
    storeBridge = ctx.storage ?? null;
    ensureRoots(ctx.config);
    if (typeof ctx.config["stateFile"] === "string" && ctx.config["stateFile"]) {
      stateFile = ctx.config["stateFile"];
    }
    // Restore from the durable document store (preferred) or the legacy
    // snapshot file; orphan-worker cleanup runs AFTER restore so recorded
    // pids from a crashed instance are killed during startup.
    const startup = (async () => {
      await restoreState();
      const orphans = await cleanupOrphans();
      ctx.log("info", `serving mounted; cleaned ${orphans} orphaned worker record(s)`);
    })();
    startupPromise = startup;
    try {
      await startup;
    } finally {
      if (startupPromise === startup) startupPromise = null;
    }
  },
  async unmount(ctx) {
    await startupPromise;
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
    storeBridge = null;
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
        case "playback-policy":
          return { policy: playbackPolicy };
        case "set-playback-policy": {
          const policy = setPlaybackPolicy(payload as unknown as PlaybackPolicy);
          await emitFn?.(EventTypes.PlaybackPolicyUpdated, {
            maxConcurrentTranscodes: policy.maxConcurrentTranscodes,
            preferDirectPlay: policy.preferDirectPlay,
            hardwareAcceleration: policy.hardwareAcceleration,
          });
          return { policy };
        }
        case "playback-sessions": {
          const recentCutoff = Date.now() - 60 * 60 * 1000;
          return {
            sessions: [...sessions.values()]
              .filter((session) => !session.closed || (session.endedAt ?? 0) >= recentCutoff)
              .sort((a, b) => b.createdAt - a.createdAt)
              .map(sessionRecord),
          };
        }
        case "preview-decision": {
          const entry = requireEntry(String(payload.fileId ?? ""));
          const caps = payload.capabilities as BrowserCapabilities;
          const network = payload.network === "local" ? "local" : "remote";
          const selection = selectTracks(entry, caps);
          const mode = playbackPolicy.preferDirectPlay && directPlayEligible(entry, caps, selection) ? "direct" : "hls";
          return {
            fileId: entry.fileId,
            title: entry.title,
            mode,
            reason: playbackReason(entry, caps, mode),
            video: mode === "direct" ? `${entry.videoCodec} passthrough` : `${entry.videoCodec} to H.264`,
            audio: `${selection.audioLanguage ?? "default"} · ${mode === "direct" ? `${entry.audioCodec} passthrough` : `${entry.audioCodec} to AAC`}`,
            subtitles: selection.subtitleTrackId ?? playbackPolicy.subtitleMode,
            maxBitrateKbps: network === "local" ? playbackPolicy.localBitrateKbps : playbackPolicy.remoteBitrateKbps,
            network,
          };
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
          const decision = negotiate(
            entry,
            caps,
            userId,
            typeof payload.client === "string" ? payload.client : "Unknown web client",
            payload.network === "local" ? "local" : "remote",
          );
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
          for (const session of sessions.values()) {
            if (!session.closed && session.userId === userId && session.fileId === fileId) {
              session.positionMs = positionMs;
              session.durationMs = durationMs;
              session.lastActivityAt = Date.now();
            }
          }
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
          if (!userId) throw new ServingError("invalid_request", "userId required");
          const fileId = payload.fileId !== undefined ? String(payload.fileId) : null;
          const visible = new Map(visibleEntries(userId).map((entry) => [entry.fileId, entry]));
          const out = [...resumes.values()]
            .filter((point) => {
              if (point.userId !== userId || !visible.has(point.fileId)) return false;
              return fileId === null || point.fileId === fileId;
            })
            .sort(
              (a, b) =>
                b.updatedAt.localeCompare(a.updatedAt) || a.fileId.localeCompare(b.fileId),
            )
            .map((point) => {
              const entry = visible.get(point.fileId)!;
              return {
                fileId: point.fileId,
                title: entry.title,
                kind: entry.kind,
                positionMs: point.positionMs,
                durationMs: point.durationMs,
                completed:
                  point.durationMs > 0 && point.positionMs >= point.durationMs * 0.95,
                lastWatchedAt: point.updatedAt,
                artworkUrl: null,
              };
            });
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
          const out = openSession(
            entry.fileId,
            "hls",
            String(payload.reason ?? "manual"),
            qualities,
            userId,
            typeof payload.client === "string" ? payload.client : "Unknown web client",
            payload.network === "local" ? "local" : "remote",
            selectTracks(entry, payload.capabilities as BrowserCapabilities),
          );
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
          if (payload.positionMs !== undefined) {
            const positionMs = Number(payload.positionMs);
            if (Number.isFinite(positionMs) && positionMs >= 0) s.positionMs = positionMs;
          }
          if (payload.durationMs !== undefined) {
            const durationMs = Number(payload.durationMs);
            if (Number.isFinite(durationMs) && durationMs >= 0) s.durationMs = durationMs;
          }
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
          const inputPath = typeof payload.inputPath === "string" ? payload.inputPath : undefined;
          const alreadyStarted = workers.has(sessionId);
          spawnWorker(s, inputPath);
          if (!alreadyStarted) {
            await emitFn?.(EventTypes.PlaybackStarted, {
              sessionId,
              userId: s.userId,
              fileId: s.fileId,
              mode: "hls",
            }, { correlationId: sessionId });
          }
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
            fileId: s.fileId,
            closed: s.closed,
            closeReason: s.closeReason ?? null,
            workerAlive: workers.has(sessionId),
            qualities: s.qualities,
            userId: s.userId,
            mode: s.mode,
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
