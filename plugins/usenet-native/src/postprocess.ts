import { execFile, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, createReadStream, createWriteStream } from "node:fs";
import { copyFile, link, lstat, mkdir, mkdtemp, open, readdir, rename, rm, statfs } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import type { Par2Repairer, RepairResult, Unpacker, UnpackResult } from "./engine.js";

const run = promisify(execFile);
const MAX_LIST_BYTES = 4 * 1024 * 1024;
const TIMEOUT = 30 * 60 * 1000;

function executable(names: string[]): string | null {
  return names.find(name => !spawnSync(name, [name === "par2" ? "-V" : "i"], { stdio: "ignore", timeout: 5000 }).error) ?? null;
}

export const postprocessTools = { par2: executable(["par2"]), archive: executable(["7zz", "7z"]) };

async function regular(path: string): Promise<void> {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Post-processing input must be a regular file.");
}

function safeName(name: string): string {
  if (!name || isAbsolute(name) || /[\\:\x00-\x1f\x7f]/.test(name) || name.split("/").some(part => !part || part === "." || part === "..")) {
    throw new Error("Archive or recovery data contains an unsafe filename.");
  }
  return name;
}

async function safeDirectory(root: string, directory: string): Promise<void> {
  const path = relative(root, directory);
  if (path && (path.startsWith("..") || isAbsolute(path))) throw new Error("Post-processing path escapes the download directory.");
  let current = root;
  for (const part of ["", ...path.split(sep).filter(Boolean)]) {
    if (part) current = join(current, part);
    await mkdir(current, { recursive: false }).catch(error => { if (error.code !== "EEXIST") throw error; });
    const stat = await lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Post-processing directory must not be a symlink.");
  }
}

async function capacity(root: string, bytes: number, maxBytes: number, minFreeBytes: number): Promise<void> {
  const disk = await statfs(root);
  if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > maxBytes || disk.bavail * disk.bsize - bytes < minFreeBytes) {
    throw new Error("Insufficient free space or post-processing size limit exceeded.");
  }
}

async function hash(path: string): Promise<string> {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return digest.digest("hex");
}

export class ArchiveUnpacker implements Unpacker {
  constructor(private readonly maxBytes: number, private readonly minFreeBytes: number) {}

  async unpack(archivePath: string, destDir: string, signal?: AbortSignal): Promise<UnpackResult> {
    signal?.throwIfAborted();
    const binary = postprocessTools.archive;
    if (!binary) throw new Error("Archive extraction requires 7-Zip. Install 7zz or 7z and restart Tantalar.");
    await safeDirectory(destDir, destDir);
    await regular(archivePath);
    let listing: string;
    try { listing = (await run(binary, ["l", "-slt", "-ba", "-p-", "--", archivePath], { signal, timeout: 60_000, maxBuffer: MAX_LIST_BYTES })).stdout; }
    catch { throw new Error("The archive could not be read. It may be incomplete or password protected."); }
    const entries = listing.trim().split(/\r?\n\r?\n/).filter(Boolean).map(block => {
      const fields: Record<string, string> = Object.create(null);
      for (const line of block.split(/\r?\n/)) {
        const match = /^([^=]+) =(?: (.*))?$/.exec(line);
        if (!match || fields[match[1]!] !== undefined) throw new Error("Unsupported archive listing.");
        fields[match[1]!] = match[2] ?? "";
      }
      const name = safeName(fields.Path ?? "");
      if (fields.Encrypted === "+") throw new Error("This archive requires a password.");
      if (fields["Symbolic Link"] || fields["Hard Link"] || fields["Copy Link"] || fields["Alternate Stream"] === "+" || /(?:^|\s)[lbcp]/.test(fields.Attributes ?? "")) throw new Error("Archive links and special files are not supported.");
      return { name, directory: fields.Folder === "+", size: Number(fields.Size) };
    });
    if (entries.length > 10_000 || new Set(entries.map(e => e.name)).size !== entries.length) throw new Error("Archive has too many or duplicate entries.");
    const files = entries.filter(e => !e.directory);
    if (!files.length || files.some(e => !Number.isSafeInteger(e.size) || e.size < 0)) throw new Error("Archive has no valid files.");
    await capacity(destDir, files.reduce((sum, e) => sum + e.size, 0), this.maxBytes, this.minFreeBytes);
    const stage = await mkdtemp(join(destDir, ".tantalar-unpack-"));
    const output: string[] = [];
    try {
      for (const [index, entry] of files.entries()) {
        signal?.throwIfAborted();
        const temp = join(stage, String(index));
        const child = spawn(binary, ["x", "-so", "-spd", "-y", "-p-", "--", archivePath, entry.name], { signal, killSignal: "SIGKILL", stdio: ["ignore", "pipe", "ignore"] });
        const exited = new Promise<void>((accept, reject) => {
          child.once("error", () => reject(new Error("Archive extraction could not start.")));
          child.once("close", code => code === 0 ? accept() : reject(new Error("Archive extraction failed its integrity check.")));
        });
        // Observe both promises even when the stream fails first.
        void exited.catch(() => undefined);
        const timer = setTimeout(() => child.kill("SIGKILL"), TIMEOUT);
        let bytes = 0;
        try {
          await pipeline(child.stdout!, new Transform({ transform(chunk, _encoding, callback) {
            bytes += chunk.length;
            callback(bytes > entry.size ? new Error("Archive output exceeds its declared size.") : null, chunk);
          } }), createWriteStream(temp, { flags: "wx", mode: 0o600 }));
          await exited;
          if (bytes !== entry.size) throw new Error("Archive output is incomplete.");
        } finally { clearTimeout(timer); child.kill("SIGKILL"); await exited.catch(() => undefined); }
        signal?.throwIfAborted();
        const destination = resolve(destDir, entry.name);
        await safeDirectory(destDir, dirname(destination));
        try { await link(temp, destination); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          await regular(destination);
          if (await hash(temp) !== await hash(destination)) throw new Error("Archive output conflicts with an existing file.");
        }
        output.push(destination);
      }
    } finally { await rm(stage, { recursive: true, force: true }); }
    return { unpacked: true, files: output, detail: `Extracted ${output.length} files.` };
  }
}

