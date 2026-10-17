/**
 * dev.tantalar.plugin.usenet-native (TAN-010) — first-party embedded Usenet
 * download-client. NO SABnzbd or external daemon: NNTP TLS/authentication,
 * server priorities, connection pools, scheduling, yEnc/CRC, storage safety,
 * queue controls and events are all owned here. Optional operator-installed
 * par2 and 7-Zip processes handle recovery and contained archive extraction.
 *
 * Durable segment checkpoints live in core through ctx.storage. Production
 * uses the local certificate-validating NNTP transport. Tests use a legal
 * local TLS fixture or an in-memory transport.
 */
import { existsSync, lstatSync, readFileSync, statfsSync } from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { runPlugin, definePlugin, cacheReleaseSource, type PluginContext, type PluginDefinition } from "@tantalar/plugin-sdk";
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
  parseNzb,
  type EngineResumeState,
  type NntpEngine,
} from "./engine.js";
import { TlsNntpTransport, type TlsNntpServerConfig } from "./nntp.js";
import { ArchiveUnpacker, Par2FileRepairer, postprocessTools } from "./postprocess.js";

const CLIENT_CAPABILITY = "dev.tantalar.capability.download-client";
const ENGINE_CAPABILITY = "dev.tantalar.capability.usenet.engine";
const PLUGIN_ID = "dev.tantalar.plugin.usenet-native";

const RESUME_KEY = "resume-state";
const CONFIG_KEY = "server-configuration";
const SECRET_ENV_PATTERN = /^TANTALAR_SECRET_[A-Z0-9_]+$/;
const WORKER_INTERVAL_MS = 250;

export interface UsenetServerConfig {
  readonly id: string;
  readonly name: string;
  readonly host: string;
  readonly port: number;
  readonly tls: "implicit" | "starttls";
  readonly username: string;
  readonly passwordEnv?: string;
  readonly passwordRef?: string;
  readonly priority: number;
  readonly connections: number;
}

export interface RedactedUsenetServerConfig extends Omit<UsenetServerConfig, "passwordEnv" | "passwordRef"> {
  readonly hasPassword: boolean;
  readonly passwordSource: "stored" | "environment";
}

interface EngineConfig {
  downloadRoots: string[];
  minFreeBytes: number;
  maxJobBytes: number;
  maxConcurrent: number;
  servers: UsenetServerConfig[];
}

function cleanString(value: unknown, field: string, maxLength = 512): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.trim().length > maxLength ||
    /[\0\r\n]/.test(value)
  ) {
    throw new DownloadClientError("invalid_request", `${field} must be a non-empty string`);
  }
  return value.trim();
}

export function parseServerConfig(value: unknown): UsenetServerConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new DownloadClientError("invalid_request", "server must be an object");
  }
  const raw = value as Record<string, unknown>;
  if (Object.hasOwn(raw, "password")) {
    throw new DownloadClientError("invalid_request", "inline Usenet passwords are forbidden; use passwordEnv");
  }
  const tls = raw.tls;
  if (tls !== "implicit" && tls !== "starttls") {
    throw new DownloadClientError("invalid_request", "server.tls must be implicit or starttls");
  }
  const port = Number(raw.port);
  const priority = Number(raw.priority);
  const connections = Number(raw.connections);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new DownloadClientError("invalid_request", "server.port must be an integer from 1 to 65535");
  }
  if (!Number.isSafeInteger(priority) || priority < 0) {
    throw new DownloadClientError("invalid_request", "server.priority must be a non-negative integer");
  }
  if (!Number.isInteger(connections) || connections < 1 || connections > 32) {
    throw new DownloadClientError("invalid_request", "server.connections must be an integer from 1 to 32");
  }
  const username = cleanString(raw.username, "server.username", 256);
  const passwordEnv = typeof raw.passwordEnv === "string" && raw.passwordEnv.trim() ? raw.passwordEnv.trim() : undefined;
  const passwordRef = typeof raw.passwordRef === "string" && raw.passwordRef.trim() ? raw.passwordRef.trim() : undefined;
  if ((!passwordEnv && !passwordRef) || (passwordEnv && passwordRef)) {
    throw new DownloadClientError("invalid_request", "server requires one password source");
  }
  if (passwordEnv && !SECRET_ENV_PATTERN.test(passwordEnv)) {
    throw new DownloadClientError(
      "invalid_request",
      "server.passwordEnv must match TANTALAR_SECRET_[A-Z0-9_]+",
    );
  }
  if (passwordRef && !/^usenet:[a-z0-9][a-z0-9-]{0,79}$/.test(passwordRef)) {
    throw new DownloadClientError("invalid_request", "server.passwordRef is invalid");
  }
  return {
    id: cleanString(raw.id, "server.id", 80),
    name: cleanString(raw.name, "server.name", 120),
    host: cleanString(raw.host, "server.host", 253),
    port,
    tls,
    username,
    ...(passwordEnv ? { passwordEnv } : {}),
    ...(passwordRef ? { passwordRef } : {}),
    priority,
    connections,
  };
}

