/**
 * Phase 3c tests: series + movies automation plugins and the end-to-end
 * fixture acquisition pipeline. Covers: add-by-name with season/episode
 * tracking, wanted-list scans, monitored-movie auto-grab, manual interactive
 * pick, grab through the fixture NZB/torrent client, failure handling with
 * blacklist + automatic re-search, idempotent adds, quality-upgrade ranking,
 * and full event-chain reconstruction from the log. Fixtures only.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Kysely } from "kysely";
import { migrate, openDatabase, type Db } from "@tantalar/db";
import {
  EventTypes,
  type CandidateRelease,
  type DownloadStatus,
  type IndexerSearchResult,
} from "@tantalar/contracts";
import { EventBus } from "../apps/server/src/events.js";
import { ServiceContainer } from "../apps/server/src/container.js";
import { Scheduler } from "../apps/server/src/scheduler.js";
import { Supervisor } from "../apps/server/src/supervisor.js";
import { GrabPipeline } from "../apps/server/src/acquisition/pipeline.js";
import { toCandidate } from "../apps/server/src/acquisition/comparer.js";

const SERIES_ID = "dev.tantalar.plugin.series";
const SERIES_CAP = "dev.tantalar.capability.automation.series";
const MOVIES_ID = "dev.tantalar.plugin.movies";
const MOVIES_CAP = "dev.tantalar.capability.automation.movies";
const INDEXER_CAP = "dev.tantalar.capability.indexer";
const CLIENT_ID = "dev.tantalar.plugin.fixture-download-client";
const CLIENT_CAP = "dev.tantalar.capability.download-client";

const SERIES_ENTRY = "node " + resolve("plugins/series/dist/plugin.js");
const MOVIES_ENTRY = "node " + resolve("plugins/movies/dist/plugin.js");
const INDEXER_ENTRY = "node " + resolve("plugins/fixture-indexer/dist/plugin.js");
const CLIENT_ENTRY = "node " + resolve("plugins/fixture-download-client/dist/plugin.js");

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
let pipeline: GrabPipeline;

function manifestFor(id: string, capability: string, command: string) {
  return {
    id,
    version: "0.1.0",
    protocolVersion: 1,
    provides: [capability],
    requires: ["dev.tantalar.capability.event.emit", "dev.tantalar.capability.log"],
    subscriptions: [],
    entry: { command },
  };
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "tantalar-p3c-"));
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
  pipeline = new GrabPipeline({ bus, container });
});

afterAll(async () => {
  await supervisor.stopAll();
  await db.destroy();
});

async function mount(id: string, capability: string, command: string) {
  const rt = await supervisor.mount(manifestFor(id, capability, command), {});
  expect(rt.state).toBe("healthy");
}

/** Deterministic candidate builder over the fixture indexer catalog shape. */
function release(overrides: Partial<Parameters<typeof toCandidate>[0]> & { guid: string; title: string }): CandidateRelease {
  return toCandidate({
    kind: "torrent",
    downloadUrl: `https://fixture.invalid/${overrides.guid}`,
    sizeBytes: 1024,
    publishedAt: new Date().toISOString(),
    categories: [],
    indexerId: "dev.tantalar.plugin.fixture-indexer",
    seeders: 50,
    ...overrides,
  });
}

// ---- Series automation plugin -------------------------------------------------

describe("series automation plugin (story 1)", () => {
  beforeAll(async () => {
    await mount(SERIES_ID, SERIES_CAP, SERIES_ENTRY);
  });
  afterAll(async () => {
    await supervisor.unmount(SERIES_ID);
  });

  it("adds a show by name and creates seasons/episodes", async () => {
    const p = container.resolve(SERIES_CAP);
    const added = (await p.invoke("add-series", { name: "Fixture Show", seasons: 2, episodesPerSeason: 3 })) as {
      seriesId: string;
      created: boolean;
    };
    expect(added.created).toBe(true);
    const rec = (await p.invoke("get-series", { seriesId: added.seriesId })) as { episodeCount: number; name: string };
    expect(rec.episodeCount).toBe(6);
    expect(rec.name).toBe("Fixture Show");
    // Idempotency: adding again does not duplicate.
    const again = (await p.invoke("add-series", { name: "Fixture Show" })) as { created: boolean };
    expect(again.created).toBe(false);
    expect((await p.invoke("get-series", { seriesId: added.seriesId }) as { episodeCount: number }).episodeCount).toBe(6);
  });

  it("generates a wanted list of monitored episodes with queries", async () => {
    const p = container.resolve(SERIES_CAP);
    const out = (await p.invoke("wanted", {})) as { wanted: Array<{ episodeKey: string; query: string }> };
    expect(out.wanted.length).toBe(6);
    expect(out.wanted[0]?.query).toMatch(/^Fixture Show S01E01$/);
  });

  it("traces an episode scan into the event log with correlation", async () => {
    const p = container.resolve(SERIES_CAP);
    const res = (await p.invoke("search-episode", {
      seriesId: "series-fixture-show",
      episodeKey: "S01E02",
      correlationId: "corr-scan-1",
    })) as { searched: boolean };
    expect(res.searched).toBe(true);
    const rows = await bus.read({ correlationId: "corr-scan-1" });
    expect(rows.map((r) => r.type)).toContain(EventTypes.SeriesEpisodeSearched);
  });

  it("respects monitoring off: unmonitored shows drop out of the wanted list", async () => {
    const p = container.resolve(SERIES_CAP);
    await p.invoke("set-monitoring", { seriesId: "series-fixture-show", monitored: false });
    const off = (await p.invoke("wanted", {})) as { wanted: unknown[] };
    expect(off.wanted).toHaveLength(0);
    await p.invoke("set-monitoring", { seriesId: "series-fixture-show", monitored: true });
    const on = (await p.invoke("wanted", {})) as { wanted: unknown[] };
    expect(on.wanted.length).toBe(6);
  });
});

