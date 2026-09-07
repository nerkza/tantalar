/**
 * dev.tantalar.plugin.torrent-native (TAN-009, TAN-012) — embedded torrent
 * engine plugin. First-party; speaks the provider-neutral download-client
 * schema from @tantalar/contracts plus a torrent-engine capability surface
 * (piece verification, file selection, storage safety).
 *
 * NO qBittorrent or any external daemon: transfers run through the injected
 * TorrentEngine seam. Tests use MemoryTorrentEngine with legal synthetic
 * .torrent fixtures — no real trackers, no copyrighted content.
 *
 * Tantalar owns everything else here:
 *  - Durable job + resume state via ctx.storage (core DB, survives restart);
 *  - Storage-safety controls: root containment fail-closed on every write,
 *    free-space stop thresholds (fs.statfs), per-root quotas, cleanup;
 *  - Queue order, pause/resume/retry/recovery;
 *  - Events for every mutation with the caller's correlationId.
 */
import { lstatSync, readFileSync, statfsSync } from "node:fs";
import { isAbsolute, join, resolve, sep } from "node:path";
import { runPlugin, definePlugin, cacheReleaseSource, type PluginContext, type PluginDefinition } from "@tantalar/plugin-sdk";
import {
  PROTOCOL_VERSION,
  validateManifest,
  validateDownloadRequest,
  DownloadClientError,
  EventTypes,
  type DownloadRequest,
  type DownloadState,
  type DownloadStatus,
} from "@tantalar/contracts";
import {
  DEFAULT_TORRENT_LIMITS,
  MemoryTorrentEngine,
  parseMagnet,
  parseTorrentFile,
  type EngineTorrent,
  type TorrentEngine,
} from "./engine.js";
import { WebTorrentEngine } from "./webtorrent-engine.js";
import {
  TRACKER_RULES_CAPABILITY,
  matchTrackerRule,
  evaluateObligations,
  validateTrackerRule,
  TrackerRuleError,
  type TrackerRule,
  type ObligationReport,
  type SeedingStats,
} from "@tantalar/contracts";

const CLIENT_CAPABILITY = "dev.tantalar.capability.download-client";
const ENGINE_CAPABILITY = "dev.tantalar.capability.torrent.engine";
const PLUGIN_ID = "dev.tantalar.plugin.torrent-native";

const RESUME_KEY = "resume-state";
const ROOTS_KEY = "configured-download-roots";
const MAX_DOWNLOAD_ROOTS = 32;
const MAX_ROOT_PATH_BYTES = 4_096;

interface EngineConfig {
  /** Absolute directories the engine may write into. Required: fail closed without one. */
  downloadRoots: string[];
  /** Stop all transfers when a root's free space falls below this (bytes). */
  minFreeBytes: number;
  /** Per-job byte quota (0 = unlimited). */
  maxJobBytes: number;
  /** Max concurrent downloading jobs (queue order control). */
  maxConcurrent: number;
  /** Real transport by default. Memory is an explicit deterministic test seam. */
  engineMode: "webtorrent" | "memory";
  /** Public tracker discovery remains unavailable until the VPN boundary ships. */
  trackerMode: "disabled" | "loopback";
  maxMetadataBytes: number;
  maxTorrentFiles: number;
  maxTorrentPathBytes: number;
  maxTorrentPieces: number;
  metadataTimeoutMs: number;
  progressIntervalMs: number;
  /**
   * Test/deterministic seam: when set (>= 0), freeBytes reports exactly this
   * value instead of querying the filesystem. Ambient disk activity cannot
   * invalidate threshold checks while it is active.
   */
  freeBytesOverride?: number;
}

