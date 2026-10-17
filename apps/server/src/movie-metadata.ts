import { createHash } from "node:crypto";
import type { EpisodeMetadata, MediaMetadataSnapshot } from "@tantalar/contracts";
import type { ServiceContainer } from "./container.js";

/** Shared provider snapshots and artwork for Control and authorized library items. */
export function createMovieMetadataService(container: ServiceContainer) {
  const metadataProvider = () => container.resolve("dev.tantalar.capability.metadata-provider");
  const artworkSources = new Map<string, string>();
  const artworkCache = new Map<string, { body: Buffer; contentType: string; expiresAt: number }>();

  const safeArtworkSource = (value: unknown): string | null => {
    if (typeof value !== "string") return null;
    try {
      const url = new URL(value);
      return url.protocol === "https:" && ["image.tmdb.org", "fixtures.tantalar.invalid"].includes(url.hostname)
        ? url.toString()
        : null;
    } catch {
      return null;
    }
  };

  const artworkPath = (source: string): string => {
    const key = createHash("sha256").update(source).digest("hex");
    artworkSources.set(key, source);
    return `/api/v1/acquisition/artwork/${key}`;
  };

  const fetchArtwork = async (source: string) => {
    const key = createHash("sha256").update(source).digest("hex");
    const cached = artworkCache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached;
    const response = await fetch(source, { redirect: "error", signal: AbortSignal.timeout(5_000) });
    const contentType = response.headers.get("content-type")?.split(";")[0]?.trim() ?? "";
    const contentLength = Number(response.headers.get("content-length") ?? 0);
    if (!response.ok || !["image/jpeg", "image/png", "image/webp"].includes(contentType) || contentLength > 5_000_000) {
      throw new Error("artwork unavailable");
    }
    const body = Buffer.from(await response.arrayBuffer());
    if (body.byteLength > 5_000_000) throw new Error("artwork unavailable");
    while (artworkCache.size >= 100) artworkCache.delete(artworkCache.keys().next().value!);
    const entry = { body, contentType, expiresAt: Date.now() + 60 * 60 * 1_000 };
    artworkCache.set(key, entry);
    return entry;
  };

  const normalizeCandidate = (value: unknown) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const input = value as Record<string, unknown>;
    const kind = input.kind === "movie" ? "movie" : input.kind === "series" ? "series" : null;
    const externalId = typeof input.externalId === "string" ? input.externalId.slice(0, 200) : "";
    const title = typeof input.name === "string" ? input.name.slice(0, 300) : "";
    const provider = typeof input.provider === "string" ? input.provider.slice(0, 80) : "";
    if (!kind || !externalId || !title || !provider) return null;
    const artworkSource = safeArtworkSource(input.artworkUrl);
    const availableAt = typeof input.airDate === "string" && !Number.isNaN(Date.parse(input.airDate))
      ? input.airDate.slice(0, 10)
      : undefined;
    return {
      kind,
      externalId,
      title,
      provider,
      year: typeof input.year === "number" && Number.isFinite(input.year) ? Math.trunc(input.year) : null,
      overview: typeof input.overview === "string" ? input.overview.slice(0, 5000) : "",
      ...(artworkSource ? { artworkUrl: artworkPath(artworkSource) } : {}),
      ...(availableAt ? { availableAt } : {}),
    };
  };

  const snapshotText = (value: unknown, max: number): string | null =>
    typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null;
  const snapshotPath = (value: unknown): string | null => {
    const path = snapshotText(value, 500);
    return path && /^\/[A-Za-z0-9_./-]+$/.test(path) ? path : null;
  };
  const normalizeMovieSnapshot = (value: unknown): MediaMetadataSnapshot | null => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const input = value as Record<string, unknown>;
    const externalId = snapshotText(input.externalId, 200);
    const name = snapshotText(input.name, 300);
    const provider = snapshotText(input.provider, 80);
    const locale = snapshotText(input.locale, 20);
    const fetchedAt = snapshotText(input.fetchedAt, 48);
    const source = input.source === "direct" || input.source === "fixture" ? input.source : input.source === "hosted" ? "hosted" : null;
    if ((input.kind !== "movie" && input.kind !== "series") || !externalId || !name || !provider || !locale || !fetchedAt || !source || Number.isNaN(Date.parse(fetchedAt))) return null;
    const externalIds = input.externalIds && typeof input.externalIds === "object" && !Array.isArray(input.externalIds)
      ? Object.fromEntries(Object.entries(input.externalIds as Record<string, unknown>)
          .slice(0, 20)
          .flatMap(([key, value]) => {
            const id = snapshotText(value, 200);
            return id ? [[key.slice(0, 40), id]] : [];
          }))
      : {};
    const releaseDate = typeof input.releaseDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(input.releaseDate) ? input.releaseDate : null;
    const year = typeof input.year === "number" && Number.isInteger(input.year) && input.year >= 1800 && input.year <= 3000 ? input.year : null;
    const runtimeMinutes = typeof input.runtimeMinutes === "number" && Number.isInteger(input.runtimeMinutes) && input.runtimeMinutes > 0 && input.runtimeMinutes <= 10_000 ? input.runtimeMinutes : null;
    const rating = typeof input.rating === "number" && Number.isFinite(input.rating) && input.rating >= 0 && input.rating <= 10 ? input.rating : null;
    const voteCount = typeof input.voteCount === "number" && Number.isFinite(input.voteCount) && input.voteCount > 0 ? Math.trunc(input.voteCount) : 0;
    const artworkUrl = safeArtworkSource(input.artworkUrl);
    return {
      externalId,
      kind: input.kind,
      name,
      originalTitle: snapshotText(input.originalTitle, 300),
      overview: typeof input.overview === "string" ? input.overview.slice(0, 5000) : "",
      tagline: snapshotText(input.tagline, 1000),
      releaseDate,
      ...(input.kind === "series" ? { lastAirDate: typeof input.lastAirDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(input.lastAirDate) ? input.lastAirDate : null } : {}),
      year,
      ...(releaseDate ? { airDate: releaseDate } : {}),
      runtimeMinutes,
      genres: Array.isArray(input.genres)
        ? [...new Set(input.genres.map((genre) => snapshotText(genre, 80)).filter((genre): genre is string => genre !== null))].slice(0, 40)
        : [],
      actors: Array.isArray(input.actors) ? [...new Set(input.actors.map(value => snapshotText(value, 160)).filter((value): value is string => value !== null))].slice(0, 100) : [],
      directors: Array.isArray(input.directors) ? [...new Set(input.directors.map(value => snapshotText(value, 160)).filter((value): value is string => value !== null))].slice(0, 20) : [],
      certification: snapshotText(input.certification, 40),
      status: snapshotText(input.status, 80),
      originalLanguage: snapshotText(input.originalLanguage, 20),
      rating,
      voteCount,
      posterPath: snapshotPath(input.posterPath),
      backdropPath: snapshotPath(input.backdropPath),
      ...(artworkUrl ? { artworkUrl } : {}),
      externalIds,
      provider,
      locale,
      fetchedAt,
      source,
    };
  };
  const publicMovieSnapshot = ({ artworkUrl: _artworkUrl, ...snapshot }: MediaMetadataSnapshot) => snapshot;
  const resolveMovieSnapshot = async (record: Record<string, unknown>, refresh = false): Promise<MediaMetadataSnapshot | null> => {
    const externalId = snapshotText(record.externalId, 200);
    const provider = snapshotText(record.provider, 80);
    if (!externalId || !provider) return null;
    const kind = record.kind === "series" || record.seriesId ? "series" : "movie";
    const response = await metadataProvider().invoke("details", {
      kind,
      externalId,
      name: snapshotText(record.title ?? record.name, 300) ?? "",
      ...(kind === "series" ? { metadataOnly: true } : {}),
      ...(refresh ? { refresh: true } : {}),
    }) as { found?: boolean; metadata?: unknown };
    const snapshot = response.found ? normalizeMovieSnapshot(response.metadata) : null;
    return snapshot?.kind === kind && snapshot.externalId === externalId && snapshot.provider === provider ? snapshot : null;
  };

  const getManagedRecord = async (kind: "movie" | "series", id: string) => container
    .resolve(`dev.tantalar.capability.automation.${kind === "movie" ? "movies" : "series"}`)
    .invoke(kind === "movie" ? "get-movie" : "get-series", kind === "movie" ? { movieId: id } : { seriesId: id }) as Promise<Record<string, unknown>>;

  const artworkSource = (record: Record<string, unknown>, snapshot: MediaMetadataSnapshot | null, variant: "poster" | "backdrop") => {
    // Manual poster changes (including removal) take precedence over provider artwork.
    if (variant === "poster" && Array.isArray(record.manualFields) && record.manualFields.includes("artworkUrl")) {
      return safeArtworkSource(record.artworkUrl);
    }
    const path = variant === "poster" ? snapshot?.posterPath : snapshot?.backdropPath;
    if (snapshot?.provider === "tmdb" && path) {
      return `https://image.tmdb.org/t/p/${variant === "poster" ? "w342" : "w780"}${path}`;
    }
    return variant === "poster" ? safeArtworkSource(record.artworkUrl) : null;
  };

  const publicEpisode = (value: unknown): (Partial<EpisodeMetadata> & { episodeKey: string; title: string }) | null => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const episode = value as Record<string, unknown>;
    if (typeof episode.episodeKey !== "string" || !/^S\d{2,3}E\d{2,4}$/.test(episode.episodeKey)) return null;
    return {
      episodeKey: episode.episodeKey,
      title: snapshotText(episode.title, 300) ?? snapshotText(episode.query, 300) ?? episode.episodeKey,
      ...(typeof episode.airDate === "string" ? { airDate: episode.airDate.slice(0, 10) } : {}),
      ...(typeof episode.runtimeMinutes === "number" && episode.runtimeMinutes > 0 ? { runtimeMinutes: episode.runtimeMinutes } : {}),
      ...(typeof episode.overview === "string" ? { overview: episode.overview.slice(0, 5000) } : {}),
      ...(typeof episode.externalId === "string" ? { externalId: episode.externalId.slice(0, 200) } : {}),
    };
  };

  const episodeFor = (record: Record<string, unknown>, itemKey: string) => Array.isArray(record.episodes)
    ? record.episodes.find((episode: Record<string, unknown>) => episode.episodeKey === itemKey.split(":")[1]) as Record<string, unknown> | undefined : undefined;
  const episodeArtwork = (record: Record<string, unknown>, episode: Record<string, unknown> | undefined) => {
    const path = snapshotPath(episode?.stillPath);
    return record.provider === "tmdb" && path ? `https://image.tmdb.org/t/p/w780${path}` : null;
  };

  const enrichItems = async <T extends { fileId: string; itemKey: string; kind?: string }>(items: T[]) => {
    const records = new Map<string, Promise<{ record: Record<string, unknown>; snapshot: MediaMetadataSnapshot | null } | null>>();
    return Promise.all(items.map(async (item) => {
      if (item.itemKey.startsWith("existing:")) return item;
      const kind = item.itemKey.startsWith("series-") ? "series" : "movie";
      const id = kind === "series" ? item.itemKey.split(":")[0]! : item.itemKey;
      let pending = records.get(id);
      if (!pending) {
        pending = getManagedRecord(kind, id).then(async (record) => ({
          record, snapshot: await resolveMovieSnapshot({ ...record, kind }).catch(() => null),
        })).catch(() => null);
        records.set(id, pending);
      }
      const resolved = await pending;
      if (!resolved) return item;
      const { record, snapshot } = resolved;
      const episode = kind === "series" ? episodeFor(record, item.itemKey) : undefined;
      const episodeDetails = publicEpisode(episode);
      return {
        ...item,
        kind,
        ...(typeof (record.title ?? record.name) === "string" ? { title: String(record.title ?? record.name).slice(0, 300) } : {}),
        ...(typeof record.year === "number" ? { year: record.year } : {}),
        ...(typeof record.overview === "string" ? { overview: record.overview.slice(0, 5000) } : {}),
        ...(artworkSource(record, snapshot, "poster") ? { artworkUrl: `/api/v1/library/${encodeURIComponent(item.fileId)}/artwork/poster` } : {}),
        ...(artworkSource(record, snapshot, "backdrop") ? { backdropUrl: `/api/v1/library/${encodeURIComponent(item.fileId)}/artwork/backdrop` } : {}),
        ...(snapshot ? { metadataSnapshot: publicMovieSnapshot(snapshot) } : {}),
        ...(episodeDetails ? { episode: episodeDetails } : {}),
        ...(episodeArtwork(record, episode) ? { backdropUrl: `/api/v1/library/${encodeURIComponent(item.fileId)}/artwork/backdrop` } : {}),
      };
    }));
  };

  const itemArtwork = async (itemKey: string, variant: "poster" | "backdrop") => {
    const kind = itemKey.startsWith("series-") ? "series" : "movie";
    const record = await getManagedRecord(kind, kind === "series" ? itemKey.split(":")[0]! : itemKey);
    const snapshot = await resolveMovieSnapshot({ ...record, kind }).catch(() => null);
    const source = (variant === "backdrop" ? episodeArtwork(record, episodeFor(record, itemKey)) : null) ?? artworkSource(record, snapshot, variant);
    if (!source) throw new Error("artwork unavailable");
    return fetchArtwork(source);
  };

  return { safeArtworkSource, artworkSources, artworkPath, fetchArtwork, normalizeCandidate, publicMovieSnapshot, publicEpisode, episodeArtwork, resolveMovieSnapshot, artworkSource, enrichItems, itemArtwork };
}
