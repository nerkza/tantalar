/**
 * Wave 3 (TAN-020/021): core library management service.
 *
 * Locked decisions implemented here:
 *  - library removal NEVER deletes media files; deleting files requires the
 *    separate explicit `confirmDeleteMedia` call (removeMedia);
 *  - path containment and symlink safety fail closed: a root that resolves
 *    through a symlink, or a path escaping its root, is rejected;
 *  - cross-device copy/move behavior is explicit: validate() reports the
 *    filesystem identity (st_dev) of each root so operators can see which
 *    libraries live on another device from their import roots;
 *  - every mutation emits a traceable event with correlationId support;
 *  - catalog writes are idempotent by (sourceHash, destinationPath).
 */
import { realpathSync, statSync, existsSync, unlinkSync } from "node:fs";
import { lstat, readdir, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import { extname, isAbsolute, join, relative, sep, resolve as pathResolve } from "node:path";
import { EventTypes } from "@tantalar/contracts";
import {
  LibraryRepository,
  MediaCatalogRepository,
  type LibraryRecord,
  type MediaCatalogRecord,
} from "@tantalar/db";
import type { EventBus } from "./events.js";

export class LibraryError extends Error {
  readonly statusCode: number;
  constructor(message: string, statusCode: number) {
    super(message);
    this.statusCode = statusCode;
    this.name = "LibraryError";
  }
}

function httpError(message: string, statusCode: number): Error {
  return Object.assign(new Error(message), { statusCode });
}

/** True when `child` (already resolved) sits inside `root` (already real). */
function isInside(root: string, child: string): boolean {
  return child === root || child.startsWith(root + sep);
}

export interface ValidationIssue {
  readonly code:
    | "root_missing"
    | "root_not_directory"
    | "root_symlink"
    | "path_missing"
    | "path_escape"
    | "cross_device";
  readonly detail: string;
}

export interface ValidationResult {
  readonly library: LibraryRecord;
  readonly ok: boolean;
  readonly issues: ValidationIssue[];
  /** st_dev of the library root, when it exists — cross-device visibility. */
  readonly device?: number;
}

export interface LibraryServiceOptions {
  bus: EventBus;
  libraries: LibraryRepository;
  mediaCatalog: MediaCatalogRepository;
  onCatalogUpsert?: (record: MediaCatalogRecord, library: LibraryRecord) => Promise<void>;
  onCatalogRemove?: (fileId: string) => Promise<void>;
}

export interface LibraryScanResult {
  readonly checked: number;
  readonly discovered: number;
  readonly existing: number;
  readonly missingRemoved: number;
  readonly skipped: number;
  readonly errors: string[];
}

const VIDEO_EXTENSIONS = new Set([
  ".avi", ".flv", ".m2ts", ".m4v", ".mkv", ".mov", ".mp4", ".mpeg", ".mpg", ".ts", ".webm", ".wmv",
]);

export class LibraryService {
  readonly #busy = new Set<string>();
  async exclusive<T>(id: string, work: () => Promise<T>): Promise<T> {
    if (this.#busy.has(id)) throw new LibraryError("Library file work is already running. Retry after it finishes.", 409);
    this.#busy.add(id);
    try { return await work(); } finally { this.#busy.delete(id); }
  }
  readonly #bus: EventBus;
  readonly #libraries: LibraryRepository;
  readonly #mediaCatalog: MediaCatalogRepository;
  readonly #onCatalogUpsert?: LibraryServiceOptions["onCatalogUpsert"];
  readonly #onCatalogRemove?: LibraryServiceOptions["onCatalogRemove"];

  constructor(opts: LibraryServiceOptions) {
    this.#bus = opts.bus;
    this.#libraries = opts.libraries;
    this.#mediaCatalog = opts.mediaCatalog;
    this.#onCatalogUpsert = opts.onCatalogUpsert;
    this.#onCatalogRemove = opts.onCatalogRemove;
  }

  async refreshCatalogEntry(fileId: string): Promise<void> {
    const record = await this.#mediaCatalog.get(fileId);
    if (!record) throw new LibraryError("Catalog file not found.", 404);
    const library = await this.get(record.libraryId);
    await this.#onCatalogUpsert?.(record, library);
  }

  async #emit(type: string, payload: Record<string, unknown>, correlationId?: string): Promise<void> {
    await this.#bus.publish({
      type,
      producer: "core",
      payload,
      ...(correlationId !== undefined ? { correlationId } : {}),
    });
  }

  /**
   * Fail-closed root resolution: the configured root must already exist as a
   * real directory and must NOT be (or pass through) a symlink.
   */
  static resolveRoot(rootPath: string): string {
    if (!isAbsolute(rootPath)) {
      throw new LibraryError("library root must be an absolute path", 400);
    }
    const abs = pathResolve(rootPath);
    if (!existsSync(abs)) throw new LibraryError(`library root does not exist: ${abs}`, 400);
    if (!statSync(abs).isDirectory()) throw new LibraryError(`library root is not a directory: ${abs}`, 400);
    let real: string;
    try {
      real = realpathSync(abs);
    } catch {
      throw new LibraryError(`library root cannot be resolved: ${abs}`, 400);
    }
    if (real !== abs) throw new LibraryError(`library root must not be a symlink: ${abs}`, 400);
    return real;
  }

  async create(input: {
    name: string;
    rootPath: string;
    kind: "series" | "movie" | "mixed";
    correlationId?: string;
  }): Promise<LibraryRecord> {
    if (!["series", "movie", "mixed"].includes(input.kind)) {
      throw new LibraryError("kind must be series, movie or mixed", 400);
    }
    // Fail closed BEFORE any durable write: an unusable root never becomes
    // a library row.
    const realRoot = LibraryService.resolveRoot(input.rootPath);
    let record: LibraryRecord;
    try {
      record = await this.#libraries.create({ name: input.name.trim(), rootPath: realRoot, kind: input.kind });
    } catch (err) {
      if ((err as { statusCode?: number }).statusCode === 409)
        throw new LibraryError((err as Error).message, 409);
      throw err;
    }
    await this.#emit(
      EventTypes.LibraryCreated,
      { libraryId: record.id, name: record.name, rootPath: record.rootPath, kind: record.kind },
      input.correlationId,
    );
    return record;
  }

  async list(): Promise<LibraryRecord[]> {
    return this.#libraries.list();
  }

  async get(id: string): Promise<LibraryRecord> {
    const rec = await this.#libraries.get(id);
    if (!rec) throw httpError("unknown library", 404);
    return rec;
  }

  async edit(
    id: string,
    patch: Partial<{ name: string; rootPath: string; kind: "series" | "movie" | "mixed" }>,
    correlationId?: string,
  ): Promise<LibraryRecord> {
    const existing = await this.get(id);
    if (patch.rootPath !== undefined) patch = { ...patch, rootPath: LibraryService.resolveRoot(patch.rootPath) };
    let updated: LibraryRecord | null;
    try {
      updated = await this.#libraries.update(id, patch);
    } catch (err) {
      if ((err as { statusCode?: number }).statusCode === 409)
        throw new LibraryError((err as Error).message, 409);
      throw err;
    }
    if (!updated) throw httpError("unknown library", 404);
    await this.#emit(
      EventTypes.LibraryEdited,
      { libraryId: id, changedFields: Object.keys(patch), previousRootPath: existing.rootPath },
      correlationId,
    );
    return updated;
  }

  async setEnabled(id: string, enabled: boolean, correlationId?: string): Promise<LibraryRecord> {
    await this.get(id);
    const updated = await this.#libraries.update(id, { enabled });
    if (!updated) throw httpError("unknown library", 404);
    await this.#emit(
      EventTypes.LibraryEnabledChanged,
      { libraryId: id, enabled },
      correlationId,
    );
    return updated;
  }

  /**
   * Remove the library definition. Media files are NEVER touched here —
   * deleting files requires removeMedia(confirmDelete=true) as a separate,
   * explicit step. The event payload states this explicitly for auditability.
   */
  async remove(id: string, correlationId?: string): Promise<{ removed: true; mediaFilesDeleted: false }> {
    await this.get(id);
    const catalog = await this.#mediaCatalog.listByLibrary(id);
    await this.#libraries.remove(id); // cascades catalog rows only
    for (const row of catalog) await this.#onCatalogRemove?.(row.fileId);
    await this.#emit(EventTypes.LibraryRemoved, { libraryId: id, mediaFilesDeleted: false }, correlationId);
    return { removed: true, mediaFilesDeleted: false };
  }

  /**
   * Explicit media deletion. Requires confirmDelete=true; refuses to delete
   * anything outside the library's recorded root (fail closed on escape).
   */
  async removeMedia(libraryId: string, confirmDelete: boolean, correlationId?: string): Promise<{ deletedFiles: number }> {
    const library = await this.get(libraryId);
    if (!confirmDelete) {
      throw new LibraryError(
        "deleting media requires explicit confirmation (confirmDelete: true); removing the library alone never deletes files",
        400,
      );
    }
    const paths = await this.#libraries.mediaPaths(libraryId);
    let deleted = 0;
    for (const p of paths) {
      const abs = pathResolve(p);
      if (!isInside(pathResolve(library.rootPath), abs)) continue; // fail closed
      try {
        if (existsSync(abs)) {
          unlinkSync(abs);
          deleted += 1;
        }
      } catch {
        /* unreadable/already-gone file: keep going, report the count */
      }
    }
    await this.#emit(EventTypes.MediaDeleted, { libraryId, deletedFiles: deleted }, correlationId);
    return { deletedFiles: deleted };
  }

  /** Validate one library (or all when id omitted): containment + existence + device. */
  async validate(id?: string, correlationId?: string): Promise<ValidationResult[]> {
    const targets = id ? [await this.get(id)] : await this.#libraries.list();
    const out: ValidationResult[] = [];
    for (const lib of targets) {
      const issues: ValidationIssue[] = [];
      let device: number | undefined;
      const abs = pathResolve(lib.rootPath);
      if (!existsSync(abs)) {
        issues.push({ code: "root_missing", detail: `root does not exist: ${abs}` });
      } else {
        if (!statSync(abs).isDirectory()) issues.push({ code: "root_not_directory", detail: abs });
        try {
          const real = realpathSync(abs);
          if (real !== abs) issues.push({ code: "root_symlink", detail: `${abs} -> ${real}` });
          device = statSync(real).dev;
          // Catalog containment re-check.
          for (const m of await this.#mediaCatalog.listByLibrary(lib.id)) {
            const mp = pathResolve(m.path);
            if (!isInside(real, mp)) {
              issues.push({ code: "path_escape", detail: `${m.fileId}: ${mp} outside ${real}` });
              continue;
            }
            if (!existsSync(mp)) issues.push({ code: "path_missing", detail: `${m.fileId}: ${mp}` });
          }
        } catch {
          issues.push({ code: "root_missing", detail: `root cannot be resolved: ${abs}` });
        }
      }
      const result: ValidationResult = {
        library: lib,
        ok: issues.length === 0,
        issues,
        ...(device !== undefined ? { device } : {}),
      };
      out.push(result);
      await this.#emit(
        EventTypes.LibraryValidated,
        { libraryId: lib.id, ok: result.ok, issueCodes: issues.map((i) => i.code) },
        correlationId,
      );
    }
    return out;
  }

  /** Discover supported videos recursively, without following symlinks. */
  async rescan(id: string, correlationId?: string): Promise<LibraryScanResult> {
    return this.exclusive(id, () => this.#rescan(id, correlationId));
  }

  async #rescan(id: string, correlationId?: string): Promise<LibraryScanResult> {
    const lib = await this.get(id);
    const root = LibraryService.resolveRoot(lib.rootPath);
    const rows = await this.#mediaCatalog.listByLibrary(lib.id);
    const byPath = new Map(rows.map((row) => [pathResolve(row.path), row]));
    const files: string[] = [];
    const errors: string[] = [];
    let skipped = 0;

    const walk = async (directory: string): Promise<void> => {
      let entries;
      try {
        entries = await readdir(directory, { withFileTypes: true });
      } catch (err) {
        errors.push(`${relative(root, directory) || "."}: ${(err as Error).message}`);
        return;
      }
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        if (entry.name === ".tantalar-recycle") { skipped++; continue; }
        const candidate = join(directory, entry.name);
        try {
          const info = await lstat(candidate);
          if (info.isSymbolicLink()) {
            skipped += 1;
          } else if (info.isDirectory()) {
            const realDirectory = await realpath(candidate);
            if (isInside(root, realDirectory)) await walk(realDirectory);
            else skipped += 1;
          } else if (info.isFile() && VIDEO_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
            const realFile = await realpath(candidate);
            if (isInside(root, realFile)) files.push(realFile);
            else skipped += 1;
          } else {
            skipped += 1;
          }
        } catch (err) {
          errors.push(`${relative(root, candidate)}: ${(err as Error).message}`);
        }
      }
    };

    await walk(root);
    let missingRemoved = 0;
    for (const row of rows) {
      try {
        await lstat(pathResolve(row.path));
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
          errors.push(`${relative(root, row.path)}: ${(err as Error).message}`);
          continue;
        }
        await this.#mediaCatalog.delete(row.fileId);
        try {
          await this.#onCatalogRemove?.(row.fileId);
        } catch (hookError) {
          errors.push(`${relative(root, row.path)}: ${(hookError as Error).message}`);
        }
        missingRemoved += 1;
      }
    }

    let discovered = 0;
    let existing = 0;
    for (const path of files) {
      const current = byPath.get(path);
      if (current) {
        existing += 1;
        try {
          await this.#onCatalogUpsert?.(current, lib);
        } catch (err) {
          errors.push(`${relative(root, path)}: ${(err as Error).message}`);
        }
        continue;
      }
      const relativePath = relative(root, path).split(sep).join("/");
      const identity = createHash("sha256")
        .update(`existing\0${lib.id}\0${relativePath}`)
        .digest("hex");
      const out = await this.#mediaCatalog.put({
        fileId: `existing:${identity}`,
        libraryId: lib.id,
        itemKey: `existing:${identity}`,
        path,
        quality: "unknown",
        method: "existing",
        sourceHash: identity,
      });
      if (out.created) discovered += 1;
      else existing += 1;
      try {
        await this.#onCatalogUpsert?.(out.record, lib);
      } catch (err) {
        errors.push(`${relativePath}: ${(err as Error).message}`);
      }
    }
    const result: LibraryScanResult = {
      checked: files.length,
      discovered,
      existing,
      missingRemoved,
      skipped,
      errors,
    };
    await this.#emit(
      EventTypes.LibraryRescanCompleted,
      { libraryId: lib.id, ...result },
      correlationId,
    );
    return result;
  }

  /** Free space on the library root's filesystem (bytes available). */
  freeSpace(id: string): { availableBytes: number | null } {
    // Node has no portable statvfs; report null rather than guess.
    void id;
    return { availableBytes: null };
  }

  /** Durable catalog upsert keyed by import identity (idempotent imports). */
  async catalog(input: {
    libraryId: string;
    itemKey: string;
    path: string;
    quality: string;
    method: "hardlink" | "copy" | "existing";
    sourceHash: string;
    fileId?: string;
    correlationId?: string;
  }): Promise<{ record: MediaCatalogRecord; created: boolean }> {
    const lib = await this.get(input.libraryId);
    // Fail closed on escape before any write.
    const realRoot = realpathSync(lib.rootPath);
    const abs = pathResolve(input.path);
    if (!isInside(realRoot, abs)) throw new LibraryError("destination escapes the library root", 400);
    const out = await this.#mediaCatalog.put({
      fileId: input.fileId,
      libraryId: lib.id,
      itemKey: input.itemKey,
      path: abs,
      quality: input.quality,
      method: input.method,
      sourceHash: input.sourceHash,
    });
    if (out.created) {
      await this.#emit(
        EventTypes.MediaCataloged,
        { fileId: out.record.fileId, libraryId: lib.id, itemKey: input.itemKey, path: out.record.path },
        input.correlationId,
      );
    }
    await this.#onCatalogUpsert?.(out.record, lib);
    return out;
  }

  async catalogList(libraryId?: string): Promise<MediaCatalogRecord[]> {
    return libraryId ? this.#mediaCatalog.listByLibrary(libraryId) : this.list().then(async (libs) => {
      const all: MediaCatalogRecord[] = [];
      for (const l of libs) all.push(...(await this.#mediaCatalog.listByLibrary(l.id)));
      return all;
    });
  }
}
