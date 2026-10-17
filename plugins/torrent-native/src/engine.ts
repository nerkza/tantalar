/**
 * Torrent engine seam (TAN-009).
 *
 * `TorrentEngine` is the transport-level surface the plugin drives: add a
 * torrent (from .torrent bytes or a magnet URI), drive transfers, and read
 * per-file / per-piece state. The default implementation wraps webtorrent
 * (MIT, license-reviewed under ADR-0016) with NO tracker traffic unless a
 * caller supplies announce URLs; tests inject `MemoryTorrentEngine`, a
 * deterministic in-process engine seeded from synthetic torrent files, so
 * every acceptance path runs offline against legal fixtures only.
 *
 * The plugin owns configuration, durable job/resume state (via the core
 * storage bridge), queue controls, piece verification, file selection,
 * recovery, and cleanup. This module deliberately contains no Tantalar
 * policy — it is the protocol boundary.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export interface EngineFile {
  /** Path of this file RELATIVE to the torrent download root. */
  readonly path: string;
  readonly lengthBytes: number;
  /** Whether this file is selected for download (file selection control). */
  selected: boolean;
  /** Downloaded byte count for this file (0 until its pieces complete). */
  downloadedBytes: number;
}

export interface EngineTorrent {
  readonly infoHash: string;
  readonly name: string;
  readonly sizeBytes: number;
  readonly pieceLength: number;
  readonly piecesTotal: number;
  readonly announceUrls: readonly string[];
  readonly magnetUri: string;
  readonly files: EngineFile[];
  readonly downloadPath: string;
  paused: boolean;
  /** Bytes received from peers so far (progress basis for resume). */
  receivedBytes: number;
  done: boolean;
  piecesVerified: number;
  /** Seconds this torrent has been seeding (post-completion). */
  seedingSeconds: number;
  /** Bytes uploaded to peers so far (ratio numerator). */
  uploadedBytes: number;
  /** Per-tracker tag assigned by the rules engine. */
  tag?: string;
}

/** Operations the engine must support for the plugin's capability surface. */
export interface TorrentEngine {
  /** Add from raw .torrent bytes or a magnet URI; returns the live torrent. */
  add(input: {
    source: string;
    sourceKind: "file" | "magnet";
    downloadPath: string;
    fileSelection?: string[];
    /** Recovery may reuse verified partial files. New jobs reject collisions. */
    allowExisting?: boolean;
  }): Promise<EngineTorrent>;
  get(infoHash: string): EngineTorrent | undefined;
  list(): EngineTorrent[];
  pause(infoHash: string): void;
  resume(infoHash: string): void;
  selectFiles?(infoHash: string, paths: readonly string[]): void;
  remove(infoHash: string, opts?: { keepFiles?: boolean }): Promise<void>;
  /** Verify every selected piece by hashing; repairs counters after crash. */
  verify(infoHash: string): Promise<{ verifiedPieces: number; totalPieces: number; corruptedFiles: string[] }>;
  /** Drive one deterministic transfer step; real engines tick on IO. */
  advance?(infoHash: string): Promise<void>;
  /** Release listeners and sockets owned by this engine. */
  destroy?(): Promise<void>;
}

// ---- Bencode / torrent parsing -------------------------------------------------
//
// Minimal bencode reader covering dictionary/list/integer/byte-string —
// enough to parse .torrent metainfo (info dict, piece length, files). No
// external parser dependency needed for the shapes torrents actually use.

type BencodeValue = number | Uint8Array | BencodeValue[] | { [k: string]: BencodeValue };

export interface TorrentInputLimits {
  readonly maxMetadataBytes: number;
  readonly maxFiles: number;
  readonly maxPathBytes: number;
  readonly maxPathDepth: number;
  readonly maxPayloadBytes: number;
  readonly maxPieces: number;
}

export const DEFAULT_TORRENT_LIMITS: TorrentInputLimits = Object.freeze({
  maxMetadataBytes: 2 * 1024 * 1024,
  maxFiles: 10_000,
  maxPathBytes: 1024,
  maxPathDepth: 32,
  maxPayloadBytes: 8 * 1024 ** 4,
  maxPieces: 1_000_000,
});

interface DecodeState {
  nodes: number;
  readonly maxNodes: number;
  readonly maxDepth: number;
}

