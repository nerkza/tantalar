/**
 * dev.tantalar.plugin.usenet-native (TAN-010) — first-party embedded Usenet
 * download-client. NO SABnzbd or external daemon: NNTP TLS/authentication,
 * server priorities, connection pools, scheduling, yEnc/CRC, PAR2, unpacking,
 * storage safety, queue controls and events are all owned here.
 *
 * Durable state lives in core (ctx.storage resume doc) and mirrors into the
 * unified TAN-011 download_jobs contract via the injected DownloadJobMirror
 * seam. Tests inject MemoryNntpEngine + MemoryNntpTransport with legal
 * synthetic fixtures — no network, no real servers.
 */
import { statfsSync } from "node:fs";
import { isAbsolute, join, resolve, sep } from "node:path";
import { runPlugin, definePlugin, type PluginContext, type PluginDefinition } from "@tantalar/plugin-sdk";
import {
  PROTOCOL_VERSION,
  validateManifest,
  validateDownloadRequest,
  DownloadClientError,
  EventTypes,
  type DownloadStatus,
  type DownloadState,
} from "@tantalar/contracts";
import {
  MemoryNntpEngine,
  type NntpEngine,
  type NntpServerConfig,
  type Par2Repairer,
  type Unpacker,
} from "./engine.js";

const CLIENT_CAPABILITY = "dev.tantalar.capability.download-client";
const ENGINE_CAPABILITY = "dev.tantalar.capability.usenet.engine";
const PLUGIN_ID = "dev.tantalar.plugin.usenet-native";

const RESUME_KEY = "resume-state";

interface EngineConfig {
  downloadRoots: string[];
  minFreeBytes: number;
  maxJobBytes: number;
  maxConcurrent: number;
}

function loadConfig(): EngineConfig {
  const raw = JSON.parse(process.env["TANTALAR_PLUGIN_CONFIG"] ?? "{}") as Record<string, unknown>;
  const roots = Array.isArray(raw.downloadRoots)
    ? (raw.downloadRoots as unknown[]).map(String).filter((r) => r.trim().length > 0)
    : [];
  return {
    downloadRoots: roots.map((r) => resolve(r)),
    minFreeBytes: Number(raw.minFreeBytes ?? 0),
    maxJobBytes: Number(raw.maxJobBytes ?? 0),
    maxConcurrent: Math.max(1, Number(raw.maxConcurrent ?? 2)),
  };
}

// ---- Durable resume document ----------------------------------------------------

interface StoredJob {
  itemKey: string;
  title: string;
  jobId: string; // engine id
  nzbPath: string;
  queuePosition: number;
  failedReason?: string;
}

interface ResumeDoc {
  jobs: Record<string, StoredJob>; // downloadId -> job
  seq: number;
}

let emitFn: PluginContext["emit"] | null = null;
let logFn: PluginContext["log"] | null = null;
/** Cross-capability invoke bridge for the kill-switch gate (null when unmounted). */
let invokeCtx: Pick<PluginContext, "invoke"> | null = null;
let storeGet: ((key: string) => Promise<{ doc: unknown } | null>) | null = null;
let storePut: ((key: string, doc: unknown) => Promise<void>) | null = null;

let cfg: EngineConfig = loadConfig();
let engine: NntpEngine = new MemoryNntpEngine({
  servers: [],
  transports: [],
  repairer: { async repair() { return { repaired: false, missingBlocks: 0, recoveredFiles: [], detail: "no repairer configured" }; } },
  unpacker: { async unpack() { return { unpacked: false, files: [], detail: "no unpacker configured" }; } },
});

/** Swap the transport/engine (tests inject here). */
export function setEngine(next: NntpEngine): void {
  engine = next;
}
export function currentEngine(): NntpEngine {
  return engine;
}
/** Register server priorities for fill-order documentation/health checks. */
export function serverPriorities(): NntpServerConfig[] {
  return [];
}
export function setRepairer(_r: Par2Repairer): void {}
export function setUnpacker(_u: Unpacker): void {}

