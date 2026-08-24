/**
 * Wave 7 (TAN-014): core indexer-settings service — the operator surface to
 * ADD, TEST, and ENABLE Torznab/Newznab indexer configurations.
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
import { uuidv7 } from "@tantalar/contracts";
import type { Db } from "@tantalar/db";

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

  async #put(record: IndexerSettingsRecord): Promise<void> {
    await this.#store.put(OWNER, record.id, record);
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
    if (
      input.limits?.maxSearchesPerWindow !== undefined &&
      (!Number.isInteger(input.limits.maxSearchesPerWindow) || input.limits.maxSearchesPerWindow < 0)
    ) {
      throw new IndexerSettingsError("limits.maxSearchesPerWindow must be a non-negative integer", 400);
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
      const categoryCount = [...res.body.matchAll(/<(?:sub)?category\s+[^>]*>/g)].length;
      const searchModes: string[] = [];
      if (/<search\s+available="yes"/.test(res.body)) searchModes.push("search");
      if (/<tv-search\s+available="yes"/.test(res.body)) searchModes.push("tv-search");
      if (/<movie-search\s+available="yes"/.test(res.body)) searchModes.push("movie-search");
      if (res.status !== 200 || (categoryCount === 0 && searchModes.length === 0)) {
        return { ok: false, code: "parse_error", detail: "response had no parsable caps", probedUrl: redactUrl(url) };
      }
      return { ok: true, detail: "caps fetched", categoryCount, searchModes, probedUrl: redactUrl(url) };
    } catch (err) {
      return { ok: false, code: "unavailable", detail: String((err as Error).message ?? err), probedUrl: redactUrl(url) };
    }
  }
}
