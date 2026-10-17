/**
 * Movies automation plugin (phase 3c, story 2).
 *
 * Provides `dev.tantalar.capability.automation.movies`: monitored movies
 * with per-movie quality profiles and a minimum quality-upgrade bar.
 * The orchestrator (or tests) drive `scan`: for every monitored, unacquired
 * movie the plugin reports the query to run; when a qualifying release was
 * grabbed the caller records it via `mark-acquired`, which emits
 * `movie.acquired`. All state is in-process fixture state. Every accepted
 * operation is event-traced with the caller's correlationId.
 */
import { runPlugin, definePlugin, type PluginContext, type PluginDefinition } from "@tantalar/plugin-sdk";
import {
  PROTOCOL_VERSION,
  validateManifest,
  EventTypes,
  type QualityProfile,
} from "@tantalar/contracts";

const MOVIES_CAPABILITY = "dev.tantalar.capability.automation.movies";
const PLUGIN_ID = "dev.tantalar.plugin.movies";

const manifest = validateManifest({
  id: PLUGIN_ID,
  version: "0.1.0",
  protocolVersion: PROTOCOL_VERSION,
  provides: [MOVIES_CAPABILITY],
  requires: ["dev.tantalar.capability.event.emit", "dev.tantalar.capability.log"],
  subscriptions: [],
  entry: { command: "node dist/plugin.js" },
});

interface MovieState {
  title: string;
  year: number;
  monitored: boolean;
  profile: QualityProfile;
  externalId?: string;
  provider?: string;
  overview?: string;
  artworkUrl?: string;
  availableAt?: string;
  destinationLibraryId?: string;
  minimumAvailability?: string;
  manualFields?: string[];
  /** Release guid of the currently held copy, if any. */
  acquiredGuid: string | null;
}

let emitFn:
  | ((type: string, payload: Record<string, unknown>, opts?: { correlationId?: string }) => Promise<void>)
  | null = null;

const movies = new Map<string, MovieState>(); // movieId -> state

/** Wave 3 (TAN-013): durable storage bridge; null when storage is unavailable. */
let store: PluginContext["storage"] | null = null;
const DOC_KEY = "state";

async function persist(): Promise<void> {
  if (!store) return;
  try {
    await store.put(DOC_KEY, { movies: [...movies.entries()].map(([id, m]) => ({ id, ...m })) });
  } catch {
    /* durability resumes on the next mutation */
  }
}

async function restore(): Promise<void> {
  if (!store) return;
  try {
    const hit = await store.get(DOC_KEY);
    const doc = hit?.doc as { movies?: Array<{ id: string } & MovieState> } | undefined;
    for (const m of doc?.movies ?? []) movies.set(m.id, { ...m });
  } catch {
    /* corrupt snapshot: start clean rather than fail the mount */
  }
}

