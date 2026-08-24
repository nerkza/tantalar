/**
 * Canonical contracts for Tantalar (locked by ADR-0004/0006/0007/0008).
 * Protobuf wire format is canonical for the plugin transport; the TypeScript
 * types below are the in-process canonical shapes and mirror
 * ./proto/tantalar/plugin/v1/plugin.proto (the IDL is normative; ADR-0004).
 */
export const PROTOCOL_VERSION = 1;

/** Event envelope per ADR-0007. Immutable after append. */
export interface EventEnvelope {
  readonly schemaVersion: 1;
  readonly eventId: string; // UUIDv7 (ADR-0008)
  readonly type: string; // reverse-DNS, e.g. dev.tantalar.event.plugin.mounted
  readonly occurredAt: string; // ISO-8601 UTC
  readonly producer: string; // e.g. "core" or plugin id
  readonly subject?: string;
  readonly correlationId?: string;
  readonly causationId?: string;
  readonly payload: Record<string, unknown>;
  readonly metadata?: Record<string, unknown>;
}

/** Plugin manifest per ADR-0006 (mirrors proto Manifest). */
export interface PluginManifest {
  readonly id: string; // reverse-DNS, e.g. dev.tantalar.plugin.hello-world
  readonly version: string;
  readonly protocolVersion: number;
  readonly provides: readonly string[]; // capability names (reverse-DNS)
  readonly requires: readonly string[];
  readonly subscriptions: readonly string[]; // event type prefixes
  readonly entry: {
    readonly command: string;
    readonly args?: readonly string[];
  };
}

/** Core-owned capability and event names. */
export const CapabilityNames = {
  EventEmit: "dev.tantalar.capability.event.emit",
  SchedulerRegister: "dev.tantalar.capability.scheduler.register",
  Log: "dev.tantalar.capability.log",
  /** Phase 2: narrow key validation for plugins (MCP contract §3). */
  AuthIntrospection: "dev.tantalar.capability.auth.introspection",
  /**
   * Phase 3a/3b acquisition domain. The indexer and download-client
   * capabilities are provided by provider plugins (fixtures first-party);
   * the release-comparer is built-in-provided and replaceable (phase 3b);
   * tracker rules live ONLY in tracker plugins (ADR-0015) and the VPN
   * binding capability is provided by the vpn-manager plugin.
   */
  Indexer: "dev.tantalar.capability.indexer",
  DownloadClient: "dev.tantalar.capability.download-client",
  ReleaseComparer: "dev.tantalar.capability.release-comparer",
  TrackerRules: "dev.tantalar.capability.tracker.rules",
  VpnBinding: "dev.tantalar.capability.vpn-binding",
  /**
   * Phase 4 library domain. The importer/post-processor and the
   * metadata-provider are plugin-provided capabilities; the built-in
   * TMDB/TVDB plugin supplies metadata and is replaceable.
   */
  Importer: "dev.tantalar.capability.importer",
  MetadataProvider: "dev.tantalar.capability.metadata-provider",
} as const;

