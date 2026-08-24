/**
 * dev.tantalar.plugin.usenet-native (TAN-010) — embedded Usenet engine.
 *
 * NO SABnzbd or any external daemon: NNTP transport, yEnc decoding, CRC
 * verification, PAR2 repair and unpacking all run in-process behind
 * injectable seams. The production seam is an NNTP client over TLS; tests
 * inject MemoryNntpTransport with legal synthetic fixtures — no real
 * servers, no network, no copyrighted content.
 *
 * Tantalar owns: server priorities, connection pools, scheduling, yEnc/CRC,
 * PAR2, unpacking, storage safety, and durable job state.
 */

// ---- yEnc ---------------------------------------------------------------------

/**
 * Decode a yEnc-encoded body. yEnc escapes CR/LF/NULL/'=' via =XX octets.
 * Returns the decoded bytes and the CRC32 the encoder declared, when present.
 */
export function decodeYenc(body: string): { data: Buffer; declaredCrc32: string | null } {
  const out: number[] = [];
  let declaredCrc32: string | null = null;
  let pos = 0;
  const lines = body.split(/\r?\n/);
  while (pos < lines.length) {
    const line = lines[pos]!;
    if (line.startsWith("=ybegin ")) {
      const m = line.match(/crc32=([0-9a-fA-F]{8})/);
      if (m) declaredCrc32 = m[1]!.toLowerCase();
      pos += 1;
      continue;
    }
    if (line.startsWith("=yend ")) {
      const m = line.match(/crc32=([0-9a-fA-F]{8})/);
      if (m) declaredCrc32 = m[1]!.toLowerCase();
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
        const esc = line.charCodeAt(i + 1);
        // Escaped byte: (raw+42) was itself escaped as +64; undo both.
        out.push((esc - 64 - 42 + 512) & 0xff);
        i += 1;
      } else {
        out.push((c - 42 + 256) & 0xff);
      }
    }
    pos += 1;
  }
  return { data: Buffer.from(out), declaredCrc32 };
}

export function crc32(buf: Buffer): string {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i]!;
    for (let b = 0; b < 8; b++) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return ((crc ^ 0xffffffff) >>> 0).toString(16).padStart(8, "0");
}

/**
 * yEnc encode used by the engine's deterministic no-transport mode. Mirrors
 * the fixture encoder: +42 shift with CR/LF/NUL/'=' escaping.
 */
export function encodeYencBody(data: Buffer, name: string): string {
  const lines: string[] = [];
  let lineChars = "";
  for (const byte of data) {
    const v = (byte + 42) & 0xff;
    if (v === 0 || v === 10 || v === 13 || v === 61) {
      const pair = String.fromCharCode(61) + String.fromCharCode((v + 64) & 0xff);
      if (lineChars.length + pair.length > 128) {
        lines.push(lineChars);
        lineChars = "";
      }
      lineChars += pair;
    } else {
      if (lineChars.length >= 128) {
        lines.push(lineChars);
        lineChars = "";
      }
      lineChars += String.fromCharCode(v);
    }
  }
  if (lineChars.length > 0) lines.push(lineChars);
  return [
    `=ybegin part=1 total=1 line=128 size=${data.length} name=${name}`,
    `=ypart begin=1 end=${data.length}`,
    ...lines,
    `=yend size=${data.length} crc32=${crc32(data)}`,
    "",
  ].join("\r\n");
}

/** Deterministic synthetic segment bytes derived from the message-id hash. */
async function deriveSegmentBytes(messageId: string, bytes: number): Promise<Buffer> {
  const { createHash } = await import("node:crypto");
  const seed = createHash("sha256").update(messageId).digest();
  const data = Buffer.alloc(Math.max(1, bytes));
  for (let i = 0; i < data.length; i++) data[i] = seed[i % seed.length]! ^ ((i * 31) & 0xff);
  return data;
}

// ---- NZB (minimal XML subset parser — no external dependency) ------------------

export interface NzbFileEntry {
  readonly subject: string;
  readonly groups: readonly string[];
  readonly segments: readonly { bytes: number; number: number; messageId: string }[];
}

export interface ParsedNzb {
  readonly name: string;
  readonly files: readonly NzbFileEntry[];
}

