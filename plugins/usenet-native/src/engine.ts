/**
 * dev.tantalar.plugin.usenet-native (TAN-010) — embedded Usenet engine.
 *
 * NO SABnzbd or external download daemon: NNTP transport, yEnc decoding,
 * CRC verification, and bounded file writes run in-process. The production
 * transport is a certificate-validating TLS NNTP client. Tests can inject
 * MemoryNntpTransport with legal synthetic fixtures.
 *
 * Tantalar owns server priorities, connection pools, scheduling, yEnc/CRC,
 * storage safety, and durable segment checkpoints. The plugin blocks PAR2
 * and archive post-processing until reviewed implementations ship.
 */

import {
  closeSync,
  constants as fsConstants,
  createReadStream,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  truncateSync,
  writeSync,
} from "node:fs";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import * as zlib from "node:zlib";

// ---- yEnc ---------------------------------------------------------------------

/**
 * Decode a yEnc-encoded body. yEnc escapes CR/LF/NULL/'=' via =XX octets.
 * Returns the decoded bytes and the CRC32 the encoder declared, when present.
 */
export function decodeYenc(body: string): {
  data: Buffer;
  declaredCrc32: string | null;
  declaredPartCrc32: string | null;
} {
  const out = Buffer.allocUnsafe(Buffer.byteLength(body, "latin1"));
  let outLength = 0;
  let declaredCrc32: string | null = null;
  let declaredPartCrc32: string | null = null;
  let declaredSize: number | null = null;
  let sawBegin = false;
  let sawEnd = false;
  let pos = 0;
  const lines = body.split(/\r?\n/);
  while (pos < lines.length) {
    const line = lines[pos]!;
    if (line.startsWith("=ybegin ")) {
      sawBegin = true;
      const m = line.match(/crc32=([0-9a-fA-F]{8})/);
      if (m) declaredCrc32 = m[1]!.toLowerCase();
      pos += 1;
      continue;
    }
    if (line.startsWith("=yend ")) {
      sawEnd = true;
      const m = line.match(/(?:^|\s)crc32=([0-9a-fA-F]{8})(?:\s|$)/);
      if (m) declaredCrc32 = m[1]!.toLowerCase();
      const part = line.match(/pcrc32=([0-9a-fA-F]{8})/);
      if (part) declaredPartCrc32 = part[1]!.toLowerCase();
      const size = line.match(/(?:^|\s)size=(\d+)(?:\s|$)/);
      if (size) declaredSize = Number(size[1]);
      pos += 1;
      continue;
    }
    if (line.startsWith("=ypart ")) {
      pos += 1;
      continue;
    }
    for (let i = 0; i < line.length; i++) {
      const c = line.charCodeAt(i);
      if (c === 61 /* '=' */) {
        if (i + 1 >= line.length) throw new Error("invalid truncated yEnc escape");
        const esc = line.charCodeAt(i + 1);
        // Escaped byte: (raw+42) was itself escaped as +64; undo both.
        out[outLength++] = (esc - 64 - 42 + 512) & 0xff;
        i += 1;
      } else {
        out[outLength++] = (c - 42 + 256) & 0xff;
      }
    }
    pos += 1;
  }
  if (!sawBegin || !sawEnd) throw new Error("NNTP article does not contain a complete yEnc body");
  if (declaredSize !== null && declaredSize !== outLength) throw new Error("yEnc body size does not match its trailer");
  return { data: out.subarray(0, outLength), declaredCrc32, declaredPartCrc32 };
}

export function crc32(buf: Buffer): string {
  return updateCrc32(buf, 0).toString(16).padStart(8, "0");
}

function updateCrc32(buf: Buffer, previous: number): number {
  if (typeof zlib.crc32 === "function") return zlib.crc32(buf, previous);
  // Retain support for runtimes without the native checksum implementation.
  let crc = previous ^ 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i]!;
    for (let b = 0; b < 8; b++) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// ---- NZB (minimal XML subset parser — no external dependency) ------------------

export interface NzbFileEntry {
  readonly subject: string;
  readonly fileName: string;
  readonly groups: readonly string[];
  readonly segments: readonly { bytes: number; number: number; messageId: string }[];
}

export interface ParsedNzb {
  readonly name: string;
  readonly files: readonly NzbFileEntry[];
}

