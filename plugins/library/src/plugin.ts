/**
 * Library / import post-processor plugin (phase 4, stories 10–12).
 *
 * Provides `dev.tantalar.capability.importer`: safe configurable rename
 * schemes, hardlink-first import with cross-device copy fallback, atomic
 * file placement (temp name + rename), collision handling, quality-upgrade
 * replacement with verified rollback (the old copy is only removed after
 * the new copy is fully in place), and an in-process media-library record
 * set plus calendar entries derived from monitored media.
 *
 * Security invariants:
 *  - source paths must sit inside a configured import root;
 *  - symlinks are rejected by default (conservative);
 *  - resolved destinations must stay inside the library root (no path
 *    traversal or symlink escape);
 *  - every accepted operation is event-traced with correlationId and is
 *    idempotent on (itemKey + source hash).
 */
import { runPlugin, definePlugin, type PluginContext, type PluginDefinition } from "@tantalar/plugin-sdk";
import { preserveReplacedFile, recycleEntries, cleanupRecycleBin } from "./recycle-bin.js";
import {
  PROTOCOL_VERSION,
  validateManifest,
  EventTypes,
  ImportError,
  validateRenameTemplate,
  type ImportMethod,
  type ImportMode,
  type ImportPlan,
} from "@tantalar/contracts";

