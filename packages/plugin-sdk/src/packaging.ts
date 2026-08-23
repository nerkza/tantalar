/**
 * Plugin packaging tooling (phase-2): load a manifest from disk, verify the
 * package contents, and pack/unpack `.tpk` archives (uncompressed tar of
 * manifest.json + entry assets). Security invariants:
 *  - reject path traversal anywhere in archive member names;
 *  - reject symlinks / special files inside packages;
 *  - reject absolute paths;
 *  - enforce a per-file and total size cap;
 *  - manifest must validate against the canonical contract.
 */
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { validateManifest, type PluginManifest } from "@tantalar/contracts";

export const TPK_MAX_FILE_BYTES = 50 * 1024 * 1024;
export const TPK_MAX_TOTAL_BYTES = 200 * 1024 * 1024;

export class PackageError extends Error {}

function assertSafeMemberName(name: string): void {
  if (name.length === 0) throw new PackageError("package: empty member name");
  if (name.includes("\\")) throw new PackageError(`package: backslash in member name ${name}`);
  if (name.startsWith("/")) throw new PackageError(`package: absolute member path ${name}`);
  const parts = name.split("/");
  if (parts.some((p) => p === "..")) {
    throw new PackageError(`package: path traversal in member ${name}`);
  }
}

export interface LoadedPackage {
  readonly root: string;
  readonly manifest: PluginManifest;
}

/** Load + fully validate a plugin package directory. */
export async function loadPackage(root: string): Promise<LoadedPackage> {
  const absRoot = resolve(root);
  let raw: string;
  try {
    raw = await fs.readFile(join(absRoot, "manifest.json"), "utf8");
  } catch {
    throw new PackageError(`package: manifest.json not found under ${absRoot}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new PackageError(`package: malformed manifest.json: ${(err as Error).message}`);
  }
  const manifest = validateManifest(parsed);

  // Entry command must resolve within the package for local-path entries
  // ("node dist/plugin.js" style); bare commands (on PATH) pass through.
  const script = manifest.entry.command.split(" ")[1];
  if (script !== undefined && !script.includes("/")) {
    // bare module name resolved via node_modules — fine.
  } else if (script !== undefined) {
    const target = resolve(absRoot, script);
    if (!target.startsWith(absRoot + sep)) {
      throw new PackageError(`package: entry escapes package root (${script})`);
    }
    try {
      await fs.access(target);
    } catch {
      throw new PackageError(`package: entry script missing (${script})`);
    }
  }

  return { root: absRoot, manifest };
}

export interface TpkEntry {
  readonly name: string;
  readonly data: Buffer;
}

/**
 * Pack a validated package directory into .tpk entries (name + bytes).
 * Deterministic ordering; includes manifest.json and every file recursively,
 * skipping node_modules/.git/dist build caches are NOT skipped (entry may live
 * in dist).
 */
export async function packPlugin(
  root: string,
  opts: { skip?: (relPath: string) => boolean } = {},
): Promise<{ entries: TpkEntry[]; sha256: string }> {
  const pkg = await loadPackage(root);
  const skip = opts.skip ?? ((p) => p.startsWith("node_modules/") || p.startsWith(".git/"));
  const entries: TpkEntry[] = [];
  let total = 0;

  async function walk(dir: string): Promise<void> {
    const dirents = await fs.readdir(dir, { withFileTypes: true });
    for (const d of dirents.sort((a, b) => a.name.localeCompare(b.name))) {
      const abs = join(dir, d.name);
      const rel = abs.slice(pkg.root.length + 1).split(sep).join("/");
      if (d.isSymbolicLink()) throw new PackageError(`package: symlink not allowed in tpk (${rel})`);
      if (skip(rel)) continue;
      if (d.isDirectory()) {
        await walk(abs);
        continue;
      }
      if (!d.isFile()) throw new PackageError(`package: non-regular file not allowed (${rel})`);
      assertSafeMemberName(rel);
      const stat = await fs.stat(abs);
      if (stat.size > TPK_MAX_FILE_BYTES) throw new PackageError(`package: ${rel} exceeds file size cap`);
      total += stat.size;
      if (total > TPK_MAX_TOTAL_BYTES) throw new PackageError("package: total size cap exceeded");
      entries.push({ name: rel, data: await fs.readFile(abs) });
    }
  }
  await walk(pkg.root);

  const hash = createHash("sha256");
  for (const e of entries) {
    hash.update(e.name);
    hash.update(e.data);
  }
  return { entries, sha256: hash.digest("hex") };
}

/**
 * Verify a set of .tpk entries WITHOUT extracting to disk paths blindly:
 * returns the manifest after checking every member for traversal/symlinks and
 * revalidating it against the canonical contract.
 */
export async function verifyTpkEntries(entries: readonly TpkEntry[]): Promise<LoadedManifestFromEntries> {
  const names = new Set<string>();
  let total = 0;
  for (const e of entries) {
    assertSafeMemberName(e.name);
    if (names.has(e.name)) throw new PackageError(`package: duplicate member ${e.name}`);
    names.add(e.name);
    total += e.data.byteLength;
    if (e.data.byteLength > TPK_MAX_FILE_BYTES)
      throw new PackageError(`package: ${e.name} exceeds file size cap`);
    if (total > TPK_MAX_TOTAL_BYTES) throw new PackageError("package: total size cap exceeded");
  }
  const manifestEntry = entries.find((e) => e.name === "manifest.json");
  if (!manifestEntry) throw new PackageError("package: manifest.json missing from tpk");
  let parsed: unknown;
  try {
    parsed = JSON.parse(manifestEntry.data.toString("utf8"));
  } catch (err) {
    throw new PackageError(`package: malformed manifest.json: ${(err as Error).message}`);
  }
  return { manifest: validateManifest(parsed), files: [...entries] };
}

export interface LoadedManifestFromEntries {
  readonly manifest: PluginManifest;
  readonly files: readonly TpkEntry[];
}

/** Install layout helper: safe destination dir for an installed plugin id. */
export function installDirFor(pluginsRoot: string, pluginId: string): string {
  if (!/^[a-z0-9.-]+$/.test(pluginId)) throw new PackageError(`install: unsafe plugin id ${pluginId}`);
  return join(resolve(pluginsRoot), ...pluginId.split("."));
}

/** Extract verified entries into an install dir (already safety-checked). */
export async function extractTo(entries: readonly TpkEntry[], dest: string): Promise<void> {
  for (const e of entries) {
    const target = join(dest, e.name);
    if (!resolve(target).startsWith(resolve(dest) + sep) && basename(target) !== e.name.split("/").pop()) {
      throw new PackageError(`install: refusing ${e.name}`);
    }
    await fs.mkdir(dirname(target), { recursive: true });
    await fs.writeFile(target, e.data);
  }
}