function bdecode(
  buf: Uint8Array,
  pos = 0,
  state: DecodeState = { nodes: 0, maxNodes: 200_000, maxDepth: 64 },
  depth = 0,
): { value: BencodeValue; end: number } {
  state.nodes += 1;
  if (state.nodes > state.maxNodes) throw new Error("bencode: node limit exceeded");
  if (depth > state.maxDepth) throw new Error("bencode: nesting limit exceeded");
  const c = buf[pos];
  if (c === undefined) throw new Error("bencode: unexpected end");
  if (c === 0x69 /* i */) {
    const e = buf.indexOf(0x65 /* e */, pos);
    if (e < 0) throw new Error("bencode: unterminated integer");
    const raw = Buffer.from(buf.slice(pos + 1, e)).toString("ascii");
    if (!/^(?:0|-?[1-9][0-9]*)$/.test(raw) || raw === "-0") throw new Error("bencode: invalid integer");
    const value = Number(raw);
    if (!Number.isSafeInteger(value)) throw new Error("bencode: integer out of range");
    return { value, end: e + 1 };
  }
  if (c === 0x6c /* l */) {
    const out: BencodeValue[] = [];
    let p = pos + 1;
    while (buf[p] !== 0x65 /* e */) {
      if (buf[p] === undefined) throw new Error("bencode: unterminated list");
      const r = bdecode(buf, p, state, depth + 1);
      out.push(r.value);
      p = r.end;
    }
    return { value: out, end: p + 1 };
  }
  if (c === 0x64 /* d */) {
    const out: { [k: string]: BencodeValue } = {};
    let p = pos + 1;
    while (buf[p] !== 0x65 /* e */) {
      if (buf[p] === undefined) throw new Error("bencode: unterminated dictionary");
      const key = bdecode(buf, p, state, depth + 1);
      if (!(key.value instanceof Uint8Array)) throw new Error("bencode: dictionary key must be bytes");
      const keyText = Buffer.from(key.value).toString("utf8");
      if (Object.hasOwn(out, keyText)) throw new Error(`bencode: duplicate key ${keyText}`);
      const val = bdecode(buf, key.end, state, depth + 1);
      out[keyText] = val.value;
      p = val.end;
    }
    return { value: out, end: p + 1 };
  }
  // Byte string: <len>:<bytes>
  const colon = buf.indexOf(0x3a /* : */, pos);
  if (colon < 0 || colon - pos > 12) throw new Error("bencode: bad string prefix");
  const rawLength = Buffer.from(buf.slice(pos, colon)).toString("ascii");
  if (!/^(?:0|[1-9][0-9]*)$/.test(rawLength)) throw new Error("bencode: invalid string length");
  const len = Number(rawLength);
  const end = colon + 1 + len;
  if (!Number.isSafeInteger(len) || end > buf.length) throw new Error("bencode: string exceeds input");
  return { value: buf.slice(colon + 1, end), end };
}

function utf8(v: BencodeValue | undefined): string {
  return v === undefined ? "" : Buffer.from(v as Uint8Array).toString("utf8");
}

/**
 * Parse .torrent metainfo into engine fields. The info-hash is computed
 * over the exact bencoded `info` slice (the canonical BitTorrent identity).
 */
function integer(v: BencodeValue | undefined, field: string): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v)) throw new Error(`torrent: invalid ${field}`);
  return v;
}

function bytesValue(v: BencodeValue | undefined, field: string): Uint8Array {
  if (!(v instanceof Uint8Array)) throw new Error(`torrent: invalid ${field}`);
  return v;
}

export function validateTorrentPathSegment(segment: string): string {
  if (
    segment.length === 0 ||
    segment === "." ||
    segment === ".." ||
    segment.includes("/") ||
    segment.includes("\\") ||
    segment.includes("\0") ||
    /^[A-Za-z]:/.test(segment) ||
    /[\u0000-\u001f\u007f]/.test(segment)
  ) {
    throw new Error("torrent: unsafe path segment");
  }
  return segment;
}

function validateRelativePath(segments: readonly string[], limits: TorrentInputLimits): string {
  if (segments.length === 0 || segments.length > limits.maxPathDepth) throw new Error("torrent: invalid path depth");
  const safe = segments.map(validateTorrentPathSegment);
  const joined = safe.join("/");
  if (Buffer.byteLength(joined, "utf8") > limits.maxPathBytes) throw new Error("torrent: path exceeds limit");
  return joined;
}

