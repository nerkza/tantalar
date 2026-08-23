/**
 * Kernel boot (architecture §4): config -> DB migrate -> event log ->
 * container -> supervisor -> HTTP. Owns graceful shutdown ordering.
 */
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, dumpConfig, unsecret, type LoadedConfig } from "@tantalar/config";
import { openDatabase, migrate, type Db, type Dialect } from "@tantalar/db";
import { Kysely } from "kysely";
import pino from "pino";
import { AuthService } from "./auth.js";
import { EventBus } from "./events.js";
import { ServiceContainer } from "./container.js";
import { Scheduler } from "./scheduler.js";
import { Supervisor } from "./supervisor.js";
import { buildServer } from "./http.js";
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

export interface Kernel {
  config: LoadedConfig;
  db: Kysely<Db>;
  bus: EventBus;
  container: ServiceContainer;
  scheduler: Scheduler;
  supervisor: Supervisor;
  auth: AuthService;
  ready(): boolean;
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
      return {
        command: cmd ?? "node",
        args: [...(manifest.entry.args ?? []), script ?? ""],
        env: {},
      };
    },
  });

  let readyFlag = false;

  const kernel: Kernel = {
    config: loaded,
    db,
    bus,
    container,
    scheduler,
    supervisor,
    auth,
    ready: () => readyFlag,
    async listen(host?: string, port?: number) {
      const app = await buildServer({
        auth,
        bus,
        supervisor,
        container,
        ready: () => readyFlag,
      });
      const serverCfg = loaded.config.server as { host: string; port: number };
      const addr = await app.listen({ port: port ?? serverCfg.port, host: host ?? serverCfg.host });
      void app;
      readyFlag = true;
      await bus.publish({ type: EventTypes.ServerBooted, producer: "core", payload: { addr } });
      return addr;
    },
    async shutdown() {
      readyFlag = false;
      scheduler.stop();
      await supervisor.stopAll();
      await db.destroy();
    },
  };

  // Mount config-declared enabled plugins unless skipped (tests).
  if (!options.skipConfigPlugins) {
    const pluginSet = ((loaded.config.plugins as { set?: Record<string, unknown> }).set ?? {}) as Record<
      string,
      { enabled?: boolean; manifestPath?: string }
    >;
    for (const [id, def] of Object.entries(pluginSet)) {
      if (def.enabled === false || !def.manifestPath) continue;
      try {
        const mod = await import(def.manifestPath);
        await supervisor.mount(mod.manifest ?? mod.default?.manifest ?? {}, {});
      } catch (err) {
        log.error({ pluginId: id, err: String(err) }, "plugin mount failed");
        throw err;
      }
    }
  }

  scheduler.start();
  return kernel;
}

export { dumpConfig };
