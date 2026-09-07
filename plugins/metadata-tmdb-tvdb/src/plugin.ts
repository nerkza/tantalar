/**
 * Metadata provider plugin (TAN-016 wave 7 upgrade of phase 4, story 14).
 *
 * Provides `dev.tantalar.capability.metadata-provider` backed by the real
 * TMDB REST provider for movies and series. Normal runtime uses Tantalar's
 * hosted metadata gateway; a stored TMDB key selects direct-provider mode.
 * Fixture catalogs are available only through explicit test configuration.
 *
 * Guarantees:
 *  - The hosted credential stays in the gateway. Optional direct credentials
 *    arrive through the server secret store or TANTALAR_SECRET_TMDB_API_KEY;
 *    neither is logged, echoed, or returned.
 *  - Successful lookups are cached durably (core DB document store) with a
 *    TTL; provider outages answer from cache and never corrupt records —
 *    a failed refresh leaves the previous record untouched.
 *  - Rate-limit state (HTTP 429) and outages surface as events + status.
 */
import { runPlugin, definePlugin, type PluginContext, type PluginDefinition } from "@tantalar/plugin-sdk";
import { PROTOCOL_VERSION, validateManifest, EventTypes, type MediaMetadata, type MovieMetadataSnapshot, type MediaMetadataSnapshot } from "@tantalar/contracts";
import {
  episodeFromSeason,
  episodesFromSeason,
  firstMovieHit,
  firstShowHit,
  movieHits,
  movieDetailsUrl,
  movieSnapshot,
  seriesSnapshot,
  movieSearchUrl,
  seasonUrl,
  seriesSeasons,
  showDetailsUrl,
  showHits,
  showSearchUrl,
} from "./tmdb.js";

const METADATA_CAPABILITY = "dev.tantalar.capability.metadata-provider";
const PLUGIN_ID = "dev.tantalar.plugin.metadata-tmdb-tvdb";

const manifest = validateManifest({
  id: PLUGIN_ID,
  version: "0.2.0",
  protocolVersion: PROTOCOL_VERSION,
  provides: [METADATA_CAPABILITY],
  requires: ["dev.tantalar.capability.event.emit", "dev.tantalar.capability.log", "dev.tantalar.capability.secret.resolve"],
  subscriptions: [],
  entry: { command: "node dist/plugin.js" },
});

// ---- Configuration ---------------------------------------------------------------

interface ProviderConfig {
  tmdbBaseUrl: string;
  gatewayBaseUrl: string;
  apiKey: string;
  locale: string;
  fixtureMode: boolean;
  /** Cache TTL ms (default 7 days). */
  cacheTtlMs: number;
}

function loadConfig(): ProviderConfig {
  const raw = JSON.parse(process.env["TANTALAR_PLUGIN_CONFIG"] ?? "{}") as Record<string, unknown>;
  return {
    tmdbBaseUrl: String(raw.tmdbBaseUrl ?? "https://api.themoviedb.org/3"),
    gatewayBaseUrl: String(raw.metadataGatewayUrl ?? "https://metadata.tantalar.app/v1/tmdb"),
    apiKey: String(process.env["TANTALAR_SECRET_TMDB_API_KEY"] ?? ""),
    locale: String(raw.locale ?? "en-US"),
    fixtureMode: raw.fixtureMode === true,
    cacheTtlMs: Number(raw.cacheTtlMs ?? 7 * 24 * 60 * 60 * 1000),
  };
}

// ---- Transport seam ------------------------------------------------------------------

export interface ProviderResponse {
  readonly status: number;
  readonly body: string;
}

export type ProviderTransport = (url: string) => Promise<ProviderResponse>;

let transport: ProviderTransport = async (url) => {
  const res = await fetch(url, { headers: { accept: "application/json" } });
  return { status: res.status, body: await res.text() };
};

/** Test hook: replace the HTTP transport. Returns the previous one. */
export function setTransport(next: ProviderTransport): ProviderTransport {
  const prev = transport;
  transport = next;
  return prev;
}

// ---- Fixture catalogs (explicit test mode only) -----------------------------------

interface FixtureSeries {
  tvdbId: string;
  name: string;
  overview: string;
  firstAired: string;
  artworkUrl: string;
  episodes: Record<string, { airDate: string; title: string }>;
}

interface FixtureMovie {
  tmdbId: string;
  title: string;
  overview: string;
  releaseDate: string;
  year: number;
  artworkUrl: string;
  posterPath: string;
}

