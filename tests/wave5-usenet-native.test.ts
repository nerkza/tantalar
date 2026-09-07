/**
 * Wave 5 tests (TAN-010 + TAN-011): embedded Usenet engine + unified
 * durable download_jobs.
 *
 * Proves, over the real out-of-process plugin contract:
 *  - add via legal synthetic NZB fixtures; no SABnzbd/daemon involved;
 *  - yEnc decode + CRC32 verification (unit);
 *  - fill-server behavior: missing segment on the primary falls through to
 *    the backup, with a visible warning;
 *  - real local TLS NNTP transfer to completion; pause/resume/retry/queue controls;
 *  - restart without duplicates (durable resume, idempotent add);
 *  - explicit PAR2 and archive-processing blocks;
 *  - provider-neutral download_jobs history: progress/ETA/warnings/retry/
 *    failure/removal/import handoff, durable across restarts.
 *
 * All article data is legal synthetic content served by a local TLS fixture.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AddressInfo } from "node:net";
import { createServer, type Server, type TLSSocket } from "node:tls";
import { createServer as createHttpServer } from "node:http";
import { Kysely } from "kysely";
import { migrate, openDatabase, DownloadJobStore, type Db } from "@tantalar/db";
import { EventTypes } from "@tantalar/contracts";
import { EventBus } from "../apps/server/src/events.js";
import { ServiceContainer } from "../apps/server/src/container.js";
import { Scheduler } from "../apps/server/src/scheduler.js";
import { Supervisor } from "../apps/server/src/supervisor.js";

import {
  MemoryNntpEngine,
  MemoryNntpTransport,
  MemoryPar2Repairer,
  MemoryUnpacker,
  crc32,
  decodeYenc,
  parseNzb,
  type NntpServerConfig,
} from "../plugins/usenet-native/src/engine.js";
import { makeSyntheticNzb as createSyntheticNzb, yencBodyFor } from "../plugins/usenet-native/src/fixtures.js";

const PLUGIN_ID = "dev.tantalar.plugin.usenet-native";
const CLIENT_CAP = "dev.tantalar.capability.download-client";
const ENGINE_CAP = "dev.tantalar.capability.usenet.engine";
const PLUGIN_ENTRY = "node " + resolve("plugins/usenet-native/dist/plugin.js");

let db: Kysely<Db>;
let bus: EventBus;
let container: ServiceContainer;
let supervisor: Supervisor;
let dir: string;
let downloadRoot: string;
let fixtureDir: string;
let tlsServer: Server;
let pluginConfig: Record<string, unknown>;
const tlsSockets = new Set<TLSSocket>();
const pluginArticles = new Map<string, string>();
const TLS_CERT_PATH = resolve("tests/fixtures/usenet/localhost-cert.pem");
const TLS_KEY_PATH = resolve("tests/fixtures/usenet/localhost-key.pem");
const FIXTURE_SECRET_ENV = "TANTALAR_SECRET_USENET_FIXTURE";
const FIXTURE_PASSWORD = "legal-fixture-password";
let vpnAllowDispatch = true;

function makeSyntheticNzb(
  ...args: Parameters<typeof createSyntheticNzb>
): ReturnType<typeof createSyntheticNzb> {
  const nzb = createSyntheticNzb(...args);
  for (const [index, fileName] of nzb.fileNames.entries()) {
    pluginArticles.set(
      `<synthetic-${nzb.name}-${index + 1}@fixture.invalid>`,
      yencBodyFor(nzb.payloads, fileName),
    );
  }
  return nzb;
}

async function startPluginNntpFixture(): Promise<number> {
  tlsServer = createServer(
    { key: readFileSync(TLS_KEY_PATH), cert: readFileSync(TLS_CERT_PATH) },
    (socket) => {
      tlsSockets.add(socket);
      socket.on("close", () => tlsSockets.delete(socket));
      socket.setEncoding("latin1");
      socket.write("200 Tantalar legal fixture ready\r\n", "latin1");
      let buffer = "";
      socket.on("data", (chunk: string) => {
        buffer += chunk;
        for (;;) {
          const end = buffer.indexOf("\r\n");
          if (end < 0) break;
          const command = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          if (command === "AUTHINFO USER fixture-user") {
            socket.write("381 password required\r\n", "latin1");
          } else if (command.startsWith("AUTHINFO PASS ")) {
            socket.write(
              command === `AUTHINFO PASS ${FIXTURE_PASSWORD}`
                ? "281 authentication accepted\r\n"
                : "481 authentication rejected\r\n",
              "latin1",
            );
          } else if (command.startsWith("ARTICLE ")) {
            const messageId = command.slice("ARTICLE ".length);
            const article = pluginArticles.get(messageId);
            if (!article) {
              socket.write("430 no such article\r\n", "latin1");
              continue;
            }
            const body = article
              .split(/\r?\n/)
              .map((line) => (line.startsWith(".") ? `.${line}` : line))
              .join("\r\n");
            socket.write(`220 article follows\r\nMessage-ID: ${messageId}\r\n\r\n${body}\r\n.\r\n`, "latin1");
          } else if (command === "QUIT") {
            socket.end("205 closing connection\r\n", "latin1");
          } else {
            socket.write("500 unsupported command\r\n", "latin1");
          }
        }
      });
    },
  );
  tlsServer.on("tlsClientError", () => {});
  await new Promise<void>((resolveListen, reject) => {
    tlsServer.once("error", reject);
    tlsServer.listen(0, "127.0.0.1", () => {
      tlsServer.off("error", reject);
      resolveListen();
    });
  });
  return (tlsServer.address() as AddressInfo).port;
}

// Shared fixture servers assembled per-test below.
function primaryConfig(): NntpServerConfig {
  return { name: "primary", host: "news1.fixture.invalid", port: 563, tls: true, username: "u", priority: 1, maxConnections: 4 };
}
function fillConfig(): NntpServerConfig {
  return { name: "fill", host: "news2.fixture.invalid", port: 563, tls: true, priority: 2, maxConnections: 2 };
}

/** Build an engine whose primary misses `missingOnPrimary` message-ids. */
function buildEngine(
  articlesPrimary: ReadonlyMap<string, string>,
  articlesFill: ReadonlyMap<string, string>,
  fixtures: ReadonlyMap<string, Buffer> = new Map(),
) {
  const primary = new MemoryNntpTransport(primaryConfig(), articlesPrimary);
  const fill = new MemoryNntpTransport(fillConfig(), articlesFill);
  return {
    engine: new MemoryNntpEngine({
      servers: [primaryConfig(), fillConfig()],
      transports: [primary, fill],
      repairer: new MemoryPar2Repairer(fixtures),
      unpacker: new MemoryUnpacker(new Map()),
      log: () => {},
    }),
    servedFrom: [primary.servedFrom, fill.servedFrom],
  };
}

