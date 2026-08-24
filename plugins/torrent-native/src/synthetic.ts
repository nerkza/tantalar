/**
 * Legal synthetic torrent fixtures (TAN-009 acceptance: "legal test torrent").
 * Everything here is generated in-repo: a tiny bencoded .torrent metainfo
 * with random-ish public-domain payload bytes. No copyrighted content, no
 * real trackers — announce points at an invalid .invalid host that is never
 * contacted by the memory engine.
 */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Bencode primitives (encoder only; decode lives in engine.ts). */
function bstr(s: string | Uint8Array): Buffer<ArrayBuffer> {
  const len = s.length;
  const out: number[] = [];
  for (const ch of `${len}:`) out.push(ch.charCodeAt(0));
  const bytes = typeof s === "string" ? Buffer.from(s, "utf8") : s;
  for (const byte of Array.from(bytes)) out.push(byte);
  return Buffer.from(out) as Buffer<ArrayBuffer>;
}
function bint(n: number): Buffer<ArrayBuffer> {
  return Buffer.concat([Buffer.from("i", "ascii"), Buffer.from(String(n), "ascii"), Buffer.from("e", "ascii")]) as Buffer<ArrayBuffer>;
}
function bdict(d: Record<string, Buffer>): Buffer<ArrayBuffer> {
  const keys = Object.keys(d).sort();
  const parts: Array<Buffer<ArrayBuffer>> = [Buffer.from("d", "ascii") as Buffer<ArrayBuffer>];
  for (const k of keys) parts.push(bstr(k), d[k] as Buffer<ArrayBuffer>);
  parts.push(Buffer.from("e", "ascii") as Buffer<ArrayBuffer>);
  return Buffer.concat(parts) as Buffer<ArrayBuffer>;
}
function blist(items: Array<Buffer<ArrayBuffer>>): Buffer<ArrayBuffer> {
  return Buffer.concat([Buffer.from("l", "ascii") as Buffer<ArrayBuffer>, ...items, Buffer.from("e", "ascii") as Buffer<ArrayBuffer>]) as Buffer<ArrayBuffer>;
}

export interface SyntheticTorrent {
  /** Absolute path of the generated .torrent file. */
  torrentPath: string;
  infoHash: string;
  name: string;
  pieceLength: number;
  piecesTotal: number;
  announceUrls: string[];
  files: Array<{ path: string; lengthBytes: number }>;
  payloads: Record<string, Uint8Array>;
}

/**
 * Build one multi-file synthetic torrent with `pieceCount` pieces per file
 * chunking derived from pieceLength. Payload bytes are deterministic.
 */
export function makeSyntheticTorrent(
  dir: string,
  name: string,
  opts?: { fileCount?: number; fileBytes?: number; pieceLength?: number },
): SyntheticTorrent {
  mkdirSync(dir, { recursive: true });
  const fileCount = opts?.fileCount ?? 2;
  const fileBytes = opts?.fileBytes ?? 64 * 1024;
  const pieceLength = opts?.pieceLength ?? 32 * 1024;

  const files: Array<{ path: string; lengthBytes: number }> = [];
  const payloads: Record<string, Uint8Array> = {};
  for (let i = 0; i < fileCount; i++) {
    const rel = i === 0 ? `${name}.txt` : `data/${name}-${i}.bin`;
    const buf = Buffer.alloc(fileBytes);
    for (let b = 0; b < fileBytes; b++) buf[b] = (i * 31 + b * 7 + name.length) % 251;
    files.push({ path: rel, lengthBytes: fileBytes });
    payloads[rel] = new Uint8Array(buf);
  }

  // Piece hashes over the CONCATENATED payload (single-file-set convention).
  const total = files.reduce((a, f) => a + f.lengthBytes, 0);
  const piecesTotal = Math.ceil(total / pieceLength);
  const concat = Buffer.concat(files.map((f) => Buffer.from(payloads[f.path]!)));
  const hashes: Buffer[] = [];
  for (let p = 0; p < piecesTotal; p++) {
    hashes.push(createHash("sha1").update(concat.subarray(p * pieceLength, (p + 1) * pieceLength)).digest());
  }

  const announce = `https://${name.toLowerCase()}.invalid/announce`;
  const infoDict = bdict({
    name: bstr(name),
    "piece length": bint(pieceLength),
    pieces: bstr(Buffer.concat(hashes)),
    files: blist(files.map((f) => bdict({ length: bint(f.lengthBytes), path: blist(f.path.split("/").map((s) => bstr(s))) }))),
  });
  const metainfo = bdict({
    info: infoDict,
    announce: bstr(announce),
  });

  const infoMarker = Buffer.from("4:info", "ascii");
  const idx = metainfo.indexOf(infoMarker);
  // The outer dict closes with a single 'e' after the info dict value.
  const infoEnd = metainfo.length - 1;
  const infoHash = createHash("sha1").update(metainfo.subarray(idx + infoMarker.length, infoEnd)).digest("hex");

  const torrentPath = join(dir, `${name}.torrent`);
  writeFileSync(torrentPath, metainfo);
  return {
    torrentPath,
    infoHash,
    name,
    pieceLength,
    piecesTotal,
    announceUrls: [announce],
    files,
    payloads,
  };
}