function parseServerList(value: unknown): UsenetServerConfig[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new DownloadClientError("invalid_request", "servers must be an array");
  const servers = value.map(parseServerConfig).sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
  const ids = new Set<string>();
  for (const server of servers) {
    if (ids.has(server.id)) throw new DownloadClientError("invalid_request", `duplicate Usenet server id: ${server.id}`);
    ids.add(server.id);
  }
  return servers;
}

function configInteger(value: unknown, fallback: number, field: string, min: number, max: number): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new DownloadClientError("invalid_request", `${field} must be an integer from ${min} to ${max}`);
  }
  return parsed;
}

function loadConfig(): EngineConfig {
  const raw = JSON.parse(process.env["TANTALAR_PLUGIN_CONFIG"] ?? "{}") as Record<string, unknown>;
  if (Object.hasOwn(raw, "password")) {
    throw new DownloadClientError("invalid_request", "inline Usenet passwords are forbidden; use passwordEnv");
  }
  const roots = Array.isArray(raw.downloadRoots)
    ? (raw.downloadRoots as unknown[]).map(String).filter((r) => r.trim().length > 0)
    : [];
  return {
    downloadRoots: roots.map((r) => resolve(r)),
    minFreeBytes: configInteger(raw.minFreeBytes, 0, "minFreeBytes", 0, Number.MAX_SAFE_INTEGER),
    maxJobBytes: configInteger(raw.maxJobBytes, 0, "maxJobBytes", 0, Number.MAX_SAFE_INTEGER),
    maxConcurrent: configInteger(raw.maxConcurrent, 2, "maxConcurrent", 1, 128),
    servers: parseServerList(raw.servers),
  };
}

// ---- Durable resume document ----------------------------------------------------

interface StoredJob {
  itemKey: string;
  title: string;
  jobId: string; // engine id
  nzbPath: string;
  downloadPath: string;
  queuePosition: number;
  resume?: EngineResumeState;
  failedReason?: string;
  correlationId?: string;
}

interface ResumeDoc {
  jobs: Record<string, StoredJob>; // downloadId -> job
  seq: number;
}

let emitFn: PluginContext["emit"] | null = null;
let logFn: PluginContext["log"] | null = null;
/** Cross-capability invoke bridge for the kill-switch gate (null when unmounted). */
let invokeCtx: Pick<PluginContext, "invoke"> | null = null;
const resolvedPasswords = new Map<string, string>();
let storeGet: ((key: string) => Promise<{ doc: unknown } | null>) | null = null;
let storePut: ((key: string, doc: unknown) => Promise<void>) | null = null;
let workerTimer: ReturnType<typeof setInterval> | null = null;
let workerRunning = false;
const lastPublishedProgress = new Map<string, string>();

let cfg: EngineConfig = loadConfig();

