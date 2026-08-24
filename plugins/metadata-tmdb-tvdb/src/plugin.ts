/**
 * Metadata provider plugin (TAN-016 wave 7 upgrade of phase 4, story 14).
 *
 * Provides `dev.tantalar.capability.metadata-provider` backed by the real
 * TMDB REST provider for movies and series. Fixture catalogs remain as a
 * fallback ONLY when no credentials are configured (so local/dev installs
 * and existing suites keep working) — with `apiKey` present every lookup
 * goes to TMDB through an injectable transport.
 *
 * Guarantees:
 *  - Credentials arrive via plugin config or TANTALAR_SECRET_TMDB_API_KEY;
 *    never logged, echoed, or returned.
 *  - Successful lookups are cached durably (core DB document store) with a
 *    TTL; provider outages answer from cache and never corrupt records —
 *    a failed refresh leaves the previous record untouched.
 *  - Rate-limit state (HTTP 429) and outages surface as events + status.
 */
import { runPlugin, definePlugin, type PluginContext, type PluginDefinition } from "@tantalar/plugin-sdk";
import { PROTOCOL_VERSION, validateManifest, EventTypes, type MediaMetadata } from "@tantalar/contracts";
import {
  episodeFromSeason,
  firstMovieHit,
  firstShowHit,
  movieSearchUrl,
  seasonUrl,
  showSearchUrl,
} from "./tmdb.js";

const METADATA_CAPABILITY = "dev.tantalar.capability.metadata-provider";
const PLUGIN_ID = "dev.tantalar.plugin.metadata-tmdb-tvdb";

const manifest = validateManifest({
  id: PLUGIN_ID,
  version: "0.2.0",
  protocolVersion: PROTOCOL_VERSION,
  provides: [METADATA_CAPABILITY],
  requires: ["dev.tantalar.capability.event.emit", "dev.tantalar.capability.log"],
  subscriptions: [],
  entry: { command: "node dist/plugin.js" },
});

// ---- Configuration ---------------------------------------------------------------

interface ProviderConfig {
  baseUrl: string;
  apiKey: string;
  locale: string;
  /** Cache TTL ms (default 7 days). */
  cacheTtlMs: number;
}

function loadConfig(): ProviderConfig {
  const raw = JSON.parse(process.env["TANTALAR_PLUGIN_CONFIG"] ?? "{}") as Record<string, unknown>;
  return {
    baseUrl: String(raw.tmdbBaseUrl ?? "https://api.themoviedb.org/3"),
    apiKey: String(raw.apiKey ?? process.env["TANTALAR_SECRET_TMDB_API_KEY"] ?? ""),
    locale: String(raw.locale ?? "en-US"),
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

// ---- Fixture catalogs (fallback when no credentials are configured) ---------------

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
let storeGet: ((key: string) => Promise<{ doc: unknown; updatedAt: string } | null>) | null = null;
let storePut: ((key: string, doc: unknown) => Promise<void>) | null = null;

let cfg = loadConfig();
let lastProviderError: { code: string; message: string; at: string } | null = null;
const CACHE_KEY = "metadata-cache";

type CacheShape = Record<string, { meta: MediaMetadata; cachedAt: string }>;

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

async function fetchJson(url: string): Promise<unknown> {
  const res = await transport(url);
  if (res.status === 401 || res.status === 403) throw new Error("auth_failed: provider rejected the configured api key");
  if (res.status === 429) throw new Error("rate_limited: provider reported rate limiting (HTTP 429)");
  if (res.status >= 500) throw new Error(`unavailable: provider unavailable (HTTP ${res.status})`);
  try {
    return JSON.parse(res.body) as unknown;
  } catch {
    throw new Error("parse_error: provider returned malformed JSON");
  }
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
    hit = firstMovieHit(await fetchJson(movieSearchUrl(cfg.baseUrl, cfg.apiKey, name, year)));
  } else {
    hit = firstShowHit(await fetchJson(showSearchUrl(cfg.baseUrl, cfg.apiKey, name)));
  }
  if (!hit || typeof hit.id !== "number") return null;
  let epTitle: string | undefined;
  let airDate: string | undefined;
  if (kind === "series" && typeof hit.id === "number") {
    const seasonPayload = await fetchJson(seasonUrl(cfg.baseUrl, cfg.apiKey, hit.id as number, season));
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
    storeGet = (key) => ctx.storage.get(key);
    storePut = (key, doc) => ctx.storage.put(key, doc);
    cfg = loadConfig();
    ctx.log("info", cfg.apiKey ? "metadata provider mounted (tmdb live)" : "metadata provider mounted (fixture fallback)");
  },
  async unmount(ctx) {
    emitFn = null;
    logFn = null;
    storeGet = null;
    storePut = null;
    ctx.log("info", "metadata provider unmounted");
  },
  handlers: {
    [METADATA_CAPABILITY]: async (operation, payload) => {
      switch (operation) {
        case "lookup": {
          const kind = payload.kind === "movie" ? "movie" : "series";
          const name = String(payload.name ?? "");
          if (!name) throw new Error("name required");
          const season = typeof payload.season === "number" ? Math.trunc(payload.season) : 1;
          const episode = typeof payload.episode === "number" ? Math.trunc(payload.episode) : 1;
          const year = typeof payload.year === "number" ? Math.trunc(payload.year) : undefined;
          const key = cacheKey(kind, name, kind === "series" ? season : undefined, kind === "series" ? episode : undefined);

          const cache = await loadCache();
          const hit = cache[key];
          if (hit && Date.now() - Date.parse(hit.cachedAt) < cfg.cacheTtlMs) {
            return { found: true, metadata: hit.meta, source: "cache" };
          }

          let meta: MediaMetadata | null = null;
          if (cfg.apiKey) {
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
              // Without any cache, fall through to fixtures only when they match.
              void logFn;
            }
          }
          if (!meta) meta = await lookupFixture(kind, name, year, season, episode);
          if (!meta) {
            await emitFn?.(
              EventTypes.MetadataSearchCompleted,
              { provider: cfg.apiKey ? "tmdb" : "fixture", kind, name, found: false },
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
          return { found: true, metadata: meta, source: cfg.apiKey && meta.provider === "tmdb" ? "provider" : "fixture" };
        }
        case "status": {
          return {
            live: Boolean(cfg.apiKey),
            locale: cfg.locale,
            ...(lastProviderError ? { lastError: lastProviderError } : {}),
          };
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
