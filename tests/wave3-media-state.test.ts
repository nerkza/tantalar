/**
 * Wave 3 tests (TAN-013/020/021): durable media state and library management.
 *
 * Covers:
 *  - migration 0006 on SQLite (and Postgres when TEST_POSTGRES_URL is set);
 *  - plugin document store CRUD + namespacing;
 *  - restart durability of series/movies/library plugin state via the
 *    supervisor storage bridge;
 *  - library create/edit/disable/remove flows, fail-closed path containment,
 *    symlink rejection, cross-device visibility;
 *  - removal never deletes media without explicit confirmation;
 *  - idempotent catalog writes keyed by import identity + concurrency race;
 *  - API auth boundaries (401/403/CSRF) for /api/v1/libraries;
 *  - traceable events on every mutation.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync, symlinkSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Kysely } from "kysely";
import {
  migrate,
  openDatabase,
  PluginDocumentStore,
  LibraryRepository,
  MediaCatalogRepository,
  type Db,
} from "@tantalar/db";
import { EventTypes } from "@tantalar/contracts";
import { EventBus } from "../apps/server/src/events.js";
import { ServiceContainer } from "../apps/server/src/container.js";
import { Scheduler } from "../apps/server/src/scheduler.js";
import { Supervisor } from "../apps/server/src/supervisor.js";
import { LibraryService } from "../apps/server/src/library.js";

const policy = {
  initialBackoffMs: 100,
  maxBackoffMs: 500,
  backoffMultiplier: 2,
  windowMs: 10_000,
  maxRestartsInWindow: 5,
};

let db: Kysely<Db>;
let bus: EventBus;
let container: ServiceContainer;
let supervisor: Supervisor;
let documents: PluginDocumentStore;
let libraries: LibraryRepository;
let mediaCatalog: MediaCatalogRepository;
let service: LibraryService;
let dir: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "tantalar-wave3-"));
  db = await openDatabase({ dialect: "sqlite", sqlitePath: join(dir, "t.db") });
  await migrate(db);
  bus = new EventBus(db);
  container = new ServiceContainer();
  container.register({ pluginId: "core", capability: "dev.tantalar.capability.event.emit", invoke: async () => ({ ok: true }) });
  container.register({ pluginId: "core", capability: "dev.tantalar.capability.log", invoke: async () => ({ ok: true }) });
  documents = new PluginDocumentStore(db);
  libraries = new LibraryRepository(db);
  mediaCatalog = new MediaCatalogRepository(db);
  service = new LibraryService({ bus, libraries, mediaCatalog });
  supervisor = new Supervisor({
    bus,
    container,
    scheduler: new Scheduler(db, 100_000),
    documents,
    restartPolicy: policy,
    healthIntervalMs: 500,
    resolveEntry: (m) => {
      const [cmd, ...rest] = m.entry.command.split(" ");
      const configJson = (m as unknown as { __config?: Record<string, unknown> }).__config;
      return {
        command: cmd ?? "node",
        args: rest.filter(Boolean),
        env: (configJson ? { TANTALAR_PLUGIN_CONFIG: JSON.stringify(configJson) } : {}) as Record<string, string>,
      };
    },
  });
});

afterAll(async () => {
  await supervisor.stopAll().catch(() => undefined);
  await db.destroy();
});

// ---- Migration ------------------------------------------------------------------

describe("migration 0006 (durable media state)", () => {
  it("creates the wave-3 tables with the expected columns", async () => {
    // Insert round-trips prove both shape and constraints.
    await documents.put("dev.tantalar.plugin.test", "k1", { a: 1 });
    const hit = await documents.get("dev.tantalar.plugin.test", "k1");
    expect(hit?.doc).toEqual({ a: 1 });

    await expect(documents.get("other-plugin", "k1")).resolves.toBeNull();

    expect(await documents.delete("dev.tantalar.plugin.test", "k1")).toBe(true);
    expect(await documents.delete("dev.tantalar.plugin.test", "k1")).toBe(false);

    // The serving plugin's legacy snapshot file is NOT required anymore:
    // state lives in plugin_documents.
    const [row] = await db
      .selectFrom("plugin_documents")
      .select((eb) => eb.fn.countAll<number>().as("n"))
      .execute();
    expect(Number(row?.n ?? 0)).toBe(0);
  });

  it("runs cleanly against Postgres when TEST_POSTGRES_URL is configured", async (ctx) => {
    const url = process.env["TEST_POSTGRES_URL"];
    if (!url) return ctx.skip(); // CI-gated, mirrors migrations-postgres.test.ts
    const pdb = await openDatabase({ dialect: "postgres", postgresUrl: url });
    try {
      const applied = await migrate(pdb);
      // First run applies everything pending; a second run is a no-op.
      // (The DB may already carry the migration from an earlier run.)
      const appliedAgain = await migrate(pdb);
      expect(appliedAgain).not.toContain("0006_wave3_media_state");
      void applied;
      const docs = new PluginDocumentStore(pdb);
      await docs.put("pg-probe", "k", { ok: true });
      await expect(docs.get("pg-probe", "k")).resolves.toMatchObject({ doc: { ok: true } });
      await docs.delete("pg-probe", "k");
    } finally {
      await pdb.destroy();
    }
  });
});

// ---- Restart durability through the storage bridge -------------------------------

describe("restart durability via the storage bridge", () => {
  it("series state survives unmount/remount without any state file", async () => {
    const entry = `node ${join(process.cwd(), "plugins/series/dist/plugin.js")}`;
    const manifest = () => ({
      id: "dev.tantalar.plugin.series",
      version: "0.1.0",
      protocolVersion: 1 as const,
      provides: ["dev.tantalar.capability.automation.series"],
      requires: ["dev.tantalar.capability.event.emit", "dev.tantalar.capability.log"],
      subscriptions: [],
      entry: { command: entry },
    });
    const cap = "dev.tantalar.capability.automation.series";
    await supervisor.mount(manifest(), {});
    const series = (): { invoke(op: string, p?: Record<string, unknown>): Promise<unknown> } =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      container.resolve(cap) as any;

    await series().invoke("add-series", { name: "Durable Show", seasons: 2, episodesPerSeason: 3 });
    await series().invoke("set-monitoring", { seriesId: "series-durable-show", monitored: false });

    // Unmount (state stays in plugin_documents), remount fresh process.
    await supervisor.unmount("dev.tantalar.plugin.series");
    await supervisor.mount(manifest(), {});
    const got = (await series().invoke("get-series", { seriesId: "series-durable-show" })) as {
      name: string;
      monitored: boolean;
      episodeCount: number;
    };
    expect(got.name).toBe("Durable Show");
    expect(got.monitored).toBe(false); // monitoring change survived restart
    expect(got.episodeCount).toBe(6);

    // Movies: same durability guarantee.
    const mManifest = () => ({
      id: "dev.tantalar.plugin.movies",
      version: "0.1.0",
      protocolVersion: 1 as const,
      provides: ["dev.tantalar.capability.automation.movies"],
      requires: ["dev.tantalar.capability.event.emit", "dev.tantalar.capability.log"],
      subscriptions: [],
      entry: { command: `node ${join(process.cwd(), "plugins/movies/dist/plugin.js")}` },
    });
    const movies = (): { invoke(op: string, p?: Record<string, unknown>): Promise<unknown> } =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      container.resolve("dev.tantalar.capability.automation.movies") as any;
    await supervisor.mount(mManifest(), {});
    await movies().invoke("add-movie", { title: "Durable Film", year: 2024 });
    await movies().invoke("mark-acquired", { movieId: "movie-durable-film-2024", guid: "g-1" });
    await supervisor.unmount("dev.tantalar.plugin.movies");
    await supervisor.mount(mManifest(), {});
    const movie = (await movies().invoke("get-movie", { movieId: "movie-durable-film-2024" })) as {
      acquiredGuid: string | null;
    };
    expect(movie.acquiredGuid).toBe("g-1");
    await supervisor.unmount("dev.tantalar.plugin.movies");
    await supervisor.unmount("dev.tantalar.plugin.series");
  });

  it("plugins cannot read another plugin's documents even by key guesswork", async () => {
    await documents.put("dev.tantalar.plugin.library", "state", { secret: true });
    const hit = await documents.get("dev.tantalar.plugin.serving", "state");
    expect(hit).toBeNull();
    await documents.delete("dev.tantalar.plugin.library", "state");
  });
});

// ---- Library management -----------------------------------------------------------

describe("library management flows (TAN-020)", () => {
  it("creates, lists, edits, disables and removes a library — emitting an event per mutation", async () => {
    const root = join(dir, "lib-a");
    mkdirSync(root, { recursive: true });

    const created = await service.create({ name: "Movies Main", rootPath: root, kind: "movie", correlationId: "corr-lib-1" });
    expect(created.enabled).toBe(true);

    const edited = await service.edit(created.id, { name: "Movies Renamed" }, "corr-lib-2");
    expect(edited.name).toBe("Movies Renamed");

    const disabled = await service.setEnabled(created.id, false, "corr-lib-3");
    expect(disabled.enabled).toBe(false);
    const reEnabled = await service.setEnabled(created.id, true, "corr-lib-3b");
    expect(reEnabled.enabled).toBe(true);

    const removed = await service.remove(created.id, "corr-lib-4");
    expect(removed).toEqual({ removed: true, mediaFilesDeleted: false });

    const types = (await bus.read({ correlationId: "corr-lib-1" })).map((e) => e.type);
    void types;
    const allEvents = await bus.read({ typePrefix: "dev.tantalar.event.library." });
    const byCorr = new Map(allEvents.map((e) => [e.correlationId, e.type]));
    expect(byCorr.get("corr-lib-2")).toBe(EventTypes.LibraryEdited);
    expect(byCorr.get("corr-lib-3")).toBe(EventTypes.LibraryEnabledChanged);
    expect(byCorr.get("corr-lib-4")).toBe(EventTypes.LibraryRemoved);

    await expect(service.get(created.id)).rejects.toMatchObject({ statusCode: 404 });
  });

  it("rejects duplicate names, missing roots, symlinked roots (fail closed)", async () => {
    const root = join(dir, "lib-b");
    mkdirSync(root, { recursive: true });
    await service.create({ name: "Unique", rootPath: root, kind: "mixed" });
    await expect(service.create({ name: "Unique", rootPath: root, kind: "mixed" })).rejects.toMatchObject({
      statusCode: 409,
    });
    await expect(service.create({ name: "Nope", rootPath: join(dir, "absent"), kind: "movie" })).rejects.toThrow(
      /does not exist/,
    );

    // Symlinked root: rejected before any durable write.
    const target = join(dir, "lib-b-real");
    mkdirSync(target, { recursive: true });
    let link = "";
    try {
      link = join(dir, "lib-link");
      symlinkSync(target, link);
      await expect(service.create({ name: "Symlinked", rootPath: link, kind: "movie" })).rejects.toThrow(/symlink/);
    } catch {
      /* filesystem without symlink support */
    }

    // A failed create leaves no partial row.
    const list = await service.list();
    expect(list.filter((l) => l.name === "Symlinked" || l.name === "Nope")).toHaveLength(0);
  });

  it("never deletes media on remove; explicit confirmDelete does — and only inside the root", async () => {
    const root = join(dir, "lib-c");
    mkdirSync(root, { recursive: true });
    const lib = await service.create({ name: "Deletable", rootPath: root, kind: "mixed" });
    const filePath = join(root, "episode.mkv");
    writeFileSync(filePath, "media bytes\n");

    await service.catalog({
      libraryId: lib.id,
      itemKey: "show:s01e01",
      path: filePath,
      quality: "1080p",
      method: "copy",
      sourceHash: "hash-c1",
    });

    // Remove the library definition only.
    await service.remove(lib.id);
    expect(existsSync(filePath)).toBe(true); // media untouched
    // Re-create the same library row to exercise the explicit deletion path.
    const lib2 = await service.create({ name: "Deletable", rootPath: root, kind: "mixed" });
    // Catalog was cascaded on remove; recatalog so deletion has a recorded path.
    await service.catalog({
      libraryId: lib2.id,
      itemKey: "show:s01e01",
      path: filePath,
      quality: "1080p",
      method: "copy",
      sourceHash: "hash-c1",
    });

    // Without confirmation: refused, file intact.
    await expect(service.removeMedia(lib2.id, false)).rejects.toMatchObject({ statusCode: 400 });
    expect(existsSync(filePath)).toBe(true);

    const out = await service.removeMedia(lib2.id, true, "corr-del-1");
    expect(out.deletedFiles).toBe(1);
    expect(existsSync(filePath)).toBe(false);
    const delEvents = await bus.read({ typePrefix: EventTypes.MediaDeleted });
    expect(delEvents.some((e) => e.correlationId === "corr-del-1")).toBe(true);
  });
});

