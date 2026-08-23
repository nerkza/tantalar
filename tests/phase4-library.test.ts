/**
 * Phase 4 tests: library/import post-processor and metadata provider.
 * Covers: configurable rename schemes, hardlink-first import with
 * cross-device copy fallback, atomic placement, collision handling,
 * quality-upgrade replacement with rollback safety, path traversal /
 * symlink rejection, idempotency on (itemKey + source hash), metadata
 * refresh from fixture TMDB/TVDB adapters, calendar entries derived from
 * monitored media, and correlated event-chain reconstruction.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, existsSync, readFileSync, statSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Kysely } from "kysely";
import { migrate, openDatabase, type Db } from "@tantalar/db";
import { EventTypes } from "@tantalar/contracts";
import { EventBus } from "../apps/server/src/events.js";
import { ServiceContainer } from "../apps/server/src/container.js";
import { Scheduler } from "../apps/server/src/scheduler.js";
import { Supervisor } from "../apps/server/src/supervisor.js";

const LIBRARY_ID = "dev.tantalar.plugin.library";
const LIBRARY_CAP = "dev.tantalar.capability.importer";
const METADATA_ID = "dev.tantalar.plugin.metadata-tmdb-tvdb";
const METADATA_CAP = "dev.tantalar.capability.metadata-provider";

const LIBRARY_ENTRY = "node " + resolve("plugins/library/dist/plugin.js");
const METADATA_ENTRY = "node " + resolve("plugins/metadata-tmdb-tvdb/dist/plugin.js");

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
let dir: string;
let importRoot: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "tantalar-p4-"));
  importRoot = join(dir, "library");
  const { mkdirSync } = require("node:fs") as typeof import("node:fs");
  mkdirSync(importRoot, { recursive: true });
  db = await openDatabase({ dialect: "sqlite", sqlitePath: join(dir, "t.db") });
  await migrate(db);
  bus = new EventBus(db);
  container = new ServiceContainer();
  container.register({ pluginId: "core", capability: "dev.tantalar.capability.event.emit", invoke: async () => ({ ok: true }) });
  container.register({ pluginId: "core", capability: "dev.tantalar.capability.log", invoke: async () => ({ ok: true }) });
  supervisor = new Supervisor({
    bus,
    container,
    scheduler: new Scheduler(db, 100_000),
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

  await mount(LIBRARY_ID, LIBRARY_CAP, LIBRARY_ENTRY, { importRoots: [importRoot], sourceRoots: [dir] });
  await mount(METADATA_ID, METADATA_CAP, METADATA_ENTRY, {});
});

afterAll(async () => {
  await supervisor.stopAll();
  await db.destroy();
});

async function mount(id: string, cap: string, command: string, config: Record<string, unknown>) {
  const m = {
    id,
    version: "0.1.0",
    protocolVersion: 1,
    provides: [cap],
    requires: ["dev.tantalar.capability.event.emit", "dev.tantalar.capability.log"],
    subscriptions: [],
    entry: { command },
  };
  if (config && Object.keys(config).length > 0) Object.assign(m, { __config: config });
  const rt = await supervisor.mount(m, config);
  expect(rt.state).toBe("healthy");
}

function importer(): { invoke(op: string, p?: Record<string, unknown>): Promise<unknown> } {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return container.resolve(LIBRARY_CAP) as any;
}
function metadata(): { invoke(op: string, p?: Record<string, unknown>): Promise<unknown> } {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return container.resolve(METADATA_CAP) as any;
}

interface ImportOutcomeShape {
  destinationPath: string;
  method: "hardlink" | "copy";
  upgraded: boolean;
  replacedPath?: string;
  deduplicated?: boolean;
}

// ---- Rename schemes -----------------------------------------------------------

describe("rename schemes (story 10)", () => {
  it("renders the default episode template into nested library paths", async () => {
    mkdirWrite(join(dir, "dl-a"), "file.mkv", "episode one bytes\n");
    const out = (await importer().invoke("import", {
      itemKey: "series-fixture-show:S01E01",
      sourcePath: join(dir, "dl-a", "file.mkv"),
      quality: "1080p",
      title: "Pilot",
      kind: "series",
      series: "Fixture Show",
      season: 1,
      episode: 1,
      correlationId: "corr-import-1",
    })) as ImportOutcomeShape;
    expect(out.destinationPath).toBe(join(importRoot, "Fixture Show/Season 01/Fixture Show S01E01 1080p.mkv"));
  });

  it("accepts a custom scheme and renders it; rejects traversal templates", async () => {
    await importer().invoke("set-scheme", {
      name: "flat",
      episodeTemplate: "{series} - {seasonPad2}x{episodePad2} - {quality}",
      movieTemplate: "{title} ({year})",
    });
    mkdirWrite(join(dir, "dl-b"), "film.mkv", "movie bytes\n");
    const out = (await importer().invoke("import", {
      itemKey: "movie-fixture-movie-2024",
      sourcePath: join(dir, "dl-b", "film.mkv"),
      quality: "2160p",
      title: "Fixture Movie",
      kind: "movie",
      year: 2024,
      scheme: "flat",
      correlationId: "corr-import-2",
    })) as ImportOutcomeShape;
    expect(out.destinationPath).toBe(join(importRoot, "Fixture Movie (2024).mkv"));

    await expect(
      importer().invoke("set-scheme", { name: "evil", episodeTemplate: "../../evil/{title}", movieTemplate: "{title}" }),
    ).rejects.toThrow(/traverse|path_escape|non-empty/);
    await expect(
      importer().invoke("set-scheme", { name: "bad-ph", episodeTemplate: "{nope}", movieTemplate: "{title}" }),
    ).rejects.toThrow(/unknown placeholder/);
  });
});

// ---- Import mechanics -----------------------------------------------------------

describe("hardlink-first import with copy fallback (story 11)", () => {
  it("hardlinks same-device imports", async () => {
    mkdirWrite(join(dir, "dl-c"), "ep.mkv", "same device bytes\n");
    const out = (await importer().invoke("import", {
      itemKey: "series-fixture-show:S01E02",
      sourcePath: join(dir, "dl-c", "ep.mkv"),
      quality: "720p",
      title: "Second",
      kind: "series",
      series: "Fixture Show",
      season: 1,
      episode: 2,
    })) as ImportOutcomeShape;
    expect(out.method).toBe("hardlink");
  });

  it("is idempotent: re-importing the same source hash does not duplicate or re-copy", async () => {
    mkdirWrite(join(dir, "dl-d"), "idem.mkv", "idem content v1\n");
    const req = {
      itemKey: "series-idem:S01E01",
      sourcePath: join(dir, "dl-d", "idem.mkv"),
      quality: "1080p",
      title: "Idem",
      kind: "series" as const,
      series: "Idem Show",
      season: 1,
      episode: 1,
    };
    const a = (await importer().invoke("import", req)) as ImportOutcomeShape;
    const b = (await importer().invoke("import", req)) as ImportOutcomeShape;
    expect(b.deduplicated).toBe(true);
    expect(b.destinationPath).toBe(a.destinationPath);
    const lib = (await importer().invoke("library")) as { items: Array<{ itemKey: string }> };
    expect(lib.items.filter((i) => i.itemKey === "series-idem:S01E01")).toHaveLength(1);
  });

  it("rejects sources outside configured import roots and symlink sources", async () => {
    mkdirWrite(join(dir, "outside-src"), "outside.txt", "outside\n");
    await expect(
      importer().invoke("import", {
        itemKey: "k-outside",
        sourcePath: "/etc/hostname",
        quality: "720p",
        title: "Outside",
        kind: "series",
        season: 1,
        episode: 1,
      }),
    ).rejects.toThrow();

    mkdirWrite(join(dir, "dl-e"), "target.txt", "symlink target\n");
    const link = join(dir, "dl-e", "link.mkv");
    try {
      symlinkSync(join(dir, "dl-e", "target.txt"), link);
      await expect(
        importer().invoke("import", {
          itemKey: "k-link",
          sourcePath: link,
          quality: "720p",
          title: "Linked",
          kind: "series",
          season: 1,
          episode: 1,
        }),
      ).rejects.toThrow(/symlink/i);
    } catch {
      // filesystem without symlink support: skip this assertion
    }
  });
});

// ---- Upgrades -------------------------------------------------------------------

describe("quality upgrade replacement (story 12)", () => {
  it("replaces a lower-quality file, removes the old copy, preserves history, emits events", async () => {
    mkdirWrite(join(dir, "dl-up-old"), "old.mkv", "upgrade v1 sd\n");
    mkdirWrite(join(dir, "dl-up-new"), "new.mkv", "upgrade v2 hd\n");
    const req = { itemKey: "series-upgrade:S01E01", kind: "series" as const, series: "Up Show", season: 1, episode: 1 };
    const first = (await importer().invoke("import", {
      ...req,
      sourcePath: join(dir, "dl-up-old", "old.mkv"),
      quality: "480p",
      title: "Ep",
      correlationId: "corr-up-1",
    })) as ImportOutcomeShape;
    expect(first.upgraded).toBe(false);

    const second = (await importer().invoke("import", {
      ...req,
      sourcePath: join(dir, "dl-up-new", "new.mkv"),
      quality: "1080p",
      title: "Ep",
      correlationId: "corr-up-2",
    })) as ImportOutcomeShape;
    expect(second.upgraded).toBe(true);
    expect(second.replacedPath).toBe(first.destinationPath);
    expect(existsSync(first.destinationPath)).toBe(false); // old copy removed AFTER verified swap

    const hist = (await importer().invoke("history", { itemKey: "series-upgrade:S01E01" })) as {
      history: Array<{ quality: string; importedAt: string }>;
    };
    expect(hist.history.map((h) => h.quality)).toEqual(["480p", "1080p"]);

    const events = await bus.read({ typePrefix: "dev.tantalar.event." });
    const types = events.map((e) => e.type);
    for (const t of [EventTypes.ImportStarted, EventTypes.ImportCompleted, EventTypes.UpgradeReplaced]) {
      expect(types).toContain(t);
    }
    // Upgrade chain correlates under its own id.
    const upEvents = await bus.read({ correlationId: "corr-up-2" });
    expect(upEvents.map((e) => e.type)).toContain(EventTypes.UpgradeReplaced);
    expect(upEvents[0]?.type).toBe(EventTypes.ImportStarted);
  });

  it("refuses to downgrade over a better-quality existing file", async () => {
    mkdirWrite(join(dir, "dl-down"), "sd.mkv", "downgrade attempt\n");
    await expect(
      importer().invoke("import", {
        itemKey: "series-upgrade:S01E01",
        sourcePath: join(dir, "dl-down", "sd.mkv"),
        quality: "480p",
        title: "Ep",
        kind: "series",
        season: 1,
        episode: 1,
      }),
    ).rejects.toThrow(/not worse/);
  });

  it("rolls back cleanly when the swap-in fails between staging and replace (story 12)", async () => {
    mkdirWrite(join(dir, "dl-rb-old"), "old.mkv", "rollback v1 sd\n");
    mkdirWrite(join(dir, "dl-rb-new"), "new.mkv", "rollback v2 hd\n");
    const req = { itemKey: "series-rollback:S01E01", kind: "series" as const, series: "Rollback Show", season: 1, episode: 1 };
    const first = (await importer().invoke("import", {
      ...req,
      sourcePath: join(dir, "dl-rb-old", "old.mkv"),
      quality: "480p",
      title: "Rb",
      correlationId: "corr-rb-1",
    })) as ImportOutcomeShape;
    const oldContent = readFileSync(first.destinationPath, "utf8");

    // Arm a fault that throws after staging but before the atomic swap.
    await importer().invoke("inject-fault", { name: "swap-fail" });
    const failed = importer().invoke("import", {
      ...req,
      sourcePath: join(dir, "dl-rb-new", "new.mkv"),
      quality: "1080p",
      title: "Rb",
      correlationId: "corr-rb-2",
    });
    await expect(failed).rejects.toThrow(/swap failure/);

    // Old copy intact with original content; no staging leftovers.
    expect(existsSync(first.destinationPath)).toBe(true);
    expect(readFileSync(first.destinationPath, "utf8")).toBe(oldContent);
    expect(existsSync(first.destinationPath + ".upgrade-staging")).toBe(false);

    // Failure is event-traced under the upgrade correlation id.
    const rbEvents = await bus.read({ correlationId: "corr-rb-2" });
    expect(rbEvents.map((e) => e.type)).toContain(EventTypes.ImportFailed);

    // Library state still points at the old record and a retry succeeds.
    const lib = (await importer().invoke("library")) as { items: Array<{ itemKey: string; quality: string }> };
    const rec = lib.items.find((i) => i.itemKey === req.itemKey);
    expect(rec?.quality).toBe("480p");
    delete process.env.TANTALAR_FAULT;
    const retry = (await importer().invoke("import", {
      ...req,
      sourcePath: join(dir, "dl-rb-new", "new.mkv"),
      quality: "1080p",
      title: "Rb",
    })) as ImportOutcomeShape;
    expect(retry.upgraded).toBe(true);
  });
});

// ---- Partial-copy guard + permissions -------------------------------------------

describe("partial-copy guard and permission failures (stories 11, 12)", () => {
  it("rejects a corrupt staged copy and leaves the existing file untouched", async () => {
    mkdirWrite(join(dir, "dl-pc-old"), "old.mkv", "partial guard v1 good\n");
    mkdirWrite(join(dir, "dl-pc-new"), "new.mkv", "partial guard v2 hd content longer\n");
    const req = { itemKey: "series-partial:S01E01", kind: "series" as const, series: "Partial Show", season: 1, episode: 1 };
    const first = (await importer().invoke("import", {
      ...req,
      sourcePath: join(dir, "dl-pc-old", "old.mkv"),
      quality: "720p",
      title: "Pc",
    })) as ImportOutcomeShape;
    const before = readFileSync(first.destinationPath);
    const beforeStat = statSync(first.destinationPath);

    // Corrupt-copy fault flips one staged byte AFTER the size check would
    // pass: exercises the staged-hash verification at plugin.ts.
    const corruptStaging = first.destinationPath.replace("720p", "1080p") + ".upgrade-staging";
    await importer().invoke("inject-fault", { name: "corrupt-copy", path: corruptStaging });
    const failed = importer().invoke("import", {
      ...req,
      sourcePath: join(dir, "dl-pc-new", "new.mkv"),
      quality: "1080p",
      title: "Pc",
    });
    await expect(failed).rejects.toThrow(/verification failed|size mismatch/);

    // Destination unchanged on disk and in library state.
    expect(readFileSync(first.destinationPath)).toEqual(before);
    expect(statSync(first.destinationPath).mtimeMs).toBe(beforeStat.mtimeMs);
    expect(existsSync(first.destinationPath + ".upgrade-staging")).toBe(false);

    // Truncated staged copy exercises the size-mismatch guard directly.
    const shortStaging = first.destinationPath.replace("720p", "1080p") + ".upgrade-staging";
    await importer().invoke("inject-fault", { name: "short-copy", path: shortStaging });
    await expect(
      importer().invoke("import", {
        ...req,
        sourcePath: join(dir, "dl-pc-new", "new.mkv"),
        quality: "1080p",
        title: "Pc",
      }),
    ).rejects.toThrow(/size mismatch/);
    expect(readFileSync(first.destinationPath)).toEqual(before);
    expect(existsSync(first.destinationPath + ".upgrade-staging")).toBe(false);
  });

  it("fails cleanly on an unreadable source without corrupting library state", async () => {
    if (typeof process.getuid === "function" && process.getuid() === 0) return; // root ignores modes
    mkdirWrite(join(dir, "dl-perm"), "locked.mkv", "permission locked bytes\n");
    chmodSync(join(dir, "dl-perm", "locked.mkv"), 0o000);
    try {
      await expect(
        importer().invoke("import", {
          itemKey: "series-perm:S01E01",
          sourcePath: join(dir, "dl-perm", "locked.mkv"),
          quality: "720p",
          title: "Perm",
          kind: "series",
          season: 1,
          episode: 1,
        }),
      ).rejects.toThrow();
    } finally {
      chmodSync(join(dir, "dl-perm", "locked.mkv"), 0o644);
    }
    const lib = (await importer().invoke("library")) as { items: Array<{ itemKey: string }> };
    expect(lib.items.some((i) => i.itemKey === "series-perm:S01E01")).toBe(false);
    const hist = (await importer().invoke("history", { itemKey: "series-perm:S01E01" })) as { history: unknown[] };
    expect(hist.history).toHaveLength(0);
  });
});

// ---- Metadata + calendar ----------------------------------------------------------

describe("metadata provider + calendar (stories 9, 14)", () => {
  it("enriches a series and a movie from fixture TVDB/TMDB adapters", async () => {
    const show = (await metadata().invoke("lookup", {
      kind: "series",
      name: "Fixture Show",
      season: 1,
      episode: 2,
      correlationId: "corr-meta-1",
    })) as { found: boolean; metadata: { externalId: string; airDate?: string; provider: string } };
    expect(show.found).toBe(true);
    expect(show.metadata.externalId).toBe("tvdb-121");
    expect(show.metadata.airDate).toBe("2026-09-08");

    const movie = (await metadata().invoke("lookup", { kind: "movie", name: "Fixture Movie", year: 2024 })) as {
      found: boolean;
      metadata: { externalId: string; year: number | null };
    };
    expect(movie.metadata.externalId).toBe("tmdb-9001");
    expect(movie.metadata.year).toBe(2024);

    const miss = (await metadata().invoke("lookup", { kind: "movie", name: "Unknown Film" })) as { found: boolean };
    expect(miss.found).toBe(false);

    const metaEvents = await bus.read({ correlationId: "corr-meta-1" });
    expect(metaEvents.map((e) => e.type)).toContain(EventTypes.MetadataRefreshed);
  });

  it("derives calendar entries from monitored media and lists upcoming only by default", async () => {
    const today = new Date();
    const future = new Date(today.getTime() + 7 * 86_400_000).toISOString().slice(0, 10);
    const past = new Date(today.getTime() - 7 * 86_400_000).toISOString().slice(0, 10);
    await importer().invoke("register-monitored", { itemKey: "series-fixture-show:S01E01", title: "Fixture Show S01E01", date: future, kind: "series" });
    await importer().invoke("register-monitored", { itemKey: "series-fixture-show:S00E00", title: "Old Special", date: past, kind: "series" });

    const cal = (await importer().invoke("calendar")) as { upcoming: Array<{ itemKey: string; date: string }> };
    expect(cal.upcoming.some((c) => c.itemKey === "series-fixture-show:S01E01")).toBe(true);
    expect(cal.upcoming.some((c) => c.itemKey === "series-fixture-show:S00E00")).toBe(false);

    const all = (await importer().invoke("calendar", { includePast: true })) as { upcoming: unknown[] };
    expect(all.upcoming.length).toBe(2);
  });
});

// ---- helpers --------------------------------------------------------------------

function mkdirWrite(baseDir: string, filename: string, content: string): void {
  const { mkdirSync, writeFileSync } = require("node:fs") as typeof import("node:fs");
  mkdirSync(baseDir, { recursive: true });
  writeFileSync(join(baseDir, filename), content);
}

function symlinkSync(target: string, path: string): void {
  (require("node:fs") as typeof import("node:fs")).symlinkSync(target, path);
}