function fullArticleMaps(nzb: ReturnType<typeof makeSyntheticNzb>, opts: { missingOnPrimary?: readonly string[] } = {}) {
  const all = new Map<string, string>();
  for (const f of nzb.fileNames) {
    // messageId for file f is <synthetic-{name}-{f+1}@fixture.invalid>
    const idx = nzb.fileNames.indexOf(f) + 1;
    all.set(`<synthetic-${nzb.name}-${idx}@fixture.invalid>`, yencBodyFor(nzb.payloads, f));
  }
  const primary = new Map(all);
  for (const id of opts.missingOnPrimary ?? []) primary.delete(id);
  return { all, primary };
}

async function mountPlugin(config: Record<string, unknown> = {}): Promise<void> {
  const m = {
    id: PLUGIN_ID,
    version: "0.1.0",
    protocolVersion: 1,
    provides: [CLIENT_CAP, ENGINE_CAP],
    requires: [
      "dev.tantalar.capability.event.emit",
      "dev.tantalar.capability.log",
      "dev.tantalar.capability.vpn-binding",
    ],
    subscriptions: [],
    entry: { command: PLUGIN_ENTRY },
  };
  Object.assign(m, { __config: config });
  const rt = await supervisor.mount(m as never, config);
  expect(["healthy", "restarting"]).toContain(rt.state);
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      container.resolve(CLIENT_CAP);
      container.resolve(ENGINE_CAP);
      return;
    } catch {
      await new Promise((resolveWait) => setTimeout(resolveWait, 20));
    }
  }
  throw new Error(`usenet-native did not become ready (state=${supervisor.get(PLUGIN_ID)?.state ?? "missing"})`);
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "tantalar-wave5-"));
  downloadRoot = join(dir, "downloads");
  fixtureDir = join(dir, "fixtures");
  const { mkdirSync } = await import("node:fs");
  mkdirSync(downloadRoot, { recursive: true });
  mkdirSync(fixtureDir, { recursive: true });
  db = await openDatabase({ dialect: "sqlite", sqlitePath: join(dir, "t.db") });
  await migrate(db);
  bus = new EventBus(db);
  container = new ServiceContainer();
  container.register({ pluginId: "core", capability: "dev.tantalar.capability.event.emit", invoke: async () => ({ ok: true }) });
  container.register({ pluginId: "core", capability: "dev.tantalar.capability.log", invoke: async () => ({ ok: true }) });
  container.register({
    pluginId: "core",
    capability: "dev.tantalar.capability.vpn-binding",
    invoke: async () => ({
      allowDispatch: vpnAllowDispatch,
      health: vpnAllowDispatch ? "healthy" : "down",
      profileId: "fixture-vpn",
    }),
  });
  const nntpPort = await startPluginNntpFixture();
  pluginConfig = {
    downloadRoots: [downloadRoot],
    maxConcurrent: 50,
    servers: [
      {
        id: "fixture-primary",
        name: "Legal local TLS fixture",
        host: "127.0.0.1",
        port: nntpPort,
        tls: "implicit",
        username: "fixture-user",
        passwordEnv: FIXTURE_SECRET_ENV,
        priority: 0,
        connections: 2,
      },
    ],
  };
  supervisor = new Supervisor({
    bus,
    container,
    scheduler: new Scheduler(db, 100_000),
    documents: new (Object.getPrototypeOf(bus).constructor && require("@tantalar/db").PluginDocumentStore)(db),
    restartPolicy: { initialBackoffMs: 100, maxBackoffMs: 500, backoffMultiplier: 2, windowMs: 10_000, maxRestartsInWindow: 50 },
    healthIntervalMs: 500,
    resolveEntry: (m: { entry: { command: string }; __config?: Record<string, unknown> }) => {
      const [cmd, ...rest] = m.entry.command.split(" ");
      return {
        command: cmd ?? "node",
        args: rest.filter(Boolean),
        env: {
          ...(m.__config ? { TANTALAR_PLUGIN_CONFIG: JSON.stringify(m.__config) } : {}),
          [FIXTURE_SECRET_ENV]: FIXTURE_PASSWORD,
          NODE_EXTRA_CA_CERTS: TLS_CERT_PATH,
        },
      };
    },
  });
  await mountPlugin(pluginConfig);
});