// ---- Movies automation plugin --------------------------------------------------

describe("movies automation plugin (story 2)", () => {
  beforeAll(async () => {
    await mount(MOVIES_ID, MOVIES_CAP, MOVIES_ENTRY);
  });
  afterAll(async () => {
    await supervisor.unmount(MOVIES_ID);
  });

  it("adds a monitored movie idempotently and reports it in scans", async () => {
    const p = container.resolve(MOVIES_CAP);
    const added = (await p.invoke("add-movie", { title: "Fixture Movie", year: 2024 })) as { movieId: string; created: boolean };
    expect(added.created).toBe(true);
    const dup = (await p.invoke("add-movie", { title: "Fixture Movie", year: 2024 })) as { created: boolean };
    expect(dup.created).toBe(false);
    const scan = (await p.invoke("scan", {})) as { wanted: Array<{ movieId: string; query: string }> };
    expect(scan.wanted.some((w) => w.movieId === added.movieId && /Fixture Movie 2024/.test(w.query))).toBe(true);
  });

  it("marks acquired idempotently and removes the movie from scans", async () => {
    const p = container.resolve(MOVIES_CAP);
    const first = (await p.invoke("mark-acquired", { movieId: "movie-fixture-movie-2024", guid: "g1" })) as {
      acquired: boolean;
      upgrade: boolean;
    };
    expect(first.acquired).toBe(true);
    expect(first.upgrade).toBe(false);
    const second = (await p.invoke("mark-acquired", { movieId: "movie-fixture-movie-2024", guid: "g1" })) as {
      acquired: boolean;
    };
    expect(second.acquired).toBe(false); // same guid → no-op
    const scan = (await p.invoke("scan", {})) as { wanted: unknown[] };
    expect(scan.wanted.some((w) => (w as { movieId: string }).movieId === "movie-fixture-movie-2024")).toBe(false);
  });
});

// ---- End-to-end fixture pipeline -----------------------------------------------