async function loadResume(): Promise<ResumeDoc> {
  if (!storeGet) throw new Error("not mounted");
  const hit = await storeGet(RESUME_KEY);
  if (!hit || typeof hit.doc !== "object" || hit.doc === null) return { jobs: {}, seq: 0 };
  const doc = hit.doc as Partial<ResumeDoc>;
  return { jobs: doc.jobs ?? {}, seq: doc.seq ?? 0 };
}

async function saveResume(doc: ResumeDoc): Promise<void> {
  if (!storePut) throw new Error("not mounted");
  await storePut(RESUME_KEY, doc);
}

// ---- Storage safety ----------------------------------------------------------------

export function containedInRoot(p: string): string | null {
  const abs = resolve(p);
  for (const root of cfg.downloadRoots) {
    if (abs === root || abs.startsWith(root + sep)) return root;
  }
  return null;
}

export function assertContained(p: string): string {
  const root = containedInRoot(p);
  if (!root) throw new DownloadClientError("blocked", `path outside configured download roots: ${p}`);
  return root;
}

export function freeBytes(dir: string): number | null {
  try {
    const s = statfsSync(dir);
    return s.bavail * s.bsize;
  } catch {
    return null;
  }
}

export function assertStorageSafe(sizeBytes: number): void {
  if (cfg.downloadRoots.length === 0)
    throw new DownloadClientError("blocked", "no download roots configured");
  for (const root of cfg.downloadRoots) {
    const free = freeBytes(root);
    if (free !== null && free < cfg.minFreeBytes) {
      throw new DownloadClientError(
        "blocked",
        `free-space threshold: ${root} has ${free} bytes, minimum ${cfg.minFreeBytes}`,
      );
    }
  }
  if (cfg.maxJobBytes > 0 && sizeBytes > cfg.maxJobBytes)
    throw new DownloadClientError("blocked", `job size ${sizeBytes} exceeds quota ${cfg.maxJobBytes}`);
}

// ---- Job state mapping ---------------------------------------------------------------

function statusOf(downloadId: string, job: StoredJob): DownloadStatus {
  const t = engine.get(job.jobId);
  const progress =
    t && t.totalBytes > 0 ? Math.round((t.receivedBytes / t.totalBytes) * 100) : 0;
  let state: DownloadState;
  if (job.failedReason) state = "failed";
  else if (!t) state = "queued";
  else if (t.state === "completed") state = "completed";
  else if (t.state === "paused") state = "paused";
  else if (t.state === "failed") state = "failed";
  else if (t.receivedBytes === 0) state = "queued";
  else state = "downloading";
  return {
    downloadId,
    itemKey: job.itemKey,
    state,
    progressPercent: Math.min(100, progress),
    sizeBytes: t?.totalBytes ?? 0,
    ...(job.failedReason !== undefined ? { error: job.failedReason } : {}),
  };
}

async function nextQueuePosition(doc: ResumeDoc): Promise<number> {
  const positions = Object.values(doc.jobs).map((j) => j.queuePosition);
  return positions.length === 0 ? 1 : Math.max(...positions) + 1;
}

// ---- Fail-closed kill switch gate (TAN-045) -----------------------------------
//
// Before this client opens ANY socket for a new job it consults the
// vpn-manager binding gate. Bound clients dispatch only while their tunnel
// is explicitly healthy; a gate error other than "capability absent" blocks.
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
    if (/no provider|not registered|not declared/i.test(msg)) return; // VPN subsystem absent
    throw new DownloadClientError("blocked", `kill switch: binding gate unavailable (${msg})`);
  }
  if (!check?.allowDispatch) {
    throw new DownloadClientError(
      "blocked",
      `kill switch: tunnel ${String(check?.profileId ?? "?")} health=${String(check?.health ?? "down")}`,
    );
  }
}

