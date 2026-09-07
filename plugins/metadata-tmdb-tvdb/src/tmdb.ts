/**
 * TMDB wire adapter (TAN-016). Pure functions: build query URLs and parse
 * trimmed TMDB API responses into the neutral MediaMetadata contract.
 * No network here; the plugin owns fetching through an injectable transport.
 * An optional direct-provider API key never appears in parsed output or errors.
 */

import type { EpisodeMetadata, MovieMetadataSnapshot, SeriesMetadataSnapshot } from "@tantalar/contracts";

export interface TmdbSearchMovie {
  id: number;
  title?: string;
  overview?: string;
  release_date?: string;
  poster_path?: string | null;
}

interface TmdbMovieDetails extends TmdbSearchMovie {
  credits?: { cast?: Array<{ name?: string }>; crew?: Array<{ name?: string; job?: string }> };
  original_title?: string;
  tagline?: string;
  runtime?: number | null;
  genres?: Array<{ name?: string }>;
  status?: string;
  original_language?: string;
  vote_average?: number;
  vote_count?: number;
  backdrop_path?: string | null;
  imdb_id?: string | null;
  external_ids?: {
    imdb_id?: string | null;
    wikidata_id?: string | null;
    facebook_id?: string | null;
    instagram_id?: string | null;
    twitter_id?: string | null;
  };
  release_dates?: {
    results?: Array<{
      iso_3166_1?: string;
      release_dates?: Array<{ certification?: string; type?: number }>;
    }>;
  };
}

export interface TmdbSearchShow {
  id: number;
  name?: string;
  overview?: string;
  first_air_date?: string;
  poster_path?: string | null;
}

export interface TmdbEpisode {
  id?: number;
  season_number?: number;
  episode_number?: number;
  name?: string;
  overview?: string;
  air_date?: string;
  runtime?: number | null;
  still_path?: string | null;
}

export interface TmdbSeasonSummary {
  season_number?: number;
  episode_count?: number;
}

export const TMDB_IMAGE_BASE = "https://image.tmdb.org/t/p/w342";

export function imageUrl(path: string | null | undefined): string | undefined {
  return path ? `${TMDB_IMAGE_BASE}${path}` : undefined;
}

function finishUrl(url: URL, apiKey: string, locale?: string): string {
  if (apiKey) url.searchParams.set("api_key", apiKey);
  if (locale) url.searchParams.set("language", locale);
  return url.toString();
}

export function movieSearchUrl(baseUrl: string, apiKey: string, query: string, year?: number, locale?: string): string {
  const u = new URL(`${baseUrl.replace(/\/$/, "")}/search/movie`);
  u.searchParams.set("query", query);
  if (year !== undefined) u.searchParams.set("year", String(year));
  return finishUrl(u, apiKey, locale);
}

export function showSearchUrl(baseUrl: string, apiKey: string, query: string, locale?: string): string {
  const u = new URL(`${baseUrl.replace(/\/$/, "")}/search/tv`);
  u.searchParams.set("query", query);
  return finishUrl(u, apiKey, locale);
}

export function showDetailsUrl(baseUrl: string, apiKey: string, tmdbId: number, locale?: string): string {
  const u = new URL(`${baseUrl.replace(/\/$/, "")}/tv/${encodeURIComponent(String(tmdbId))}`);
  return finishUrl(u, apiKey, locale);
}

