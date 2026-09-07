/**
 * Series automation plugin (phase 3c, story 1).
 *
 * Provides `dev.tantalar.capability.automation.series`: add a show by name,
 * automatic season/episode tracking, a monitored wanted-episode list with
 * per-show quality profiles, and search/scan operations the orchestrator
 * (or tests) drive. All state is in-process fixture state — no network, no
 * real metadata provider. Every accepted operation emits an event carrying
 * the caller's correlationId so the decision chain reconstructs from the log.
 */
import { runPlugin, definePlugin, type PluginContext, type PluginDefinition } from "@tantalar/plugin-sdk";
import {
  PROTOCOL_VERSION,
  validateManifest,
  EventTypes,
  type QualityProfile,
} from "@tantalar/contracts";

const SERIES_CAPABILITY = "dev.tantalar.capability.automation.series";
const PLUGIN_ID = "dev.tantalar.plugin.series";

const manifest = validateManifest({
  id: PLUGIN_ID,
  version: "0.1.0",
  protocolVersion: PROTOCOL_VERSION,
  provides: [SERIES_CAPABILITY],
  requires: ["dev.tantalar.capability.event.emit", "dev.tantalar.capability.log"],
  subscriptions: [],
  entry: { command: "node dist/plugin.js" },
});

export interface EpisodeRecord {
  readonly seriesId: string;
  readonly season: number;
  readonly episode: number;
  /** Search string used to find releases for this episode. */
  readonly query: string;
  readonly airDate?: string;
  readonly title?: string;
  readonly externalId?: string;
  readonly overview?: string;
  readonly runtimeMinutes?: number;
  readonly stillPath?: string;
}

type SeriesMonitorMode = "all" | "future" | "missing" | "none";

interface SeriesState {
  name: string;
  monitored: boolean;
  profile: QualityProfile;
  seasons: number;
  episodesPerSeason: number;
  monitorMode: SeriesMonitorMode;
  destinationLibraryId?: string;
  minimumAvailability?: string;
  year?: number;
  externalId?: string;
  provider?: string;
  overview?: string;
  artworkUrl?: string;
  episodes: Map<string, EpisodeRecord>; // key `S<season>E<episode>`
  acquiredEpisodeKeys: Set<string>;
  manualFields?: string[];
}

function defaultProfile(): QualityProfile {
  return { name: "hd", preferredQualities: ["1080p"] };
}

let emitFn:
  | ((type: string, payload: Record<string, unknown>, opts?: { correlationId?: string }) => Promise<void>)
  | null = null;

/** Wave 3 (TAN-013): durable storage bridge; null when storage is unavailable. */
let store: PluginContext["storage"] | null = null;
const DOC_KEY = "state";

const shows = new Map<string, SeriesState>();
let seq = 0;

/** Snapshot the in-memory state into the durable document store. */
async function persist(): Promise<void> {
  if (!store) return;
  try {
    await store.put(DOC_KEY, {
      shows: [...shows.entries()].map(([id, s]) => ({
        id,
        name: s.name,
        monitored: s.monitored,
        profile: s.profile,
        seasons: s.seasons,
        episodesPerSeason: s.episodesPerSeason,
        monitorMode: s.monitorMode,
        ...(s.destinationLibraryId ? { destinationLibraryId: s.destinationLibraryId } : {}),
        ...(s.minimumAvailability ? { minimumAvailability: s.minimumAvailability } : {}),
        ...(s.year !== undefined ? { year: s.year } : {}),
        ...(s.externalId ? { externalId: s.externalId } : {}),
        ...(s.provider ? { provider: s.provider } : {}),
        ...(s.overview !== undefined ? { overview: s.overview } : {}),
        ...(s.artworkUrl ? { artworkUrl: s.artworkUrl } : {}),
        episodes: [...s.episodes.values()],
        acquiredEpisodeKeys: [...s.acquiredEpisodeKeys],
        manualFields: s.manualFields ?? [],
      })),
    });
  } catch {
    // Storage failures never lose the in-memory answer; durability resumes
    // on the next mutation once the bridge is healthy again.
  }
}