function decodeXmlText(value: string): string {
  return value.replace(/&(?:#(\d+)|#x([0-9a-fA-F]+)|quot|apos|lt|gt|amp);/g, (entity, decimal, hex) => {
    if (decimal) return String.fromCodePoint(Number(decimal));
    if (hex) return String.fromCodePoint(Number.parseInt(hex, 16));
    switch (entity) {
      case "&quot;": return '"';
      case "&apos;": return "'";
      case "&lt;": return "<";
      case "&gt;": return ">";
      case "&amp;": return "&";
      default: return entity;
    }
  });
}

function xmlAttribute(attributes: string, name: string): string | null {
  const match = attributes.match(new RegExp(`(?:^|\\s)${name}="([^"]*)"`));
  return match ? decodeXmlText(match[1]!) : null;
}

/** Return a single safe output name or fail before any directory is created. */
export function nzbOutputFileName(subject: string): string {
  const quoted = subject.match(/["']([^"']+)["']/)?.[1];
  const candidate = (quoted ?? subject.replace(/\s*\(\d+\/\d+\).*$/, "")).trim();
  if (
    candidate.length === 0 ||
    candidate.length > 240 ||
    candidate === "." ||
    candidate === ".." ||
    isAbsolute(candidate) ||
    /[\\/\0\r\n]/.test(candidate) ||
    basename(candidate) !== candidate
  ) {
    throw new Error("nzb contains an unsafe output filename");
  }
  return candidate;
}

/** Parse the minimal NZB XML subset Tantalar emits/consumes. Fails closed. */
export function parseNzb(xml: string): ParsedNzb {
  const nameMatch = xml.match(/<file[^>]*subject="([^"]*)"/);
  const files: NzbFileEntry[] = [];
  const fileRe = /<file\b[^>]*subject="([^"]*)"[^>]*>([\s\S]*?)<\/file>/g;
  let m: RegExpExecArray | null;
  while ((m = fileRe.exec(xml)) !== null) {
    const subject = decodeXmlText(m[1]!);
    const fileName = nzbOutputFileName(subject);
    const groups: string[] = [];
    const groupRe = /<group>([^<]+)<\/group>/g;
    let g: RegExpExecArray | null;
    while ((g = groupRe.exec(m[2]!)) !== null) groups.push(g[1]!.trim());
    const segments: { bytes: number; number: number; messageId: string }[] = [];
    const segRe = /<segment\b([^>]*)>([^<]+)<\/segment>/g;
    let s: RegExpExecArray | null;
    while ((s = segRe.exec(m[2]!)) !== null) {
      const bytes = Number(xmlAttribute(s[1]!, "bytes"));
      const number = Number(xmlAttribute(s[1]!, "number"));
      const messageId = decodeXmlText(s[2]!).trim();
      if (!Number.isSafeInteger(bytes) || bytes < 1 || !Number.isSafeInteger(number) || number < 1) {
        throw new Error(`nzb file "${subject}" contains invalid segment metadata`);
      }
      if (messageId.length === 0 || messageId.length > 998 || /[\0\r\n]/.test(messageId)) {
        throw new Error(`nzb file "${subject}" contains an invalid message id`);
      }
      segments.push({ bytes, number, messageId });
    }
    if (segments.length === 0) throw new Error(`nzb file "${subject}" has no segments`);
    if (new Set(segments.map((segment) => segment.number)).size !== segments.length) {
      throw new Error(`nzb file "${subject}" contains duplicate segment numbers`);
    }
    files.push({ subject, fileName, groups, segments: segments.sort((a, b) => a.number - b.number) });
  }
  if (files.length === 0) throw new Error("nzb contains no files");
  const names = new Set<string>();
  for (const file of files) {
    const key = file.fileName.toLocaleLowerCase("en-US");
    if (names.has(key)) throw new Error(`nzb contains a duplicate output filename: ${file.fileName}`);
    names.add(key);
  }
  const name = decodeXmlText(nameMatch?.[1] ?? files[0]!.subject).replace(/\(\d+\/\d+\).*$/, "").trim() || "download";
  return { name, files };
}

// ---- PAR2 (repair seam) ----------------------------------------------------------

export interface RepairResult {
  readonly repaired: boolean;
  readonly missingBlocks: number;
  readonly recoveredFiles: readonly string[];
  readonly detail: string;
}

export interface Par2Repairer {
  readonly available?: boolean;
  /**
   * Verify + repair the files in `dir` using PAR2 recovery data. Returns a
   * truthful result; never invents content it could not recover.
   */
  repair(dir: string, targetFiles: readonly string[], signal?: AbortSignal): Promise<RepairResult>;
}