const seriesFixtures: FixtureSeries[] = [
  {
    tvdbId: "tvdb-121",
    name: "Fixture Show",
    overview: "A fixture series used by the Tantalar test suites.",
    firstAired: "2024-01-05",
    artworkUrl: "https://fixtures.tantalar.invalid/art/tvdb-121.jpg",
    episodes: {
      "S01E01": { airDate: "2026-09-01", title: "Pilot" },
      "S01E02": { airDate: "2026-09-08", title: "Second" },
    },
  },
];

const movieFixtures: FixtureMovie[] = [
  {
    tmdbId: "tmdb-9001",
    title: "Fixture Movie",
    overview: "A fixture movie used by the Tantalar test suites.",
    releaseDate: "2024-07-12",
    year: 2024,
    artworkUrl: "https://fixtures.tantalar.invalid/art/tmdb-9001.jpg",
    posterPath: "/art/tmdb-9001.jpg",
  },
];

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

// ---- Plugin state ----------------------------------------------------------------------

let emitFn:
  | ((type: string, payload: Record<string, unknown>, opts?: { correlationId?: string }) => Promise<void>)
  | null = null;
let logFn: PluginContext["log"] | null = null;
let invokeCtx: PluginContext | null = null;
let storeGet: ((key: string) => Promise<{ doc: unknown; updatedAt: string } | null>) | null = null;
let storePut: ((key: string, doc: unknown) => Promise<void>) | null = null;

let cfg = loadConfig();
let lastProviderError: { code: string; message: string; at: string } | null = null;
const CACHE_KEY = "metadata-cache";
const API_KEY_REF = "tmdb:api-key";

type CacheShape = Record<string, { meta: MediaMetadata; cachedAt: string }>;

function cacheEntry(value: unknown): CacheShape[string] | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const entry = value as Partial<CacheShape[string]>;
  return entry.meta && typeof entry.meta === "object" && typeof entry.cachedAt === "string" && !Number.isNaN(Date.parse(entry.cachedAt))
    ? entry as CacheShape[string]
    : null;
}

async function loadCache(): Promise<CacheShape> {
  if (!storeGet) return {};
  try {
    const hit = await storeGet(CACHE_KEY);
    const doc = hit?.doc as CacheShape | undefined;
    return doc && typeof doc === "object" ? doc : {};
  } catch {
    return {};
  }
}

async function saveCache(cache: CacheShape): Promise<void> {
  if (!storePut) return;
  try {
    await storePut(CACHE_KEY, cache);
  } catch {
    /* best-effort durability */
  }
}

function cacheKey(kind: "series" | "movie", name: string, season?: number, episode?: number): string {
  return `${kind}:${slug(name)}${season !== undefined ? `:s${season}` : ""}${episode !== undefined ? `e${episode}` : ""}`;
}

function snapshotCacheKey(kind: "series" | "movie", externalId: string): string {
  const provider = cfg.fixtureMode ? (kind === "movie" ? "tmdb-fixture" : "tvdb-fixture") : "tmdb";
  return `snapshot:${provider}:${kind}:${externalId}`;
}

async function fetchJson(url: string): Promise<unknown> {
  let res: ProviderResponse;
  try {
    res = await transport(url);
  } catch {
    throw new Error("unavailable: provider request failed");
  }
  if (res.status === 401 || res.status === 403) {
    throw new Error(cfg.apiKey ? "auth_failed: provider rejected the configured api key" : "unavailable: hosted metadata service rejected the request");
  }
  if (res.status === 429) throw new Error("rate_limited: provider reported rate limiting (HTTP 429)");
  if (res.status >= 500) throw new Error(`unavailable: provider unavailable (HTTP ${res.status})`);
  if (res.status >= 400) throw new Error(`unavailable: provider request failed (HTTP ${res.status})`);
  try {
    return JSON.parse(res.body) as unknown;
  } catch {
    throw new Error("parse_error: provider returned malformed JSON");
  }
}

async function hydrateApiKey(): Promise<void> {
  const environmentKey = process.env["TANTALAR_SECRET_TMDB_API_KEY"] ?? "";
  if (environmentKey) {
    cfg.apiKey = environmentKey;
    return;
  }
  try {
    const result = await invokeCtx?.invoke("dev.tantalar.capability.secret.resolve", "resolve", { ref: API_KEY_REF });
    cfg.apiKey = String((result as { value?: unknown } | null)?.value ?? "");
  } catch {
    cfg.apiKey = "";
  }
}

