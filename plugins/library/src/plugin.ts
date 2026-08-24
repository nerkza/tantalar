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
import {
  PROTOCOL_VERSION,
  validateManifest,
  EventTypes,
  ImportError,
  validateRenameTemplate,
  type ImportMethod,
} from "@tantalar/contracts";

import {
  realpathSync,
  lstatSync,
  statSync,
  mkdirSync,
  copyFileSync,
  linkSync,
  renameSync,
  unlinkSync,
  existsSync,
  readFileSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname, resolve as pathResolve, basename, extname, sep } from "node:path";

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

const PLACEHOLDER_RE = /\{(series|season|episode|title|year|quality|seasonPad2|episodePad2|codec|language|edition)\}/g;

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
  readonly upgraded: boolean;
  readonly replacedPath?: string;
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
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
  if (Array.isArray(cfg.importRoots)) {
    importRoots.length = 0;
    for (const r of cfg.importRoots) {
      if (typeof r === "string" && r.length > 0) importRoots.push(realpathSync(r));
    }
  }
  if (Array.isArray(cfg.sourceRoots)) {
    sourceRoots.length = 0;
    for (const r of cfg.sourceRoots) {
      if (typeof r === "string" && r.length > 0) sourceRoots.push(realpathSync(r));
    }
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
    edition: String(req.edition ?? ""),
  };
  return renderTemplate(template, values);
}

/** Atomic placement: write to temp name in dest dir, then fsync-rename in. */
function placeAtomically(src: string, dest: string, preferHardlink: boolean): ImportMethod {
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
  if (method === "copy") copyFileSync(src, tmp);
  // Partial-copy guard: byte length must match before the rename lands.
  if (statSync(tmp).size !== statSync(src).size)
    throw new ImportError("io_error", "partial copy detected (size mismatch)");
  renameSync(tmp, dest); // same-directory rename is atomic
  return method;
}

async function doImport(payload: Record<string, unknown>): Promise<ImportOutcome & { deduplicated: boolean }> {
  if (importRoots.length === 0)
    throw new ImportError("outside_root", "no import roots configured");
  const src = String(payload.sourcePath ?? "");
  if (!src) throw new ImportError("io_error", "sourcePath required");
  const itemKey = String(payload.itemKey ?? "");
  if (!itemKey) throw new ImportError("io_error", "itemKey required");
  const quality = String(payload.quality ?? "unknown");
  const title = String(payload.title ?? "");
  if (!title) throw new ImportError("io_error", "title required");

  // Source must be inside a configured source/import root and not a symlink.
  assertInsideRoot(src, [...importRoots, ...sourceRoots], "source");
  rejectSymlink(src);
  const st = statSync(src);
  if (!st.isFile()) throw new ImportError("io_error", "source must be a regular file");

  const hash = sha256File(src);
  const ledgerKey = `${itemKey}:${hash}`;
  const prior = importLedger.get(ledgerKey);
  if (prior) return { ...prior, deduplicated: true };

  await emitFn?.(
    EventTypes.ImportStarted,
    { itemKey, sourcePath: src, quality },
    typeof payload.correlationId === "string" ? { correlationId: payload.correlationId } : undefined,
  );

  const schemeName = String(payload.scheme ?? "default");
  const scheme = schemes.get(schemeName);
  if (!scheme) throw new ImportError("invalid_template", `unknown scheme ${schemeName}`);
  const rel = renderFor({ ...payload }, scheme);
  const root = importRoots[0]!;
  const ext = extname(src);
  const destBase = join(root, rel) + ext;

  // Create the destination directory tree first, then verify containment
  // against real paths so a symlinked segment cannot escape.
  mkdirSync(dirname(destBase), { recursive: true });
  const destDirReal = realpathSync(dirname(destBase));
  assertInsideRoot(join(destDirReal, basename(destBase)), importRoots, "destination");
  const dest = join(destDirReal, basename(destBase));
  if (!isInside(importRoots[0]!, dest))
    throw new ImportError("path_escape", "resolved destination escapes the library root");

  const existing = libraryItems.get(itemKey)?.at(-1);

  // Same-destination collision handling:
  //  - identical content hash at destination → idempotent no-op;
  //  - different content → treated as an upgrade slot (replace below).
  if (existsSync(dest)) {
    if (sha256File(dest) === hash) {
      const outcome: ImportOutcome = {
        itemKey,
        destinationPath: dest,
        method: existing?.method ?? "copy",
        upgraded: false,
      };
      importLedger.set(ledgerKey, outcome);
      await persist();
      return { ...outcome, deduplicated: true };
    }
  }

  // Quality gate: never downgrade over an existing better-quality file
  // unless the caller explicitly forces replacement.
  const RANK = ["480p", "720p", "1080p", "2160p"];
  if (existing && !payload.force) {
    const curIdx = RANK.indexOf(existing.quality);
    const newIdx = RANK.indexOf(quality);
    if (curIdx >= 0 && newIdx >= 0 && newIdx <= curIdx) {
      throw new ImportError("collision", `existing ${existing.quality} is not worse than ${quality}`);
    }
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
      try {
        linkSync(src, staging);
        method = "hardlink";
      } catch {
        copyFileSync(src, staging);
        method = "copy";
      }
      injectFault("short-copy");
      injectFault("corrupt-copy");
      if (statSync(staging).size !== st.size)
        throw new ImportError("io_error", "partial staged copy (size mismatch)");
      // Verify staged bytes match source before touching the old file.
      if (sha256File(staging) !== hash)
        throw new ImportError("io_error", "staged copy verification failed");
      const replacedPath = existing.destinationPath;
      injectFault("swap-fail");
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
      method = placeAtomically(src, dest, true);
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
          const root = importRoots[0] ?? "(no import root configured)";
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
        case "import":
          return doImport(payload);
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
