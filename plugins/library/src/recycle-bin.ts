import { createHash, randomUUID } from "node:crypto";
import { existsSync, linkSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, unlinkSync, writeFileSync, rmdirSync } from "node:fs";
import { basename, join, relative, sep } from "node:path";

function inside(root: string, path: string) { return path.startsWith(root + sep); }
function binRoot(root: string, create: boolean): string | null {
  const realRoot = realpathSync(root);
  const bin = join(realRoot, ".tantalar-recycle");
  if (!existsSync(bin)) { if (!create) return null; mkdirSync(bin, { mode: 0o700 }); }
  if (lstatSync(bin).isSymbolicLink() || realpathSync(bin) !== bin) throw new Error("Recycle bin must be a real directory inside the library.");
  return bin;
}

/** Preserve old bytes on the same filesystem before an atomic replacement. Failure stops the replacement. */
export function preserveReplacedFile(root: string, source: string): string {
  const realRoot = realpathSync(root);
  const path = realpathSync(source);
  if (!inside(realRoot, path) || lstatSync(source).isSymbolicLink() || !lstatSync(path).isFile()) throw new Error("Replacement source is outside its library.");
  const bin = binRoot(realRoot, true)!;
  const entry = join(bin, randomUUID());
  mkdirSync(entry, { mode: 0o700 });
  // Hardlink keeps the previous inode alive even when the destination is atomically replaced.
  linkSync(path, join(entry, "file"));
  writeFileSync(join(entry, "entry.json"), JSON.stringify({ version: 1, originalPath: relative(realRoot, path), name: basename(path), recycledAt: new Date().toISOString(), size: lstatSync(path).size }), { flag: "wx", mode: 0o600 });
  return entry;
}

export function recycleEntries(roots: readonly string[], days: number) {
  if (!Number.isInteger(days) || days < 0 || days > 3650) throw new Error("Invalid recycle-bin retention.");
  const entries: Array<{ id: string; name: string; recycledAt: string; size: number; expired: boolean; directory: string; fingerprint: string }> = [];
  for (const root of roots) {
    const bin = binRoot(root, false);
    if (!bin) continue;
    for (const id of readdirSync(bin).sort()) {
      if (!/^[a-f0-9-]{36}$/.test(id)) continue;
      const dir = join(bin, id);
      if (lstatSync(dir).isSymbolicLink() || !lstatSync(dir).isDirectory() || realpathSync(dir) !== dir) continue;
      const metadataPath = join(dir, "entry.json"), filePath = join(dir, "file");
      if (!existsSync(metadataPath) || !existsSync(filePath) || lstatSync(metadataPath).isSymbolicLink() || lstatSync(filePath).isSymbolicLink()) continue;
      const info = lstatSync(filePath);
      if (!info.isFile() || !lstatSync(metadataPath).isFile() || lstatSync(metadataPath).size > 4096) continue;
      try {
        const raw = readFileSync(metadataPath, "utf8");
        const record = JSON.parse(raw);
        if (record.version !== 1 || typeof record.name !== "string" || !Number.isFinite(Date.parse(record.recycledAt)) || record.size !== info.size) continue;
        entries.push({ id, name: record.name, recycledAt: record.recycledAt, size: info.size, expired: days > 0 && Date.parse(record.recycledAt) < Date.now() - days * 86_400_000,
          directory: dir, fingerprint: createHash("sha256").update(`${raw}:${info.ino}:${info.size}:${info.mtimeMs}`).digest("hex") });
      } catch { /* Unrecognised entries are never deletion candidates. */ }
      if (entries.length >= 1000) return entries;
    }
  }
  return entries;
}

export function cleanupRecycleBin(roots: readonly string[], days: number, expected?: ReadonlyArray<{ id: string; fingerprint: string }>) {
  const entries = recycleEntries(roots, days).filter(e => e.expired);
  const approved = expected ? new Map(expected.map(e => [e.id, e.fingerprint])) : null;
  let removed = 0, bytes = 0;
  for (const entry of entries) {
    if (approved && approved.get(entry.id) !== entry.fingerprint) continue;
    // Re-read the managed entry immediately before deletion. Never recursively remove a directory.
    if (lstatSync(entry.directory).isSymbolicLink() || realpathSync(entry.directory) !== entry.directory) continue;
    const file = join(entry.directory, "file"), metadata = join(entry.directory, "entry.json");
    const info = lstatSync(file), metaInfo = lstatSync(metadata);
    if (!info.isFile() || info.isSymbolicLink() || !metaInfo.isFile() || metaInfo.isSymbolicLink() || metaInfo.size > 4096) continue;
    const raw = readFileSync(metadata, "utf8");
    if (createHash("sha256").update(`${raw}:${info.ino}:${info.size}:${info.mtimeMs}`).digest("hex") !== entry.fingerprint) continue;
    unlinkSync(file);
    unlinkSync(metadata);
    try { rmdirSync(entry.directory); } catch { /* Unexpected extra files remain untouched. */ }
    removed++; bytes += entry.size;
  }
  return { removed, bytes };
}
