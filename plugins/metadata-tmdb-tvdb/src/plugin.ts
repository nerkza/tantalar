/**
 * Metadata provider plugin (phase 4, story 14).
 *
 * Provides `dev.tantalar.capability.metadata-provider` backed by fixture
 * adapters for TMDB (movies) and TVDB (series). No network: responses come
 * from an in-process fixture catalog shaped like the real provider payloads,
 * adapted to the neutral MediaMetadata contract. Replaceable by a real
 * provider plugin without core changes.
 */
import { runPlugin, definePlugin, type PluginDefinition } from "@tantalar/plugin-sdk";
import { PROTOCOL_VERSION, validateManifest, EventTypes, type MediaMetadata } from "@tantalar/contracts";

const METADATA_CAPABILITY = "dev.tantalar.capability.metadata-provider";
const PLUGIN_ID = "dev.tantalar.plugin.metadata-tmdb-tvdb";

const manifest = validateManifest({
  id: PLUGIN_ID,
  version: "0.1.0",
  protocolVersion: PROTOCOL_VERSION,
  provides: [METADATA_CAPABILITY],
  requires: ["dev.tantalar.capability.event.emit", "dev.tantalar.capability.log"],
  subscriptions: [],
  entry: { command: "node dist/plugin.js" },
});

// ---- Fixture catalogs (shaped like trimmed TMDB/TVDB payloads) -----------------

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

/** Trimmed TVDB-style series response fixtures. */
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

/** Trimmed TMDB-style movie response fixtures. */
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

let emitFn:
  | ((type: string, payload: Record<string, unknown>, opts?: { correlationId?: string }) => Promise<void>)
  | null = null;

const plugin: PluginDefinition = definePlugin({
  manifest,
  mount(ctx) {
    emitFn = async (type, payload, opts) => ctx.emit(type, payload, opts);
    ctx.log("info", "metadata provider mounted (fixture tmdb/tvdb)");
  },
  unmount(ctx) {
    emitFn = null;
    ctx.log("info", "metadata provider unmounted");
  },
  handlers: {
    [METADATA_CAPABILITY]: async (operation, payload) => {
      switch (operation) {
        case "lookup": {
          const kind = payload.kind === "movie" ? "movie" : "series";
          const name = String(payload.name ?? "");
          if (!name) throw new Error("name required");
          let meta: MediaMetadata | null = null;
          if (kind === "series") {
            const fx =
              seriesFixtures.find((s) => s.name.toLowerCase() === name.toLowerCase()) ??
              seriesFixtures.find((s) => slug(s.name) === slug(name));
            if (!fx) return { found: false };
            const season = typeof payload.season === "number" ? Math.trunc(payload.season) : 1;
            const episode = typeof payload.episode === "number" ? Math.trunc(payload.episode) : 1;
            const epKey = `S${String(season).padStart(2, "0")}E${String(episode).padStart(2, "0")}`;
            const ep = fx.episodes[epKey];
            meta = {
              externalId: fx.tvdbId,
              kind,
              name: fx.name,
              overview: ep ? `${ep.title} — ${fx.overview}` : fx.overview,
              year: Number(fx.firstAired.slice(0, 4)),
              ...(ep ? { airDate: ep.airDate } : {}),
              artworkUrl: fx.artworkUrl,
              provider: "tvdb-fixture",
            };
          } else {
            const year = typeof payload.year === "number" ? Math.trunc(payload.year) : undefined;
            const fx =
              movieFixtures.find((m) => m.title.toLowerCase() === name.toLowerCase() && (!year || m.year === year)) ??
              movieFixtures.find((m) => slug(m.title) === slug(name));
            if (!fx) return { found: false };
            meta = {
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
          await emitFn?.(
            EventTypes.MetadataRefreshed,
            { externalId: meta.externalId, kind: meta.kind, name: meta.name, provider: meta.provider },
            typeof payload.correlationId === "string" ? { correlationId: payload.correlationId } : undefined,
          );
          return { found: true, metadata: meta };
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
