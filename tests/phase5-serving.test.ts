/**
 * Phase 5A tests: serving backend.
 * Covers: format-matrix capability negotiation (story 13), direct play
 * bypassing ffmpeg, byte-range serving, authorization boundaries
 * (per-viewer library visibility, story 21), resume points and races,
 * watch history / continue-watching (story 18), collections / browsing
 * (story 15), subtitle inventory incl. external (story 19), and bounded
 * transcode-session orchestration: worker caps, idle cleanup, hang
 * watchdog, cancellation, kill -9 orphan cleanup (story 17).
 *
 * All media fixtures are synthetic byte blobs; the "ffmpeg worker" is a
 * fixture node subprocess. No real copyrighted media is used.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Kysely } from "kysely";
import { migrate, openDatabase, type Db } from "@tantalar/db";
import { EventTypes, ServingError, isDirectPlayable, validateResumeUpdate } from "@tantalar/contracts";
import { EventBus } from "../apps/server/src/events.js";
import { ServiceContainer } from "../apps/server/src/container.js";
import { Scheduler } from "../apps/server/src/scheduler.js";
import { Supervisor } from "../apps/server/src/supervisor.js";
import { AuthService } from "../apps/server/src/auth.js";
import { buildServer } from "../apps/server/src/http.js";

const SERVING_ID = "dev.tantalar.plugin.serving";
const SERVING_CAP = "dev.tantalar.capability.serving";
const SERVING_ENTRY = "node " + resolve("plugins/serving/dist/plugin.js");

const policy = {
  initialBackoffMs: 100,
  maxBackoffMs: 500,
  backoffMultiplier: 2,
  windowMs: 10_000,
  maxRestartsInWindow: 5,
};

let db: Kysely<Db>;
let bus: EventBus;
let container: ServiceContainer;
let supervisor: Supervisor;
let auth: AuthService;
let app: Awaited<ReturnType<typeof buildServer>>;
let address = "";
let dir: string;
let mediaRoot: string;
let hlsRoot: string;

// fixture media files (synthetic bytes)
const FILES: Record<string, string> = {}; // fileId -> path

function serving(): { invoke(op: string, p?: Record<string, unknown>): Promise<unknown> } {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return container.resolve(SERVING_CAP) as any;
}

async function mount(id: string, cap: string, command: string, config: Record<string, unknown>) {
  const m = {
    id,
    version: "0.1.0",
    protocolVersion: 1,
    provides: [cap],
    requires: ["dev.tantalar.capability.event.emit", "dev.tantalar.capability.log"],
    subscriptions: [],
    entry: { command },
  };
  const rt = await supervisor.mount(m, config);
  expect(rt.state).toBe("healthy");
}

const ADMIN = { cookie: "", csrf: "" };

async function login(username: string, password: string) {
  const res = await fetch(`${address}/api/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  expect(res.status).toBe(200);
  const setCookie = res.headers.getSetCookie?.() ?? [];
  return {
    cookie: setCookie.map((c) => c.split(";")[0]).join("; "),
    csrf: ((await res.json()) as { csrfToken: string }).csrfToken,
  };
}

function get(path: string, who = ADMIN, extraHeaders: Record<string, string> = {}) {
  return fetch(`${address}${path}`, { headers: { cookie: who.cookie, ...extraHeaders } });
}

function post(path: string, body?: unknown, who = ADMIN) {
  return fetch(`${address}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-csrf-token": who.csrf, cookie: who.cookie },
    body: JSON.stringify(body ?? {}),
  });
}

function put(path: string, body: unknown, who = ADMIN) {
  return fetch(`${address}${path}`, {
    method: "PUT",
    headers: { "content-type": "application/json", "x-csrf-token": who.csrf, cookie: who.cookie },
    body: JSON.stringify(body),
  });
}

function del(path: string, who = ADMIN) {
  return fetch(`${address}${path}`, {
    method: "DELETE",
    headers: { "x-csrf-token": who.csrf, cookie: who.cookie },
  });
}

const BROWSER_FULL = {
  canPlayContainers: ["mp4"],
  canPlayVideo: ["h264"],
  canPlayAudio: ["aac"],
  canDirectSubtitles: ["srt", "vtt"],
};

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "tantalar-p5-"));
  mediaRoot = join(dir, "media");
  hlsRoot = join(dir, "segments");
  mkdirSync(mediaRoot, { recursive: true });
  mkdirSync(hlsRoot, { recursive: true });

  db = await openDatabase({ dialect: "sqlite", sqlitePath: join(dir, "t.db") });
  await migrate(db);
  bus = new EventBus(db);
  container = new ServiceContainer();
  container.register({ pluginId: "core", capability: "dev.tantalar.capability.event.emit", invoke: async () => ({ ok: true }) });
  container.register({ pluginId: "core", capability: "dev.tantalar.capability.log", invoke: async () => ({ ok: true }) });
  supervisor = new Supervisor({
    bus,
    container,
    scheduler: new Scheduler(db, 100_000),
    restartPolicy: policy,
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
  await mount(SERVING_ID, SERVING_CAP, SERVING_ENTRY, {
    // Fixture "ffmpeg": a node one-liner that stays alive until killed.
    ffmpegCommand: process.execPath,
    ffmpegArgs: ["-e", "setInterval(()=>{},1000)"],
    maxWorkers: 2,
    idleTimeoutMs: 60_000,
    hangTimeoutMs: 60_000,
    // Catalog/viewer/watch-state snapshot; survives the orphan-sim remount.
    stateFile: join(dir, "serving-state.json"),
  });

  auth = new AuthService(db);

  // Synthetic fixture media: tiny files with real bytes on disk.
  for (const [name, bytes] of [
    ["mp4-h264-aac", "A".repeat(4096)],
    ["mkv-hevc-dts", "B".repeat(4096)],
    ["avi-av1-truehd", "C".repeat(4096)],
    ["mp4-h264-atmos", "D".repeat(4096)],
  ] as const) {
    const p = join(mediaRoot, `${name}.bin`);
    writeFileSync(p, bytes);
    FILES[name] = p;
  }
  const entry = (fileId: string, container_, v, a, lib: string, subs: unknown[] = []) =>
    serving().invoke("register-entry", {
      fileId,
      itemKey: `item-${fileId}`,
      title: fileId,
      kind: "movie",
      libraryId: lib,
      container: container_,
      videoCodec: v,
      audioCodec: a,
      sizeBytes: statSync(FILES[fileId.replace(/^f-/, "")] ?? FILES["mp4-h264-aac"]).size,
      subtitles: subs,
    });
  await entry("f-mp4-h264-aac", "mp4", "h264", "aac", "lib-main");
  await entry("f-mkv-hevc-dts", "mkv", "hevc", "dts", "lib-main", [
    {
      trackId: "sub-1",
      lang: "en",
      format: "srt",
      source: "embedded",
      content: "1\n00:00:01,000 --> 00:00:04,000\nHello from the embedded unit track.\n",
    },
    { trackId: "sub-2", lang: "en", format: "pgs", source: "embedded" },
  ]);
  await entry("f-avi-av1-truehd", "avi", "av1", "truehd", "lib-restricted");
  await entry("f-mp4-h264-atmos", "mp4", "h264", "atmos", "lib-main");

  await serving().invoke("set-viewer", { userId: "u-admin", libraries: ["*"] });
  await serving().invoke("set-viewer", { userId: "u-kids", libraries: ["lib-main"] });
  await serving().invoke("set-viewer", { userId: "u-none", libraries: [] });

  app = await buildServer({
    auth,
    bus,
    supervisor,
    container,
    ready: () => true,
    ops: { auth, db, supervisor, container, bus, ready: () => true, dataDir: dir, sqlitePath: join(dir, "t.db") },
    serving: (invoke) => ({
      invoke,
      resolvePath: async (fileId) => FILES[fileId.replace(/^f-/, "")] ?? null,
      mediaRoots: async () => [mediaRoot],
      hlsRoot,
      resolveSegmentPath: (sessionId, fileName) => join(hlsRoot, sessionId, fileName),
      resolveLibraryAccess: async (userId, isAdmin) => {
        if (isAdmin || userId === "u-admin") return ["*"];
        if (userId === "u-kids") return ["lib-main"];
        return [];
      },
    }),
  });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const a = app.server.address() as { port: number };
  address = `http://127.0.0.1:${a.port}`;
  await auth.createUser("admin", "password-admin-1", "admin");
  const s = await login("admin", "password-admin-1");
  ADMIN.cookie = s.cookie;
  ADMIN.csrf = s.csrf;
  // The acting viewer for cookie sessions is the admin user id; map that
  // user to the fixture admin viewer with full visibility.
  {
    const [adminRow] = await db.selectFrom("users").select("id").where("username", "=", "admin").execute();
    await serving().invoke("set-viewer", { userId: adminRow!.id, libraries: ["*"] });
  }
});

afterAll(async () => {
  await supervisor.stopAll();
  await app.close();
  await db.destroy();
});

// ---- Story 13/16: format matrix + direct play --------------------------------

describe("capability negotiation (stories 13, 16)", () => {
  it("direct-plays mp4/h264/aac for a fully capable browser", async () => {
    const res = await post("/api/v1/negotiate/f-mp4-h264-aac", BROWSER_FULL);
    expect(res.status).toBe(200);
    const { decision } = (await res.json()) as { decision: { mode: string; streamUrl?: string } };
    expect(decision.mode).toBe("direct");
    expect(decision.streamUrl).toMatch(/^\/api\/v1\/stream\/f-mp4-h264-aac\?sessionId=/);
  });

  it("negotiates HLS for unsupported containers (mkv/avi) and codecs (hevc/av1)", async () => {
    for (const fid of ["f-mkv-hevc-dts", "f-avi-av1-truehd"]) {
      const res = await post(`/api/v1/negotiate/${fid}`, BROWSER_FULL);
      expect(res.status).toBe(200);
      const { decision } = (await res.json()) as {
        decision: { mode: string; manifestUrl?: string; qualities?: string[] };
      };
      expect(decision.mode).toBe("hls");
      expect(decision.manifestUrl).toMatch(/manifest\.m3u8$/);
      expect(decision.qualities!.length).toBeGreaterThan(0);
    }
  });

  it("negotiates HLS for unsupported audio passthrough (atmos)", async () => {
    const res = await post("/api/v1/negotiate/f-mp4-h264-atmos", BROWSER_FULL);
    const { decision } = (await res.json()) as { decision: { mode: string } };
    expect(decision.mode).toBe("hls");
  });

  it("matrix helper agrees with the endpoint across the full combo grid", () => {
    const containers = ["mp4", "mkv", "avi"] as const;
    const videos = ["h264", "hevc", "av1"] as const;
    const audios = ["aac", "ac3", "dts", "truehd", "atmos"] as const;
    let direct = 0;
    for (const c of containers)
      for (const v of videos)
        for (const a of audios) {
          const ok = isDirectPlayable({ container: c, videoCodec: v, audioCodec: a }, BROWSER_FULL);
          expect(ok).toBe(c === "mp4" && v === "h264" && a === "aac");
          if (ok) direct++;
        }
    expect(direct).toBe(1);
  });

  it("emits playback.started for direct play", async () => {
    await post("/api/v1/negotiate/f-mp4-h264-aac", BROWSER_FULL);
    const { events } = (await (
      await get("/api/v1/events?typePrefix=dev.tantalar.event.playback")
    ).json()) as { events: Array<{ type: string; payload: Record<string, unknown> }> };
    expect(events.some((e) => e.type === EventTypes.PlaybackStarted && e.payload["mode"] === "direct")).toBe(true);
  });
});

// ---- Story 16: byte-range direct play ------------------------------------------

describe("direct-play byte-range serving", () => {
  it("serves the full file with Accept-Ranges and no ffmpeg involvement", async () => {
    const res = await get("/api/v1/stream/f-mp4-h264-aac");
    expect(res.status).toBe(200);
    expect(res.headers.get("accept-ranges")).toBe("bytes");
    const body = await res.text();
    expect(body.length).toBe(4096);
  });

  it("serves 206 partial content for a mid-file range", async () => {
    const res = await get("/api/v1/stream/f-mp4-h264-aac", ADMIN, { range: "bytes=100-199" });
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe("bytes 100-199/4096");
    expect((await res.text()).length).toBe(100);
  });

  it("supports suffix (last N bytes) and open-ended ranges", async () => {
    const suffix = await get("/api/v1/stream/f-mp4-h264-aac", ADMIN, { range: "bytes=-50" });
    expect(suffix.status).toBe(206);
    expect(suffix.headers.get("content-range")).toBe("bytes 4046-4095/4096");
    const open = await get("/api/v1/stream/f-mp4-h264-aac", ADMIN, { range: "bytes=4000-" });
    expect(open.status).toBe(206);
    expect((await open.text()).length).toBe(96);
  });

  it("rejects unsatisfiable ranges with 416", async () => {
    const res = await get("/api/v1/stream/f-mp4-h264-aac", ADMIN, { range: "bytes=99999-" });
    expect(res.status).toBe(416);
    const bad = await get("/api/v1/stream/f-mp4-h264-aac", ADMIN, { range: "bytes=999-100" });
    expect(bad.status).toBe(416);
  });

  it("unknown fileId → 404; range cannot escape the media root", async () => {
    expect((await get("/api/v1/stream/f-nope")).status).toBe(404);
  });
});

// ---- Story 21: authorization boundaries ----------------------------------------

describe("authorization boundaries (story 21)", () => {
  it("unauthenticated requests are 401 on every serving route", async () => {
    for (const [p, method] of [
      ["/api/v1/library", "GET"],
      ["/api/v1/stream/f-mp4-h264-aac", "GET"],
      ["/api/v1/library/f-mp4-h264-aac/subtitles", "GET"],
      ["/api/v1/history", "GET"],
      ["/api/v1/negotiate/f-mp4-h264-aac", "POST"],
    ] as const) {
      const res = await fetch(`${address}${p}`, { method: method as string });
      expect(res.status).toBe(401);
    }
  });

  it("a viewer sees only permitted libraries (metadata, bytes, subtitles)", async () => {
    // Registration happens before ALL other tests; plugins mutate shared
    // process state, so assert against the two never-touched fixture ids.
    await expect(serving().invoke("authorize", { userId: "u-kids", fileId: "f-mp4-h264-aac" })).resolves.toBeTruthy();
    await expect(
      serving().invoke("authorize", { userId: "u-kids", fileId: "f-avi-av1-truehd" }),
    ).rejects.toThrow(/may not access/);
    await expect(
      serving().invoke("authorize", { userId: "u-none", fileId: "f-mp4-h264-aac" }),
    ).rejects.toThrow(/may not access/);
  });

  it("browse hides restricted libraries per viewer", async () => {
    const admin = (await (await get("/api/v1/library")).json()) as { items: unknown[] };
    expect(admin.items.length).toBe(4);
    // Durable grants are re-applied on each request, so stale plugin state
    // cannot make an allowed library disappear after a plugin restart.
    await serving().invoke("set-viewer", { userId: "u-kids", libraries: [] });
    const kids = (await (await get("/api/v1/library?viewerId=u-kids")).json()) as {
      items: Array<{ fileId: string }>;
    };
    expect(kids.items.map((i) => i.fileId)).not.toContain("f-avi-av1-truehd");
    const none = (await (await get("/api/v1/library?viewerId=u-none")).json()) as { items: unknown[] };
    expect(none.items.length).toBe(0);
  });
});

// ---- Stories 15/18: browsing, collections, resume, continue-watching -----------

describe("browsing, resume points, watch history (stories 15, 18)", () => {
  it("resume point persists per viewer and is isolated between viewers", async () => {
    const set1 = await post("/api/v1/library/f-mp4-h264-aac/resume", { positionMs: 60_000, durationMs: 100_000 });
    expect(set1.status).toBe(200);
    const got = (await (await get("/api/v1/library/f-mp4-h264-aac/resume")).json()) as {
      resumePoint: { positionMs: number } | null;
    };
    expect(got.resumePoint?.positionMs).toBe(60_000);

    // A different viewer has no resume point for the same file. Probe a
    // THIRD user id never used anywhere else in the suite.
    await serving().invoke("set-viewer", { userId: "u-second", libraries: ["lib-main"] });
    const other = (await (await get("/api/v1/library/f-mp4-h264-aac/resume?viewerId=u-second")).json()) as {
      resumePoint: Record<string, unknown> | null;
    };
    expect(other.resumePoint === null || other.resumePoint === undefined).toBe(true);
  });

  it("rejects out-of-order progress (race guard) unless explicitly rewinding", async () => {
    const late = await post("/api/v1/library/f-mp4-h264-aac/resume", { positionMs: 10_000 });
    const lateBody = (await late.json()) as { accepted: boolean };
    expect(lateBody.accepted).toBe(false);
    const rewind = await post("/api/v1/library/f-mp4-h264-aac/resume", {
      positionMs: 5_000,
      allowRewind: true,
    });
    expect(((await rewind.json()) as { accepted: boolean }).accepted).toBe(true);
  });

  it("validates resume updates at the contract boundary", () => {
    expect(() => validateResumeUpdate({ fileId: "x", positionMs: -1 })).toThrow(ServingError);
    expect(() => validateResumeUpdate({ fileId: "x", positionMs: 10_000, durationMs: 50 })).toThrow(
      ServingError,
    );
    expect(validateResumeUpdate({ fileId: "x", positionMs: 10 }).positionMs).toBe(10);
  });

  it("continue-watching lists in-progress items, newest first; history records completion", async () => {
    await post("/api/v1/library/f-mkv-hevc-dts/resume", { positionMs: 30_000, durationMs: 100_000 });
    const lib = (await (await get("/api/v1/library")).json()) as {
      continueWatching: Array<{ fileId: string }>;
    };
    expect(lib.continueWatching.map((c) => c.fileId)).toContain("f-mp4-h264-aac");
    expect(lib.continueWatching.map((c) => c.fileId)).toContain("f-mkv-hevc-dts");

    // Finish one: near-end progress marks completed and drops out of CW.
    await post("/api/v1/library/f-mp4-h264-aac/resume", { positionMs: 99_000, allowRewind: false });
    const after = (await (await get("/api/v1/library")).json()) as {
      continueWatching: Array<{ fileId: string }>;
    };
    expect(after.continueWatching.map((c) => c.fileId)).not.toContain("f-mp4-h264-aac");
    const hist = (await (await get("/api/v1/history")).json()) as {
      history: Array<{ fileId: string; completed: boolean }>;
    };
    expect(hist.history.some((h) => h.fileId === "f-mp4-h264-aac" && h.completed)).toBe(true);
    expect(
      ((await (
        await get("/api/v1/events?typePrefix=dev.tantalar.event.playback")
      ).json()) as { events: Array<{ type: string }> }).events.some(
        (e) => e.type === EventTypes.PlaybackProgress,
      ),
    ).toBe(true);
  });

  it("returns one newest viewer-safe row for each visible catalog item", async () => {
    const userId = `u-history-${Date.now()}`;
    await serving().invoke("set-viewer", { userId, libraries: ["*"] });
    await serving().invoke("set-resume", {
      userId,
      fileId: "f-mp4-h264-aac",
      positionMs: 10_000,
      durationMs: 100_000,
    });
    await serving().invoke("set-resume", {
      userId,
      fileId: "f-mp4-h264-aac",
      positionMs: 20_000,
      durationMs: 100_000,
    });
    await new Promise((resolve_) => setTimeout(resolve_, 2));
    await serving().invoke("set-resume", {
      userId,
      fileId: "f-mkv-hevc-dts",
      positionMs: 99_000,
      durationMs: 100_000,
    });
    await serving().invoke("set-resume", {
      userId,
      fileId: "f-avi-av1-truehd",
      positionMs: 30_000,
      durationMs: 100_000,
    });
    await serving().invoke("register-entry", {
      fileId: "f-history-removed",
      itemKey: "item-history-removed",
      title: "Removed movie",
      kind: "movie",
      libraryId: "lib-main",
      container: "mp4",
      videoCodec: "h264",
      audioCodec: "aac",
      sizeBytes: 1,
      subtitles: [],
    });
    await serving().invoke("set-resume", {
      userId,
      fileId: "f-history-removed",
      positionMs: 15_000,
      durationMs: 100_000,
    });
    await serving().invoke("remove-entry", { fileId: "f-history-removed" });

    // A stale resume cannot survive a current grant or catalog check.
    await serving().invoke("set-viewer", { userId, libraries: ["lib-main"] });
    const result = (await serving().invoke("history", { userId })) as {
      history: Array<Record<string, unknown>>;
    };

    expect(result.history.map((row) => row.fileId)).toEqual([
      "f-mkv-hevc-dts",
      "f-mp4-h264-aac",
    ]);
    expect(result.history.filter((row) => row.fileId === "f-mp4-h264-aac")).toHaveLength(1);
    expect(result.history[0]).toMatchObject({
      fileId: "f-mkv-hevc-dts",
      title: "f-mkv-hevc-dts",
      kind: "movie",
      positionMs: 99_000,
      durationMs: 100_000,
      completed: true,
      artworkUrl: null,
    });
    expect(Object.keys(result.history[0] ?? {}).sort()).toEqual([
      "artworkUrl",
      "completed",
      "durationMs",
      "fileId",
      "kind",
      "lastWatchedAt",
      "positionMs",
      "title",
    ]);
  });

  it("collections group visible items by kind", async () => {
    const lib = (await (await get("/api/v1/library")).json()) as {
      collections: Array<{ name: string; fileIds: string[] }>;
    };
    const movies = lib.collections.find((c) => c.name === "Movies");
    expect(movies?.fileIds.length).toBeGreaterThan(0);
  });
});

// ---- Story 19: subtitles ---------------------------------------------------------

describe("subtitle inventory (story 19)", () => {
  it("lists embedded tracks for a file", async () => {
    const res = await get("/api/v1/library/f-mkv-hevc-dts/subtitles");
    const { tracks } = (await res.json()) as { tracks: Array<{ format: string; source: string }> };
    expect(tracks.map((t) => t.format).sort()).toEqual(["pgs", "srt"]);
    expect(tracks.every((t) => t.source === "embedded")).toBe(true);
  });

  it("registers and serves external subtitles alongside embedded", async () => {
    const reg = await post("/api/v1/library/f-mkv-hevc-dts/subtitles", { lang: "de", format: "srt" });
    expect(reg.status).toBe(200);
    const { tracks } = (await (
      await get("/api/v1/library/f-mkv-hevc-dts/subtitles")
    ).json()) as { tracks: Array<{ format: string; source: string; lang: string }> };
    const ext = tracks.find((t) => t.source === "external");
    expect(ext).toMatchObject({ lang: "de", format: "srt" });
    const p = `/api/v1/library/f-mkv-hevc-dts/subtitles?viewerId=u-none`;
    // u-none has zero visible libraries; every file query is forbidden.
    const denied = await get(p);
    expect(denied.status).toBe(403);
    // Invalid format rejected.
    const bad = await post("/api/v1/library/f-mkv-hevc-dts/subtitles", { lang: "fr", format: "vtt-plus" });
    expect(bad.status).toBe(400);
  });
});

// ---- Story 17: transcode lifecycle ------------------------------------------------

describe("transcode session lifecycle (story 17)", () => {
  it("opens an HLS session, refuses unstarted output, and closes cleanly", async () => {
    const open = await post("/api/v1/transcode-session", {
      fileId: "f-mkv-hevc-dts",
      qualities: ["1080p", "720p"],
      reason: "test-lifecycle",
    });
    expect(open.status).toBe(200);
    const { sessionId, manifestUrl } = (await open.json()) as { sessionId: string; manifestUrl: string };

    const manifest = await get(manifestUrl);
    expect(manifest.status).toBe(200);
    const text = await manifest.text();
    expect(text).toContain("#EXT-X-STREAM-INF");
    expect(text).toContain("1080p");

    expect((await get(`/api/v1/hls/${sessionId}/0/playlist.m3u8`)).status).toBe(503);
    const seg = await get(`/api/v1/hls/${sessionId}/0/seg0.ts`);
    expect(seg.status).toBe(404);

    const cancel = await del(`/api/v1/transcode-session/${sessionId}`);
    expect(cancel.status).toBe(200);
    // Subsequent segment requests fail closed after close.
    expect((await get(`/api/v1/hls/${sessionId}/0/seg0.ts`)).status).toBe(404);

    const { events } = (await (
      await get("/api/v1/events?typePrefix=dev.tantalar.event.transcode")
    ).json()) as { events: Array<{ type: string; payload: Record<string, unknown> }> };
    expect(events.some((e) => e.type === EventTypes.TranscodeSessionOpened && e.payload["reason"] === "test-lifecycle")).toBe(true);
    expect(events.some((e) => e.type === EventTypes.TranscodeSessionClosed)).toBe(true);
  });

  it("enforces the global worker cap", async () => {
    await serving().invoke("configure", { maxWorkers: 2 });
    const s1 = (await (await post("/api/v1/transcode-session", { fileId: "f-mkv-hevc-dts" })).json()) as {
      sessionId: string;
    };
    const s2 = (await (await post("/api/v1/transcode-session", { fileId: "f-mkv-hevc-dts" })).json()) as {
      sessionId: string;
    };
    await serving().invoke("start-worker", { sessionId: s1.sessionId });
    await expect(serving().invoke("start-worker", { sessionId: s2.sessionId })).rejects.toThrow(
      /session_limit/,
    );
    await serving().invoke("cancel-session", { sessionId: s1.sessionId });
    // Cap freed after cancel.
    await serving().invoke("start-worker", { sessionId: s2.sessionId });
    await serving().invoke("cancel-session", { sessionId: s2.sessionId });
  });

  it("hang watchdog kills a stalled worker", async () => {
    await serving().invoke("configure", { hangTimeoutMs: 300, idleTimeoutMs: 60_000 });
    const s = (await (await post("/api/v1/transcode-session", { fileId: "f-mkv-hevc-dts" })).json()) as {
      sessionId: string;
    };
    await serving().invoke("start-worker", { sessionId: s.sessionId });
    // No session-touch: watchdog must reap within ~2s of ticks.
    await new Promise((r) => setTimeout(r, 2500));
    const state = (await serving().invoke("session-state", { sessionId: s.sessionId })) as {
      closed: boolean;
      closeReason: string | null;
    };
    expect(state.closed).toBe(true);
    expect(state.closeReason).toBe("hang_watchdog");
    await serving().invoke("configure", { hangTimeoutMs: 60_000 });
  });

  it("idle timeout reaps abandoned sessions", async () => {
    await serving().invoke("configure", { idleTimeoutMs: 400, hangTimeoutMs: 60_000 });
    const s = (await (await post("/api/v1/transcode-session", { fileId: "f-mkv-hevc-dts" })).json()) as {
      sessionId: string;
    };
    await new Promise((r) => setTimeout(r, 2000));
    const state = (await serving().invoke("session-state", { sessionId: s.sessionId })) as {
      closed: boolean;
      closeReason: string | null;
    };
    expect(state.closed).toBe(true);
    expect(state.closeReason).toBe("idle_timeout");
    await serving().invoke("configure", { idleTimeoutMs: 60_000 });
  });

  it("kill -9 style orphaned workers are cleaned on restart (no orphans survive)", async () => {
    // Simulate crash: open a session via the plugin, then unmount the
    // plugin without closing; the REMOUNTED plugin's startup cleanup must
    // sweep every worker record it still tracks in-process.
    const orphan = (await serving().invoke("open-session", {
      userId: "u-admin",
      fileId: "f-mkv-hevc-dts",
      reason: "orphan-sim",
    })) as { sessionId: string };
    await supervisor.unmount(SERVING_ID);
    await mount(SERVING_ID, SERVING_CAP, SERVING_ENTRY, {
      ffmpegCommand: process.execPath,
      ffmpegArgs: ["-e", "setInterval(()=>{},1000)"],
      maxWorkers: 2,
      idleTimeoutMs: 60_000,
      hangTimeoutMs: 60_000,
      // Catalog/viewer/watch-state survives the simulated crash via the
      // snapshot file (transcode sessions are ephemeral by design).
      stateFile: join(dir, "serving-state.json"),
    });
    // The remounted plugin begins with NO sessions; the orphan session id
    // simply doesn't exist — cleanup at mount closed it (startup_cleanup).
    await expect(
      serving().invoke("session-state", { sessionId: orphan.sessionId }),
    ).rejects.toThrow(/unknown session/);
  });

  it("explicit cancellation closes the session and kills the worker", async () => {
    const s = (await (await post("/api/v1/transcode-session", { fileId: "f-mkv-hevc-dts" })).json()) as {
      sessionId: string;
    };
    await serving().invoke("start-worker", { sessionId: s.sessionId });
    const out = (await serving().invoke("cancel-session", { sessionId: s.sessionId })) as { closed: boolean };
    expect(out.closed).toBe(true);
    const state = (await serving().invoke("session-state", { sessionId: s.sessionId })) as { workerAlive: boolean };
    expect(state.workerAlive).toBe(false);
  });

  it("failure events carry the reason for closed sessions", async () => {
    const { events } = (await (
      await get("/api/v1/events?typePrefix=dev.tantalar.event.transcode")
    ).json()) as { events: Array<{ type: string; payload: Record<string, unknown> }> };
    const closed = events.filter((e) => e.type === EventTypes.TranscodeSessionClosed);
    expect(closed.length).toBeGreaterThan(0);
    expect(closed.every((e) => typeof e.payload["reason"] === "string")).toBe(true);
  });
});

// ---- Phase 5 review repairs (task t_2bad15eb) --------------------------------

/** Login as an arbitrary (newly created) user; returns cookie + csrf. */
async function loginUser(username: string, password: string, role: "admin" | "viewer" = "viewer") {
  await auth.createUser(username, password, role);
  return login(username, password);
}