export function movieDetailsUrl(baseUrl: string, apiKey: string, tmdbId: number, locale?: string): string {
  const u = new URL(`${baseUrl.replace(/\/$/, "")}/movie/${encodeURIComponent(String(tmdbId))}`);
  u.searchParams.set("append_to_response", "external_ids,release_dates,credits");
  return finishUrl(u, apiKey, locale);
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function date(value: unknown): string | null {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
}

function path(value: unknown): string | null {
  return typeof value === "string" && /^\/[A-Za-z0-9_./-]+$/.test(value) ? value : null;
}

function movieCertification(movie: TmdbMovieDetails, locale: string): string | null {
  const results = movie.release_dates?.results ?? [];
  const localeRegion = locale.split("-")[1]?.toUpperCase();
  const regions = [...new Set([localeRegion, "US", ...results.map((result) => result.iso_3166_1)].filter(Boolean))];
  for (const region of regions) {
    const releases = results.find((result) => result.iso_3166_1 === region)?.release_dates ?? [];
    const certification = [...releases]
      .sort((a, b) => (a.type === 3 ? 0 : a.type === 2 ? 1 : 2) - (b.type === 3 ? 0 : b.type === 2 ? 1 : 2))
      .map((release) => text(release.certification))
      .find((value): value is string => value !== null);
    if (certification) return certification;
  }
  return null;
}

export function movieSnapshot(
  payload: unknown,
  options: { externalId: string; locale: string; fetchedAt: string; source: MovieMetadataSnapshot["source"] },
): MovieMetadataSnapshot | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const movie = payload as TmdbMovieDetails;
  const title = text(movie.title);
  if (!Number.isInteger(movie.id) || !title || options.externalId !== `tmdb-${movie.id}`) return null;
  const releaseDate = date(movie.release_date);
  const posterPath = path(movie.poster_path);
  const backdropPath = path(movie.backdrop_path);
  const externalIds = Object.fromEntries([
    ["tmdb", String(movie.id)],
    ["imdb", text(movie.external_ids?.imdb_id) ?? text(movie.imdb_id)],
    ["wikidata", text(movie.external_ids?.wikidata_id)],
    ["facebook", text(movie.external_ids?.facebook_id)],
    ["instagram", text(movie.external_ids?.instagram_id)],
    ["twitter", text(movie.external_ids?.twitter_id)],
  ].filter((entry): entry is [string, string] => entry[1] !== null));
  return {
    externalId: options.externalId,
    kind: "movie",
    name: title,
    originalTitle: text(movie.original_title),
    overview: text(movie.overview) ?? "",
    tagline: text(movie.tagline),
    releaseDate,
    year: releaseDate ? Number(releaseDate.slice(0, 4)) : null,
    ...(releaseDate ? { airDate: releaseDate } : {}),
    runtimeMinutes: typeof movie.runtime === "number" && Number.isFinite(movie.runtime) && movie.runtime > 0 ? Math.trunc(movie.runtime) : null,
    genres: [...new Set((movie.genres ?? []).map((genre) => text(genre.name)).filter((name): name is string => name !== null))],
    actors: Array.isArray(movie.credits?.cast) ? [...new Set(movie.credits.cast.map(person => text(person?.name)).filter((name): name is string => name !== null))].slice(0, 100) : [],
    directors: Array.isArray(movie.credits?.crew) ? [...new Set(movie.credits.crew.filter(person => person?.job === "Director").map(person => text(person.name)).filter((name): name is string => name !== null))].slice(0, 20) : [],
    certification: movieCertification(movie, options.locale),
    status: text(movie.status),
    originalLanguage: text(movie.original_language),
    rating: typeof movie.vote_average === "number" && Number.isFinite(movie.vote_average) ? movie.vote_average : null,
    voteCount: typeof movie.vote_count === "number" && Number.isFinite(movie.vote_count) && movie.vote_count > 0 ? Math.trunc(movie.vote_count) : 0,
    posterPath,
    backdropPath,
    ...(posterPath ? { artworkUrl: imageUrl(posterPath) } : {}),
    externalIds,
    provider: "tmdb",
    locale: options.locale,
    fetchedAt: options.fetchedAt,
    source: options.source,
  };
}

export function seasonUrl(baseUrl: string, apiKey: string, tmdbId: number, season: number, locale?: string): string {
  const u = new URL(`${baseUrl.replace(/\/$/, "")}/tv/${encodeURIComponent(String(tmdbId))}/season/${season}`);
  return finishUrl(u, apiKey, locale);
}

export function seriesSnapshot(payload: unknown, options: Parameters<typeof movieSnapshot>[1]): SeriesMetadataSnapshot | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const show = payload as TmdbMovieDetails & TmdbSearchShow & { original_name?: string; last_air_date?: string; episode_run_time?: number[] };
  const snapshot = movieSnapshot({
    ...show, title: show.name, original_title: show.original_name, release_date: show.first_air_date,
    runtime: Array.isArray(show.episode_run_time) ? show.episode_run_time.find(value => Number.isInteger(value) && value > 0 && value <= 10_000) : null,
  }, options);
  return snapshot ? { ...snapshot, kind: "series", lastAirDate: date(show.last_air_date) } : null;
}

