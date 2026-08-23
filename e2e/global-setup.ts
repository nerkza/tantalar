/**
 * Playwright global setup: boot a real Tantalar server with the serving
 * plugin mounted and synthetic media fixtures (no copyrighted content), then
 * expose its address + fixture ids to the tests via env/JSON.
 *
 * The web app is served by the Playwright webServer (vite dev) which proxies
 * /api to this server.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Kysely } from "kysely";
import { migrate, openDatabase, type Db } from "../packages/db/dist/index.js";
import { EventBus } from "../apps/server/src/events.js";
import { ServiceContainer } from "../apps/server/src/container.js";
import { Scheduler } from "../apps/server/src/scheduler.js";
import { Supervisor } from "../apps/server/src/supervisor.js";
import { AuthService } from "../apps/server/src/auth.js";
import { buildServer } from "../apps/server/src/http.js";

const SERVING_ID = "dev.tantalar.plugin.serving";
const SERVING_CAP = "dev.tantalar.capability.serving";
const SERVING_ENTRY = "node " + resolve("plugins/serving/dist/plugin.js");

export const E2E_USER = "admin";
export const E2E_PASS = "password-admin-1";

async function start() {
  const dir = mkdtempSync(join(tmpdir(), "tantalar-e2e-"));
  const mediaRoot = join(dir, "media");
  mkdirSync(mediaRoot, { recursive: true });

  const db: Kysely<Db> = await openDatabase({ dialect: "sqlite", sqlitePath: join(dir, "t.db") });
  await migrate(db);
  const bus = new EventBus(db);
  const container = new ServiceContainer();
  container.register({ pluginId: "core", capability: "dev.tantalar.capability.event.emit", invoke: async () => ({ ok: true }) });
  container.register({ pluginId: "core", capability: "dev.tantalar.capability.log", invoke: async () => ({ ok: true }) });
  const supervisor = new Supervisor({
    bus,
    container,
    scheduler: new Scheduler(db, 100_000),
    restartPolicy: {
      initialBackoffMs: 100,
      maxBackoffMs: 500,
      backoffMultiplier: 2,
      windowMs: 10_000,
      maxRestartsInWindow: 5,
    },
    healthIntervalMs: 500,
    resolveEntry: (m) => {
      const [cmd, ...rest] = m.entry.command.split(" ");
      const configJson = (m as unknown as { __config?: Record<string, unknown> }).__config;
      return {
        command: cmd ?? "node",
        args: rest.filter(Boolean),
        env: (configJson ? { TANTALAR_PLUGIN_CONFIG: JSON.stringify(configJson) } : {}) as Record<string, string>,
      };
    },
  });

  const manifest = {
    id: SERVING_ID,
    version: "0.1.0",
    protocolVersion: 1,
    provides: [SERVING_CAP],
    requires: ["dev.tantalar.capability.event.emit", "dev.tantalar.capability.log"],
    subscriptions: [],
    entry: { command: SERVING_ENTRY },
  };
  await supervisor.mount(manifest, {
    ffmpegCommand: process.execPath,
    ffmpegArgs: ["-e", "setInterval(()=>{},1000)"],
    maxWorkers: 2,
    idleTimeoutMs: 120_000,
    hangTimeoutMs: 120_000,
    stateFile: join(dir, "serving-state.json"),
  });
  const serving = (): { invoke(op: string, p?: Record<string, unknown>): Promise<unknown> } =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    container.resolve(SERVING_CAP) as any;

  // Synthetic fixture media — generated locally with ffmpeg (testsrc/sine),
  // so no copyrighted material is ever used. The two direct-play items are
  // real mp4/h264/aac files the browser can actually decode; the mkv and avi
  // items only back the HLS/negotiation paths, so byte blobs suffice.
  const ffmpegBin = process.env.TANTALAR_E2E_FFMPEG ?? "ffmpeg";
  const genFixture = (name: string, real: boolean): string => {
    const p = join(mediaRoot, `${name}.bin`);
    if (real) {
      execFileSync(ffmpegBin, [
        "-f", "lavfi", "-i", "testsrc=duration=30:size=320x240:rate=10",
        "-f", "lavfi", "-i", "sine=frequency=440:duration=30",
        "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-shortest", "-f", "mp4", "-y", p,
      ], { stdio: "ignore" });
    } else {
      writeFileSync(p, Buffer.alloc(4096, name.charCodeAt(0)));
    }
    return p;
  };
  const files: Record<string, string> = {
    "mp4-h264-aac": genFixture("mp4-h264-aac", true),
    "mp4-h264-aac-ep2": genFixture("mp4-h264-aac-ep2", true),
    "mkv-hevc-dts": genFixture("mkv-hevc-dts", false),
    "avi-av1-truehd": genFixture("avi-av1-truehd", false),
  };

  // A real (locally generated) MPEG-TS payload so hls.js can parse the
  // synthetic HLS segments the server hands out during e2e runs.
  const tsSegment = join(dir, "segment.ts");
  execFileSync(ffmpegBin, [
    "-f", "lavfi", "-i", "testsrc=duration=8:size=320x240:rate=10",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=8",
    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-shortest", "-f", "mpegts", "-y", tsSegment,
  ], { stdio: "ignore" });
  const tsBytes = readFileSync(tsSegment);

  // fileId → fixture key
  const fixtureOf: Record<string, string> = {
    "f-ep1": "mp4-h264-aac",
    "f-ep2": "mp4-h264-aac-ep2",
    "f-mkv-hevc-dts": "mkv-hevc-dts",
    "f-restricted": "avi-av1-truehd",
  };

  const entry = (
    fileId: string,
    itemKey: string,
    kind: "movie" | "series",
    container_: string,
    v: string,
    a: string,
    lib: string,
    subs: unknown[] = [],
  ) =>
    serving().invoke("register-entry", {
      fileId,
      itemKey,
      title: fileId,
      kind,
      libraryId: lib,
      container: container_,
      videoCodec: v,
      audioCodec: a,
      sizeBytes: statSync(files[fixtureOf[fileId] ?? fileId.replace(/^f-/, "")]!).size,
      subtitles: subs,
    });

  // Series with two episodes (autoplay-next flow) + an HLS item + subtitle item.
  await entry("f-ep1", "series-show/s01e01", "series", "mp4", "h264", "aac", "lib-main");
  await entry("f-ep2", "series-show/s01e02", "series", "mp4", "h264", "aac", "lib-main");
  await entry("f-mkv-hevc-dts", "mkv-item", "movie", "mkv", "hevc", "dts", "lib-main", [
    {
      trackId: "sub-srt-en",
      lang: "en",
      format: "srt",
      source: "embedded",
      content:
        "1\n00:00:01,000 --> 00:00:04,000\nHello from the synthetic embedded track.\n" +
        "2\n00:00:05,000 --> 00:00:08,000\nLocally generated fixture content.\n",
    },
    { trackId: "sub-pgs-en", lang: "en", format: "pgs", source: "embedded" },
  ]);
  await entry("f-restricted", "restricted-item", "movie", "avi", "av1", "truehd", "lib-restricted");

  await serving().invoke("set-viewer", { userId: "u-kids", libraries: ["lib-main"] });
  await serving().invoke("set-viewer", { userId: "u-none", libraries: [] });

  const auth = new AuthService(db);
  const app = await buildServer({
    auth,
    db,
    bus,
    supervisor,
    container,
    ready: () => true,
    serving: (invoke) => ({
      invoke,
      resolvePath: (fileId: string) => files[fixtureOf[fileId] ?? fileId.replace(/^f-/, "")] ?? null,
      mediaRoots: [mediaRoot],
      segmentPayload: () => tsBytes,
    }),
  });
  await app.listen({ port: Number(process.env.TANTALAR_API_PORT ?? 3199), host: "127.0.0.1" });
  await auth.createUser(E2E_USER, E2E_PASS, "admin");

  const [adminRow] = await db.selectFrom("users").select("id").where("username", "=", E2E_USER).execute();
  await serving().invoke("set-viewer", { userId: adminRow!.id, libraries: ["*"] });

  return { db, app, supervisor, bus, adminId: adminRow!.id, serving };
}

export default async function globalSetup() {
  const started = await start();
  // Seed a grab→import correlation chain so the Activity/Trajectory view has
  // a full decision story to reconstruct in the e2e suite.
  const corr = "corr-e2e-phase6";
  for (const [type, payload] of [
    ["dev.tantalar.event.indexer.searched", { query: "Show S01E01" }],
    ["dev.tantalar.event.comparison.verdict", { itemKey: "series-show:s01e01", winnerGuid: "good-rel", rankedGuids: ["good-rel"] }],
    ["dev.tantalar.event.grab.decision", { itemKey: "series-show:s01e01", decided: true, guid: "good-rel", mode: "automatic" }],
    ["dev.tantalar.event.client.dispatch", { itemKey: "good-rel", downloadId: "d-e2e" }],
    ["dev.tantalar.event.download.completed", { downloadId: "d-e2e" }],
    ["dev.tantalar.event.import.started", { itemKey: "series-show:s01e01" }],
    ["dev.tantalar.event.import.completed", { path: "/library/series-show/s01e01.mkv" }],
  ] as const) {
    await started.bus
      .publish({ type, producer: "core", payload, correlationId: corr })
      .catch(() => undefined);
  }
  // Keep the server alive for the whole run; teardown on exit.
  const teardown = async () => {
    await started.supervisor.stopAll().catch(() => undefined);
    await started.app.close().catch(() => undefined);
    await started.db.destroy().catch(() => undefined);
  };
  process.on("exit", () => void teardown());
  process.on("SIGINT", () => void teardown().then(() => process.exit(0)));
  process.on("SIGTERM", () => void teardown().then(() => process.exit(0)));
}