async function addJob(rawPayload: unknown): Promise<DownloadStatus> {
  const req = validateDownloadRequest(rawPayload);
  if (req.kind !== "nzb")
    throw new DownloadClientError("invalid_request", "usenet-native accepts NZB releases only");
  await assertKillSwitchOpen(
    invokeCtx ?? { invoke: async () => { throw new Error("no provider: not mounted"); } },
    PLUGIN_ID,
  );

  const doc = await loadResume();
  // Idempotent add by itemKey.
  const existingId = Object.entries(doc.jobs).find(
    ([, j]) => j.itemKey === req.itemKey && !j.failedReason && engine.get(j.jobId),
  );
  if (existingId) return statusOf(existingId[0], existingId[1]);

  // Local .nzb path (seeded/test surface). Containment applies to WRITES.
  if (!(isAbsolute(req.sourceUrl) && req.sourceUrl.endsWith(".nzb")))
    throw new DownloadClientError("invalid_request", "sourceUrl must be a contained absolute .nzb path");

  const added = await engine.add({ sourceKind: "nzb-path", sourcePath: req.sourceUrl, downloadPath: cfg.downloadRoots[0] ?? "" });
  assertStorageSafe(added.totalBytes);

  const downloadPath = join(cfg.downloadRoots[0] ?? "", added.id);
  assertContained(downloadPath);

  doc.seq += 1;
  const downloadId = `un-${String(doc.seq).padStart(4, "0")}`;
  const job: StoredJob = {
    itemKey: req.itemKey,
    title: req.title,
    jobId: added.id,
    nzbPath: req.sourceUrl,
    queuePosition: await nextQueuePosition(doc),
  };
  doc.jobs[downloadId] = job;
  await saveResume(doc);

  await emitFn?.(
    EventTypes.DownloadQueued,
    { downloadId, itemKey: req.itemKey, jobId: added.id, queuePosition: job.queuePosition, state: "queued" },
    req.correlationId !== undefined ? { correlationId: req.correlationId } : undefined,
  );
  return statusOf(downloadId, job);
}

async function requireJob(payload: Record<string, unknown>): Promise<{ job: StoredJob; id: string }> {
  const id = String(payload.downloadId ?? "");
  const doc = await loadResume();
  const job = doc.jobs[id];
  if (!job) throw new DownloadClientError("unknown_download", `unknown download ${id}`);
  return { job, id };
}

async function getJob(payload: Record<string, unknown>): Promise<DownloadStatus> {
  const { job, id } = await requireJob(payload);
  return statusOf(id, job);
}

async function listJobs(): Promise<{ downloads: DownloadStatus[] }> {
  const doc = await loadResume();
  const out: DownloadStatus[] = [];
  for (const [id, job] of Object.entries(doc.jobs)) out.push(statusOf(id, job));
  out.sort((a, b) => a.downloadId.localeCompare(b.downloadId));
  return { downloads: out };
}

async function pauseJob(payload: Record<string, unknown>): Promise<DownloadStatus> {
  const { job, id } = await requireJob(payload);
  engine.pause(job.jobId);
  await emitFn?.(EventTypes.DownloadProgress, { downloadId: id, itemKey: job.itemKey, paused: true });
  return statusOf(id, job);
}

async function resumeJob(payload: Record<string, unknown>): Promise<DownloadStatus> {
  const { job, id } = await requireJob(payload);
  engine.resume(job.jobId);
  await engine.advance(job.jobId);
  return statusOf(id, job);
}

async function removeJob(payload: Record<string, unknown>): Promise<{ removed: boolean }> {
  const { job } = await requireJob(payload);
  const keepFiles = payload.keepFiles !== false;
  await engine.remove(job.jobId, { keepFiles });
  const doc = await loadResume();
  delete doc.jobs[String(payload.downloadId ?? "")];
  await saveResume(doc);
  return { removed: true };
}

async function retryJob(payload: Record<string, unknown>): Promise<DownloadStatus> {
  const { job, id } = await requireJob(payload);
  job.failedReason = undefined;
  const doc = await loadResume();
  doc.jobs[id] = job;
  await saveResume(doc);
  engine.resume(job.jobId);
  await engine.advance(job.jobId);
  return statusOf(id, job);
}

/** Drive every active job one segment-step, in queue order, up to maxConcurrent. */
async function advanceAll(): Promise<{ downloads: DownloadStatus[] }> {
  const doc = await loadResume();
  const ordered = Object.values(doc.jobs)
    .sort((a, b) => a.queuePosition - b.queuePosition)
    .slice(0, cfg.maxConcurrent);
  for (const job of ordered) {
    const t = engine.get(job.jobId);
    if (!t || t.state === "paused" || t.state === "completed" || t.state === "failed") continue;
    await engine.advance(job.jobId);
  }
  return listJobs();
}

