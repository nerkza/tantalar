/**
 * Core schema (Phase 1 initial schema) and dual-dialect migration runner.
 * ADR-0009: Kysely; better-sqlite3 (WAL) + pg; per-dialect SQL pairs in one
 * numbered sequence. Migrations must pass on both engines before phase exit.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  Kysely,
  PostgresDialect,
  SqliteDialect,
  Migrator,
  CamelCasePlugin,
  type Migration,
  type MigrationProvider,
  type GeneratedAlways,
} from "kysely";
import Database from "better-sqlite3";
import { Client } from "pg";

export type Dialect = "sqlite" | "postgres";

export interface UsersTable {
  id: string;
  username: string;
  passwordHash: string; // Argon2id
  role: "admin" | "viewer";
  createdAt: string;
  // Wave 9 (TAN-032): soft deactivation. Deactivated users cannot sign in;
  // their durable rows (history, preferences) stay intact.
  active: number; // 0/1
}

/**
 * Wave 9 (TAN-032): immutable security audit log. One append-only row per
 * security-sensitive mutation (role change, password reset, session revoke,
 * deactivation, API-key create/revoke, webhook change, backup/restore).
 */
export interface AuditLogTable {
  id: string; // uuidv7
  actorUserId: string | null;
  actorUsername: string | null;
  action: string; // reverse-DNS-ish action code, e.g. "user.role.changed"
  targetType: string; // "user" | "api_key" | "webhook" | "plugin" | "system"
  targetId: string;
  detail: string; // JSON object, secret-free by construction
  occurredAt: string;
}

export interface SessionsTable {
  tokenHash: string; // SHA-256 of opaque token
  userId: string;
  csrfToken: string;
  createdAt: string;
  expiresAt: string;
}

export interface ApiKeysTable {
  id: string;
  name: string;
  keyHash: string; // SHA-256 of "tantalar_..." key
  scopes: string; // JSON array of scope strings
  createdAt: string;
  revokedAt: string | null;
  // Wave 9 (TAN-033): explicit optional expiry; null = no expiry.
  expiresAt: string | null;
}

export interface EventsTable {
  eventId: string; // UUIDv7, primary key — append-only
  schemaVersion: number;
  type: string;
  occurredAt: string;
  producer: string;
  subject: string | null;
  correlationId: string | null;
  causationId: string | null;
  payload: string; // canonical JSON
  metadata: string | null; // canonical JSON or null
}

export interface SchedulerJobsTable {
  id: string;
  pluginId: string;
  jobKey: string; // idempotency key (pluginId + declared key)
  schedule: string;
  lastRunAt: string | null;
  nextRunAt: string | null;
  lockedAt: string | null;
}

export interface PluginStateTable {
  pluginId: string;
  state: string;
  restartCount: number;
  updatedAt: string;
  // Phase 2 (story 24):
  installedSource: string | null; // local path or tpk://<sha256>
  enabled: number; // 0/1 — config-declared desired state
  capabilitiesSnapshot: string | null; // JSON array from the manifest at mount
}

export interface OutboundWebhooksTable {
  id: string;
  pluginId: string; // owning plugin (dev.tantalar.plugin.webhook)
  url: string;
  eventTypes: string; // JSON array of subscribed type prefixes
  secretEnvVar: string; // env var NAME only — secrets are env-only
  active: number; // 0/1
  createdAt: string;
  // Wave 9 (TAN-033): delivery observability. lastStatus is a truthful
  // outcome code ("delivered" | "failed" | "skipped_no_secret"); the secret
  // itself is NEVER stored here.
  lastStatus: string | null;
  lastDeliveryAt: string | null;
  lastDetail: string | null;
}

export interface SchemaMigrationsTable {
  name: string;
  appliedAt: string;
}

/**
 * Guided-onboarding state (wave 2, TAN-003). Exactly one row (id "global"):
 * a JSON map of step id → { status: pending|done|skipped }, durable across
 * restarts so the wizard can resume where it left off.
 */
