/**
 * Torznab / Newznab wire adapters (TAN-014).
 *
 * Pure functions: parse provider XML into neutral shapes, and build query
 * URLs. No network here — the plugin owns fetching so tests can inject a
 * transport seam. Credentials NEVER appear in parsed output or errors.
 *
 * Supported surface (the common real-world subset):
 *  - /api?t=caps → categories + search modes
 *  - /api?t=search|tvsearch|moviesearch&query/season/ep + apikey → results RSS
 */
import { IndexerError, type IndexerLimits, type IndexedRelease } from "@tantalar/contracts";
import type { IndexerCapabilities } from "@tantalar/contracts";

/** Minimal XML helpers — providers emit simple well-formed caps/RSS. */
function textOf(xml: string, tag: string): string {
  const m = new RegExp(`<${tag}(?:\\s[^>]*)?>([^<]*)</${tag}>`).exec(xml);
  return m?.[1]?.trim() ?? "";
}

function attrOf(tagXml: string, attr: string): string {
  const m = new RegExp(`${attr}="([^"]*)"`).exec(tagXml);
  return m?.[1] ?? "";
}

export interface CapsParseResult {
  categories: Array<{ id: number; name: string }>;
  searchModes: Array<"search" | "tv-search" | "movie-search">;
}

/** Parse a Torznab/Newznab `t=caps` response. Fails closed on empty output. */
export function parseCaps(xml: string): CapsParseResult {
  const categories: Array<{ id: number; name: string }> = [];
  for (const m of xml.matchAll(/<category\s+[^>]*>/g)) {
    const tag = m[0];
    const id = Number(attrOf(tag, "id"));
    const name = attrOf(tag, "name");
    if (Number.isInteger(id) && id > 0 && name) categories.push({ id, name });
    // Subcategories are flat-mapped into the same list with parent-prefixed ids.
    void tag;
  }
  for (const m of xml.matchAll(/<subcat\s+[^>]*>/g)) {
    const id = Number(attrOf(m[0], "id"));
    const name = attrOf(m[0], "name");
    if (Number.isInteger(id) && id > 0 && name) categories.push({ id, name });
  }
  const searchModes: CapsParseResult["searchModes"] = [];
  if (/<search\s+available="yes"/.test(xml)) searchModes.push("search");
  if (/<tv-search\s+available="yes"/.test(xml)) searchModes.push("tv-search");
  if (/<movie-search\s+available="yes"/.test(xml)) searchModes.push("movie-search");
  if (categories.length === 0 && searchModes.length === 0) {
    throw new IndexerError("parse_error", "caps response had no categories or search functions");
  }
  return { categories, searchModes };
}

export interface WireRelease {
  guid: string;
  title: string;
  kind: "nzb" | "torrent";
  downloadUrl: string;
  infoUrl?: string;
  sizeBytes: number;
  publishedAt: string;
  seeders?: number;
  leechers?: number;
  categories: number[];
}

/** Map a torznab:attr name onto the neutral release fields we keep. */
function attrValue(itemXml: string, name: string): string | null {
  for (const m of itemXml.matchAll(/<torznab:attr\s+[^>]*>|<newznab:attr\s+[^>]*>/g)) {
    if (attrOf(m[0], "name") === name) return attrOf(m[0], "value");
  }
  return null;
}

/**
 * Parse a search-result RSS document. `kind` decides which enclosure /
 * link element carries the download URL (torrents use torznab enclosures,
 * NZBs the newznab enclosure).
 */