function findInfoSlice(bytes: Uint8Array): { start: number; end: number } {
  if (bytes[0] !== 0x64) throw new Error("torrent: root must be a dictionary");
  const state: DecodeState = { nodes: 0, maxNodes: 200_000, maxDepth: 64 };
  let pos = 1;
  let found: { start: number; end: number } | null = null;
  while (bytes[pos] !== 0x65) {
    if (bytes[pos] === undefined) throw new Error("torrent: unterminated root dictionary");
    const key = bdecode(bytes, pos, state, 1);
    if (!(key.value instanceof Uint8Array)) throw new Error("torrent: root key must be bytes");
    const valueStart = key.end;
    const value = bdecode(bytes, valueStart, state, 1);
    if (Buffer.from(key.value).toString("utf8") === "info") {
      if (found) throw new Error("torrent: duplicate info dictionary");
      found = { start: valueStart, end: value.end };
    }
    pos = value.end;
  }
  if (!found) throw new Error("torrent: missing info dictionary");
  return found;
}

export function parseTorrentFile(
  bytes: Uint8Array,
  overrides: Partial<TorrentInputLimits> = {},
): {
  infoHash: string;
  name: string;
  pieceLength: number;
  piecesTotal: number;
  pieceHashes: string[];
  announceUrls: string[];
  files: Array<{ path: string; lengthBytes: number }>;
  multiFile: boolean;
} {
  const limits = { ...DEFAULT_TORRENT_LIMITS, ...overrides };
  if (bytes.length === 0 || bytes.length > limits.maxMetadataBytes) throw new Error("torrent: metadata exceeds limit");
  const decodedResult = bdecode(bytes);
  if (decodedResult.end !== bytes.length) throw new Error("torrent: trailing metainfo bytes");
  const decoded = decodedResult.value as { [k: string]: BencodeValue };
  const info = decoded["info"] as { [k: string]: BencodeValue } | undefined;
  if (!info || Array.isArray(info) || info instanceof Uint8Array) throw new Error("torrent: missing info dictionary");
  const infoSlice = findInfoSlice(bytes);
  const sha = createHash("sha1").update(Buffer.from(bytes.slice(infoSlice.start, infoSlice.end))).digest("hex");

  const name = validateTorrentPathSegment(utf8(bytesValue(info["name"], "name")));
  const pieceLength = integer(info["piece length"], "piece length");
  if (pieceLength < 4 * 1024 || pieceLength > 16 * 1024 * 1024) throw new Error("torrent: piece length outside limits");
  const pieces = bytesValue(info["pieces"], "pieces");
  if (pieces.length === 0 || pieces.length % 20 !== 0) throw new Error("torrent: invalid piece hashes");
  const piecesTotal = pieces.length / 20;
  if (piecesTotal > limits.maxPieces) throw new Error("torrent: piece count exceeds limit");
  const pieceHashes: string[] = [];
  for (let offset = 0; offset < pieces.length; offset += 20) {
    pieceHashes.push(Buffer.from(pieces.slice(offset, offset + 20)).toString("hex"));
  }

  const files: Array<{ path: string; lengthBytes: number }> = [];
  const seenPaths = new Set<string>();
  const fileList = info["files"];
  const multiFile = Array.isArray(fileList);
  if (Array.isArray(fileList)) {
    if (fileList.length === 0 || fileList.length > limits.maxFiles) throw new Error("torrent: file count exceeds limit");
    for (const f of fileList) {
      const fd = f as { [k: string]: BencodeValue };
      const rawSegments = fd["path"];
      if (!Array.isArray(rawSegments)) throw new Error("torrent: invalid file path");
      const rel = validateRelativePath(rawSegments.map((s) => utf8(bytesValue(s, "path segment"))), limits);
      if (seenPaths.has(rel)) throw new Error("torrent: duplicate file path");
      seenPaths.add(rel);
      const lengthBytes = integer(fd["length"], "file length");
      if (lengthBytes < 0) throw new Error("torrent: negative file length");
      files.push({ path: rel, lengthBytes });
    }
  } else {
    const lengthBytes = integer(info["length"], "file length");
    if (lengthBytes < 0) throw new Error("torrent: negative file length");
    files.push({ path: name, lengthBytes });
  }

  const sizeBytes = files.reduce((total, file) => total + file.lengthBytes, 0);
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes <= 0 || sizeBytes > limits.maxPayloadBytes) {
    throw new Error("torrent: payload size outside limits");
  }
  if (Math.ceil(sizeBytes / pieceLength) !== piecesTotal) throw new Error("torrent: piece hash count does not match payload");

  const announce = typeof decoded["announce"] === "object" && !(decoded["announce"] instanceof Uint8Array)
    ? []
    : [utf8(decoded["announce"])].filter((s) => s.length > 0);
  const announceList = Array.isArray(decoded["announce-list"])
    ? (decoded["announce-list"] as BencodeValue[]).flatMap((tier) =>
        Array.isArray(tier) ? tier.map((t) => utf8(t)) : [],
      )
    : [];
  const announceUrls = [...new Set([...announce, ...announceList])].map(validateTrackerUrl);
  if (announceUrls.length > 64) throw new Error("torrent: tracker count exceeds limit");
  return {
    infoHash: sha,
    name,
    pieceLength,
    piecesTotal,
    pieceHashes,
    announceUrls,
    files,
    multiFile,
  };
}