export interface OnboardingStateTable {
  id: string; // always "global"
  steps: string; // canonical JSON: { [stepId]: { status: "pending"|"done"|"skipped" } }
  updatedAt: string;
}

/** A singleton mutex row. Bootstrap completion still derives only from users. */
export interface BootstrapLockTable {
  id: string;
  touchedAt: string;
}

export interface UiPreferencesTable {
  userId: string; // PK — one row per user
  preferences: string; // JSON object (grid layout, density, active theme id)
  updatedAt: string;
}

export interface ThemesTable {
  id: string;
  name: string;
  tokens: string; // JSON map of `--tantalar-*` token name → value
  updatedAt: string;
}

/**
 * Wave 3 (TAN-013): durable plugin-owned state. One JSON document per
 * (pluginId, key). Plugins reach this ONLY through the storage bridge the
 * supervisor exposes on their context — they never get a DB handle.
 */
export interface PluginDocumentsTable {
  pluginId: string;
  docKey: string;
  doc: string; // canonical JSON document
  updatedAt: string;
}

/**
 * Wave 3 (TAN-020/021): core-owned library definitions. Removal of a
 * library row never deletes media files; deletion of media requires the
 * separate explicit confirmDelete flag on the remove call.
 */
export interface LibrariesTable {
  id: string; // uuidv7
  name: string;
  rootPath: string; // absolute, realpath'd at create/edit time
  kind: "series" | "movie" | "mixed";
  enabled: number; // 0/1 desired state
  createdAt: string;
  updatedAt: string;
}

/**
 * Wave 3 (TAN-021): durable media catalog. fileId → library + path +
 * import identity. Imports are idempotent by (sourceHash, destinationPath);
 * every mutation is mirrored into the event log by the service layer.
 */
export interface MediaCatalogTable {
  fileId: string;
  libraryId: string;
  itemKey: string;
  path: string; // absolute path inside the library root
  quality: string;
  method: "hardlink" | "copy";
  sourceHash: string; // sha256 at import time
  importedAt: string;
  updatedAt: string;
}

/**
 * Wave 5 (TAN-011): unified durable download_jobs. One provider-neutral row
 * per acquisition job (torrent or usenet). Terminal jobs are never deleted —
 * `removed` flags queue removal while history stays durable.
 */
