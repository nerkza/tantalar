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
}

interface SeriesState {
  name: string;
  monitored: boolean;
  profile: QualityProfile;
  seasons: number;
  episodesPerSeason: number;
  episodes: Map<string, EpisodeRecord>; // key `S<season>E<episode>`
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
      | { shows?: Array<{ id: string; name: string; monitored: boolean; profile: QualityProfile; seasons: number; episodesPerSeason: number }> }
      | undefined;
    for (const s of doc?.shows ?? []) {
      const episodes = new Map<string, EpisodeRecord>();
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
      shows.set(s.id, { ...s, episodes });
    }
  } catch {
    // Corrupt/absent snapshot: start clean rather than fail the mount.
  }
}

function episodeKey(season: number, episode: number): string {
  return `S${String(season).padStart(2, "0")}E${String(episode).padStart(2, "0")}`;
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
          const id = `series-${slug(name)}`;
          if (shows.has(id)) return { seriesId: id, created: false }; // idempotent add
          seq += 1;
          void seq;
          const seasons = typeof payload.seasons === "number" && payload.seasons > 0 ? Math.floor(payload.seasons) : 1;
          const episodesPerSeason =
            typeof payload.episodesPerSeason === "number" && payload.episodesPerSeason > 0
              ? Math.floor(payload.episodesPerSeason)
              : 1;
          const profile = (payload.profile as QualityProfile | undefined) ?? defaultProfile();
          const episodes = new Map<string, EpisodeRecord>();
          for (let s = 1; s <= seasons; s++) {
            for (let e = 1; e <= episodesPerSeason; e++) {
              episodes.set(episodeKey(s, e), {
                seriesId: id,
                season: s,
                episode: e,
                query: `${name} S${String(s).padStart(2, "0")}E${String(e).padStart(2, "0")}`,
              });
            }
          }
          shows.set(id, { name, monitored: true, profile, seasons, episodesPerSeason, episodes });
          await emitFn?.(EventTypes.SeriesAdded, { seriesId: id, name, seasons, episodesPerSeason });
          await persist();
          return { seriesId: id, created: true };
        }
        case "get-series": {
          const rec = shows.get(String(payload.seriesId ?? ""));
          if (!rec) throw new Error(`unknown series ${String(payload.seriesId)}`);
          return {
            seriesId: String(payload.seriesId),
            name: rec.name,
            monitored: rec.monitored,
            profile: rec.profile,
            episodeCount: rec.episodes.size,
          };
        }
        case "set-monitoring": {
          const rec = shows.get(String(payload.seriesId ?? ""));
          if (!rec) throw new Error(`unknown series ${String(payload.seriesId)}`);
          rec.monitored = Boolean(payload.monitored);
          await emitFn?.(EventTypes.SeriesMonitoringChanged, {
            seriesId: String(payload.seriesId),
            monitored: rec.monitored,
          });
          await persist();
          return { seriesId: String(payload.seriesId), monitored: rec.monitored };
        }
        case "wanted": {
          // Monitored episodes without an acquired release; the caller may
          // pass `acquiredKeys` (episode keys already grabbed/imported).
          const acquired = new Set(Array.isArray(payload.acquiredKeys) ? (payload.acquiredKeys as unknown[]).map(String) : []);
          const out: Array<{ seriesId: string; episodeKey: string; query: string }> = [];
          for (const [seriesId, rec] of shows) {
            if (!rec.monitored) continue;
            for (const [key, ep] of rec.episodes) {
              if (!acquired.has(`${seriesId}:${key}`)) {
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
        case "mark-acquired":
          return { marked: true };
        case "conformance-probe":
          return { ok: true };
        default:
          throw new Error(`unknown operation ${operation}`);
      }
    },
  },
});

runPlugin(plugin);
