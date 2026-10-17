import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CapabilityNames, EventTypes } from "@tantalar/contracts";
import { sql } from "kysely";
import { boot, decodeMcpDesiredConfig, DEFAULT_HLS_FFMPEG_ARGS, type Kernel } from "../apps/server/src/kernel.js";

let kernel: Kernel;
let dir: string;
let address = "";

async function availablePort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
  return port;
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "tantalar-kernel-"));
  // Standard install: default first-party plugin set mounts from the repo
  // root; the required capabilities must be present before /readyz is 200.
  kernel = await boot({
    env: {},
    cliOverrides: {
      server: { port: 0 },
      database: { dialect: "sqlite", sqlite: { path: join(dir, "boot.db") } },
    },
  });
  address = await kernel.listen("127.0.0.1", 0);
});

afterAll(async () => {
  await kernel.shutdown();
});

describe("kernel boot sequence (config -> migrate -> log -> container -> supervisor -> HTTP)", () => {
  it("initializes native download directories beside the active database", async () => {
    const status = await kernel.container.resolve("dev.tantalar.capability.usenet.engine").invoke("configuration-status", {}) as { downloadRoots: string[] };
    expect(status.downloadRoots).toEqual([join(dir, "downloads", "usenet")]);
    const plugins = kernel.config.config.plugins as { set: Record<string, { config?: { downloadRoots?: string[] } }> };
    expect(plugins.set["dev.tantalar.plugin.torrent-native"]?.config?.downloadRoots).toEqual([join(dir, "downloads", "torrent")]);
  });
  it("decodes MCP desired config from SQLite TEXT and PostgreSQL JSONB", () => {
    const expected = { http: { bind: "::1", port: 8642 } };
    expect(decodeMcpDesiredConfig(JSON.stringify(expected))).toEqual(expected);
    expect(decodeMcpDesiredConfig(expected)).toEqual(expected);
    expect(() => decodeMcpDesiredConfig([])).toThrow(/must be an object/);
  });

  it("mounts an explicit top-level MCP config and gives persisted desired state precedence", async () => {
    const databasePath = join(dir, "mcp-config-precedence.db");
    const fileConfiguration = {
      http: { enabled: false, bind: "127.0.0.1", port: 19101, tlsViaProxy: false },
      mutatingToolsEnabled: false,
      limits: { timeoutMs: 5_000, maxResultBytes: 65_536, rateLimitPerMinute: 120 },
    };
    const readDesiredMcp = (target: Kernel) => {
      const plugins = target.config.config.plugins as {
        set?: Record<string, { config?: Record<string, unknown> }>;
      };
      return plugins.set?.["dev.tantalar.plugin.mcp"]?.config;
    };
    const configured = await boot({
      env: {},
      cliOverrides: {
        server: { port: 0 },
        database: { dialect: "sqlite", sqlite: { path: databasePath } },
        mcp: fileConfiguration,
      },
    });
    const persistedConfiguration = {
      ...fileConfiguration,
      http: { ...fileConfiguration.http, port: 19102 },
    };
    try {
      expect(configured.supervisor.get("dev.tantalar.plugin.mcp")?.state).toBe("healthy");
      expect(readDesiredMcp(configured)).toEqual(fileConfiguration);
      await configured.db
        .insertInto("plugin_state")
        .values({
          pluginId: "dev.tantalar.plugin.mcp",
          state: "healthy",
          restartCount: 0,
          updatedAt: new Date().toISOString(),
          installedSource: "plugins/mcp-server/manifest.json",
          enabled: 1,
          capabilitiesSnapshot: JSON.stringify(["dev.tantalar.capability.mcp.status"]),
          desiredConfig: JSON.stringify(persistedConfiguration),
        })
        .execute();
    } finally {
      await configured.shutdown();
    }

    const restarted = await boot({
      env: {},
      cliOverrides: {
        server: { port: 0 },
        database: { dialect: "sqlite", sqlite: { path: databasePath } },
        mcp: { ...fileConfiguration, http: { ...fileConfiguration.http, port: 19103 } },
      },
    });
    try {
      expect(restarted.supervisor.get("dev.tantalar.plugin.mcp")?.state).toBe("healthy");
      expect(readDesiredMcp(restarted)).toEqual(persistedConfiguration);
    } finally {
      await restarted.shutdown();
    }
  }, 30_000);

  it("introspects production API keys through the canonical wire field", async () => {
    const { key } = await kernel.auth.createApiKey("mcp-runtime", ["events.read"]);
    const result = await kernel.container
      .resolve(CapabilityNames.AuthIntrospection)
      .invoke("introspect", { api_key: key }) as { valid: boolean; scopes: string[] };
    expect(result).toMatchObject({ valid: true, scopes: ["events.read"] });
  });

  it("persists transport disablement and reports a successful runtime rollback", async () => {
    await kernel.auth.createUser("mcp-admin", "password-mcp-admin-1", "admin");
    const login = await fetch(`${address}/api/v1/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "mcp-admin", password: "password-mcp-admin-1" }),
    });
    const cookie = (login.headers.getSetCookie?.() ?? [])
      .map((value) => value.split(";")[0])
      .find((value) => value.startsWith("tantalar_session=")) ?? "";
    const csrf = ((await login.json()) as { csrfToken: string }).csrfToken;
    const headers = {
      "content-type": "application/json",
      cookie: `${cookie}; tantalar_csrf=${csrf}`,
      "x-csrf-token": csrf,
    };
    const configuration = {
      http: { enabled: false, bind: "127.0.0.1", port: 18652, tlsViaProxy: false },
      mutatingToolsEnabled: false,
      limits: { timeoutMs: 5_000, maxResultBytes: 65_536, rateLimitPerMinute: 120 },
    };

    const applied = await fetch(`${address}/api/v1/mcp/config`, {
      method: "PUT",
      headers,
      body: JSON.stringify(configuration),
    });
    expect(applied.status).toBe(200);
    expect(await applied.json()).toMatchObject({
      saved: true,
      status: { mounted: true, activeTransport: "Disabled", endpoint: null, configuration },
    });

    await sql.raw(`
      CREATE TRIGGER fail_mcp_state_write
      BEFORE INSERT ON plugin_state
      WHEN NEW.plugin_id = 'dev.tantalar.plugin.mcp'
      BEGIN
        SELECT RAISE(FAIL, 'forced MCP state persistence failure');
      END
    `).execute(kernel.db);
    try {
      const failed = await fetch(`${address}/api/v1/mcp/config`, {
        method: "PUT",
        headers,
        body: JSON.stringify({ ...configuration, http: { ...configuration.http, port: 18653 } }),
      });
      expect(failed.status).toBe(409);
      expect(await failed.json()).toMatchObject({ rolledBack: true });
      expect(kernel.supervisor.get("dev.tantalar.plugin.mcp")?.state).toBe("healthy");

      const restored = await fetch(`${address}/api/v1/mcp/status`, { headers: { cookie } });
      expect(await restored.json()).toMatchObject({
        mounted: true,
        activeTransport: "Disabled",
        configuration,
      });
    } finally {
      await sql.raw("DROP TRIGGER IF EXISTS fail_mcp_state_write").execute(kernel.db);
      if (kernel.supervisor.get("dev.tantalar.plugin.mcp")) {
        await kernel.supervisor.unmount("dev.tantalar.plugin.mcp");
      }
      await kernel.db.deleteFrom("plugin_state").where("pluginId", "=", "dev.tantalar.plugin.mcp").execute();
    }
  }, 30_000);

  it("enforces and classifies the MCP administration routes without auditing keys", async () => {
    const signIn = async (username: string, password: string) => {
      const response = await fetch(`${address}/api/v1/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      expect(response.status).toBe(200);
      const cookie = (response.headers.getSetCookie?.() ?? [])
        .map((value) => value.split(";")[0])
        .find((value) => value.startsWith("tantalar_session=")) ?? "";
      const csrf = ((await response.json()) as { csrfToken: string }).csrfToken;
      return { cookie, csrf };
    };

    expect((await fetch(`${address}/api/v1/mcp/status`)).status).toBe(401);
    expect((await fetch(`${address}/api/v1/mcp/test`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ apiKey: "not-authorized" }),
    })).status).toBe(401);

    await kernel.auth.createUser("mcp-route-viewer", "password-mcp-viewer-1", "viewer");
    const viewer = await signIn("mcp-route-viewer", "password-mcp-viewer-1");
    expect((await fetch(`${address}/api/v1/mcp/status`, { headers: { cookie: viewer.cookie } })).status).toBe(403);

    const adminName = "mcp-route-admin";
    await kernel.auth.createUser(adminName, "password-mcp-route-1", "admin");
    const admin = await signIn(adminName, "password-mcp-route-1");
    const mutationHeaders = {
      "content-type": "application/json",
      cookie: `${admin.cookie}; tantalar_csrf=${admin.csrf}`,
      "x-csrf-token": admin.csrf,
    };
    const pluginPort = await availablePort();
    const configuration = {
      http: { enabled: true, bind: "127.0.0.1", port: pluginPort, tlsViaProxy: false },
      mutatingToolsEnabled: false,
      limits: { timeoutMs: 5_000, maxResultBytes: 65_536, rateLimitPerMinute: 120 },
    };

    expect((await fetch(`${address}/api/v1/mcp/config`, {
      method: "PUT",
      headers: { "content-type": "application/json", cookie: admin.cookie },
      body: JSON.stringify(configuration),
    })).status).toBe(403);
    expect((await fetch(`${address}/api/v1/mcp/test`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: admin.cookie },
      body: JSON.stringify({ apiKey: "csrf-probe" }),
    })).status).toBe(403);

    const unsafeBind = await fetch(`${address}/api/v1/mcp/config`, {
      method: "PUT",
      headers: mutationHeaders,
      body: JSON.stringify({
        ...configuration,
        http: { enabled: true, bind: "0.0.0.0", port: pluginPort, tlsViaProxy: false },
      }),
    });
    expect(unsafeBind.status).toBe(400);
    expect(await unsafeBind.json()).toMatchObject({ code: "unsafe_bind" });

    const invalidConfig = await fetch(`${address}/api/v1/mcp/config`, {
      method: "PUT",
      headers: mutationHeaders,
      body: JSON.stringify({
        ...configuration,
        http: { ...configuration.http, bind: "invalid bind" },
      }),
    });
    expect(invalidConfig.status).toBe(400);
    expect(await invalidConfig.json()).toMatchObject({ code: "invalid_configuration" });

    const fakeMode = { current: "missing_scope" as "missing_scope" | "protocol" };
    const fakeServer = createHttpServer((request, response) => {
      request.resume();
      response.writeHead(200, { "content-type": "application/json" });
      if (fakeMode.current === "missing_scope") {
        response.end(JSON.stringify({ jsonrpc: "2.0", id: "initialize", error: { message: "insufficient scope" } }));
      } else {
        response.end("not-json");
      }
    });

    const validKey = await kernel.auth.createApiKey("mcp-route-success", ["events.read"]);
    const invalidKey = "tantalar_route_secret_should_not_appear";
    try {
      const applied = await fetch(`${address}/api/v1/mcp/config`, {
        method: "PUT",
        headers: mutationHeaders,
        body: JSON.stringify(configuration),
      });
      expect(applied.status).toBe(200);

      const success = await fetch(`${address}/api/v1/mcp/test`, {
        method: "POST",
        headers: mutationHeaders,
        body: JSON.stringify({ apiKey: validKey.key }),
      });
      const successBody = await success.json() as {
        ok: boolean;
        code: string | null;
        checks: Array<{ name: string; ok: boolean }>;
        tools: Array<{ name: string }>;
      };
      expect(successBody).toMatchObject({
        ok: true,
        code: null,
        checks: [
          { name: "initialize", ok: true },
          { name: "ping", ok: true },
          { name: "tools/list", ok: true },
        ],
      });
      expect(successBody.tools).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: "dev.tantalar.mcp.health" }),
        expect.objectContaining({ name: "dev.tantalar.mcp.activity.query" }),
      ]));

      const authentication = await fetch(`${address}/api/v1/mcp/test`, {
        method: "POST",
        headers: mutationHeaders,
        body: JSON.stringify({ apiKey: invalidKey }),
      });
      expect(await authentication.json()).toMatchObject({ ok: false, code: "authentication", checks: [] });

      await new Promise<void>((resolveListen, reject) => {
        fakeServer.once("error", reject);
        fakeServer.listen(0, "127.0.0.1", resolveListen);
      });
      const fakePort = (fakeServer.address() as { port: number }).port;
      const fakeConfiguration = {
        ...configuration,
        http: { ...configuration.http, clientEndpoint: `http://127.0.0.1:${fakePort}/` },
      };
      expect((await fetch(`${address}/api/v1/mcp/config`, {
        method: "PUT",
        headers: mutationHeaders,
        body: JSON.stringify(fakeConfiguration),
      })).status).toBe(200);

      const missingScope = await fetch(`${address}/api/v1/mcp/test`, {
        method: "POST",
        headers: mutationHeaders,
        body: JSON.stringify({ apiKey: invalidKey }),
      });
      expect(await missingScope.json()).toMatchObject({ ok: false, code: "missing_scope", checks: [] });

      fakeMode.current = "protocol";
      const protocol = await fetch(`${address}/api/v1/mcp/test`, {
        method: "POST",
        headers: mutationHeaders,
        body: JSON.stringify({ apiKey: invalidKey }),
      });
      expect(await protocol.json()).toMatchObject({ ok: false, code: "protocol", checks: [] });

      fakeServer.closeAllConnections();
      await new Promise<void>((resolveClose, reject) => fakeServer.close((error) => error ? reject(error) : resolveClose()));
      const transport = await fetch(`${address}/api/v1/mcp/test`, {
        method: "POST",
        headers: mutationHeaders,
        body: JSON.stringify({ apiKey: invalidKey }),
      });
      expect(await transport.json()).toMatchObject({ ok: false, code: "transport", checks: [] });

      const auditRows = await kernel.db
        .selectFrom("audit_log")
        .select(["action", "detail"])
        .where("actorUsername", "=", adminName)
        .execute();
      const actions = auditRows.map((row) => row.action);
      expect(actions.filter((action) => action === "mcp.configuration.rejected")).toHaveLength(2);
      expect(actions).toContain("mcp.configuration.applied");
      expect(actions.filter((action) => action === "mcp.connection.tested")).toHaveLength(5);
      const rejectedCodes = auditRows
        .filter((row) => row.action === "mcp.configuration.rejected")
        .map((row) => (JSON.parse(row.detail) as { code: string }).code)
        .sort();
      expect(rejectedCodes).toEqual(["invalid_configuration", "unsafe_bind"]);
      const connectionDetails = auditRows
        .filter((row) => row.action === "mcp.connection.tested")
        .map((row) => JSON.parse(row.detail) as { ok: boolean; code?: string; checks: number });
      expect(connectionDetails).toEqual(expect.arrayContaining([
        expect.objectContaining({ ok: true, checks: 3 }),
        expect.objectContaining({ ok: false, code: "authentication" }),
        expect.objectContaining({ ok: false, code: "missing_scope" }),
        expect.objectContaining({ ok: false, code: "protocol" }),
        expect.objectContaining({ ok: false, code: "transport" }),
      ]));
      const auditText = JSON.stringify(auditRows);
      expect(auditText).not.toContain(validKey.key);
      expect(auditText).not.toContain(invalidKey);

      const callEvents = await kernel.bus.read({ typePrefix: EventTypes.McpCall });
      const eventText = JSON.stringify(callEvents);
      expect(eventText).not.toContain(validKey.key);
      expect(eventText).not.toContain(invalidKey);
    } finally {
      if (fakeServer.listening) {
        fakeServer.closeAllConnections();
        await new Promise<void>((resolveClose) => fakeServer.close(() => resolveClose()));
      }
      if (kernel.supervisor.get("dev.tantalar.plugin.mcp")) {
        await kernel.supervisor.unmount("dev.tantalar.plugin.mcp");
      }
      await kernel.db.deleteFrom("plugin_state").where("pluginId", "=", "dev.tantalar.plugin.mcp").execute();
    }
  }, 60_000);

  it("bounds the default HLS worker's decoder, filter, encoder, and input rate", () => {
    const args = [...DEFAULT_HLS_FFMPEG_ARGS];
    expect(args).toContain("-re");
    expect(args.filter((arg) => arg === "-threads")).toHaveLength(2);
    expect(args).toEqual(expect.arrayContaining(["-filter_threads", "-filter_complex_threads", "-maxrate"]));
    for (const option of ["-threads", "-filter_threads", "-filter_complex_threads"]) {
      const indexes = args.flatMap((arg, index) => (arg === option ? [index] : []));
      for (const index of indexes) expect(args[index + 1]).toBe("2");
    }
  });

  it("boots the standard install and readiness reflects capability presence", async () => {
    const report = kernel.readiness();
    expect(report.ready).toBe(true);
    expect(report.missingCapabilities).toEqual([]);
    const res = await fetch(`${address}/readyz`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { ok: boolean }).ok).toBe(true);
    const healthz = await fetch(`${address.replace(/\/$/, "")}/healthz`);
    expect(healthz.status).toBe(200);
  });

  it("first-party modules mounted through the manifest loader are healthy", () => {
    const mounted = kernel.supervisor.list();
    const byId = new Map(mounted.map((p) => [p.manifest.id, p]));
    expect(byId.get("dev.tantalar.plugin.serving")?.state).toBe("healthy");
    expect(byId.get("dev.tantalar.plugin.fixture-indexer")?.state).toBe("healthy");
    expect(byId.get("dev.tantalar.plugin.library")?.state).toBe("healthy");
  });

  it("mounts the persistent indexer configuration API in a normal boot", async () => {
    const res = await fetch(`${address}/api/v1/indexers`);
    expect(res.status).toBe(401);
  });

  it("records a boot event in the append-only log", async () => {
    const booted = await kernel.bus.read({ typePrefix: "dev.tantalar.event.server.booted" });
    expect(booted.length).toBe(1);
  });

  it("discovers existing media, exposes it through the serving API, and restores it after restart", async () => {
    const configuredRoot = join(dir, "media");
    mkdirSync(configuredRoot, { recursive: true });
    const root = realpathSync(configuredRoot);
    const nested = join(root, "Movies");
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(nested, "Example.Movie.2026.mkv"), "synthetic video bytes");
    await kernel.auth.createUser("media-admin", "password-media-admin-1", "admin");
    const login = await fetch(`${address}/api/v1/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "media-admin", password: "password-media-admin-1" }),
    });
    const cookie = (login.headers.getSetCookie?.() ?? [])
      .map((value) => value.split(";")[0])
      .find((value) => value.startsWith("tantalar_session=")) ?? "";
    const csrf = ((await login.json()) as { csrfToken: string }).csrfToken;
    const mutationHeaders = {
      "content-type": "application/json",
      cookie: `${cookie}; tantalar_csrf=${csrf}`,
      "x-csrf-token": csrf,
    };
    const created = await fetch(`${address}/api/v1/libraries`, {
      method: "POST",
      headers: mutationHeaders,
      body: JSON.stringify({ name: "Existing media", rootPath: root, kind: "movie" }),
    });
    const libraryId = ((await created.json()) as { library: { id: string } }).library.id;
    const scanned = await fetch(`${address}/api/v1/libraries/${libraryId}/rescan`, {
      method: "POST",
      headers: mutationHeaders,
      body: "{}",
    });
    expect(await scanned.json()).toMatchObject({ checked: 1, discovered: 1, existing: 0, errors: [] });
    const beforeRestart = (await (await fetch(`${address}/api/v1/library`, { headers: { cookie } })).json()) as {
      items: Array<{ fileId: string; title: string; libraryId: string }>;
    };
    expect(beforeRestart.items).toEqual([
      expect.objectContaining({ title: "Example Movie", libraryId }),
    ]);
    const stream = await fetch(`${address}/api/v1/stream/${beforeRestart.items[0]?.fileId}`, { headers: { cookie } });
    expect(stream.status).toBe(200);
    expect(await stream.text()).toBe("synthetic video bytes");

    const restarted = await boot({
      env: {},
      cliOverrides: {
        server: { port: 0 },
        database: { dialect: "sqlite", sqlite: { path: join(dir, "boot.db") } },
      },
    });
    const restartedAddress = await restarted.listen("127.0.0.1", 0);
    const afterRestart = (await (await fetch(`${restartedAddress}/api/v1/library`, { headers: { cookie } })).json()) as {
      items: Array<{ title: string; libraryId: string }>;
    };
    expect(afterRestart.items).toEqual([
      expect.objectContaining({ title: "Example Movie", libraryId }),
    ]);
    await restarted.shutdown();
  });

  it("migrations are idempotent across boots on the same database", async () => {
    // Booting again against the same sqlite file must not fail.
    const k2 = await boot({
      env: {},
      skipConfigPlugins: true,
      cliOverrides: {
        server: { port: 0 },
        database: { dialect: "sqlite", sqlite: { path: join(dir, "boot.db") } },
        // No required capabilities in this probe boot: it only proves the
        // migrate path is idempotent.
        plugins: { set: {}, requiredCapabilities: [] } as never,
      },
    });
    await k2.shutdown();
  });

  it("a missing required capability fails readiness with detail (mount completion is not readiness)", async () => {
    const k3 = await boot({
      env: {},
      skipConfigPlugins: true,
      cliOverrides: {
        server: { port: 0 },
        database: { dialect: "sqlite", sqlite: { path: join(dir, "probe.db") } },
        plugins: {
          set: {},
          requiredCapabilities: ["dev.tantalar.capability.indexer"],
        } as never,
      },
    });
    const addr = await k3.listen("127.0.0.1", 0);
    const report = k3.readiness();
    expect(report.ready).toBe(false);
    expect(report.listening).toBe(true);
    expect(report.missingCapabilities).toEqual(["dev.tantalar.capability.indexer"]);
    const res = await fetch(`${addr}/readyz`);
    expect(res.status).toBe(503);
    const body = (await res.json()) as { missingCapabilities: string[] };
    expect(body.missingCapabilities).toEqual(["dev.tantalar.capability.indexer"]);
    await k3.shutdown();
  });

  it("--dump-config output is redacted and parseable as an input layer", async () => {
    const { loadConfig, dumpConfig, parseConfigYaml } = await import("@tantalar/config");
    const loaded = loadConfig({ env: { TANTALAR_SECRET_DATABASE__POSTGRES__URL: "postgres://u:secretpw@h/d" } });
    const dumped = dumpConfig(loaded.config);
    expect(dumped).not.toContain("secretpw");
    expect(dumped).toContain("[REDACTED]");
    // Redacted dump is still a structurally valid config layer.
    const reparsed = parseConfigYaml(dumped);
    expect(typeof reparsed).toBe("object");
  });

  it("default port is 8790 and TANTALAR-style config still overrides", async () => {
    const { loadConfig } = await import("@tantalar/config");
    const loaded = loadConfig({ env: {} });
    expect((loaded.config.server as { port: number }).port).toBe(8790);
    const overridden = loadConfig({
      cliOverrides: { server: { port: 9999 } },
    });
    expect((overridden.config.server as { port: number }).port).toBe(9999);
  });
});