export interface DownloadJobsTable {
  jobId: string;
  itemKey: string;
  title: string;
  source: "torrent" | "usenet";
  providerPluginId: string;
  state: string; // DownloadState
  progressPercent: number; // 0..100 integer
  sizeBytes: number;
  receivedBytes: number;
  etaAt: string | null; // ISO-8601, null when unknown
  warnings: string; // JSON array of strings
  retryCount: number;
  sourceRef: string;
  failureReason: string | null;
  removed: number; // 0/1
  /** Wave 9 (TAN-030): queue priority; higher runs first. */
  priority: number;
  importHandoffPath: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Db {
  users: UsersTable;
  sessions: SessionsTable;
  api_keys: ApiKeysTable;
  events: EventsTable;
  scheduler_jobs: SchedulerJobsTable;
  plugin_state: PluginStateTable;
  outbound_webhooks: OutboundWebhooksTable;
  audit_log: AuditLogTable;
  ui_preferences: UiPreferencesTable;
  themes: ThemesTable;
  onboarding_state: OnboardingStateTable;
  bootstrap_lock: BootstrapLockTable;
  schema_migrations: SchemaMigrationsTable;
  plugin_documents: PluginDocumentsTable;
  libraries: LibrariesTable;
  media_catalog: MediaCatalogTable;
  download_jobs: DownloadJobsTable;
  release_decisions: ReleaseDecisionsTable;
  release_blocklist: ReleaseBlocklistTable;
}

/**
 * Wave 7 (TAN-018): immutable release-decision history. One row per
 * accepted OR rejected candidate with human-readable reasons.
 */
export interface ReleaseDecisionsTable {
  decisionId: string; // uuidv7
  itemKey: string;
  mode: "automatic" | "interactive";
  outcome: "accepted" | "rejected";
  guid: string;
  title: string;
  reasons: string; // JSON array of human-readable strings
  overridden: number; // 0/1 — operator manual override of the automatic verdict
  blocked: number; // 0/1 — also added to the durable blocklist
  decidedAt: string;
}

/**
 * Wave 7 (TAN-018): durable blocklist. Expired entries stop blocking but
 * remain listed until explicitly removed.
 */
export interface ReleaseBlocklistTable {
  guid: string; // primary key
  itemKey: string;
  reason: string;
  expiresAt: string | null; // null = permanent
  createdAt: string;
}

const MIGRATIONS: Array<{ name: string; sqlite: string[]; postgres: string[] }> = [
  {
    name: "0001_initial_schema",
    sqlite: [
      `CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('admin','viewer')),
        created_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id),
        csrf_token TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS api_keys (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        key_hash TEXT NOT NULL UNIQUE,
        scopes TEXT NOT NULL,
        created_at TEXT NOT NULL,
        revoked_at TEXT
      )`,
      `CREATE TABLE IF NOT EXISTS events (
        event_id TEXT PRIMARY KEY,
        schema_version INTEGER NOT NULL,
        type TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        producer TEXT NOT NULL,
        subject TEXT,
        correlation_id TEXT,
        causation_id TEXT,
        payload TEXT NOT NULL,
        metadata TEXT
      )`,
      `CREATE INDEX IF NOT EXISTS idx_events_type ON events(type)`,
      `CREATE INDEX IF NOT EXISTS idx_events_occurred ON events(occurred_at)`,
      `CREATE INDEX IF NOT EXISTS idx_events_correlation ON events(correlation_id)`,
      `CREATE TABLE IF NOT EXISTS scheduler_jobs (
        id TEXT PRIMARY KEY,
        plugin_id TEXT NOT NULL,
        job_key TEXT NOT NULL UNIQUE,
        schedule TEXT NOT NULL,
        last_run_at TEXT,
        next_run_at TEXT,
        locked_at TEXT
      )`,
      `CREATE TABLE IF NOT EXISTS plugin_state (
        plugin_id TEXT PRIMARY KEY,
        state TEXT NOT NULL,
        restart_count INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS schema_migrations (
        name TEXT PRIMARY KEY,
        applied_at TEXT NOT NULL
      )`,
    ],
    postgres: [
      `CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('admin','viewer')),
        created_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id),
        csrf_token TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS api_keys (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        key_hash TEXT NOT NULL UNIQUE,
        scopes TEXT NOT NULL,
        created_at TEXT NOT NULL,
        revoked_at TEXT
      )`,
      `CREATE TABLE IF NOT EXISTS events (
        event_id TEXT PRIMARY KEY,
        schema_version INTEGER NOT NULL,
        type TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        producer TEXT NOT NULL,
        subject TEXT,
        correlation_id TEXT,
        causation_id TEXT,
        payload JSONB NOT NULL,
        metadata JSONB
      )`,
      `CREATE INDEX IF NOT EXISTS idx_events_type ON events(type)`,
      `CREATE INDEX IF NOT EXISTS idx_events_occurred ON events(occurred_at)`,
      `CREATE INDEX IF NOT EXISTS idx_events_correlation ON events(correlation_id)`,
      `CREATE TABLE IF NOT EXISTS scheduler_jobs (
        id TEXT PRIMARY KEY,
        plugin_id TEXT NOT NULL,
        job_key TEXT NOT NULL UNIQUE,
        schedule TEXT NOT NULL,
        last_run_at TEXT,
        next_run_at TEXT,
        locked_at TEXT
      )`,
      `CREATE TABLE IF NOT EXISTS plugin_state (
        plugin_id TEXT PRIMARY KEY,
        state TEXT NOT NULL,
        restart_count INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS schema_migrations (
        name TEXT PRIMARY KEY,
        applied_at TEXT NOT NULL
      )`,
    ],
  },
  {
    name: "0002_phase2_plugin_state_and_webhooks",
    sqlite: [
      `ALTER TABLE plugin_state ADD COLUMN installed_source TEXT`,
      `ALTER TABLE plugin_state ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1`,
      `ALTER TABLE plugin_state ADD COLUMN capabilities_snapshot TEXT`,
      `CREATE TABLE IF NOT EXISTS outbound_webhooks (
        id TEXT PRIMARY KEY,
        plugin_id TEXT NOT NULL,
        url TEXT NOT NULL,
        event_types TEXT NOT NULL,
        secret_env_var TEXT NOT NULL,
        active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL
      )`,
    ],
    postgres: [
      `ALTER TABLE plugin_state ADD COLUMN IF NOT EXISTS installed_source TEXT`,
      `ALTER TABLE plugin_state ADD COLUMN IF NOT EXISTS enabled INTEGER NOT NULL DEFAULT 1`,
      `ALTER TABLE plugin_state ADD COLUMN IF NOT EXISTS capabilities_snapshot TEXT`,
      `CREATE TABLE IF NOT EXISTS outbound_webhooks (
        id TEXT PRIMARY KEY,
        plugin_id TEXT NOT NULL,
        url TEXT NOT NULL,
        event_types TEXT NOT NULL,
        secret_env_var TEXT NOT NULL,
        active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL
      )`,
    ],
  },
  {
    name: "0004_phase6_ui_preferences_and_themes",
    sqlite: [
      `CREATE TABLE IF NOT EXISTS ui_preferences (
        user_id TEXT PRIMARY KEY,
        preferences TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS themes (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        tokens TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
    ],
    postgres: [
      `CREATE TABLE IF NOT EXISTS ui_preferences (
        user_id TEXT PRIMARY KEY,
        preferences JSONB NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS themes (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        tokens JSONB NOT NULL,
        updated_at TEXT NOT NULL
      )`,
    ],
  },
  {
    name: "0005_wave2_onboarding_state",
    sqlite: [
      `CREATE TABLE IF NOT EXISTS bootstrap_lock (
        id TEXT PRIMARY KEY,
        touched_at TEXT NOT NULL
      )`,
      `INSERT OR IGNORE INTO bootstrap_lock (id, touched_at) VALUES ('global', '1970-01-01T00:00:00.000Z')`,
      `CREATE TABLE IF NOT EXISTS onboarding_state (
        id TEXT PRIMARY KEY,
        steps TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
    ],
    postgres: [
      `CREATE TABLE IF NOT EXISTS bootstrap_lock (
        id TEXT PRIMARY KEY,
        touched_at TEXT NOT NULL
      )`,
      `INSERT INTO bootstrap_lock (id, touched_at) VALUES ('global', '1970-01-01T00:00:00.000Z') ON CONFLICT (id) DO NOTHING`,
      `CREATE TABLE IF NOT EXISTS onboarding_state (
        id TEXT PRIMARY KEY,
        steps TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
    ],
  },
  {
    name: "0006_wave3_media_state",
    sqlite: [
      `CREATE TABLE IF NOT EXISTS plugin_documents (
        plugin_id TEXT NOT NULL,
        doc_key TEXT NOT NULL,
        doc TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (plugin_id, doc_key)
      )`,
      `CREATE TABLE IF NOT EXISTS libraries (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        root_path TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('series','movie','mixed')),
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS media_catalog (
        file_id TEXT PRIMARY KEY,
        library_id TEXT NOT NULL REFERENCES libraries(id),
        item_key TEXT NOT NULL,
        path TEXT NOT NULL,
        quality TEXT NOT NULL,
        method TEXT NOT NULL CHECK (method IN ('hardlink','copy')),
        source_hash TEXT NOT NULL,
        imported_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_media_import_identity ON media_catalog(source_hash, path)`,
      `CREATE INDEX IF NOT EXISTS idx_media_library ON media_catalog(library_id)`,
      `CREATE INDEX IF NOT EXISTS idx_media_item ON media_catalog(item_key)`,
    ],
    postgres: [
      `CREATE TABLE IF NOT EXISTS plugin_documents (
        plugin_id TEXT NOT NULL,
        doc_key TEXT NOT NULL,
        doc JSONB NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (plugin_id, doc_key)
      )`,
      `CREATE TABLE IF NOT EXISTS libraries (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        root_path TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('series','movie','mixed')),
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS media_catalog (
        file_id TEXT PRIMARY KEY,
        library_id TEXT NOT NULL REFERENCES libraries(id),
        item_key TEXT NOT NULL,
        path TEXT NOT NULL,
        quality TEXT NOT NULL,
        method TEXT NOT NULL CHECK (method IN ('hardlink','copy')),
        source_hash TEXT NOT NULL,
        imported_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_media_import_identity ON media_catalog(source_hash, path)`,
      `CREATE INDEX IF NOT EXISTS idx_media_library ON media_catalog(library_id)`,
      `CREATE INDEX IF NOT EXISTS idx_media_item ON media_catalog(item_key)`,
    ],
  },
  {
    name: "0007_wave5_download_jobs",
    sqlite: [
      `CREATE TABLE IF NOT EXISTS download_jobs (
        job_id TEXT PRIMARY KEY,
        item_key TEXT NOT NULL,
        title TEXT NOT NULL,
        source TEXT NOT NULL CHECK (source IN ('torrent','usenet')),
        provider_plugin_id TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('queued','downloading','paused','completed','failed','cancelled')),
        progress_percent INTEGER NOT NULL DEFAULT 0,
        size_bytes INTEGER NOT NULL DEFAULT 0,
        received_bytes INTEGER NOT NULL DEFAULT 0,
        eta_at TEXT,
        warnings TEXT NOT NULL DEFAULT '[]',
        retry_count INTEGER NOT NULL DEFAULT 0,
        source_ref TEXT NOT NULL,
        failure_reason TEXT,
        removed INTEGER NOT NULL DEFAULT 0,
        import_handoff_path TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      // Idempotency: one active job per (itemKey, source). Partial unique
      // index keeps durable history rows (removed=1) out of the constraint.
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_download_jobs_active ON download_jobs(item_key, source) WHERE removed = 0`,
      `CREATE INDEX IF NOT EXISTS idx_download_jobs_state ON download_jobs(state)`,
    ],
    postgres: [
      `CREATE TABLE IF NOT EXISTS download_jobs (
        job_id TEXT PRIMARY KEY,
        item_key TEXT NOT NULL,
        title TEXT NOT NULL,
        source TEXT NOT NULL CHECK (source IN ('torrent','usenet')),
        provider_plugin_id TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('queued','downloading','paused','completed','failed','cancelled')),
        progress_percent INTEGER NOT NULL DEFAULT 0,
        size_bytes BIGINT NOT NULL DEFAULT 0,
        received_bytes BIGINT NOT NULL DEFAULT 0,
        eta_at TEXT,
        warnings JSONB NOT NULL DEFAULT '[]',
        retry_count INTEGER NOT NULL DEFAULT 0,
        source_ref TEXT NOT NULL,
        failure_reason TEXT,
        removed SMALLINT NOT NULL DEFAULT 0,
        import_handoff_path TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_download_jobs_active ON download_jobs(item_key, source) WHERE removed = 0`,
      `CREATE INDEX IF NOT EXISTS idx_download_jobs_state ON download_jobs(state)`,
    ],
  },
  {
    name: "0008_wave7_decisions_blocklist",
    sqlite: [
      `CREATE TABLE IF NOT EXISTS release_decisions (
        decision_id TEXT PRIMARY KEY,
        item_key TEXT NOT NULL,
        mode TEXT NOT NULL CHECK (mode IN ('automatic','interactive')),
        outcome TEXT NOT NULL CHECK (outcome IN ('accepted','rejected')),
        guid TEXT NOT NULL,
        title TEXT NOT NULL,
        reasons TEXT NOT NULL DEFAULT '[]',
        overridden INTEGER NOT NULL DEFAULT 0,
        blocked INTEGER NOT NULL DEFAULT 0,
        decided_at TEXT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_decisions_item ON release_decisions(item_key, decided_at)`,
      `CREATE TABLE IF NOT EXISTS release_blocklist (
        guid TEXT PRIMARY KEY,
        item_key TEXT NOT NULL,
        reason TEXT NOT NULL,
        expires_at TEXT,
        created_at TEXT NOT NULL
      )`,
    ],
    postgres: [
      `CREATE TABLE IF NOT EXISTS release_decisions (
        decision_id TEXT PRIMARY KEY,
        item_key TEXT NOT NULL,
        mode TEXT NOT NULL CHECK (mode IN ('automatic','interactive')),
        outcome TEXT NOT NULL CHECK (outcome IN ('accepted','rejected')),
        guid TEXT NOT NULL,
        title TEXT NOT NULL,
        reasons JSONB NOT NULL DEFAULT '[]',
        overridden SMALLINT NOT NULL DEFAULT 0,
        blocked SMALLINT NOT NULL DEFAULT 0,
        decided_at TEXT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_decisions_item ON release_decisions(item_key, decided_at)`,
      `CREATE TABLE IF NOT EXISTS release_blocklist (
        guid TEXT PRIMARY KEY,
        item_key TEXT NOT NULL,
        reason TEXT NOT NULL,
        expires_at TEXT,
        created_at TEXT NOT NULL
      )`,
    ],
  },
  {
    name: "0009_wave9_operations",
    sqlite: [
      `ALTER TABLE users ADD COLUMN active INTEGER NOT NULL DEFAULT 1`,
      `CREATE TABLE IF NOT EXISTS audit_log (
        id TEXT PRIMARY KEY,
        actor_user_id TEXT,
        actor_username TEXT,
        action TEXT NOT NULL,
        target_type TEXT NOT NULL,
        target_id TEXT NOT NULL,
        detail TEXT NOT NULL DEFAULT '{}',
        occurred_at TEXT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_audit_occurred ON audit_log(occurred_at)`,
      `ALTER TABLE api_keys ADD COLUMN expires_at TEXT`,
      `ALTER TABLE outbound_webhooks ADD COLUMN last_status TEXT`,
      `ALTER TABLE outbound_webhooks ADD COLUMN last_delivery_at TEXT`,
      `ALTER TABLE outbound_webhooks ADD COLUMN last_detail TEXT`,
      `ALTER TABLE download_jobs ADD COLUMN priority INTEGER NOT NULL DEFAULT 0`,
      `CREATE INDEX IF NOT EXISTS idx_download_jobs_priority ON download_jobs(priority)`,
    ],
    postgres: [
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS active SMALLINT NOT NULL DEFAULT 1`,
      `CREATE TABLE IF NOT EXISTS audit_log (
        id TEXT PRIMARY KEY,
        actor_user_id TEXT,
        actor_username TEXT,
        action TEXT NOT NULL,
        target_type TEXT NOT NULL,
        target_id TEXT NOT NULL,
        detail JSONB NOT NULL DEFAULT '{}',
        occurred_at TEXT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_audit_occurred ON audit_log(occurred_at)`,
      `ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS expires_at TEXT`,
      `ALTER TABLE outbound_webhooks ADD COLUMN IF NOT EXISTS last_status TEXT`,
      `ALTER TABLE outbound_webhooks ADD COLUMN IF NOT EXISTS last_delivery_at TEXT`,
      `ALTER TABLE outbound_webhooks ADD COLUMN IF NOT EXISTS last_detail TEXT`,
      `ALTER TABLE download_jobs ADD COLUMN IF NOT EXISTS priority INTEGER NOT NULL DEFAULT 0`,
      `CREATE INDEX IF NOT EXISTS idx_download_jobs_priority ON download_jobs(priority)`,
    ],
  },
];

class InlineMigrationProvider implements MigrationProvider {
  constructor(private readonly dialect: Dialect) {}

  async getMigrations(): Promise<Record<string, Migration>> {
    const dialect = this.dialect;
    const out: Record<string, Migration> = {};
    for (const m of MIGRATIONS) {
      out[m.name] = {
        async up(db: Kysely<unknown>) {
          // Use the dialect captured from the outer connection, not the
          // transaction wrapper: the wrapper does not carry the dialect tag.
          const statements = dialect === "postgres" ? m.postgres : m.sqlite;
          for (const sql of statements) {
            await (db as unknown as { executeQuery(q: unknown): Promise<unknown> }).executeQuery({
              sql,
              parameters: [],
              query: { kind: "RawNode", sqlFragments: [sql], parameters: [] },
            } as never);
          }
        },
      };
    }
    return out;
  }
}

export async function openDatabase(opts: {
  dialect: Dialect;
  sqlitePath?: string;
  postgresUrl?: string;
}): Promise<Kysely<Db>> {
  if (opts.dialect === "postgres") {
    if (!opts.postgresUrl) throw new Error("postgresUrl required for postgres dialect");
    const { Pool } = await import("pg");
    const pool = new Pool({ connectionString: opts.postgresUrl });
    // Eagerly verify connectivity so boot fails loudly on a bad URL.
    await pool.query("SELECT 1");
    const db = new Kysely<Db>({
      dialect: new PostgresDialect({ pool }),
      plugins: [new CamelCasePlugin()],
    });
    (db as unknown as { __tantalarDialect: Dialect }).__tantalarDialect = "postgres";
    return db;
  }
  const path = opts.sqlitePath ?? "./data/tantalar.db";
  const sqlite = new Database(path);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  const db = new Kysely<Db>({
    dialect: new SqliteDialect({ database: sqlite }),
    plugins: [new CamelCasePlugin()],
  });
  (db as unknown as { __tantalarDialect: Dialect }).__tantalarDialect = "sqlite";
  return db;
}

/** Run all pending migrations; returns applied migration names this run. */
export async function migrate(db: Kysely<Db>): Promise<string[]> {
  const dialect =
    (db as unknown as { __tantalarDialect?: Dialect }).__tantalarDialect ?? "sqlite";
  const exec = db as unknown as { executeQuery(q: unknown): Promise<unknown> };
  await exec.executeQuery({
    sql: "SELECT 1",
    parameters: [],
    query: { kind: "RawNode", sqlFragments: ["SELECT 1"], parameters: [] },
  } as never);
  // Ensure tracking table exists before the Kysely migrator touches it.
  await exec.executeQuery({
    sql: "CREATE TABLE IF NOT EXISTS kysely_migrations (name TEXT PRIMARY KEY, timestamp TEXT NOT NULL)",
    parameters: [],
    query: {
      kind: "RawNode",
      sqlFragments: ["CREATE TABLE IF NOT EXISTS kysely_migrations (name TEXT PRIMARY KEY, timestamp TEXT NOT NULL)"],
      parameters: [],
    },
  } as never);
  const migrator = new Migrator({
    db: db as unknown as Kysely<any>,
    provider: new InlineMigrationProvider(dialect),
  });
  const { error, results } = await migrator.migrateToLatest();
  if (error) throw error;
  return (results ?? []).filter((r) => r.status === "Success").map((r) => r.migrationName);
}
export * from "./repositories.js";
export * from "./download-jobs.js";
export * from "./decisions.js";