/**
 * MemoryPar2Repairer (test seam): a file is "damaged" when its on-disk bytes
 * differ from the fixture payload; recovery data restores it. Mirrors what a
 * real PAR2 tool guarantees without shipping one.
 */
export class MemoryPar2Repairer implements Par2Repairer {
  constructor(
    private readonly fixtures: ReadonlyMap<string, Buffer>, // abs path -> original bytes
  ) {}

  async repair(dir: string, targetFiles: readonly string[]): Promise<RepairResult> {
    const { readFileSync, writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const recovered: string[] = [];
    let missing = 0;
    for (const f of targetFiles) {
      const abs = join(dir, f);
      const original = this.fixtures.get(abs);
      if (!original) {
        missing += 1;
        continue;
      }
      let current: Buffer;
      try {
        current = readFileSync(abs);
      } catch {
        current = Buffer.alloc(0);
      }
      if (!current.equals(original)) {
        if (current.length === 0) missing += 1;
        writeFileSync(abs, original); // recovery data applied
        recovered.push(f);
      }
    }
    return {
      repaired: recovered.length > 0,
      missingBlocks: missing,
      recoveredFiles: recovered,
      detail: recovered.length > 0 ? `recovered ${recovered.length} file(s)` : "all files verified intact",
    };
  }
}

// ---- Unpack seam -------------------------------------------------------------------

export interface UnpackResult {
  readonly unpacked: boolean;
  readonly files: readonly string[];
  readonly detail: string;
}

export interface Unpacker {
  unpack(archivePath: string, destDir: string, signal?: AbortSignal): Promise<UnpackResult>;
}

/**
 * MemoryUnpacker (test seam): "archives" are marker files; unpacking
 * materializes the fixture payload files next to them.
 */
export class MemoryUnpacker implements Unpacker {
  constructor(
    private readonly contents: ReadonlyMap<string, Buffer>, // archive abs path -> concatenated payload
  ) {}

  async unpack(archivePath: string, destDir: string): Promise<UnpackResult> {
    const { mkdirSync, writeFileSync } = await import("node:fs");
    const { basename, join } = await import("node:path");
    const payload = this.contents.get(archivePath);
    if (!payload) return { unpacked: false, files: [], detail: `no unpack data for ${archivePath}` };
    mkdirSync(destDir, { recursive: true });
    const stem = basename(archivePath).replace(/\.(rar|7z|zip)$/i, "");
    const out = join(destDir, `${stem}.bin`);
    writeFileSync(out, payload);
    return { unpacked: true, files: [out], detail: "unpacked 1 file" };
  }
}

// ---- NNTP transport seam ------------------------------------------------------------

export interface NntpArticle {
  readonly messageId: string;
  readonly body: string; // yEnc text body
}

export interface NntpTransport {
  /** Connect and authenticate; called once per pooled connection. */
  connect(): Promise<void>;
  /** Fetch one article body by message-id. */
  article(messageId: string): Promise<NntpArticle>;
  close(): Promise<void>;
}

export interface NntpServerConfig {
  readonly name: string;
  readonly host: string;
  readonly port: number;
  readonly tls: boolean;
  readonly username?: string;
  readonly password?: string; // secret; transport-internal only, never logged
  readonly priority: number; // lower fills first
  readonly maxConnections: number;
}

/**
 * MemoryNntpTransport (test seam): serves articles from an in-memory pool.
 * `fillServer` is a lower-priority backup; the pool tries servers in priority
 * order and falls back when a higher-priority server misses a segment.
 */
export class MemoryNntpTransport implements NntpTransport {
  readonly servedFrom = new Map<string, string>(); // messageId -> server name

  constructor(
    private readonly server: NntpServerConfig,
    private readonly articles: ReadonlyMap<string, string>, // messageId -> body
  ) {}

  async connect(): Promise<void> {
    if (!this.server.host) throw new Error("no host configured");
  }

  async article(messageId: string): Promise<NntpArticle> {
    const body = this.articles.get(messageId);
    if (body === undefined) {
      const err = new Error(`ARTICLE 430 ${messageId}: not found on ${this.server.name}`) as Error & { code?: string };
      err.code = "ARTICLE_MISSING";
      throw err;
    }
    this.servedFrom.set(messageId, this.server.name);
    return { messageId, body };
  }