function providerMode(): "hosted" | "direct" | "fixture" {
  return cfg.fixtureMode ? "fixture" : cfg.apiKey ? "direct" : "hosted";
}

function liveBaseUrl(): string {
  return cfg.apiKey ? cfg.tmdbBaseUrl : cfg.gatewayBaseUrl;
}

function providerState(): "ready" | "rate-limited" | "unavailable" {
  if (lastProviderError?.code === "rate_limited") return "rate-limited";
  return lastProviderError ? "unavailable" : "ready";
}

async function validateConnection(): Promise<void> {
  if (cfg.fixtureMode) return;
  const url = new URL(`${liveBaseUrl().replace(/\/$/, "")}/configuration`);
  if (cfg.apiKey) url.searchParams.set("api_key", cfg.apiKey);
  await fetchJson(url.toString());
  lastProviderError = null;
}

async function searchLive(kind: "series" | "movie", query: string, limit: number): Promise<MediaMetadata[]> {
  const payload = await fetchJson(
    kind === "movie"
      ? movieSearchUrl(liveBaseUrl(), cfg.apiKey, query, undefined, cfg.locale)
      : showSearchUrl(liveBaseUrl(), cfg.apiKey, query, cfg.locale),
  );
  const hits = kind === "movie" ? movieHits(payload) : showHits(payload);
  return hits.slice(0, limit).map((hit) => ({
    externalId: `tmdb-${String(hit.id)}`,
    kind,
    name: hit.title,
    overview: hit.overview,
    year: hit.year,
    ...(hit.airDate !== undefined ? { airDate: hit.airDate } : {}),
    ...(hit.artworkUrl !== undefined ? { artworkUrl: hit.artworkUrl } : {}),
    provider: "tmdb",
  }));
}

function searchFixtures(kind: "series" | "movie", query: string, limit: number): MediaMetadata[] {
  const term = slug(query);
  if (!term) return [];
  if (kind === "series") {
    return seriesFixtures
      .filter((item) => slug(item.name).includes(term))
      .slice(0, limit)
      .map((item) => ({
        externalId: item.tvdbId,
        kind,
        name: item.name,
        overview: item.overview,
        year: Number(item.firstAired.slice(0, 4)),
        airDate: item.firstAired,
        artworkUrl: item.artworkUrl,
        provider: "tvdb-fixture",
      }));
  }
  return movieFixtures
    .filter((item) => slug(item.title).includes(term))
    .slice(0, limit)
    .map((item) => ({
      externalId: item.tmdbId,
      kind,
      name: item.title,
      overview: item.overview,
      year: item.year,
      airDate: item.releaseDate,
      artworkUrl: item.artworkUrl,
      provider: "tmdb-fixture",
    }));
}

async function metadataDetails(kind: "series" | "movie", externalId: string): Promise<MediaMetadataSnapshot | null> {
  if (cfg.fixtureMode) {
    if (kind === "movie") {
      const item = movieFixtures.find((fixture) => fixture.tmdbId === externalId);
      return item ? {
        externalId: item.tmdbId,
        kind,
        name: item.title,
        overview: item.overview,
        year: item.year,
        airDate: item.releaseDate,
        artworkUrl: item.artworkUrl,
        provider: "tmdb-fixture",
        originalTitle: item.title,
        tagline: null,
        releaseDate: item.releaseDate,
        runtimeMinutes: 100,
        genres: ["Fixture"],
        actors: [],
        directors: [],
        certification: "PG",
        status: "Released",
        originalLanguage: "en",
        rating: 7.5,
        voteCount: 100,
        posterPath: item.posterPath,
        backdropPath: null,
        externalIds: { tmdb: item.tmdbId.replace(/^tmdb-/, "") },
        locale: cfg.locale,
        fetchedAt: new Date().toISOString(),
        source: "fixture",
      } satisfies MovieMetadataSnapshot : null;
    }
    const item = seriesFixtures.find((fixture) => fixture.tvdbId === externalId);
    return item ? {
      externalId: item.tvdbId,
      kind,
      name: item.name,
      overview: item.overview,
      year: Number(item.firstAired.slice(0, 4)),
      airDate: item.firstAired,
      artworkUrl: item.artworkUrl,
      provider: "tvdb-fixture",
      originalTitle: item.name, tagline: null, releaseDate: item.firstAired, lastAirDate: null,
      runtimeMinutes: 45, genres: ["Fixture"], actors: [], directors: [], certification: null,
      status: "Returning Series", originalLanguage: "en", rating: null, voteCount: 0,
      posterPath: null, backdropPath: null, externalIds: { tvdb: item.tvdbId },
      locale: cfg.locale, fetchedAt: new Date().toISOString(), source: "fixture",
    } : null;
  }
  const match = /^tmdb-(\d+)$/.exec(externalId);
  if (!match) return null;
  const payload = await fetchJson(
    kind === "movie"
      ? movieDetailsUrl(liveBaseUrl(), cfg.apiKey, Number(match[1]), cfg.locale)
      : showDetailsUrl(liveBaseUrl(), cfg.apiKey, Number(match[1]), cfg.locale),
  );
  if (kind === "movie") {
    return movieSnapshot(payload, {
      externalId,
      locale: cfg.locale,
      fetchedAt: new Date().toISOString(),
      source: providerMode() === "direct" ? "direct" : "hosted",
    });
  }
  return seriesSnapshot(payload, { externalId, locale: cfg.locale, fetchedAt: new Date().toISOString(), source: providerMode() === "direct" ? "direct" : "hosted" });
}