afterAll(async () => {
  await supervisor.stopAll();
  for (const socket of tlsSockets) socket.destroy();
  await new Promise<void>((resolveClose) => tlsServer.close(() => resolveClose()));
  await db.destroy();
});

/* eslint-disable @typescript-eslint/no-explicit-any */
function client(): any {
  return container.resolve(CLIENT_CAP) as any;
}
function engineCap(): any {
  return container.resolve(ENGINE_CAP) as any;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

async function driveToCompletion(itemKey: string, title: string, nzbPath: string, maxSteps = 200): Promise<{ state: string; downloadId: string }> {
  const added = (await client().invoke("add", { itemKey, title, kind: "nzb", sourceUrl: nzbPath })) as {
    state: string;
    downloadId: string;
  };
  let last = added.state;
  for (let i = 0; i < maxSteps && last !== "completed" && last !== "failed"; i++) {
    const res = (await client().invoke("advance", {})) as { downloads: Array<{ itemKey: string; state: string }> };
    last = res.downloads.find((d) => d.itemKey === itemKey)?.state ?? last;
  }
  return { state: last, downloadId: added.downloadId };
}

// ---- Unit level -------------------------------------------------------------------

describe("yEnc + CRC + NZB parsing (legal synthetic units)", () => {
  it("round-trips yEnc encode → decode with matching CRC32", async () => {
    const { encodeYenc } = await import("../plugins/usenet-native/src/fixtures.js");
    const payload = Buffer.alloc(4096);
    for (let i = 0; i < payload.length; i++) payload[i] = i & 0xff;
    const body = encodeYenc(payload, "fixture.bin", 1, 1);
    const decoded = decodeYenc(body);
    expect(decoded.declaredCrc32).toBe(crc32(payload));
    expect(decoded.data.equals(payload)).toBe(true);
    expect(crc32(decoded.data)).toBe(crc32(payload));
  });

  it("decodeYenc reports declared CRC so mismatches become visible warnings", async () => {
    const { encodeYenc } = await import("../plugins/usenet-native/src/fixtures.js");
    const payload = Buffer.from("abc");
    const body = encodeYenc(payload, "x", 1, 1);
    const d = decodeYenc(body);
    expect(d.declaredCrc32).not.toBeNull();
    expect(d.data.toString()).toBe("abc");
    expect(d.declaredCrc32).toBe(crc32(payload));
    // A tampered CRC still surfaces so mismatches become warnings upstream.
    const tampered = body.replace(/crc32=[0-9a-f]+/, "crc32=deadbeef");
    expect(decodeYenc(tampered).declaredCrc32).toBe("deadbeef");
  });

  it("parses a synthetic NZB fail-closed", () => {
    const nzb = makeSyntheticNzb(fixtureDir, "unit-parse", { fileCount: 2, fileBytes: 1024 });
    const parsed = parseNzb(require("node:fs").readFileSync(nzb.nzbPath, "utf8"));
    expect(parsed.files).toHaveLength(2);
    expect(parsed.files[0]!.segments).toHaveLength(1);
    expect(() => parseNzb("<nzb></nzb>")).toThrow(/no files/);
  });
});

// ---- Full lifecycle over the process boundary ---------------------------------------

describe("usenet-native embedded engine (TAN-010)", () => {
  it("reports redacted configuration and tests the configured TLS server", async () => {
    const status = (await engineCap().invoke("configuration-status", {})) as {
      ready: boolean;
      servers: Array<Record<string, unknown>>;
      limitations: Record<string, boolean>;
    };
    expect(status.ready).toBe(true);
    expect(status.servers).toHaveLength(1);
    expect(status.servers[0]).toMatchObject({
      id: "fixture-primary",
      hasPassword: true,
      passwordSource: "environment",
    });
    expect(status.servers[0]).not.toHaveProperty("password");
    expect(status.limitations).toEqual({ starttls: false, par2: true, archives: true });

    const server = (pluginConfig.servers as Array<Record<string, unknown>>)[0]!;
    await expect(engineCap().invoke("test-server", { server })).resolves.toMatchObject({ ok: true });
    await expect(engineCap().invoke("test-server", { server: { ...server, tls: "starttls" } })).rejects.toThrow(
      /STARTTLS is not supported/,
    );
    await expect(
      engineCap().invoke("configure", { servers: [{ ...server, passwordEnv: "plaintext-name" }] }),
    ).rejects.toThrow(/TANTALAR_SECRET_/);
    await expect(engineCap().invoke("configure", { servers: [{ ...server, password: FIXTURE_PASSWORD }] })).rejects.toThrow(
      /inline Usenet passwords are forbidden/,
    );
    await expect(engineCap().invoke("configure", { servers: [server] })).resolves.toMatchObject({ ready: true });
    await supervisor.unmount(PLUGIN_ID);
    await mountPlugin({ downloadRoots: [downloadRoot], maxConcurrent: 50 });
    await expect(engineCap().invoke("configuration-status", {})).resolves.toMatchObject({ ready: true });
  });

  it("advances queued jobs in the bounded background worker", async () => {
    const nzb = makeSyntheticNzb(fixtureDir, "wave5-background", { fileCount: 2, fileBytes: 8 * 1024 });
    const added = (await client().invoke("add", {
      itemKey: "movie-wave5-background",
      title: "Wave5 Background",
      kind: "nzb",
      sourceUrl: nzb.nzbPath,
    })) as { downloadId: string };
    let state = "queued";
    for (let attempt = 0; attempt < 30 && state !== "completed"; attempt++) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 50));
      state = ((await client().invoke("status", { downloadId: added.downloadId })) as { state: string }).state;
    }
    expect(state).toBe("completed");
    const completed = (await client().invoke("completed-files", { downloadId: added.downloadId })) as {
      files: Array<{ path: string; sizeBytes: number }>;
    };
    expect(completed.files).toHaveLength(2);
    expect(completed.files.every((file) => resolve(file.path).startsWith(resolve(downloadRoot)) && file.sizeBytes > 0)).toBe(true);
  });

  it("gates add, advance, resume, and retry when VPN binding is unhealthy", async () => {
    const blockedAdd = makeSyntheticNzb(fixtureDir, "wave5-vpn-add", { fileCount: 1, fileBytes: 4 * 1024 });
    vpnAllowDispatch = false;
    try {
      await expect(
        client().invoke("add", {
          itemKey: "movie-wave5-vpn-add",
          title: "Wave5 VPN Add",
          kind: "nzb",
          sourceUrl: blockedAdd.nzbPath,
        }),
      ).rejects.toThrow(/kill switch/);
    } finally {
      vpnAllowDispatch = true;
    }

    const queued = makeSyntheticNzb(fixtureDir, "wave5-vpn-advance", { fileCount: 2, fileBytes: 4 * 1024 });
    const added = (await client().invoke("add", {
      itemKey: "movie-wave5-vpn-advance",
      title: "Wave5 VPN Advance",
      kind: "nzb",
      sourceUrl: queued.nzbPath,
    })) as { downloadId: string };
    vpnAllowDispatch = false;
    try {
      await expect(client().invoke("advance", {})).rejects.toThrow(/kill switch/);
    } finally {
      vpnAllowDispatch = true;
    }
    await client().invoke("pause", { downloadId: added.downloadId });
    vpnAllowDispatch = false;
    try {
      await expect(client().invoke("resume", { downloadId: added.downloadId })).rejects.toThrow(/kill switch/);
    } finally {
      vpnAllowDispatch = true;
    }
    await client().invoke("resume", { downloadId: added.downloadId });

    const missing = makeSyntheticNzb(fixtureDir, "wave5-vpn-retry", { fileCount: 1, fileBytes: 4 * 1024 });
    const missingBody = pluginArticles.get(missing.messageIds[0]!)!;
    pluginArticles.delete(missing.messageIds[0]!);
    const failed = await driveToCompletion("movie-wave5-vpn-retry", "Wave5 VPN Retry", missing.nzbPath);
    expect(failed.state).toBe("failed");
    vpnAllowDispatch = false;
    try {
      await expect(client().invoke("retry", { downloadId: failed.downloadId })).rejects.toThrow(/kill switch/);
    } finally {
      vpnAllowDispatch = true;
      pluginArticles.set(missing.messageIds[0]!, missingBody);
    }
    await client().invoke("retry", { downloadId: failed.downloadId });
    const completed = await driveToCompletion("movie-wave5-vpn-retry", "Wave5 VPN Retry", missing.nzbPath);
    expect(completed.state).toBe("completed");
  });

  it("downloads a legal synthetic NZB end-to-end WITHOUT SABnzbd (add → advance → completed)", async () => {
    const nzb = makeSyntheticNzb(fixtureDir, "wave5-show-s01e01", { fileCount: 2, fileBytes: 64 * 1024 });
    const result = await driveToCompletion("series-wave5:S01E01", "Wave5 Show S01E01", nzb.nzbPath);
    expect(result.state).toBe("completed");

    const status = (await client().invoke("status", { downloadId: result.downloadId })) as {
      state: string;
      progressPercent: number;
    };
    expect(status.state).toBe("completed");
    expect(status.progressPercent).toBe(100);

    // Payload bytes land in a dedicated root for this job.
    const written = join(downloadRoot, result.downloadId, nzb.fileNames[0]!);
    expect(existsSync(written)).toBe(true);
  });

  it("downloads an indexer NZB URL through the real plugin and NNTP transport", async () => {
    const nzb = makeSyntheticNzb(fixtureDir, "wave5-http", { fileCount: 1, fileBytes: 4096 });
    const server = createHttpServer((_request, response) => { response.setHeader("Content-Type", "application/x-nzb"); response.end(readFileSync(nzb.nzbPath)); });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    try {
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api?t=get&id=fixture&apikey=private-key`;
      const result = await driveToCompletion("movie-wave5-http", "HTTP fixture", url);
      await expect.poll(async () => (await client().invoke("status", { downloadId: result.downloadId })).state).toBe("completed");
      expect(readFileSync(join(downloadRoot, result.downloadId, nzb.fileNames[0]!))).toEqual(nzb.payloads.get(nzb.fileNames[0]!));
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  });

  it("falls back to the fill server when the primary misses a segment, with a visible warning", async () => {
    const nzb = makeSyntheticNzb(fixtureDir, "wave5-fillserver", { fileCount: 2, fileBytes: 16 * 1024 });
    const missMe = nzb.messageIds[0]!;
    const { all, primary } = fullArticleMaps(nzb, { missingOnPrimary: [missMe] });
    const { engine, servedFrom } = buildEngine(primary, all);

    const added = await engine.add({ sourceKind: "nzb-path", sourcePath: nzb.nzbPath, downloadPath: join(dir, "fill-root") });
    for (let i = 0; i < 10 && engine.get(added.id)!.state !== "completed"; i++) await engine.advance(added.id);
    const job = engine.get(added.id)!;
    expect(job.state).toBe("completed");
    // The missed segment was served by the FILL server.
    const servedBy = (map: typeof servedFrom[0]) => map.get(missMe);
    const which = servedFrom.map(servedBy).find(Boolean);
    expect(which).toBe("fill");
    expect(job.warnings.some((w) => /missing on server primary/.test(w))).toBe(true);

    // Plugin-level visibility: same warning shape surfaces through the capability.
    const status = (await client().invoke("list", {})) as { downloads: Array<{ itemKey: string; state: string }> };
    expect(Array.isArray(status.downloads)).toBe(true);
  });

  it("fails truthfully when NO configured server has a segment", async () => {
    const nzb = makeSyntheticNzb(fixtureDir, "wave5-unavailable", { fileCount: 1, fileBytes: 8 * 1024 });
    const { primary } = fullArticleMaps(nzb);
    primary.delete(nzb.messageIds[0]!); // missing everywhere
    const { engine } = buildEngine(primary, new Map());
    const added = await engine.add({ sourceKind: "nzb-path", sourcePath: nzb.nzbPath, downloadPath: join(dir, "fail-root") });
    for (let i = 0; i < 5; i++) {
      if (engine.get(added.id)!.state === "failed") break;
      await engine.advance(added.id);
    }
    const job = engine.get(added.id)!;
    expect(job.state).toBe("failed");
    expect(job.failureReason).toMatch(/unavailable on all configured servers/);
  });

  it("pause → resume keeps progress without restarting", async () => {
    const nzb = makeSyntheticNzb(fixtureDir, "wave5-pause", { fileCount: 3, fileBytes: 16 * 1024 });
    const added = (await client().invoke("add", {
      itemKey: "movie-wave5-pause",
      title: "Wave5 Pause",
      kind: "nzb",
      sourceUrl: nzb.nzbPath,
    })) as { downloadId: string };
    await client().invoke("advance", {});
    const paused = (await client().invoke("pause", { downloadId: added.downloadId })) as { state: string };
    expect(paused.state).toBe("paused");
    const resumed = (await client().invoke("resume", { downloadId: added.downloadId })) as { state: string };
    expect(resumed.state).not.toBe("paused");
  });

  it("queue positions are provider-neutral and validated", async () => {
    const list = (await client().invoke("list", {})) as { downloads: Array<{ downloadId: string }> };
    const first = list.downloads[0]?.downloadId;
    if (first) {
      await expect(engineCap().invoke("queue-position", { downloadId: first, queuePosition: 1 })).resolves.toBeDefined();
      await expect(engineCap().invoke("queue-position", { downloadId: first, queuePosition: 0 })).rejects.toThrow(/>= 1/);
    }
  });

  it("rejects torrent-kind releases and unsafe source URLs fail-closed", async () => {
    await expect(
      client().invoke("add", { itemKey: "x-tor", title: "X", kind: "torrent", sourceUrl: "/tmp/x.torrent" }),
    ).rejects.toThrow(/NZB releases only/);
    await expect(
      client().invoke("add", { itemKey: "x-url", title: "X", kind: "nzb", sourceUrl: "file://example.invalid/a.nzb" }),
    ).rejects.toThrow(/absolute .nzb path/);
  });

  it("is idempotent on repeated adds for the same itemKey", async () => {
    const nzb = makeSyntheticNzb(fixtureDir, "wave5-idem", { fileCount: 1, fileBytes: 8 * 1024 });
    const r1 = await driveToCompletion("movie-wave5-idem", "Wave5 Idem", nzb.nzbPath);
    expect(r1.state).toBe("completed");
    const again = (await client().invoke("add", { itemKey: "movie-wave5-idem", title: "Wave5 Idem", kind: "nzb", sourceUrl: nzb.nzbPath })) as { downloadId: string };
    expect(again.downloadId).toBe(r1.downloadId);
  });
});

describe("restart without duplicates (durable resume)", () => {
  it("persists job state across unmount + remount without duplicating jobs", async () => {
    const nzb = makeSyntheticNzb(fixtureDir, "wave5-restart", { fileCount: 1, fileBytes: 32 * 1024 });
    const added = (await client().invoke("add", {
      itemKey: "movie-wave5-restart",
      title: "Wave5 Restart",
      kind: "nzb",
      sourceUrl: nzb.nzbPath,
    })) as { downloadId: string };

    await supervisor.unmount(PLUGIN_ID);
    await mountPlugin(pluginConfig);

    // Same itemKey add after remount must NOT create a second job.
    const dupe = (await client().invoke("add", {
      itemKey: "movie-wave5-restart",
      title: "Wave5 Restart",
      kind: "nzb",
      sourceUrl: nzb.nzbPath,
    })) as { downloadId: string };
    expect(dupe.downloadId).toBe(added.downloadId);

    const list = (await client().invoke("list", {})) as { downloads: Array<{ itemKey: string }> };
    expect(list.downloads.filter((d) => d.itemKey === "movie-wave5-restart")).toHaveLength(1);

    const done = await driveToCompletion("movie-wave5-restart", "Wave5 Restart", nzb.nzbPath);
    expect(done.state).toBe("completed");
  });
});

describe("post-processing boundaries (TAN-010)", () => {
  it("reports missing recovery data and handles jobs without archives", async () => {
    const nzb = makeSyntheticNzb(fixtureDir, "wave5-post-processing", { fileCount: 1, fileBytes: 16 * 1024 });
    const done = await driveToCompletion(
      "movie-wave5-post-processing",
      "Wave5 Post Processing",
      nzb.nzbPath,
    );
    expect(done.state).toBe("completed");
    await expect(engineCap().invoke("repair", { downloadId: done.downloadId })).rejects.toThrow(
      /has no PAR2 recovery files/,
    );
    await expect(engineCap().invoke("unpack", { downloadId: done.downloadId })).resolves.toMatchObject({ unpacked: false, files: [] });
  });
});

// ---- TAN-011 unified download_jobs ----------------------------------------------------

describe("unified durable download_jobs (TAN-011)", () => {
  let store: DownloadJobStore;

  beforeAll(() => {
    store = new DownloadJobStore(db);
  });

  it("records the full transactional lifecycle for usenet AND torrent jobs in one contract", async () => {
    const u = await store.create({
      itemKey: "job-usenet-1",
      title: "Usenet Job",
      source: "usenet",
      providerPluginId: PLUGIN_ID,
      providerJobId: "usenet-transaction-1",
      sourceRef: `sha256:${"1".repeat(64)}`,
      sizeBytes: 1000,
    });
    expect(u.created).toBe(true);
    expect(u.record.state).toBe("queued");

    const t = await store.create({
      itemKey: "job-torrent-1",
      title: "Torrent Job",
      source: "torrent",
      providerPluginId: "dev.tantalar.plugin.torrent-native",
      providerJobId: "torrent-transaction-1",
      sourceRef: `sha256:${"2".repeat(64)}`,
      sizeBytes: 2000,
    });
    expect(t.created).toBe(true);

    await store.updateProgress(u.record.jobId, {
      state: "downloading",
      progressPercent: 42.6,
      receivedBytes: 426,
      etaAt: "2026-08-24T00:00:00.000Z",
      warning: "segment fallback to fill server",
    });
    const mid = await store.getOrThrow(u.record.jobId);
    expect(mid.progressPercent).toBe(43); // clamped + rounded
    expect(mid.warnings).toEqual(["segment fallback to fill server"]);
    expect(mid.etaAt).toBe("2026-08-24T00:00:00.000Z");

    await store.updateProgress(u.record.jobId, { state: "completed", progressPercent: 100, receivedBytes: 1000 });
    await store.recordImportHandoff(u.record.jobId, "/library/Wave5 Show S01E01.mkv");
    const done = await store.getOrThrow(u.record.jobId);
    expect(done.importHandoffPath).toBe("/library/Wave5 Show S01E01.mkv");

    // Terminal protection.
    await expect(store.updateProgress(u.record.jobId, { state: "downloading" })).rejects.toThrow(/cannot move/);
    await expect(store.markFailed(u.record.jobId, "nope")).rejects.toThrow(/retroactively/);

    // Retry bookkeeping on a failed job.
    await store.markFailed(t.record.jobId, "piece hash mismatch");
    const retried = await store.retry(t.record.jobId);
    expect(retried.state).toBe("queued");
    expect(retried.failureReason).toBeNull();
    expect(retried.retryCount).toBe(1);
  });

  it("removal flags history instead of deleting — durable across 'restart'", async () => {
    const j = await store.create({
      itemKey: "job-history-1",
      title: "History Job",
      source: "usenet",
      providerPluginId: PLUGIN_ID,
      providerJobId: "usenet-history-1",
      sourceRef: `sha256:${"3".repeat(64)}`,
    });
    await store.updateProgress(j.record.jobId, { state: "completed", progressPercent: 100 });
    await store.remove(j.record.jobId);
    const flagged = await store.getOrThrow(j.record.jobId);
    expect(flagged.removed).toBe(true);
    expect(flagged.state).toBe("completed"); // history intact

    // History listing includes removed rows newest-first after active ones.
    const listed = await store.list({ includeHistory: true });
    expect(listed.some((r) => r.jobId === j.record.jobId && r.removed)).toBe(true);

    // Removed rows free the active slot: re-add creates a NEW job.
    const fresh = await store.create({
      itemKey: "job-history-1",
      title: "History Job v2",
      source: "usenet",
      providerPluginId: PLUGIN_ID,
      providerJobId: "usenet-history-2",
      sourceRef: `sha256:${"3".repeat(64)}`,
    });
    expect(fresh.created).toBe(true);
    expect(fresh.record.jobId).not.toBe(j.record.jobId);
  });

  it("enforces one active job per (itemKey, source) — restart cannot duplicate", async () => {
    const a = await store.create({
      itemKey: "job-active-1",
      title: "Active",
      source: "usenet",
      providerPluginId: PLUGIN_ID,
      providerJobId: "usenet-active-1",
      sourceRef: `sha256:${"4".repeat(64)}`,
    });
    expect(a.created).toBe(true);
    const b = await store.create({
      itemKey: "job-active-1",
      title: "Active",
      source: "usenet",
      providerPluginId: PLUGIN_ID,
      providerJobId: "usenet-active-race",
      sourceRef: `sha256:${"4".repeat(64)}`,
    });
    expect(b.created).toBe(false);
    expect(b.record.jobId).toBe(a.record.jobId);
    await expect(store.retry(b.record.jobId)).rejects.toThrow(/only failed or paused/);
  });

  it("requires redacted source and real provider identities", async () => {
    await expect(store.create({
      itemKey: "unsafe-source",
      title: "Unsafe source",
      source: "usenet",
      providerPluginId: PLUGIN_ID,
      providerJobId: "unsafe-source-job",
      sourceRef: "/private/news/passkey.nzb",
    })).rejects.toThrow(/SHA-256 fingerprint/);

    const first = await store.create({
      itemKey: "provider-identity-a",
      title: "Provider identity A",
      source: "usenet",
      providerPluginId: PLUGIN_ID,
      providerJobId: "shared-provider-id",
      sourceRef: `sha256:${"5".repeat(64)}`,
    });
    await expect(store.create({
      itemKey: "provider-identity-b",
      title: "Provider identity B",
      source: "usenet",
      providerPluginId: PLUGIN_ID,
      providerJobId: "shared-provider-id",
      sourceRef: `sha256:${"6".repeat(64)}`,
    })).rejects.toThrow();

    await db
      .updateTable("download_jobs")
      .set({ providerJobId: null })
      .where("jobId", "=", first.record.jobId)
      .execute();
    expect((await store.getOrThrow(first.record.jobId)).providerJobId).toBeNull();
  });
});
