/**
 * Fixture indexer plugin (phase 3a, stories 3+4 plumbing).
 *
 * Implements `dev.tantalar.capability.indexer` with the provider-neutral
 * search/query/result schemas from @tantalar/contracts. All releases come
 * from an in-process fixture catalog — no network, no tracker-specific
 * logic (ADR-0015). Supports:
 *   - automatic and interactive query modes
 *   - normalized results validated against the canonical schema
 *   - rate limits (rolling window) and retention (min release age)
 *   - structured IndexerError failures
 *   - one `dev.tantalar.event.indexer.searched` event per accepted search,
 *     carrying the caller's correlationId for event-log tracing.
 *
 * Prowlarr-compatible definition formats are NOT parsed here: they are the
 * job of a dedicated adapter plugin (evaluation outcome recorded in the
 * phase-3a exit evidence). This fixture speaks only the neutral schema.
 */
import { runPlugin, definePlugin, type PluginDefinition } from "@tantalar/plugin-sdk";
import {
  PROTOCOL_VERSION,
  validateManifest,
  validateIndexerQuery,
  validateIndexedRelease,
  EventTypes,
  IndexerError,
  type IndexedRelease,
  type IndexerLimits,
  type IndexerQuery,
  type IndexerSearchResult,
} from "@tantalar/contracts";

const INDEXER_CAPABILITY = "dev.tantalar.capability.indexer";
const INDEXER_ID = "dev.tantalar.plugin.fixture-indexer";

const manifest = validateManifest({
  id: INDEXER_ID,
  version: "0.1.0",
  protocolVersion: PROTOCOL_VERSION,
  provides: [INDEXER_CAPABILITY],
  requires: ["dev.tantalar.capability.event.emit", "dev.tantalar.capability.log"],
  subscriptions: [],
  entry: { command: "node dist/plugin.js" },
});

interface CatalogEntry {
  readonly guid: string;
  readonly title: string;
  readonly kind: "nzb" | "torrent";
  readonly downloadUrl: string;
  readonly sizeBytes: number;
  readonly ageDays: number;
  readonly seeders?: number;
  readonly leechers?: number;
  readonly categories: number[];
}

/** Deterministic fixture catalog; `ageDays` is relative to boot time. */
const CATALOG: readonly CatalogEntry[] = [
  {
    guid: "fixture-nzb-0001",
    title: "Fixture Show S01E01 1080p WEB-DL",
    kind: "nzb",
    downloadUrl: "https://fixture.invalid/nzb/0001.nzb",
    sizeBytes: 1_073_741_824,
    ageDays: 30,
    categories: [2000, 5000],
  },
  {
    guid: "fixture-torrent-0002",
    title: "Fixture Show S01E01 720p HDTV",
    kind: "torrent",
    downloadUrl: "magnet:?xt=urn:btih:fixture0002",
    sizeBytes: 536_870_912,
    ageDays: 1,
    seeders: 40,
    leechers: 2,
    categories: [2000],
  },
  {
    guid: "fixture-torrent-0003",
    title: "Fixture Movie 2024 2160p BluRay",
    kind: "torrent",
    downloadUrl: "magnet:?xt=urn:btih:fixture0003",
    sizeBytes: 16_106_127_360,
    ageDays: 400,
    seeders: 120,
    leechers: 5,
    categories: [1000],
  },
];

const DEFAULT_LIMITS: IndexerLimits = {
  maxSearchesPerWindow: 0, // unlimited unless configured
  windowMs: 60_000,
  retentionDays: 0,
};