async function seriesTopology(externalId: string, name: string): Promise<import("@tantalar/contracts").EpisodeMetadata[]> {
  if (cfg.fixtureMode) {
    const fixture = seriesFixtures.find((item) => item.tvdbId === externalId)
      ?? seriesFixtures.find((item) => slug(item.name) === slug(name));
    if (!fixture) return [];
    return Object.entries(fixture.episodes).flatMap(([key, episode]) => {
      const match = /^S(\d+)E(\d+)$/.exec(key);
      return match
        ? [{ season: Number(match[1]), episode: Number(match[2]), title: episode.title, airDate: episode.airDate }]
        : [];
    });
  }

  const id = /^tmdb-(\d+)$/.exec(externalId)?.[1];
  if (!id) return [];
  const show = await fetchJson(showDetailsUrl(liveBaseUrl(), cfg.apiKey, Number(id), cfg.locale)) as { id?: number };
  if (show.id !== Number(id)) throw new Error("Series provider identity changed");
  const seasons = seriesSeasons(show).slice(0, 50);
  const episodes: import("@tantalar/contracts").EpisodeMetadata[] = [];
  for (let offset = 0; offset < seasons.length; offset += 4) {
    const batch = seasons.slice(offset, offset + 4);
    const pages = await Promise.all(batch.map((season) => fetchJson(seasonUrl(liveBaseUrl(), cfg.apiKey, Number(id), season.season, cfg.locale))));
    for (const [index, page] of pages.entries()) {
      const parsed = episodesFromSeason(page);
      if (parsed.some(episode => episode.season !== batch[index]!.season)) throw new Error("Season provider identity changed");
      if (parsed.length > 0) episodes.push(...parsed);
      else {
        const season = batch[index]!;
        for (let episode = 1; episode <= season.episodeCount; episode += 1) {
          episodes.push({ season: season.season, episode, title: `Episode ${episode}` });
        }
      }
    }
  }
  return episodes.slice(0, 5000);
}

async function lookupLive(
  kind: "series" | "movie",
  name: string,
  year: number | undefined,
  season: number,
  episode: number,
): Promise<MediaMetadata | null> {
  let hit: ReturnType<typeof firstMovieHit> | ReturnType<typeof firstShowHit>;
  if (kind === "movie") {
    hit = firstMovieHit(await fetchJson(movieSearchUrl(liveBaseUrl(), cfg.apiKey, name, year, cfg.locale)));
  } else {
    hit = firstShowHit(await fetchJson(showSearchUrl(liveBaseUrl(), cfg.apiKey, name, cfg.locale)));
  }
  if (!hit || typeof hit.id !== "number") return null;
  let epTitle: string | undefined;
  let airDate: string | undefined;
  if (kind === "series" && typeof hit.id === "number") {
    const seasonPayload = await fetchJson(seasonUrl(liveBaseUrl(), cfg.apiKey, hit.id as number, season, cfg.locale));
    const ep = episodeFromSeason(seasonPayload, episode);
    if (ep) {
      epTitle = ep.title;
      airDate = ep.airDate;
    }
  }
  return {
    externalId: `tmdb-${String(hit.id)}`,
    kind,
    name: hit.title,
    overview: epTitle ? `${epTitle} — ${hit.overview}` : hit.overview,
    year: hit.year,
    ...(airDate !== undefined ? { airDate } : hit.airDate !== undefined ? { airDate: hit.airDate } : {}),
    ...(hit.artworkUrl !== undefined ? { artworkUrl: hit.artworkUrl } : {}),
    provider: "tmdb",
  };
}