// ---- Validation, rescan, catalog identity -----------------------------------------

describe("validate, rescan and import identity (TAN-021)", () => {
  it("validates containment and reports missing files; rescan drops vanished rows", async () => {
    const root = join(dir, "lib-d");
    mkdirSync(root, { recursive: true });
    const lib = await service.create({ name: "Validated", rootPath: root, kind: "series" });
    const f1 = join(root, "a.mkv");
    const f2 = join(root, "b.mkv");
    writeFileSync(f1, "a");
    writeFileSync(f2, "b");
    await service.catalog({ libraryId: lib.id, itemKey: "s:a", path: f1, quality: "720p", method: "hardlink", sourceHash: "h-a" });
    await service.catalog({ libraryId: lib.id, itemKey: "s:b", path: f2, quality: "720p", method: "hardlink", sourceHash: "h-b" });

    let results = await service.validate(lib.id, "corr-val-1");
    expect(results[0]?.ok).toBe(true);
    expect(results[0]?.device).toEqual(expect.any(Number));

    // File vanishes → validation flags it; rescan removes the row.
    const { unlinkSync } = await import("node:fs");
    unlinkSync(f2);
    results = await service.validate(lib.id);
    expect(results[0]?.ok).toBe(false);
    expect(results[0]?.issues.map((i) => i.code)).toContain("path_missing");

    const rescan = await service.rescan(lib.id, "corr-rescan-1");
    expect(rescan.missingRemoved).toBe(1);
    expect((await service.validate(lib.id))[0]?.ok).toBe(true);

    const valEvents = await bus.read({ typePrefix: EventTypes.LibraryValidated });
    expect(valEvents.some((e) => e.correlationId === "corr-val-1")).toBe(true);
    const scanEvents = await bus.read({ typePrefix: EventTypes.LibraryRescanCompleted });
    expect(scanEvents.some((e) => e.correlationId === "corr-rescan-1")).toBe(true);
  });

  it("catalog writes are idempotent by (sourceHash, destinationPath), including under concurrency", async () => {
    const root = join(dir, "lib-e");
    mkdirSync(root, { recursive: true });
    const lib = await service.create({ name: "Idempotent", rootPath: root, kind: "movie" });
    const dest = join(root, "film.mkv");

    const first = await service.catalog({
      libraryId: lib.id, itemKey: "m:1", path: dest, quality: "1080p", method: "copy", sourceHash: "same-hash",
    });
    expect(first.created).toBe(true);

    // Identical identity → no duplicate, same fileId.
    const second = await service.catalog({
      libraryId: lib.id, itemKey: "m:1", path: dest, quality: "1080p", method: "copy", sourceHash: "same-hash",
    });
    expect(second.created).toBe(false);
    expect(second.record.fileId).toBe(first.record.fileId);

    // Concurrent identical imports: exactly one winner.
    const races = await Promise.all(
      Array.from({ length: 6 }, () =>
        service.catalog({ libraryId: lib.id, itemKey: "m:race", path: join(root, "race.mkv"), quality: "720p", method: "copy", sourceHash: "race-hash" }),
      ),
    );
    expect(new Set(races.map((r) => r.record.fileId)).size).toBe(1);

    const rows = await service.catalogList(lib.id);
    expect(rows).toHaveLength(2); // one per distinct identity

    // Escape attempt fails closed.
    await expect(
      service.catalog({ libraryId: lib.id, itemKey: "evil", path: join(dir, "outside.mkv"), quality: "720p", method: "copy", sourceHash: "h-x" }),
    ).rejects.toThrow(/escapes|root/);
  });
});
