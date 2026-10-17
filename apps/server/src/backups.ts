import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import Database from "better-sqlite3";
import { PluginDocumentStore, type Db } from "@tantalar/db";
import { unsecret } from "@tantalar/config";
import type { Kysely } from "kysely";
import { nextRunAt, type Scheduler } from "./scheduler.js";
import { validSecretValue } from "./secret-store.js";

export const CONFIGURATION_LIMIT = 256 * 1024 * 1024;
// ponytail: JSON snapshots hold database bytes in memory; use a streamed archive above 180 MiB.
const OWNER = "core.backups";
const JOB = "core::backup";
const fail = (message: string, statusCode = 400): never => { throw Object.assign(new Error(message), { statusCode }); };
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
type Secrets = { version: 1; secrets: Record<string, Record<string, string>> };
interface RuntimeConfiguration { config: Record<string, unknown>; environment: Record<string, string> }
interface ConfigurationFile extends RuntimeConfiguration {
  format: "tantalar-configuration";
  version: 1;
  createdAt: string;
  database: { encoding: "base64"; sha256: string; data: string };
  secrets: Secrets;
}
export interface BackupSettings { directory: string; retention: number }

async function atomicWrite(path: string, value: string | Buffer) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, value, { mode: 0o600 });
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
}

async function readJson(path: string): Promise<unknown | null> {
  try { return JSON.parse(await readFile(path, "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Capture named NNTP/webhook credentials without importing arbitrary process environment variables. */
function portableReferences(value: unknown, environment: Record<string, string>): void {
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (["passwordEnv", "secretEnvVar"].includes(key) && typeof child === "string" && process.env[child] !== undefined) {
      const alias = /^(TANTALAR_SECRET_|TANTALAR_WEBHOOK_)/.test(child) ? child : `TANTALAR_SECRET_IMPORTED_${hash(Buffer.from(child)).slice(0, 16).toUpperCase()}`;
      environment[alias] = process.env[child]!;
      (value as Record<string, unknown>)[key] = alias;
    } else portableReferences(child, environment);
  }
}

function validateRuntime(value: unknown): asserts value is RuntimeConfiguration {
  if (!object(value) || !object(value.config) || !object(value.environment)) return fail("Invalid configuration mapping.");
  const check = (node: unknown, depth = 0) => {
    if (depth > 40) fail("Configuration is nested too deeply.");
    if (node && typeof node === "object") for (const [key, child] of Object.entries(node)) {
      if (["__proto__", "prototype", "constructor"].includes(key)) fail("Unsafe configuration key.");
      check(child, depth + 1);
    }
  };
  check(value);
  for (const [name, secret] of Object.entries(value.environment)) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(name) || !name.startsWith("TANTALAR_SECRET_") && !name.startsWith("TANTALAR_WEBHOOK_") || typeof secret !== "string" || secret.includes("\0")) {
      fail("Invalid credential environment entry.");
    }
  }
  const config = value.config;
  if (!object(config.server) || typeof config.server.host !== "string" || !Number.isInteger(config.server.port) || Number(config.server.port) < 0 || Number(config.server.port) > 65535
    || !object(config.plugins) || !object(config.plugins.set) || !Array.isArray(config.plugins.requiredCapabilities)
    || !object(config.auth) || !Number.isFinite(config.auth.sessionTtlSeconds) || Number(config.auth.sessionTtlSeconds) <= 0
    || !object(config.scheduler) || !Number.isFinite(config.scheduler.tickMs) || Number(config.scheduler.tickMs) < 1) fail("Invalid server, plugin, authentication or scheduler configuration.");
}

/** Apply only before opening the database. The pending file is a replayable recovery journal. */
export async function applyPendingConfiguration(dataDir: string, sqlitePath: string): Promise<void> {
  const pending = join(dataDir, "configuration.pending.json");
  const value = await readJson(pending);
  if (!value) return;
  validateRuntime(value);
  const file = value as ConfigurationFile;
  const bytes = Buffer.from(file.database.data, "base64");
  if (hash(bytes) !== file.database.sha256) fail("Pending configuration checksum failed.");
  // Preserve the last live state, including writes made after the import was staged.
  const safety = join(dataDir, "configuration.pre-restore.db");
  if (!await stat(safety).catch(() => null)) {
    const live = new Database(sqlitePath, { readonly: true });
    const temporary = `${safety}.tmp`;
    await writeFile(temporary, "", { mode: 0o600 });
    try { await live.backup(temporary); } finally { live.close(); }
    for (const name of [".secrets.json", "configuration.runtime.json"]) {
      const content = await readFile(join(dataDir, name)).catch(error => { if (error.code === "ENOENT") return null; throw error; });
      if (content) await atomicWrite(join(dataDir, `${name}.pre-restore`), content);
    }
    await rename(temporary, safety);
  }
  await atomicWrite(join(dataDir, ".secrets.json"), JSON.stringify(file.secrets));
  await atomicWrite(join(dataDir, "configuration.runtime.json"), JSON.stringify({ config: file.config, environment: file.environment }));
  await rm(`${sqlitePath}-wal`, { force: true });
  await rm(`${sqlitePath}-shm`, { force: true });
  await atomicWrite(sqlitePath, bytes);
  const restored = new Database(sqlitePath);
  try { restored.exec("DELETE FROM sessions"); } finally { restored.close(); }
  await rm(pending);
}

export async function readRuntimeConfiguration(dataDir: string): Promise<RuntimeConfiguration | null> {
  const value = await readJson(join(dataDir, "configuration.runtime.json"));
  if (value === null) return null;
  validateRuntime(value);
  return value;
}

export class Backups {
  #busy = false;
  readonly store: PluginDocumentStore;
  constructor(readonly db: Kysely<Db>, readonly dataDir: string, readonly sqlitePath: string | undefined,
    readonly config: Record<string, unknown>, readonly scheduler?: Scheduler) { this.store = new PluginDocumentStore(db); }

  async register() {
    await this.scheduler?.declareJob("core", "backup", "daily 02:00", async () => {
      const result = await this.save(true);
      return { outcome: `Configuration backup saved to ${result.path}.`, counts: { bytes: result.bytes } };
    }, { name: "Configuration backup", scope: "Complete configuration and database", enabled: Boolean(this.sqlitePath), resource: "configuration-backup" });
  }

  async settings() {
    const saved = (await this.store.get(OWNER, "settings"))?.doc as BackupSettings | undefined;
    const job = (await this.scheduler?.listJobs())?.find(job => job.jobKey === JOB);
    return { directory: saved?.directory ?? join(this.dataDir, "backups"), retention: saved?.retention ?? 7,
      supported: Boolean(this.sqlitePath), enabled: Boolean(job?.enabled), schedule: job?.schedule ?? "daily 02:00",
      nextRunAt: job?.nextRunAt ?? null, latestRun: job?.latestRun ?? null,
      pendingImport: Boolean(await stat(join(this.dataDir, "configuration.pending.json")).catch(() => null)) };
  }

  async update(input: BackupSettings & { enabled: boolean; schedule: string }) {
    if (!this.sqlitePath) fail("Configuration backups require SQLite storage.", 503);
    if (!this.scheduler) fail("Scheduler is unavailable.", 503);
    if (!nextRunAt(input.schedule) || !Number.isInteger(input.retention) || input.retention < 0 || input.retention > 3650 || !input.directory.trim() || input.directory.includes("\0")) fail("Invalid backup settings.");
    const directory = resolve(input.directory.trim());
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await this.scheduler!.updateJob(JOB, { schedule: input.schedule, enabled: input.enabled });
    await this.store.put(OWNER, "settings", { directory, retention: input.retention });
    return this.settings();
  }

  async exclusive<T>(work: () => Promise<T>): Promise<T> {
    if (this.#busy) fail("A configuration operation is already running.", 409);
    this.#busy = true;
    try { return await work(); } finally { this.#busy = false; }
  }

  async snapshot(): Promise<ConfigurationFile> {
    if (!this.sqlitePath) fail("Configuration backups require SQLite storage.", 503);
    const temporary = join(this.dataDir, `configuration-${randomUUID()}.tmp`);
    const source = new Database(this.sqlitePath!, { readonly: true });
    try {
      await writeFile(temporary, "", { mode: 0o600 });
      await source.backup(temporary);
      await chmod(temporary, 0o600);
      const environment = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => /^(TANTALAR_SECRET_|TANTALAR_WEBHOOK_)/.test(entry[0]) && entry[1] !== undefined));
      const config = unsecret(this.config) as Record<string, unknown>;
      portableReferences(config, environment);
      const probe = new Database(temporary);
      try {
        probe.pragma("journal_mode = DELETE");
        probe.transaction(() => {
          for (const row of probe.prepare("SELECT plugin_id, doc_key, doc FROM plugin_documents").all() as Array<{ plugin_id: string; doc_key: string; doc: string }>) {
            const doc = JSON.parse(row.doc); portableReferences(doc, environment);
            const encoded = JSON.stringify(doc);
            if (encoded !== row.doc) probe.prepare("UPDATE plugin_documents SET doc = ? WHERE plugin_id = ? AND doc_key = ?").run(encoded, row.plugin_id, row.doc_key);
          }
          for (const row of probe.prepare("SELECT id, secret_env_var FROM outbound_webhooks").all() as Array<{ id: string; secret_env_var: string }>) {
            const ref = { secretEnvVar: row.secret_env_var }; portableReferences(ref, environment);
            if (ref.secretEnvVar !== row.secret_env_var) probe.prepare("UPDATE outbound_webhooks SET secret_env_var = ? WHERE id = ?").run(ref.secretEnvVar, row.id);
          }
        })();
        if (probe.pragma("integrity_check", { simple: true }) !== "ok") fail("Backup integrity check failed.", 500);
      }
      finally { probe.close(); }
      if ((await stat(temporary)).size > 180 * 1024 * 1024) fail("Database exceeds the 180 MiB configuration-file limit.", 413);
      const bytes = await readFile(temporary);
      const secrets = await readJson(join(this.dataDir, ".secrets.json")) as Secrets | null;
      return { format: "tantalar-configuration", version: 1, createdAt: new Date().toISOString(), config, environment,
        database: { encoding: "base64", sha256: hash(bytes), data: bytes.toString("base64") }, secrets: secrets ?? { version: 1, secrets: {} } };
    } finally { source.close(); await rm(temporary, { force: true }); }
  }

  async save(automatic = false) {
    return this.exclusive(async () => {
      const settings = await this.settings();
      const file = await this.snapshot();
      const prefix = automatic ? "tantalar-auto-" : "tantalar-config-";
      const path = join(settings.directory, `${prefix}${file.createdAt.replace(/[:.]/g, "-")}-${randomUUID()}.json`);
      const text = JSON.stringify(file);
      if (Buffer.byteLength(text) > CONFIGURATION_LIMIT) fail("Configuration exceeds the 256 MiB file limit.", 413);
      await atomicWrite(path, text);
      if (automatic && settings.retention > 0) {
        const files = (await readdir(settings.directory)).filter(name => /^tantalar-auto-[\dTZ-]+-[a-f0-9-]{36}\.json$/.test(name)).sort().reverse();
        for (const name of files.slice(settings.retention)) await rm(join(settings.directory, name));
      }
      return { path, bytes: Buffer.byteLength(text), includes: ["complete database", "effective configuration", "saved credentials", "Tantalar credential environment"] };
    });
  }

  async stage(value: unknown) {
    return this.exclusive(async () => {
      if (!this.sqlitePath) fail("Configuration imports require SQLite storage.", 503);
      if ((await this.settings()).pendingImport) fail("An import is already pending. Restart or cancel it first.", 409);
      validateRuntime(value);
      const file = value as ConfigurationFile;
      if (file.format !== "tantalar-configuration" || file.version !== 1 || typeof file.createdAt !== "string"
        || !object(file.database) || file.database.encoding !== "base64" || typeof file.database.data !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(file.database.data)
        || !object(file.secrets) || file.secrets.version !== 1 || !object(file.secrets.secrets)) fail("Unsupported or invalid Tantalar configuration file.");
      for (const [owner, refs] of Object.entries(file.secrets.secrets)) {
        if (!object(refs) || Object.values(refs).some(secret => !validSecretValue(owner, secret))) fail("Invalid saved credentials.");
      }
      const text = JSON.stringify(file);
      if (Buffer.byteLength(text) > CONFIGURATION_LIMIT) fail("Configuration exceeds the 256 MiB file limit.", 413);
      const bytes = Buffer.from(file.database.data, "base64");
      if (hash(bytes) !== file.database.sha256) fail("Configuration database checksum failed.");
      const temporary = join(this.dataDir, `import-${randomUUID()}.tmp`);
      await atomicWrite(temporary, bytes);
      try {
        const probe = new Database(temporary, { readonly: true });
        const live = new Database(this.sqlitePath!, { readonly: true });
        try {
          const schema = (db: Database.Database) => JSON.stringify(db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all());
          if (schema(probe) !== schema(live)) fail("Configuration database schema differs. Import into the same Tantalar version.");
          if (probe.pragma("integrity_check", { simple: true }) !== "ok" || (probe.pragma("foreign_key_check") as unknown[]).length) fail("Configuration database integrity check failed.");
          if (!(probe.prepare("SELECT count(*) AS n FROM users WHERE role = 'admin' AND active = 1").get() as { n: number }).n) fail("Configuration must contain an active administrator.");
        } finally { probe.close(); live.close(); }
      } catch (error) { if ((error as { statusCode?: number }).statusCode) throw error; fail("Configuration database is unreadable."); }
      finally { await rm(temporary, { force: true }); }
      // Keep a complete safety file. Retention never deletes manual or safety backups.
      const safety = await this.snapshot();
      await atomicWrite(join(this.dataDir, `configuration-safety-${randomUUID()}.json`), JSON.stringify(safety));
      for (const name of ["configuration.pre-restore.db", ".secrets.json.pre-restore", "configuration.runtime.json.pre-restore"]) await rm(join(this.dataDir, name), { force: true });
      await atomicWrite(join(this.dataDir, "configuration.pending.json"), text);
      return { note: "Import validated. Restart Tantalar, then sign in with an administrator account from the imported file. Host configuration and environment overrides remain active." };
    });
  }

  async stagePath(path: string) {
    const directory = await realpath((await this.settings()).directory).catch(() => fail("Managed backups directory does not exist. Save a configuration first."));
    const candidate = await realpath(resolve(path)).catch(() => fail("Backup file not found."));
    if (!candidate.startsWith(directory + sep)) fail("Path must be a file inside the managed backups directory.");
    if (!(await stat(candidate)).isFile() || (await stat(candidate)).size > CONFIGURATION_LIMIT) fail("Invalid backup file or file exceeds 256 MiB.");
    if (candidate.endsWith(".db")) {
      const file = await this.exclusive(() => this.snapshot());
      const bytes = await readFile(candidate);
      file.database = { encoding: "base64", data: bytes.toString("base64"), sha256: hash(bytes) };
      return this.stage(file);
    }
    let value: unknown;
    try { value = JSON.parse(await readFile(candidate, "utf8")); } catch { return fail("Select a Tantalar configuration JSON file."); }
    return this.stage(value);
  }

  async cancel() { return this.exclusive(async () => { await rm(join(this.dataDir, "configuration.pending.json"), { force: true }); return { cancelled: true }; }); }
}