export const EventTypes = {
  PluginMounted: "dev.tantalar.event.plugin.mounted",
  PluginUnmounted: "dev.tantalar.event.plugin.unmounted",
  PluginCrashed: "dev.tantalar.event.plugin.crashed",
  PluginRestarted: "dev.tantalar.event.plugin.restarted",
  PluginFailed: "dev.tantalar.event.plugin.failed",
  CapabilityRegistered: "dev.tantalar.event.capability.registered",
  CapabilityRevoked: "dev.tantalar.event.capability.revoked",
  SchedulerJobFired: "dev.tantalar.event.scheduler.job.fired",
  ServerBooted: "dev.tantalar.event.server.booted",
  /** MCP audit trail (mcp-server.md §8) — one immutable event per call. */
  McpCall: "dev.tantalar.event.mcp.call",
  WebhookDelivery: "dev.tantalar.event.webhook.delivery",
  /**
   * Phase 3a acquisition domain (phase-3a-acquisition.md §Contracts).
   * Search and grab events; download progress/completed are emitted by
   * download-client plugins (Phase 3a downloader abstraction).
   */
  IndexerSearched: "dev.tantalar.event.indexer.searched",
  ReleaseGrabbed: "dev.tantalar.event.release.grabbed",
  /**
   * Phase 3b acquisition intelligence (phase-3b-acquisition.md §Contracts).
   * Every step of the grab path is an event: candidate set → comparison
   * verdict → grab decision → client dispatch; plus download lifecycle and
   * VPN tunnel health.
   */
  ComparisonVerdict: "dev.tantalar.event.comparison.verdict",
  GrabDecision: "dev.tantalar.event.grab.decision",
  ClientDispatch: "dev.tantalar.event.client.dispatch",
  DownloadQueued: "dev.tantalar.event.download.queued",
  DownloadProgress: "dev.tantalar.event.download.progress",
  DownloadCompleted: "dev.tantalar.event.download.completed",
  DownloadFailed: "dev.tantalar.event.download.failed",
  BlacklistAdded: "dev.tantalar.event.blacklist.added",
  TunnelHealthChanged: "dev.tantalar.event.tunnel.health.changed",
  /**
   * Phase 3c automation domain (series + movies plugins). Monitoring and
   * wanted-list lifecycle events; acquisition itself flows through the
   * existing grab-path events above.
   */
  SeriesAdded: "dev.tantalar.event.series.added",
  SeriesMonitoringChanged: "dev.tantalar.event.series.monitoring.changed",
  SeriesEpisodeSearched: "dev.tantalar.event.series.episode.searched",
  MovieAdded: "dev.tantalar.event.movie.added",
  MovieMonitoringChanged: "dev.tantalar.event.movie.monitoring.changed",
  MovieScanCompleted: "dev.tantalar.event.movie.scan.completed",
  MovieAcquired: "dev.tantalar.event.movie.acquired",
  /**
   * Phase 4 library domain (phase-4-library-import.md §Contracts). Every
   * import/upgrade/metadata step is an event; `*.import.started` carries the
   * correlationId so a full import chain reconstructs from the log.
   */
  ImportStarted: "dev.tantalar.event.import.started",
  ImportCompleted: "dev.tantalar.event.import.completed",
  ImportFailed: "dev.tantalar.event.import.failed",
  UpgradeReplaced: "dev.tantalar.event.upgrade.replaced",
  MetadataRefreshed: "dev.tantalar.event.metadata.refreshed",
  /**
   * Phase 5 serving domain (phase-5-serving.md §Contracts). Playback and
   * transcode-session lifecycle; every access decision is traced.
   */
  PlaybackStarted: "dev.tantalar.event.playback.started",
  PlaybackProgress: "dev.tantalar.event.playback.progress",
  TranscodeSessionOpened: "dev.tantalar.event.transcode.session.opened",
  TranscodeSessionClosed: "dev.tantalar.event.transcode.session.closed",
  /**
   * Wave 3 (TAN-020/021) library management. Every library mutation and
   * catalog change emits a traceable event; `library.media.deleted` fires
   * ONLY on the explicit confirmDeleteMedia path — never on library removal.
   */
  LibraryCreated: "dev.tantalar.event.library.created",
  LibraryEdited: "dev.tantalar.event.library.edited",
  LibraryRemoved: "dev.tantalar.event.library.removed",
  LibraryEnabledChanged: "dev.tantalar.event.library.enabled.changed",
  LibraryValidated: "dev.tantalar.event.library.validated",
  LibraryRescanCompleted: "dev.tantalar.event.library.rescan.completed",
  MediaCataloged: "dev.tantalar.event.media.cataloged",
  MediaDeleted: "dev.tantalar.event.library.media.deleted",
  /**
   * Wave 7 (TAN-014/016/017/018): provider health, discovery, and decision
   * history. Provider failures and rate-limit states are events so operator
   * surfaces stay truthful; every accepted OR rejected release decision is
   * an immutable event with human-readable reasons.
   */
  IndexerProviderError: "dev.tantalar.event.indexer.provider.error",
  IndexerCapsRefreshed: "dev.tantalar.event.indexer.caps.refreshed",
  MetadataSearchCompleted: "dev.tantalar.event.metadata.search.completed",
  ReleaseDecisionRecorded: "dev.tantalar.event.release.decision.recorded",
} as const;

// ---- Phase 3a: provider-neutral indexer schemas ------------------------------
//
// Canonical in-process shapes for `dev.tantalar.capability.indexer`
// operations (search, parse, limits). These mirror the acquisition contract
// section of the phase-3a spec; plugins implement them via the public SDK.
// Provider-specific wire formats (Prowlarr definitions etc.) are adapted by
// adapter plugins only — core never parses tracker/indexer formats.

/** Which mode produced a query. Automatic = unattended wanted-list search. */
export type IndexerQueryMode = "automatic" | "interactive";

/** Category of content a release represents (mirrors common indexer caps). */
export type ReleaseKind = "nzb" | "torrent";

export interface IndexerLimits {
  /** Max automatic searches per rolling window; 0 = unlimited. */
  readonly maxSearchesPerWindow: number;
  readonly windowMs: number;
  /** Provider retention window in days: releases older than this have expired. */
  readonly retentionDays: number;
}

/**
 * Normalized search request. `query` is the free-text needle; `categories`
 * are indexer-agnostic numeric categories (2000 TV, 2030 anime, …) so no
 * provider vocabulary leaks into core.
 */
export interface IndexerQuery {
  readonly mode: IndexerQueryMode;
  readonly query: string;
  readonly categories?: readonly number[];
  readonly limit?: number;
  /** Correlation id propagated onto every emitted event for this search. */
  readonly correlationId?: string;
}

/** A single normalized search result (release). */
export interface IndexedRelease {
  readonly guid: string;
  readonly title: string;
  readonly kind: ReleaseKind;
  /** Direct download URL or magnet link, per `kind`. */
  readonly downloadUrl: string;
  readonly infoUrl?: string;
  readonly sizeBytes: number;
  readonly publishedAt: string; // ISO-8601 UTC
  readonly seeders?: number;
  readonly leechers?: number;
  readonly categories: readonly number[];
  readonly indexerId: string;
}

export interface IndexerSearchResult {
  readonly releases: readonly IndexedRelease[];
  /** True when the indexer reports more results exist beyond this page. */
  readonly hasMore: boolean;
  /** Rate/retention state after this query, for the caller's accounting. */
  readonly remainingInWindow: number | null;
}

/** Structured indexer failure codes — stable, non-provider strings. */
export type IndexerErrorCode =
  | "rate_limited"
  | "retention_blocked"
  | "auth_failed"
  | "unavailable"
  | "invalid_query"
  | "parse_error";

export class IndexerError extends Error {
  readonly code: IndexerErrorCode;
  constructor(code: IndexerErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = "IndexerError";
  }
}