function materializeServer(server: UsenetServerConfig): TlsNntpServerConfig {
  if (server.tls !== "implicit") {
    throw new DownloadClientError("blocked", `STARTTLS is not supported for server ${server.name}; use implicit TLS`);
  }
  const password = serverPassword(server);
  if (!password) {
    throw new DownloadClientError("blocked", `secret environment reference is not available for server ${server.name}`);
  }
  if (/[\0\r\n]/.test(password)) {
    throw new DownloadClientError("blocked", `secret environment value is invalid for server ${server.name}`);
  }
  return {
    name: server.name,
    host: server.host,
    port: server.port,
    tls: true,
    username: server.username,
    password,
    priority: server.priority,
    maxConnections: server.connections,
    connectTimeoutMs: 8_000,
    responseTimeoutMs: 30_000,
    maxArticleBytes: 16 * 1024 * 1024,
  };
}

function createEngine(servers: readonly UsenetServerConfig[]): NntpEngine {
  const materialized = servers
    .filter((server) => server.tls === "implicit" && Boolean(serverPassword(server)))
    .map(materializeServer);
  return new MemoryNntpEngine({
    servers: materialized,
    transports: materialized.map((server) => new TlsNntpTransport(server)),
    repairer: new Par2FileRepairer(cfg.maxJobBytes || Number.MAX_SAFE_INTEGER, cfg.minFreeBytes),
    unpacker: new ArchiveUnpacker(cfg.maxJobBytes || Number.MAX_SAFE_INTEGER, cfg.minFreeBytes),
    log: (level, message) => logFn?.(level, message),
  });
}

let engine: NntpEngine = createEngine(cfg.servers);

/** Swap the transport/engine (tests inject here). */
export function setEngine(next: NntpEngine): void {
  engine = next;
}
export function currentEngine(): NntpEngine {
  return engine;
}
/** Register server priorities for fill-order documentation/health checks. */
export function serverPriorities(): RedactedUsenetServerConfig[] {
  return cfg.servers.map(redactServer);
}

function serverPassword(server: UsenetServerConfig): string | undefined {
  return server.passwordEnv ? process.env[server.passwordEnv] : resolvedPasswords.get(server.id);
}

function redactServer(server: UsenetServerConfig): RedactedUsenetServerConfig {
  const { passwordEnv, passwordRef: _passwordRef, ...safe } = server;
  return {
    ...safe,
    hasPassword: Boolean(serverPassword(server)),
    passwordSource: passwordEnv ? "environment" : "stored",
  };
}

async function hydratePasswords(servers: readonly UsenetServerConfig[]): Promise<void> {
  for (const server of servers) {
    if (server.passwordEnv) continue;
    try {
      const result = await invokeCtx?.invoke("dev.tantalar.capability.secret.resolve", "resolve", { ref: server.passwordRef });
      const value = String((result as { value?: unknown } | null)?.value ?? "");
      if (value && !/[\0\r\n]/.test(value)) resolvedPasswords.set(server.id, value);
      else resolvedPasswords.delete(server.id);
    } catch {
      resolvedPasswords.delete(server.id);
    }
  }
  for (const id of [...resolvedPasswords.keys()]) {
    if (!servers.some((server) => server.id === id && server.passwordRef)) resolvedPasswords.delete(id);
  }
}

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

function assertPerJobRoot(path: string): void {
  const root = assertContained(path);
  if (dirname(resolve(path)) !== resolve(root)) {
    throw new DownloadClientError("blocked", "Usenet job output must be a direct child of a configured download root");
  }
  if (!existsSync(root)) {
    throw new DownloadClientError("blocked", "configured download root does not exist");
  }
  const rootStat = lstatSync(root);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new DownloadClientError("blocked", "configured download root is not a regular directory");
  }
  if (existsSync(path)) {
    const jobStat = lstatSync(path);
    if (jobStat.isSymbolicLink() || !jobStat.isDirectory()) {
      throw new DownloadClientError("blocked", "Usenet job output is not a regular directory");
    }
  }
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
    progressPercent: state === "completed" ? 100 : Math.min(99, progress),
    sizeBytes: t?.totalBytes ?? 0,
    receivedBytes: t?.receivedBytes ?? 0,
    ...(job.failedReason !== undefined || t?.failureReason !== undefined
      ? { error: job.failedReason ?? t?.failureReason }
      : {}),
  };
}

