/**
 * TMDB wire adapter (TAN-016). Pure functions: build query URLs and parse
 * trimmed TMDB API responses into the neutral MediaMetadata contract.
 * No network here; the plugin owns fetching through an injectable transport.
 * The api key never appears in parsed output or errors.
 */

export interface TmdbSearchMovie {
  id: number;
  title?: string;
  overview?: string;
  release_date?: string;
  poster_path?: string | null;
}

export interface TmdbSearchShow {
  id: number;
  name?: string;
  overview?: string;
  first_air_date?: string;
  poster_path?: string | null;
}

export interface TmdbEpisode {
  season_number?: number;
  episode_number?: number;
  name?: string;
  overview?: string;
  air_date?: string;
}

export const TMDB_IMAGE_BASE = "https://image.tmdb.org/t/p/w342";

export function imageUrl(path: string | null | undefined): string | undefined {
  return path ? `${TMDB_IMAGE_BASE}${path}` : undefined;
}

export function movieSearchUrl(baseUrl: string, apiKey: string, query: string, year?: number): string {
  const u = new URL(`${baseUrl.replace(/\/$/, "")}/search/movie`);
  u.searchParams.set("api_key", apiKey);
  u.searchParams.set("query", query);
  if (year !== undefined) u.searchParams.set("year", String(year));
  return u.toString();
}

export function showSearchUrl(baseUrl: string, apiKey: string, query: string): string {
  const u = new URL(`${baseUrl.replace(/\/$/, "")}/search/tv`);
  u.searchParams.set("api_key", apiKey);
  u.searchParams.set("query", query);
  return u.toString();
}

export function seasonUrl(baseUrl: string, apiKey: string, tmdbId: number, season: number): string {
  const u = new URL(`${baseUrl.replace(/\/$/, "")}/tv/${encodeURIComponent(String(tmdbId))}/season/${season}`);
  u.searchParams.set("api_key", apiKey);
  return u.toString();
}

export function firstMovieHit(payload: unknown): { id: number; title: string; overview: string; year: number | null; airDate?: string; artworkUrl?: string } | null {
  const results = (payload as { results?: TmdbSearchMovie[] } | null)?.results ?? [];
  const hit = results[0];
  if (!hit || typeof hit.id !== "number" || !hit.title) return null;
  return {
    id: hit.id,
    title: hit.title,
    overview: hit.overview ?? "",
    year: hit.release_date ? Number(hit.release_date.slice(0, 4)) : null,
    ...(hit.release_date ? { airDate: hit.release_date } : {}),
    ...imageUrl(hit.poster_path) ? { artworkUrl: imageUrl(hit.poster_path)! } : {},
  };
}

export function firstShowHit(payload: unknown): { id: number; title: string; overview: string; year: number | null; airDate?: string; artworkUrl?: string } | null {
  const results = (payload as { results?: TmdbSearchShow[] } | null)?.results ?? [];
  const hit = results[0];
  if (!hit || typeof hit.id !== "number" || !hit.name) return null;
  return {
    id: hit.id,
    title: hit.name,
    overview: hit.overview ?? "",
    year: hit.first_air_date ? Number(hit.first_air_date.slice(0, 4)) : null,
    ...(hit.first_air_date ? { airDate: hit.first_air_date } : {}),
    ...imageUrl(hit.poster_path) ? { artworkUrl: imageUrl(hit.poster_path)! } : {},
  };
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