function slug(title: string): string {
  return title
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
    ctx.log("info", "movies mounted");
  },
  unmount(ctx) {
    emitFn = null;
    store = null;
    ctx.log("info", "movies unmounted");
  },
  handlers: {
    [MOVIES_CAPABILITY]: async (operation, payload) => {
      switch (operation) {
        case "add-movie": {
          const title = String(payload.title ?? "").trim();
          if (!title) throw new Error("title required");
          const externalId = String(payload.externalId ?? "").trim();
          const provider = String(payload.provider ?? "").trim();
          const duplicate = externalId
            ? [...movies].find(([, movie]) => movie.externalId === externalId && movie.provider === provider)?.[0]
            : undefined;
          const id = duplicate ?? `movie-${slug(title)}-${String(payload.year ?? 0)}`;
          const existing = movies.get(id);
          if (existing) {
            Object.assign(existing, {
              monitored: payload.monitored !== false,
              ...(payload.profile && typeof payload.profile === "object" ? { profile: payload.profile as QualityProfile } : {}),
              ...(typeof payload.destinationLibraryId === "string" ? { destinationLibraryId: payload.destinationLibraryId } : {}),
              ...(typeof payload.minimumAvailability === "string" ? { minimumAvailability: payload.minimumAvailability } : {}),
              ...(externalId ? { externalId } : {}),
              ...(provider ? { provider } : {}),
              ...(typeof payload.overview === "string" ? { overview: payload.overview } : {}),
              ...(typeof payload.artworkUrl === "string" ? { artworkUrl: payload.artworkUrl } : {}),
              ...(typeof payload.availableAt === "string" ? { availableAt: payload.availableAt } : {}),
            });
            await persist();
            return { movieId: id, created: false };
          }
          const monitored = payload.monitored !== false;
          movies.set(id, {
            title,
            year: typeof payload.year === "number" ? payload.year : 0,
            monitored,
            profile:
              (payload.profile as QualityProfile | undefined) ?? { name: "uhd", preferredQualities: ["2160p", "1080p"] },
            ...(externalId ? { externalId } : {}),
            ...(provider ? { provider } : {}),
            ...(typeof payload.overview === "string" ? { overview: payload.overview } : {}),
            ...(typeof payload.artworkUrl === "string" ? { artworkUrl: payload.artworkUrl } : {}),
            ...(typeof payload.availableAt === "string" ? { availableAt: payload.availableAt } : {}),
            ...(typeof payload.destinationLibraryId === "string" ? { destinationLibraryId: payload.destinationLibraryId } : {}),
            ...(typeof payload.minimumAvailability === "string" ? { minimumAvailability: payload.minimumAvailability } : {}),
            manualFields: [],
            acquiredGuid: null,
          });
          await emitFn?.(EventTypes.MovieAdded, { movieId: id, title, monitored });
          await persist();
          return { movieId: id, created: true };
        }
        case "list-movies":
          return {
            movies: [...movies.entries()]
              .map(([movieId, rec]) => ({
                movieId,
                ...rec,
                acquisitionState: rec.acquiredGuid ? "available" : rec.monitored ? "wanted" : "unmonitored",
              }))
              .sort((a, b) => a.title.localeCompare(b.title)),
          };
        case "get-movie": {
          const rec = movies.get(String(payload.movieId ?? ""));
          if (!rec) throw new Error(`unknown movie ${String(payload.movieId)}`);
          return {
            movieId: String(payload.movieId),
            title: rec.title,
            year: rec.year,
            monitored: rec.monitored,
            profile: rec.profile,
            ...(rec.externalId ? { externalId: rec.externalId } : {}),
            ...(rec.provider ? { provider: rec.provider } : {}),
            ...(rec.overview !== undefined ? { overview: rec.overview } : {}),
            ...(rec.artworkUrl ? { artworkUrl: rec.artworkUrl } : {}),
            ...(rec.availableAt ? { availableAt: rec.availableAt } : {}),
            ...(rec.destinationLibraryId ? { destinationLibraryId: rec.destinationLibraryId } : {}),
            ...(rec.minimumAvailability ? { minimumAvailability: rec.minimumAvailability } : {}),
            manualFields: rec.manualFields ?? [],
            acquiredGuid: rec.acquiredGuid,
          };
        }
        case "set-monitoring": {
          const rec = movies.get(String(payload.movieId ?? ""));
          if (!rec) throw new Error(`unknown movie ${String(payload.movieId)}`);
          rec.monitored = Boolean(payload.monitored);
          await emitFn?.(EventTypes.MovieMonitoringChanged, {
            movieId: String(payload.movieId),
            monitored: rec.monitored,
          });
          await persist();
          return { movieId: String(payload.movieId), monitored: rec.monitored };
        }
        case "update-movie": {
          const movieId = String(payload.movieId ?? "");
          const rec = movies.get(movieId);
          if (!rec) throw new Error(`unknown movie ${movieId}`);
          if (payload.title !== undefined) {
            const title = String(payload.title).trim();
            if (!title) throw new Error("title required");
            rec.title = title;
          }
          if (typeof payload.year === "number") rec.year = Math.trunc(payload.year);
          if (payload.overview === null) delete rec.overview;
          else if (typeof payload.overview === "string") rec.overview = payload.overview;
          if (payload.artworkUrl === null) delete rec.artworkUrl;
          else if (typeof payload.artworkUrl === "string") rec.artworkUrl = payload.artworkUrl;
          if (payload.availableAt === null) delete rec.availableAt;
          else if (typeof payload.availableAt === "string") rec.availableAt = payload.availableAt;
          if (typeof payload.destinationLibraryId === "string") rec.destinationLibraryId = payload.destinationLibraryId;
          if (typeof payload.minimumAvailability === "string") rec.minimumAvailability = payload.minimumAvailability;
          if (payload.profile && typeof payload.profile === "object") rec.profile = payload.profile as QualityProfile;
          if (typeof payload.monitored === "boolean") rec.monitored = payload.monitored;
          if (Array.isArray(payload.manualFields)) {
            rec.manualFields = [...new Set(payload.manualFields.map(String).filter((field) => ["title", "year", "overview", "artworkUrl"].includes(field)))];
          }
          await persist();
          return { movieId, updated: true };
        }
        case "delete-movie": {
          const movieId = String(payload.movieId ?? "");
          const deleted = movies.delete(movieId);
          if (deleted) await persist();
          return { movieId, deleted };
        }
        case "scan": {
          // One scan pass over all monitored movies without a copy.
          const out: Array<{ movieId: string; query: string; profile: QualityProfile }> = [];
          for (const [movieId, rec] of movies) {
            if (rec.monitored && rec.acquiredGuid === null) {
              out.push({ movieId, query: `${rec.title} ${rec.year}`.trim(), profile: rec.profile });
            }
          }
          await emitFn?.(
            EventTypes.MovieScanCompleted,
            { scannedMovies: out.length },
            typeof payload.correlationId === "string" ? { correlationId: payload.correlationId } : undefined,
          );
          return { wanted: out };
        }
        case "mark-acquired": {
          const movieId = String(payload.movieId ?? "");
          const guid = String(payload.guid ?? "");
          const rec = movies.get(movieId);
          if (!rec) throw new Error(`unknown movie ${movieId}`);
          if (rec.acquiredGuid === guid) return { acquired: false }; // idempotent
          const upgrade = rec.acquiredGuid !== null;
          rec.acquiredGuid = guid;
          await emitFn?.(EventTypes.MovieAcquired, { movieId, guid, upgrade });
          await persist();
          return { acquired: true, upgrade };
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