/** Validate PAR2 output names before giving the repair executable write access. */
async function recoveryNames(path: string, allowed: Set<string>): Promise<Map<string, number>> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  const names = new Map<string, number>();
  try {
    const size = (await file.stat()).size;
    let offset = 0;
    while (offset < size) {
      const header = Buffer.alloc(64);
      if ((await file.read(header, 0, 64, offset)).bytesRead !== 64 || !header.subarray(0, 8).equals(Buffer.from("PAR2\0PKT"))) throw new Error("Invalid PAR2 packet.");
      const length = Number(header.readBigUInt64LE(8));
      if (!Number.isSafeInteger(length) || length < 64 || length % 4 || offset + length > size) throw new Error("Incomplete PAR2 recovery file.");
      const type = header.subarray(48, 64).toString("ascii");
      if (type === "PAR 2.0\0FileDesc") {
        if (length < 124 || length > 8192) throw new Error("Invalid PAR2 file description.");
        const body = Buffer.alloc(length - 64);
        await file.read(body, 0, body.length, offset + 64);
        const name = safeName(body.subarray(56).toString("utf8").replace(/\0+$/, ""));
        if (name !== basename(name) || !allowed.has(name)) throw new Error("PAR2 references a file outside this download.");
        names.set(name, Number(body.readBigUInt64LE(48)));
      } else if (type.includes("UniFile")) throw new Error("Unsupported PAR2 filename extension.");
      offset += length;
    }
  } finally { await file.close(); }
  return names;
}

export class Par2FileRepairer implements Par2Repairer {
  readonly available = Boolean(postprocessTools.par2);
  constructor(private readonly maxBytes: number, private readonly minFreeBytes: number) {}

  async repair(dir: string, targetFiles: readonly string[], signal?: AbortSignal): Promise<RepairResult> {
    signal?.throwIfAborted();
    if (!postprocessTools.par2) throw new Error("PAR2 repair requires par2cmdline. Install par2 and restart Tantalar.");
    await safeDirectory(dir, dir);
    const allowed = new Set(targetFiles.filter(name => !/\.par2$/i.test(name)));
    const parity = (await readdir(dir)).filter(name => /\.par2$/i.test(name));
    if (!parity.length) throw new Error("The release is damaged and has no PAR2 recovery files.");
    const names = new Map<string, number>();
    for (const name of parity) {
      await regular(join(dir, name));
      for (const [file, size] of await recoveryNames(join(dir, name), allowed)) names.set(file, size);
    }
    if (!names.size) throw new Error("PAR2 recovery data has no file descriptions.");
    await capacity(dir, [...names.values()].reduce((a, b) => a + b, 0) * 2, this.maxBytes * 2, this.minFreeBytes);
    const stage = await mkdtemp(join(dir, ".tantalar-repair-"));
    try {
      for (const name of parity) await link(join(dir, name), join(stage, name));
      for (const name of names.keys()) {
        signal?.throwIfAborted();
        try { await regular(join(dir, name)); await copyFile(join(dir, name), join(stage, name), constants.COPYFILE_FICLONE); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      }
      try { await run(postprocessTools.par2, ["r", "-q", "-m256", "-t2", `-B${stage}`, "--", join(stage, parity.find(n => !/\.vol\d+-\d+\.par2$/i.test(n)) ?? parity[0]!)], { signal, killSignal: "SIGKILL", cwd: stage, timeout: TIMEOUT, maxBuffer: MAX_LIST_BYTES }); }
      catch { throw new Error("PAR2 could not recover this release. Search for another release or add a fill server."); }
      for (const [name, size] of names) {
        signal?.throwIfAborted();
        const output = join(stage, name);
        await regular(output);
        if ((await lstat(output)).size !== size) throw new Error("PAR2 output is incomplete.");
        await rename(output, join(dir, name));
      }
    } finally { await rm(stage, { recursive: true, force: true }); }
    return { repaired: true, missingBlocks: 0, recoveredFiles: [...names.keys()], detail: "PAR2 verification and repair completed." };
  }
}