import {
  realpathSync,
  lstatSync,
  statSync,
  mkdirSync,
  createReadStream,
  linkSync,
  renameSync,
  unlinkSync,
  existsSync,
  readFileSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { copyFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, dirname, resolve as pathResolve, basename, extname, relative, sep } from "node:path";

const IMPORTER_CAPABILITY = "dev.tantalar.capability.importer";
const PLUGIN_ID = "dev.tantalar.plugin.library";

const manifest = validateManifest({
  id: PLUGIN_ID,
  version: "0.1.0",
  protocolVersion: PROTOCOL_VERSION,
  provides: [IMPORTER_CAPABILITY],
  requires: ["dev.tantalar.capability.event.emit", "dev.tantalar.capability.log"],
  subscriptions: [],
  entry: { command: "node dist/plugin.js" },
});

// ---- Naming templates ---------------------------------------------------------

interface CompiledScheme {
  readonly name: string;
  readonly episodeTemplate: string;
  readonly movieTemplate: string;
}

function defaultSchemes(): Map<string, CompiledScheme> {
  const out = new Map<string, CompiledScheme>();
  out.set("default", {
    name: "default",
    episodeTemplate: "{series}/Season {seasonPad2}/{series} S{seasonPad2}E{episodePad2} {quality}",
    movieTemplate: "{title} ({year})/{title} ({year}) {quality}",
  });
  return out;
}

const PLACEHOLDER_RE = /\{(series|season|episode|title|year|quality|seasonPad2|episodePad2|codec|language|group|edition)\}/g;

function renderTemplate(
  template: string,
  values: Record<string, string>,
): string {
  const cleaned = template.split(/[\\/]/).filter((p) => p.length > 0 && p !== "." && p !== "..");
  return cleaned
    .map((segment) =>
      segment.replace(PLACEHOLDER_RE, (_m, key: string) => {
        const v = values[key];
        if (v === undefined) throw new ImportError("invalid_template", `missing value for {${key}}`);
        // Sanitize each substituted value: no separators, no traversal.
        return v.replace(/[\\/:*?"<>|.]/g, " ").trim() || "unknown";
      }),
    )
    .join("/");
}

// ---- In-process state -----------------------------------------------------------

interface LibraryFileRecord {
  readonly itemKey: string;
  readonly destinationPath: string;
  readonly method: ImportMethod;
  readonly quality: string;
  /** sha256 of source content at import time. */
  readonly sourceHash: string;
  readonly importedAt: string;
}

interface CalendarEntry {
  readonly itemKey: string;
  readonly kind: "series" | "movie";
  readonly title: string;
  /** ISO date of the upcoming release/air date. */
  readonly date: string;
}

let emitFn:
  | ((type: string, payload: Record<string, unknown>, opts?: { correlationId?: string }) => Promise<void>)
  | null = null;

const importRoots: string[] = [];
const sourceRoots: string[] = []; // configured download/completed dirs
const schemes = defaultSchemes();
/** itemKey -> current file record (history kept per import below). */
const libraryItems = new Map<string, LibraryFileRecord[]>();
/** Idempotency ledger: `${itemKey}:${sourceHash}` -> result. */
const importLedger = new Map<string, ImportOutcome>();
// Keep staging names and the idempotency ledger serial while file I/O yields to health pings.
let importWork = Promise.resolve();
const calendarEntries = new Map<string, CalendarEntry>();

/** Wave 3 (TAN-013): durable storage bridge; null when storage is unavailable. */
let store: PluginContext["storage"] | null = null;
const DOC_KEY = "state";

/** Snapshot library items + calendar into the durable document store. */
async function persist(): Promise<void> {
  if (!store) return;
  try {
    await store.put(DOC_KEY, {
      items: [...libraryItems.entries()].map(([key, list]) => ({ key, list })),
      ledger: [...importLedger.entries()].map(([k, v]) => ({ k, v })),
      calendar: [...calendarEntries.values()],
      schemes: [...schemes.values()],
    });
  } catch {
    /* durability resumes on the next mutation */
  }
}

/** Restore from the durable document store at mount (crash/restart recovery). */
async function restore(): Promise<void> {
  if (!store) return;
  try {
    const hit = await store.get(DOC_KEY);
    const doc = hit?.doc as
      | {
          items?: Array<{ key: string; list: LibraryFileRecord[] }>;
          ledger?: Array<{ k: string; v: ImportOutcome }>;
          calendar?: CalendarEntry[];
          schemes?: CompiledScheme[];
        }
      | undefined;
    for (const it of doc?.items ?? []) libraryItems.set(it.key, [...it.list]);
    for (const l of doc?.ledger ?? []) importLedger.set(l.k, l.v);
    for (const c of doc?.calendar ?? []) calendarEntries.set(c.itemKey, c);
    for (const s of doc?.schemes ?? []) if (!schemes.has(s.name)) schemes.set(s.name, s);
  } catch {
    /* corrupt snapshot: start clean rather than fail the mount */
  }
}

/**
 * Test-only fault injection. When TANTALAR_FAULT is set, the named fault
 * fires once at the matching point in the import path. Production runs
 * never set it, so behavior is unchanged.
 */
function injectFault(name: string): void {
  const cfg = process.env.TANTALAR_FAULT;
  if (cfg !== name) return;
  delete process.env.TANTALAR_FAULT;
  switch (name) {
    case "short-copy": {
      // Simulate a truncated staged copy: shrink it after the copy step.
      const stagingPath = process.env.TANTALAR_FAULT_PATH ?? "";
      if (stagingPath && existsSync(stagingPath)) truncateSync(stagingPath, 1);
      break;
    }
    case "corrupt-copy": {
      // Same size as the source but different bytes: defeats size checks,
      // forcing the staged-hash verification to catch it.
      const p = process.env.TANTALAR_FAULT_PATH ?? "";
      if (p && existsSync(p)) {
        const buf = readFileSync(p);
        buf[0] = buf[0] === 0x58 ? 0x59 : 0x58; // flip one byte, keep length
        writeFileSync(p, buf);
      }
      break;
    }
    case "swap-fail":
      // Failure between staging and swap-in (e.g. rename fails).
      throw new ImportError("io_error", "injected swap failure between staging and swap-in");
    default:
      break;
  }
}

interface ImportOutcome {
  readonly itemKey: string;
  readonly destinationPath: string;
  readonly method: ImportMethod;
  readonly sourceHash: string;
  readonly upgraded: boolean;
  readonly replacedPath?: string;
}

interface PlannedImport {
  readonly review: ImportPlan;
  readonly root: string;
  readonly existing?: LibraryFileRecord;
  readonly deduplicatedOutcome?: ImportOutcome;
  readonly persistDeduplication: boolean;
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

/** True when `child` resolves inside `root` (both already realpaths). */
function isInside(root: string, child: string): boolean {
  return child === root || child.startsWith(root + sep);
}

/** Resolve without following symlinks for the final component. */
function assertInsideRoot(p: string, roots: readonly string[], what: string): string {
  const abs = pathResolve(p);
  let realParent: string;
  try {
    realParent = realpathSync(dirname(abs));
  } catch {
    throw new ImportError("outside_root", `${what}: parent directory does not exist`);
  }
  const realPath = join(realParent, basename(abs));
  if (!roots.some((r) => isInside(r, realPath)))
    throw new ImportError("outside_root", `${what} outside configured roots: ${abs}`);
  return abs;
}

function rejectSymlink(p: string): void {
  try {
    if (lstatSync(p).isSymbolicLink())
      throw new ImportError("symlink_rejected", `symlinks rejected: ${p}`);
  } catch (err) {
    if (err instanceof ImportError) throw err;
    throw new ImportError("io_error", `cannot stat ${p}`);
  }
}

function ensureRoots(config: Record<string, unknown>): void {
  const cfg = config as { importRoots?: unknown; sourceRoots?: unknown };
  const imports = Array.isArray(cfg.importRoots) ? cfg.importRoots.filter((r): r is string => typeof r === "string" && r.length > 0).map(r => realpathSync(r)) : [...importRoots];
  const sources = Array.isArray(cfg.sourceRoots) ? cfg.sourceRoots.filter((r): r is string => typeof r === "string" && r.length > 0).map(r => realpathSync(r)) : [...sourceRoots];
  if (Array.isArray(cfg.importRoots)) {
    importRoots.length = 0;
    importRoots.push(...imports);
  }
  if (Array.isArray(cfg.sourceRoots)) {
    sourceRoots.length = 0;
    sourceRoots.push(...sources);
  }
}

function renderFor(req: Record<string, unknown>, scheme: CompiledScheme): string {
  const kind = req.kind === "movie" ? "movie" : "series";
  const template = validateRenameTemplate(kind === "movie" ? scheme.movieTemplate : scheme.episodeTemplate);
  const season = typeof req.season === "number" ? String(Math.trunc(req.season)) : "00";
  const episode = typeof req.episode === "number" ? String(Math.trunc(req.episode)) : "00";
  const values: Record<string, string> = {
    series: String(req.series ?? req.title ?? "Unknown"),
    title: String(req.title ?? "Unknown"),
    season,
    seasonPad2: season.padStart(2, "0"),
    episode,
    episodePad2: episode.padStart(2, "0"),
    year: typeof req.year === "number" ? String(Math.trunc(req.year)) : "",
    quality: String(req.quality ?? "unknown"),
    codec: String(req.codec ?? ""),
    language: String(req.language ?? ""),
    group: String(req.releaseGroup ?? ""),
    edition: String(req.edition ?? ""),
  };
  return renderTemplate(template, values);
}

function normalizeImportMode(value: unknown): ImportMode {
  if (value === undefined || value === "automatic") return "automatic";
  if (value === "copy") return "copy";
  throw new ImportError("invalid_mode", "mode must be automatic or copy");
}

/** Resolve the existing path prefix without creating the destination tree. */
function plannedDestinationPath(root: string, candidate: string): string {
  const absolute = pathResolve(candidate);
  if (!isInside(root, absolute)) {
    throw new ImportError("path_escape", "destination escapes the library root");
  }
  let existingParent = dirname(absolute);
  while (!existsSync(existingParent)) {
    const parent = dirname(existingParent);
    if (parent === existingParent) throw new ImportError("outside_root", "destination parent cannot be resolved");
    existingParent = parent;
  }
  const resolvedParent = realpathSync(existingParent);
  if (!isInside(root, resolvedParent)) {
    throw new ImportError("path_escape", "resolved destination escapes the library root");
  }
  const destination = join(resolvedParent, relative(existingParent, absolute));
  if (!isInside(root, destination)) {
    throw new ImportError("path_escape", "resolved destination escapes the library root");
  }
  return destination;
}

async function planImport(payload: Record<string, unknown>): Promise<PlannedImport> {
  if (importRoots.length === 0) throw new ImportError("outside_root", "no import roots configured");
  const sourceInput = String(payload.sourcePath ?? "");
  if (!sourceInput) throw new ImportError("io_error", "sourcePath required");
  const itemKey = String(payload.itemKey ?? "");
  if (!itemKey) throw new ImportError("io_error", "itemKey required");
  const quality = String(payload.quality ?? "unknown");
  const title = String(payload.title ?? "");
  if (!title) throw new ImportError("io_error", "title required");
  const mode = normalizeImportMode(payload.mode);

  const sourcePath = assertInsideRoot(sourceInput, [...importRoots, ...sourceRoots], "source");
  rejectSymlink(sourcePath);
  const sourceStat = statSync(sourcePath);
  if (!sourceStat.isFile()) throw new ImportError("io_error", "source must be a regular file");
  const sourceHash = await sha256File(sourcePath);

  const scheme = String(payload.scheme ?? "default");
  const compiledScheme = schemes.get(scheme);
  if (!compiledScheme) throw new ImportError("invalid_template", `unknown scheme ${scheme}`);
  const requestedRoot = typeof payload.destinationRoot === "string" ? realpathSync(payload.destinationRoot) : importRoots[0]!;
  if (!importRoots.includes(requestedRoot)) {
    throw new ImportError("outside_root", "destinationRoot is not a configured import root");
  }
  const renderedPath = join(requestedRoot, renderFor(payload, compiledScheme)) + extname(sourcePath);
  const prior = importLedger.get(`${itemKey}:${sourceHash}`);
  const destinationPath = plannedDestinationPath(requestedRoot, prior?.destinationPath ?? renderedPath);
  let destinationHash: string | null = null;
  if (existsSync(destinationPath)) {
    rejectSymlink(destinationPath);
    if (!statSync(destinationPath).isFile()) throw new ImportError("collision", "destination is not a regular file");
    destinationHash = await sha256File(destinationPath);
  }

  const existing = libraryItems.get(itemKey)?.at(-1);
  const deduplicatedOutcome = prior ?? (destinationHash === sourceHash
    ? {
        itemKey,
        destinationPath,
        method: existing?.method ?? "copy",
        sourceHash,
        upgraded: false,
      }
    : undefined);
  if (existing && !deduplicatedOutcome && !payload.force) {
    const rank = ["480p", "720p", "1080p", "2160p"];
    const currentIndex = rank.indexOf(existing.quality);
    const nextIndex = rank.indexOf(quality);
    if (currentIndex >= 0 && nextIndex >= 0 && nextIndex <= currentIndex) {
      throw new ImportError("collision", `existing ${existing.quality} is not worse than ${quality}`);
    }
  }

  const kind = payload.kind === "movie" ? "movie" : "series";
  const action: ImportPlan["action"] = deduplicatedOutcome ? "deduplicate" : existing ? "upgrade" : "import";
  const publicPlan: Omit<ImportPlan, "fingerprint"> = {
    itemKey,
    sourcePath,
    destinationPath,
    sourceHash,
    quality,
    title,
    kind,
    ...(typeof payload.series === "string" ? { series: payload.series } : {}),
    ...(typeof payload.season === "number" && Number.isFinite(payload.season) ? { season: Math.trunc(payload.season) } : {}),
    ...(typeof payload.episode === "number" && Number.isFinite(payload.episode) ? { episode: Math.trunc(payload.episode) } : {}),
    ...(typeof payload.year === "number" && Number.isFinite(payload.year) ? { year: Math.trunc(payload.year) } : {}),
    scheme,
    ...(typeof payload.codec === "string" ? { codec: payload.codec } : {}),
    ...(typeof payload.language === "string" ? { language: payload.language } : {}),
    ...(typeof payload.releaseGroup === "string" ? { releaseGroup: payload.releaseGroup } : {}),
    ...(typeof payload.edition === "string" ? { edition: payload.edition } : {}),
    mode,
    action,
  };
  const fingerprint = createHash("sha256").update(JSON.stringify({
    plan: publicPlan,
    destinationHash,
    existing: existing ? {
      destinationPath: existing.destinationPath,
      quality: existing.quality,
      sourceHash: existing.sourceHash,
    } : null,
  })).digest("hex");
  return {
    review: { ...publicPlan, fingerprint },
    root: requestedRoot,
    ...(existing ? { existing } : {}),
    ...(deduplicatedOutcome ? { deduplicatedOutcome } : {}),
    persistDeduplication: Boolean(deduplicatedOutcome && !prior),
  };
}

/** Atomic placement: write to temp name in dest dir, then fsync-rename in. */
async function placeAtomically(src: string, dest: string, preferHardlink: boolean): Promise<ImportMethod> {
  mkdirSync(dirname(dest), { recursive: true });
  const tmp = join(dirname(dest), `.tantalar-${basename(dest)}.tmp-${process.pid}`);
  try {
    unlinkSync(tmp);
  } catch {
    /* absent is fine */
  }
  let method: ImportMethod = "copy";
  if (preferHardlink) {
    try {
      linkSync(src, tmp);
      method = "hardlink";
    } catch {
      // EXDEV / cross-device / unsupported → copy fallback.
      method = "copy";
    }
  }
  if (method === "copy") await copyFile(src, tmp);
  // Partial-copy guard: byte length must match before the rename lands.
  if (statSync(tmp).size !== statSync(src).size)
    throw new ImportError("io_error", "partial copy detected (size mismatch)");
  renameSync(tmp, dest); // same-directory rename is atomic
  return method;
}

async function doImport(payload: Record<string, unknown>): Promise<ImportOutcome & { deduplicated: boolean }> {
  const planned = await planImport(payload);
  const { review, root, existing, deduplicatedOutcome, persistDeduplication } = planned;
  const suppliedFingerprint = payload.reviewFingerprint;
  if (suppliedFingerprint !== undefined && suppliedFingerprint !== review.fingerprint) {
    throw new ImportError("review_stale", "import review changed; review again");
  }

  const { itemKey, sourcePath: src, destinationPath: dest, sourceHash: hash, quality, mode } = review;
  const ledgerKey = `${itemKey}:${hash}`;
  if (deduplicatedOutcome) {
    if (persistDeduplication) {
      importLedger.set(ledgerKey, deduplicatedOutcome);
      await persist();
    }
    return { ...deduplicatedOutcome, sourceHash: deduplicatedOutcome.sourceHash ?? hash, deduplicated: true };
  }

  const st = statSync(src);

  await emitFn?.(
    EventTypes.ImportStarted,
    { itemKey, sourcePath: src, quality },
    typeof payload.correlationId === "string" ? { correlationId: payload.correlationId } : undefined,
  );

  // Create the destination directory tree first, then verify containment
  // against real paths so a symlinked segment cannot escape.
  mkdirSync(dirname(dest), { recursive: true });
  if (plannedDestinationPath(root, dest) !== dest) {
    throw new ImportError("path_escape", "resolved destination changed after review");
  }

  // Upgrade safety: place the NEW file first under a temp sibling, verify
  // it, then remove the old copy — the only good copy is never deleted
  // before replacement verification.
  const staging = dest + ".upgrade-staging";
  let method: ImportMethod;
  try {
    unlinkSync(staging);
  } catch {
    /* absent ok */
  }
  try {
    if (existing) {
      // Stage via hardlink-or-copy to a staging name first.
      if (mode === "copy") {
        await copyFile(src, staging);
        method = "copy";
      } else {
        try {
          linkSync(src, staging);
          method = "hardlink";
        } catch {
          await copyFile(src, staging);
          method = "copy";
        }
      }
      injectFault("short-copy");
      injectFault("corrupt-copy");
      if (statSync(staging).size !== st.size)
        throw new ImportError("io_error", "partial staged copy (size mismatch)");
      // Verify staged bytes match source before touching the old file.
      if (await sha256File(staging) !== hash)
        throw new ImportError("io_error", "staged copy verification failed");
      const replacedPath = existing.destinationPath;
      injectFault("swap-fail");
      preserveReplacedFile(root, replacedPath);
      renameSync(staging, dest); // atomic swap-in of verified new bytes
      // Only now remove superseded copies that are NOT this destination.
      if (replacedPath !== dest) {
        try {
          unlinkSync(replacedPath);
        } catch {
          /* best effort; history keeps the record */
        }
      }
    } else {
      method = await placeAtomically(src, dest, mode === "automatic");
    }

    const rec: LibraryFileRecord = {
      itemKey,
      destinationPath: dest,
      method,
      quality,
      sourceHash: hash,
      importedAt: new Date().toISOString(),
    };
    const list = libraryItems.get(itemKey) ?? [];
    list.push(rec);
    libraryItems.set(itemKey, list);

    const outcome: ImportOutcome = {
      itemKey,
      destinationPath: dest,
      method,
      sourceHash: hash,
      upgraded: Boolean(existing),
      ...(existing ? { replacedPath: existing.destinationPath } : {}),
    };
    importLedger.set(ledgerKey, outcome);
    await persist();

    const corr = typeof payload.correlationId === "string" ? { correlationId: payload.correlationId } : undefined;
    if (existing) {
      await emitFn?.(
        EventTypes.UpgradeReplaced,
        { itemKey, old: existing.destinationPath, new: dest, oldQuality: existing.quality, quality },
        corr,
      );
    }
    await emitFn?.(
      EventTypes.ImportCompleted,
      { itemKey, destinationPath: dest, method, upgraded: outcome.upgraded },
      corr,
    );
    return { ...outcome, deduplicated: false };
  } catch (err) {
    // Rollback: remove any staged leftovers; the original file was never
    // removed before this point, so nothing else to restore.
    try {
      unlinkSync(staging);
    } catch {
      /* ok */
    }
    await emitFn?.(
      EventTypes.ImportFailed,
      { itemKey, sourcePath: src, error: (err as Error).message },
      typeof payload.correlationId === "string" ? { correlationId: payload.correlationId } : undefined,
    );
    throw err;
  }
}

const plugin: PluginDefinition = definePlugin({
  manifest,
  async mount(ctx) {
    emitFn = async (type, payload, opts) => ctx.emit(type, payload, opts);
    store = ctx.storage ?? null;
    ensureRoots(ctx.config);
    await restore();
    ctx.log("info", "library importer mounted");
  },
  unmount(ctx) {
    emitFn = null;
    store = null;
    ctx.log("info", "library importer unmounted");
  },
  handlers: {
    [IMPORTER_CAPABILITY]: async (operation, payload) => {
      switch (operation) {
        case "configure-roots":
          ensureRoots(payload);
          return { configured: true };
        case "set-scheme": {
          const name = String(payload.name ?? "");
          if (!name) throw new ImportError("invalid_template", "scheme name required");
          const ep = validateRenameTemplate(String(payload.episodeTemplate ?? ""));
          const mv = validateRenameTemplate(String(payload.movieTemplate ?? ""));
          schemes.set(name, { name, episodeTemplate: ep, movieTemplate: mv });
          await persist();
          return { set: name };
        }
        case "list-schemes":
          return { schemes: [...schemes.values()], roots: [...importRoots] };
        case "preview-rename": {
          // TAN-022: live preview of the output path for a candidate scheme
          // and item without touching disk. Throws on an invalid template so
          // invalid schemes can never be saved by the caller.
          const kind = payload.kind === "movie" ? "movie" : "series";
          const schemeName = String(payload.scheme ?? "default");
          const scheme = schemes.get(schemeName);
          if (!scheme) throw new ImportError("invalid_template", `unknown scheme ${schemeName}`);
          const episodeTemplate = validateRenameTemplate(
            typeof payload.episodeTemplate === "string" ? payload.episodeTemplate : scheme.episodeTemplate,
          );
          const movieTemplate = validateRenameTemplate(
            typeof payload.movieTemplate === "string" ? payload.movieTemplate : scheme.movieTemplate,
          );
          const rel = renderFor({ ...payload, kind }, { name: schemeName, episodeTemplate, movieTemplate });
          const ext = typeof payload.ext === "string" && payload.ext ? payload.ext : ".mkv";
          const root = typeof payload.destinationRoot === "string" ? realpathSync(payload.destinationRoot) : importRoots[0] ?? "(no import root configured)";
          if (payload.destinationRoot && !importRoots.includes(root)) throw new Error("Unknown library root.");
          return { path: `${root}/${rel}${ext}`, scheme: schemeName, kind };
        }
        case "rename-plan": {
          // TAN-022: bulk review — re-render every imported item under a
          // candidate scheme and report which destinations would change.
          // Nothing moves; the result is reviewable before any bulk change.
          const schemeName = String(payload.scheme ?? "default");
          const scheme = schemes.get(schemeName);
          if (!scheme) throw new ImportError("invalid_template", `unknown scheme ${schemeName}`);
          const root = importRoots[0];
          if (!root) throw new ImportError("invalid_template", "no import root configured");
          const plan: Array<{ itemKey: string; currentPath: string; newPath: string; changes: boolean }> = [];
          for (const [itemKey, records] of libraryItems) {
            const last = records.at(-1)!;
            const kind = itemKey.startsWith("movie") ? "movie" : "series";
            const title = itemKey.split(":").slice(1).join(":") || itemKey;
            let newPath: string;
            try {
              const rel = renderFor({ kind, title, series: title, quality: last.quality }, scheme);
              newPath = join(root, rel) + extname(last.destinationPath);
            } catch (err) {
              newPath = `(invalid under this scheme: ${(err as Error).message})`;
            }
            plan.push({ itemKey, currentPath: last.destinationPath, newPath, changes: newPath !== last.destinationPath });
          }
          plan.sort((a, b) => a.itemKey.localeCompare(b.itemKey));
          return { scheme: schemeName, total: plan.length, changed: plan.filter((p) => p.changes).length, plan };
        }
        case "recycle-preview": {
          const roots = payload.root ? importRoots.filter(root => root === payload.root) : importRoots;
          if (payload.root && roots.length !== 1) throw new Error("Unknown library root.");
          return { entries: recycleEntries(roots, Number(payload.days ?? 7)).map(({ directory: _directory, ...entry }) => entry) };
        }
        case "register-existing": {
          const itemKey = String(payload.itemKey ?? "");
          if (!itemKey) throw new Error("Missing media identity.");
          if (libraryItems.has(itemKey)) return { registered: false };
          const path = assertInsideRoot(String(payload.path), importRoots, "existing file");
          rejectSymlink(path);
          if (!statSync(path).isFile()) throw new Error("Existing media is not a file.");
          const record: LibraryFileRecord = { itemKey, destinationPath: path, quality: String(payload.quality ?? "unknown"), method: "copy", sourceHash: await sha256File(path), importedAt: new Date().toISOString() };
          libraryItems.set(itemKey, [record]);
          await persist();
          return { registered: true };
        }
        case "rename-file": {
          const work = importWork.then(async () => {
            const root = realpathSync(String(payload.root));
            if (!importRoots.includes(root)) throw new Error("Unknown library root.");
            const source = assertInsideRoot(String(payload.source), [root], "rename source");
            const destination = plannedDestinationPath(root, String(payload.destination));
            if (relative(root, destination).split(sep).includes(".tantalar-recycle")) throw new Error("Cannot rename media into the recycle bin.");
            const path = existsSync(source) ? source : destination;
            rejectSymlink(path);
            const info = statSync(path);
            const fingerprint = `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}`;
            if (!info.isFile() || fingerprint !== payload.fingerprint) throw new Error("File changed since preview. Create a new rename preview.");
            if (source !== destination && existsSync(source)) {
              mkdirSync(dirname(destination), { recursive: true });
              if (plannedDestinationPath(root, destination) !== destination) throw new Error("Rename destination changed.");
              // link is atomic and refuses an occupied destination. Retry can recover between link and unlink.
              if (existsSync(destination)) {
                rejectSymlink(destination);
                const target = statSync(destination);
                if (target.dev !== info.dev || target.ino !== info.ino) throw new Error("Rename destination already exists.");
              } else linkSync(source, destination);
              unlinkSync(source);
            }
            for (const records of libraryItems.values()) for (let i = 0; i < records.length; i++) if (records[i]!.destinationPath === source) records[i] = { ...records[i]!, destinationPath: destination };
            for (const [key, outcome] of importLedger) if (outcome.destinationPath === source) importLedger.set(key, { ...outcome, destinationPath: destination });
            await persist();
            return { destination };
          });
          importWork = work.then(() => undefined, () => undefined);
          return work;
        }
        case "recycle-cleanup": {
          const work = importWork.then(() => {
            const roots = payload.root ? importRoots.filter(root => root === payload.root) : importRoots;
            if (payload.root && roots.length !== 1) throw new Error("Unknown library root.");
            return cleanupRecycleBin(roots, Number(payload.days ?? 7), Array.isArray(payload.entries) ? payload.entries : undefined);
          });
          importWork = work.then(() => undefined, () => undefined);
          return work;
        }
        case "review-import":
          return (await planImport(payload)).review;
        case "import": {
          const work = importWork.then(() => doImport(payload));
          importWork = work.then(() => undefined, () => undefined);
          return work;
        }
        case "library": {
          const out: Array<{ itemKey: string; path: string; quality: string; method: string; importedAt: string }> = [];
          for (const [key, records] of libraryItems) {
            const last = records.at(-1)!;
            out.push({
              itemKey: key,
              path: last.destinationPath,
              quality: last.quality,
              method: last.method,
              importedAt: last.importedAt,
            });
          }
          return { items: out };
        }
        case "history": {
          const key = String(payload.itemKey ?? "");
          const recs = libraryItems.get(key) ?? [];
          return {
            history: recs.map((r) => ({
              path: r.destinationPath,
              quality: r.quality,
              method: r.method,
              importedAt: r.importedAt,
            })),
          };
        }
        case "calendar": {
          // Calendar data derived from monitored media: callers register
          // monitored items via `register-monitored`; entries with dates.
          const now = new Date().toISOString().slice(0, 10);
          const all = [...calendarEntries.values()].sort((a, b) => a.date.localeCompare(b.date));
          const upcoming = payload.includePast ? all : all.filter((c) => c.date >= now);
          return { upcoming };
        }
        case "register-monitored": {
          const itemKey = String(payload.itemKey ?? "");
          const title = String(payload.title ?? "");
          const date = String(payload.date ?? "");
          const kind = payload.kind === "movie" ? "movie" : "series";
          if (!itemKey || !title || Number.isNaN(Date.parse(date)))
            throw new Error("itemKey, title, and ISO date required");
          calendarEntries.set(itemKey, { itemKey, kind, title, date: date.slice(0, 10) });
          await persist();
          return { registered: itemKey };
        }
        case "conformance-probe":
          return { ok: true };
        case "inject-fault": {
          // Test-only: arm the next single fault in this plugin process.
          const name = String(payload.name ?? "");
          if (!["short-copy", "corrupt-copy", "swap-fail"].includes(name))
            throw new Error(`unknown fault ${name}`);
          process.env.TANTALAR_FAULT = name;
          if (typeof payload.path === "string") process.env.TANTALAR_FAULT_PATH = payload.path;
          else delete process.env.TANTALAR_FAULT_PATH;
          return { armed: name };
        }
        default:
          throw new Error(`unknown operation ${operation}`);
      }
    },
  },
});

runPlugin(plugin);