async function lookupFixture(kind: "series" | "movie", name: string, year: number | undefined, season: number, episode: number): Promise<MediaMetadata | null> {
  if (kind === "series") {
    const fx =
      seriesFixtures.find((s) => s.name.toLowerCase() === name.toLowerCase()) ??
      seriesFixtures.find((s) => slug(s.name) === slug(name));
    if (!fx) return null;
    const epKey = `S${String(season).padStart(2, "0")}E${String(episode).padStart(2, "0")}`;
    const ep = fx.episodes[epKey];
    return {
      externalId: fx.tvdbId,
      kind,
      name: fx.name,
      overview: ep ? `${ep.title} — ${fx.overview}` : fx.overview,
      year: Number(fx.firstAired.slice(0, 4)),
      ...(ep ? { airDate: ep.airDate } : {}),
      artworkUrl: fx.artworkUrl,
      provider: "tvdb-fixture",
    };
  }
  const fx =
    movieFixtures.find((m) => m.title.toLowerCase() === name.toLowerCase() && (!year || m.year === year)) ??
    movieFixtures.find((m) => slug(m.title) === slug(name));
  if (!fx) return null;
  return {
    externalId: fx.tmdbId,
    kind,
    name: fx.title,
    overview: fx.overview,
    year: fx.year,
    airDate: fx.releaseDate,
    artworkUrl: fx.artworkUrl,
    provider: "tmdb-fixture",
  };
}

