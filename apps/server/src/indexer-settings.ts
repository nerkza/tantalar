/**
 * Wave 7 (TAN-014): core indexer-settings service — the operator surface to
 * ADD, EDIT, TEST, ENABLE, and DELETE Torznab/Newznab indexer configurations.
 *
 * Locked decisions implemented here:
 *  - API keys arrive through this API or TANTALAR_SECRET_* env secrets and
 *    are NEVER returned, logged, or echoed: every read returns a redacted
 *    record with only `hasApiKey`;
 *  - baseUrl must be a valid http(s) URL; unconfigured indexers fail closed
 *    at search time inside the provider plugin;
 *  - `test` performs a real caps probe through an injectable transport seam
 *    (tests inject responses; production uses fetch) and maps failures to
 *    structured codes instead of leaking provider error bodies;
 *  - records live in the durable `plugin_documents` table under the reserved
 *    owner `dev.tantalar.core.indexers`, so settings survive restarts.
 */
import type { Kysely } from "kysely";
import { PluginDocumentStore } from "@tantalar/db";
import {
  IndexerError,
  uuidv7,
  validateIndexedRelease,
  validateIndexerQuery,
  type IndexedRelease,
  type IndexerSearchResult,
} from "@tantalar/contracts";
import type { Db } from "@tantalar/db";
import { buildQueryUrl, parseCaps, parseResults } from "dev.tantalar.plugin.indexer-torznab-newznab/wire";

const OWNER = "dev.tantalar.core.indexers";

export class IndexerSettingsError extends Error {
  readonly statusCode: number;
  constructor(message: string, statusCode: number) {
    super(message);
    this.statusCode = statusCode;
    this.name = "IndexerSettingsError";
  }
}

export interface IndexerSettingsRecord {
  readonly id: string;
  readonly name: string;
  readonly protocol: "torznab" | "newznab";
  readonly baseUrl: string;
  /** Stored but NEVER returned by list/get. */
  readonly apiKey: string;
  readonly priority: number;
  readonly enabled: boolean;
  readonly maxSearchesPerWindow: number;
  readonly windowMs: number;
  readonly retentionDays: number;
  readonly interactiveSearch: boolean;
  readonly automaticSearch: boolean;
  readonly categories: readonly number[];
  readonly tags: readonly string[];
  readonly capabilities?: {
    readonly searchModes: readonly ("search" | "tv-search" | "movie-search")[];
    readonly categories: ReadonlyArray<{ id: number; name: string }>;
    readonly testedAt: string;
  };
}

/** Redacted public shape: safe to return over HTTP. */
export interface RedactedIndexer {
  id: string;
  name: string;
  protocol: "torznab" | "newznab";
  baseUrl: string;
  hasApiKey: boolean;
  priority: number;
  enabled: boolean;
  searchModes: { interactive: boolean; automatic: boolean };
  categories: readonly number[];
  tags: readonly string[];
  capabilities?: IndexerSettingsRecord["capabilities"];
  limits: { maxSearchesPerWindow: number; windowMs: number; retentionDays: number };
}

function redact(r: IndexerSettingsRecord): RedactedIndexer {
  return {
    id: r.id,
    name: r.name,
    protocol: r.protocol,
    baseUrl: r.baseUrl,
    hasApiKey: r.apiKey.length > 0,
    priority: r.priority,
    enabled: r.enabled,
    searchModes: { interactive: r.interactiveSearch, automatic: r.automaticSearch },
    categories: r.categories,
    tags: r.tags,
    ...(r.capabilities ? { capabilities: r.capabilities } : {}),
    limits: {
      maxSearchesPerWindow: r.maxSearchesPerWindow,
      windowMs: r.windowMs,
      retentionDays: r.retentionDays,
    },
  };
}

export interface AddIndexerInput {
  name: string;
  protocol: "torznab" | "newznab";
  baseUrl: string;
  apiKey?: string;
  priority?: number;
  enabled?: boolean;
  searchModes?: { interactive?: boolean; automatic?: boolean };
  categories?: readonly number[];
  tags?: readonly string[];
  limits?: { maxSearchesPerWindow?: number; windowMs?: number; retentionDays?: number };
}

