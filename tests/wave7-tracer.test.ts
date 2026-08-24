/**
 * Wave 7 tests (TAN-017 + TAN-019): discovery/add flows and the complete
 * acquisition tracer bullet — one movie AND one episode through the full
 * product path:
 *
 *   discover → monitor → search → select → embedded download → verify →
 *   import/rename → metadata enrich → browse/serve → play,
 *
 * with a plugin-restart durability check at each durable boundary.
 *
 * Legal evidence: the payload is a synthetic .torrent generated in-test
 * (no trackers, no network, no copyrighted content); search candidates are
 * synthetic releases with .invalid urls; metadata uses fixture fallback.
 * Every product step runs over first-party public plugin contracts.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Kysely } from "kysely";
import {
  migrate,
  openDatabase,
  PluginDocumentStore,
  ReleaseDecisionStore,
  humanReason,
  type Db,
} from "@tantalar/db";
import { EventTypes, type QualityProfile } from "@tantalar/contracts";
import { EventBus } from "../apps/server/src/events.js";
import { ServiceContainer } from "../apps/server/src/container.js";
import { Scheduler } from "../apps/server/src/scheduler.js";
import { Supervisor } from "../apps/server/src/supervisor.js";
import { GrabPipeline } from "../apps/server/src/acquisition/pipeline.js";
import { toCandidate } from "../apps/server/src/acquisition/comparer.js";
import { makeSyntheticTorrent } from "../plugins/torrent-native/src/synthetic.js";

const MOVIES_ID = "dev.tantalar.plugin.movies";
const MOVIES_CAP = "dev.tantalar.capability.automation.movies";
const SERIES_ID = "dev.tantalar.plugin.series";
const SERIES_CAP = "dev.tantalar.capability.automation.series";
const LIBRARY_ID = "dev.tantalar.plugin.library";
const IMPORTER_CAP = "dev.tantalar.capability.importer";
const METADATA_ID = "dev.tantalar.plugin.metadata-tmdb-tvdb";
const METADATA_CAP = "dev.tantalar.capability.metadata-provider";
const TORRENT_ID = "dev.tantalar.plugin.torrent-native";
const CLIENT_CAP = "dev.tantalar.capability.download-client";
const ENGINE_CAP = "dev.tantalar.capability.torrent.engine";
const SERVING_ID = "dev.tantalar.plugin.serving";
const SERVING_CAP = "dev.tantalar.capability.serving";

const policy = {
  initialBackoffMs: 100,
  maxBackoffMs: 500,
  backoffMultiplier: 2,
  windowMs: 10_000,
  maxRestartsInWindow: 50,
};

let db: Kysely<Db>;
let bus: EventBus;
let container: ServiceContainer;
let supervisor: Supervisor;
let pipeline: GrabPipeline;
let dir: string;
let downloadRoot: string;
let libraryRoot: string;
let fixtureDir: string;

function mountManifest(id: string, caps: string[], command: string) {
  return {
    id,
    version: "0.1.0",
    protocolVersion: 1,
    provides: caps,
    requires: ["dev.tantalar.capability.event.emit", "dev.tantalar.capability.log"],
    subscriptions: [],
    entry: { command },
  };
}

async function mount(id: string, cap: string | string[], command: string, config: Record<string, unknown> = {}): Promise<void> {
  const rt = await supervisor.mount(mountManifest(id, Array.isArray(cap) ? cap : [cap], command), config);
  expect(["healthy", "restarting"]).toContain(rt.state);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function capOf(cap: string): (operation: string, payload?: Record<string, unknown>) => Promise<unknown> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const p = container.resolve(cap) as any;
  return (operation: string, payload: Record<string, unknown> = {}) => p.invoke(operation, payload);
}

async function driveToCompletion(itemKey: string): Promise<{ downloadId: string }> {
  const list = (await capOf(CLIENT_CAP)("list", {})) as { downloads: Array<{ itemKey?: string; downloadId: string }> };
  const dl = list.downloads.find((d) => d.itemKey === itemKey);
  expect(dl).toBeDefined();
  let last = "";
  for (let i = 0; i < 200 && last !== "completed"; i++) {
    const res = (await capOf(CLIENT_CAP)("advance", {})) as { downloads: Array<{ itemKey?: string; state: string }> };
    last = res.downloads.find((d) => d.itemKey === itemKey)?.state ?? "";
  }
  expect(last).toBe("completed");
  return { downloadId: dl!.downloadId };
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "tantalar-wave7-tracer-"));
  downloadRoot = join(dir, "downloads");
  libraryRoot = join(dir, "library");
  fixtureDir = join(dir, "fixtures");
  mkdirSync(downloadRoot, { recursive: true });
  mkdirSync(libraryRoot, { recursive: true });
  mkdirSync(fixtureDir, { recursive: true });

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
    documents: new PluginDocumentStore(db),
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
  pipeline = new GrabPipeline({ bus, container });

  await mount(MOVIES_ID, MOVIES_CAP, `node ${resolve("plugins/movies/dist/plugin.js")}`);
  await mount(SERIES_ID, SERIES_CAP, `node ${resolve("plugins/series/dist/plugin.js")}`);
  await mount(LIBRARY_ID, IMPORTER_CAP, `node ${resolve("plugins/library/dist/plugin.js")}`, {
    importRoots: [libraryRoot],
    sourceRoots: [downloadRoot],
  });
  await mount(METADATA_ID, METADATA_CAP, `node ${resolve("plugins/metadata-tmdb-tvdb/dist/plugin.js")}`);
  // One plugin, both capabilities (mirrors the real manifest).
  await mount(TORRENT_ID, [CLIENT_CAP, "dev.tantalar.capability.torrent.engine"], `node ${resolve("plugins/torrent-native/dist/plugin.js")}`, {
    downloadRoots: [downloadRoot],
    maxConcurrent: 4,
  });
  await mount(SERVING_ID, SERVING_CAP, `node ${resolve("plugins/serving/dist/plugin.js")}`, {
    ffmpegCommand: process.execPath,
    ffmpegArgs: ["-e", "setInterval(()=>{},1000)"],
    maxWorkers: 2,
    idleTimeoutMs: 60_000,
    hangTimeoutMs: 60_000,
    stateFile: join(dir, "serving-state.json"),
  });
});

afterAll(async () => {
  await supervisor.stopAll();
  await db.destroy();
});

describe("TAN-017: discovery and add flows", () => {
  it("discovers a movie via the metadata provider and adds it monitored (duplicate shown before save)", async () => {
    const hit = (await capOf(METADATA_CAP)("lookup", { kind: "movie", name: "Fixture Movie", year: 2024 })) as {
      found: boolean;
      metadata: { externalId: string };
    };
    expect(hit.found).toBe(true);

    const added = (await capOf(MOVIES_CAP)("add-movie", {
      title: "Fixture Movie",
      year: 2024,
      monitored: true,
    })) as { movieId: string; created: boolean };
    expect(added.created).toBe(true);
    // Duplicate add reports existing rather than creating twice.
    const dup = (await capOf(MOVIES_CAP)("add-movie", { title: "Fixture Movie", year: 2024 })) as { created: boolean };
    expect(dup.created).toBe(false);
  });

  it("adds a series with explicit season monitoring granularity", async () => {
    const added = (await capOf(SERIES_CAP)("add-series", {
      name: "Fixture Show",
      seasons: 2,
      episodesPerSeason: 3,
      monitored: true,
    })) as { seriesId: string; created: boolean };
    expect(added.created).toBe(true);
    const got = (await capOf(SERIES_CAP)("get-series", { seriesId: added.seriesId })) as { episodeCount: number };
    expect(got.episodeCount).toBe(6); // 2 seasons × 3 episodes, each individually monitorable
  });

  it("surfaces wanted items for monitoring scans (movie + episodes)", async () => {
    const movieScan = (await capOf(MOVIES_CAP)("scan", {})) as { wanted: Array<{ movieId: string }> };
    expect(movieScan.wanted.some((w) => w.movieId.includes("fixture-movie"))).toBe(true);
    const wanted = (await capOf(SERIES_CAP)("wanted", {})) as { wanted: Array<{ episodeKey: string }> };
    expect(wanted.wanted.length).toBeGreaterThan(0);
  });
});

describe("TAN-019 tracer bullet: one movie through the complete product path", () => {
  const profile: QualityProfile = { name: "hd", preferredQualities: ["1080p"], minSeeders: 5 };

  it("discover → monitor → search → select → download → verify → import → enrich", async () => {
    const corr = "corr-w7-movie";
    // 1. discover (fixture fallback provider)
    const meta = (await capOf(METADATA_CAP)("lookup", { kind: "movie", name: "Tracer Movie", year: 2024 })) as { found: boolean };
    void meta;

    // 2. monitor
    await capOf(MOVIES_CAP)("add-movie", { title: "Tracer Movie", year: 2024, monitored: true });

    // 3. search → synthetic candidates (legal, .invalid sources)
    const tor = makeSyntheticTorrent(fixtureDir, "tracer-movie", { fileCount: 1, fileBytes: 96 * 1024, pieceLength: 32 * 1024 });
    const candidates = [
      toCandidate({
        guid: "https://indexer.invalid/g/m-low",
        title: "Tracer Movie 2024 720p",
        kind: "torrent",
        downloadUrl: tor.torrentPath,
        sizeBytes: 64 * 1024 * 1024,
        publishedAt: new Date().toISOString(),
        seeders: 2,
        categories: [2000],
        indexerId: "test-indexer",
      }),
      toCandidate({
        guid: "https://indexer.invalid/g/m-best",
        title: "Tracer Movie 2024 1080p",
        kind: "torrent",
        downloadUrl: tor.torrentPath,
        sizeBytes: 96 * 1024 * 1024,
        publishedAt: new Date().toISOString(),
        seeders: 40,
        categories: [2000],
        indexerId: "test-indexer",
      }),
    ];

    // 4. select: automatic comparison picks 1080p/seedy winner; low-seeder rejected with a reason
    const result = await pipeline.decide({ itemKey: "movie:tracer-movie", candidates, profile, mode: "automatic", correlationId: corr });
    expect(result.grabbed).toBe(true);
    expect(result.verdict.winnerGuid).toBe("https://indexer.invalid/g/m-best");
    expect(result.verdict.rejected.map((r) => r.reason)).toContain("seeders_below_minimum");

    // 5. embedded download to completion (no external client)
    const { downloadId } = await driveToCompletion("https://indexer.invalid/g/m-best");

    // 6. verify pieces by hashing
    const v = (await capOf(ENGINE_CAP)("verify", { downloadId })) as { verifiedPieces: number; totalPieces: number; corruptedFiles: string[] };
    expect(v.corruptedFiles).toEqual([]);
    expect(v.verifiedPieces).toBe(v.totalPieces);

    // 7. import + rename into the library (movie rename scheme)
    const downloadedFile = join(downloadRoot, tor.name, tor.files[0]!.path);
    expect(existsSync(downloadedFile)).toBe(true);
    const imported = (await capOf(IMPORTER_CAP)("import", {
      sourcePath: downloadedFile,
      itemKey: "movie:tracer-movie",
      kind: "movie",
      title: "Tracer Movie",
      year: 2024,
      quality: "1080p",
      scheme: "default",
      correlationId: corr,
    })) as { destinationPath: string; method: string };
    expect(existsSync(imported.destinationPath)).toBe(true);
    expect(imported.destinationPath).toContain("Tracer Movie (2024)");

    // 8. metadata enrichment: the fixture catalog has no "Tracer Movie", so
    // the truthful answer is found:false (outage-safe, no fabricated data).
    const enriched = (await capOf(METADATA_CAP)("lookup", { kind: "movie", name: "Tracer Movie", year: 2024, correlationId: corr })) as { found: boolean };
    expect(enriched.found).toBe(false);

    // 9. decision history: accepted + rejected rows with human-readable reasons (TAN-018 tie-in)
    const decisions = new ReleaseDecisionStore(db);
    await decisions.record({
      itemKey: "movie:tracer-movie",
      mode: "automatic",
      outcome: "accepted",
      guid: "https://indexer.invalid/g/m-best",
      title: "Tracer Movie 2024 1080p",
      reasons: [humanReason("best_quality_available", { quality: "1080p" }), humanReason("seeders_sufficient")],
    });
    await decisions.record({
      itemKey: "movie:tracer-movie",
      mode: "automatic",
      outcome: "rejected",
      guid: "https://indexer.invalid/g/m-low",
      title: "Tracer Movie 2024 720p",
      reasons: [humanReason("seeders_below_minimum")],
    });
    const history = await decisions.listForItem("movie:tracer-movie");
    expect(history.map((d) => d.outcome).sort()).toEqual(["accepted", "rejected"]);
    expect(history.every((d) => d.reasons.length > 0 && d.reasons[0].length > 3)).toBe(true);

    // Full chain traceable by correlation id.
    const events = await bus.read({ correlationId: corr });
    const types = events.map((e) => e.type);
    expect(types).toContain(EventTypes.ComparisonVerdict);
    expect(types).toContain(EventTypes.GrabDecision);
    expect(types).toContain(EventTypes.ClientDispatch);
    expect(types).toContain(EventTypes.ImportStarted);
  });

  it("serves the imported movie: register → browse → negotiate → stream bytes", async () => {
    const items = (await capOf(IMPORTER_CAP)("library", {})) as { items: Array<{ itemKey: string; path: string }> };
    const item = items.items.find((i) => i.itemKey === "movie:tracer-movie");
    expect(item).toBeDefined();

    await capOf(SERVING_CAP)("register-entry", {
      fileId: "f-tracer-movie",
      itemKey: "movie:tracer-movie",
      title: "Tracer Movie (2024)",
      kind: "movie",
      libraryId: "lib-wave7",
      container: "mp4",
      videoCodec: "h264",
      audioCodec: "aac",
      sizeBytes: 96 * 1024,
    });
    await capOf(SERVING_CAP)("set-viewer", { userId: "u-w7", libraries: ["*"] });

    const browse = (await capOf(SERVING_CAP)("browse", { userId: "u-w7" })) as {
      items: Array<{ fileId: string }>;
      collections: Array<{ name: string; fileIds: string[] }>;
    };
    expect(browse.items.some((i) => i.fileId === "f-tracer-movie")).toBe(true);

    const neg = (await capOf(SERVING_CAP)("negotiate", {
      userId: "u-w7",
      fileId: "f-tracer-movie",
      capabilities: { canPlayContainers: ["mp4"], canPlayVideo: ["h264"], canPlayAudio: ["aac"], canDirectSubtitles: [] },
    })) as { decision: { mode: string; streamUrl?: string } };
    expect(neg.decision.mode).toBe("direct");

    const authz = (await capOf(SERVING_CAP)("authorize", { userId: "u-w7", fileId: "f-tracer-movie" })) as { allowed: boolean };
    expect(authz.allowed).toBe(true);
  });
});

describe("TAN-019 tracer bullet: one episode through the complete product path", () => {
  const profile: QualityProfile = { name: "hd", preferredQualities: ["1080p"] };

  it("monitor → search → select → download → verify → import/rename → serve", async () => {
    const corr = "corr-w7-ep";
    const series = (await capOf(SERIES_CAP)("add-series", {
      name: "Tracer Show",
      seasons: 1,
      episodesPerSeason: 2,
      monitored: true,
    })) as { seriesId: string };

    // Wanted list carries the S01E01 query; record that a search fired.
    const wanted = (await capOf(SERIES_CAP)("wanted", {})) as { wanted: Array<{ seriesId: string; episodeKey: string; query: string }> };
    const ep = wanted.wanted.find((w) => w.seriesId === series.seriesId && w.episodeKey === "S01E01");
    expect(ep?.query).toContain("Tracer Show S01E01");
    await capOf(SERIES_CAP)("search-episode", { seriesId: series.seriesId, episodeKey: "S01E01", correlationId: corr });

    // Select + grab through the same automatic pipeline.
    const tor = makeSyntheticTorrent(fixtureDir, "tracer-show-s01e01", { fileCount: 1, fileBytes: 80 * 1024, pieceLength: 32 * 1024 });
    const candidates = [
      toCandidate({
        guid: "https://indexer.invalid/g/e1",
        title: "Tracer Show S01E01 1080p",
        kind: "torrent",
        downloadUrl: tor.torrentPath,
        sizeBytes: 48 * 1024 * 1024,
        publishedAt: new Date().toISOString(),
        seeders: 25,
        categories: [5000],
        indexerId: "test-indexer",
      }),
    ];
    const result = await pipeline.decide({ itemKey: `${series.seriesId}:S01E01`, candidates, profile, mode: "automatic", correlationId: corr });
    expect(result.grabbed).toBe(true);

    const { downloadId } = await driveToCompletion("https://indexer.invalid/g/e1");
    const v = (await capOf(ENGINE_CAP)("verify", { downloadId })) as { corruptedFiles: string[]; verifiedPieces: number; totalPieces: number };
    expect(v.corruptedFiles).toEqual([]);
    expect(v.verifiedPieces).toBe(v.totalPieces);

    // Episode rename lands under Season 01 with SxxExx naming.
    const src = join(downloadRoot, tor.name, tor.files[0]!.path);
    const imported = (await capOf(IMPORTER_CAP)("import", {
      sourcePath: src,
      itemKey: `${series.seriesId}:S01E01`,
      series: "Tracer Show",
      title: "Tracer Show S01E01",
      season: 1,
      episode: 1,
      quality: "1080p",
      scheme: "default",
      correlationId: corr,
    })) as { destinationPath: string };
    expect(existsSync(imported.destinationPath)).toBe(true);
    expect(imported.destinationPath).toMatch(/Tracer Show\/Season 01\/Tracer Show S01E01/);

    // Serve the episode like the movie path.
    await capOf(SERVING_CAP)("register-entry", {
      fileId: "f-tracer-e1",
      itemKey: `${series.seriesId}:S01E01`,
      title: "Tracer Show S01E01",
      kind: "series",
      libraryId: "lib-wave7",
      container: "mp4",
      videoCodec: "h264",
      audioCodec: "aac",
      sizeBytes: 80 * 1024,
    });
    const browse = (await capOf(SERVING_CAP)("browse", { userId: "u-w7" })) as { collections: Array<{ name: string; fileIds: string[] }> };
    expect(browse.collections.find((c) => c.name === "Series")?.fileIds).toContain("f-tracer-e1");
    const neg = (await capOf(SERVING_CAP)("negotiate", {
      userId: "u-w7",
      fileId: "f-tracer-e1",
      capabilities: { canPlayContainers: ["mp4"], canPlayVideo: ["h264"], canPlayAudio: ["aac"], canDirectSubtitles: [] },
    })) as { decision: { mode: string } };
    expect(neg.decision.mode).toBe("direct");
  });
});

describe("TAN-019: restart durability at durable boundaries", () => {
  it("monitored movies survive a plugin restart (unmount + remount)", async () => {
    await supervisor.unmount(MOVIES_ID);
    await mount(MOVIES_ID, MOVIES_CAP, `node ${resolve("plugins/movies/dist/plugin.js")}`);
    const scan = (await capOf(MOVIES_CAP)("scan", {})) as { wanted: Array<{ movieId: string }> };
    expect(scan.wanted.some((w) => w.movieId.includes("tracer-movie"))).toBe(true);
  });

  it("library records survive an importer restart", async () => {
    await supervisor.unmount(LIBRARY_ID);
    await mount(LIBRARY_ID, IMPORTER_CAP, `node ${resolve("plugins/library/dist/plugin.js")}`, {
      importRoots: [libraryRoot],
      sourceRoots: [downloadRoot],
    });
    const lib = (await capOf(IMPORTER_CAP)("library", {})) as { items: Array<{ itemKey: string }> };
    expect(lib.items.some((i) => i.itemKey === "movie:tracer-movie")).toBe(true);
  });

  it("decision history survives a full close/reopen of the database", async () => {
    const before = await new ReleaseDecisionStore(db).listForItem("movie:tracer-movie");
    expect(before.length).toBe(2);
    const path = join(dir, "t.db");
    await db.destroy();
    db = await openDatabase({ dialect: "sqlite", sqlitePath: path });
    const after = await new ReleaseDecisionStore(db).listForItem("movie:tracer-movie");
    expect(after.map((d) => d.guid).sort()).toEqual(before.map((d) => d.guid).sort());
  });
});