describe("end-to-end fixture pipeline (stories 1–8)", () => {
  beforeAll(async () => {
    await mount(INDEXER_ID_SAFE(), INDEXER_CAP, INDEXER_ENTRY);
    await mount(CLIENT_ID, CLIENT_CAP, CLIENT_ENTRY);
  });
  afterAll(async () => {
    await supervisor.unmount(INDEXER_ID_SAFE());
    await supervisor.unmount(CLIENT_ID);
  });
  function INDEXER_ID_SAFE(): string {
    return "dev.tantalar.plugin.fixture-indexer";
  }

  it("searches the fixture indexer for a wanted episode and auto-grabs through the download client", async () => {
    const corr = "corr-e2e-1";
    // 1. Wanted episode generates an automatic search against the indexer.
    const indexer = container.resolve(INDEXER_CAP);
    const result = (await indexer.invoke("search", {
      mode: "automatic",
      query: "S01E01",
      correlationId: corr,
    })) as IndexerSearchResult;
    expect(result.releases.length).toBeGreaterThan(0);

    // 2. Candidates go through comparison → decision → dispatch → queued.
    const candidates = result.releases.map(toCandidate);
    const verdictResult = await pipeline.decide({
      itemKey: "series-fixture-show:S01E01",
      mode: "automatic",
      correlationId: corr,
      candidates,
      profile: { name: "hd", preferredQualities: ["1080p"] },
    });
    expect(verdictResult.grabbed).toBe(true);
    expect(verdictResult.download?.state).toBeDefined();

    // 3. The job advances to completed inside the fixture client.
    const client = container.resolve(CLIENT_CAP);
    const fin = (await client.invoke("advance", {})) as { downloads: DownloadStatus[] };
    expect(fin.downloads.find((d) => d.itemKey === verdictResult.download?.itemKey)?.state).toBe("completed");

    // 4. Full event chain reconstructs from the log under one correlation id.
    const events = await bus.read({ correlationId: corr });
    const types = events.map((e) => e.type);
    for (const t of [
      EventTypes.IndexerSearched,
      EventTypes.ComparisonVerdict,
      EventTypes.GrabDecision,
      EventTypes.ClientDispatch,
      EventTypes.DownloadQueued,
      EventTypes.DownloadProgress,
      EventTypes.DownloadCompleted,
    ]) {
      expect(types).toContain(t);
    }
  });

  it("interactive search returns ranked releases and a manual pick emits the event chain", async () => {
    const corr = "corr-e2e-inter";
    const indexer = container.resolve(INDEXER_CAP);
    const result = (await indexer.invoke("search", { mode: "interactive", query: "S01E01", correlationId: corr })) as IndexerSearchResult;
    const candidates = result.releases.map(toCandidate);
    const ranked = await pipeline.decide({
      itemKey: "series-fixture-show:S01E02",
      mode: "automatic",
      correlationId: corr,
      candidates,
      profile: { name: "hd", preferredQualities: ["1080p"] },
    });
    expect(ranked.grabbed).toBe(true);
    const manual = await pipeline.decide({
      itemKey: "series-fixture-show:S01E03",
      mode: "interactive",
      chosenGuid: result.releases[0]!.guid,
      correlationId: corr + "-manual",
      candidates,
      profile: { name: "hd", preferredQualities: ["1080p"] },
    });
    expect(manual.grabbed).toBe(true);
    const events = await bus.read({ correlationId: corr + "-manual" });
    expect(events.map((e) => e.type)).toContain(EventTypes.GrabDecision);
    expect(events.map((e) => e.type)).toContain(EventTypes.ClientDispatch);
  });

  it("failed downloads blacklist the release and automatic re-search picks a different one", async () => {
    const good = release({ guid: "good-rel", title: "X S01E01 1080p WEB-DL" });
    const bad = release({ guid: "bad-rel", title: "X S01E01 720p HDTV" });
    const client = container.resolve(CLIENT_CAP);

    // First attempt grabs the higher-ranked release.
    const first = await pipeline.decide({
      itemKey: "series-x:S01E01",
      mode: "automatic",
      correlationId: "corr-retry-1",
      candidates: [bad, good],
      profile: { name: "hd", preferredQualities: ["1080p"] },
    });
    expect(first.grabbed).toBe(true);
    expect(first.verdict.winnerGuid).toBe("good-rel");

    // Simulate a transfer failure of that release and run the failure hook.
    const fb = await pipeline.handleFailure("series-x:S01E01", "good-rel");
    expect(fb.blacklisted).toBe(true);

    // Automatic re-search: blacklisted release is rejected, next-best grabbed.
    const retry = await pipeline.decide({
      itemKey: "series-x:S01E01",
      mode: "automatic",
      correlationId: "corr-retry-2",
      candidates: [bad, good],
      profile: { name: "hd", preferredQualities: ["1080p"] },
    });
    expect(retry.grabbed).toBe(true);
    expect(retry.verdict.winnerGuid).toBe("bad-rel");
    expect(retry.verdict.rejected[0]).toMatchObject({ guid: "good-rel", reason: "blacklisted_release" });
    const blEvents = await bus.read({ typePrefix: EventTypes.BlacklistAdded });
    expect(blEvents.length).toBeGreaterThan(0);
    void client;
  });

  it("quality upgrades rank properly/repack and higher quality ahead of the held copy", async () => {
    const held = release({ guid: "held-720", title: "U S01E01 720p HDTV" });
    const better = release({ guid: "better-1080-proper", title: "U S01E01 1080p PROPER" });
    const out = await pipeline.decide({
      itemKey: "series-u:S01E01",
      mode: "automatic",
      correlationId: "corr-upgrade",
      candidates: [held, better],
      profile: { name: "hd", preferredQualities: ["1080p"], preferProperRepack: true },
    });
    expect(out.grabbed).toBe(true);
    expect(out.verdict.winnerGuid).toBe("better-1080-proper");
    expect(out.verdict.reasons).toContain("proper_repack_upgrade");
  });

  it("is idempotent at the client: re-grabbing the same item does not duplicate jobs", async () => {
    const client = container.resolve(CLIENT_CAP);
    const a = (await client.invoke("add", {
      itemKey: "idem-1",
      title: "Idem 1080p",
      kind: "nzb",
      sourceUrl: "https://fixture.invalid/idem.nzb",
    })) as DownloadStatus;
    const b = (await client.invoke("add", {
      itemKey: "idem-1",
      title: "Idem 1080p",
      kind: "nzb",
      sourceUrl: "https://fixture.invalid/idem.nzb",
    })) as DownloadStatus;
    expect(b.downloadId).toBe(a.downloadId);
  });
});