export interface UpdateIndexerInput {
  name?: string;
  protocol?: "torznab" | "newznab";
  baseUrl?: string;
  /** Blank or omitted keeps the stored key. */
  apiKey?: string;
  priority?: number;
  enabled?: boolean;
  searchModes?: { interactive?: boolean; automatic?: boolean };
  categories?: readonly number[];
  tags?: readonly string[];
  limits?: { maxSearchesPerWindow?: number; windowMs?: number; retentionDays?: number };
}

export interface TestOutcome {
  readonly ok: boolean;
  readonly code?: "auth_failed" | "unavailable" | "parse_error" | "invalid_query";
  readonly detail: string;
  readonly categoryCount?: number;
  readonly searchModes?: readonly string[];
  /** Never includes the apikey. */
  readonly probedUrl: string;
}

function redactUrl(url: string): string {
  return url.replace(/([?&])apikey=[^&]*/i, "$1apikey=[REDACTED]");
}

/** Transport seam: tests inject canned caps responses; production uses fetch. */
export type CapsTransport = (url: string) => Promise<{ status: number; body: string }>;

const defaultTransport: CapsTransport = async (url) => {
  const res = await fetch(url, { headers: { accept: "application/xml,text/xml" } });
  return { status: res.status, body: await res.text() };
};

export class IndexerSettingsService {
  readonly #db: Kysely<Db>;
  readonly #store: PluginDocumentStore;
  #transport: CapsTransport = defaultTransport;
  #onChanged: () => Promise<void> = async () => undefined;
  readonly #searchWindows = new Map<string, number[]>();

  constructor(db: Kysely<Db>) {
    this.#db = db;
    this.#store = new PluginDocumentStore(db);
  }

  /** Test hook: replace the caps transport. Returns the previous one. */
  setTransport(next: CapsTransport): CapsTransport {
    const prev = this.#transport;
    this.#transport = next;
    return prev;
  }

  setOnChanged(callback: () => Promise<void>): void {
    this.#onChanged = callback;
  }

