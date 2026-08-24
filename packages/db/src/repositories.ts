/**
 * Wave 3 (TAN-013/020/021): durable repositories for media state.
 *
 *  - PluginDocumentStore: JSON documents per (pluginId, key). This is the
 *    backing store for the supervisor storage bridge; plugins reach it ONLY
 *    through that bridge (they never see a DB handle).
 *  - LibraryRepository: core-owned library definitions. Removal NEVER
 *    deletes media files — deleting files requires a separate explicit
 *    confirmDeleteMedia step performed by LibraryService (TAN-020).
 *  - MediaCatalogRepository: durable fileId → path/import-identity records.
 *    Imports are idempotent on (sourceHash, destinationPath) enforced by a
 *    unique index; put() is an upsert so a re-import of identical content
 *    to the same destination is a no-op, not a duplicate row.
 *
 * Path containment and symlink safety are enforced by the service layer;
 * these repositories fail closed on obviously invalid rows (empty ids,
 * empty paths) but do not touch the filesystem themselves.
 */
import type { Kysely } from "kysely";
import type { Db, LibrariesTable, MediaCatalogTable, PluginDocumentsTable } from "./index.js";
import { uuidv7 } from "@tantalar/contracts";

// ---- Plugin document store ---------------------------------------------------

export class PluginDocumentStore {
  readonly #db: Kysely<Db>;
  constructor(db: Kysely<Db>) {
    this.#db = db;
  }

  async get(pluginId: string, docKey: string): Promise<{ doc: unknown; updatedAt: string } | null> {
    if (!pluginId || !docKey) throw new Error("pluginId and docKey required");
    const [row] = await this.#db
      .selectFrom("plugin_documents")
      .selectAll()
      .where("pluginId", "=", pluginId)
      .where("docKey", "=", docKey)
      .execute();
    if (!row) return null;
    // SQLite stores a JSON string; Postgres JSONB comes back already parsed.
    const doc = typeof row.doc === "string" ? (JSON.parse(row.doc) as unknown) : row.doc;
    return { doc, updatedAt: row.updatedAt };
  }

  async put(pluginId: string, docKey: string, doc: unknown): Promise<void> {
    if (!pluginId || !docKey) throw new Error("pluginId and docKey required");
    const serialized = JSON.stringify(doc ?? null);
    await this.#db
      .insertInto("plugin_documents")
      .values({
        pluginId,
        docKey,
        doc: serialized,
        updatedAt: new Date().toISOString(),
      })
      .onConflict((oc) =>
        oc.columns(["pluginId", "docKey"]).doUpdateSet({
          doc: serialized,
          updatedAt: new Date().toISOString(),
        }),
      )
      .execute();
  }

  async delete(pluginId: string, docKey: string): Promise<boolean> {
    const result = await this.#db
      .deleteFrom("plugin_documents")
      .where("pluginId", "=", pluginId)
      .where("docKey", "=", docKey)
      .executeTakeFirst();
    return Number(result?.numDeletedRows ?? 0) > 0;
  }
}

// ---- Library repository --------------------------------------------------------