/** Restore from the durable document store at mount (crash/restart recovery). */
async function restore(): Promise<void> {
  if (!store) return;
  try {
    const hit = await store.get(DOC_KEY);
    const doc = hit?.doc as
      | { shows?: Array<{ id: string; name: string; monitored: boolean; profile: QualityProfile; seasons: number; episodesPerSeason: number; monitorMode?: SeriesMonitorMode; destinationLibraryId?: string; minimumAvailability?: string; year?: number; externalId?: string; provider?: string; overview?: string; artworkUrl?: string; episodes?: EpisodeRecord[]; acquiredEpisodeKeys?: string[]; manualFields?: string[] }> }
      | undefined;
    for (const s of doc?.shows ?? []) {
      const episodes = new Map<string, EpisodeRecord>();
      if (Array.isArray(s.episodes)) {
        for (const episode of s.episodes) episodes.set(episodeKey(episode.season, episode.episode), episode);
      } else {
        for (let se = 1; se <= s.seasons; se++) {
          for (let e = 1; e <= s.episodesPerSeason; e++) {
            episodes.set(episodeKey(se, e), {
              seriesId: s.id,
              season: se,
              episode: e,
              query: `${s.name} S${String(se).padStart(2, "0")}E${String(e).padStart(2, "0")}`,
            });
          }
        }
      }
      shows.set(s.id, {
        ...s,
        monitorMode: s.monitorMode ?? (s.monitored ? "all" : "none"),
        episodes,
        acquiredEpisodeKeys: new Set(s.acquiredEpisodeKeys ?? []),
        manualFields: s.manualFields ?? [],
      });
    }
  } catch {
    // Corrupt/absent snapshot: start clean rather than fail the mount.
  }
}

function episodeKey(season: number, episode: number): string {
  return `S${String(season).padStart(2, "0")}E${String(episode).padStart(2, "0")}`;
}

function buildEpisodes(
  seriesId: string,
  name: string,
  payload: Record<string, unknown>,
  fallbackSeasons: number,
  fallbackEpisodesPerSeason: number,
): Map<string, EpisodeRecord> {
  const episodes = new Map<string, EpisodeRecord>();
  if (Array.isArray(payload.episodes)) {
    for (const value of payload.episodes) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const input = value as Record<string, unknown>;
      const season = Number(input.season);
      const episode = Number(input.episode);
      if (!Number.isInteger(season) || season < 0 || season > 200 || !Number.isInteger(episode) || episode < 1 || episode > 1000) continue;
      episodes.set(episodeKey(season, episode), {
        seriesId,
        season,
        episode,
        query: `${name} S${String(season).padStart(2, "0")}E${String(episode).padStart(2, "0")}`,
        ...(typeof input.title === "string" ? { title: input.title.trim().slice(0, 300) } : {}),
        ...(typeof input.externalId === "string" ? { externalId: input.externalId.slice(0, 200) } : {}),
        ...(typeof input.overview === "string" ? { overview: input.overview.slice(0, 5000) } : {}),
        ...(typeof input.runtimeMinutes === "number" && Number.isInteger(input.runtimeMinutes) && input.runtimeMinutes > 0 && input.runtimeMinutes <= 10_000 ? { runtimeMinutes: input.runtimeMinutes } : {}),
        ...(typeof input.stillPath === "string" && /^\/[A-Za-z0-9_./-]+$/.test(input.stillPath) ? { stillPath: input.stillPath.slice(0, 500) } : {}),
        ...(typeof input.airDate === "string" ? { airDate: input.airDate.slice(0, 10) } : {}),
      });
    }
  }
  if (episodes.size > 0) return episodes;
  for (let season = 1; season <= fallbackSeasons; season += 1) {
    for (let episode = 1; episode <= fallbackEpisodesPerSeason; episode += 1) {
      episodes.set(episodeKey(season, episode), {
        seriesId,
        season,
        episode,
        query: `${name} S${String(season).padStart(2, "0")}E${String(episode).padStart(2, "0")}`,
      });
    }
  }
  return episodes;
}

/** Deterministic id from the show name so adds are idempotent by name. */
function slug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

