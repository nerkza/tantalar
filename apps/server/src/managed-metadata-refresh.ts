import { createHash } from "node:crypto";
import type { ServiceContainer } from "./container.js";
import { createMovieMetadataService } from "./movie-metadata.js";

/** Same identity and manual-field safeguards for operator and scheduled refresh. */
export async function refreshManagedMetadata(container: ServiceContainer, kind: "movie" | "series", id: string, reviewToken?: string) {
  const { resolveMovieSnapshot, safeArtworkSource } = createMovieMetadataService(container);
  const moviesProvider = () => container.resolve("dev.tantalar.capability.automation.movies");
  const seriesProvider = () => container.resolve("dev.tantalar.capability.automation.series");
  const metadataProvider = () => container.resolve("dev.tantalar.capability.metadata-provider");
  const getManagedRecord = async (kind: "movie" | "series", id: string) => (kind === "movie" ? moviesProvider() : seriesProvider()).invoke(kind === "movie" ? "get-movie" : "get-series", kind === "movie" ? { movieId: id } : { seriesId: id }) as Promise<Record<string, unknown>>;
  const current = await getManagedRecord(kind, id);
  const externalId = String(current.externalId ?? "");
  const provider = String(current.provider ?? "");
  const name = String((kind === "movie" ? current.title : current.name) ?? "");
  if (!externalId || !provider || !name) throw Object.assign(new Error(({ error: "This item has no provider identity." }).error), { statusCode: 409, ...{ error: "This item has no provider identity." } });
  const details = kind === "series"
    ? await metadataProvider().invoke("details", { kind, externalId, name, refresh: true }) as { found?: boolean; metadata?: Record<string, unknown>; episodes?: unknown[] }
    : null;
  const snapshot = kind === "movie" ? await resolveMovieSnapshot(current, true) : null;
  if (kind === "movie" && !snapshot) throw Object.assign(new Error(({ error: "The provider no longer returns this title." }).error), { statusCode: 404, ...{ error: "The provider no longer returns this title." } });
  if (kind === "series" && (!details?.found || !details.metadata)) throw Object.assign(new Error(({ error: "The provider no longer returns this title." }).error), { statusCode: 404, ...{ error: "The provider no longer returns this title." } });
  const metadata = kind === "movie" ? snapshot! : details!.metadata!;
  if (metadata.kind !== kind || metadata.externalId !== externalId || metadata.provider !== provider) {
    throw Object.assign(new Error(({ error: "The provider returned a different identity. Existing matches were kept." }).error), { statusCode: 409, ...{ error: "The provider returned a different identity. Existing matches were kept." } });
  }
  const manualFields = new Set(Array.isArray(current.manualFields) ? current.manualFields.map(String) : []);
  const refreshedName = manualFields.has("title") ? name : String(metadata.name ?? name);
  const refreshedYear = manualFields.has("year") ? current.year : metadata.year;
  const refreshedOverview = manualFields.has("overview") ? current.overview : metadata.overview;
  const refreshedArtwork = manualFields.has("artworkUrl") ? current.artworkUrl : safeArtworkSource(metadata.artworkUrl);
  const providerDate = kind === "movie" ? snapshot!.releaseDate : metadata.airDate;
  const refreshedAvailableAt = typeof providerDate === "string" && !Number.isNaN(Date.parse(providerDate))
    ? providerDate.slice(0, 32)
    : current.availableAt;
  if (kind === "series") {
    if (!Array.isArray(details!.episodes) || details!.episodes.length === 0) {
      throw Object.assign(new Error(({ error: "Series episode metadata is unavailable; existing metadata was kept." }).error), { statusCode: 409, ...{ error: "Series episode metadata is unavailable; existing metadata was kept." } });
    }
    const episodeKey = (episode: Record<string, unknown>) => String(episode.episodeKey ?? `S${String(episode.season).padStart(2, "0")}E${String(episode.episode).padStart(2, "0")}`);
    const previous = Array.isArray(current.episodes) ? current.episodes as Record<string, unknown>[] : [];
    const proposed = details!.episodes as Record<string, unknown>[];
    const acquired = new Set(Array.isArray(current.acquiredEpisodeKeys) ? current.acquiredEpisodeKeys.map(String) : []);
    const byKey = new Map(proposed.map(episode => [episodeKey(episode), episode]));
    const retained = previous.filter(episode => acquired.has(episodeKey(episode)) && !byKey.has(episodeKey(episode)));
    const changes = previous.flatMap(episode => {
      const key = episodeKey(episode);
      const next = byKey.get(key);
      if (!next && acquired.has(key)) return [{ label: key, before: String(episode.title ?? episode.query ?? key), after: "Not returned by provider. Keep the local episode match." }];
      if (next && episode.externalId && next.externalId && episode.externalId !== next.externalId) {
        return [{ label: key, before: `${String(episode.title ?? key)} (${String(episode.airDate ?? "date unavailable")})`, after: `${String(next.title ?? key)} (${String(next.airDate ?? "date unavailable")}) — provider episode identity changed` }];
      }
      return [];
    });
    if (changes.length) {
      const token = createHash("sha256").update(JSON.stringify({ id, externalId, provider, previous, proposed })).digest("hex");
      if (reviewToken !== token) {
        throw Object.assign(new Error(({ error: "Review episode changes before refreshing metadata.", review: { token, changes } }).error), { statusCode: 409, ...{ error: "Review episode changes before refreshing metadata.", review: { token, changes } } });
      }
    }
    await seriesProvider().invoke("add-series", {
      externalId,
      provider,
      name: refreshedName,
      ...(typeof refreshedYear === "number" ? { year: refreshedYear } : {}),
      ...(typeof refreshedOverview === "string" ? { overview: refreshedOverview } : {}),
      ...(typeof refreshedArtwork === "string" ? { artworkUrl: refreshedArtwork } : {}),
      episodes: [...proposed, ...retained],
      profile: current.profile,
      monitorMode: current.monitorMode,
      destinationLibraryId: current.destinationLibraryId,
      minimumAvailability: current.minimumAvailability,
    });
    await seriesProvider().invoke("update-series", { seriesId: id, manualFields: [...manualFields] });
  } else {
    await moviesProvider().invoke("update-movie", {
      movieId: id,
      title: refreshedName,
      ...(typeof refreshedYear === "number" ? { year: refreshedYear } : {}),
      ...(typeof refreshedOverview === "string" ? { overview: refreshedOverview } : { overview: null }),
      ...(typeof refreshedArtwork === "string" ? { artworkUrl: refreshedArtwork } : { artworkUrl: null }),
      ...(typeof refreshedAvailableAt === "string" ? { availableAt: refreshedAvailableAt } : {}),
      manualFields: [...manualFields],
    });
  }
  return { provider, externalId };
}