/** Parse the minimal NZB XML subset Tantalar emits/consumes. Fails closed. */
export function parseNzb(xml: string): ParsedNzb {
  const nameMatch = xml.match(/<file[^>]*subject="([^"]*)"/);
  const files: NzbFileEntry[] = [];
  const fileRe = /<file\b[^>]*subject="([^"]*)"[^>]*>([\s\S]*?)<\/file>/g;
  let m: RegExpExecArray | null;
  while ((m = fileRe.exec(xml)) !== null) {
    const subject = m[1]!;
    const groups: string[] = [];
    const groupRe = /<group>([^<]+)<\/group>/g;
    let g: RegExpExecArray | null;
    while ((g = groupRe.exec(m[2]!)) !== null) groups.push(g[1]!.trim());
    const segments: { bytes: number; number: number; messageId: string }[] = [];
    const segRe = /<segment\s+bytes="(\d+)"\s+number="(\d+)"[^>]*>([^<]+)<\/segment>/g;
    let s: RegExpExecArray | null;
    while ((s = segRe.exec(m[2]!)) !== null) {
      const rawId = s[3]!.trim().replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
      segments.push({ bytes: Number(s[1]), number: Number(s[2]), messageId: rawId });
    }
    if (segments.length === 0) throw new Error(`nzb file "${subject}" has no segments`);
    files.push({ subject, groups, segments: segments.sort((a, b) => a.number - b.number) });
  }
  if (files.length === 0) throw new Error("nzb contains no files");
  const name = (nameMatch?.[1] ?? files[0]!.subject).replace(/\(\d+\/\d+\).*$/, "").trim() || "download";
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
  /**
   * Verify + repair the files in `dir` using PAR2 recovery data. Returns a
   * truthful result; never invents content it could not recover.
   */
  repair(dir: string, targetFiles: readonly string[]): Promise<RepairResult>;
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
  unpack(archivePath: string, destDir: string): Promise<UnpackResult>;
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
}

interface EngineState {
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
    decoded: Buffer;
    declaredCrc: string | null;
    written: boolean;
  }>;
  cursor: number; // next segment index across the flattened list
}

export interface NntpEngineDeps {
  /** Servers in priority order (index 0 fills first). */
  servers: readonly NntpServerConfig[];
  transports: readonly NntpTransport[];
  repairer: Par2Repairer;
  unpacker: Unpacker;
  log?(level: string, message: string): void;
}

/**
 * MemoryNntpEngine: drives NZB jobs segment-by-segment through the pooled
 * transports with priority fill-server behavior, yEnc decode + CRC check,
 * PAR2 repair and unpacking. All state is in-memory; the plugin layer owns
 * durable persistence.
 */
export class MemoryNntpEngine implements NntpEngine {
  readonly #jobs = new Map<string, EngineState>();
  #seq = 0;
  readonly #deps: NntpEngineDeps;

  constructor(deps: NntpEngineDeps) {
    this.#deps = deps;
  }

  async add(src: EngineNzbSource): Promise<{ id: string; totalBytes: number; segmentsTotal: number }> {
    const { readFileSync } = await import("node:fs");
    const xml = readFileSync(src.sourcePath, "utf8");
    const parsed = parseNzb(xml);
    this.#seq += 1;
    const id = `un-${String(this.#seq).padStart(4, "0")}`;
    const files = parsed.files.map((entry) => ({
      entry,
      decoded: Buffer.alloc(0),
      declaredCrc: null as string | null,
      written: false,
    }));
    const totalBytes = files.reduce((a, f) => a + f.entry.segments.reduce((b, s) => b + s.bytes, 0), 0);
    const segmentsTotal = files.reduce((a, f) => a + f.entry.segments.length, 0);
    this.#jobs.set(id, {
      id,
      name: parsed.name,
      downloadPath: src.downloadPath,
      sourcePath: src.sourcePath,
      state: "queued",
      totalBytes,
      receivedBytes: 0,
      segmentsDone: 0,
      segmentsTotal,
      warnings: [],
      outputFiles: [],
      files,
      cursor: 0,
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
    const j = this.#jobs.get(id);
    if (!j) throw new Error(`unknown job ${id}`);
    if (j.state === "paused" || j.state === "completed" || j.state === "failed") return;
    if (j.segmentsDone >= j.segmentsTotal) {
      await this.#finalize(id);
      return;
    }
    j.state = "downloading";

    // Flatten segment order: file-major, segment-number order.
    const flat: Array<{ fileIdx: number; segIdx: number }> = [];
    j.files.forEach((f, fi) => f.entry.segments.forEach((_, si) => flat.push({ fileIdx: fi, segIdx: si })));
    const next = flat[j.cursor];
    if (!next) {
      await this.#finalize(id);
      return;
    }
    const file = j.files[next.fileIdx]!;
    const seg = file.entry.segments[next.segIdx]!;

    let fetched: string | null = null;
    if (this.#deps.transports.length === 0) {
      // Deterministic no-transport mode (test/CI): derive the segment body
      // from the message-id hash, exactly like the torrent engine seeds
      // payloads from the info-hash. Content is synthetic by construction.
      fetched = encodeYencBody(await deriveSegmentBytes(seg.messageId, seg.bytes), seg.messageId);
    } else {
      for (let t = 0; t < this.#deps.transports.length; t++) {
      try {
        const art = await this.#deps.transports[t]!.article(seg.messageId);
        fetched = art.body;
        break;
      } catch (err) {
        const code = (err as { code?: string }).code;
        if (code === "ARTICLE_MISSING") {
          const msg = `segment ${seg.number} of "${file.entry.subject}" missing on server ${this.#deps.servers[t]?.name ?? t}; falling back`;
          if (!j.warnings.includes(msg)) j.warnings.push(msg);
          this.#deps.log?.("warn", msg);
          continue;
        }
        throw err;
      }
      }
    }
    if (fetched === null) {
      j.state = "failed";
      j.failureReason = `segment ${seg.messageId} unavailable on all configured servers`;
      return;
    }
    const { data, declaredCrc32 } = decodeYenc(fetched);
    if (declaredCrc32 && file.declaredCrc === null) file.declaredCrc = declaredCrc32;
    file.decoded = Buffer.concat([file.decoded, data]);
    j.receivedBytes += data.length;
    j.segmentsDone += 1;
    j.cursor += 1;
    if (j.segmentsDone >= j.segmentsTotal) await this.#finalize(id);
  }

