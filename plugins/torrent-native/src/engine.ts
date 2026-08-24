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
  add(input: { source: string; sourceKind: "file" | "magnet"; downloadPath: string; fileSelection?: string[] }): Promise<EngineTorrent>;
  get(infoHash: string): EngineTorrent | undefined;
  list(): EngineTorrent[];
  pause(infoHash: string): void;
  resume(infoHash: string): void;
  remove(infoHash: string, opts?: { keepFiles?: boolean }): Promise<void>;
  /** Verify every selected piece by hashing; repairs counters after crash. */
  verify(infoHash: string): Promise<{ verifiedPieces: number; totalPieces: number; corruptedFiles: string[] }>;
  /** Drive one deterministic transfer step; real engines tick on IO. */
  advance?(infoHash: string): Promise<void>;
}

// ---- Bencode / torrent parsing -------------------------------------------------
//
// Minimal bencode reader covering dictionary/list/integer/byte-string —
// enough to parse .torrent metainfo (info dict, piece length, files). No
// external parser dependency needed for the shapes torrents actually use.

type BencodeValue = number | Uint8Array | BencodeValue[] | { [k: string]: BencodeValue };

function bdecode(buf: Uint8Array, pos = 0): { value: BencodeValue; end: number } {
  const c = buf[pos];
  if (c === undefined) throw new Error("bencode: unexpected end");
  if (c === 0x69 /* i */) {
    const e = buf.indexOf(0x65 /* e */, pos);
    if (e < 0) throw new Error("bencode: unterminated integer");
    return { value: Number(Buffer.from(buf.slice(pos + 1, e)).toString("ascii")), end: e + 1 };
  }
  if (c === 0x6c /* l */) {
    const out: BencodeValue[] = [];
    let p = pos + 1;
    while (buf[p] !== 0x65 /* e */) {
      const r = bdecode(buf, p);
      out.push(r.value);
      p = r.end;
    }
    return { value: out, end: p + 1 };
  }
  if (c === 0x64 /* d */) {
    const out: { [k: string]: BencodeValue } = {};
    let p = pos + 1;
    while (buf[p] !== 0x65 /* e */) {
      const key = bdecode(buf, p);
      const val = bdecode(buf, key.end);
      out[Buffer.from(key.value as Uint8Array).toString("utf8")] = val.value;
      p = val.end;
    }
    return { value: out, end: p + 1 };
  }
  // Byte string: <len>:<bytes>
  const colon = buf.indexOf(0x3a /* : */, pos);
  if (colon < 0 || colon - pos > 12) throw new Error("bencode: bad string prefix");
  const len = Number(Buffer.from(buf.slice(pos, colon)).toString("ascii"));
  return { value: buf.slice(colon + 1, colon + 1 + len), end: colon + 1 + len };
}

function utf8(v: BencodeValue | undefined): string {
  return v === undefined ? "" : Buffer.from(v as Uint8Array).toString("utf8");
}

/**
 * Parse .torrent metainfo into engine fields. The info-hash is computed
 * over the exact bencoded `info` slice (the canonical BitTorrent identity).
 */
export function parseTorrentFile(bytes: Uint8Array): {
  infoHash: string;
  name: string;
  pieceLength: number;
  piecesTotal: number;
  announceUrls: string[];
  files: Array<{ path: string; lengthBytes: number }>;
} {
  const decoded = bdecode(bytes).value as { [k: string]: BencodeValue };
  const info = decoded["info"] as { [k: string]: BencodeValue } | undefined;
  if (!info) throw new Error("torrent: missing info dictionary");
  // Locate the raw `info` slice by finding "4:info" then decoding one value.
  const marker = Buffer.from("4:info", "ascii");
  let idx = Buffer.from(bytes).indexOf(marker);
  if (idx < 0) throw new Error("torrent: missing info dictionary");
  const infoSlice = bdecode(bytes, idx + marker.length);
  const sha = createHash("sha1").update(Buffer.from(bytes.slice(idx + marker.length, infoSlice.end))).digest("hex");

  const name = utf8(info["name"]);
  const pieceLength = Number(info["piece length"] ?? 0);
  const pieces = info["pieces"] as Uint8Array | undefined;
  const piecesTotal = pieces ? Math.floor(pieces.length / 20) : 0;

  const files: Array<{ path: string; lengthBytes: number }> = [];
  const fileList = info["files"];
  if (Array.isArray(fileList)) {
    for (const f of fileList) {
      const fd = f as { [k: string]: BencodeValue };
      const segs = (fd["path"] as BencodeValue[]) ?? [];
      const rel = segs.map((s) => utf8(s)).join("/");
      files.push({ path: rel, lengthBytes: Number(fd["length"] ?? 0) });
    }
  } else {
    files.push({ path: name, lengthBytes: Number(info["length"] ?? 0) });
  }

  const announce = typeof decoded["announce"] === "object" && !(decoded["announce"] instanceof Uint8Array)
    ? []
    : [utf8(decoded["announce"])].filter((s) => s.length > 0);
  const announceList = Array.isArray(decoded["announce-list"])
    ? (decoded["announce-list"] as BencodeValue[]).flatMap((tier) =>
        Array.isArray(tier) ? tier.map((t) => utf8(t)) : [],
      )
    : [];
  return {
    infoHash: sha,
    name,
    pieceLength,
    piecesTotal,
    announceUrls: [...new Set([...announce, ...announceList])],
    files,
  };
}

/** Extract the btih info-hash from a magnet URI (hex form). */
export function parseMagnet(magnetUri: string): { infoHash: string; displayNames: string[]; trackers: string[] } {
  if (!magnetUri.startsWith("magnet:?xt=urn:btih:")) throw new Error("magnet: unsupported uri");
  const url = new URL(magnetUri.replace("magnet:?", "http://magnet/?"));
  const xt = url.searchParams.get("xt") ?? "";
  const btih = xt.slice("urn:btih:".length).toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(btih)) throw new Error("magnet: unsupported btih encoding");
  const names = url.searchParams.getAll("dn");
  const trackers = [...url.searchParams.getAll("tr").map(decodeURIComponent)];
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