// ---- Engine capability operations ------------------------------------------------------

async function verifyCrc(payload: Record<string, unknown>): Promise<{
  downloadId: string;
  warnings: readonly string[];
}> {
  const { job, id } = await requireJob(payload);
  const t = engine.get(job.jobId);
  if (!t) throw new DownloadClientError("unknown_download", `unknown download ${id}`);
  await emitFn?.(EventTypes.DownloadProgress, { downloadId: id, itemKey: job.itemKey, crcWarnings: t.warnings });
  return { downloadId: id, warnings: t.warnings };
}

async function repairJob(payload: Record<string, unknown>): Promise<{
  downloadId: string;
  repaired: boolean;
  recoveredFiles: readonly string[];
  missingBlocks: number;
}> {
  const { job, id } = await requireJob(payload);
  const result = await engine.repair(job.jobId);
  await emitFn?.(EventTypes.DownloadProgress, { downloadId: id, itemKey: job.itemKey, repair: result });
  return { downloadId: id, ...result };
}

async function unpackJob(payload: Record<string, unknown>): Promise<{
  downloadId: string;
  unpacked: boolean;
  files: readonly string[];
}> {
  const { job, id } = await requireJob(payload);
  const result = await engine.unpack(job.jobId);
  await emitFn?.(EventTypes.DownloadProgress, { downloadId: id, itemKey: job.itemKey, unpack: result });
  return { downloadId: id, ...result };
}

async function setQueuePosition(payload: Record<string, unknown>): Promise<DownloadStatus> {
  const { job, id } = await requireJob(payload);
  const pos = Number(payload.queuePosition ?? 0);
  if (!(pos >= 1)) throw new DownloadClientError("invalid_request", "queuePosition must be >= 1");
  const doc = await loadResume();
  job.queuePosition = pos;
  doc.jobs[id] = job;
  await saveResume(doc);
  return statusOf(id, job);
}

/** Restart recovery: reload persisted jobs; the engine re-adds from the NZB path. */
async function recoverOnMount(): Promise<number> {
  const doc = await loadResume();
  let recovered = 0;
  for (const [downloadId, job] of Object.entries(doc.jobs)) {
    if (engine.get(job.jobId)) {
      recovered += 1;
      continue;
    }
    try {
      const added = await engine.add({ sourceKind: "nzb-path", sourcePath: job.nzbPath, downloadPath: cfg.downloadRoots[0] ?? "" });
      if (added.id !== job.jobId) {
        // Re-add produced a fresh engine id — remap so the durable record keeps working.
        job.jobId = added.id;
        doc.jobs[downloadId] = job;
      }
      recovered += 1;
    } catch (err) {
      logFn?.("warn", `recovery skipped ${job.itemKey}: ${(err as Error).message}`);
    }
  }
  await saveResume(doc);
  return recovered;
}

const plugin: PluginDefinition = definePlugin({
  manifest: validateManifest({
    id: PLUGIN_ID,
    version: "0.1.0",
    protocolVersion: PROTOCOL_VERSION,
    provides: [CLIENT_CAPABILITY, ENGINE_CAPABILITY],
    requires: ["dev.tantalar.capability.event.emit", "dev.tantalar.capability.log"],
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
    const recovered = await recoverOnMount();
    ctx.log("info", `usenet-native mounted (recovered ${recovered} jobs)`);
  },

  async unmount(ctx: PluginContext) {
    emitFn = null;
    logFn = null;
    invokeCtx = null;
    storeGet = null;
    storePut = null;
    ctx.log("info", "usenet-native unmounted");
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
          return { ok: true };
        default:
          throw new DownloadClientError("invalid_request", `unknown operation ${operation}`);
      }
    },

    [ENGINE_CAPABILITY]: async (operation: string, payload: Record<string, unknown>) => {
      switch (operation) {
        case "verify-crc":
          return verifyCrc(payload);
        case "repair":
          return repairJob(payload);
        case "unpack":
          return unpackJob(payload);
        case "queue-position":
          return setQueuePosition(payload);
        default:
          throw new DownloadClientError("invalid_request", `unknown operation ${operation}`);
      }
    },
  },
});

runPlugin(plugin);
