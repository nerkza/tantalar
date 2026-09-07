/**
 * Kernel boot (architecture §4): config -> DB migrate -> event log ->
 * container -> supervisor -> HTTP. Owns graceful shutdown ordering.
 */
import { mkdir, realpath, stat } from "node:fs/promises";
import { execFile } from "node:child_process";
import { basename, extname, join, dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, dumpConfig, unsecret, type LoadedConfig } from "@tantalar/config";
import { openDatabase, migrate, DownloadJobStore, type Db, type Dialect, type LibraryRecord, type MediaCatalogRecord } from "@tantalar/db";
import { PluginDocumentStore, LibraryRepository, MediaCatalogRepository } from "@tantalar/db";
import { Kysely } from "kysely";
import pino from "pino";
import { AuthService } from "./auth.js";
import { EventBus } from "./events.js";
import { ServiceContainer, type CapabilityProvider } from "./container.js";
import { Scheduler } from "./scheduler.js";
import { registerLibraryJobs } from "./runtime-jobs.js";
import { QualitySettings } from "./quality-settings.js";
import { runUpgradeSearch } from "./acquisition/upgrade-search.js";
import { Supervisor } from "./supervisor.js";
import { buildServer } from "./http.js";
import { type ServingDeps } from "./serving.js";
import { PluginLifecycleManager, type PluginSet, type PluginSetEntry } from "./lifecycle.js";
import { LibraryService } from "./library.js";
import { catalogIdentity, identifyCatalogFile } from "./catalog-identification.js";
import { IndexerSettingsService } from "./indexer-settings.js";
import { SecretStore } from "./secret-store.js";
import { syncDownloadJobs } from "./download-manager.js";
import { runAutomaticAcquisition } from "./acquisition/managed-search.js";
import { ReleaseDecisionStore } from "@tantalar/db";
import { EventTypes, CapabilityNames, parseQualityLabel, type DownloadJobRecord, type ImportResult, type LibraryEntry } from "@tantalar/contracts";

const SERVING_CAPABILITY = "dev.tantalar.capability.serving";
const MCP_PLUGIN_ID = "dev.tantalar.plugin.mcp";
const MCP_MANIFEST_PATH = "plugins/mcp-server/manifest.json";
const MCP_DEFAULT_CONFIG = {
  http: { enabled: true, bind: "127.0.0.1", port: 8642, tlsViaProxy: false },
  mutatingToolsEnabled: false,
  limits: { timeoutMs: 30_000, maxResultBytes: 1_048_576, rateLimitPerMinute: 120 },
} satisfies Record<string, unknown>;

/** Decode the SQLite TEXT or PostgreSQL JSONB representation. */
export function decodeMcpDesiredConfig(value: unknown): Record<string, unknown> {
  const decoded = typeof value === "string" ? JSON.parse(value) as unknown : value;
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) {
    throw new Error("stored MCP configuration must be an object");
  }
  return structuredClone(decoded as Record<string, unknown>);
}

export const DEFAULT_HLS_FFMPEG_ARGS = [
  "-hide_banner", "-loglevel", "error", "-y",
  "-re", "-threads", "2", "-filter_threads", "2", "-filter_complex_threads", "2",
  "-i", "{{inputPath}}",
  "-map", "0:v:0", "-map", "0:a:0?", "-sn",
  "-vf", "scale=-2:min(720\\,ih)",
  "-c:v", "libx264", "-threads", "2", "-preset", "veryfast", "-crf", "24",
  "-maxrate", "2500k", "-bufsize", "5000k",
  "-c:a", "aac", "-ac", "2", "-ar", "48000",
  "-f", "hls", "-hls_time", "2", "-hls_list_size", "0",
  "-hls_flags", "independent_segments+temp_file",
  "-hls_segment_filename", "{{sessionIdPlaceholder}}/seg%05d.ts",
  "{{sessionIdPlaceholder}}/playlist.m3u8",
] as const;

type ProbedMedia = Pick<LibraryEntry, "videoCodec" | "audioCodec" | "audioTracks">;

