/**
 * Legal synthetic Usenet fixtures for tests. Generates an NZB document plus
 * the yEnc article bodies a memory NNTP transport serves. No real servers,
 * no network, no copyrighted content.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { crc32 } from "./engine.js";

export function encodeYenc(data: Buffer, name: string, part: number, total: number): string {
  // yEnc encode: add 42, escape NUL/CR/LF/'='. Lines wrap on BYTE boundaries
  // (never inside an escape pair) at 128 encoded characters.
  const lines: string[] = [];
  let lineChars = "";
  for (const byte of data) {
    let v = (byte + 42) & 0xff;
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
    `=ybegin part=${part} total=${total} line=128 size=${data.length} name=${name}`,
    `=ypart begin=1 end=${data.length}`,
    ...lines,
    `=yend size=${data.length} crc32=${crc32(data)}`,
    "",
  ].join("\r\n");
}

export interface SyntheticNzb {
  readonly nzbPath: string;
  readonly name: string;
  readonly fileNames: readonly string[];
  readonly payloads: ReadonlyMap<string, Buffer>; // fileName -> bytes
  readonly messageIds: readonly string[];
}

export interface SyntheticNzbOptions {
  readonly fileCount?: number;
  readonly fileBytes?: number;
  /** Message-ids to OMIT from every server (forces fill-server fallback). */
  readonly missingOnPrimary?: readonly string[];
  /** Message-ids missing on ALL servers (job must fail). */
  readonly missingEverywhere?: readonly string[];
  /** Corrupt these files after write (drives PAR2 repair path). */
  readonly corruptOnDisk?: boolean;
}

export function makeSyntheticNzb(dir: string, name: string, opts: SyntheticNzbOptions = {}): SyntheticNzb {
  mkdirSync(dir, { recursive: true });
  const fileCount = opts.fileCount ?? 2;
  const fileBytes = opts.fileBytes ?? 32 * 1024;
  const fileNames: string[] = [];
  const payloads = new Map<string, Buffer>();
  const messageIds: string[] = [];
  let xml = `<?xml version="1.0" encoding="UTF-8"?>\n<nzb xmlns="http://www.newzbin.com/DTD/2003/nzb">\n`;
  let segSeq = 0;
  for (let f = 0; f < fileCount; f++) {
    const fileName = `${name}.part${f + 1}`;
    const payload = Buffer.alloc(fileBytes);
    for (let i = 0; i < fileBytes; i++) payload[i] = (f * 31 + i) & 0xff;
    fileNames.push(fileName);
    payloads.set(fileName, payload);
    // One segment per file keeps fixtures small and deterministic.
    segSeq += 1;
    const messageId = `<synthetic-${name}-${segSeq}@fixture.invalid>`;
    messageIds.push(messageId);
    xml += `  <file subject="${fileName} (1/1)" date="0"><groups><group>alt.binaries.fixture</group></groups><segments><segment bytes="${fileBytes}" number="1">&lt;synthetic-${name}-${segSeq}@fixture.invalid&gt;</segment></segments></file>\n`;
  }
  xml += "</nzb>\n";
  const nzbPath = join(dir, `${name}.nzb`);
  writeFileSync(nzbPath, xml);
  void opts; // options consumed by test-level server assembly
  return { nzbPath, name, fileNames, payloads, messageIds };
}

export function yencBodyFor(payloads: ReadonlyMap<string, Buffer>, fileName: string): string {
  const data = payloads.get(fileName);
  if (!data) throw new Error(`no fixture payload for ${fileName}`);
  return encodeYenc(data, fileName, 1, 1);
}