  async close(): Promise<void> {
    /* pooled connection teardown */
  }
}

// ---- Engine --------------------------------------------------------------------------

export interface EngineNzbSource {
  readonly sourceKind: "nzb-path";
  readonly sourcePath: string;
  readonly downloadPath: string;
  readonly resume?: EngineResumeState;
}

export interface EngineResumeState {
  readonly paused?: boolean;
  readonly needsRepair?: boolean;
  readonly cursor: number;
  readonly receivedBytes: number;
  readonly segmentsDone: number;
  readonly warnings: readonly string[];
  readonly files: readonly {
    readonly fileName: string;
    readonly bytesWritten: number;
    readonly declaredCrc: string | null;
  }[];
}

export interface EngineJob {
  readonly id: string;
  readonly name: string;
  readonly state: "queued" | "downloading" | "paused" | "completed" | "failed";
  readonly totalBytes: number;
  readonly receivedBytes: number;
  readonly segmentsDone: number;
  readonly segmentsTotal: number;
  readonly warnings: readonly string[];
  readonly failureReason?: string;
  readonly repair?: RepairResult;
  readonly unpack?: UnpackResult;
  readonly outputFiles: readonly string[];
}

export interface NntpEngine {
  add(src: EngineNzbSource): Promise<{ id: string; totalBytes: number; segmentsTotal: number }>;
  get(id: string): EngineJob | undefined;
  advance(id: string): Promise<void>;
  pause(id: string): void;
  resume(id: string): void;
  repair(id: string): Promise<RepairResult>;
  unpack(id: string): Promise<UnpackResult>;
  remove(id: string, opts: { keepFiles: boolean }): Promise<void>;
  snapshot(id: string): EngineResumeState;
  close(): Promise<void>;
}

interface EngineState {
  needsRepair: boolean;
  id: string;
  name: string;
  downloadPath: string;
  sourcePath: string;
  state: "queued" | "downloading" | "paused" | "completed" | "failed";
  totalBytes: number;
  receivedBytes: number;
  segmentsDone: number;
  segmentsTotal: number;
  warnings: string[];
  failureReason?: string;
  repair?: RepairResult;
  unpack?: UnpackResult;
  outputFiles: string[];
  files: Array<{
    entry: NzbFileEntry;
    bytesWritten: number;
    declaredCrc: string | null;
  }>;
  cursor: number; // next segment index across the flattened list
}

export interface NntpEngineDeps {
  /** Servers in priority order (index 0 fills first). */
  servers: readonly NntpServerConfig[];
  transports: readonly NntpTransport[];
  repairer: Par2Repairer;
  unpacker: Unpacker;
  log?(level: "debug" | "info" | "warn" | "error", message: string): void;
}

function containedPath(root: string, name: string): string {
  const resolvedRoot = resolve(root);
  const candidate = resolve(resolvedRoot, name);
  if (candidate === resolvedRoot || !candidate.startsWith(`${resolvedRoot}${sep}`)) {
    throw new Error("nzb output path escapes the job root");
  }
  return candidate;
}

function assertSafeExistingFile(path: string): void {
  if (!existsSync(path)) return;
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("nzb output target is not a regular file");
}

function assertSafeJobRoot(path: string): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("job download path is not a regular directory");
}

function appendContained(path: string, data: Buffer): void {
  assertSafeExistingFile(path);
  const flags = fsConstants.O_WRONLY | fsConstants.O_APPEND | fsConstants.O_CREAT | (fsConstants.O_NOFOLLOW ?? 0);
  const fd = openSync(path, flags, 0o600);
  try {
    if (!fstatSync(fd).isFile()) throw new Error("nzb output target is not a regular file");
    let offset = 0;
    while (offset < data.length) offset += writeSync(fd, data, offset, data.length - offset);
  } finally {
    closeSync(fd);
  }
}

async function crc32File(path: string, signal: AbortSignal): Promise<string> {
  assertSafeExistingFile(path);
  let crc = 0;
  const stream = createReadStream(path, {
    fd: openSync(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0)),
    signal,
  });
  for await (const chunk of stream) {
    crc = updateCrc32(chunk as Buffer, crc);
  }
  return crc.toString(16).padStart(8, "0");
}

function firstArchiveVolume(name: string): boolean {
  return /(?:\.rar|\.7z|\.zip|\.7z\.001|\.zip\.001)$/i.test(name) && (!/\.part\d+\.rar$/i.test(name) || /\.part0*1\.rar$/i.test(name));
}