export interface LibraryRecord {
  id: string;
  name: string;
  rootPath: string;
  kind: "series" | "movie" | "mixed";
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

function rowToLibrary(row: LibrariesTable): LibraryRecord {
  return {
    id: row.id,
    name: row.name,
    rootPath: row.rootPath,
    kind: row.kind,
    enabled: row.enabled === 1,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export class LibraryRepository {
  readonly #db: Kysely<Db>;
  constructor(db: Kysely<Db>) {
    this.#db = db;
  }

  async create(input: { name: string; rootPath: string; kind: "series" | "movie" | "mixed" }): Promise<LibraryRecord> {
    if (!input.name.trim()) throw new Error("library name required");
    if (!input.rootPath.trim()) throw new Error("library rootPath required");
    const now = new Date().toISOString();
    const row: LibrariesTable = {
      id: uuidv7(),
      name: input.name,
      rootPath: input.rootPath,
      kind: input.kind,
      enabled: 1,
      createdAt: now,
      updatedAt: now,
    };
    try {
      await this.#db.insertInto("libraries").values(row).execute();
    } catch (err) {
      if (String((err as Error).message).includes("UNIQUE") || (err as { code?: string }).code === "23505") {
        throw Object.assign(new Error(`a library named \"${input.name}\" already exists`), { statusCode: 409 });
      }
      throw err;
    }
    return rowToLibrary(row);
  }

  async list(): Promise<LibraryRecord[]> {
    const rows = await this.#db.selectFrom("libraries").selectAll().orderBy("createdAt asc").execute();
    return rows.map(rowToLibrary);
  }

  async get(id: string): Promise<LibraryRecord | null> {
    const [row] = await this.#db.selectFrom("libraries").selectAll().where("id", "=", id).execute();
    return row ? rowToLibrary(row) : null;
  }

  async update(
    id: string,
    patch: Partial<{ name: string; rootPath: string; kind: "series" | "movie" | "mixed"; enabled: boolean }>,
  ): Promise<LibraryRecord | null> {
    const updates: Partial<LibrariesTable> = { updatedAt: new Date().toISOString() };
    if (patch.name !== undefined) {
      if (!patch.name.trim()) throw new Error("library name required");
      updates.name = patch.name;
    }
    if (patch.rootPath !== undefined) {
      if (!patch.rootPath.trim()) throw new Error("library rootPath required");
      updates.rootPath = patch.rootPath;
    }
    if (patch.kind !== undefined) updates.kind = patch.kind;
    if (patch.enabled !== undefined) updates.enabled = patch.enabled ? 1 : 0;
    try {
      const result = await this.#db
        .updateTable("libraries")
        .set(updates)
        .where("id", "=", id)
        .executeTakeFirst();
      if (Number(result?.numUpdatedRows ?? 0) === 0) return null;
    } catch (err) {
      if (String((err as Error).message).includes("UNIQUE")) {
        throw Object.assign(new Error(`a library named \"${patch.name}\" already exists`), { statusCode: 409 });
      }
      throw err;
    }
    return this.get(id);
  }

  /**
   * Remove the library ROW only. Media files on disk are never touched here;
   * catalog rows cascade via FK where supported and the service layer owns
   * any explicit media deletion decision.
   */
  async remove(id: string): Promise<boolean> {
    // Delete catalog entries for this library first (SQLite lacks the FK
    // cascade we did not declare; explicit is safer than implicit).
    await this.#db.deleteFrom("media_catalog").where("libraryId", "=", id).execute();
    const result = await this.#db.deleteFrom("libraries").where("id", "=", id).executeTakeFirst();
    return Number(result?.numDeletedRows ?? 0) > 0;
  }

  /** Catalog paths recorded under this library (used by explicit media deletion). */
  async mediaPaths(id: string): Promise<string[]> {
    const rows = await this.#db
      .selectFrom("media_catalog")
      .select("path")
      .where("libraryId", "=", id)
      .execute();
    return rows.map((r) => r.path);
  }
}

// ---- Media catalog repository ----------------------------------------------------

export interface MediaCatalogRecord {
  fileId: string;
  libraryId: string;
  itemKey: string;
  path: string;
  quality: string;
  method: "hardlink" | "copy";
  sourceHash: string;
  importedAt: string;
  updatedAt: string;
}

function rowToCatalog(row: MediaCatalogTable): MediaCatalogRecord {
  return {
    fileId: row.fileId,
    libraryId: row.libraryId,
    itemKey: row.itemKey,
    path: row.path,
    quality: row.quality,
    method: row.method,
    sourceHash: row.sourceHash,
    importedAt: row.importedAt,
    updatedAt: row.updatedAt,
  };
}

export class MediaCatalogRepository {
  readonly #db: Kysely<Db>;
  constructor(db: Kysely<Db>) {
    this.#db = db;
  }

  async get(fileId: string): Promise<MediaCatalogRecord | null> {
    if (!fileId) throw new Error("fileId required");
    const [row] = await this.#db
      .selectFrom("media_catalog")
      .selectAll()
      .where("fileId", "=", fileId)
      .execute();
    return row ? rowToCatalog(row) : null;
  }

  async findByImportIdentity(sourceHash: string, destinationPath: string): Promise<MediaCatalogRecord | null> {
    if (!sourceHash || !destinationPath) throw new Error("sourceHash and destinationPath required");
    const [row] = await this.#db
      .selectFrom("media_catalog")
      .selectAll()
      .where("sourceHash", "=", sourceHash)
      .where("path", "=", destinationPath)
      .execute();
    return row ? rowToCatalog(row) : null;
  }

  async findByItemKey(itemKey: string): Promise<MediaCatalogRecord[]> {
    const rows = await this.#db
      .selectFrom("media_catalog")
      .selectAll()
      .where("itemKey", "=", itemKey)
      .orderBy("importedAt asc")
      .execute();
    return rows.map(rowToCatalog);
  }

  async listByLibrary(libraryId: string): Promise<MediaCatalogRecord[]> {
    const rows = await this.#db
      .selectFrom("media_catalog")
      .selectAll()
      .where("libraryId", "=", libraryId)
      .orderBy("importedAt asc")
      .execute();
    return rows.map(rowToCatalog);
  }

  /**
   * Idempotent upsert keyed by import identity (sourceHash + destination).
   * Returns { record, created }. When a row with the same identity already
   * exists the existing record is returned unchanged (created=false), so a
   * retried import can never duplicate durable state.
   */
  async put(input: {
    fileId?: string;
    libraryId: string;
    itemKey: string;
    path: string;
    quality: string;
    method: "hardlink" | "copy";
    sourceHash: string;
  }): Promise<{ record: MediaCatalogRecord; created: boolean }> {
    if (!input.libraryId || !input.itemKey || !input.path || !input.sourceHash)
      throw new Error("libraryId, itemKey, path and sourceHash required");
    const existing = await this.findByImportIdentity(input.sourceHash, input.path);
    if (existing) {
      // Same identity may legitimately update metadata (quality label),
      // but keep fileId and importedAt stable.
      await this.#db
        .updateTable("media_catalog")
        .set({ quality: input.quality, method: input.method, updatedAt: new Date().toISOString() })
        .where("fileId", "=", existing.fileId)
        .execute();
      const updated = await this.get(existing.fileId);
      return { record: updated ?? existing, created: false };
    }
    const now = new Date().toISOString();
    const row: MediaCatalogTable = {
      fileId: input.fileId ?? uuidv7(),
      libraryId: input.libraryId,
      itemKey: input.itemKey,
      path: input.path,
      quality: input.quality,
      method: input.method,
      sourceHash: input.sourceHash,
      importedAt: now,
      updatedAt: now,
    };
    try {
      await this.#db.insertInto("media_catalog").values(row).execute();
    } catch (err) {
      const msg = String((err as Error).message);
      if (msg.includes("UNIQUE") || (err as { code?: string }).code === "23505") {
        // Lost a race against a concurrent identical import: re-read.
        const winner = await this.findByImportIdentity(input.sourceHash, input.path);
        if (winner) return { record: winner, created: false };
      }
      throw err;
    }
    return { record: rowToCatalog(row), created: true };
  }

  async delete(fileId: string): Promise<boolean> {
    const result = await this.#db
      .deleteFrom("media_catalog")
      .where("fileId", "=", fileId)
      .executeTakeFirst();
    return Number(result?.numDeletedRows ?? 0) > 0;
  }
}
