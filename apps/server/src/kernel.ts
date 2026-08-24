/**
 * Kernel boot (architecture §4): config -> DB migrate -> event log ->
 * container -> supervisor -> HTTP. Owns graceful shutdown ordering.
 */
import { mkdir } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, dumpConfig, unsecret, type LoadedConfig } from "@tantalar/config";
import { openDatabase, migrate, type Db, type Dialect } from "@tantalar/db";
import { PluginDocumentStore, LibraryRepository, MediaCatalogRepository } from "@tantalar/db";
import { Kysely } from "kysely";
import pino from "pino";
import { AuthService } from "./auth.js";
import { EventBus } from "./events.js";
import { ServiceContainer } from "./container.js";
import { Scheduler } from "./scheduler.js";
import { Supervisor } from "./supervisor.js";
import { buildServer } from "./http.js";
import { type ServingDeps } from "./serving.js";
import { PluginLifecycleManager } from "./lifecycle.js";
import { LibraryService } from "./library.js";
import { EventTypes, CapabilityNames } from "@tantalar/contracts";

export interface BootOptions {
  profileFile?: string;
  hostFile?: string;
  cliOverrides?: Record<string, unknown>;
  env?: NodeJS.ProcessEnv;
  /** Test hook: skip mounting plugins declared in config. */
  skipConfigPlugins?: boolean;
  /** Test hook: override plugin entry resolution root. */
  pluginRoot?: string;
}

export interface ReadinessReport {
  /** True only when listening AND every required capability has a live provider. */
  ready: boolean;
  listening: boolean;
  /** Required capabilities with no provider right now (empty when ready). */
  missingCapabilities: string[];
}

export interface Kernel {
  config: LoadedConfig;
  db: Kysely<Db>;
  bus: EventBus;
  container: ServiceContainer;
  scheduler: Scheduler;
  supervisor: Supervisor;
  auth: AuthService;
  ready(): boolean;
  /** Truthful readiness: mount completion alone is NOT capability readiness. */
  readiness(): ReadinessReport;
  listen(host?: string, port?: number): Promise<string>;
  shutdown(): Promise<void>;
}