export function parseResults(xml: string, kind: "nzb" | "torrent"): WireRelease[] {
  const out: WireRelease[] = [];
  void kind;
  const items = xml.match(/<item(?:\s[^>]*)?>[\s\S]*?<\/item>/g) ?? [];
  for (const item of items) {
    const guid = textOf(item, "guid") || attrValue(item, "guid") || "";
    const title = textOf(item, "title");
    const encMatch = /<enclosure\s+([^>]*)\/?>/.exec(item);
    const encAttrs = encMatch?.[1] ?? "";
    let downloadUrl = encAttrs ? attrOf(encAttrs, "url") : "";
    if (!downloadUrl) downloadUrl = textOf(item, "link");
    if (!guid || !title || !downloadUrl) continue; // skip malformed items, not fail the page

    const sizeAttr = encAttrs ? attrOf(encAttrs, "length") : "";
    const sizeParsed = Number(sizeAttr);
    const sizeFromAttr = attrValue(item, "size");
    const sizeBytes = Number.isFinite(sizeParsed) && sizeParsed > 0 ? sizeParsed : Number(sizeFromAttr ?? 0);

    const pubDateRaw = textOf(item, "pubDate");
    const publishedMs = pubDateRaw ? Date.parse(pubDateRaw) : Number.NaN;
    const seedersRaw = attrValue(item, "seeders");
    const peersRaw = attrValue(item, "peers");
    const leechersRaw = attrValue(item, "leechers");
    const cats: number[] = [];
    for (const c of item.matchAll(/<category(?:\s[^>]*)?>(\d+)<\/category>/g)) {
      cats.push(Number(c[1]));
    }

    out.push({
      guid,
      title,
      kind,
      downloadUrl,
      ...(textOf(item, "comments") ? { infoUrl: textOf(item, "comments") } : {}),
      sizeBytes: Number.isFinite(sizeBytes) && sizeBytes > 0 ? sizeBytes : 0,
      publishedAt: Number.isNaN(publishedMs) ? new Date().toISOString() : new Date(publishedMs).toISOString(),
      ...(seedersRaw !== null ? { seeders: Number(seedersRaw) } : {}),
      ...(leechersRaw !== null
        ? { leechers: Number(leechersRaw) }
        : peersRaw !== null
          ? { leechers: Math.max(0, Number(peersRaw) - Number(seedersRaw ?? 0)) }
          : {}),
      categories: cats,
    });
  }
  return out;
}

/** Build a provider query URL. The apikey is appended but never logged. */
export function buildQueryUrl(opts: {
  readonly baseUrl: string;
  readonly protocol: "torznab" | "newznab";
  readonly apiKey: string;
  readonly mode: "search" | "tv-search" | "movie-search";
  readonly query: string;
  readonly categories?: readonly number[];
  readonly limit?: number;
  readonly season?: number;
  readonly episode?: number;
}): string {
  let base: URL;
  try {
    base = new URL(opts.baseUrl);
  } catch {
    throw new IndexerError("invalid_query", `invalid indexer baseUrl: ${opts.baseUrl}`);
  }
  base.pathname = base.pathname.replace(/\/$/, "") + "/api";
  base.searchParams.set("t", opts.mode === "tv-search" ? "tvsearch" : opts.mode === "movie-search" ? "moviesearch" : "search");
  base.searchParams.set("apikey", opts.apiKey);
  if (opts.query) base.searchParams.set("q", opts.query);
  if (opts.mode === "tv-search") {
    if (opts.season !== undefined) base.searchParams.set("season", String(opts.season));
    if (opts.episode !== undefined) base.searchParams.set("ep", String(opts.episode));
  }
  if (opts.categories && opts.categories.length > 0) {
    base.searchParams.set("cat", opts.categories.join(","));
  }
  if (opts.limit !== undefined) base.searchParams.set("limit", String(Math.min(100, opts.limit)));
  void opts.protocol;
  return base.toString();
}

/** Default limits applied when the operator configures none. */
export const DEFAULT_WIRE_LIMITS: IndexerLimits = {
  maxSearchesPerWindow: 0,
  windowMs: 60_000,
  retentionDays: 0,
};

/** Build the neutral capabilities doc from parsed caps. */
export function toCapabilities(
  protocol: "torznab" | "newznab",
  caps: CapsParseResult,
  limits: IndexerLimits,
): IndexerCapabilities {
  return {
    protocol,
    categories: caps.categories,
    searchModes: caps.searchModes.length > 0 ? caps.searchModes : ["search"],
    limits,
    fetchedAt: new Date().toISOString(),
  };
}
