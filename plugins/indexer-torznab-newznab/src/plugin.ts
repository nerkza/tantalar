/**
 * dev.tantalar.plugin.indexer-torznab-newznab (TAN-014) — real indexer
 * integration speaking the provider-neutral `dev.tantalar.capability.indexer`
 * contract over genuine Torznab (torrent) and Newznab (usenet) wire formats.
 *
 * Guarantees:
 *  - Credentials arrive ONLY through TANTALAR_SECRET_* env secrets or plugin
 *    config marked secret; they are never logged, echoed, or returned.
 *  - Caps (`t=caps`) are fetched once and cached with a TTL; a cached copy
 *    answers when the provider is down (outages cannot corrupt local state).
 *  - Rate limits use the shared rolling-window accounting; limit state and
 *    provider errors surface as events and structured IndexerError codes.
 *  - A transport seam (`setTransport`) lets tests inject responses without
 *    any network. Production uses fetch.
 */
import { runPlugin, definePlugin, type PluginContext, type PluginDefinition } from "@tantalar/plugin-sdk";
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
import {
  buildQueryUrl,
  parseCaps,
  parseResults,
  toCapabilities,
} from "./wire.js";

const INDEXER_CAPABILITY = "dev.tantalar.capability.indexer";
const PLUGIN_ID = "dev.tantalar.plugin.indexer-torznab-newznab";

const manifest = validateManifest({
  id: PLUGIN_ID,
  version: "0.1.0",
  protocolVersion: PROTOCOL_VERSION,
  provides: [INDEXER_CAPABILITY],
  requires: ["dev.tantalar.capability.event.emit", "dev.tantalar.capability.log"],
  subscriptions: [],
  entry: { command: "node dist/plugin.js" },
});

// ---- Configuration -------------------------------------------------------------

interface ProviderConfig {
  /** Torznab (torrent) or Newznab (nzb) protocol of the upstream provider. */
  protocol: "torznab" | "newznab";
  baseUrl: string;
  apiKey: string;
  priority: number;
  enabled: boolean;
  limits: IndexerLimits;
  /** Caps cache TTL in ms (default 24h). */
  capsTtlMs: number;
}

function loadConfig(): ProviderConfig {
  const raw = JSON.parse(process.env["TANTALAR_PLUGIN_CONFIG"] ?? "{}") as Record<string, unknown>;
  const protoRaw = String(raw.protocol ?? "torznab");
  const protocol: ProviderConfig["protocol"] = protoRaw === "newznab" ? "newznab" : "torznab";
  const lim = (raw.limits ?? {}) as Record<string, unknown>;
  return {
    protocol,
    baseUrl: String(raw.baseUrl ?? "").replace(/\/$/, ""),
    // Secrets may arrive as plain strings via config or via dedicated secret vars.
    apiKey: String(raw.apiKey ?? process.env["TANTALAR_SECRET_INDEXER_API_KEY"] ?? ""),
    priority: Number(raw.priority ?? 25),
    enabled: raw.enabled !== false,
    limits: {
      maxSearchesPerWindow: Number(lim.maxSearchesPerWindow ?? 0),
      windowMs: Number(lim.windowMs ?? 60_000),
      retentionDays: Number(lim.retentionDays ?? 0),
    },
    capsTtlMs: Number(raw.capsTtlMs ?? 24 * 60 * 60 * 1000),
  };
}

// ---- Transport seam --------------------------------------------------------------

export interface WireResponse {
  readonly status: number;
  readonly body: string;
}

export type WireTransport = (url: string) => Promise<WireResponse>;

let transport: WireTransport = async (url) => {
  const res = await fetch(url, { headers: { accept: "application/xml,text/xml" } });
  return { status: res.status, body: await res.text() };
};

/** Test hook: replace the HTTP transport. Returns the previous one. */
export function setTransport(next: WireTransport): WireTransport {
  const prev = transport;
  transport = next;
  return prev;
}

// ---- Rolling-window rate limiting ------------------------------------------------