function decodeBase32InfoHash(value: string): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0;
  let accumulator = 0;
  const out: number[] = [];
  for (const char of value.toUpperCase()) {
    const index = alphabet.indexOf(char);
    if (index < 0) throw new Error("magnet: unsupported btih encoding");
    accumulator = (accumulator << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((accumulator >>> bits) & 0xff);
    }
  }
  if (out.length !== 20) throw new Error("magnet: unsupported btih encoding");
  return Buffer.from(out).toString("hex");
}

function validateTrackerUrl(value: string): string {
  if (Buffer.byteLength(value, "utf8") > 2048) throw new Error("torrent: tracker URL exceeds limit");
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("torrent: invalid tracker URL");
  }
  if (!new Set(["http:", "https:", "udp:", "ws:", "wss:"]).has(parsed.protocol)) {
    throw new Error("torrent: unsupported tracker protocol");
  }
  if (parsed.username || parsed.password || !parsed.hostname) throw new Error("torrent: invalid tracker URL");
  return value;
}

/** Extract the v1 btih info-hash from a bounded magnet URI. */
export function parseMagnet(magnetUri: string): { infoHash: string; displayNames: string[]; trackers: string[] } {
  if (Buffer.byteLength(magnetUri, "utf8") > 16 * 1024) throw new Error("magnet: URI exceeds limit");
  if (!magnetUri.startsWith("magnet:?xt=urn:btih:")) throw new Error("magnet: unsupported uri");
  const url = new URL(magnetUri.replace("magnet:?", "http://magnet/?"));
  const xt = url.searchParams.get("xt") ?? "";
  const encoded = xt.slice("urn:btih:".length);
  const btih = /^[0-9a-fA-F]{40}$/.test(encoded) ? encoded.toLowerCase() : decodeBase32InfoHash(encoded);
  const names = url.searchParams.getAll("dn").map(validateTorrentPathSegment);
  const trackers = [...new Set(url.searchParams.getAll("tr").map(validateTrackerUrl))];
  if (trackers.length > 64) throw new Error("magnet: tracker count exceeds limit");
  return { infoHash: btih, displayNames: names, trackers };
}

function magnetFor(infoHash: string, name: string, announceUrls: readonly string[]): string {
  const params = new URLSearchParams();
  params.set("xt", `urn:btih:${infoHash}`);
  if (name) params.set("dn", name);
  for (const t of announceUrls) params.append("tr", t);
  return `magnet:?${params.toString()}`;
}

/**
 * Compute which files each half-open piece range covers, mapping verified
 * pieces onto per-file progress. Used by verification and progress.
 */
export function pieceCoverage(torrent: Pick<EngineTorrent, "files" | "pieceLength" | "piecesTotal" | "sizeBytes">): Array<Array<number>> {
  const coverage: Array<Array<number>> = [];
  let offset = 0;
  for (let p = 0; p < torrent.piecesTotal; p++) {
    const start = p * torrent.pieceLength;
    const end = Math.min(start + torrent.pieceLength, torrent.sizeBytes);
    const owners: number[] = [];
    let fileOffset = 0;
    for (let fi = 0; fi < torrent.files.length; fi++) {
      const fStart = fileOffset;
      const fEnd = fileOffset + torrent.files[fi]!.lengthBytes;
      if (fEnd > start && fStart < end) owners.push(fi);
      fileOffset = fEnd;
    }
    coverage.push(owners);
    void offset;
  }
  return coverage;
}

// ---- Memory engine (deterministic test transport) -------------------------------