export interface TmdbSearchHit {
  id: number;
  title: string;
  overview: string;
  year: number | null;
  airDate?: string;
  artworkUrl?: string;
}

export function movieHits(payload: unknown): TmdbSearchHit[] {
  const results = (payload as { results?: TmdbSearchMovie[] } | null)?.results ?? [];
  return results.flatMap((hit) =>
    typeof hit.id === "number" && hit.title
      ? [{
          id: hit.id,
          title: hit.title,
          overview: hit.overview ?? "",
          year: hit.release_date ? Number(hit.release_date.slice(0, 4)) : null,
          ...(hit.release_date ? { airDate: hit.release_date } : {}),
          ...(imageUrl(hit.poster_path) ? { artworkUrl: imageUrl(hit.poster_path) } : {}),
        }]
      : [],
  );
}

export function firstMovieHit(payload: unknown): TmdbSearchHit | null {
  return movieHits(payload)[0] ?? null;
}

export function showHits(payload: unknown): TmdbSearchHit[] {
  const results = (payload as { results?: TmdbSearchShow[] } | null)?.results ?? [];
  return results.flatMap((hit) =>
    typeof hit.id === "number" && hit.name
      ? [{
          id: hit.id,
          title: hit.name,
          overview: hit.overview ?? "",
          year: hit.first_air_date ? Number(hit.first_air_date.slice(0, 4)) : null,
          ...(hit.first_air_date ? { airDate: hit.first_air_date } : {}),
          ...(imageUrl(hit.poster_path) ? { artworkUrl: imageUrl(hit.poster_path) } : {}),
        }]
      : [],
  );
}

export function firstShowHit(payload: unknown): TmdbSearchHit | null {
  return showHits(payload)[0] ?? null;
}

export function seriesSeasons(payload: unknown): Array<{ season: number; episodeCount: number }> {
  const seasons = (payload as { seasons?: TmdbSeasonSummary[] } | null)?.seasons ?? [];
  return seasons.flatMap((item) =>
    Number.isInteger(item.season_number) && Number.isInteger(item.episode_count) && Number(item.episode_count) > 0
      ? [{ season: Number(item.season_number), episodeCount: Number(item.episode_count) }]
      : [],
  );
}

export function episodesFromSeason(payload: unknown): EpisodeMetadata[] {
  const episodes = (payload as { episodes?: TmdbEpisode[] } | null)?.episodes ?? [];
  return episodes.flatMap((item) =>
    item && Number.isInteger(item.season_number) && Number(item.season_number) >= 0 && Number.isInteger(item.episode_number) && Number(item.episode_number) > 0
      ? [{
          season: Number(item.season_number),
          episode: Number(item.episode_number),
          title: typeof item.name === "string" && item.name.trim() ? item.name.trim().slice(0, 300) : `Episode ${String(item.episode_number)}`,
          ...(Number.isSafeInteger(item.id) && Number(item.id) > 0 ? { externalId: `tmdb-${item.id}` } : {}),
          ...(date(item.air_date) ? { airDate: date(item.air_date)! } : {}),
          ...(typeof item.overview === "string" ? { overview: item.overview.slice(0, 5000) } : {}),
          ...(Number.isInteger(item.runtime) && Number(item.runtime) > 0 && Number(item.runtime) <= 10_000 ? { runtimeMinutes: Number(item.runtime) } : {}),
          ...(typeof item.still_path === "string" && /^\/[A-Za-z0-9_./-]+$/.test(item.still_path) ? { stillPath: item.still_path.slice(0, 500) } : {}),
        }]
      : [],
  );
}

export function episodeFromSeason(payload: unknown, episodeNumber: number): { title: string; overview: string; airDate?: string } | null {
  const episodes = (payload as { episodes?: TmdbEpisode[] } | null)?.episodes ?? [];
  const ep = episodes.find((e) => e.episode_number === episodeNumber);
  if (!ep) return null;
  return {
    title: ep.name ?? `Episode ${episodeNumber}`,
    overview: ep.overview ?? "",
    ...(ep.air_date ? { airDate: ep.air_date } : {}),
  };
}