/**
 * MemoryNntpEngine: drives NZB jobs segment-by-segment through the pooled
 * transports with priority fill-server behavior, yEnc decode + CRC check,
 * PAR2 repair and unpacking. All state is in-memory; the plugin layer owns
 * durable persistence.
 */
export class MemoryNntpEngine implements NntpEngine {
  readonly #jobs = new Map<string, EngineState>();
  readonly #active = new Map<string, { controller: AbortController; promise: Promise<void> }>();
  #seq = 0;
  readonly #deps: NntpEngineDeps;

  constructor(deps: NntpEngineDeps) {
    this.#deps = deps;
  }

  async add(src: EngineNzbSource): Promise<{ id: string; totalBytes: number; segmentsTotal: number }> {
    if (!isAbsolute(src.sourcePath)) throw new Error("NZB source path must be absolute");
    if (!isAbsolute(src.downloadPath)) throw new Error("job download path must be absolute");
    const xml = readFileSync(src.sourcePath, "utf8");
    const parsed = parseNzb(xml);
    mkdirSync(src.downloadPath, { recursive: true, mode: 0o700 });
    const rootStat = lstatSync(src.downloadPath);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
      throw new Error("job download path is not a regular directory");
    }

    this.#seq += 1;
    const id = `un-${String(this.#seq).padStart(4, "0")}`;
    const resume = src.resume;
    if (resume && (resume.cursor !== resume.segmentsDone || resume.cursor < 0)) {
      throw new Error("stored NNTP segment cursor is invalid");
    }
    if (resume && resume.files.length !== parsed.files.length) {
      throw new Error("stored NNTP file checkpoint does not match the NZB");
    }