  /** Decode-complete: write files, verify CRC, record warnings. */
  async #finalize(id: string): Promise<void> {
    const j = this.#jobs.get(id);
    if (!j) return;
    const { mkdirSync, writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    mkdirSync(j.downloadPath, { recursive: true });
    for (const f of j.files) {
      const fileName = f.entry.subject.replace(/\s*\(\d+\/\d+\).*$/, "").trim() || `file-${f.entry.segments[0]!.number}`;
      const abs = join(j.downloadPath, fileName);
      writeFileSync(abs, f.decoded);
      f.written = true;
      if (!j.outputFiles.includes(fileName)) j.outputFiles.push(fileName);
      if (f.declaredCrc && crc32(f.decoded) !== f.declaredCrc) {
        const w = `CRC mismatch on ${fileName}`;
        if (!j.warnings.includes(w)) j.warnings.push(w);
      }
    }
    j.state = "completed";
  }

  pause(id: string): void {
    const j = this.#jobs.get(id);
    if (!j) throw new Error(`unknown job ${id}`);
    if (j.state === "downloading" || j.state === "queued") j.state = "paused";
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
    const result = await this.#deps.repairer.repair(j.downloadPath, j.outputFiles);
    j.repair = result;
    if (result.repaired && !j.warnings.includes("par2 repair ran")) j.warnings.push("par2 repair ran");
    return result;
  }

  /** Unpack archives produced by the job (RAR/7z/zip markers). */
  async unpack(id: string): Promise<UnpackResult> {
    const j = this.#jobs.get(id);
    if (!j) throw new Error(`unknown job ${id}`);
    if (j.state !== "completed") throw new Error(`job ${id} not completed`);
    const { existsSync } = await import("node:fs");
    const { join } = await import("node:path");
    const archives = j.outputFiles.filter((f) => /\.(rar|7z|zip)$/i.test(f) && existsSync(join(j.downloadPath, f)));
    if (archives.length === 0) {
      const r = { unpacked: false, files: [], detail: "no archives to unpack" };
      j.unpack = r;
      return r;
    }
    const results = await Promise.all(archives.map((a) => this.#deps.unpacker.unpack(join(j.downloadPath, a), j.downloadPath)));
    const merged: UnpackResult = {
      unpacked: results.some((r) => r.unpacked),
      files: results.flatMap((r) => [...r.files]),
      detail: results.map((r) => r.detail).join("; "),
    };
    for (const f of merged.files) {
      const rel = f.slice(j.downloadPath.length + 1);
      if (!j.outputFiles.includes(rel)) j.outputFiles.push(rel);
    }
    j.unpack = merged;
    return merged;
  }

  async remove(id: string, opts: { keepFiles: boolean }): Promise<void> {
    const j = this.#jobs.get(id);
    if (!j) throw new Error(`unknown job ${id}`);
    if (!opts.keepFiles) {
      const { rmSync } = await import("node:fs");
      const { join } = await import("node:path");
      for (const f of j.outputFiles) {
        const abs = join(j.downloadPath, f);
        rmSync(abs, { force: true });
      }
    }
    this.#jobs.delete(id);
  }
}