function boundedNumber(
  raw: unknown,
  fallback: number,
  name: string,
  minimum: number,
  maximum: number,
): number {
  const value = raw === undefined || raw === null ? fallback : Number(raw);
  if (!Number.isFinite(value) || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`torrent-native: ${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

function loadConfig(): EngineConfig {
  const raw = JSON.parse(process.env["TANTALAR_PLUGIN_CONFIG"] ?? "{}") as Record<string, unknown>;
  const roots = Array.isArray(raw.downloadRoots)
    ? (raw.downloadRoots as unknown[]).map(String).filter((r) => r.trim().length > 0)
    : [];
  return {
    downloadRoots: roots.map((r) => resolve(r)),
    minFreeBytes: boundedNumber(raw.minFreeBytes, 0, "minFreeBytes", 0, Number.MAX_SAFE_INTEGER),
    maxJobBytes: boundedNumber(raw.maxJobBytes, 0, "maxJobBytes", 0, Number.MAX_SAFE_INTEGER),
    maxConcurrent: boundedNumber(raw.maxConcurrent, 2, "maxConcurrent", 1, 1_000),
    engineMode: raw.engineMode === "memory" ? "memory" : "webtorrent",
    trackerMode: raw.trackerMode === "loopback" ? "loopback" : "disabled",
    maxMetadataBytes: boundedNumber(
      raw.maxMetadataBytes,
      DEFAULT_TORRENT_LIMITS.maxMetadataBytes,
      "maxMetadataBytes",
      16 * 1024,
      10 * 1024 * 1024,
    ),
    maxTorrentFiles: boundedNumber(raw.maxTorrentFiles, DEFAULT_TORRENT_LIMITS.maxFiles, "maxTorrentFiles", 1, 100_000),
    maxTorrentPathBytes: boundedNumber(
      raw.maxTorrentPathBytes,
      DEFAULT_TORRENT_LIMITS.maxPathBytes,
      "maxTorrentPathBytes",
      64,
      16 * 1024,
    ),
    maxTorrentPieces: boundedNumber(
      raw.maxTorrentPieces,
      DEFAULT_TORRENT_LIMITS.maxPieces,
      "maxTorrentPieces",
      1,
      4_000_000,
    ),
    metadataTimeoutMs: boundedNumber(raw.metadataTimeoutMs, 30_000, "metadataTimeoutMs", 1_000, 120_000),
    progressIntervalMs: boundedNumber(raw.progressIntervalMs, 1_000, "progressIntervalMs", 250, 10_000),
    ...(raw.freeBytesOverride !== undefined && raw.freeBytesOverride !== null
      ? { freeBytesOverride: Number(raw.freeBytesOverride) }
      : {}),
  };
}

function validateDownloadRoots(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    throw new DownloadClientError("invalid_request", "downloadRoots must be an array");
  }
  if (raw.length > MAX_DOWNLOAD_ROOTS) {
    throw new DownloadClientError(
      "invalid_request",
      `downloadRoots cannot contain more than ${MAX_DOWNLOAD_ROOTS} entries`,
    );
  }

  const roots: string[] = [];
  const seen = new Set<string>();
  for (const value of raw) {
    if (typeof value !== "string" || value.length === 0 || value !== value.trim()) {
      throw new DownloadClientError("invalid_request", "each download root must be a non-empty path without surrounding whitespace");
    }
    if (!isAbsolute(value) || Buffer.byteLength(value, "utf8") > MAX_ROOT_PATH_BYTES || /[\0-\x1f\x7f]/u.test(value)) {
      throw new DownloadClientError("invalid_request", "each download root must be a valid bounded absolute path");
    }
    const root = resolve(value);
    let stat: ReturnType<typeof lstatSync>;
    try {
      stat = lstatSync(root);
    } catch {
      throw new DownloadClientError("invalid_request", `download root does not exist: ${root}`);
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new DownloadClientError("invalid_request", `download root must be a real directory, not a symlink: ${root}`);
    }
    if (!seen.has(root)) {
      seen.add(root);
      roots.push(root);
    }
  }
  return roots;
}

// ---- Durable resume document ----------------------------------------------------

interface StoredJob {
  itemKey: string;
  title: string;
  infoHash: string;
  sourceKind: "file" | "magnet";
  sourcePath?: string;
  magnetUri?: string;
  downloadId: string;
  queuePosition: number;
  selectedFiles?: string[];
  downloadPath?: string;
  failedReason?: string;
  correlationId?: string;
}

interface ResumeDoc {
  jobs: Record<string, StoredJob>; // downloadId -> job
  seq: number;
  /** TAN-015: per-tracker rules, durable across restart. */
  rules?: Record<string, TrackerRule>;
}

function emptyResume(): ResumeDoc {
  return { jobs: {}, seq: 0, rules: {} };
}

let emitFn: PluginContext["emit"] | null = null;
let logFn: PluginContext["log"] | null = null;
/** Cross-capability invoke bridge for the kill-switch gate (null when unmounted). */
let invokeCtx: Pick<PluginContext, "invoke"> | null = null;
let storeGet: ((key: string) => Promise<{ doc: unknown } | null>) | null = null;
let storePut: ((key: string, doc: unknown) => Promise<void>) | null = null;
let progressTimer: NodeJS.Timeout | null = null;
let progressPollActive = false;
const lastPublishedProgress = new Map<string, string>();

let cfg: EngineConfig = loadConfig();
let engine: TorrentEngine = new MemoryTorrentEngine();
let engineInjected = false;
/** Swap the transport (tests inject MemoryTorrentEngine seeds this way). */
export function setEngine(next: TorrentEngine): void {
  engine = next;
  engineInjected = true;
}
export function currentEngine(): TorrentEngine {
  return engine;
}

async function loadResume(): Promise<ResumeDoc> {
  if (!storeGet) throw new Error("not mounted");
  const hit = await storeGet(RESUME_KEY);
  if (!hit || typeof hit.doc !== "object" || hit.doc === null) return emptyResume();
  const doc = hit.doc as Partial<ResumeDoc>;
  return { jobs: doc.jobs ?? {}, seq: doc.seq ?? 0, rules: doc.rules ?? {} };
}

async function saveResume(doc: ResumeDoc): Promise<void> {
  if (!storePut) throw new Error("not mounted");
  await storePut(RESUME_KEY, doc);
}

async function loadConfiguredRoots(): Promise<string[] | null> {
  if (!storeGet) throw new Error("not mounted");
  const hit = await storeGet(ROOTS_KEY);
  if (!hit) return null;
  const doc = hit.doc as { downloadRoots?: unknown } | null;
  return validateDownloadRoots(doc?.downloadRoots);
}

async function saveConfiguredRoots(downloadRoots: string[]): Promise<void> {
  if (!storePut) throw new Error("not mounted");
  await storePut(ROOTS_KEY, { downloadRoots });
}

// ---- Storage safety helpers (TAN-012) ---------------------------------------------

/** Fail closed unless `p` sits inside one of the configured download roots. */
export function containedInRoot(p: string): string | null {
  return containedInRoots(p, cfg.downloadRoots);
}

function containedInRoots(p: string, roots: string[]): string | null {
  const abs = resolve(p);
  for (const root of roots) {
    if (abs === root || abs.startsWith(root + sep)) return root;
  }
  return null;
}

export function assertContained(p: string): string {
  const root = containedInRoot(p);
  if (!root) throw new DownloadClientError("blocked", `path outside configured download roots: ${p}`);
  return root;
}

/** Free bytes on the filesystem of `dir`; null when unsupported. */
export function freeBytes(dir: string): number | null {
  // Deterministic seam (tests): a configured override pins the reported
  // value so ambient disk activity cannot flip a threshold check.
  if (cfg.freeBytesOverride !== undefined) return cfg.freeBytesOverride;
  try {
    // Node >= 18.15 exposes statfs on Linux/macOS.
    const s = statfsSync(dir);
    return s.bavail * s.bsize;
  } catch {
    return null;
  }
}

export function assertStorageSafe(jobSizeBytes: number): void {
  if (cfg.downloadRoots.length === 0) {
    throw new DownloadClientError("blocked", "no download roots configured");
  }
  for (const root of cfg.downloadRoots) {
    const free = freeBytes(root);
    if (free !== null && free < cfg.minFreeBytes) {
      throw new DownloadClientError(
        "blocked",
        `free-space threshold: ${root} has ${free} bytes, minimum ${cfg.minFreeBytes}`,
      );
    }
  }
  if (cfg.maxJobBytes > 0 && jobSizeBytes > cfg.maxJobBytes) {
    throw new DownloadClientError("blocked", `job size ${jobSizeBytes} exceeds quota ${cfg.maxJobBytes}`);
  }
}

// ---- Job state mapping ------------------------------------------------------------

function statusOf(downloadId: string, job: StoredJob, t: EngineTorrent): DownloadStatus {
  const progress = t.sizeBytes > 0 ? Math.round((t.receivedBytes / t.sizeBytes) * 100) : 0;
  let state: DownloadState;
  if (t.done && t.piecesVerified >= t.piecesTotal && t.piecesTotal > 0) state = "completed";
  else if (job.failedReason) state = "failed";
  else if (t.paused) state = "paused";
  else if (t.piecesVerified === 0 && t.receivedBytes === 0) state = "queued";
  else state = "downloading";
  return {
    downloadId,
    itemKey: job.itemKey,
    state,
    progressPercent: Math.min(100, progress),
    sizeBytes: t.sizeBytes,
    receivedBytes: t.receivedBytes,
    ...(job.failedReason !== undefined ? { error: job.failedReason } : {}),
  };
}

function jobEventOptions(job: StoredJob): { correlationId?: string } | undefined {
  return job.correlationId ? { correlationId: job.correlationId } : undefined;
}

async function publishJobStatus(downloadId: string, job: StoredJob, torrent: EngineTorrent): Promise<void> {
  if (!emitFn) return;
  const status = statusOf(downloadId, job, torrent);
  const key = `${status.state}:${status.progressPercent}`;
  if (lastPublishedProgress.get(downloadId) === key) return;
  lastPublishedProgress.set(downloadId, key);
  const type = status.state === "completed"
    ? EventTypes.DownloadCompleted
    : status.state === "failed"
      ? EventTypes.DownloadFailed
      : EventTypes.DownloadProgress;
  await emitFn(type, {
    downloadId,
    itemKey: job.itemKey,
    state: status.state,
    progressPercent: status.progressPercent,
    sizeBytes: status.sizeBytes,
    ...(status.error ? { error: status.error } : {}),
  }, jobEventOptions(job));
}

// ---- Tracker rules (TAN-015) ---------------------------------------------------

function statsOf(t: EngineTorrent): SeedingStats {
  const ratio = t.receivedBytes > 0 ? t.uploadedBytes / t.receivedBytes : t.uploadedBytes > 0 ? Infinity : 0;
  return {
    uploadedBytes: t.uploadedBytes,
    downloadedBytes: t.receivedBytes,
    seedingSeconds: t.seedingSeconds,
    ratio,
  };
}

async function listRules(): Promise<{ rules: TrackerRule[] }> {
  const doc = await loadResume();
  return { rules: Object.values(doc.rules ?? {}).sort((a, b) => a.name.localeCompare(b.name)) };
}

async function putRule(payload: Record<string, unknown>): Promise<TrackerRule> {
  const input = validateTrackerRule(payload);
  const doc = await loadResume();
  doc.rules ??= {};
  const id = typeof payload.id === "string" && payload.id.trim() ? payload.id.trim() : `rule-${Object.keys(doc.rules).length + 1}`;
  const existing = doc.rules[id];
  const name = input.name.trim();
  if (!existing && Object.values(doc.rules).some((r) => r.name.toLowerCase() === name.toLowerCase())) {
    throw new TrackerRuleError("duplicate_rule", `a rule named "${name}" already exists`);
  }
  const rule: TrackerRule = {
    id,
    name,
    announceHosts: (input.announceHosts ?? existing?.announceHosts ?? []).map((h: string) => h.trim()).filter(Boolean),
    minRatio: input.minRatio ?? existing?.minRatio ?? 0,
    minSeedTimeHours: input.minSeedTimeHours ?? existing?.minSeedTimeHours ?? 0,
    ...(input.tag ?? existing?.tag ? { tag: input.tag ?? existing?.tag } : {}),
    maxConcurrent: input.maxConcurrent ?? existing?.maxConcurrent ?? 0,
    allowDataRemoval: input.allowDataRemoval ?? existing?.allowDataRemoval ?? false,
    enabled: input.enabled ?? existing?.enabled ?? true,
  };
  doc.rules[id] = rule;
  await saveResume(doc);
  await emitFn?.("dev.tantalar.event.tracker.rule.updated", { ruleId: id, name, action: existing ? "updated" : "created" });
  return rule;
}

async function deleteRule(payload: Record<string, unknown>): Promise<{ removed: boolean }> {
  const id = String(payload.id ?? "");
  const doc = await loadResume();
  if (!doc.rules?.[id]) throw new TrackerRuleError("unknown_rule", `unknown rule ${id}`);
  delete doc.rules[id];
  await saveResume(doc);
  await emitFn?.("dev.tantalar.event.tracker.rule.updated", { ruleId: id, action: "deleted" });
  return { removed: true };
}

function ruleFor(t: EngineTorrent, doc: ResumeDoc): TrackerRule | null {
  return matchTrackerRule(Object.values(doc.rules ?? {}), t.announceUrls);
}

async function obligationsFor(id: string): Promise<ObligationReport> {
  const doc = await loadResume();
  const job = doc.jobs[id];
  const t = job ? engine.get(job.infoHash) : undefined;
  if (!job || !t) throw new DownloadClientError("unknown_download", `unknown download ${id}`);
  return evaluateObligations(id, ruleFor(t, doc), statsOf(t));
}

async function reportObligations(payload: Record<string, unknown>): Promise<ObligationReport> {
  return obligationsFor(String(payload.downloadId ?? ""));
}

async function listObligations(): Promise<{ obligations: ObligationReport[] }> {
  const doc = await loadResume();
  const out: ObligationReport[] = [];
  for (const [id, job] of Object.entries(doc.jobs)) {
    const t = engine.get(job.infoHash);
    if (t) out.push(evaluateObligations(id, ruleFor(t, doc), statsOf(t)));
  }
  out.sort((a, b) => a.downloadId.localeCompare(b.downloadId));
  return { obligations: out };
}


async function nextQueuePosition(doc: ResumeDoc): Promise<number> {
  const positions = Object.values(doc.jobs).map((j) => j.queuePosition);
  return positions.length === 0 ? 1 : Math.max(...positions) + 1;
}

// ---- Fail-closed kill switch gate (TAN-045) -----------------------------------
//
// Before this client opens ANY socket for a new job it consults the
// vpn-manager binding gate. Bound clients dispatch only while their tunnel
// is explicitly healthy. A gate error OTHER than "capability absent" blocks
// (fail-closed): we never transfer while unsure. When the whole VPN
// subsystem is absent the client is direct by definition.
const VPN_BINDING_CAP = "dev.tantalar.capability.vpn-binding";

export async function assertKillSwitchOpen(
  ctx: Pick<PluginContext, "invoke">,
  clientId: string,
): Promise<void> {
  let check: { allowDispatch?: boolean; health?: string; profileId?: string | null } | null;
  try {
    check = (await ctx.invoke(VPN_BINDING_CAP, "pre-dispatch-check", { clientId })) as typeof check;
  } catch (err) {
    const msg = String((err as Error)?.message ?? err);
    throw new DownloadClientError("blocked", `kill switch: binding gate unavailable (${msg})`);
  }
  if (!check?.allowDispatch) {
    throw new DownloadClientError(
      "blocked",
      `kill switch: tunnel ${String(check?.profileId ?? "?")} health=${String(check?.health ?? "down")}`,
    );
  }
}

function torrentLimits() {
  return {
    maxMetadataBytes: cfg.maxMetadataBytes,
    maxFiles: cfg.maxTorrentFiles,
    maxPathBytes: cfg.maxTorrentPathBytes,
    maxPieces: cfg.maxTorrentPieces,
    // The plugin's storage gate reports quota failures consistently. The
    // real engine separately receives maxJobBytes for magnet metadata.
    maxPayloadBytes: DEFAULT_TORRENT_LIMITS.maxPayloadBytes,
  };
}

async function addJob(rawPayload: unknown): Promise<DownloadStatus> {
  const req = validateDownloadRequest(rawPayload);
  if (req.kind !== "torrent") {
    throw new DownloadClientError("invalid_request", "torrent-native accepts torrent releases only");
  }
  await assertKillSwitchOpen(
    invokeCtx ?? { invoke: async () => { throw new Error("no provider: not mounted"); } },
    PLUGIN_ID,
  );
  const doc = await loadResume();
  const existing = Object.entries(doc.jobs).find(([, j]) => j.itemKey === req.itemKey && !j.failedReason);
  if (existing && engine.get(existing[1].infoHash)) {
    return statusOf(existing[0], existing[1], engine.get(existing[1].infoHash)!); // idempotent add
  }

  // Resolve the metainfo and compute the job footprint BEFORE touching disk.
  assertStorageSafe(0);
  const sourcePath = /^https?:\/\//i.test(req.sourceUrl)
    ? await cacheReleaseSource(req.sourceUrl, cfg.downloadRoots[0]!, ".torrent", cfg.maxMetadataBytes)
    : req.sourceUrl;
  let infoHash: string;
  let displayName: string;
  let announceUrls: string[];
  let sizeBytes: number;
  let filesList: Array<{ path: string; lengthBytes: number }>;
  let sourceKind: "file" | "magnet";
  let sourceRef: string;
  let magnetUri: string | undefined;

  if (req.sourceUrl.startsWith("magnet:?")) {
    const m = parseMagnet(req.sourceUrl);
    infoHash = m.infoHash;
    displayName = m.displayNames[0] ?? infoHash;
    announceUrls = m.trackers;
    sourceKind = "magnet";
    sourceRef = req.sourceUrl;
    magnetUri = req.sourceUrl;
    // Size unknown until metadata arrives; conservative 0 passes quota check.
    sizeBytes = 0;
    filesList = [];
  } else if (isAbsolute(sourcePath) && sourcePath.endsWith(".torrent")) {
    // Local .torrent metainfo path (seeded/test surface). The .torrent file
    // itself is metadata, not payload: it must exist and read as a torrent,
    // but the WRITE containment applies to downloadPath, checked below.
    const metainfoStat = lstatSync(sourcePath);
    if (!metainfoStat.isFile() || metainfoStat.isSymbolicLink()) {
      throw new DownloadClientError("invalid_request", "torrent metainfo must be a regular file");
    }
    if (metainfoStat.size > cfg.maxMetadataBytes) {
      throw new DownloadClientError("invalid_request", "torrent metadata exceeds configured limit");
    }
    const parsed = parseTorrentFile(readFileSync(sourcePath), torrentLimits());
    infoHash = parsed.infoHash;
    displayName = parsed.name;
    announceUrls = parsed.announceUrls;
    sizeBytes = parsed.files.reduce((a, f) => a + f.lengthBytes, 0);
    filesList = parsed.files;
    sourceKind = "file";
    sourceRef = sourcePath;
  } else {
    throw new DownloadClientError(
      "invalid_request",
      "sourceUrl must be a magnet URI or a contained absolute .torrent path",
    );
  }

  assertStorageSafe(sizeBytes);

  // TAN-015: apply the matched tracker rule — tag the torrent and enforce
  // the per-tracker concurrent-download limit.
  {
    const rule = matchTrackerRule(Object.values(doc.rules ?? {}), announceUrls);
    if (rule) {
      if (rule.maxConcurrent > 0) {
        const active = Object.values(doc.jobs).filter((j) => {
          const t = engine.get(j.infoHash);
          if (!t || t.done) return false;
          const r = matchTrackerRule(Object.values(doc.rules ?? {}), t.announceUrls);
          return r?.id === rule.id;
        }).length;
        if (active >= rule.maxConcurrent) {
          throw new DownloadClientError(
            "blocked",
            `tracker rule "${rule.name}" allows ${rule.maxConcurrent} concurrent download(s)`,
          );
        }
      }
    }
  }

  const downloadPath = join(cfg.downloadRoots[0] ?? "", displayName || infoHash);
  assertContained(downloadPath);

  const torrent = await engine.add({
    source: sourceKind === "magnet" ? sourceRef : sourceRef,
    sourceKind,
    downloadPath,
    // Keep transport deselected until metadata-derived quota checks complete.
    fileSelection: [],
  });
  try {
    assertStorageSafe(torrent.sizeBytes);
  } catch (error) {
    await engine.remove(torrent.infoHash, { keepFiles: false });
    throw error;
  }
  engine.selectFiles?.(torrent.infoHash, torrent.files.map((file) => file.path));
  {
    const rule = matchTrackerRule(Object.values(doc.rules ?? {}), announceUrls);
    if (rule?.tag) torrent.tag = rule.tag;
  }

  doc.seq += 1;
  const downloadId = `tn-${String(doc.seq).padStart(4, "0")}`;
  const job: StoredJob = {
    itemKey: req.itemKey,
    title: req.title,
    infoHash: torrent.infoHash,
    sourceKind,
    ...(sourceKind === "magnet" ? { magnetUri } : { sourcePath: sourceRef }),
    downloadId,
    queuePosition: await nextQueuePosition(doc),
    downloadPath,
    ...(req.correlationId ? { correlationId: req.correlationId } : {}),
  };
  doc.jobs[downloadId] = job;
  await saveResume(doc);

  await emitFn?.(
    EventTypes.DownloadQueued,
    {
      downloadId,
      itemKey: req.itemKey,
      infoHash: torrent.infoHash,
      queuePosition: job.queuePosition,
      state: "queued",
    },
    jobEventOptions(job),
  );
  return statusOf(downloadId, job, torrent);
}

async function getJob(payload: Record<string, unknown>): Promise<DownloadStatus> {
  const id = String(payload.downloadId ?? "");
  const doc = await loadResume();
  const job = doc.jobs[id];
  const t = job ? engine.get(job.infoHash) : undefined;
  if (!job || !t) throw new DownloadClientError("unknown_download", `unknown download ${id}`);
  return statusOf(id, job, t);
}

async function listJobs(): Promise<{ downloads: DownloadStatus[] }> {
  const doc = await loadResume();
  const out: DownloadStatus[] = [];
  for (const [id, job] of Object.entries(doc.jobs)) {
    const t = engine.get(job.infoHash);
    if (t) out.push(statusOf(id, job, t));
  }
  out.sort((a, b) => a.downloadId.localeCompare(b.downloadId));
  return { downloads: out };
}

async function completedFiles(payload: Record<string, unknown>): Promise<{ files: Array<{ path: string; sizeBytes: number }> }> {
  const { job, torrent, id } = await requireTorrent(payload);
  if (statusOf(id, job, torrent).state !== "completed") return { files: [] };
  const files: Array<{ path: string; sizeBytes: number }> = [];
  for (const file of torrent.files) {
    if (!file.selected || file.downloadedBytes < file.lengthBytes) continue;
    const path = join(torrent.downloadPath, file.path);
    assertContained(path);
    try {
      const info = lstatSync(path);
      if (info.isFile() && !info.isSymbolicLink()) files.push({ path, sizeBytes: info.size });
    } catch {
      // A completed engine record can outlive files removed outside Tantalar.
    }
  }
  return { files };
}

async function publishLiveProgress(): Promise<void> {
  if (progressPollActive || !emitFn) return;
  progressPollActive = true;
  try {
    const doc = await loadResume();
    const active = Object.entries(doc.jobs).filter(([, job]) => {
      const torrent = engine.get(job.infoHash);
      return torrent && !torrent.done && !torrent.paused;
    });
    if (active.length > 0) {
      try {
        await assertKillSwitchOpen(
          invokeCtx ?? { invoke: async () => { throw new Error("VPN binding gate unavailable"); } },
          PLUGIN_ID,
        );
      } catch (error) {
        for (const [downloadId, job] of active) {
          engine.pause(job.infoHash);
          const key = "blocked:vpn";
          if (lastPublishedProgress.get(downloadId) === key) continue;
          lastPublishedProgress.set(downloadId, key);
          await emitFn(EventTypes.DownloadProgress, {
            downloadId,
            itemKey: job.itemKey,
            paused: true,
            blocked: "VPN binding unavailable",
          }, jobEventOptions(job));
        }
      }
    }

    for (const [downloadId, job] of Object.entries(doc.jobs)) {
      const torrent = engine.get(job.infoHash);
      if (!torrent) continue;
      await publishJobStatus(downloadId, job, torrent);
    }
  } catch (error) {
    logFn?.("warn", `progress poll failed: ${(error as Error).message}`);
  } finally {
    progressPollActive = false;
  }
}

async function requireTorrent(payload: Record<string, unknown>): Promise<{ job: StoredJob; torrent: EngineTorrent; id: string }> {
  const id = String(payload.downloadId ?? "");
  const doc = await loadResume();
  const job = doc.jobs[id];
  const t = job ? engine.get(job.infoHash) : undefined;
  if (!job || !t) throw new DownloadClientError("unknown_download", `unknown download ${id}`);
  return { job, torrent: t, id };
}

async function pauseJob(payload: Record<string, unknown>): Promise<DownloadStatus> {
  const { job, torrent, id } = await requireTorrent(payload);
  engine.pause(torrent.infoHash);
  await emitFn?.(EventTypes.DownloadProgress, {
    downloadId: id,
    itemKey: job.itemKey,
    paused: true,
  }, jobEventOptions(job));
  return statusOf(id, job, engine.get(job.infoHash)!);
}

async function resumeJob(payload: Record<string, unknown>): Promise<DownloadStatus> {
  const { job, torrent, id } = await requireTorrent(payload);
  await assertKillSwitchOpen(
    invokeCtx ?? { invoke: async () => { throw new Error("VPN binding gate unavailable"); } },
    PLUGIN_ID,
  );
  engine.resume(torrent.infoHash);
  await engine.advance?.(torrent.infoHash);
  return statusOf(id, job, engine.get(job.infoHash)!);
}

async function removeJob(payload: Record<string, unknown>): Promise<{ removed: boolean }> {
  const { torrent } = await requireTorrent(payload);
  const downloadId = String(payload.downloadId ?? "");
  // TAN-015 safe removal: Tantalar never removes payload data before all
  // tracker obligations pass. keepFiles=false (data deletion) additionally
  // requires the rule's explicit allowDataRemoval.
  const report = await obligationsFor(downloadId);
  const wantsDataRemoval = payload.keepFiles === false;
  if (report.status === "unsatisfied" && wantsDataRemoval) {
    throw new TrackerRuleError(
      "obligations_unmet",
      `tracker rule "${report.ruleName}" not satisfied: ${report.reasons.join("; ")}`,
    );
  }
  let keepFiles = payload.keepFiles !== false;
  if (report.status === "satisfied" && report.ruleId) {
    const doc = await loadResume();
    const rule = doc.rules?.[report.ruleId];
    if (rule && !rule.allowDataRemoval) keepFiles = true; // rule forces file retention
  }
  await engine.remove(torrent.infoHash, { keepFiles });
  const doc = await loadResume();
  delete doc.jobs[downloadId];
  await saveResume(doc);
  // Rule decisions are visible in job history (event log).
  await emitFn?.("dev.tantalar.event.tracker.removal.decision", {
    downloadId,
    ruleId: report.ruleId,
    ruleName: report.ruleName,
    obligationStatus: report.status,
    keepFiles,
    reasons: report.reasons,
  });
  return { removed: true };
}

async function retryJob(payload: Record<string, unknown>): Promise<DownloadStatus> {
  const { job, torrent, id } = await requireTorrent(payload);
  await assertKillSwitchOpen(
    invokeCtx ?? { invoke: async () => { throw new Error("VPN binding gate unavailable"); } },
    PLUGIN_ID,
  );
  job.failedReason = undefined;
  const doc = await loadResume();
  doc.jobs[id] = job;
  await saveResume(doc);
  engine.resume(torrent.infoHash);
  await engine.advance?.(torrent.infoHash);
  return statusOf(id, job, engine.get(job.infoHash)!);
}

async function advanceAll(): Promise<{ downloads: DownloadStatus[] }> {
  // Deterministic test/step surface: drive every active job one step, in
  // queue order, up to maxConcurrent simultaneously. Completed jobs keep
  // advancing so seeding time accrues for tracker-obligation evaluation.
  const doc = await loadResume();
  const ordered = Object.values(doc.jobs)
    .sort((a, b) => a.queuePosition - b.queuePosition)
    .slice(0, cfg.maxConcurrent);
  for (const job of ordered) {
    const t = engine.get(job.infoHash);
    if (!t || t.paused) continue;
    await assertKillSwitchOpen(
      invokeCtx ?? { invoke: async () => { throw new Error("VPN binding gate unavailable"); } },
      PLUGIN_ID,
    );
    await engine.advance?.(job.infoHash);
    const torrent = engine.get(job.infoHash);
    if (torrent) await publishJobStatus(job.downloadId, job, torrent);
  }
  return listJobs();
}

function runtimeStatus() {
  const activeJobs = engine.list().filter((torrent) => !torrent.done).length;
  const limitations = [
    "DHT, LSD, PEX, web seeds, NAT traversal and public trackers are disabled",
    "Only an explicitly configured loopback tracker tracer is network-capable",
    "Default enablement waits for an enforced VPN network boundary",
  ];
  if (cfg.engineMode === "memory") limitations.unshift("Memory transport is deterministic test-only mode");
  return {
    ready:
      cfg.engineMode === "webtorrent" &&
      cfg.trackerMode === "loopback" &&
      cfg.downloadRoots.length > 0,
    engine: cfg.engineMode,
    dhtEnabled: false,
    publicDiscoveryEnabled: false,
    downloadRootsConfigured: cfg.downloadRoots.length,
    activeJobs,
    limitations,
  };
}

async function configure(payload: Record<string, unknown>) {
  const downloadRoots = validateDownloadRoots(payload.downloadRoots);
  const doc = await loadResume();
  const stranded = Object.values(doc.jobs).find(
    (job) => job.downloadPath && !containedInRoots(job.downloadPath, downloadRoots),
  );
  if (stranded) {
    throw new DownloadClientError(
      "blocked",
      "download roots cannot be removed while a persisted job still uses them",
    );
  }
  await saveConfiguredRoots(downloadRoots);
  cfg = { ...cfg, downloadRoots };
  return runtimeStatus();
}

// ---- Engine capability operations (TAN-009/012 specifics) ---------------------------

async function verifyPieces(payload: Record<string, unknown>): Promise<{
  downloadId: string;
  verifiedPieces: number;
  totalPieces: number;
  corruptedFiles: string[];
}> {
  const { job, torrent, id } = await requireTorrent(payload);
  const result = await engine.verify(torrent.infoHash);
  await emitFn?.(EventTypes.DownloadProgress, {
    downloadId: id,
    itemKey: job.itemKey,
    verification: result,
  }, jobEventOptions(job));
  return { downloadId: id, ...result };
}

async function selectFiles(payload: Record<string, unknown>): Promise<DownloadStatus> {
  const { job, torrent, id } = await requireTorrent(payload);
  const wanted = Array.isArray(payload.paths) ? (payload.paths as unknown[]).map(String) : [];
  const known = new Set(torrent.files.map((file) => file.path));
  const unknown = wanted.find((path) => !known.has(path));
  if (unknown) throw new DownloadClientError("invalid_request", `unknown torrent file ${unknown}`);
  engine.selectFiles?.(torrent.infoHash, wanted);
  for (const f of torrent.files) f.selected = wanted.includes(f.path);
  const doc = await loadResume();
  doc.jobs[id] = { ...job, selectedFiles: wanted };
  await saveResume(doc);
  return statusOf(id, job, torrent);
}

async function setQueuePosition(payload: Record<string, unknown>): Promise<DownloadStatus> {
  const { job, id } = await requireTorrent(payload);
  const pos = Number(payload.queuePosition ?? 0);
  const doc = await loadResume();
  if (!(pos >= 1)) throw new DownloadClientError("invalid_request", "queuePosition must be >= 1");
  job.queuePosition = pos;
  doc.jobs[id] = job;
  await saveResume(doc);
  const t = engine.get(job.infoHash)!;
  return statusOf(id, job, t);
}

/**
 * Cleanup: remove completed payloads under the configured roots. Explicit
 * only — every removed path is re-verified against containment before the
 * unlink, and an audit event records exactly what was cleaned.
 */
async function cleanupCompleted(payload: Record<string, unknown>): Promise<{ removedPaths: string[] }> {
  const { rmSync, existsSync } = await import("node:fs");
  const { job, torrent, id } = await requireTorrent(payload);
  const removed: string[] = [];
  for (const f of torrent.files) {
    if (f.downloadedBytes < f.lengthBytes) continue;
    const abs = join(torrent.downloadPath, f.path);
    assertContained(abs);
    if (existsSync(abs)) {
      if (payload.dryRun !== true) rmSync(abs, { force: false });
      removed.push(abs);
    }
  }
  await emitFn?.(EventTypes.DownloadProgress, {
    downloadId: id,
    itemKey: job.itemKey,
    cleanup: { removedPaths: removed },
  }, jobEventOptions(job));
  return { removedPaths: removed };
}

/** Restart recovery: reload persisted jobs and reconcile with the engine. */
async function recoverOnMount(): Promise<number> {
  const doc = await loadResume();
  let recovered = 0;
  for (const job of Object.values(doc.jobs)) {
    if (engine.get(job.infoHash)) {
      recovered += 1;
      await emitFn?.(EventTypes.DownloadProgress, {
        downloadId: job.downloadId,
        itemKey: job.itemKey,
        recovered: true,
      }, jobEventOptions(job));
      continue;
    }
    try {
      if (job.sourceKind === "file" && job.sourcePath) {
        await engine.add({
          source: job.sourcePath,
          sourceKind: "file",
          downloadPath: job.downloadPath ?? join(cfg.downloadRoots[0] ?? "", job.title),
          fileSelection: job.selectedFiles,
          allowExisting: true,
        });
        recovered += 1;
        await emitFn?.(EventTypes.DownloadProgress, {
          downloadId: job.downloadId,
          itemKey: job.itemKey,
          recovered: true,
        }, jobEventOptions(job));
      } else if (job.magnetUri) {
        await engine.add({
          source: job.magnetUri,
          sourceKind: "magnet",
          downloadPath: job.downloadPath ?? join(cfg.downloadRoots[0] ?? "", job.title),
          fileSelection: job.selectedFiles,
          allowExisting: true,
        });
        recovered += 1;
        await emitFn?.(EventTypes.DownloadProgress, {
          downloadId: job.downloadId,
          itemKey: job.itemKey,
          recovered: true,
        }, jobEventOptions(job));
      }
    } catch (err) {
      logFn?.("warn", `recovery skipped ${job.downloadId}: ${(err as Error).message}`);
    }
  }
  return recovered;
}

const plugin: PluginDefinition = definePlugin({
  manifest: validateManifest({
    id: PLUGIN_ID,
    version: "0.1.0",
    protocolVersion: PROTOCOL_VERSION,
    provides: [CLIENT_CAPABILITY, ENGINE_CAPABILITY, TRACKER_RULES_CAPABILITY],
    requires: [
      "dev.tantalar.capability.event.emit",
      "dev.tantalar.capability.log",
      VPN_BINDING_CAP,
    ],
    subscriptions: [],
    entry: { command: "node dist/plugin.js" },
  }),

  async mount(ctx: PluginContext) {
    emitFn = (type, payload, opts) => ctx.emit(type, payload, opts);
    logFn = (level, message) => ctx.log(level, message);
    invokeCtx = ctx;
    storeGet = (key) => ctx.storage.get(key);
    storePut = (key, doc) => ctx.storage.put(key, doc);
    cfg = loadConfig();
    const configuredRoots = await loadConfiguredRoots();
    if (configuredRoots) cfg = { ...cfg, downloadRoots: configuredRoots };
    if (!engineInjected) {
      engine = cfg.engineMode === "memory"
        ? new MemoryTorrentEngine()
        : new WebTorrentEngine({
            trackerMode: cfg.trackerMode,
            metadataTimeoutMs: cfg.metadataTimeoutMs,
            maxConnections: cfg.maxConcurrent * 20,
            maxMetadataBytes: cfg.maxMetadataBytes,
            maxFiles: cfg.maxTorrentFiles,
            maxPathBytes: cfg.maxTorrentPathBytes,
            maxPieces: cfg.maxTorrentPieces,
            maxPayloadBytes: cfg.maxJobBytes > 0 ? cfg.maxJobBytes : DEFAULT_TORRENT_LIMITS.maxPayloadBytes,
          });
    }
    const recovered = await recoverOnMount();
    if (cfg.engineMode === "webtorrent") {
      progressTimer = setInterval(() => void publishLiveProgress(), cfg.progressIntervalMs);
      progressTimer.unref();
    }
    ctx.log(
      "info",
      `torrent-native mounted (transport=${cfg.engineMode}, tracker=${cfg.trackerMode}, recovered ${recovered} jobs)`,
    );
  },

  async unmount(ctx: PluginContext) {
    if (progressTimer) clearInterval(progressTimer);
    progressTimer = null;
    lastPublishedProgress.clear();
    await engine.destroy?.();
    emitFn = null;
    logFn = null;
    invokeCtx = null;
    storeGet = null;
    storePut = null;
    ctx.log("info", "torrent-native unmounted");
  },

  handlers: {
    [CLIENT_CAPABILITY]: async (operation: string, payload: Record<string, unknown>) => {
      switch (operation) {
        case "add":
          return addJob(payload as Record<string, unknown>);
        case "status":
          return getJob(payload);
        case "list":
          return listJobs();
        case "completed-files":
          return completedFiles(payload);
        case "pause":
          return pauseJob(payload);
        case "resume":
          return resumeJob(payload);
        case "remove":
          return removeJob(payload);
        case "retry":
          return retryJob(payload);
        case "advance":
          return advanceAll();
        case "conformance-probe":
          return {
            ok: true,
            transport: cfg.engineMode,
            trackerMode: cfg.trackerMode,
            publicDiscovery: false,
          };
        default:
          throw new DownloadClientError("invalid_request", `unknown operation ${operation}`);
      }
    },

    [ENGINE_CAPABILITY]: async (operation: string, payload: Record<string, unknown>) => {
      switch (operation) {
        case "runtime-status":
          return runtimeStatus();
        case "configure":
          return configure(payload);
        case "verify":
          return verifyPieces(payload);
        case "select-files":
          return selectFiles(payload);
        case "queue-position":
          return setQueuePosition(payload);
        case "cleanup-completed":
          return cleanupCompleted(payload);
        default:
          throw new DownloadClientError("invalid_request", `unknown operation ${operation}`);
      }
    },

    // TAN-015: per-tracker rules + obligation reporting. Decisions surface
    // in job history via the removal-decision event.
    [TRACKER_RULES_CAPABILITY]: async (operation: string, payload: Record<string, unknown>) => {
      switch (operation) {
        case "list-rules":
          return listRules();
        case "put-rule":
          return putRule(payload);
        case "delete-rule":
          return deleteRule(payload);
        case "obligations":
          return reportObligations(payload);
        case "list-obligations":
          return listObligations();
        case "conformance-probe":
          return { ok: true };
        default:
          throw new TrackerRuleError("invalid_rule", `unknown operation ${operation}`);
      }
    },
  },
});

runPlugin(plugin);
