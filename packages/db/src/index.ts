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
}

export interface SchemaMigrationsTable {
  name: string;
  appliedAt: string;
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

export interface Db {
  users: UsersTable;
  sessions: SessionsTable;
  api_keys: ApiKeysTable;
  events: EventsTable;
  scheduler_jobs: SchedulerJobsTable;
  plugin_state: PluginStateTable;
  outbound_webhooks: OutboundWebhooksTable;
  ui_preferences: UiPreferencesTable;
  themes: ThemesTable;
  schema_migrations: SchemaMigrationsTable;
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
];

class InlineMigrationProvider implements MigrationProvider {
  async getMigrations(): Promise<Record<string, Migration>> {
    const out: Record<string, Migration> = {};
    for (const m of MIGRATIONS) {
      out[m.name] = {
        async up(db: Kysely<unknown>) {
          const dialect = (db as unknown as { __tantalarDialect?: Dialect }).__tantalarDialect ?? "sqlite";
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
    provider: new InlineMigrationProvider(),
  });
  const { error, results } = await migrator.migrateToLatest();
  if (error) throw error;
  return (results ?? []).filter((r) => r.status === "Success").map((r) => r.migrationName);
}