    const files = parsed.files.map((entry, index) => {
      const saved = resume?.files[index];
      if (saved && saved.fileName !== entry.fileName) {
        throw new Error("stored NNTP file checkpoint does not match the NZB");
      }
      const bytesWritten = saved?.bytesWritten ?? 0;
      if (!Number.isSafeInteger(bytesWritten) || bytesWritten < 0) {
        throw new Error("stored NNTP byte checkpoint is invalid");
      }
      const target = containedPath(src.downloadPath, entry.fileName);
      assertSafeExistingFile(target);
      if (existsSync(target)) {
        const size = lstatSync(target).size;
        if (!resume) throw new Error(`job output already exists: ${entry.fileName}`);
        if (size < bytesWritten) throw new Error(`stored NNTP byte checkpoint exceeds ${entry.fileName}`);
        truncateSync(target, bytesWritten);
      } else if (bytesWritten > 0) {
        throw new Error(`stored NNTP output is missing: ${entry.fileName}`);
      }
      return { entry, bytesWritten, declaredCrc: saved?.declaredCrc ?? null };
    });
    const totalBytes = files.reduce((a, f) => a + f.entry.segments.reduce((b, s) => b + s.bytes, 0), 0);
    const segmentsTotal = files.reduce((a, f) => a + f.entry.segments.length, 0);
    const cursor = resume?.cursor ?? 0;
    if (!Number.isSafeInteger(cursor) || cursor > segmentsTotal) {
      throw new Error("stored NNTP segment cursor is invalid");
    }
    const receivedBytes = resume?.receivedBytes ?? 0;
    if (
      !Number.isSafeInteger(receivedBytes) ||
      receivedBytes < 0 ||
      receivedBytes !== files.reduce((sum, file) => sum + file.bytesWritten, 0)
    ) {
      throw new Error("stored NNTP received byte checkpoint is invalid");
    }
    this.#jobs.set(id, {
      needsRepair: resume?.needsRepair ?? false,
      id,
      name: parsed.name,
      downloadPath: src.downloadPath,
      sourcePath: src.sourcePath,
      state: src.resume?.paused === true ? "paused" : "queued",
      totalBytes,
      receivedBytes,
      segmentsDone: resume?.segmentsDone ?? 0,
      segmentsTotal,
      warnings: [...(resume?.warnings ?? [])],
      outputFiles: files.filter((file) => file.bytesWritten > 0).map((file) => file.entry.fileName),
      files,
      cursor,
    });
    return { id, totalBytes, segmentsTotal };
  }

  get(id: string): EngineJob | undefined {
    const j = this.#jobs.get(id);
    if (!j) return undefined;
    return {
      id: j.id,
      name: j.name,
      state: j.state,
      totalBytes: j.totalBytes,
      receivedBytes: j.receivedBytes,
      segmentsDone: j.segmentsDone,
      segmentsTotal: j.segmentsTotal,
      warnings: [...j.warnings],
      ...(j.failureReason !== undefined ? { failureReason: j.failureReason } : {}),
      ...(j.repair !== undefined ? { repair: j.repair } : {}),
      ...(j.unpack !== undefined ? { unpack: j.unpack } : {}),
      outputFiles: [...j.outputFiles],
    };
  }

  /**
   * Advance one segment across the whole job. Fill-server behavior: try
   * transports in server priority order; a missing segment on a
   * higher-priority server falls through to the next (recorded as a warning).
   */
  async advance(id: string): Promise<void> {
    const active = this.#active.get(id);
    if (active) return active.promise;
    return this.#operate(id, signal => this.#advance(id, signal));
  }

  #operate<T>(id: string, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.#active.has(id)) throw new Error("A download operation is already running.");
    const controller = new AbortController();
    const promise = operation(controller.signal).finally(() => this.#active.delete(id));
    this.#active.set(id, { controller, promise: promise.then(() => undefined, () => undefined) });
    return promise;
  }

  async #advance(id: string, signal: AbortSignal): Promise<void> {
    const j = this.#jobs.get(id);
    if (!j) throw new Error(`unknown job ${id}`);
    if (j.state === "paused" || j.state === "completed" || j.state === "failed") return;
    if (j.segmentsDone >= j.segmentsTotal) {
      await this.#finalize(id, signal);
      return;
    }
    j.state = "downloading";

    // Flatten segment order: file-major, segment-number order.
    const flat: Array<{ fileIdx: number; segIdx: number }> = [];
    j.files.forEach((f, fi) => f.entry.segments.forEach((_, si) => flat.push({ fileIdx: fi, segIdx: si })));
    const next = flat[j.cursor];
    if (!next) {
      await this.#finalize(id, signal);
      return;
    }
    const file = j.files[next.fileIdx]!;
    const seg = file.entry.segments[next.segIdx]!;
    const hasVideo = j.files.some(f => /\.(?:mkv|mp4|m4v|avi|mov|ts|m2ts|webm|mpg|mpeg)$/i.test(f.entry.fileName));
    if (hasVideo && !this.#deps.repairer.available && /\.par2$/i.test(file.entry.fileName)) {
      this.#skipOptionalFile(j, file, next.segIdx, "Recovery file is not needed for an intact video");
      return;
    }

    if (this.#deps.transports.length === 0) {
      j.state = "failed";
      j.failureReason = "no NNTP servers are configured";
      return;
    }

    let fetched: string | null = null;
    for (let t = 0; t < this.#deps.transports.length; t++) {
      try {
        const art = await this.#deps.transports[t]!.article(seg.messageId);
        fetched = art.body;
        break;
      } catch (err) {
        if (signal.aborted) return;
        const code = (err as { code?: string }).code;
        if (code === "ARTICLE_MISSING") {
          const msg = `segment ${seg.number} of "${file.entry.fileName}" missing on server ${this.#deps.servers[t]?.name ?? t}; falling back`;
          if (!j.warnings.includes(msg)) j.warnings.push(msg);
          this.#deps.log?.("warn", msg);
          continue;
        }
        j.state = "failed";
        j.failureReason = `NNTP server ${this.#deps.servers[t]?.name ?? t} failed: ${String((err as Error).message ?? err)}`;
        return;
      }
    }
    if (signal.aborted) return;
    const hasPayload = hasVideo || j.files.some(f => firstArchiveVolume(f.entry.fileName));
    if (fetched === null) {
      if (hasPayload && /\.(?:nfo|sfv|srr|txt|jpe?g|png|par2)$/i.test(file.entry.fileName)) {
        this.#skipOptionalFile(j, file, next.segIdx, "Optional file is unavailable on all configured servers");
        return;
      }
      if (this.#deps.repairer.available && j.files.some(f => /\.par2$/i.test(f.entry.fileName))) {
        j.needsRepair = true;
        j.warnings.push(`Missing segment ${seg.number}; PAR2 repair will run after download.`);
        j.cursor++;
        j.segmentsDone++;
        return;
      }
      j.state = "failed";
      j.failureReason = `segment ${seg.messageId} unavailable on all configured servers`;
      return;
    }
    let decoded: ReturnType<typeof decodeYenc>;
    try { decoded = decodeYenc(fetched); }
    catch {
      if (hasPayload && /\.(?:nfo|sfv|srr|txt|jpe?g|png)$/i.test(file.entry.fileName)) {
        this.#skipOptionalFile(j, file, next.segIdx, "Optional file is not yEnc encoded");
        return;
      }
      if (this.#deps.repairer.available && j.files.some(f => /\.par2$/i.test(f.entry.fileName))) {
        j.needsRepair = true;
        j.cursor++;
        j.segmentsDone++;
        return;
      }
      j.state = "failed";
      j.failureReason = "A download article is not valid yEnc data.";
      return;
    }
    const { data, declaredCrc32, declaredPartCrc32 } = decoded;
    if (declaredPartCrc32 && crc32(data) !== declaredPartCrc32) {
      if (this.#deps.repairer.available && j.files.some(f => /\.par2$/i.test(f.entry.fileName))) {
        j.needsRepair = true;
        j.cursor++;
        j.segmentsDone++;
        return;
      }
      j.state = "failed";
      j.failureReason = `segment ${seg.number} of ${file.entry.fileName} failed its yEnc CRC check`;
      return;
    }
    if (declaredCrc32 && file.declaredCrc === null) file.declaredCrc = declaredCrc32;
    const target = containedPath(j.downloadPath, file.entry.fileName);
    assertSafeJobRoot(j.downloadPath);
    appendContained(target, data);
    file.bytesWritten += data.length;
    if (!j.outputFiles.includes(file.entry.fileName)) j.outputFiles.push(file.entry.fileName);
    j.receivedBytes += data.length;
    j.segmentsDone += 1;
    j.cursor += 1;
    if (j.segmentsDone >= j.segmentsTotal) await this.#finalize(id, signal);
  }

  #skipOptionalFile(j: EngineState, file: EngineState["files"][number], segmentIndex: number, reason: string): void {
    const path = containedPath(j.downloadPath, file.entry.fileName);
    assertSafeJobRoot(j.downloadPath);
    assertSafeExistingFile(path);
    if (file.bytesWritten > 0) rmSync(path);
    j.receivedBytes -= file.bytesWritten;
    file.bytesWritten = 0;
    file.declaredCrc = null;
    j.outputFiles = j.outputFiles.filter(name => name !== file.entry.fileName);
    const remaining = file.entry.segments.length - segmentIndex;
    j.cursor += remaining;
    j.segmentsDone += remaining;
    j.warnings.push(`${reason}: ${file.entry.fileName}`);
  }

  /** Verify, repair when required, then extract before publishing completion. */
  async #finalize(id: string, signal: AbortSignal): Promise<void> {
    const j = this.#jobs.get(id);
    if (!j) return;
    try {
    for (const f of j.files) {
      const abs = containedPath(j.downloadPath, f.entry.fileName);
      assertSafeJobRoot(j.downloadPath);
      if (f.declaredCrc && await crc32File(abs, signal) !== f.declaredCrc) {
        j.needsRepair = true;
      }
    }
    if (j.needsRepair) {
      j.repair = await this.#deps.repairer.repair(j.downloadPath, j.files.map(f => f.entry.fileName), signal);
      signal.throwIfAborted();
      if (!j.repair.repaired) throw new Error("PAR2 could not repair the downloaded data.");
      for (const f of j.files) {
        const path = containedPath(j.downloadPath, f.entry.fileName);
        assertSafeExistingFile(path);
        if (existsSync(path)) {
          if (f.declaredCrc && await crc32File(path, signal) !== f.declaredCrc) throw new Error("CRC mismatch after PAR2 repair.");
          f.bytesWritten = lstatSync(path).size;
          if (!j.outputFiles.includes(f.entry.fileName)) j.outputFiles.push(f.entry.fileName);
        }
      }
      j.receivedBytes = j.files.reduce((sum, file) => sum + file.bytesWritten, 0);
      j.needsRepair = false;
    }
    const hasVideo = j.outputFiles.some(name => /\.(?:mkv|mp4|m4v|avi|mov|ts|m2ts|webm|mpg|mpeg)$/i.test(name));
    const archives = j.outputFiles.filter(firstArchiveVolume);
    for (const archive of archives) {
      const result = await this.#deps.unpacker.unpack(containedPath(j.downloadPath, archive), j.downloadPath, signal);
      signal.throwIfAborted();
      if (!result.unpacked) throw new Error("Archive extraction did not produce files.");
      j.unpack = result;
      for (const path of result.files) {
        const name = relative(j.downloadPath, path);
        containedPath(j.downloadPath, name);
        assertSafeExistingFile(path);
        if (!j.outputFiles.includes(name)) j.outputFiles.push(name);
      }
    }
    if (!hasVideo && !archives.length && j.files.some(f => /\.par2$/i.test(f.entry.fileName))) throw new Error("Recovery files contain no playable media.");
    j.state = "completed";
    } catch (error) {
      if (signal.aborted) return;
      j.state = "failed";
      j.failureReason = String((error as Error).message ?? "Post-processing failed.");
    }
  }

  pause(id: string): void {
    const j = this.#jobs.get(id);
    if (!j) throw new Error(`unknown job ${id}`);
    if (j.state === "downloading" || j.state === "queued") {
      j.state = "paused";
      this.#active.get(id)?.controller.abort();
    }
  }

  resume(id: string): void {
    const j = this.#jobs.get(id);
    if (!j) throw new Error(`unknown job ${id}`);
    if (j.state === "paused") j.state = j.segmentsDone > 0 ? "downloading" : "queued";
  }

  /** Run the PAR2 repair seam over the job's output files. */
  async repair(id: string): Promise<RepairResult> {
    const j = this.#jobs.get(id);
    if (!j) throw new Error(`unknown job ${id}`);
    if (j.state !== "completed") throw new Error(`job ${id} not completed`);
    return this.#operate(id, async signal => {
    const result = await this.#deps.repairer.repair(j.downloadPath, j.outputFiles, signal);
    signal.throwIfAborted();
    j.repair = result;
    if (result.repaired && !j.warnings.includes("par2 repair ran")) j.warnings.push("par2 repair ran");
    return result;
    });
  }

  /** Unpack archives produced by the job (RAR/7z/zip markers). */
  async unpack(id: string): Promise<UnpackResult> {
    const j = this.#jobs.get(id);
    if (!j) throw new Error(`unknown job ${id}`);
    if (j.state !== "completed") throw new Error(`job ${id} not completed`);
    return this.#operate(id, async signal => {
    const { existsSync } = await import("node:fs");
    const { join } = await import("node:path");
    const archives = j.outputFiles.filter((f) => firstArchiveVolume(f) && existsSync(join(j.downloadPath, f)));
    if (archives.length === 0) {
      const r = { unpacked: false, files: [], detail: "no archives to unpack" };
      j.unpack = r;
      return r;
    }
    const results: UnpackResult[] = [];
    for (const archive of archives) results.push(await this.#deps.unpacker.unpack(join(j.downloadPath, archive), j.downloadPath, signal));
    signal.throwIfAborted();
    const merged: UnpackResult = {
      unpacked: results.some((r) => r.unpacked),
      files: results.flatMap((r) => [...r.files]),
      detail: results.map((r) => r.detail).join("; "),
    };
    for (const f of merged.files) {
      const rel = relative(j.downloadPath, f);
      containedPath(j.downloadPath, rel);
      assertSafeExistingFile(f);
      if (!j.outputFiles.includes(rel)) j.outputFiles.push(rel);
    }
    j.unpack = merged;
    return merged;
    });
  }

  async remove(id: string, opts: { keepFiles: boolean }): Promise<void> {
    const j = this.#jobs.get(id);
    if (!j) throw new Error(`unknown job ${id}`);
    const active = this.#active.get(id);
    active?.controller.abort();
    await active?.promise;
    if (!opts.keepFiles) {
      for (const f of j.outputFiles) {
        assertSafeJobRoot(j.downloadPath);
        const abs = containedPath(j.downloadPath, f);
        assertSafeExistingFile(abs);
        rmSync(abs, { force: true });
      }
    }
    this.#jobs.delete(id);
  }

  snapshot(id: string): EngineResumeState {
    const j = this.#jobs.get(id);
    if (!j) throw new Error(`unknown job ${id}`);
    return {
      paused: j.state === "paused",
      needsRepair: j.needsRepair,
      cursor: j.cursor,
      receivedBytes: j.receivedBytes,
      segmentsDone: j.segmentsDone,
      warnings: [...j.warnings],
      files: j.files.map((file) => ({
        fileName: file.entry.fileName,
        bytesWritten: file.bytesWritten,
        declaredCrc: file.declaredCrc,
      })),
    };
  }

  async close(): Promise<void> {
    for (const active of this.#active.values()) active.controller.abort();
    await Promise.allSettled(this.#deps.transports.map((transport) => transport.close()));
    await Promise.allSettled([...this.#active.values()].map(active => active.promise));
  }
}
