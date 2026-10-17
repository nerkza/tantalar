import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Kysely } from "kysely";
import { DownloadJobStore, ReleaseDecisionStore, migrate, openDatabase, type Db } from "@tantalar/db";
import { ServiceContainer } from "../apps/server/src/container.js";
import { EventBus } from "../apps/server/src/events.js";
import { listManagedWanted, runAutomaticAcquisition, searchManagedReleases } from "../apps/server/src/acquisition/managed-search.js";

describe("automatic managed acquisition", () => {
  let db: Kysely<Db> | null = null;
  afterEach(async () => db?.destroy());

  it("uses the interactive policy verdict and dispatches only its accepted winner", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tantalar-automatic-acquisition-"));
    db = await openDatabase({ dialect: "sqlite", sqlitePath: join(dir, "test.db") });
    await migrate(db);
    const jobs = new DownloadJobStore(db);
    const decisions = new ReleaseDecisionStore(db);
    const bus = new EventBus(db);
    const container = new ServiceContainer();
    container.register({
      pluginId: "movies",
      capability: "dev.tantalar.capability.automation.movies",
      invoke: async (operation) => operation === "scan"
        ? { wanted: [{ movieId: "movie-auto", query: "Automatic Movie 2026" }] }
        : operation === "get-movie"
          ? {
              movieId: "movie-auto",
              title: "Automatic Movie",
              year: 2026,
              availableAt: "2020-01-01",
              minimumAvailability: "released",
              profile: { name: "hd", preferredQualities: ["1080p"] },
            }
          : { acquired: true },
    });
    container.register({
      pluginId: "indexer",
      capability: "dev.tantalar.capability.indexer",
      invoke: async () => ({
        releases: [
          {
            guid: "auto-rejected",
            title: "Automatic Movie 2026 480p",
            kind: "torrent",
            downloadUrl: "magnet:?xt=urn:btih:1111111111111111111111111111111111111111",
            sizeBytes: 1_000,
            publishedAt: "2026-08-26T12:00:00.000Z",
            seeders: 100,
            categories: [1000],
            indexerId: "indexer",
          },
          {
            guid: "auto-accepted",
            title: "Automatic Movie 2026 1080p",
            kind: "torrent",
            downloadUrl: "magnet:?xt=urn:btih:2222222222222222222222222222222222222222",
            sizeBytes: 2_000,
            publishedAt: "2026-08-26T12:00:00.000Z",
            seeders: 20,
            categories: [1000],
            indexerId: "indexer",
          },
        ],
      }),
    });
    const dispatched: string[] = [];
    container.register({
      pluginId: "dev.tantalar.plugin.torrent-native",
      capability: "dev.tantalar.capability.download-client",
      invoke: async (_operation, payload) => {
        dispatched.push(String(payload.title));
        return { downloadId: "tn-auto", itemKey: "movie-auto", state: "queued", progressPercent: 0, sizeBytes: 2_000 };
      },
    });

    const interactive = await searchManagedReleases(container, decisions, "movie", "movie-auto", "interactive", undefined, bus);
    const automatic = await searchManagedReleases(container, decisions, "movie", "movie-auto", "automatic");
    expect(automatic.verdict.rejected).toEqual(interactive.verdict.rejected);
    expect(automatic.verdict.assessments).toEqual(interactive.verdict.assessments);
    expect(interactive.verdict.rejected).toContainEqual({ guid: "auto-rejected", reason: "quality_below_profile" });
    expect(await listManagedWanted(container)).toEqual([{
      kind: "movie",
      id: "movie-auto",
      itemKey: "movie-auto",
      query: "Automatic Movie 2026",
    }]);
    expect(await runAutomaticAcquisition(container, decisions, jobs, bus)).toMatchObject({ searched: 1, grabbed: 1 });
    expect(dispatched).toEqual(["Automatic Movie 2026 1080p"]);
    expect((await jobs.list())[0]).toMatchObject({ itemKey: "movie-auto", providerJobId: "tn-auto" });
    expect((await decisions.listForItem("movie-auto"))[0]).toMatchObject({ mode: "automatic", outcome: "accepted", guid: "auto-accepted" });
    const snapshots = await bus.read({ typePrefix: "dev.tantalar.event.release.decision.recorded" });
    expect(snapshots.map((event) => event.payload.mode)).toEqual(["interactive", "automatic"]);
    expect(snapshots[0]?.payload.assessments).toEqual(expect.arrayContaining([
      expect.objectContaining({
        accepted: false,
        reasons: [{ code: "quality_below_profile", message: "Rejected: quality below the profile minimum" }],
      }),
      expect.objectContaining({
        accepted: true,
        reasons: expect.arrayContaining([
          { code: "preferred_quality", message: "Quality matches the monitoring profile" },
          { code: "best_quality_available", message: "Best quality available (1080p)" },
        ]),
      }),
    ]));
    expect(JSON.stringify(snapshots)).not.toContain("magnet:");
    expect(JSON.stringify(snapshots)).not.toContain("auto-accepted");
  });

  it("keeps every failing policy reason when availability rejects a candidate", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tantalar-unavailable-acquisition-"));
    db = await openDatabase({ dialect: "sqlite", sqlitePath: join(dir, "test.db") });
    await migrate(db);
    const decisions = new ReleaseDecisionStore(db);
    const container = new ServiceContainer();
    container.register({
      pluginId: "movies",
      capability: "dev.tantalar.capability.automation.movies",
      invoke: async () => ({
        movieId: "movie-future",
        title: "Future Movie",
        year: 2999,
        availableAt: "2999-01-01",
        minimumAvailability: "released",
        profile: {
          name: "restricted",
          preferredQualities: ["1080p"],
          maxSizeBytes: 1_000,
          minSeeders: 10,
          preferredLanguages: ["en"],
        },
      }),
    });
    container.register({
      pluginId: "indexer",
      capability: "dev.tantalar.capability.indexer",
      invoke: async () => ({
        releases: [{
          guid: "unavailable-bad",
          title: "Future Movie 2999 720p",
          kind: "torrent",
          downloadUrl: "magnet:?xt=urn:btih:3333333333333333333333333333333333333333",
          sizeBytes: 2_000,
          publishedAt: "2026-08-26T12:00:00.000Z",
          seeders: 1,
          language: "de",
          categories: [1000],
          indexerId: "indexer",
        }],
      }),
    });

    const result = await searchManagedReleases(container, decisions, "movie", "movie-future", "automatic");

    expect(result.verdict.assessments).toEqual([{
      guid: "unavailable-bad",
      accepted: false,
      reasons: [
        "size_exceeds_limit",
        "seeders_below_minimum",
        "quality_below_profile",
        "language_not_allowed",
        "availability_not_met",
      ],
    }]);
    expect(result.verdict.rejected).toEqual([{
      guid: "unavailable-bad",
      reason: "size_exceeds_limit",
    }]);
  });
});
