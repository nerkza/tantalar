import { describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import { ServiceContainer } from "../apps/server/src/container.js";
import { createMovieMetadataService } from "../apps/server/src/movie-metadata.js";
import { registerServingRoutes } from "../apps/server/src/serving.js";
import { episodesFromSeason, seriesSnapshot } from "../plugins/metadata-tmdb-tvdb/src/tmdb.js";
const Fastify = createRequire(new URL("../apps/server/package.json", import.meta.url))("fastify");

describe("movie presentation", () => {
  it("normalizes episode facts without inventing runtimes or accepting remote still URLs", () => {
    const episodes = episodesFromSeason({ episodes: [
      { id: 123, season_number: 1, episode_number: 2, name: "Episode title", air_date: "2026-01-02", runtime: 47, still_path: "/still.jpg", overview: "Summary" },
      { season_number: 1, episode_number: 3, runtime: 0, still_path: "https://untrusted.invalid/still.jpg", air_date: "unknown" },
      { season_number: -1, episode_number: 0 },
    ] });
    expect(episodes).toEqual([
      { season: 1, episode: 2, title: "Episode title", externalId: "tmdb-123", airDate: "2026-01-02", runtimeMinutes: 47, stillPath: "/still.jpg", overview: "Summary" },
      { season: 1, episode: 3, title: "Episode 3" },
    ]);
  });
  it("shares series facts without fetching topology and rejects mismatched provider identities", async () => {
    const options = { externalId: "tmdb-12", locale: "en-GB", fetchedAt: "2026-09-06T12:00:00Z", source: "hosted" as const };
    const payload = { id: 12, name: "Series", first_air_date: "2024-01-01", last_air_date: "2026-09-01", episode_run_time: [0, 48], genres: [{ name: "Drama" }], status: "Returning Series", vote_average: 8, vote_count: 100, backdrop_path: "/series.jpg" };
    const snapshot = seriesSnapshot(payload, options)!;
    expect(snapshot).toMatchObject({ kind: "series", runtimeMinutes: 48, releaseDate: "2024-01-01", lastAirDate: "2026-09-01", genres: ["Drama"], status: "Returning Series", rating: 8 });
    expect(seriesSnapshot({ ...payload, id: 13 }, options)).toBeNull();
    expect(seriesSnapshot({ ...payload, episode_run_time: [] }, options)?.runtimeMinutes).toBeNull();
    const container = new ServiceContainer();
    const invoke = vi.fn(async () => ({ found: true, metadata: snapshot }));
    container.register({ pluginId: "metadata", capability: "dev.tantalar.capability.metadata-provider", invoke });
    container.register({ pluginId: "series", capability: "dev.tantalar.capability.automation.series", invoke: async () => ({ seriesId: "series-12", externalId: "tmdb-12", provider: "tmdb", name: "Manual series", overview: "Manual overview" }) });
    const service = createMovieMetadataService(container);
    const items = await service.enrichItems([{ fileId: "episode", itemKey: "series-12:S01E01" }]);
    expect(items[0]).toMatchObject({ title: "Manual series", overview: "Manual overview", metadataSnapshot: { kind: "series", runtimeMinutes: 48 }, backdropUrl: "/api/v1/library/episode/artwork/backdrop" });
    expect(invoke).toHaveBeenCalledWith("details", expect.objectContaining({ kind: "series", metadataOnly: true }));
    expect(await service.resolveMovieSnapshot({ externalId: "tmdb-12", provider: "tmdb", kind: "movie" })).toBeNull();
  });

  it("uses the series identity and poster for a cataloged episode", async () => {
    const container = new ServiceContainer();
    const invoke = vi.fn(async () => ({ name: "Lanterns", overview: "Series overview", year: 2026, artworkUrl: "https://image.tmdb.org/t/p/w342/lanterns.jpg" }));
    container.register({ pluginId: "series", capability: "dev.tantalar.capability.automation.series", invoke });
    const items = await createMovieMetadataService(container).enrichItems([{ fileId: "episode", itemKey: "series-lanterns:S01E01", kind: "movie" }]);
    expect(invoke).toHaveBeenCalledWith("get-series", { seriesId: "series-lanterns" });
    expect(items[0]).toMatchObject({ title: "Lanterns", kind: "series", artworkUrl: "/api/v1/library/episode/artwork/poster", overview: "Series overview" });
  });
  it("shares provider facts, preserves overrides, bounds artwork, and keeps legacy items readable", async () => {
    const container = new ServiceContainer();
    const record = { provider: "tmdb", externalId: "tmdb-1", title: "Manual title", year: 1999, overview: "Manual overview", manualFields: ["title", "overview", "artworkUrl"], artworkUrl: null };
    const invoke = vi.fn(async () => record);
    container.register({ pluginId: "movies", capability: "dev.tantalar.capability.automation.movies", invoke });
    container.register({ pluginId: "metadata", capability: "dev.tantalar.capability.metadata-provider", invoke: async () => ({
      found: true, metadata: {
        kind: "movie", provider: "tmdb", externalId: "tmdb-1", name: "Provider title", overview: "Provider overview", year: 2026,
        runtimeMinutes: 101, posterPath: "/poster.jpg", backdropPath: "/backdrop.jpg", genres: ["Drama"],
        locale: "en-GB", fetchedAt: "2026-09-05T00:00:00Z", source: "hosted",
      },
    }) });
    const metadata = createMovieMetadataService(container);
    const items = [{ fileId: "f1", itemKey: "movie-1", kind: "movie", title: "Old title" }, { fileId: "f2", itemKey: "movie-1", kind: "movie", title: "Old title" }];
    const result = await metadata.enrichItems(items);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(result[0]).toMatchObject({ title: "Manual title", year: 1999, overview: "Manual overview", metadataSnapshot: { name: "Provider title", runtimeMinutes: 101 } });
    expect(result[0]).not.toHaveProperty("artworkUrl");
    expect(result[0]).toHaveProperty("backdropUrl", "/api/v1/library/f1/artwork/backdrop");
    expect(JSON.stringify(result)).not.toContain("image.tmdb.org");
    const snapshot = await metadata.resolveMovieSnapshot(record);
    expect(metadata.artworkSource({}, snapshot, "poster")).toBe("https://image.tmdb.org/t/p/w342/poster.jpg");
    expect(metadata.artworkSource({}, snapshot, "backdrop")).toBe("https://image.tmdb.org/t/p/w780/backdrop.jpg");
    expect(metadata.safeArtworkSource("https://evil.invalid/a.jpg")).toBeNull();
    expect(await createMovieMetadataService(new ServiceContainer()).enrichItems(items)).toEqual(items);
  });

  it("checks library access before artwork and after grant revocation", async () => {
    const app = Fastify();
    let permitted = true;
    const artwork = vi.fn(async () => ({ body: Buffer.from("fixture"), contentType: "image/jpeg" }));
    const enrichItems = vi.fn(async <T extends { fileId: string; itemKey: string }>(items: T[]) => items);
    registerServingRoutes(app, {
      requireAuth: async (_request, _reply, scope) => {
        expect(scope).toBe("serving.read");
        return { kind: "session", scopes: [], userId: "viewer", role: "viewer" };
      },
      invoke: async (operation) => {
        if (operation === "browse") return { items: permitted ? [{ fileId: "visible", itemKey: "movie-1", kind: "movie" }] : [], collections: [], continueWatching: [] };
        if (!permitted) throw new Error("forbidden");
        return { allowed: true };
      },
      artwork, enrichItems, resolvePath: () => null, mediaRoots: [],
    });
    try {
      expect((await app.inject("/api/v1/library")).statusCode).toBe(200);
      expect(enrichItems).toHaveBeenLastCalledWith([{ fileId: "visible", itemKey: "movie-1", kind: "movie" }]);
      const image = await app.inject("/api/v1/library/visible/artwork/poster");
      expect(image.statusCode).toBe(200);
      expect(image.headers["cache-control"]).toBe("private, no-store");
      permitted = false;
      expect((await app.inject("/api/v1/library/visible/artwork/poster")).statusCode).toBe(403);
      expect(artwork).toHaveBeenCalledTimes(1);
      await app.inject("/api/v1/library");
      expect(enrichItems).toHaveBeenLastCalledWith([]);
      expect((await app.inject("/api/v1/library/visible/artwork/original")).statusCode).toBe(400);
    } finally { await app.close(); }
  });
});