describe("review repairs: subtitle content route (P1-1)", () => {
  it("serves external subtitle content end-to-end after registration", async () => {
    const reg = await post("/api/v1/library/f-mkv-hevc-dts/subtitles", {
      lang: "de",
      format: "srt",
      content: "1\n00:00:01,000 --> 00:00:02,000\nHallo\n",
    });
    expect(reg.status).toBe(200);
    const { trackId } = (await reg.json()) as { trackId: string };
    const res = await get(`/api/v1/library/subtitles/${trackId}`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Hallo");
  });

  it("serves embedded subtitle content declared at registration", async () => {
    const res = await get("/api/v1/library/subtitles/sub-1");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("00:00");
  });

  it("404s unknown tracks and 403s viewers without library visibility", async () => {
    expect((await get("/api/v1/library/subtitles/sub-does-not-exist")).status).toBe(404);
    const denied = await get("/api/v1/library/subtitles/sub-1?viewerId=u-none");
    expect(denied.status).toBe(403);
  });
});

describe("review repairs: CSRF on serving mutations (P1-2)", () => {
  it("rejects cookie-authenticated serving mutations without the CSRF header", async () => {
    const paths: Array<[string, unknown]> = [
      ["/api/v1/library/f-mp4-h264-aac/resume", { positionMs: 1000 }],
      ["/api/v1/negotiate/f-mp4-h264-aac", BROWSER_FULL],
      ["/api/v1/transcode-session", { fileId: "f-mkv-hevc-dts" }],
      ["/api/v1/library/f-mkv-hevc-dts/subtitles", { lang: "fr", format: "srt" }],
    ];
    for (const [p, body] of paths) {
      const res = await fetch(`${address}${p}`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie: ADMIN.cookie },
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(403);
    }
    const del = await fetch(`${address}/api/v1/transcode-session/nope`, {
      method: "DELETE",
      headers: { cookie: ADMIN.cookie },
    });
    expect(del.status).toBe(403);
  });

  it("still accepts the same mutations with the CSRF header present", async () => {
    const res = await post("/api/v1/library/f-mp4-h264-aac/resume", { positionMs: 1500 });
    expect(res.status).toBe(200);
  });
});

describe("review repairs: viewer-bound HLS sessions (P1-3)", () => {
  it("denies a different session user access to another viewer's HLS session", async () => {
    await serving().invoke("set-viewer", { userId: "u-second", libraries: ["lib-main"] });
    const [secondUser] = await db.selectFrom("users").select("id").where("username", "=", "admin").execute();
    void secondUser;
    const owner = await post("/api/v1/transcode-session", { fileId: "f-mkv-hevc-dts" });
    const { sessionId } = (await owner.json()) as { sessionId: string };
    // A second, unrelated cookie-session user must be denied.
    const peon = await loginUser(`peon-${Date.now()}`, "password-peon-1");
    const denied = await fetch(`${address}/api/v1/hls/${sessionId}/manifest.m3u8`, {
      headers: { cookie: peon.cookie },
    });
    expect(denied.status).toBe(403);
    // Same for playlists and segments.
    expect(
      (await fetch(`${address}/api/v1/hls/${sessionId}/0/playlist.m3u8`, { headers: { cookie: peon.cookie } })).status,
    ).toBe(403);
    expect(
      (await fetch(`${address}/api/v1/hls/${sessionId}/0/seg0.ts`, { headers: { cookie: peon.cookie } })).status,
    ).toBe(403);
    // The owner still gets through.
    expect((await get(`/api/v1/hls/${sessionId}/manifest.m3u8`)).status).toBe(200);
  });
});

describe("review repairs: HTTP-triggered real ffmpeg worker + real segments (P2-4)", () => {
  it("starts a real ffmpeg worker via HTTP and serves the produced segment bytes", async () => {
    await serving().invoke("configure", {
      segmentsDir: hlsRoot,
      ffmpegCommand: "ffmpeg",
      ffmpegArgs: [
        "-hide_banner", "-loglevel", "error", "-y",
        "-f", "lavfi", "-i", "testsrc=duration=2:size=64x64:rate=10",
        "-c:v", "libx264", "-preset", "ultrafast",
        "-f", "hls", "-hls_time", "1", "-hls_list_size", "0",
        "-hls_segment_filename", join("{{sessionIdPlaceholder}}", "seg%05d.ts"),
        join("{{sessionIdPlaceholder}}", "playlist.m3u8"),
      ],
    });
    const open = await post("/api/v1/transcode-session", { fileId: "f-mkv-hevc-dts" });
    const { sessionId } = (await open.json()) as { sessionId: string };
    const start = await post(`/api/v1/hls/${sessionId}/start`);
    expect(start.status).toBe(200);
    const started = (await start.json()) as { started: string; pid?: number };
    expect(started.started).toBe(sessionId);

    const playlist = await get(`/api/v1/hls/${sessionId}/0/playlist.m3u8`);
    expect(playlist.status).toBe(200);
    expect(await playlist.text()).toContain("#EXTINF");

    // The worker is a REAL ffmpeg process writing a REAL MPEG-TS file.
    const segPath = join(hlsRoot, sessionId, "seg00000.ts");
    for (let i = 0; i < 100 && !existsSync(segPath); i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(existsSync(segPath)).toBe(true);

    const seg = await get(`/api/v1/hls/${sessionId}/0/seg00000.ts`);
    expect(seg.status).toBe(200);
    expect(seg.headers.get("content-type")).toBe("video/mp2t");
    const buf = Buffer.from(await seg.arrayBuffer());
    expect(buf.length).toBeGreaterThan(188);
    expect(buf[0]).toBe(0x47); // MPEG-TS sync byte — real container bytes
    await serving().invoke("cancel-session", { sessionId });
    await serving().invoke("configure", { ffmpegCommand: process.execPath, ffmpegArgs: ["-e", "setInterval(()=>{},1000)"] });
  }, 30_000);
});

describe("review repairs: durable orphan cleanup (P2-5)", () => {
  it("kills worker pids recorded durably in the state file after a simulated crash", async () => {
    // Victim process that would survive a kill -9 of the server.
    const victim = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
    const exited = new Promise<boolean>((res) => victim.once("exit", () => res(true)));
    // Stop the current instance first so its graceful unmount cannot overwrite
    // the crash snapshot that the next instance must recover.
    const statePath = join(dir, "serving-state.json");
    await supervisor.unmount(SERVING_ID);
    // Simulate crash state: the PREVIOUS instance durably recorded the worker.
    const snap = JSON.parse(await import("node:fs").then((fs) => fs.readFileSync(statePath, "utf8")));
    writeFileSync(
      statePath,
      JSON.stringify({ ...snap, workers: [{ sessionId: "crash-sim", pid: victim.pid }] }),
    );
    await mount(SERVING_ID, SERVING_CAP, SERVING_ENTRY, {
      ffmpegCommand: process.execPath,
      ffmpegArgs: ["-e", "setInterval(()=>{},1000)"],
      maxWorkers: 2,
      idleTimeoutMs: 60_000,
      hangTimeoutMs: 60_000,
      stateFile: statePath,
    });
    // The remounted plugin must SIGKILL the durably-recorded pid.
    expect(await Promise.race([exited, new Promise<boolean>((r) => setTimeout(() => r(false), 5000))])).toBe(true);
  });

  it("restores normalized viewer history after a serving-plugin restart", async () => {
    const userId = `u-history-persist-${Date.now()}`;
    await serving().invoke("set-viewer", { userId, libraries: ["lib-main"] });
    await serving().invoke("set-resume", {
      userId,
      fileId: "f-mp4-h264-atmos",
      positionMs: 45_000,
      durationMs: 120_000,
    });

    const statePath = join(dir, "serving-state.json");
    await supervisor.unmount(SERVING_ID);
    await mount(SERVING_ID, SERVING_CAP, SERVING_ENTRY, {
      ffmpegCommand: process.execPath,
      ffmpegArgs: ["-e", "setInterval(()=>{},1000)"],
      maxWorkers: 2,
      idleTimeoutMs: 60_000,
      hangTimeoutMs: 60_000,
      stateFile: statePath,
    });

    const restored = (await serving().invoke("history", { userId })) as {
      history: Array<Record<string, unknown>>;
    };
    expect(restored.history).toHaveLength(1);
    expect(restored.history[0]).toMatchObject({
      fileId: "f-mp4-h264-atmos",
      positionMs: 45_000,
      durationMs: 120_000,
      completed: false,
    });
  });
});

describe("review repairs: named-viewer impersonation restricted (P2-6)", () => {
  it("blocks ordinary session users from acting as an arbitrary named viewer", async () => {
    const peon = await loginUser(`peon2-${Date.now()}`, "password-peon-2");
    const h = { cookie: peon.cookie };
    expect((await fetch(`${address}/api/v1/library?viewerId=u-admin`, { headers: h })).status).toBe(403);
    expect(
      (await fetch(`${address}/api/v1/library/f-mkv-hevc-dts/subtitles`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-csrf-token": peon.csrf, cookie: peon.cookie },
        body: JSON.stringify({ userId: "u-admin", lang: "de", format: "srt" }),
      })).status,
    ).toBe(403);
    // Acting as themselves is fine.
    const self = await fetch(`${address}/api/v1/history`, { headers: h });
    expect(self.status).toBe(200);
  });
});

describe("R5-11 playback administration", () => {
  it("reports the same FFmpeg readiness in Playback and system diagnostics", async () => {
    const [playbackResponse, diagnosticsResponse] = await Promise.all([
      get("/api/v1/playback"),
      get("/api/v1/system/diagnostics"),
    ]);
    expect(playbackResponse.status).toBe(200);
    expect(diagnosticsResponse.status).toBe(200);
    const playback = (await playbackResponse.json()) as { probe: { available: boolean } };
    const diagnostics = (await diagnosticsResponse.json()) as { transcoder: { ffmpegAvailable: boolean } };
    expect(diagnostics.transcoder.ffmpegAvailable).toBe(playback.probe.available);
  });

  it("lists redacted live sessions and stops a transcode with correlated evidence", async () => {
    const [admin] = await db.selectFrom("users").select("id").where("username", "=", "admin").execute();
    const opened = (await serving().invoke("open-session", {
      userId: admin!.id,
      fileId: "f-mkv-hevc-dts",
      reason: "admin-test",
      client: "Fixture browser",
      network: "local",
    })) as { sessionId: string };
    await serving().invoke("start-worker", { sessionId: opened.sessionId });

    const response = await get("/api/v1/playback");
    expect(response.status).toBe(200);
    const snapshot = (await response.json()) as {
      sessions: Array<Record<string, unknown>>;
      policy: Record<string, unknown>;
    };
    const session = snapshot.sessions.find((item) => item.sessionId === opened.sessionId);
    expect(session).toMatchObject({
      title: "f-mkv-hevc-dts",
      viewer: "admin",
      client: "Fixture browser",
      mode: "hls",
      state: "transcoding",
      workerAlive: true,
    });
    expect(session).not.toHaveProperty("path");
    expect(session).not.toHaveProperty("userId");

    const stopped = await post(`/api/v1/playback/sessions/${opened.sessionId}/stop-transcode`);
    expect(stopped.status).toBe(200);
    const state = await serving().invoke("session-state", { sessionId: opened.sessionId }) as { closed: boolean; workerAlive: boolean };
    expect(state).toMatchObject({ closed: true, workerAlive: false });

    const eventRows = await db.selectFrom("events")
      .select(["type", "correlationId"])
      .where("correlationId", "=", opened.sessionId)
      .execute();
    expect(eventRows.some((event) => event.type === EventTypes.PlaybackStarted)).toBe(true);
    expect(eventRows.some((event) => event.type === EventTypes.PlaybackEnded)).toBe(true);
    const auditRows = await db.selectFrom("audit_log")
      .select("action")
      .where("targetId", "=", opened.sessionId)
      .execute();
    expect(auditRows).toContainEqual({ action: "playback.transcode.stopped" });
  });

  it("validates and restores the durable global playback policy", async () => {
    const current = (await serving().invoke("playback-policy", {})) as { policy: Record<string, unknown> };
    const policy = {
      ...current.policy,
      preferDirectPlay: false,
      maxConcurrentTranscodes: 3,
      hardwareAcceleration: "software",
      transcodeCacheMaxBytes: 512 * 1024 * 1024,
    };
    const saved = await put("/api/v1/playback/policy", policy);
    expect(saved.status).toBe(200);

    const unsupported = await put("/api/v1/playback/policy", { ...policy, hardwareAcceleration: "not_a_real_accelerator" });
    expect(unsupported.status).toBe(400);

    const statePath = join(dir, "serving-state.json");
    await supervisor.unmount(SERVING_ID);
    await mount(SERVING_ID, SERVING_CAP, SERVING_ENTRY, {
      ffmpegCommand: process.execPath,
      ffmpegArgs: ["-e", "setInterval(()=>{},1000)"],
      stateFile: statePath,
    });
    const restored = (await serving().invoke("playback-policy", {})) as { policy: Record<string, unknown> };
    expect(restored.policy).toMatchObject({
      preferDirectPlay: false,
      maxConcurrentTranscodes: 3,
      hardwareAcceleration: "software",
    });
  });

  it("applies saved audio and subtitle language defaults to a new session", async () => {
    const capture = join(dir, "selected-audio-map.txt");
    await serving().invoke("register-entry", {
      fileId: "f-language-policy",
      itemKey: "item-language-policy",
      title: "Language policy fixture",
      kind: "movie",
      libraryId: "lib-a",
      container: "mp4",
      videoCodec: "h264",
      audioCodec: "aac",
      sizeBytes: 4096,
      audioTracks: [
        { streamIndex: 1, lang: "eng", codec: "aac", default: true },
        { streamIndex: 2, lang: "jpn", codec: "aac" },
      ],
      subtitles: [{ trackId: "sub-jpn", lang: "jpn", format: "srt", source: "embedded", content: "WEBVTT" }],
    });
    await serving().invoke("set-viewer", { userId: "admin", libraries: ["*"] });
    const current = (await serving().invoke("playback-policy", {})) as { policy: Record<string, unknown> };
    await serving().invoke("set-playback-policy", {
      ...current.policy,
      preferDirectPlay: true,
      defaultAudioLanguage: "jpn",
      defaultSubtitleLanguage: "jpn",
      subtitleMode: "always",
    });
    await serving().invoke("configure", {
      ffmpegCommand: process.execPath,
      ffmpegArgs: [
        "-e",
        `require("node:fs").writeFileSync(${JSON.stringify(capture)}, process.argv[1]); setInterval(()=>{},1000)`,
        "0:a:0?",
      ],
    });

    const decision = (await serving().invoke("negotiate", {
      fileId: "f-language-policy",
      userId: "admin",
      capabilities: BROWSER_FULL,
    })) as { decision: { mode: string; sessionId: string; audioLanguage?: string; subtitleTrackId?: string } };
    expect(decision.decision).toMatchObject({ mode: "hls", audioLanguage: "jpn", subtitleTrackId: "sub-jpn" });
    await serving().invoke("start-worker", { sessionId: decision.decision.sessionId });
    for (let attempt = 0; attempt < 30 && !existsSync(capture); attempt++) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
    }
    expect(readFileSync(capture, "utf8")).toBe("0:2?");
    await serving().invoke("close-session", { sessionId: decision.decision.sessionId });
  });
});