/** Rolling-window search accounting and retention enforcement state. */
class RateLimiter {
  readonly #stamps: number[] = [];
  constructor(private readonly cfgLimits: IndexerLimits) {}
  get limits(): IndexerLimits {
    return this.cfgLimits;
  }
  /** Throws rate_limited when over budget; records an accepted search otherwise. */
  admit(now = Date.now()): void {
    if (this.limits.maxSearchesPerWindow > 0) {
      while (this.#stamps.length > 0 && now - (this.#stamps[0] as number) > this.limits.windowMs) {
        this.#stamps.shift();
      }
      if (this.#stamps.length >= this.limits.maxSearchesPerWindow) {
        throw new IndexerError(
          "rate_limited",
          `automatic search limit reached (${this.limits.maxSearchesPerWindow}/${this.limits.windowMs}ms)`,
        );
      }
    }
    this.#stamps.push(now);
  }
  remainingInWindow(): number | null {
    if (this.limits.maxSearchesPerWindow <= 0) return null;
    return Math.max(0, this.limits.maxSearchesPerWindow - this.#stamps.length);
  }
}

function loadConfig(): Record<string, unknown> {
  return JSON.parse(process.env["TANTALAR_PLUGIN_CONFIG"] ?? "{}") as Record<string, unknown>;
}

function loadLimits(cfg: Record<string, unknown>): IndexerLimits {
  const raw = (cfg.limits ?? {}) as Record<string, unknown>;
  return {
    maxSearchesPerWindow:
      typeof raw.maxSearchesPerWindow === "number" && raw.maxSearchesPerWindow >= 0
        ? Math.floor(raw.maxSearchesPerWindow)
        : DEFAULT_LIMITS.maxSearchesPerWindow,
    windowMs: typeof raw.windowMs === "number" && raw.windowMs > 0 ? raw.windowMs : DEFAULT_LIMITS.windowMs,
    retentionDays:
      typeof raw.retentionDays === "number" && raw.retentionDays >= 0
        ? raw.retentionDays
        : DEFAULT_LIMITS.retentionDays,
  };
}

function normalize(entry: CatalogEntry, bootMs: number): IndexedRelease {
  return validateIndexedRelease({
    guid: entry.guid,
    title: entry.title,
    kind: entry.kind,
    downloadUrl: entry.downloadUrl,
    sizeBytes: entry.sizeBytes,
    publishedAt: new Date(bootMs - entry.ageDays * 86_400_000).toISOString(),
    ...(entry.seeders !== undefined ? { seeders: entry.seeders } : {}),
    ...(entry.leechers !== undefined ? { leechers: entry.leechers } : {}),
    categories: entry.categories,
    indexerId: INDEXER_ID,
  });
}

let limiter = new RateLimiter(loadLimits(loadConfig()));
const bootMs = Date.now();
let emitFn: ((type: string, payload: Record<string, unknown>, opts?: { correlationId?: string }) => Promise<void>) | null =
  null;

async function search(rawQuery: unknown): Promise<IndexerSearchResult> {
  const q: IndexerQuery = validateIndexerQuery(rawQuery);
  const matches = CATALOG.filter((e) => e.title.toLowerCase().includes(q.query.toLowerCase()));
  // Retention applies to automatic searches only: releases older than the
  // configured minimum retention window are no longer fetchable from the
  // provider, so they are filtered out of unattended result sets.
  // Interactive searches are operator-driven and see everything.
  const effective =
    q.mode === "automatic" && limiter.limits.retentionDays > 0
      ? matches.filter((e) => e.ageDays <= limiter.limits.retentionDays)
      : matches;
  limiter.admit();

  const normalized = effective.map((e) => normalize(e, bootMs));
  const limit = q.limit ?? normalized.length;
  const releases = normalized.slice(0, limit);

  await emitFn?.(
    EventTypes.IndexerSearched,
    {
      indexerId: INDEXER_ID,
      mode: q.mode,
      query: q.query,
      resultCount: releases.length,
      hasMore: normalized.length > limit,
    },
    q.correlationId !== undefined ? { correlationId: q.correlationId } : undefined,
  );

  return {
    releases,
    hasMore: normalized.length > limit,
    remainingInWindow: limiter.remainingInWindow(),
  };
}

const plugin: PluginDefinition = definePlugin({
  manifest,
  mount(ctx) {
    limiter = new RateLimiter(loadLimits(ctx.config));
    emitFn = async (type, payload, opts) => {
      await ctx.emit(type, payload, opts);
    };
    ctx.log("info", "fixture-indexer mounted");
  },
  unmount(ctx) {
    emitFn = null;
    ctx.log("info", "fixture-indexer unmounted");
  },
  handlers: {
    [INDEXER_CAPABILITY]: async (operation, payload) => {
      switch (operation) {
        case "search":
          return search(payload);
        case "limits":
          return limiter.limits;
        case "parse": {
          // Normalization surface: accept a catalog guid, return the
          // canonical release shape (or parse_error for unknown ids).
          const entry = CATALOG.find((c) => c.guid === payload.guid);
          if (!entry) throw new IndexerError("parse_error", `unknown fixture guid ${String(payload.guid)}`);
          return normalize(entry, bootMs);
        }
        case "conformance-probe":
          // Testkit probe: any defined result satisfies the conformance case.
          return { ok: true };
        default:
          throw new IndexerError("invalid_query", `unknown operation ${operation}`);
      }
    },
  },
});

runPlugin(plugin);