/** Validate + normalize an incoming query; throws IndexerError on bad input. */
export function validateIndexerQuery(input: unknown): IndexerQuery {
  const q = input as Partial<IndexerQuery>;
  if (!q || typeof q !== "object") throw new IndexerError("invalid_query", "query must be an object");
  if (q.mode !== "automatic" && q.mode !== "interactive")
    throw new IndexerError("invalid_query", "query.mode must be automatic or interactive");
  if (typeof q.query !== "string" || q.query.trim().length === 0)
    throw new IndexerError("invalid_query", "query.query must be a non-empty string");
  if (q.categories !== undefined && (!Array.isArray(q.categories) || !q.categories.every((c) => Number.isInteger(c))))
    throw new IndexerError("invalid_query", "query.categories must be integers");
  if (q.limit !== undefined && (!Number.isInteger(q.limit) || q.limit < 1))
    throw new IndexerError("invalid_query", "query.limit must be a positive integer");
  return {
    mode: q.mode,
    query: q.query,
    ...(q.categories !== undefined ? { categories: q.categories } : {}),
    ...(q.limit !== undefined ? { limit: q.limit } : {}),
    ...(q.correlationId !== undefined ? { correlationId: q.correlationId } : {}),
  };
}

/** Validate a normalized release shape coming back from any provider plugin. */
export function validateIndexedRelease(input: unknown): IndexedRelease {
  const r = input as Partial<IndexedRelease>;
  if (!r || typeof r !== "object") throw new IndexerError("parse_error", "release must be an object");
  if (typeof r.guid !== "string" || r.guid.length === 0)
    throw new IndexerError("parse_error", "release.guid required");
  if (typeof r.title !== "string" || r.title.length === 0)
    throw new IndexerError("parse_error", "release.title required");
  if (r.kind !== "nzb" && r.kind !== "torrent") throw new IndexerError("parse_error", "release.kind invalid");
  if (typeof r.downloadUrl !== "string" || r.downloadUrl.length === 0)
    throw new IndexerError("parse_error", "release.downloadUrl required");
  if (!Number.isFinite(r.sizeBytes) || (r.sizeBytes ?? -1) < 0)
    throw new IndexerError("parse_error", "release.sizeBytes invalid");
  if (typeof r.publishedAt !== "string" || Number.isNaN(Date.parse(r.publishedAt)))
    throw new IndexerError("parse_error", "release.publishedAt must be ISO-8601");
  if (!Array.isArray(r.categories)) throw new IndexerError("parse_error", "release.categories must be an array");
  if (typeof r.indexerId !== "string" || r.indexerId.length === 0)
    throw new IndexerError("parse_error", "release.indexerId required");
  return r as IndexedRelease;
}

export function isReverseDns(name: string): boolean {
  return /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*){2,}$/.test(name);
}

// ---- Semver + contract compatibility (ADR-0004) -----------------------------

const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/;