  async #put(record: IndexerSettingsRecord): Promise<void> {
    await this.#store.put(OWNER, record.id, record);
    await this.#onChanged();
  }

  #parse(doc: unknown): IndexerSettingsRecord | null {
    if (!doc || typeof doc !== "object") return null;
    const r = doc as Partial<IndexerSettingsRecord>;
    if (
      typeof r.id !== "string" ||
      typeof r.name !== "string" ||
      (r.protocol !== "torznab" && r.protocol !== "newznab") ||
      typeof r.baseUrl !== "string"
    ) {
      return null;
    }
    return {
      id: r.id,
      name: r.name,
      protocol: r.protocol,
      baseUrl: r.baseUrl,
      apiKey: typeof r.apiKey === "string" ? r.apiKey : "",
      priority: Number.isFinite(r.priority) ? (r.priority as number) : 25,
      enabled: r.enabled !== false,
      maxSearchesPerWindow: Number.isFinite(r.maxSearchesPerWindow) ? (r.maxSearchesPerWindow as number) : 0,
      windowMs: Number.isFinite(r.windowMs) ? (r.windowMs as number) : 60_000,
      retentionDays: Number.isFinite(r.retentionDays) ? (r.retentionDays as number) : 0,
      interactiveSearch: r.interactiveSearch !== false,
      automaticSearch: r.automaticSearch !== false,
      categories: Array.isArray(r.categories) ? r.categories.filter((value): value is number => Number.isInteger(value) && value > 0) : [],
      tags: Array.isArray(r.tags) ? r.tags.filter((value): value is string => typeof value === "string").slice(0, 20) : [],
      ...(r.capabilities && typeof r.capabilities === "object" ? { capabilities: r.capabilities } : {}),
    };
  }

  static validateBaseUrl(baseUrl: string): void {
    let parsed: URL;
    try {
      parsed = new URL(baseUrl);
    } catch {
      throw new IndexerSettingsError(`invalid indexer baseUrl: ${baseUrl}`, 400);
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new IndexerSettingsError("indexer baseUrl must be http(s)", 400);
    }
  }

  validate(input: AddIndexerInput): void {
    if (typeof input.name !== "string" || input.name.trim().length === 0 || input.name.length > 120) {
      throw new IndexerSettingsError("indexer name must be 1-120 characters", 400);
    }
    if (input.protocol !== "torznab" && input.protocol !== "newznab") {
      throw new IndexerSettingsError('protocol must be "torznab" or "newznab"', 400);
    }
    IndexerSettingsService.validateBaseUrl(input.baseUrl);
    if (input.priority !== undefined && (!Number.isFinite(input.priority) || input.priority < 0)) {
      throw new IndexerSettingsError("priority must be a non-negative number", 400);
    }
    if (input.categories !== undefined && (!Array.isArray(input.categories) || !input.categories.every((value) => Number.isInteger(value) && value > 0))) {
      throw new IndexerSettingsError("categories must contain positive integers", 400);
    }
    if (input.tags !== undefined && (!Array.isArray(input.tags) || input.tags.length > 20 || !input.tags.every((value) => typeof value === "string" && value.trim().length > 0 && value.length <= 40))) {
      throw new IndexerSettingsError("tags must contain at most 20 short names", 400);
    }
    if (
      input.limits?.maxSearchesPerWindow !== undefined &&
      (!Number.isInteger(input.limits.maxSearchesPerWindow) || input.limits.maxSearchesPerWindow < 0)
    ) {
      throw new IndexerSettingsError("limits.maxSearchesPerWindow must be a non-negative integer", 400);
    }
    if (input.limits?.windowMs !== undefined && (!Number.isInteger(input.limits.windowMs) || input.limits.windowMs < 0)) {
      throw new IndexerSettingsError("limits.windowMs must be a non-negative integer", 400);
    }
    if (input.limits?.retentionDays !== undefined && (!Number.isInteger(input.limits.retentionDays) || input.limits.retentionDays < 0)) {
      throw new IndexerSettingsError("limits.retentionDays must be a non-negative integer", 400);
    }
  }

  /** Add a new indexer definition. Duplicate names are rejected. */
  async add(input: AddIndexerInput): Promise<RedactedIndexer> {
    this.validate(input);
    const name = input.name.trim();
    for (const existing of await this.list()) {
      if (existing.name.toLowerCase() === name.toLowerCase()) {
        throw new IndexerSettingsError(`an indexer named "${name}" already exists`, 409);
      }
    }
    const record: IndexerSettingsRecord = {
      id: uuidv7(),
      name,
      protocol: input.protocol,
      baseUrl: input.baseUrl.replace(/\/$/, ""),
      apiKey: input.apiKey ?? "",
      priority: input.priority ?? 25,
      enabled: input.enabled ?? true,
      maxSearchesPerWindow: input.limits?.maxSearchesPerWindow ?? 0,
      windowMs: input.limits?.windowMs ?? 60_000,
      retentionDays: input.limits?.retentionDays ?? 0,
      interactiveSearch: input.searchModes?.interactive ?? true,
      automaticSearch: input.searchModes?.automatic ?? true,
      categories: [...new Set(input.categories ?? [])],
      tags: [...new Set((input.tags ?? []).map((tag) => tag.trim().toLowerCase()))],
    };
    await this.#put(record);
    return redact(record);
  }

  async list(): Promise<RedactedIndexer[]> {
    const rows = await this.#db
      .selectFrom("plugin_documents")
      .select(["docKey", "doc"])
      .where("pluginId", "=", OWNER)
      .execute();
    const out: RedactedIndexer[] = [];
    for (const row of rows) {
      const doc = typeof row.doc === "string" ? (JSON.parse(row.doc) as unknown) : row.doc;
      const rec = this.#parse(doc);
      if (rec && rec.id === row.docKey) out.push(redact(rec));
    }
    out.sort((a, b) => a.name.localeCompare(b.name));
    return out;
  }

  async #getRaw(id: string): Promise<IndexerSettingsRecord> {
    const hit = await this.#store.get(OWNER, id);
    const rec = hit ? this.#parse(hit.doc) : null;
    if (!rec) throw new IndexerSettingsError("unknown indexer", 404);
    return rec;
  }

  async get(id: string): Promise<RedactedIndexer> {
    return redact(await this.#getRaw(id));
  }

  /** Update one definition. A blank API key deliberately preserves the stored secret. */
  async update(id: string, input: UpdateIndexerInput): Promise<RedactedIndexer> {
    const rec = await this.#getRaw(id);
    const merged: AddIndexerInput = {
      name: input.name ?? rec.name,
      protocol: input.protocol ?? rec.protocol,
      baseUrl: input.baseUrl ?? rec.baseUrl,
      priority: input.priority ?? rec.priority,
      enabled: input.enabled ?? rec.enabled,
      searchModes: {
        interactive: input.searchModes?.interactive ?? rec.interactiveSearch,
        automatic: input.searchModes?.automatic ?? rec.automaticSearch,
      },
      categories: input.categories ?? rec.categories,
      tags: input.tags ?? rec.tags,
      limits: {
        maxSearchesPerWindow: input.limits?.maxSearchesPerWindow ?? rec.maxSearchesPerWindow,
        windowMs: input.limits?.windowMs ?? rec.windowMs,
        retentionDays: input.limits?.retentionDays ?? rec.retentionDays,
      },
    };
    this.validate(merged);
    const name = merged.name.trim();
    for (const existing of await this.list()) {
      if (existing.id !== id && existing.name.toLowerCase() === name.toLowerCase()) {
        throw new IndexerSettingsError(`an indexer named "${name}" already exists`, 409);
      }
    }
    const apiKey = typeof input.apiKey === "string" && input.apiKey.trim().length > 0
      ? input.apiKey
      : rec.apiKey;
    const updated: IndexerSettingsRecord = {
      ...rec,
      name,
      protocol: merged.protocol,
      baseUrl: merged.baseUrl.replace(/\/$/, ""),
      apiKey,
      priority: merged.priority ?? rec.priority,
      enabled: merged.enabled ?? rec.enabled,
      maxSearchesPerWindow: merged.limits?.maxSearchesPerWindow ?? rec.maxSearchesPerWindow,
      windowMs: merged.limits?.windowMs ?? rec.windowMs,
      retentionDays: merged.limits?.retentionDays ?? rec.retentionDays,
      interactiveSearch: merged.searchModes?.interactive ?? rec.interactiveSearch,
      automaticSearch: merged.searchModes?.automatic ?? rec.automaticSearch,
      categories: [...new Set(merged.categories ?? rec.categories)],
      tags: [...new Set((merged.tags ?? rec.tags).map((tag) => tag.trim().toLowerCase()))],
    };
    await this.#put(updated);
    return redact(updated);
  }

  async delete(id: string): Promise<void> {
    await this.#getRaw(id);
    await this.#store.delete(OWNER, id);
    this.#searchWindows.delete(id);
    await this.#onChanged();
  }

  /** Enable or disable one indexer. Disabled indexers stop being searched. */
  async setEnabled(id: string, enabled: boolean): Promise<RedactedIndexer> {
    if (typeof enabled !== "boolean") {
      throw new IndexerSettingsError("enabled must be a boolean", 400);
    }
    const rec = await this.#getRaw(id);
    const updated: IndexerSettingsRecord = { ...rec, enabled };
    await this.#put(updated);
    return redact(updated);
  }

  /**
   * Probe the provider's caps endpoint through the transport seam. Auth
   * failures map to auth_failed, server errors to unavailable, and bodies
   * without parsable caps to parse_error. The apikey never appears in the
   * outcome.
   */
  async test(id: string): Promise<TestOutcome> {
    const rec = await this.#getRaw(id);
    IndexerSettingsService.validateBaseUrl(rec.baseUrl);
    const base = new URL(rec.baseUrl);
    base.pathname = base.pathname.replace(/\/$/, "") + "/api";
    base.searchParams.set("t", "caps");
    base.searchParams.set("apikey", rec.apiKey);
    const url = base.toString();
    try {
      const res = await this.#transport(url);
      if (res.status === 401 || res.status === 403 || /invalid api key|authentication/i.test(res.body)) {
        return { ok: false, code: "auth_failed", detail: "provider rejected the configured api key", probedUrl: redactUrl(url) };
      }
      if (res.status === 429) {
        return { ok: false, code: "unavailable", detail: "provider reported rate limiting (HTTP 429)", probedUrl: redactUrl(url) };
      }
      if (res.status >= 500) {
        return { ok: false, code: "unavailable", detail: `provider unavailable (HTTP ${res.status})`, probedUrl: redactUrl(url) };
      }
      if (res.status !== 200) return { ok: false, code: "unavailable", detail: `provider returned HTTP ${res.status}`, probedUrl: redactUrl(url) };
      const caps = parseCaps(res.body);
      const updated: IndexerSettingsRecord = {
        ...rec,
        capabilities: { ...caps, testedAt: new Date().toISOString() },
      };
      await this.#put(updated);
      return { ok: true, detail: "caps fetched", categoryCount: caps.categories.length, searchModes: caps.searchModes, probedUrl: redactUrl(url) };
    } catch (err) {
      return {
        ok: false,
        code: err instanceof IndexerError && err.code === "parse_error" ? "parse_error" : "unavailable",
        detail: String((err as Error).message ?? err),
        probedUrl: redactUrl(url),
      };
    }
  }

  async hasEnabled(): Promise<boolean> {
    return (await this.#listRaw()).some((record) => record.enabled);
  }

  async search(input: unknown): Promise<IndexerSearchResult> {
    const query = validateIndexerQuery(input);
    const requestedTags = new Set(query.tags ?? []);
    const requestedGroups = new Set((query.categories ?? []).map((value) => Math.floor(value / 1000)));
    const records = (await this.#listRaw())
      .filter((record) => record.enabled)
      .filter((record) => query.mode === "interactive" ? record.interactiveSearch : record.automaticSearch)
      .filter((record) => requestedTags.size === 0 || record.tags.some((tag) => requestedTags.has(tag)))
      .filter((record) => requestedGroups.size === 0 || record.categories.length === 0 || record.categories.some((value) => requestedGroups.has(Math.floor(value / 1000))))
      .sort((a, b) => a.priority - b.priority);
    if (records.length === 0) throw new IndexerSettingsError("No enabled indexer accepts this search.", 409);

    const raw = input as Record<string, unknown>;
    const settled = await Promise.allSettled(records.map(async (record) => {
      this.#admit(record);
      if (!record.apiKey) throw new IndexerError("auth_failed", `${record.name} has no API key`);
      let mode: "search" | "tv-search" | "movie-search" = query.categories?.includes(2000)
        ? "tv-search"
        : query.categories?.includes(1000)
          ? "movie-search"
          : "search";
      if (mode !== "search" && record.capabilities && !record.capabilities.searchModes.includes(mode)) mode = "search";
      const categories = record.categories.length > 0 ? record.categories : query.categories;
      const url = buildQueryUrl({
        baseUrl: record.baseUrl,
        protocol: record.protocol,
        apiKey: record.apiKey,
        mode,
        query: query.query,
        ...(categories ? { categories } : {}),
        ...(query.limit ? { limit: query.limit } : {}),
        ...(typeof raw.season === "number" ? { season: Math.trunc(raw.season) } : {}),
        ...(typeof raw.episode === "number" ? { episode: Math.trunc(raw.episode) } : {}),
      });
      const response = await this.#transport(url);
      if (response.status === 401 || response.status === 403) throw new IndexerError("auth_failed", `${record.name} rejected its API key`);
      if (response.status === 429) throw new IndexerError("rate_limited", `${record.name} is rate limited`);
      if (response.status >= 400) throw new IndexerError("unavailable", `${record.name} returned HTTP ${response.status}`);
      const releases = parseResults(response.body, record.protocol === "newznab" ? "nzb" : "torrent")
        .filter((release) => query.mode !== "automatic" || record.retentionDays === 0 || (Date.now() - Date.parse(release.publishedAt)) / 86_400_000 <= record.retentionDays)
        .map((release) => validateIndexedRelease({ ...release, indexerId: record.id }));
      return { releases, hasMore: query.limit !== undefined && releases.length >= query.limit };
    }));
    const releases: IndexedRelease[] = [];
    let hasMore = false;
    let firstError: unknown;
    for (const result of settled) {
      if (result.status === "fulfilled") {
        releases.push(...result.value.releases);
        hasMore ||= result.value.hasMore;
      } else {
        firstError ??= result.reason;
      }
    }
    if (releases.length === 0 && firstError) throw firstError;
    return { releases, hasMore, remainingInWindow: null };
  }

  async #listRaw(): Promise<IndexerSettingsRecord[]> {
    const rows = await this.#db.selectFrom("plugin_documents").select(["docKey", "doc"]).where("pluginId", "=", OWNER).execute();
    return rows.flatMap((row) => {
      const doc = typeof row.doc === "string" ? JSON.parse(row.doc) as unknown : row.doc;
      const record = this.#parse(doc);
      return record && record.id === row.docKey ? [record] : [];
    });
  }

  #admit(record: IndexerSettingsRecord): void {
    if (record.maxSearchesPerWindow === 0) return;
    const now = Date.now();
    const recent = (this.#searchWindows.get(record.id) ?? []).filter((time) => now - time < record.windowMs);
    if (recent.length >= record.maxSearchesPerWindow) throw new IndexerError("rate_limited", `${record.name} reached its search limit`);
    recent.push(now);
    this.#searchWindows.set(record.id, recent);
  }
}
