import { describe, expect, it } from "vitest";
import { catalogIdentity, identifyCatalogFile } from "../apps/server/src/catalog-identification.js";
import { ServiceContainer } from "../apps/server/src/container.js";

describe("local catalog identification", () => {
  it("parses titles and episodes and preserves explicit corrections", () => {
    expect(catalogIdentity("/Movies/2 Fast 2 Furious (2003) Bluray-1080p.mkv")).toEqual({ title: "2 Fast 2 Furious", year: 2003, kind: "movie" });
    expect(catalogIdentity("/Movies/Lanterns - S01E01 - Pilot WEBDL-2160p Proper.mkv")).toEqual({ title: "Lanterns", kind: "series", episodeKey: "S01E01" });
    expect(catalogIdentity("Example S01E01.mkv", "movie-example").kind).toBe("movie");
    expect(catalogIdentity("Pilot.mkv", "", "series").kind).toBe("series");
    expect(catalogIdentity("2001 A Space Odyssey (1968).mkv")).toMatchObject({ title: "2001 A Space Odyssey", year: 1968 });
  });

  it("links exact local metadata without enabling downloads and rejects ambiguous matches", async () => {
    const container = new ServiceContainer();
    const candidate = { kind: "series", name: "Lanterns", externalId: "123", provider: "tmdb", artworkUrl: "https://image.tmdb.org/t/p/w342/poster.jpg" };
    let candidates = [candidate];
    const calls: Array<{ operation: string; payload: Record<string, unknown> }> = [];
    container.register({ pluginId: "metadata", capability: "dev.tantalar.capability.metadata-provider", invoke: async (operation) => operation === "search" ? { candidates } : { found: true, metadata: candidate, episodes: [{ season: 1, episode: 1 }] } });
    container.register({ pluginId: "series", capability: "dev.tantalar.capability.automation.series", invoke: async (operation, payload) => {
      calls.push({ operation, payload });
      return operation === "list-series" ? { series: [] } : operation === "add-series" ? { seriesId: "series-lanterns" } : { marked: true };
    } });
    expect(await identifyCatalogFile(container, "Lanterns.S01E01.mkv", "local")).toBe("series-lanterns:S01E01");
    expect(calls.find(call => call.operation === "add-series")?.payload).toMatchObject({ monitored: false, monitorMode: "none", destinationLibraryId: "local", artworkUrl: candidate.artworkUrl });
    candidates = [candidate, { ...candidate, externalId: "456" }];
    expect(await identifyCatalogFile(container, "Lanterns.S01E01.mkv", "local")).toBeNull();
  });
});