function jobEventOptions(job: StoredJob): { correlationId?: string } | undefined {
  return job.correlationId ? { correlationId: job.correlationId } : undefined;
}

async function publishJobStatus(downloadId: string, job: StoredJob): Promise<void> {
  if (!emitFn) return;
  const status = statusOf(downloadId, job);
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

async function nextQueuePosition(doc: ResumeDoc): Promise<number> {
  const positions = Object.values(doc.jobs).map((j) => j.queuePosition);
  return positions.length === 0 ? 1 : Math.max(...positions) + 1;
}

// ---- Fail-closed kill switch gate (TAN-045) -----------------------------------
//
// Before this client opens ANY socket for a new job it consults the
// vpn-manager binding gate. Dispatch proceeds only while the tunnel is
// explicitly healthy. Missing or failed policy is a hard block.
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

function assertNntpReady(): void {
  if (cfg.servers.length === 0) {
    throw new DownloadClientError("blocked", "no Usenet servers are configured");
  }
  const implicit = cfg.servers.filter((server) => server.tls === "implicit");
  if (implicit.length === 0) {
    throw new DownloadClientError("blocked", "STARTTLS is not supported in this build; configure an implicit TLS server");
  }
  const usable = implicit.filter((server) => Boolean(serverPassword(server)));
  if (usable.length === 0) {
    throw new DownloadClientError("blocked", "no configured Usenet server has an available secret reference");
  }
}

function assertSafeNzbSource(path: string): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new DownloadClientError("blocked", "NZB source must be a regular file, not a symlink");
  }
  if (stat.size > 16 * 1024 * 1024) {
    throw new DownloadClientError("blocked", "NZB source exceeds the 16 MiB parser limit");
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
  assertNntpReady();

  const doc = await loadResume();
  // Idempotent add by itemKey.
  const existingId = Object.entries(doc.jobs).find(
    ([, j]) => j.itemKey === req.itemKey && !j.failedReason && engine.get(j.jobId),
  );
  if (existingId) return statusOf(existingId[0], existingId[1]);

  assertStorageSafe(0);
  const sourcePath = /^https?:\/\//i.test(req.sourceUrl)
    ? await cacheReleaseSource(req.sourceUrl, cfg.downloadRoots[0]!, ".nzb", 16 * 1024 * 1024)
    : req.sourceUrl;
  if (!(isAbsolute(sourcePath) && sourcePath.endsWith(".nzb")))
    throw new DownloadClientError("invalid_request", "sourceUrl must be an absolute .nzb path");
  assertSafeNzbSource(sourcePath);

  const parsed = parseNzb(readFileSync(sourcePath, "utf8"));
  const declaredSize = parsed.files.reduce(
    (total, file) => total + file.segments.reduce((fileTotal, segment) => fileTotal + segment.bytes, 0),
    0,
  );
  assertStorageSafe(declaredSize);

  doc.seq += 1;
  const downloadId = `un-${String(doc.seq).padStart(4, "0")}`;
  const downloadPath = join(cfg.downloadRoots[0] ?? "", downloadId);
  assertPerJobRoot(downloadPath);
  const added = await engine.add({ sourceKind: "nzb-path", sourcePath, downloadPath });
  const job: StoredJob = {
    itemKey: req.itemKey,
    title: req.title,
    jobId: added.id,
    nzbPath: sourcePath,
    downloadPath,
    queuePosition: await nextQueuePosition(doc),
    resume: engine.snapshot(added.id),
    ...(req.correlationId ? { correlationId: req.correlationId } : {}),
  };
  doc.jobs[downloadId] = job;
  await saveResume(doc);

  await emitFn?.(
    EventTypes.DownloadQueued,
    { downloadId, itemKey: req.itemKey, jobId: added.id, queuePosition: job.queuePosition, state: "queued" },
    jobEventOptions(job),
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

async function completedFiles(payload: Record<string, unknown>): Promise<{ files: Array<{ path: string; sizeBytes: number }> }> {
  const { job, id } = await requireJob(payload);
  const current = engine.get(job.jobId);
  if (!current || statusOf(id, job).state !== "completed") return { files: [] };
  const files: Array<{ path: string; sizeBytes: number }> = [];
  for (const relativePath of current.outputFiles) {
    const path = join(job.downloadPath, relativePath);
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

async function pauseJob(payload: Record<string, unknown>): Promise<DownloadStatus> {
  const { job, id } = await requireJob(payload);
  engine.pause(job.jobId);
  job.resume = engine.snapshot(job.jobId);
  const doc = await loadResume();
  doc.jobs[id] = job;
  await saveResume(doc);
  await emitFn?.(EventTypes.DownloadProgress, { downloadId: id, itemKey: job.itemKey, paused: true }, jobEventOptions(job));
  return statusOf(id, job);
}

async function resumeJob(payload: Record<string, unknown>): Promise<DownloadStatus> {
  const { job, id } = await requireJob(payload);
  await assertKillSwitchOpen(
    invokeCtx ?? { invoke: async () => { throw new Error("plugin is not mounted"); } },
    PLUGIN_ID,
  );
  assertNntpReady();
  engine.resume(job.jobId);
  job.resume = engine.snapshot(job.jobId);
  const doc = await loadResume();
  doc.jobs[id] = job;
  await saveResume(doc);
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
  await assertKillSwitchOpen(
    invokeCtx ?? { invoke: async () => { throw new Error("plugin is not mounted"); } },
    PLUGIN_ID,
  );
  assertNntpReady();
  await engine.remove(job.jobId, { keepFiles: true });
  assertPerJobRoot(job.downloadPath);
  const added = await engine.add({
    sourceKind: "nzb-path",
    sourcePath: job.nzbPath,
    downloadPath: job.downloadPath,
    ...(job.resume ? { resume: job.resume } : {}),
  });
  job.jobId = added.id;
  engine.resume(added.id);
  job.resume = engine.snapshot(added.id);
  job.failedReason = undefined;
  const doc = await loadResume();
  doc.jobs[id] = job;
  await saveResume(doc);
  return statusOf(id, job);
}

/** Drive every active job one segment-step, in queue order, up to maxConcurrent. */
async function advanceAll(): Promise<{ downloads: DownloadStatus[] }> {
  if (workerRunning) return listJobs();
  workerRunning = true;
  try {
  const doc = await loadResume();
  const ordered = Object.entries(doc.jobs)
    .sort(([, a], [, b]) => a.queuePosition - b.queuePosition)
    .filter(([, job]) => {
      const state = engine.get(job.jobId)?.state;
      return state === "queued" || state === "downloading";
    })
    .slice(0, cfg.maxConcurrent);
  if (ordered.length > 0) {
    await assertKillSwitchOpen(
      invokeCtx ?? { invoke: async () => { throw new Error("plugin is not mounted"); } },
      PLUGIN_ID,
    );
    assertNntpReady();
  }
  for (const [downloadId, job] of ordered) {
    try {
      await engine.advance(job.jobId);
      job.resume = engine.snapshot(job.jobId);
      doc.jobs[downloadId] = job;
    } catch (err) {
      job.failedReason = String((err as Error).message ?? err);
    }
    await publishJobStatus(downloadId, job);
  }
  // Controls may change the stored queue while an article or extraction is running.
  const current = await loadResume();
  for (const [downloadId, job] of ordered) {
    if (current.jobs[downloadId]?.jobId === job.jobId && engine.get(job.jobId)) {
      current.jobs[downloadId] = { ...current.jobs[downloadId]!, resume: engine.snapshot(job.jobId), failedReason: job.failedReason };
    }
  }
  await saveResume(current);
  const downloads = Object.entries(current.jobs)
    .map(([id, job]) => statusOf(id, job))
    .sort((a, b) => a.downloadId.localeCompare(b.downloadId));
  return { downloads };
  } finally {
    workerRunning = false;
  }
}

// ---- Engine capability operations ------------------------------------------------------

async function verifyCrc(payload: Record<string, unknown>): Promise<{
  downloadId: string;
  warnings: readonly string[];
}> {
  const { job, id } = await requireJob(payload);
  const t = engine.get(job.jobId);
  if (!t) throw new DownloadClientError("unknown_download", `unknown download ${id}`);
  await emitFn?.(
    EventTypes.DownloadProgress,
    { downloadId: id, itemKey: job.itemKey, crcWarnings: t.warnings },
    jobEventOptions(job),
  );
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
  return { downloadId: id, repaired: result.repaired, recoveredFiles: result.recoveredFiles, missingBlocks: result.missingBlocks };
}

async function unpackJob(payload: Record<string, unknown>): Promise<{
  downloadId: string;
  unpacked: boolean;
  files: readonly string[];
}> {
  const { job, id } = await requireJob(payload);
  const result = await engine.unpack(job.jobId);
  return { downloadId: id, unpacked: result.unpacked, files: result.files };
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
      await emitFn?.(EventTypes.DownloadProgress, {
        downloadId,
        itemKey: job.itemKey,
        recovered: true,
      }, jobEventOptions(job));
      continue;
    }
    try {
      job.downloadPath = job.downloadPath || join(cfg.downloadRoots[0] ?? "", downloadId);
      assertPerJobRoot(job.downloadPath);
      assertSafeNzbSource(job.nzbPath);
      const added = await engine.add({
        sourceKind: "nzb-path",
        sourcePath: job.nzbPath,
        downloadPath: job.downloadPath,
        ...(job.resume ? { resume: job.resume } : {}),
      });
      if (added.id !== job.jobId) {
        // Re-add produced a fresh engine id — remap so the durable record keeps working.
        job.jobId = added.id;
        doc.jobs[downloadId] = job;
      }
      job.resume = engine.snapshot(added.id);
      recovered += 1;
      await emitFn?.(EventTypes.DownloadProgress, {
        downloadId,
        itemKey: job.itemKey,
        recovered: true,
      }, jobEventOptions(job));
    } catch (err) {
      logFn?.("warn", `recovery skipped ${job.itemKey}: ${(err as Error).message}`);
    }
  }
  await saveResume(doc);
  return recovered;
}

async function loadPersistedServers(): Promise<UsenetServerConfig[] | null> {
  if (!storeGet) return null;
  const hit = await storeGet(CONFIG_KEY);
  if (!hit || !hit.doc || typeof hit.doc !== "object") return null;
  return parseServerList((hit.doc as Record<string, unknown>).servers);
}

function configurationStatus(): {
  ready: boolean;
  servers: RedactedUsenetServerConfig[];
  downloadRoots: string[];
  limitations: { starttls: false; par2: boolean; archives: boolean };
} {
  const servers = serverPriorities();
  return {
    ready:
      cfg.downloadRoots.length > 0 &&
      servers.some((server) => server.tls === "implicit" && server.hasPassword),
    servers,
    downloadRoots: [...cfg.downloadRoots],
    limitations: { starttls: false, par2: Boolean(postprocessTools.par2), archives: Boolean(postprocessTools.archive) },
  };
}

async function testServer(payload: Record<string, unknown>): Promise<{
  ok: true;
  server: RedactedUsenetServerConfig;
}> {
  const raw = (payload.server ?? payload) as Record<string, unknown>;
  const existing = cfg.servers.find((server) => server.id === raw.id);
  const server = parseServerConfig(existing && raw.passwordEnv === undefined && raw.passwordRef === undefined
    ? { ...raw, ...(existing.passwordEnv ? { passwordEnv: existing.passwordEnv } : { passwordRef: existing.passwordRef }) }
    : raw);
  await hydratePasswords([server]);
  await assertKillSwitchOpen(
    invokeCtx ?? { invoke: async () => { throw new Error("plugin is not mounted"); } },
    PLUGIN_ID,
  );
  const transport = new TlsNntpTransport(materializeServer(server));
  try {
    await transport.connect();
  } finally {
    await transport.close();
  }
  return {
    ok: true,
    server: redactServer(server),
  };
}

async function configureServers(payload: Record<string, unknown>): Promise<ReturnType<typeof configurationStatus>> {
  if (workerRunning) {
    throw new DownloadClientError("blocked", "Usenet configuration cannot change while the worker is advancing a job");
  }
  if (Object.hasOwn(payload, "password")) {
    throw new DownloadClientError("invalid_request", "inline Usenet passwords are forbidden; use passwordEnv");
  }
  const rawServers = Array.isArray(payload.servers)
    ? payload.servers.map((value) => {
        if (!value || typeof value !== "object") return value;
        const raw = value as Record<string, unknown>;
        const existing = cfg.servers.find((server) => server.id === raw.id);
        return existing && raw.passwordEnv === undefined && raw.passwordRef === undefined
          ? { ...raw, ...(existing.passwordEnv ? { passwordEnv: existing.passwordEnv } : { passwordRef: existing.passwordRef }) }
          : raw;
      })
    : payload.servers;
  const servers = parseServerList(rawServers);
  await hydratePasswords(servers);
  workerRunning = true;
  try {
    await engine.close();
    cfg = { ...cfg, servers };
    engine = createEngine(servers);
    await storePut?.(CONFIG_KEY, { servers });
    await recoverOnMount();
    return configurationStatus();
  } finally {
    workerRunning = false;
  }
}

const plugin: PluginDefinition = definePlugin({
  manifest: validateManifest({
    id: PLUGIN_ID,
    version: "0.1.0",
    protocolVersion: PROTOCOL_VERSION,
    provides: [CLIENT_CAPABILITY, ENGINE_CAPABILITY],
    requires: ["dev.tantalar.capability.event.emit", "dev.tantalar.capability.log", VPN_BINDING_CAP, "dev.tantalar.capability.secret.resolve"],
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
    const persistedServers = await loadPersistedServers();
    if (persistedServers) cfg = { ...cfg, servers: persistedServers };
    await hydratePasswords(cfg.servers);
    await engine.close();
    engine = createEngine(cfg.servers);
    const recovered = await recoverOnMount();
    workerTimer = setInterval(() => {
      void advanceAll().catch((err) => {
        logFn?.("warn", `Usenet worker paused: ${String((err as Error).message ?? err)}`);
      });
    }, WORKER_INTERVAL_MS);
    workerTimer.unref();
    ctx.log("info", `usenet-native mounted (recovered ${recovered} jobs)`);
  },

  async unmount(ctx: PluginContext) {
    if (workerTimer) clearInterval(workerTimer);
    workerTimer = null;
    lastPublishedProgress.clear();
    await engine.close();
    emitFn = null;
    logFn = null;
    invokeCtx = null;
    resolvedPasswords.clear();
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
        case "configuration-status":
          return configurationStatus();
        case "test-server":
          return testServer(payload);
        case "configure":
          return configureServers(payload);
        default:
          throw new DownloadClientError("invalid_request", `unknown operation ${operation}`);
      }
    },
  },
});

// Unit tests import the fail-closed gate from this module. Do not attach the
// plugin control protocol to their process stdin. The supervisor always sets
// TANTALAR_PLUGIN_ID for the real child process.
if (process.env["TANTALAR_PLUGIN_ID"] === PLUGIN_ID) runPlugin(plugin);