class RateLimiter {
  readonly #stamps: number[] = [];
  constructor(private readonly limits: IndexerLimits) {}
  get cfg(): IndexerLimits {
    return this.limits;
  }
  admit(now = Date.now()): void {
    if (this.limits.maxSearchesPerWindow > 0) {
      while (this.#stamps.length > 0 && now - (this.#stamps[0] as number) > this.limits.windowMs) {
        this.#stamps.shift();
      }
      if (this.#stamps.length >= this.limits.maxSearchesPerWindow) {
        throw new IndexerError(
          "rate_limited",
          `provider search limit reached (${this.limits.maxSearchesPerWindow} per ${this.limits.windowMs}ms)`,
        );
      }
    }
    this.#stamps.push(now);
  }
  remaining(): number | null {
    if (this.limits.maxSearchesPerWindow <= 0) return null;
    return Math.max(0, this.limits.maxSearchesPerWindow - this.#stamps.length);
  }
}

// ---- Plugin state -------------------------------------------------------------------

interface CapsCache {
  doc: ReturnType<typeof toCapabilities> | null;
  at: number;
}

let emitFn:
  | ((type: string, payload: Record<string, unknown>, opts?: { correlationId?: string }) => Promise<void>)
  | null = null;
let logFn: PluginContext["log"] | null = null;
let storeGet: ((key: string) => Promise<{ doc: unknown } | null>) | null = null;
let storePut: ((key: string, doc: unknown) => Promise<void>) | null = null;

let cfg = loadConfig();
let limiter = new RateLimiter(cfg.limits);
const capsCache: CapsCache = { doc: null, at: 0 };
/** Last provider failure, for truthful status surfacing. */
let lastError: { code: string; message: string; at: string } | null = null;

const CAPS_STORE_KEY = "caps-cache";

async function persistCaps(): Promise<void> {
  if (!storePut || !capsCache.doc) return;
  try {
    await storePut(CAPS_STORE_KEY, { caps: capsCache.doc, at: capsCache.at });
  } catch {
    /* cache durability is best-effort; memory copy remains */
  }
}

async function restoreCaps(): Promise<void> {
  if (!storeGet) return;
  try {
    const hit = await storeGet(CAPS_STORE_KEY);
    const doc = hit?.doc as { caps?: CapsCache["doc"]; at?: number } | undefined;
    if (doc?.caps && typeof doc.at === "number") {
      capsCache.doc = doc.caps;
      capsCache.at = doc.at;
    }
  } catch {
    /* corrupt snapshot: refetch on demand */
  }
}

function redactUrl(url: string): string {
  // Never let an apikey leak into logs or events.
  return url.replace(/([?&])apikey=[^&]*/i, "$1apikey=[REDACTED]");
}

async function fetchCaps(force: boolean): Promise<ReturnType<typeof toCapabilities>> {
  const fresh = capsCache.doc !== null && Date.now() - capsCache.at < cfg.capsTtlMs;
  if (!force && fresh && capsCache.doc) return capsCache.doc;
  if (!cfg.baseUrl || !cfg.apiKey) {
    throw new IndexerError("invalid_query", "indexer is not configured (baseUrl and api key required)");
  }
  const capsUrl = `${cfg.baseUrl}/api?t=caps&apikey=${encodeURIComponent(cfg.apiKey)}`;
  try {
    const res = await transport(capsUrl);
    if (res.status === 401 || res.status === 403 || /invalid api key|authentication/i.test(res.body)) {
      throw new IndexerError("auth_failed", "provider rejected the configured api key");
    }
    if (res.status === 429) throw new IndexerError("rate_limited", "provider reported rate limiting (HTTP 429)");
    if (res.status >= 500) throw new IndexerError("unavailable", `provider unavailable (HTTP ${res.status})`);
    const parsed = parseCaps(res.body);
    const caps = toCapabilities(cfg.protocol, parsed, cfg.limits);
    capsCache.doc = caps;
    capsCache.at = Date.now();
    await persistCaps();
    await emitFn?.(EventTypes.IndexerCapsRefreshed, {
      indexerId: PLUGIN_ID,
      categoryCount: caps.categories.length,
      searchModes: [...caps.searchModes],
      source: "provider",
    });
    return caps;
  } catch (err) {
    // Outage safety: answer from the durable cache rather than corrupting state.
    if (!(err instanceof IndexerError)) {
      lastError = { code: "unavailable", message: String((err as Error).message ?? err), at: new Date().toISOString() };
      await emitFn?.(EventTypes.IndexerProviderError, {
        indexerId: PLUGIN_ID,
        code: "unavailable",
        message: String((err as Error).message ?? err),
        op: "caps",
        servedFromCache: false,
      });
    } else {
      lastError = { code: err.code, message: err.message, at: new Date().toISOString() };
      await emitFn?.(EventTypes.IndexerProviderError, {
        indexerId: PLUGIN_ID,
        code: err.code,
        message: err.message,
        op: "caps",
        servedFromCache: false,
      });
    }
    throw err;
  }
}

function mapMode(q: IndexerQuery): "search" | "tv-search" | "movie-search" {
  if (q.categories?.includes(2000)) return "tv-search";
  if (q.categories?.includes(1000)) return "movie-search";
  return "search";
}

async function doSearch(rawQuery: unknown): Promise<IndexerSearchResult> {
  const q = validateIndexerQuery(rawQuery);
  if (!cfg.enabled) throw new IndexerError("unavailable", "indexer is disabled");
  limiter.admit();
  if (!cfg.baseUrl || !cfg.apiKey) {
    throw new IndexerError("auth_failed", "indexer has no configured credentials");
  }

  // Prefer tv/movie search modes only when the discovered caps support them.
  let mode: "search" | "tv-search" | "movie-search" = mapMode(q);
  const caps = capsCache.doc;
  if (mode !== "search" && caps && !caps.searchModes.includes(mode)) mode = "search";

  const season = typeof (rawQuery as Record<string, unknown>).season === "number"
    ? Math.trunc((rawQuery as Record<string, unknown>).season as number)
    : undefined;
  const episode = typeof (rawQuery as Record<string, unknown>).episode === "number"
    ? Math.trunc((rawQuery as Record<string, unknown>).episode as number)
    : undefined;

  const url = buildQueryUrl({
    baseUrl: cfg.baseUrl,
    protocol: cfg.protocol,
    apiKey: cfg.apiKey,
    mode,
    query: q.query,
    ...(q.categories !== undefined ? { categories: q.categories } : {}),
    ...(q.limit !== undefined ? { limit: q.limit } : {}),
    ...(season !== undefined ? { season } : {}),
    ...(episode !== undefined ? { episode } : {}),
  });

  let releases: readonly IndexedRelease[];
  try {
    const res = await transport(url);
    if (res.status === 401 || res.status === 403) {
      throw new IndexerError("auth_failed", "provider rejected the configured api key");
    }
    if (res.status === 429) throw new IndexerError("rate_limited", "provider reported rate limiting (HTTP 429)");
    if (res.status >= 500) throw new IndexerError("unavailable", `provider unavailable (HTTP ${res.status})`);
    releases = parseResults(res.body, cfg.protocol === "newznab" ? "nzb" : "torrent")
      .filter((r) => (q.mode === "automatic" && cfg.limits.retentionDays > 0
        ? (Date.now() - Date.parse(r.publishedAt)) / 86_400_000 <= cfg.limits.retentionDays
        : true))
      .map((r) =>
        validateIndexedRelease({
          ...r,
          categories: r.categories,
          indexerId: PLUGIN_ID,
        }),
      );
    lastError = null;
  } catch (err) {
    const code = err instanceof IndexerError ? err.code : "unavailable";
    const message = err instanceof Error ? err.message : String(err);
    lastError = { code, message, at: new Date().toISOString() };
    await emitFn?.(EventTypes.IndexerProviderError, {
      indexerId: PLUGIN_ID,
      code,
      message,
      op: "search",
      queryUrl: redactUrl(url),
    });
    throw err;
  }

  const limited = q.limit !== undefined ? releases.slice(0, q.limit) : releases;
  const hasMore = releases.length > limited.length;
  await emitFn?.(
    EventTypes.IndexerSearched,
    {
      indexerId: PLUGIN_ID,
      mode: q.mode,
      query: q.query,
      resultCount: limited.length,
      hasMore,
      priority: cfg.priority,
    },
    q.correlationId !== undefined ? { correlationId: q.correlationId } : undefined,
  );
  return { releases: limited, hasMore, remainingInWindow: limiter.remaining() };
}

const plugin: PluginDefinition = definePlugin({
  manifest,
  async mount(ctx) {
    emitFn = async (type, payload, opts) => ctx.emit(type, payload, opts);
    logFn = (level, message) => ctx.log(level, message);
    storeGet = (key) => ctx.storage.get(key);
    storePut = (key, doc) => ctx.storage.put(key, doc);
    cfg = loadConfig();
    limiter = new RateLimiter(cfg.limits);
    await restoreCaps();
    ctx.log("info", `indexer-torznab-newznab mounted (${cfg.protocol})`);
  },
  async unmount(ctx) {
    emitFn = null;
    logFn = null;
    storeGet = null;
    storePut = null;
    ctx.log("info", "indexer-torznab-newznab unmounted");
  },
  handlers: {
    [INDEXER_CAPABILITY]: async (operation, payload) => {
      switch (operation) {
        case "search":
          return doSearch(payload);
        case "limits":
          return { ...limiter.cfg, priority: cfg.priority };
        case "capabilities":
          return fetchCaps(payload.force === true);
        case "status": {
          const capsFresh = capsCache.doc !== null && Date.now() - capsCache.at < cfg.capsTtlMs;
          return {
            enabled: cfg.enabled,
            priority: cfg.priority,
            protocol: cfg.protocol,
            configured: Boolean(cfg.baseUrl && cfg.apiKey),
            capsCached: capsCache.doc !== null,
            capsFresh,
            remainingInWindow: limiter.remaining(),
            ...(lastError ? { lastError } : {}),
          };
        }
        case "conformance-probe":
          return { ok: true };
        default:
          throw new IndexerError("invalid_query", `unknown operation ${operation}`);
      }
    },
  },
});

runPlugin(plugin);