export function parseSemver(version: string): { major: number; minor: number; patch: number } | null {
  const m = SEMVER_RE.exec(version);
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

export function isValidSemver(version: string): boolean {
  return parseSemver(version) !== null;
}

/**
 * Contract compatibility rule: same major required; a host may serve plugins
 * built against an older MINOR of the same major (host.minor >= plugin.minor).
 * Any major mismatch is incompatible and must be rejected at handshake.
 */
export function isContractCompatible(hostVersion: number, pluginVersion: number): boolean {
  if (!Number.isInteger(hostVersion) || !Number.isInteger(pluginVersion)) return false;
  if (hostVersion !== pluginVersion) return false;
  return true;
}

// ---- Envelope / manifest validation -----------------------------------------

export function validateEnvelope(input: unknown): EventEnvelope {
  const e = input as Partial<EventEnvelope>;
  if (!e || typeof e !== "object") throw new Error("envelope: not an object");
  if (e.schemaVersion !== 1) throw new Error("envelope: schemaVersion must be 1");
  if (typeof e.eventId !== "string" || !/^[0-9a-f-]{36}$/.test(e.eventId))
    throw new Error("envelope: eventId must be a UUID");
  if (typeof e.type !== "string" || !isReverseDns(e.type))
    throw new Error(`envelope: type must be reverse-DNS, got ${String(e.type)}`);
  if (typeof e.occurredAt !== "string" || Number.isNaN(Date.parse(e.occurredAt)))
    throw new Error("envelope: occurredAt must be ISO-8601");
  if (typeof e.producer !== "string" || e.producer.length === 0)
    throw new Error("envelope: producer required");
  if (typeof e.payload !== "object" || e.payload === null)
    throw new Error("envelope: payload must be an object");
  if (e.correlationId !== undefined && typeof e.correlationId !== "string")
    throw new Error("envelope: correlationId must be a string");
  if (e.causationId !== undefined && typeof e.causationId !== "string")
    throw new Error("envelope: causationId must be a string");
  return e as EventEnvelope;
}

const RESERVED_CAPABILITY_PREFIX = "dev.tantalar.capability.";

export function validateManifest(input: unknown): PluginManifest {
  const m = input as Partial<PluginManifest>;
  if (!m || typeof m !== "object") throw new Error("manifest: not an object");
  if (typeof m.id !== "string" || !isReverseDns(m.id))
    throw new Error(`manifest: id must be reverse-DNS, got ${String(m.id)}`);
  if (typeof m.version !== "string" || !isValidSemver(m.version))
    throw new Error("manifest: version must be valid semver (ADR-0004)");
  if (m.protocolVersion !== PROTOCOL_VERSION)
    throw new Error(`manifest: protocolVersion must be ${PROTOCOL_VERSION}`);
  if (!Array.isArray(m.provides) || m.provides.length === 0)
    throw new Error("manifest: provides must list at least one capability");
  if (!m.provides.every((c) => typeof c === "string" && isReverseDns(c)))
    throw new Error("manifest: provides must be reverse-DNS capability names");
  if (!Array.isArray(m.requires) || !m.requires.every((c) => typeof c === "string" && isReverseDns(c)))
    throw new Error("manifest: requires must be reverse-DNS capability names");
  if (!Array.isArray(m.subscriptions) || !m.subscriptions.every((s) => typeof s === "string"))
    throw new Error("manifest: subscriptions must be event type prefixes");
  // Identifier-collision guard (phase-2 security): a plugin may not declare
  // the same capability twice, nor provide and require the same name.
  const provides: readonly string[] = m.provides ?? [];
  const requires: readonly string[] = m.requires ?? [];
  const dupProvide = provides.find((c, i) => provides.indexOf(c) !== i);
  if (dupProvide) throw new Error(`manifest: duplicate provided capability ${dupProvide}`);
  const overlap = provides.find((c) => requires.includes(c));
  if (overlap) throw new Error(`manifest: ${overlap} both provided and required`);
  if (!m.entry || typeof m.entry.command !== "string")
    throw new Error("manifest: entry.command required");
  // Path-traversal guard: the entry command resolves inside the package.
  if (
    m.entry.command.includes("..") ||
    (Array.isArray(m.entry.args) && m.entry.args.some((a) => typeof a === "string" && a.includes("..")))
  ) {
    throw new Error("manifest: entry must not contain path traversal");
  }
  void RESERVED_CAPABILITY_PREFIX;
  return m as unknown as PluginManifest;
}

/** UUIDv7 generator (ADR-0008). */
export function uuidv7(now: number = Date.now()): string {
  const ts = BigInt(now);
  const bytes = new Uint8Array(16);
  // 48-bit big-endian unix ms
  for (let i = 5; i >= 0; i--) {
    bytes[i] = Number((ts >> BigInt(8 * (5 - i))) & 0xffn);
  }
  crypto.getRandomValues(bytes.subarray(6));
  bytes[6] = ((bytes[6] as number) & 0x0f) | 0x70; // version 7
  bytes[8] = ((bytes[8] as number) & 0x3f) | 0x80; // variant
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// ---- Phase 3b: download-client schemas ---------------------------------------
//
// Provider-neutral shapes for `dev.tantalar.capability.download-client`
// (operations: add, status, pause, resume, remove). Plugins adapt qBittorrent,
// SABnzbd, or fixtures to this schema; core never speaks client wire formats.

/** Normalized download lifecycle states (fixture + real clients map onto these). */
export type DownloadState =
  | "queued"
  | "downloading"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled";

export interface DownloadRequest {
  /** Stable id for the wanted item this download serves. */
  readonly itemKey: string;
  readonly title: string;
  readonly kind: ReleaseKind;
  /** Direct URL or magnet, per `kind`. Never contains credentials. */
  readonly sourceUrl: string;
  /** Optional tracker plugin id; enables announce-safety and seed-goal checks. */
  readonly trackerId?: string;
  /** Correlation id propagated through all emitted events. */
  readonly correlationId?: string;
}

export interface DownloadStatus {
  readonly downloadId: string;
  readonly itemKey: string;
  readonly state: DownloadState;
  /** 0..100 */
  readonly progressPercent: number;
  readonly sizeBytes: number;
  readonly error?: string;
}

export class DownloadClientError extends Error {
  readonly code: "invalid_request" | "unknown_download" | "unavailable" | "blocked";
  constructor(code: "invalid_request" | "unknown_download" | "unavailable" | "blocked", message: string) {
    super(message);
    this.code = code;
    this.name = "DownloadClientError";
  }
}

export function validateDownloadRequest(input: unknown): DownloadRequest {
  const r = input as Partial<DownloadRequest>;
  if (!r || typeof r !== "object") throw new DownloadClientError("invalid_request", "request must be an object");
  if (typeof r.itemKey !== "string" || r.itemKey.length === 0)
    throw new DownloadClientError("invalid_request", "itemKey required");
  if (typeof r.title !== "string" || r.title.length === 0)
    throw new DownloadClientError("invalid_request", "title required");
  if (r.kind !== "nzb" && r.kind !== "torrent")
    throw new DownloadClientError("invalid_request", "kind must be nzb or torrent");
  if (typeof r.sourceUrl !== "string" || r.sourceUrl.length === 0)
    throw new DownloadClientError("invalid_request", "sourceUrl required");
  return {
    itemKey: r.itemKey,
    title: r.title,
    kind: r.kind,
    sourceUrl: r.sourceUrl,
    ...(r.trackerId !== undefined ? { trackerId: r.trackerId } : {}),
    ...(r.correlationId !== undefined ? { correlationId: r.correlationId } : {}),
  };
}

// ---- Tracker rules (TAN-015) ---------------------------------------------------
//
// Private trackers impose per-tracker obligations: minimum share ratio,
// minimum seed time, tag/limit policy, and safe-removal rules. Tantalar
// NEVER removes payload data before every obligation of the tracker that
// served the download passes. Rules are matched by tracker id and by
// announce-URL host patterns, so two trackers with the same plugin still
// get independent rules.

/** Capability id for the torrent-native tracker-rules surface. */
export const TRACKER_RULES_CAPABILITY = "dev.tantalar.capability.torrent.tracker-rules";

export interface TrackerRule {
  /** Stable rule id (operator-chosen, unique). */
  readonly id: string;
  /** Human label shown in the UI. */
  readonly name: string;
  /**
   * Host substrings matched against a job's announce URLs. Empty = default
   * rule applied to jobs whose announce URLs match no other rule.
   */
  readonly announceHosts: readonly string[];
  /** Minimum upload/download ratio before removal is allowed. */
  readonly minRatio: number;
  /** Minimum seeding time in hours before removal is allowed. */
  readonly minSeedTimeHours: number;
  /** Tag applied to the job in the engine (per-tracker grouping). */
  readonly tag?: string;
  /** Max concurrent downloads through this tracker (0 = unlimited). */
  readonly maxConcurrent: number;
  /**
   * When true the operator explicitly allows removal of data after all
   * obligations pass. When false, removal ALWAYS keeps payload files.
   */
  readonly allowDataRemoval: boolean;
  readonly enabled: boolean;
}

export interface TrackerRuleInput {
  readonly name: string;
  readonly announceHosts?: readonly string[];
  readonly minRatio?: number;
  readonly minSeedTimeHours?: number;
  readonly tag?: string;
  readonly maxConcurrent?: number;
  readonly allowDataRemoval?: boolean;
  readonly enabled?: boolean;
}

/** Seeding counters reported by the engine for one job. */
export interface SeedingStats {
  readonly uploadedBytes: number;
  readonly downloadedBytes: number;
  readonly seedingSeconds: number;
  readonly ratio: number;
}

export type ObligationStatus = "satisfied" | "unsatisfied" | "no-rule";

export interface ObligationReport {
  readonly downloadId: string;
  readonly ruleId: string | null;
  readonly ruleName: string | null;
  readonly status: ObligationStatus;
  /** Unmet conditions in human-readable form; empty when satisfied. */
  readonly reasons: readonly string[];
  readonly stats: SeedingStats | null;
}

export class TrackerRuleError extends Error {
  readonly code: "invalid_rule" | "unknown_rule" | "duplicate_rule" | "obligations_unmet";
  constructor(code: TrackerRuleError["code"], message: string) {
    super(message);
    this.code = code;
    this.name = "TrackerRuleError";
  }
}

export function validateTrackerRule(input: unknown): TrackerRuleInput {
  const r = input as Partial<TrackerRuleInput>;
  if (!r || typeof r !== "object") throw new TrackerRuleError("invalid_rule", "rule must be an object");
  if (typeof r.name !== "string" || r.name.trim().length === 0 || r.name.length > 120)
    throw new TrackerRuleError("invalid_rule", "name must be 1-120 characters");
  if (r.announceHosts !== undefined) {
    if (!Array.isArray(r.announceHosts)) throw new TrackerRuleError("invalid_rule", "announceHosts must be an array");
    for (const h of r.announceHosts) {
      if (typeof h !== "string" || h.trim().length === 0)
        throw new TrackerRuleError("invalid_rule", "announceHosts entries must be non-empty strings");
    }
  }
  if (r.minRatio !== undefined && (!Number.isFinite(r.minRatio) || r.minRatio < 0))
    throw new TrackerRuleError("invalid_rule", "minRatio must be a non-negative number");
  if (r.minSeedTimeHours !== undefined && (!Number.isFinite(r.minSeedTimeHours) || r.minSeedTimeHours < 0))
    throw new TrackerRuleError("invalid_rule", "minSeedTimeHours must be a non-negative number");
  if (r.maxConcurrent !== undefined && (!Number.isInteger(r.maxConcurrent) || r.maxConcurrent < 0))
    throw new TrackerRuleError("invalid_rule", "maxConcurrent must be a non-negative integer");
  return r as TrackerRuleInput;
}

/** Find the rule governing a job's announce URLs; first match wins. */
export function matchTrackerRule(
  rules: readonly TrackerRule[],
  announceUrls: readonly string[],
): TrackerRule | null {
  for (const rule of rules) {
    if (!rule.enabled) continue;
    for (const host of rule.announceHosts) {
      if (announceUrls.some((u) => u.includes(host))) return rule;
    }
  }
  // Default rule: enabled rule with no hosts.
  return rules.find((r) => r.enabled && r.announceHosts.length === 0) ?? null;
}

/**
 * Evaluate a job's tracker obligations. Returns a report; removal of data
 * is allowed only when status is "satisfied" (or "no-rule" with an explicit
 * operator override at the call site — never silently).
 */
export function evaluateObligations(
  downloadId: string,
  rule: TrackerRule | null,
  stats: SeedingStats | null,
): ObligationReport {
  if (!rule) {
    return { downloadId, ruleId: null, ruleName: null, status: "no-rule", reasons: [], stats };
  }
  const reasons: string[] = [];
  const s = stats ?? { uploadedBytes: 0, downloadedBytes: 0, seedingSeconds: 0, ratio: 0 };
  if (s.ratio < rule.minRatio) {
    reasons.push(`ratio ${s.ratio.toFixed(2)} below required ${rule.minRatio}`);
  }
  const seededHours = s.seedingSeconds / 3600;
  if (seededHours < rule.minSeedTimeHours) {
    reasons.push(`seed time ${seededHours.toFixed(1)}h below required ${rule.minSeedTimeHours}h`);
  }
  return {
    downloadId,
    ruleId: rule.id,
    ruleName: rule.name,
    status: reasons.length === 0 ? "satisfied" : "unsatisfied",
    reasons,
    stats: s,
  };
}

// ---- Phase 3b: release-comparison schemas ------------------------------------
//
// The comparer is a replaceable capability (built-in default provider).
// It scores candidate releases against a quality profile and returns a
// verdict BEFORE any grab decision is made.

export interface QualityProfile {
  readonly name: string;
  /** Preferred qualities in rank order, best first (free-form labels). */
  readonly preferredQualities: readonly string[];
  readonly minSeeders?: number;
  /** Reject releases larger than this. */
  readonly maxSizeBytes?: number;
  /** Prefer proper/repack re-releases over the original. */
  readonly preferProperRepack?: boolean;
}

/** A release enriched with parsed comparison attributes (quality label etc.). */
export interface CandidateRelease {
  readonly release: IndexedRelease;
  /** Parsed quality label, e.g. "1080p", "720p", "2160p". */
  readonly quality: string;
  readonly properOrRepack: boolean;
}

export type ComparisonReason =
  | "best_quality_available"
  | "preferred_quality"
  | "proper_repack_upgrade"
  | "size_within_limits"
  | "seeders_sufficient"
  | "no_qualifying_release"
  | "size_exceeds_limit"
  | "seeders_below_minimum"
  | "blacklisted_release";

export interface ComparisonVerdict {
  /** guid of the winning candidate, or null when nothing qualifies. */
  readonly winnerGuid: string | null;
  readonly rankedGuids: readonly string[];
  readonly reasons: readonly ComparisonReason[];
  readonly rejected: ReadonlyArray<{ guid: string; reason: ComparisonReason }>;
}

export function parseQualityLabel(title: string): string {
  const t = title.toLowerCase();
  const qualities = ["2160p", "1080p", "720p", "480p"];
  for (const q of qualities) if (t.includes(q)) return q;
  return "unknown";
}

export function isProperOrRepack(title: string): boolean {
  const t = title.toLowerCase();
  return /\bproper\b/.test(t) || /\brepack\b/.test(t);
}

// ---- Phase 3b: tracker rules (plugin-side only, ADR-0015) --------------------
//
// Core NEVER stores or evaluates tracker-specific rules. A tracker plugin
// exposes `dev.tantalar.capability.tracker.rules` and answers these neutral
// queries; the announce-URL guard and seed/ratio goals are enforced inside
// the plugin against its own declared host patterns.

/** Neutral query the grab pipeline asks before dispatching a torrent. */
export interface TrackerAnnounceQuery {
  readonly downloadUrl: string;
  /** Tracker plugin id being asked (must match the provider). */
  readonly trackerId: string;
}

export interface TrackerAnnounceVerdict {
  /** True only when the announce host matches the plugin's declared patterns. */
  readonly allowed: boolean;
  /** Redacted reason code; never echoes passkeys or full URLs. */
  readonly reason: "host_allowed" | "host_not_declared" | "url_missing_announce" | "malformed_url";
}

export interface SeedGoal {
  readonly seedMinutes: number | null; // null = no time goal
  readonly ratio: number | null; // null = no ratio goal
}

// ---- Phase 3b: VPN binding schemas -------------------------------------------
//
// `dev.tantalar.capability.vpn-binding`, provided by the vpn-manager plugin.
// Fail-closed: a client bound to a tunnel may transfer ONLY while the tunnel
// is explicitly healthy.

export type TunnelProtocol = "openvpn" | "wireguard";

export type TunnelHealth = "healthy" | "degraded" | "down";

export interface VpnProfile {
  readonly profileId: string;
  readonly protocol: TunnelProtocol;
  /** Remote endpoint host — safe to log; secrets live in config redaction. */
  readonly endpointHost: string;
}

// ---- Phase 4: library / import schemas ----------------------------------------
//
// The importer/post-processor is a plugin-provided capability
// (`dev.tantalar.capability.importer`). It renames, hardlinks/copies,
// upgrades, and records media files under configured library roots.
// Metadata comes from `dev.tantalar.capability.metadata-provider` plugins
// (built-in TMDB/TVDB fixture plugin; replaceable).

/** How a file physically landed in the library. */
export type ImportMethod = "hardlink" | "copy";

export interface RenameScheme {
  readonly name: string;
  /**
   * Template with placeholders. Episode templates accept {series},{season},
   * {episode},{seasonPad2},{episodePad2},{title},{year},{quality},{codec},
   * {language},{edition}; movie templates the same minus the episode/season
   * placeholders. Validated to reject path traversal and absolute escapes.
   */
  readonly episodeTemplate: string;
  readonly movieTemplate: string;
}

export class ImportError extends Error {
  readonly code: "invalid_template" | "path_escape" | "outside_root" | "symlink_rejected" | "collision" | "io_error";
  constructor(code: ImportError["code"], message: string) {
    super(message);
    this.code = code;
    this.name = "ImportError";
  }
}

/** Validate a rename template: placeholders only, no traversal segments. */
export function validateRenameTemplate(template: string): string {
  if (typeof template !== "string" || template.trim().length === 0)
    throw new ImportError("invalid_template", "template must be a non-empty string");
  if (template.includes("..") || template.startsWith("/") || /^[a-zA-Z]:/.test(template))
    throw new ImportError("path_escape", "template must not traverse outside the library root");
  const known = ["series", "season", "episode", "title", "year", "quality", "seasonPad2", "episodePad2", "codec", "language", "edition"];
  for (const ph of template.match(/\{([^}]*)\}/g) ?? []) {
    if (!known.includes(ph.slice(1, -1)))
      throw new ImportError("invalid_template", `unknown placeholder ${ph}`);
  }
  return template;
}

export interface ImportRequest {
  /** Stable key of the wanted item this file serves (e.g. series:S01E01). */
  readonly itemKey: string;
  /** Absolute source path inside a configured import root. */
  readonly sourcePath: string;
  /** Parsed quality label of the release (drives upgrade decisions). */
  readonly quality: string;
  readonly title: string;
  /** "series" or "movie" naming scheme selection. */
  readonly kind: "series" | "movie";
  /** Series/movie display name used by the rename template. */
  readonly series?: string;
  readonly season?: number;
  readonly episode?: number;
  readonly year?: number;
  readonly scheme?: string;
  /** Correlation id propagated onto every emitted event. */
  readonly correlationId?: string;
}

export interface ImportResult {
  readonly itemKey: string;
  readonly destinationPath: string;
  readonly method: ImportMethod;
  /** True when an existing file was replaced by a quality upgrade. */
  readonly upgraded: boolean;
  /** Previous destination path when upgraded, for history/rollback. */
  readonly replacedPath?: string;
}

export interface MetadataQuery {
  readonly kind: "series" | "movie";
  readonly name: string;
  readonly year?: number;
  readonly season?: number;
  readonly episode?: number;
}

/** Neutral metadata shape returned by any metadata-provider plugin. */
export interface MediaMetadata {
  readonly externalId: string;
  readonly kind: "series" | "movie";
  readonly name: string;
  readonly overview: string;
  readonly year: number | null;
  /** Air/release dates per season/episode when known (ISO dates). */
  readonly airDate?: string;
  readonly artworkUrl?: string;
  readonly provider: string;
}


export interface ClientBinding {
  /** Download-client plugin id, e.g. dev.tantalar.plugin.qbittorrent. */
  readonly clientId: string;
  readonly profileId: string | null; // null = direct (no tunnel)
}

export interface TunnelState {
  readonly profileId: string;
  readonly health: TunnelHealth;
  readonly protocol: TunnelProtocol;
}

// ---- Phase 5: serving / playback schemas --------------------------------------
//
// The serving plugin owns library browsing, watch state, viewer visibility,
// capability negotiation, and transcode-session orchestration. Core HTTP
// serves bytes; the plugin decides WHAT is served and WHO may see it.

/** A media file known to the serving layer, as reported by the importer. */
export interface LibraryEntry {
  readonly fileId: string;
  readonly itemKey: string;
  readonly title: string;
  readonly kind: "series" | "movie";
  readonly libraryId: string;
  /** Synthetic probe metadata — never parsed from real copyrighted media. */
  readonly container: "mkv" | "mp4" | "avi";
  readonly videoCodec: "h264" | "hevc" | "av1";
  readonly audioCodec: "aac" | "ac3" | "dts" | "truehd" | "atmos";
  readonly sizeBytes: number;
  readonly subtitles: readonly SubtitleTrack[];
}

export type SubtitleSource = "embedded" | "external";

export interface SubtitleTrack {
  readonly trackId: string;
  readonly lang: string;
  readonly format: "srt" | "ass" | "pgs";
  readonly source: SubtitleSource;
  /**
   * Optional inline content for browser-renderable tracks (SRT text).
   * Declared at registration so /api/v1/library/subtitles/:trackId can serve
   * the payload; never extracted from real copyrighted containers in Phase 5.
   */
  readonly content?: string;
}

/** Viewer account with per-library visibility rules. */
export interface ViewerPermissions {
  readonly userId: string;
  /** Empty array = no libraries visible; "*" = all libraries. */
  readonly libraries: readonly string[];
}

export interface ResumePoint {
  readonly userId: string;
  readonly fileId: string;
  /** Position in milliseconds. */
  readonly positionMs: number;
  readonly durationMs: number;
  readonly updatedAt: string;
}

export interface WatchHistoryEntry {
  readonly userId: string;
  readonly fileId: string;
  readonly startedAt: string;
  readonly positionMs: number;
  readonly completed: boolean;
}

/**
 * Browser capabilities a client declares during negotiation. Direct play is
 * eligible only when every track is in `canPlay` and the container itself
 * is supported.
 */
export interface BrowserCapabilities {
  readonly canPlayContainers: readonly string[];
  readonly canPlayVideo: readonly string[];
  readonly canPlayAudio: readonly string[];
  readonly canDirectSubtitles: readonly string[]; // e.g. ["srt","vtt"]
}

export type PlaybackDecision =
  | { readonly mode: "direct"; readonly streamUrl: string }
  | {
      readonly mode: "hls";
      readonly sessionId: string;
      readonly manifestUrl: string;
      readonly qualities: readonly string[];
    };

/** Stable failure codes for negotiation and session lifecycle. */
export class ServingError extends Error {
  readonly code:
    | "not_found"
    | "forbidden"
    | "invalid_request"
    | "unsupported_format"
    | "session_limit"
    | "no_worker"
    | "io_error";

  constructor(
    code: ServingError["code"],
    message: string,
  ) {
    super(message);
    this.code = code;
    this.name = "ServingError";
  }
}

export const DIRECT_PLAY_CONTAINERS = new Set(["mp4"]);
/** Video/audio combos browsers universally direct-play (fixture matrix). */
export function isDirectPlayable(
  entry: Pick<LibraryEntry, "container" | "videoCodec" | "audioCodec">,
  caps: BrowserCapabilities,
): boolean {
  return (
    caps.canPlayContainers.includes(entry.container) &&
    DIRECT_PLAY_CONTAINERS.has(entry.container) &&
    caps.canPlayVideo.includes(entry.videoCodec) &&
    caps.canPlayAudio.includes(entry.audioCodec)
  );
}

/** Validate a resume position update (guards races and bogus values). */
export function validateResumeUpdate(input: unknown): { fileId: string; positionMs: number; durationMs?: number } {
  const r = input as Partial<{ fileId: string; positionMs: number; durationMs: number }>;
  if (!r || typeof r !== "object") throw new ServingError("invalid_request", "body must be an object");
  if (typeof r.fileId !== "string" || r.fileId.length === 0)
    throw new ServingError("invalid_request", "fileId required");
  if (typeof r.positionMs !== "number" || !Number.isFinite(r.positionMs) || r.positionMs < 0)
    throw new ServingError("invalid_request", "positionMs must be >= 0");
  if (
    r.durationMs !== undefined &&
    (typeof r.durationMs !== "number" || !Number.isFinite(r.durationMs) || r.durationMs < 0)
  )
    throw new ServingError("invalid_request", "durationMs must be >= 0");
  if (r.durationMs !== undefined && r.positionMs > r.durationMs + 1000)
    throw new ServingError("invalid_request", "positionMs beyond duration");
  return {
    fileId: r.fileId,
    positionMs: Math.trunc(r.positionMs),
    ...(r.durationMs !== undefined ? { durationMs: Math.trunc(r.durationMs) } : {}),
  };
}

// ---- Wave 5 (TAN-011): unified durable download_jobs contract ------------------
//
// One stable, provider-neutral job record for every acquisition source
// (torrent + usenet). Core owns the durable state; download-client plugins
// mirror their engine progress into it through the DownloadJobStore. The
// record carries the full transactional lifecycle: progress, ETA, warnings,
// retry bookkeeping, source identity, failure reason, removal flag, and the
// import handoff pointer. Durable history is append-shaped: terminal jobs are
// never deleted, only flagged removed.

export type DownloadJobSource = "torrent" | "usenet";

export interface DownloadJobRecord {
  readonly jobId: string;
  /** Stable wanted-item id this job serves; idempotency key per source. */
  readonly itemKey: string;
  readonly title: string;
  readonly source: DownloadJobSource;
  /** Plugin id that executes the job (e.g. dev.tantalar.plugin.usenet-native). */
  readonly providerPluginId: string;
  readonly state: DownloadState;
  /** 0..100 */
  readonly progressPercent: number;
  readonly sizeBytes: number;
  /** Bytes on disk so far. */
  readonly receivedBytes: number;
  /** ISO-8601 timestamp or null when unknown. */
  readonly etaAt: string | null;
  /** Non-fatal notes (repair ran, CRC mismatch retried, …). */
  readonly warnings: readonly string[];
  readonly retryCount: number;
  /** Provider-neutral source reference (magnet URI, .torrent path, NZB path). */
  readonly sourceRef: string;
  readonly failureReason: string | null;
  /** True once the user removed the job from the queue (history retained). */
  readonly removed: boolean;
  /** Wave 9 (TAN-030): queue priority; higher runs first. */
  readonly priority: number;
  /** Import handoff: set when the completed payload was handed to the importer. */
  readonly importHandoffPath: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export const DOWNLOAD_JOB_STATES: ReadonlySet<DownloadState> = new Set([
  "queued",
  "downloading",
  "paused",
  "completed",
  "failed",
  "cancelled",
]);

export class DownloadJobError extends Error {
  readonly code: "invalid_request" | "unknown_job";
  constructor(code: "invalid_request" | "unknown_job", message: string) {
    super(message);
    this.code = code;
    this.name = "DownloadJobError";
  }
}

// ---- Wave 7 (TAN-014/016/017/018): discovery + decision schemas ---------------
//
// Provider-neutral shapes for the real Torznab/Newznab indexer plugins, the
// metadata discovery surface, and the release decision record. Core never
// parses provider wire formats — the plugins adapt them into these shapes.

/**
 * Indexer capabilities discovered from a provider (Torznab caps / Newznab
 * function list). Cached by the plugin; `fetchedAt` records cache age.
 */
export interface IndexerCapabilities {
  readonly protocol: "torznab" | "newznab";
  readonly categories: ReadonlyArray<{ id: number; name: string }>;
  readonly searchModes: readonly ("search" | "tv-search" | "movie-search")[];
  readonly limits: IndexerLimits;
  /** ISO-8601 timestamp of when the caps were last fetched from the provider. */
  readonly fetchedAt: string | null;
}

/**
 * A durable release decision (TAN-018). One record per accepted OR rejected
 * candidate; `reasons` are human-readable sentences suitable for direct
 * display. `overridden` marks an operator manual override of the automatic
 * verdict; `blocked` marks releases added to the durable blocklist.
 */
export interface ReleaseDecisionRecord {
  readonly decisionId: string;
  readonly itemKey: string;
  readonly mode: "automatic" | "interactive";
  readonly outcome: "accepted" | "rejected";
  readonly guid: string;
  readonly title: string;
  readonly reasons: readonly string[];
  readonly overridden: boolean;
  readonly blocked: boolean;
  readonly decidedAt: string;
}

/** Validate + normalize an interactive/automatic blocklist entry. */
export interface BlocklistEntry {
  readonly guid: string;
  readonly itemKey: string;
  readonly reason: string;
  /** ISO-8601 expiry; null = permanent. Expired entries stop blocking. */
  readonly expiresAt: string | null;
  readonly createdAt: string;
}