const plugin: PluginDefinition = definePlugin({
  manifest,
  async mount(ctx) {
    emitFn = async (type, payload, opts) => {
      await ctx.emit(type, payload, opts);
    };
    store = ctx.storage ?? null;
    await restore();
    ctx.log("info", "series mounted");
  },
  unmount(ctx) {
    emitFn = null;
    store = null;
    ctx.log("info", "series unmounted");
  },
  handlers: {
    [SERIES_CAPABILITY]: async (operation, payload) => {
      switch (operation) {
        case "add-series": {
          const name = String(payload.name ?? "").trim();
          if (!name) throw new Error("name required");
          const externalId = String(payload.externalId ?? "").trim();
          const provider = String(payload.provider ?? "").trim();
          const duplicate = externalId
            ? [...shows].find(([, show]) => show.externalId === externalId && show.provider === provider)?.[0]
            : undefined;
          const namedId = `series-${slug(name)}`;
          const named = shows.get(namedId);
          const id = duplicate ?? (named && externalId && (named.externalId !== externalId || named.provider !== provider)
            ? `${namedId}-${slug(provider)}-${slug(externalId)}` : namedId);
          const monitorMode: SeriesMonitorMode = payload.monitorMode === "future" || payload.monitorMode === "missing" || payload.monitorMode === "none"
            ? payload.monitorMode
            : payload.monitored === false
              ? "none"
              : "all";
          const existing = shows.get(id);
          if (existing) {
            if (externalId && (existing.externalId !== externalId || existing.provider !== provider)) throw new Error("series provider identity conflicts with an existing title");
            const episodes = buildEpisodes(id, name, payload, existing.seasons, existing.episodesPerSeason);
            const seasonCounts = new Map<number, number>();
            for (const episode of episodes.values()) seasonCounts.set(episode.season, (seasonCounts.get(episode.season) ?? 0) + 1);
            Object.assign(existing, {
              name,
              monitorMode,
              monitored: monitorMode !== "none",
              ...(payload.profile && typeof payload.profile === "object" ? { profile: payload.profile as QualityProfile } : {}),
              ...(Array.isArray(payload.episodes) ? {
                episodes,
                seasons: seasonCounts.size,
                episodesPerSeason: Math.max(0, ...seasonCounts.values()),
                acquiredEpisodeKeys: new Set([...existing.acquiredEpisodeKeys].filter((key) => episodes.has(key))),
              } : {}),
              ...(typeof payload.destinationLibraryId === "string" ? { destinationLibraryId: payload.destinationLibraryId } : {}),
              ...(typeof payload.minimumAvailability === "string" ? { minimumAvailability: payload.minimumAvailability } : {}),
              ...(typeof payload.year === "number" ? { year: Math.trunc(payload.year) } : {}),
              ...(externalId ? { externalId } : {}),
              ...(provider ? { provider } : {}),
              ...(typeof payload.overview === "string" ? { overview: payload.overview } : {}),
              ...(typeof payload.artworkUrl === "string" ? { artworkUrl: payload.artworkUrl } : {}),
            });
            await persist();
            return { seriesId: id, created: false };
          }
          seq += 1;
          void seq;
          const seasons = typeof payload.seasons === "number" && payload.seasons > 0 ? Math.floor(payload.seasons) : 1;
          const episodesPerSeason =
            typeof payload.episodesPerSeason === "number" && payload.episodesPerSeason > 0
              ? Math.floor(payload.episodesPerSeason)
              : 1;
          const profile = (payload.profile as QualityProfile | undefined) ?? defaultProfile();
          const monitored = monitorMode !== "none";
          const episodes = buildEpisodes(id, name, payload, seasons, episodesPerSeason);
          const seasonCounts = new Map<number, number>();
          for (const episode of episodes.values()) seasonCounts.set(episode.season, (seasonCounts.get(episode.season) ?? 0) + 1);
          shows.set(id, {
            name,
            monitored,
            profile,
            seasons: seasonCounts.size,
            episodesPerSeason: Math.max(0, ...seasonCounts.values()),
            monitorMode,
            ...(typeof payload.destinationLibraryId === "string" ? { destinationLibraryId: payload.destinationLibraryId } : {}),
            ...(typeof payload.minimumAvailability === "string" ? { minimumAvailability: payload.minimumAvailability } : {}),
            ...(typeof payload.year === "number" ? { year: Math.trunc(payload.year) } : {}),
            ...(externalId ? { externalId } : {}),
            ...(provider ? { provider } : {}),
            ...(typeof payload.overview === "string" ? { overview: payload.overview } : {}),
            ...(typeof payload.artworkUrl === "string" ? { artworkUrl: payload.artworkUrl } : {}),
            episodes,
            acquiredEpisodeKeys: new Set(),
            manualFields: [],
          });
          await emitFn?.(EventTypes.SeriesAdded, { seriesId: id, name, seasons: seasonCounts.size, episodeCount: episodes.size, monitored, monitorMode });
          await persist();
          return { seriesId: id, created: true };
        }
        case "list-series":
          return {
            series: [...shows.entries()]
              .map(([seriesId, rec]) => ({
                seriesId,
                name: rec.name,
                monitored: rec.monitored,
                profile: rec.profile,
                seasons: rec.seasons,
                episodeCount: rec.episodes.size,
                monitorMode: rec.monitorMode,
                ...(rec.destinationLibraryId ? { destinationLibraryId: rec.destinationLibraryId } : {}),
                ...(rec.minimumAvailability ? { minimumAvailability: rec.minimumAvailability } : {}),
                ...(rec.year !== undefined ? { year: rec.year } : {}),
                ...(rec.externalId ? { externalId: rec.externalId } : {}),
                ...(rec.provider ? { provider: rec.provider } : {}),
                ...(rec.overview !== undefined ? { overview: rec.overview } : {}),
                ...(rec.artworkUrl ? { artworkUrl: rec.artworkUrl } : {}),
                acquiredEpisodeCount: rec.acquiredEpisodeKeys.size,
                acquisitionState: !rec.monitored
                  ? "unmonitored"
                  : rec.episodes.size > 0 && rec.acquiredEpisodeKeys.size >= rec.episodes.size
                    ? "available"
                    : "wanted",
              }))
              .sort((a, b) => a.name.localeCompare(b.name)),
          };
        case "get-series": {
          const rec = shows.get(String(payload.seriesId ?? ""));
          if (!rec) throw new Error(`unknown series ${String(payload.seriesId)}`);
          return {
            seriesId: String(payload.seriesId),
            name: rec.name,
            ...(rec.year !== undefined ? { year: rec.year } : {}),
            monitored: rec.monitored,
            profile: rec.profile,
            seasons: rec.seasons,
            episodeCount: rec.episodes.size,
            monitorMode: rec.monitorMode,
            ...(rec.destinationLibraryId ? { destinationLibraryId: rec.destinationLibraryId } : {}),
            ...(rec.minimumAvailability ? { minimumAvailability: rec.minimumAvailability } : {}),
            ...(rec.externalId ? { externalId: rec.externalId } : {}),
            ...(rec.provider ? { provider: rec.provider } : {}),
            ...(rec.overview !== undefined ? { overview: rec.overview } : {}),
            ...(rec.artworkUrl ? { artworkUrl: rec.artworkUrl } : {}),
            acquiredEpisodeKeys: [...rec.acquiredEpisodeKeys],
            manualFields: rec.manualFields ?? [],
            episodes: [...rec.episodes.entries()].map(([episodeKey, episode]) => ({ episodeKey, ...episode })),
          };
        }
        case "set-monitoring": {
          const rec = shows.get(String(payload.seriesId ?? ""));
          if (!rec) throw new Error(`unknown series ${String(payload.seriesId)}`);
          rec.monitored = Boolean(payload.monitored);
          rec.monitorMode = rec.monitored ? "all" : "none";
          await emitFn?.(EventTypes.SeriesMonitoringChanged, {
            seriesId: String(payload.seriesId),
            monitored: rec.monitored,
          });
          await persist();
          return { seriesId: String(payload.seriesId), monitored: rec.monitored };
        }
        case "set-monitor-mode": {
          const seriesId = String(payload.seriesId ?? "");
          const rec = shows.get(seriesId);
          if (!rec) throw new Error(`unknown series ${seriesId}`);
          const mode = payload.monitorMode;
          if (mode !== "all" && mode !== "future" && mode !== "missing" && mode !== "none") throw new Error("invalid monitorMode");
          rec.monitorMode = mode;
          rec.monitored = mode !== "none";
          await emitFn?.(EventTypes.SeriesMonitoringChanged, { seriesId, monitored: rec.monitored, monitorMode: mode });
          await persist();
          return { seriesId, monitored: rec.monitored, monitorMode: mode };
        }
        case "update-series": {
          const seriesId = String(payload.seriesId ?? "");
          const rec = shows.get(seriesId);
          if (!rec) throw new Error(`unknown series ${seriesId}`);
          if (payload.name !== undefined) {
            const name = String(payload.name).trim();
            if (!name) throw new Error("name required");
            rec.name = name;
          }
          if (typeof payload.year === "number") rec.year = Math.trunc(payload.year);
          if (payload.overview === null) delete rec.overview;
          else if (typeof payload.overview === "string") rec.overview = payload.overview;
          if (payload.artworkUrl === null) delete rec.artworkUrl;
          else if (typeof payload.artworkUrl === "string") rec.artworkUrl = payload.artworkUrl;
          if (typeof payload.destinationLibraryId === "string") rec.destinationLibraryId = payload.destinationLibraryId;
          if (typeof payload.minimumAvailability === "string") rec.minimumAvailability = payload.minimumAvailability;
          if (payload.profile && typeof payload.profile === "object") rec.profile = payload.profile as QualityProfile;
          const mode = payload.monitorMode;
          if (mode === "all" || mode === "future" || mode === "missing" || mode === "none") {
            rec.monitorMode = mode;
            rec.monitored = mode !== "none";
          }
          if (Array.isArray(payload.manualFields)) {
            rec.manualFields = [...new Set(payload.manualFields.map(String).filter((field) => ["title", "year", "overview", "artworkUrl"].includes(field)))];
          }
          await persist();
          return { seriesId, updated: true };
        }
        case "delete-series": {
          const seriesId = String(payload.seriesId ?? "");
          const deleted = shows.delete(seriesId);
          if (deleted) await persist();
          return { seriesId, deleted };
        }
        case "wanted": {
          // Monitored episodes without an acquired release; the caller may
          // pass `acquiredKeys` (episode keys already grabbed/imported).
          const acquired = new Set(Array.isArray(payload.acquiredKeys) ? (payload.acquiredKeys as unknown[]).map(String) : []);
          const out: Array<{ seriesId: string; episodeKey: string; query: string }> = [];
          const today = new Date().toISOString().slice(0, 10);
          for (const [seriesId, rec] of shows) {
            if (!rec.monitored) continue;
            for (const [key, ep] of rec.episodes) {
              if (rec.monitorMode === "future" && ep.airDate && ep.airDate < today) continue;
              if (!rec.acquiredEpisodeKeys.has(key) && !acquired.has(`${seriesId}:${key}`)) {
                out.push({ seriesId, episodeKey: key, query: ep.query });
              }
            }
          }
          return { wanted: out };
        }
        case "search-episode": {
          // Record that a search fired for one episode (event-traced scan).
          const seriesId = String(payload.seriesId ?? "");
          const key = String(payload.episodeKey ?? "");
          const rec = shows.get(seriesId);
          if (!rec) throw new Error(`unknown series ${seriesId}`);
          const ep = rec.episodes.get(key);
          if (!ep) throw new Error(`unknown episode ${key}`);
          await emitFn?.(
            EventTypes.SeriesEpisodeSearched,
            { seriesId, episodeKey: key, query: ep.query },
            typeof payload.correlationId === "string" ? { correlationId: payload.correlationId } : undefined,
          );
          return { searched: true, query: ep.query };
        }
        case "mark-acquired": {
          const seriesId = String(payload.seriesId ?? "");
          const key = String(payload.episodeKey ?? "");
          const rec = shows.get(seriesId);
          if (!rec) throw new Error(`unknown series ${seriesId}`);
          if (!rec.episodes.has(key)) throw new Error(`unknown episode ${key}`);
          const marked = !rec.acquiredEpisodeKeys.has(key);
          rec.acquiredEpisodeKeys.add(key);
          if (marked) await persist();
          return { marked, seriesId, episodeKey: key };
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