const plugin: PluginDefinition = definePlugin({
  manifest,
  async mount(ctx) {
    emitFn = async (type, payload, opts) => ctx.emit(type, payload, opts);
    logFn = (level, message) => ctx.log(level, message);
    invokeCtx = ctx;
    storeGet = (key) => ctx.storage.get(key);
    storePut = (key, doc) => ctx.storage.put(key, doc);
    cfg = loadConfig();
    await hydrateApiKey();
    ctx.log("info", `metadata provider mounted (${providerMode()})`);
  },
  async unmount(ctx) {
    emitFn = null;
    logFn = null;
    invokeCtx = null;
    storeGet = null;
    storePut = null;
    ctx.log("info", "metadata provider unmounted");
  },
  handlers: {
    [METADATA_CAPABILITY]: async (operation, payload) => {
      switch (operation) {
        case "details": {
          const kind = payload.kind === "movie" ? "movie" : "series";
          const externalId = String(payload.externalId ?? "").trim();
          const name = String(payload.name ?? "").trim();
          if (!externalId || (kind === "series" && !name)) throw new Error("externalId required; series name required");
          const cache = await loadCache();
          const key = snapshotCacheKey(kind, externalId);
          const hit = cacheEntry(cache?.[key]);
          if (hit && (kind === "movie" || payload.metadataOnly === true) && payload.refresh !== true && Array.isArray((hit.meta as MovieMetadataSnapshot).actors) && Array.isArray((hit.meta as MovieMetadataSnapshot).directors) && Date.now() - Date.parse(hit.cachedAt) < cfg.cacheTtlMs) {
            return { found: true, metadata: hit.meta, episodes: [], source: "cache" };
          }
          try {
            const metadata = await metadataDetails(kind, externalId);
            const episodes = kind === "series" && payload.metadataOnly !== true ? await seriesTopology(externalId, name) : [];
            lastProviderError = null;
            if (!metadata && hit) return { found: true, metadata: hit.meta, episodes: [], source: "stale-cache" };
            if (metadata && cache) {
              cache[key] = { meta: metadata, cachedAt: new Date().toISOString() };
              await saveCache(cache);
            }
            return {
              found: metadata !== null && (kind === "movie" || payload.metadataOnly === true || episodes.length > 0),
              ...(metadata ? { metadata } : {}),
              episodes,
              source: cfg.fixtureMode ? "fixture" : "provider",
            };
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            const code = message.split(":")[0] ?? "unavailable";
            lastProviderError = { code, message, at: new Date().toISOString() };
            await emitFn?.("dev.tantalar.event.provider.error", {
              provider: "tmdb",
              code,
              message,
              op: "details",
            }).catch(() => undefined);
            if (hit) return { found: true, metadata: hit.meta, episodes: [], source: "stale-cache" };
            throw err;
          }
        }
        case "search": {
          const kind = payload.kind === "movie" ? "movie" : "series";
          const query = String(payload.query ?? "").trim();
          if (query.length < 2) throw new Error("query must contain at least 2 characters");
          const limit = Math.min(20, Math.max(1, Math.trunc(typeof payload.limit === "number" ? payload.limit : 10)));
          let candidates: MediaMetadata[];
          if (!cfg.fixtureMode) {
            try {
              candidates = await searchLive(kind, query, limit);
              lastProviderError = null;
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err);
              const code = message.split(":")[0] ?? "unavailable";
              lastProviderError = { code, message, at: new Date().toISOString() };
              await emitFn?.("dev.tantalar.event.provider.error", {
                provider: "tmdb",
                code,
                message,
                op: "search",
              }).catch(() => undefined);
              throw err;
            }
          } else {
            candidates = searchFixtures(kind, query, limit);
          }
          await emitFn?.(
            EventTypes.MetadataSearchCompleted,
            { provider: cfg.fixtureMode ? "fixture" : "tmdb", kind, query, count: candidates.length },
            typeof payload.correlationId === "string" ? { correlationId: payload.correlationId } : undefined,
          );
          return { candidates, source: cfg.fixtureMode ? "fixture" : "provider" };
        }
        case "lookup": {
          const kind = payload.kind === "movie" ? "movie" : "series";
          const name = String(payload.name ?? "");
          if (!name) throw new Error("name required");
          const season = typeof payload.season === "number" ? Math.trunc(payload.season) : 1;
          const episode = typeof payload.episode === "number" ? Math.trunc(payload.episode) : 1;
          const year = typeof payload.year === "number" ? Math.trunc(payload.year) : undefined;
          const key = cacheKey(kind, name, kind === "series" ? season : undefined, kind === "series" ? episode : undefined);

          const cache = await loadCache();
          const hit = cacheEntry(cache[key]);
          if (hit && Date.now() - Date.parse(hit.cachedAt) < cfg.cacheTtlMs) {
            return { found: true, metadata: hit.meta, source: "cache" };
          }

          let meta: MediaMetadata | null = null;
          if (!cfg.fixtureMode) {
            try {
              meta = await lookupLive(kind, name, year, season, episode);
              lastProviderError = null;
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err);
              const code = message.split(":")[0] ?? "unavailable";
              lastProviderError = { code, message, at: new Date().toISOString() };
              await emitFn?.("dev.tantalar.event.provider.error", {
                provider: "tmdb",
                code,
                message,
                op: "lookup",
              }).catch(() => undefined);
              // Outage safety: fall back to the last good cached record even
              // when stale; never corrupt or remove it because of an outage.
              if (hit) return { found: true, metadata: hit.meta, source: "stale-cache" };
              throw err;
            }
          }
          if (!meta && cfg.fixtureMode) meta = await lookupFixture(kind, name, year, season, episode);
          if (!meta) {
            await emitFn?.(
              EventTypes.MetadataSearchCompleted,
              { provider: cfg.fixtureMode ? "fixture" : "tmdb", kind, name, found: false },
              typeof payload.correlationId === "string" ? { correlationId: payload.correlationId } : undefined,
            );
            return { found: false };
          }

          cache[key] = { meta, cachedAt: new Date().toISOString() };
          await saveCache(cache);
          await emitFn?.(
            EventTypes.MetadataRefreshed,
            { externalId: meta.externalId, kind: meta.kind, name: meta.name, provider: meta.provider },
            typeof payload.correlationId === "string" ? { correlationId: payload.correlationId } : undefined,
          );
          return { found: true, metadata: meta, source: cfg.fixtureMode ? "fixture" : "provider" };
        }
        case "status": {
          return {
            state: providerState(),
            mode: providerMode(),
            configured: true,
            directKeyConfigured: Boolean(cfg.apiKey),
            locale: cfg.locale,
            ...(lastProviderError ? { lastError: lastProviderError } : {}),
          };
        }
        case "configure": {
          await hydrateApiKey();
          try {
            await validateConnection();
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            const code = message.split(":")[0] ?? "unavailable";
            lastProviderError = { code, message, at: new Date().toISOString() };
            throw err;
          }
          return { state: providerState(), mode: providerMode(), configured: true, directKeyConfigured: Boolean(cfg.apiKey), locale: cfg.locale };
        }
        case "conformance-probe":
          return { ok: true };
        default:
          throw new Error(`unknown operation ${operation}`);
      }
    },
  },
});

runPlugin(plugin);