function probeMedia(filePath: string): Promise<ProbedMedia> {
  return new Promise((done) => {
    execFile(
      "ffprobe",
      [
        "-v",
        "error",
        "-show_entries",
        "stream=index,codec_type,codec_name:stream_tags=language:stream_disposition=default",
        "-of",
        "json",
        filePath,
      ],
      { timeout: 15_000, maxBuffer: 1024 * 1024 },
      (error, stdout) => {
        if (error) return done({ videoCodec: "unknown", audioCodec: "unknown", audioTracks: [] });
        try {
          const streams = (JSON.parse(stdout) as {
            streams?: Array<{
              index?: number;
              codec_type?: string;
              codec_name?: string;
              tags?: { language?: string };
              disposition?: { default?: number };
            }>;
          }).streams ?? [];
          const video = streams.find((stream) => stream.codec_type === "video")?.codec_name;
          const audioStreams = streams.filter((stream) => stream.codec_type === "audio");
          const audio = audioStreams[0]?.codec_name;
          const videoCodec: LibraryEntry["videoCodec"] =
            video === "h264" || video === "hevc" || video === "av1" ? video : "unknown";
          const audioCodec: LibraryEntry["audioCodec"] =
            audio === "aac" || audio === "ac3" || audio === "dts" || audio === "truehd"
              ? audio
              : audio === "eac3"
                ? "ac3"
                : "unknown";
          const audioTracks = audioStreams.flatMap((stream) => {
            if (!Number.isInteger(stream.index)) return [];
            const codec: LibraryEntry["audioCodec"] =
              stream.codec_name === "aac" || stream.codec_name === "ac3" || stream.codec_name === "dts" || stream.codec_name === "truehd"
                ? stream.codec_name
                : stream.codec_name === "eac3"
                  ? "ac3"
                  : "unknown";
            return [{
              streamIndex: stream.index!,
              lang: stream.tags?.language?.trim().toLowerCase() || "und",
              codec,
              default: stream.disposition?.default === 1,
            }];
          });
          done({ videoCodec, audioCodec, audioTracks });
        } catch {
          done({ videoCodec: "unknown", audioCodec: "unknown", audioTracks: [] });
        }
      },
    );
  });
}

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
  const configuredMcp = (loaded.config as Record<string, unknown>)["mcp"];
  if (configuredMcp !== undefined && (!configuredMcp || typeof configuredMcp !== "object" || Array.isArray(configuredMcp))) {
    throw new Error("top-level MCP configuration must be an object");
  }

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
  const runtimeDataDir = sqlitePath ? dirname(sqlitePath) : resolve("./data");
  const hlsRoot = join(runtimeDataDir, "hls");
  await mkdir(hlsRoot, { recursive: true });
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
  const secrets = new SecretStore(join(runtimeDataDir, ".secrets.json"));
  const indexerSettings = new IndexerSettingsService(db);
  let unregisterConfiguredIndexer: (() => void) | null = null;
  const syncConfiguredIndexer = async (): Promise<void> => {
    const enabled = await indexerSettings.hasEnabled();
    if (enabled && !unregisterConfiguredIndexer) {
      unregisterConfiguredIndexer = container.register({
        pluginId: "dev.tantalar.core.configured-indexers",
        capability: "dev.tantalar.capability.indexer",
        invoke: async (operation, payload) => {
          if (operation === "search") return indexerSettings.search(payload);
          if (operation === "status") return { enabled: await indexerSettings.hasEnabled() };
          throw new Error(`unknown configured-indexer operation ${operation}`);
        },
      });
    } else if (!enabled && unregisterConfiguredIndexer) {
      unregisterConfiguredIndexer();
      unregisterConfiguredIndexer = null;
    }
  };
  indexerSettings.setOnChanged(syncConfiguredIndexer);
  await syncConfiguredIndexer();

  // 5. Supervisor
  const auth = new AuthService(
    db,
    (loaded.config.auth as { sessionTtlSeconds?: number }).sessionTtlSeconds,
  );
  const scheduler = new Scheduler(db, (loaded.config.scheduler as { tickMs?: number }).tickMs, bus);
  await scheduler.recoverInterrupted();
  const restartPolicyCfg = (loaded.config.plugins as { restart?: Record<string, number> }).restart ?? {};

  // Wave 3 (TAN-013): durable plugin document storage — the supervisor
  // bridges plugin storage calls onto this store, namespaced by plugin id.
  const documents = new PluginDocumentStore(db);
  // Wave 3 (TAN-020/021): core library + media catalog repositories.
  const libraries = new LibraryRepository(db);
  const mediaCatalog = new MediaCatalogRepository(db);

  const registerCatalogRecord = async (
    record: MediaCatalogRecord,
    library: LibraryRecord,
    identify = false,
  ): Promise<void> => {
    if (!container.hasProviders(SERVING_CAPABILITY)) return;
    const root = await realpath(library.rootPath);
    const path = await realpath(record.path);
    if (path !== root && !path.startsWith(root + sep)) throw new Error("catalog path escapes its library root");
    const info = await stat(path);
    if (!info.isFile()) throw new Error("catalog path is not a file");
    // Metadata matching belongs to scans; provider outages must not delay startup hydration.
    if (identify && record.itemKey.startsWith("existing:")) {
      try {
        const itemKey = await identifyCatalogFile(container, path, library.id, library.kind);
        if (itemKey) {
          await db.updateTable("media_catalog").set({ itemKey, updatedAt: new Date().toISOString() }).where("fileId", "=", record.fileId).execute();
          record = { ...record, itemKey };
        }
      } catch {
        log.warn({ fileId: record.fileId }, "catalog metadata matching unavailable; file remains playable");
      }
    }
    const identity = catalogIdentity(path, record.itemKey, library.kind);
    const extension = extname(path).slice(1).toLowerCase();
    const probe = await probeMedia(path);
    const entry: LibraryEntry = {
      fileId: record.fileId,
      itemKey: record.itemKey,
      title: identity.title,
      kind: identity.kind,
      libraryId: library.id,
      container: extension === "mkv" || extension === "mp4" || extension === "avi" ? extension : "unknown",
      videoCodec: probe.videoCodec,
      audioCodec: probe.audioCodec,
      audioTracks: probe.audioTracks,
      sizeBytes: info.size,
      subtitles: [],
    };
    await container.resolve(SERVING_CAPABILITY).invoke("register-entry", entry as unknown as Record<string, unknown>);
  };

  const removeCatalogRecord = async (fileId: string): Promise<void> => {
    if (!container.hasProviders(SERVING_CAPABILITY)) return;
    try {
      await container.resolve(SERVING_CAPABILITY).invoke("remove-entry", { fileId });
    } catch (err) {
      if (!/not_found|unknown fileId/.test((err as Error).message)) throw err;
    }
  };

  const libraryService = new LibraryService({
    bus,
    libraries,
    mediaCatalog,
    onCatalogUpsert: (record, library) => registerCatalogRecord(record, library, true),
    onCatalogRemove: removeCatalogRecord,
  });

  // Register core capability providers so plugins' requires can resolve.
  container.register({
    pluginId: "core",
    capability: "dev.tantalar.capability.event.emit",
    invoke: async () => ({ ok: true }), // emit flows through the control channel instead
  });
  container.register({
    pluginId: "core",
    capability: "dev.tantalar.capability.secret.resolve",
    invoke: async (operation, payload) => {
      if (operation !== "resolve") throw new Error("unknown secret operation");
      const requester = String(payload.requesterPluginId ?? "");
      if (requester !== "dev.tantalar.plugin.usenet-native" && requester !== "dev.tantalar.plugin.metadata-tmdb-tvdb") {
        throw new Error("secret access denied");
      }
      const value = await secrets.get(requester, String(payload.ref ?? ""));
      if (value === null) throw new Error("secret is unavailable");
      return { value };
    },
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
      const key = String(payload.api_key ?? payload.apiKey ?? "");
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
        const packageDirectory = manifest.id === MCP_PLUGIN_ID
          ? "mcp-server"
          : (manifest.id.split(".").pop() ?? "");
        const pkgRoot = resolve(options.pluginRoot ?? process.cwd(), "plugins", packageDirectory);
        resolved = join(pkgRoot, resolved);
      }
      return {
        command: cmd ?? "node",
        args: [...(manifest.entry.args ?? []), resolved],
        env: {},
      };
    },
  });

  container.register({
    pluginId: "core",
    capability: CapabilityNames.McpActivityRead,
    invoke: async (operation, payload) => {
      if (operation !== "query") throw new Error("unknown MCP activity operation");
      const limit = Math.min(200, Math.max(1, Number(payload.limit ?? 50)));
      return {
        events: await bus.read({
          limit,
          ...(typeof payload.afterEventId === "string" ? { afterEventId: payload.afterEventId } : {}),
        }),
      };
    },
  });
  container.register({
    pluginId: "core",
    capability: CapabilityNames.McpOperationRead,
    invoke: async (operation) => {
      if (operation !== "health" && operation !== "status") throw new Error("unknown MCP operation status request");
      return {
        plugins: supervisor.list().map((runtime) => ({
          id: runtime.manifest.id,
          state: runtime.state,
          restartCount: runtime.restartCount,
        })),
      };
    },
  });
  container.register({
    pluginId: "core",
    capability: CapabilityNames.McpConfigRead,
    invoke: async (operation) => {
      if (operation !== "inspect") throw new Error("unknown MCP config inspection request");
      return { yaml: dumpConfig(loaded.config as Record<string, unknown>) };
    },
  });

  let listening = false;
  let serverApp: Awaited<ReturnType<typeof buildServer>> | null = null;
  const pluginsCfg = loaded.config.plugins as {
    set?: Record<string, { enabled?: boolean; manifestPath?: string; config?: Record<string, unknown> }>;
    requiredCapabilities?: string[];
  };
  const desiredPlugins: PluginSet = structuredClone(pluginsCfg.set ?? {});
  for (const name of ["usenet-native", "torrent-native"]) {
    const plugin = desiredPlugins[`dev.tantalar.plugin.${name}`];
    if (!plugin?.enabled) continue;
    const config = plugin.config ?? {};
    if (!Array.isArray(config.downloadRoots) || config.downloadRoots.length === 0) {
      const root = join(runtimeDataDir, "downloads", name === "usenet-native" ? "usenet" : "torrent");
      await mkdir(root, { recursive: true });
      desiredPlugins[`dev.tantalar.plugin.${name}`] = { ...plugin, config: { ...config, downloadRoots: [root] } };
    }
  }
  if (configuredMcp !== undefined) {
    desiredPlugins[MCP_PLUGIN_ID] = {
      enabled: true,
      manifestPath: desiredPlugins[MCP_PLUGIN_ID]?.manifestPath ?? MCP_MANIFEST_PATH,
      config: structuredClone(configuredMcp as Record<string, unknown>),
    };
  }
  const persistedMcp = await db
    .selectFrom("plugin_state")
    .selectAll()
    .where("pluginId", "=", MCP_PLUGIN_ID)
    .executeTakeFirst();
  if (persistedMcp?.desiredConfig != null) {
    try {
      desiredPlugins[MCP_PLUGIN_ID] = {
        enabled: persistedMcp.enabled === 1,
        manifestPath: persistedMcp.installedSource ?? desiredPlugins[MCP_PLUGIN_ID]?.manifestPath ?? MCP_MANIFEST_PATH,
        config: decodeMcpDesiredConfig(persistedMcp.desiredConfig),
      };
    } catch {
      log.warn({ pluginId: MCP_PLUGIN_ID }, "stored MCP configuration is invalid; using file configuration");
    }
  }
  pluginsCfg.set = desiredPlugins;
  const lifecycle = new PluginLifecycleManager({
    supervisor,
    basePath: options.pluginRoot ?? process.cwd(),
  });

  const getMcpDesiredConfig = (): Record<string, unknown> =>
    structuredClone(desiredPlugins[MCP_PLUGIN_ID]?.config ?? MCP_DEFAULT_CONFIG);

  const applyMcpDesiredConfig = async (config: Record<string, unknown>) => {
    const previousEntry = desiredPlugins[MCP_PLUGIN_ID];
    const wasMounted = Boolean(supervisor.get(MCP_PLUGIN_ID));
    const nextEntry: PluginSetEntry = {
      enabled: true,
      manifestPath: previousEntry?.manifestPath ?? MCP_MANIFEST_PATH,
      config: structuredClone(config),
    };
    let runtime;
    let runtimeChanged = false;
    try {
      if (wasMounted) {
        runtime = await supervisor.reconfigure(MCP_PLUGIN_ID, nextEntry.config ?? {});
        runtimeChanged = true;
      } else {
        const result = await lifecycle.apply({ ...desiredPlugins, [MCP_PLUGIN_ID]: nextEntry });
        const failed = result.failed.find((entry) => entry.pluginId === MCP_PLUGIN_ID);
        if (failed) throw new Error(failed.error);
        runtime = supervisor.get(MCP_PLUGIN_ID);
        if (!runtime || runtime.state !== "healthy") throw new Error("MCP plugin did not reach healthy state");
        runtimeChanged = true;
      }

      await db
        .insertInto("plugin_state")
        .values({
          pluginId: MCP_PLUGIN_ID,
          state: runtime.state,
          restartCount: runtime.restartCount,
          updatedAt: new Date().toISOString(),
          installedSource: nextEntry.manifestPath ?? MCP_MANIFEST_PATH,
          enabled: 1,
          capabilitiesSnapshot: JSON.stringify(runtime.manifest.provides),
          desiredConfig: JSON.stringify(nextEntry.config ?? {}),
        })
        .onConflict((conflict) => conflict.column("pluginId").doUpdateSet({
          state: runtime!.state,
          restartCount: runtime!.restartCount,
          updatedAt: new Date().toISOString(),
          installedSource: nextEntry.manifestPath ?? MCP_MANIFEST_PATH,
          enabled: 1,
          capabilitiesSnapshot: JSON.stringify(runtime!.manifest.provides),
          desiredConfig: JSON.stringify(nextEntry.config ?? {}),
        }))
        .execute();
      desiredPlugins[MCP_PLUGIN_ID] = nextEntry;
      return runtime;
    } catch (error) {
      if (!runtimeChanged) throw error;
      let rolledBack = false;
      try {
        if (!wasMounted) {
          if (supervisor.get(MCP_PLUGIN_ID)) await supervisor.unmount(MCP_PLUGIN_ID);
          rolledBack = supervisor.get(MCP_PLUGIN_ID) === undefined;
        } else if (supervisor.get(MCP_PLUGIN_ID)) {
          const restored = await supervisor.reconfigure(
            MCP_PLUGIN_ID,
            previousEntry?.config ?? MCP_DEFAULT_CONFIG,
          );
          rolledBack = restored.state === "healthy";
        }
      } catch {
        rolledBack = false;
      }
      const failure = error instanceof Error ? error : new Error(String(error));
      throw Object.assign(failure, { rolledBack });
    }
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

  let stopLibraryJobs: (() => Promise<void>) | undefined;
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
        library: libraryService,
        indexerSettings,
        // Wave 9 (TAN-030–043): operations surface — queue, plugin
        // management, users, API keys, webhooks, backup/restore,
        // diagnostics. sqlitePath present only on the SQLite dialect.
        ops: {
          scheduler,
          auth,
          db,
          bus,
          supervisor,
          container,
          ready: () => readiness().ready,
          readiness,
          ...(dialect === "sqlite" && typeof sqlitePath === "string" ? { sqlitePath } : {}),
          dataDir: resolve(sqlitePath ?? "./data", ".."),
          secrets,
          mcp: {
            getDesiredConfig: getMcpDesiredConfig,
            applyDesiredConfig: applyMcpDesiredConfig,
          },
        },
        // Phase 5A serving surface: routes exist whenever the serving
        // capability has a provider (standard install mounts it). Core
        // re-checks path containment; fileId→path resolution comes from the
        // durable media catalog so unresolvable ids return 404.
        ...(container.hasProviders(SERVING_CAPABILITY)
          ? {
              serving: (invoke): ServingDeps => ({
                invoke,
                requireAuth: null as never, // filled in by buildServer (see http.ts)
                resolvePath: async (fileId) => {
                  const record = await mediaCatalog.get(fileId);
                  if (!record) return null;
                  const library = await libraries.get(record.libraryId);
                  return library?.enabled ? record.path : null;
                },
                mediaRoots: async () =>
                  (await libraries.list()).filter((library) => library.enabled).map((library) => library.rootPath),
                hlsRoot,
                resolveSegmentPath: (sessionId, fileName) => {
                  if (!/^[A-Za-z0-9-]+$/.test(sessionId) || !/^[A-Za-z0-9._-]+$/.test(fileName)) return null;
                  const sessionRoot = resolve(hlsRoot, sessionId);
                  const candidate = resolve(sessionRoot, fileName);
                  return candidate.startsWith(sessionRoot + sep) ? candidate : null;
                },
                resolveLibraryAccess: async (userId, isAdmin) => {
                  const enabled = (await libraries.list()).filter((library) => library.enabled).map((library) => library.id);
                  if (isAdmin) return enabled;
                  const row = await db
                    .selectFrom("ui_preferences")
                    .select("preferences")
                    .where("userId", "=", `libaccess:${userId}`)
                    .executeTakeFirst();
                  if (!row) return [];
                  try {
                    const parsed = JSON.parse(row.preferences) as { libraryIds?: unknown };
                    const allowed = new Set(enabled);
                    return Array.isArray(parsed.libraryIds)
                      ? parsed.libraryIds.map(String).filter((libraryId) => allowed.has(libraryId))
                      : [];
                  } catch {
                    return [];
                  }
                },
              }),
            }
          : {}),
      });
      const serverCfg = loaded.config.server as { host: string; port: number };
      const addr = await app.listen({ port: port ?? serverCfg.port, host: host ?? serverCfg.host });
      serverApp = app;
      listening = true;
      await bus.publish({ type: EventTypes.ServerBooted, producer: "core", payload: { addr } });
      return addr;
    },
    async shutdown() {
      listening = false;
      if (serverApp) {
        const app = serverApp;
        // Allow active replies to drain, then close unused or stalled sockets.
        // A connected client that sends no request must not block shutdown.
        const forceClose = setTimeout(() => app.server.closeAllConnections(), 5_000);
        forceClose.unref();
        try { await app.close(); } finally { clearTimeout(forceClose); }
      }
      serverApp = null;
      scheduler.stop();
      await stopLibraryJobs?.();
      await scheduler.drain();
      await supervisor.stopAll();
      await db.destroy();
    },
  };

  // Mount config-declared enabled plugins through the documented lifecycle
  // manager (manifest loader + validation), never a raw dynamic import.
  // Mount completion is NOT capability readiness — /readyz checks the
  // required capabilities via kernel.readiness().
  if (!options.skipConfigPlugins) {
    const result = await lifecycle.apply(desiredPlugins);
    for (const f of result.failed) {
      log.error({ pluginId: f.pluginId, err: f.error }, "plugin mount failed");
    }
  }

  if (container.hasProviders(SERVING_CAPABILITY)) {
    await container.resolve(SERVING_CAPABILITY).invoke("configure", {
      segmentsDir: hlsRoot,
      ffmpegCommand: process.env["TANTALAR_FFMPEG_COMMAND"] ?? "ffmpeg",
      qualityLadder: ["1280x720"],
      ffmpegArgs: DEFAULT_HLS_FFMPEG_ARGS,
    });
    for (const library of await libraries.list()) {
      for (const record of await mediaCatalog.listByLibrary(library.id)) {
        try {
          await registerCatalogRecord(record, library);
        } catch (err) {
          log.warn({ fileId: record.fileId, err }, "catalog entry not restored into serving");
        }
      }
    }
  }

  const downloadJobs = new DownloadJobStore(db);
  const importCompletedDownload = async (job: DownloadJobRecord, provider: CapabilityProvider): Promise<string> => {
    const response = await provider.invoke("completed-files", { downloadId: job.providerJobId });
    const rows = (response as { files?: unknown[] } | null)?.files ?? [];
    const files = rows.flatMap((value) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return [];
      const row = value as Record<string, unknown>;
      return typeof row.path === "string" && row.path.length > 0 && typeof row.sizeBytes === "number" && Number.isFinite(row.sizeBytes)
        ? [{ path: row.path, sizeBytes: Math.max(0, row.sizeBytes) }]
        : [];
    }).filter((file) => /\.(mkv|mp4|m4v|avi|mov|ts)$/i.test(file.path));
    // ponytail: one job maps to its largest video file; add batch mapping when multi-episode releases are supported.
    const source = files.sort((a, b) => b.sizeBytes - a.sizeBytes)[0];
    if (!source) throw new Error("completed download has no supported video file");

    const seriesMatch = /^(.*):(S(\d{2,3})E(\d{2,4}))$/.exec(job.itemKey);
    const kind = seriesMatch ? "series" : "movie";
    const managedId = seriesMatch?.[1] ?? job.itemKey;
    const managed = await container.resolve(kind === "movie"
      ? "dev.tantalar.capability.automation.movies"
      : "dev.tantalar.capability.automation.series").invoke(kind === "movie" ? "get-movie" : "get-series", kind === "movie"
      ? { movieId: managedId }
      : { seriesId: managedId }) as Record<string, unknown>;
    const destinationLibraryId = String(managed.destinationLibraryId ?? "");
    const library = destinationLibraryId ? await libraries.get(destinationLibraryId) : null;
    if (!library?.enabled || (library.kind !== "mixed" && library.kind !== kind)) {
      throw new Error("managed item has no enabled destination library");
    }
    return libraryService.exclusive(library.id, async () => {
    const title = String(kind === "movie" ? managed.title ?? "" : managed.name ?? "");
    if (!title) throw new Error("managed item has no title");
    const episodeKey = seriesMatch?.[2];
    const episodeTitle = episodeKey
      ? String(((managed.episodes as Array<Record<string, unknown>> | undefined)?.find((episode) => episode.episodeKey === episodeKey)?.title) ?? episodeKey)
      : title;
    const importer = container.resolve(CapabilityNames.Importer);
    if (importer.pluginId === "dev.tantalar.plugin.library") {
      const configuredSources = desiredPlugins[importer.pluginId]?.config?.sourceRoots;
      const sourceRoots: string[] = Array.isArray(configuredSources) ? configuredSources.filter((value): value is string => typeof value === "string") : [];
      const engineCapability = provider.pluginId === "dev.tantalar.plugin.usenet-native"
        ? "dev.tantalar.capability.usenet.engine"
        : provider.pluginId === "dev.tantalar.plugin.torrent-native" ? "dev.tantalar.capability.torrent.engine" : null;
      if (engineCapability) {
        const config = await container.resolveProvider(engineCapability, provider.pluginId).invoke("configuration-status", {}) as { downloadRoots?: string[] };
        sourceRoots.push(...(config.downloadRoots ?? []));
      }
      await importer.invoke("configure-roots", {
        importRoots: (await libraries.list()).filter(item => item.enabled).map(item => item.rootPath),
        sourceRoots,
      });
    }
    const previous = await mediaCatalog.listByLibrary(library.id);
    const installed = previous.filter(file => file.itemKey === job.itemKey).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
    if (installed && container.hasProviders(SERVING_CAPABILITY)) {
      const { sessions } = await container.resolve(SERVING_CAPABILITY).invoke("playback-sessions", {}) as { sessions: Array<{ fileId: string; endedAt?: unknown }> };
      if (sessions.some(session => session.fileId === installed.fileId && !session.endedAt)) throw new Error("Replacement deferred while the installed file is playing.");
    }
    if (installed && importer.pluginId === "dev.tantalar.plugin.library") {
      await importer.invoke("register-existing", { itemKey: job.itemKey, path: installed.path, quality: installed.quality });
    }
    const result = await importer.invoke("import", {
      itemKey: job.itemKey,
      sourcePath: source.path,
      destinationRoot: library.rootPath,
      quality: parseQualityLabel(job.title),
      title: episodeTitle,
      kind,
      ...(kind === "series" ? {
        series: title,
        season: Number(seriesMatch![3]),
        episode: Number(seriesMatch![4]),
      } : typeof managed.year === "number" ? { year: Math.trunc(managed.year) } : {}),
      ...(job.correlationId ? { correlationId: job.correlationId } : {}),
    }) as ImportResult;
    if (
      result?.itemKey !== job.itemKey ||
      !result.destinationPath ||
      !result.sourceHash ||
      !/^[a-f0-9]{64}$/.test(result.sourceHash) ||
      !["hardlink", "copy", "existing"].includes(result.method)
    ) {
      throw new Error("importer returned an invalid result");
    }
    const libraryRoot = await realpath(library.rootPath);
    const destinationPath = await realpath(result.destinationPath);
    if (destinationPath !== libraryRoot && !destinationPath.startsWith(libraryRoot + sep)) {
      throw new Error("importer destination escapes its library root");
    }
    const catalog = await mediaCatalog.put({
      libraryId: library.id,
      itemKey: job.itemKey,
      path: destinationPath,
      quality: parseQualityLabel(job.title),
      method: result.method,
      sourceHash: result.sourceHash,
    });
    await registerCatalogRecord(catalog.record, library);
    await container.resolve(kind === "movie"
      ? "dev.tantalar.capability.automation.movies"
      : "dev.tantalar.capability.automation.series").invoke("mark-acquired", kind === "movie"
      ? { movieId: managedId, guid: `file:${catalog.record.fileId}` }
      : { seriesId: managedId, episodeKey });
    if (installed && installed.fileId !== catalog.record.fileId) {
      await removeCatalogRecord(installed.fileId);
      await db.deleteFrom("media_catalog").where("fileId", "=", installed.fileId).execute();
    }
    return destinationPath;
    });
  };
  await scheduler.declareJob("core", "download-sync", "every 2s", async () => {
    await syncDownloadJobs(downloadJobs, container, importCompletedDownload);
  }, { name: "Download and import reconciliation", scope: "All downloads", protected: true, successRetention: 30 });
  const releaseDecisions = new ReleaseDecisionStore(db);
  const qualitySettings = new QualitySettings(db);
  await scheduler.declareJob("core", "wanted-search", "every 15m", async ({ runId }) => {
    const result = await runAutomaticAcquisition(container, releaseDecisions, downloadJobs, bus, 20, runId, qualitySettings, documents);
    return { state: result.failed ? "partial" : result.eligible ? "succeeded" : "skipped", outcome: `${result.searched} searched, ${result.grabbed} grabbed, ${result.skipped} skipped, ${result.failed} failed.`, counts: result };
  }, { name: "Missing media search", scope: "Monitored movies and episodes", resource: "acquisition-search" });
  await scheduler.declareJob("core", "upgrade-search", "every 6h", ({ runId }) => runUpgradeSearch(db, container, downloadJobs, releaseDecisions, bus, qualitySettings, runId),
    { name: "Quality upgrade search", scope: "Installed, monitored movies and episodes", resource: "acquisition-search" });

  stopLibraryJobs = await registerLibraryJobs(scheduler, libraryService, container, bus, db);
  scheduler.start((err) => log.error({ err }, "scheduler tick failed"));
  return kernel;
}

export { dumpConfig };