export async function boot(options: BootOptions = {}): Promise<Kernel> {
  const log = pino({ level: "info" });

  // 1. Config
  const loaded = loadConfig({
    ...(options.profileFile ? { profileFile: options.profileFile } : {}),
    ...(options.hostFile ? { hostFile: options.hostFile } : {}),
    ...(options.cliOverrides ? { cliOverrides: options.cliOverrides as never } : {}),
    ...(options.env ? { env: options.env } : {}),
  });
  for (const w of loaded.warnings) log.warn({ layer: w.layer }, w.message);

  // 2. DB open + migrate (env secrets arrive as {value, secret:true} wrappers;
  //    unsecret() resolves them for runtime use).
  const dbCfg = unsecret(loaded.config.database as never) as {
    dialect: string;
    sqlite?: { path: string };
    postgres?: { url?: string };
  };
  const dialect: Dialect = dbCfg.dialect === "postgres" ? "postgres" : "sqlite";
  let sqlitePath: string | undefined;
  if (dialect === "sqlite") {
    sqlitePath = resolve(dbCfg.sqlite?.path ?? "./data/tantalar.db");
    await mkdir(dirname(sqlitePath), { recursive: true });
  }
  const db = await openDatabase({
    dialect,
    ...(sqlitePath !== undefined ? { sqlitePath } : {}),
    postgresUrl: dbCfg.postgres?.url ?? process.env["TANTALAR_SECRET_DATABASE_POSTGRES_URL"],
  });
  await migrate(db);
  log.info({ dialect }, "migrations applied");

  // 3. Event log / bus
  const bus = new EventBus(db);

  // 4. Service container
  const container = new ServiceContainer();

  // 5. Supervisor
  const auth = new AuthService(
    db,
    (loaded.config.auth as { sessionTtlSeconds?: number }).sessionTtlSeconds,
  );
  const scheduler = new Scheduler(db, (loaded.config.scheduler as { tickMs?: number }).tickMs);
  const restartPolicyCfg = (loaded.config.plugins as { restart?: Record<string, number> }).restart ?? {};

  // Wave 3 (TAN-013): durable plugin document storage — the supervisor
  // bridges plugin storage calls onto this store, namespaced by plugin id.
  const documents = new PluginDocumentStore(db);
  // Wave 3 (TAN-020/021): core library + media catalog repositories.
  const libraries = new LibraryRepository(db);
  const mediaCatalog = new MediaCatalogRepository(db);

  // Register core capability providers so plugins' requires can resolve.
  container.register({
    pluginId: "core",
    capability: "dev.tantalar.capability.event.emit",
    invoke: async () => ({ ok: true }), // emit flows through the control channel instead
  });
  container.register({
    pluginId: "core",
    capability: "dev.tantalar.capability.log",
    invoke: async () => ({ ok: true }),
  });
  // Phase 2: auth introspection (mcp-server.md §3). Narrow surface: validity,
  // owning identity, scopes. Raw keys are never returned, logged, or stored.
  container.register({
    pluginId: "core",
    capability: CapabilityNames.AuthIntrospection,
    invoke: async (_operation, payload) => {
      const key = String(payload.apiKey ?? "");
      const rec = key ? await auth.verifyApiKey(key) : null;
      return {
        valid: rec !== null,
        identity: rec?.id ?? "",
        scopes: rec?.scopes ?? [],
      };
    },
  });

  // Deliver every published event to subscribed plugins (Phase 2 contract).
  bus.subscribe("", (envelope) => {
    void supervisor.deliverEventToPlugins(envelope);
  });

  const here = dirname(fileURLToPath(import.meta.url));
  const supervisor = new Supervisor({
    bus,
    container,
    scheduler,
    documents,
    restartPolicy: {
      initialBackoffMs: Number(restartPolicyCfg.initialBackoffMs ?? 500),
      maxBackoffMs: Number(restartPolicyCfg.maxBackoffMs ?? 30000),
      backoffMultiplier: Number(restartPolicyCfg.backoffMultiplier ?? 2),
      windowMs: Number(restartPolicyCfg.windowMs ?? 60000),
      maxRestartsInWindow: Number(restartPolicyCfg.maxRestartsInWindow ?? 5),
    },
    healthIntervalMs: 2000,
    resolveEntry: (manifest) => {
      if (!manifest.entry.command.startsWith("node ")) throw new Error(`unsupported entry: ${manifest.entry.command}`);
      const [cmd, script] = manifest.entry.command.split(" ");
      let resolved = script ?? "";
      // Package-relative entries ("node dist/plugin.js") resolve against the
      // plugin package root (the directory holding the manifest), NOT the
      // server process cwd — plugins live in their own directories.
      if (resolved && !resolved.startsWith("/")) {
        const pkgRoot = resolve(process.cwd(), "plugins", manifest.id.split(".").pop() ?? "");
        resolved = join(pkgRoot, resolved);
      }
      return {
        command: cmd ?? "node",
        args: [...(manifest.entry.args ?? []), resolved],
        env: {},
      };
    },
  });

  let listening = false;
  const pluginsCfg = loaded.config.plugins as {
    set?: Record<string, { enabled?: boolean; manifestPath?: string; config?: Record<string, unknown> }>;
    requiredCapabilities?: string[];
  };
  const requiredCapabilities = pluginsCfg.requiredCapabilities ?? [];

  /** Capability readiness: every required capability must have a provider. */
  const missingCapabilities = (): string[] =>
    requiredCapabilities.filter((cap) => !container.hasProviders(cap));

  const readiness = (): ReadinessReport => {
    const missing = missingCapabilities();
    return {
      ready: listening && missing.length === 0,
      listening,
      missingCapabilities: missing,
    };
  };

  const kernel: Kernel = {
    config: loaded,
    db,
    bus,
    container,
    scheduler,
    supervisor,
    auth,
    ready: () => readiness().ready,
    readiness,
    async listen(host?: string, port?: number) {
      const app = await buildServer({
        auth,
        db,
        bus,
        supervisor,
        container,
        ready: () => readiness().ready,
        readiness,
        // Wave 3 (TAN-020/021): library management surface.
        library: new LibraryService({ bus, libraries, mediaCatalog }),
        // Wave 9 (TAN-030–043): operations surface — queue, plugin
        // management, users, API keys, webhooks, backup/restore,
        // diagnostics. sqlitePath present only on the SQLite dialect.
        ops: {
          auth,
          db,
          bus,
          supervisor,
          container,
          ready: () => readiness().ready,
          ...(dialect === "sqlite" && typeof sqlitePath === "string" ? { sqlitePath } : {}),
          dataDir: resolve(sqlitePath ?? "./data", ".."),
        },
        // Phase 5A serving surface: routes exist whenever the serving
        // capability has a provider (standard install mounts it). Core
        // re-checks path containment; fileId→path resolution stays with the
        // durable media catalog (later wave) so unresolvable ids 404.
        ...(container.hasProviders("dev.tantalar.capability.serving")
          ? {
              serving: (invoke): ServingDeps => ({
                invoke,
                requireAuth: null as never, // filled in by buildServer (see http.ts)
                resolvePath: () => null,
                mediaRoots: [],
              }),
            }
          : {}),
      });
      const serverCfg = loaded.config.server as { host: string; port: number };
      const addr = await app.listen({ port: port ?? serverCfg.port, host: host ?? serverCfg.host });
      void app;
      listening = true;
      await bus.publish({ type: EventTypes.ServerBooted, producer: "core", payload: { addr } });
      return addr;
    },
    async shutdown() {
      listening = false;
      scheduler.stop();
      await supervisor.stopAll();
      await db.destroy();
    },
  };

  // Mount config-declared enabled plugins through the documented lifecycle
  // manager (manifest loader + validation), never a raw dynamic import.
  // Mount completion is NOT capability readiness — /readyz checks the
  // required capabilities via kernel.readiness().
  if (!options.skipConfigPlugins) {
    const lifecycle = new PluginLifecycleManager({
      supervisor,
      basePath: options.pluginRoot ?? process.cwd(),
    });
    const result = await lifecycle.apply((pluginsCfg.set ?? {}) as never);
    for (const f of result.failed) {
      log.error({ pluginId: f.pluginId, err: f.error }, "plugin mount failed");
    }
  }

  scheduler.start();
  return kernel;
}

export { dumpConfig };