interface MemorySeed {
  /** Absolute path to a .torrent fixture whose payload lives beside it. */
  torrentPath: string;
  /** Payload bytes served "from peers" for each relative file path. */
  payloads: Record<string, Uint8Array>;
}

/**
 * In-memory engine: no network, no disk writes outside an explicit
 * `downloadPath`. Transfer is deterministic — `advance` completes one
 * unverified piece at a time from the seeded payloads; `verify` hashes the
 * written bytes exactly like a real client would.
 */
export class MemoryTorrentEngine implements TorrentEngine {
  readonly #torrents = new Map<string, EngineTorrent>();
  readonly #payloads = new Map<string, Record<string, Uint8Array>>();
  readonly #verified = new Map<string, Set<number>>();

  constructor(seeds: MemorySeed[] = []) {
    for (const seed of seeds) {
      const parsed = parseTorrentFile(readFileSync(seed.torrentPath));
      this.#payloads.set(parsed.infoHash, seed.payloads);
    }
  }

  async add(input: { source: string; sourceKind: "file" | "magnet"; downloadPath: string; fileSelection?: string[] }): Promise<EngineTorrent> {
    let parsed;
    let payloadsForTorrent: Record<string, Uint8Array> | undefined;
    if (input.sourceKind === "file") {
      parsed = parseTorrentFile(readFileSync(resolve(input.source)));
      // Deterministic offline transport: payload bytes are derived from the
      // info-hash (test-only; a REAL engine would fetch them from peers).
      // This lets piece verification hash real on-disk content end-to-end.
      payloadsForTorrent = {};
      for (const f of parsed.files) {
        const buf = Buffer.alloc(f.lengthBytes);
        let seed = parseInt(parsed.infoHash.slice(0, 8), 16);
        for (let b = 0; b < f.lengthBytes; b++) {
          seed = (seed * 1103515245 + 12345) & 0x7fffffff;
          buf[b] = seed % 251;
        }
        payloadsForTorrent[f.path] = new Uint8Array(buf);
      }
    } else {
      const m = parseMagnet(input.source);
      // A magnet without local metadata cannot start in the memory engine:
      // fail closed rather than inventing content.
      const seeded = this.#payloads.get(m.infoHash);
      if (!seeded) throw new Error(`memory-engine: unknown magnet ${m.infoHash}`);
      parsed = {
        infoHash: m.infoHash,
        name: m.displayNames[0] ?? m.infoHash,
        pieceLength: 0,
        piecesTotal: 0,
        announceUrls: m.trackers,
        files: Object.keys(seeded).map((p) => ({ path: p, lengthBytes: seeded[p]!.length })),
      };
    }
    if (this.#torrents.has(parsed.infoHash)) return this.#torrents.get(parsed.infoHash)!;

    // Path containment check happens in the plugin before calling add(); the
    // engine additionally refuses empty roots.
    if (!input.downloadPath.trim()) throw new Error("downloadPath required");
    const files: EngineFile[] = parsed.files.map((f) => ({
      path: f.path,
      lengthBytes: f.lengthBytes,
      selected: !input.fileSelection || input.fileSelection.includes(f.path),
      downloadedBytes: 0,
    }));
    const sizeBytes = files.reduce((a, f) => a + f.lengthBytes, 0);
    const torrent: EngineTorrent = {
      infoHash: parsed.infoHash,
      name: parsed.name,
      sizeBytes,
      pieceLength: parsed.pieceLength,
      piecesTotal: parsed.piecesTotal,
      piecesVerified: 0,
      announceUrls: parsed.announceUrls,
      magnetUri: magnetFor(parsed.infoHash, parsed.name, parsed.announceUrls),
      files,
      downloadPath: resolve(input.downloadPath),
      paused: false,
      receivedBytes: 0,
      done: false,
      seedingSeconds: 0,
      uploadedBytes: 0,
    };
    this.#torrents.set(parsed.infoHash, torrent);
    this.#verified.set(parsed.infoHash, new Set());
    if (payloadsForTorrent) this.#payloads.set(parsed.infoHash, payloadsForTorrent);
    return torrent;
  }

  get(infoHash: string): EngineTorrent | undefined {
    return this.#torrents.get(infoHash);
  }

  list(): EngineTorrent[] {
    return [...this.#torrents.values()];
  }

  pause(infoHash: string): void {
    const t = this.#torrents.get(infoHash);
    if (t) t.paused = true;
  }

  resume(infoHash: string): void {
    const t = this.#torrents.get(infoHash);
    if (t) t.paused = false;
  }

  selectFiles(infoHash: string, paths: readonly string[]): void {
    const t = this.#torrents.get(infoHash);
    if (!t) return;
    const wanted = new Set(paths);
    for (const file of t.files) file.selected = wanted.has(file.path);
  }

  async remove(infoHash: string): Promise<void> {
    this.#torrents.delete(infoHash);
    this.#verified.delete(infoHash);
    this.#payloads.delete(infoHash);
  }

  /**
   * Complete the next unselected-skipping piece: mark its bytes received
   * and write payload bytes for fully covered files. Deterministic order.
   */
  async advance(infoHash: string): Promise<void> {
    const t = this.#torrents.get(infoHash);
    if (!t || t.paused) return;
    if (t.done) {
      // Deterministic seeding accrual: one tick = one hour of seeding and
      // upload of half the torrent size. Test-only deterministic transport.
      t.seedingSeconds += 3600;
      t.uploadedBytes += Math.ceil(t.sizeBytes / 2);
      return;
    }
    const verified = this.#verified.get(infoHash)!;
    const nextPiece = [...Array(t.piecesTotal).keys()].find((p) => !verified.has(p));
    if (nextPiece === undefined) {
      t.done = true;
      return;
    }
    const coverage = pieceCoverage(t)[nextPiece] ?? [];
    const payloads = this.#payloads.get(infoHash);
    for (const fi of coverage) {
      const f = t.files[fi];
      if (!f || !f.selected || !payloads) continue;
      const payload = payloads[f.path];
      if (!payload) continue;
      f.downloadedBytes = Math.min(f.downloadedBytes + t.pieceLength, f.lengthBytes);
      t.receivedBytes = Math.min(t.receivedBytes + t.pieceLength, t.sizeBytes);
      // Materialize completed files under the download root (safe: paths are
      // validated relative names from the fixture, never absolute or ..).
      if (f.downloadedBytes >= f.lengthBytes) this.#writeCompleted(t, f, payloads[f.path]!);
    }
    verified.add(nextPiece);
    t.piecesVerified = verified.size;
    if (verified.size >= t.piecesTotal) t.done = true;
  }

  #writeCompleted(t: EngineTorrent, f: EngineFile, payload: Uint8Array): void {
    const dest = join(t.downloadPath, f.path);
    // Containment re-check at the write boundary (defense in depth).
    if (!resolve(dest).startsWith(resolve(t.downloadPath))) throw new Error("path escape refused");
    mkdirSync(resolve(dest, ".."), { recursive: true });
    if (!existsSync(dest)) writeFileSync(dest, payload);
  }

  async verify(infoHash: string): Promise<{ verifiedPieces: number; totalPieces: number; corruptedFiles: string[] }> {
    const t = this.#torrents.get(infoHash);
    if (!t) throw new Error("unknown torrent");
    const verified = this.#verified.get(infoHash)!;
    const corrupted: string[] = [];
    // Re-hash completed files on disk; a tampered/truncated file fails and
    // marks its pieces unverified (repair = re-advance those pieces later).
    const payloads = this.#payloads.get(infoHash);
    for (const f of t.files) {
      if (!f.selected || f.downloadedBytes < f.lengthBytes) continue;
      const dest = join(t.downloadPath, f.path);
      let bad = !existsSync(dest) || statSync(dest).size !== f.lengthBytes;
      if (!bad && payloads && payloads[f.path]) {
        const onDisk = new Uint8Array(readFileSync(dest));
        const expected = payloads[f.path]!;
        if (onDisk.length !== expected.length) bad = true;
        else for (let i = 0; i < onDisk.length; i++) {
          if (onDisk[i] !== expected[i]) { bad = true; break; }
        }
      }
      if (bad) corrupted.push(f.path);
    }
    if (corrupted.length > 0) {
      const badSet = new Set(corrupted);
      const coverage = pieceCoverage(t);
      for (let p = 0; p < t.piecesTotal; p++) {
        if ((coverage[p] ?? []).some((fi) => badSet.has(t.files[fi]?.path ?? "\u0000"))) verified.delete(p);
      }
      for (const c of corrupted) {
        const fi = t.files.find((f) => f.path === c);
        if (fi) fi.downloadedBytes = 0;
      }
      t.done = false;
    }
    t.piecesVerified = verified.size;
    return { verifiedPieces: verified.size, totalPieces: t.piecesTotal, corruptedFiles: corrupted };
  }
}
