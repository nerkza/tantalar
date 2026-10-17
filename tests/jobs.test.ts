import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, rename, readdir, symlink, rm, lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { migrate, openDatabase, PluginDocumentStore, DownloadJobStore, ReleaseDecisionStore, type Db } from "@tantalar/db";
import type { Kysely } from "kysely";
import { Scheduler, nextRunAt } from "../apps/server/src/scheduler.js";
import { EventBus } from "../apps/server/src/events.js";
import { registerJobRoutes } from "../apps/server/src/job-routes.js";
import { QualitySettings, defaultQualityConfiguration, qualityUpgradeReason } from "../apps/server/src/quality-settings.js";
import { compareReleases } from "../apps/server/src/acquisition/comparer.js";
import { runAutomaticAcquisition } from "../apps/server/src/acquisition/managed-search.js";
import { ServiceContainer } from "../apps/server/src/container.js";
import { preserveReplacedFile, recycleEntries, cleanupRecycleBin } from "../plugins/library/src/recycle-bin.js";

let db: Kysely<Db>, scheduler: Scheduler, root: string;
const Fastify = createRequire(new URL("../apps/server/package.json", import.meta.url))("fastify");
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "tantalar-jobs-"));
  db = await openDatabase({ dialect: "sqlite", sqlitePath: join(root, "jobs.db") });
  await migrate(db);
  scheduler = new Scheduler(db, 1000, new EventBus(db));
});
afterEach(async () => { scheduler.stop(); await scheduler.drain(); await db.destroy(); await rm(root, { recursive: true, force: true }); });

describe("job execution and control", () => {
  it("advances bounded wanted searches past titles with provider failures, including after restart", async () => {
    const container = new ServiceContainer();
    const seen: string[] = [];
    container.register({ pluginId: "test.movies", capability: "dev.tantalar.capability.automation.movies", async invoke(operation, payload) {
      if (operation === "scan") return { wanted: ["a", "b", "c"].map(movieId => ({ movieId })) };
      seen.push(String(payload.movieId));
      throw new Error("Provider unavailable");
    } });
    for (let i = 0; i < 4; i++) await runAutomaticAcquisition(container, new ReleaseDecisionStore(db), new DownloadJobStore(db), new EventBus(db), 1, undefined, undefined, new PluginDocumentStore(db));
    expect(seen).toEqual(["a", "b", "c", "a"]);
  });
  it("rejects invalid schedules and preserves a daily UTC boundary", () => {
    for (const value of ["every 0s", "every 999999999999h", "daily 24:00", "daily 03:60", "every -1m"]) expect(nextRunAt(value)).toBeNull();
    expect(nextRunAt("daily 03:00", new Date("2026-10-25T03:00:00Z"))?.toISOString()).toBe("2026-10-26T03:00:00.000Z");
  });
  it("claims one run across concurrent ticks and keeps an operator disable made during execution", async () => {
    let release!: () => void, entered!: () => void;
    const started = new Promise<void>(r => { entered = r; });
    const held = new Promise<void>(r => { release = r; });
    let calls = 0;
    const key = await scheduler.declareJob("test", "scan", "every 1h", async () => { calls++; entered(); await held; return { outcome: "Scanned", counts: { scanned: 3 } }; });
    await db.updateTable("scheduler_jobs").set({ nextRunAt: "2020-01-01T00:00:00Z" }).where("jobKey", "=", key).execute();
    const first = scheduler.tick(); await started;
    expect(await scheduler.tick()).toBe(0);
    await expect(scheduler.dispatch(key)).rejects.toThrow("already running");
    await scheduler.updateJob(key, { enabled: false }); release(); await first;
    expect(calls).toBe(1);
    const job = (await scheduler.listJobs())[0]!;
    expect(job.nextRunAt).toBeNull(); expect(job.latestRun?.state).toBe("succeeded");
    expect(JSON.parse(job.latestRun!.details!).counts.scanned).toBe(3);
    await scheduler.declareJob("test", "scan", "every 1h", () => undefined);
    expect((await scheduler.listJobs())[0]!.enabled).toBe(0);
  });
  it("returns a durable run before completion and links retry to the failed run", async () => {
    let release!: () => void;
    const held = new Promise<void>(r => { release = r; });
    const key = await scheduler.declareJob("test", "slow", "every 1h", async () => { await held; throw new Error("token=secret https://private.invalid/?apikey=secret"); });
    const id = await scheduler.dispatch(key);
    expect((await scheduler.listRuns(key)).runs[0]?.state).toBe("running");
    release(); await scheduler.drain();
    const failed = (await scheduler.listRuns(key)).runs[0]!;
    expect(failed.error).not.toContain("token=secret"); expect(failed.error).not.toContain("private.invalid");
    await scheduler.declareJob("test", "slow", "every 1h", () => ({ outcome: "Recovered" }));
    const retry = await scheduler.retryRun(id); await scheduler.drain();
    expect((await scheduler.listRuns(key)).runs.find(r => r.id === retry)).toMatchObject({ state: "succeeded", trigger: "retry", retryOf: id });
  });
  it("preserves overdue work on declaration and marks interrupted work at startup", async () => {
    const key = await scheduler.declareJob("test", "restart", "every 1h", () => undefined);
    await db.updateTable("scheduler_jobs").set({ nextRunAt: "2020-01-01T00:00:00Z", lockedAt: "2020-01-01T00:00:00Z" }).where("jobKey", "=", key).execute();
    await db.insertInto("scheduler_runs").values({ id: "old", pluginId: "test", jobKey: key, startedAt: "2020-01-01T00:00:00Z", finishedAt: null, state: "running", outcome: null, error: null, durationMs: null }).execute();
    const restarted = new Scheduler(db);
    await restarted.recoverInterrupted(); await restarted.declareJob("test", "restart", "every 1h", () => undefined);
    expect((await restarted.listJobs())[0]!.nextRunAt).toBe("2020-01-01T00:00:00Z");
    expect((await restarted.listRuns(key)).runs[0]!.state).toBe("interrupted");
    expect(await restarted.tick()).toBe(1);
  });
  it("protects system schedules and filters paginated run history through the API guard", async () => {
    const key = await scheduler.declareJob("test", "service", "every 2s", () => ({ outcome: "Synced" }), { protected: true, name: "Reconciliation" });
    await scheduler.runNow(key); await scheduler.runNow(key);
    const app = Fastify();
    registerJobRoutes(app, scheduler, async (req, reply) => {
      if (req.headers.authorization !== "admin") { reply.code(403).send({ error: "admin only" }); return null; }
      return { userId: "admin" };
    });
    try {
      expect((await app.inject({ url: "/api/v1/jobs" })).statusCode).toBe(403);
      const response = await app.inject({ url: "/api/v1/jobs/runs?search=reconciliation&filter_state=succeeded&pageSize=1&page=2", headers: { authorization: "admin" } });
      expect(response.json().total).toBe(2); expect(response.json().runs).toHaveLength(1);
      expect((await app.inject({ method: "PATCH", url: `/api/v1/jobs/${encodeURIComponent(key)}`, headers: { authorization: "admin" }, payload: { enabled: false } })).statusCode).toBe(409);
    } finally { await app.close(); }
  });
});

it("applies Arr-style cutoff and runtime size rules without using size as an upgrade trigger", async () => {
  const quality = new QualitySettings(db);
  const settings = defaultQualityConfiguration();
  await quality.save(settings);
  const profile = await quality.effective({ name: "hd", preferredQualities: ["1080p", "720p"] }, "series", 45);
  expect(qualityUpgradeReason(profile, "720p", "1080p")).toBeNull();
  expect(qualityUpgradeReason(profile, "1080p", "1080p")).toContain("cutoff");
  expect(qualityUpgradeReason({ ...profile, upgradeAllowed: false }, "720p", "1080p")).toContain("disabled");
  const release = (guid: string, mb: number) => ({ quality: "1080p", properOrRepack: false, release: { guid, title: "Example 1080p", kind: "nzb" as const, indexerId: "fixture", publishedAt: "2026-01-01", sizeBytes: mb * 1048576, downloadUrl: "https://fixtures.invalid/release" } });
  const result = compareReleases({ profile, candidates: [release("small", 1), release("large", 6000), release("target", 4275), release("acceptable", 3000)] });
  expect(result.winnerGuid).toBe("target");
  expect(result.rejected.map(r => r.reason)).toEqual(expect.arrayContaining(["size_below_minimum", "size_exceeds_limit"]));
  expect(compareReleases({ profile: { ...profile, installedQuality: "1080p" }, candidates: [release("smaller", 3000)] }).winnerGuid).toBeNull();
  settings.profiles[0]!.cutoff = "invalid";
  await expect(quality.save(settings)).rejects.toThrow("cutoff");
});

it("preserves replaced bytes and cleans only expired, unchanged recycle entries", async () => {
  const library = join(root, "library"); await mkdir(library);
  const file = join(library, "movie.mkv"); await writeFile(file, "old bytes");
  const entry = preserveReplacedFile(library, file);
  await writeFile(join(library, "staging"), "new bytes"); await rename(join(library, "staging"), file);
  expect(await readFile(join(entry, "file"), "utf8")).toBe("old bytes");
  expect(cleanupRecycleBin([library], 7).removed).toBe(0);
  const metaPath = join(entry, "entry.json"); const meta = JSON.parse(await readFile(metaPath, "utf8"));
  await writeFile(metaPath, JSON.stringify({ ...meta, recycledAt: "2020-01-01T00:00:00Z" }));
  const entries = recycleEntries([library], 7);
  expect(entries[0]!.expired).toBe(true);
  expect(cleanupRecycleBin([library], 0).removed).toBe(0);
  expect(cleanupRecycleBin([library], 7, [{ id: entries[0]!.id, fingerprint: "changed" }]).removed).toBe(0);
  expect(cleanupRecycleBin([library], 7, entries).removed).toBe(1);
  expect(await readFile(file, "utf8")).toBe("new bytes");
  const outside = join(root, "outside"); await mkdir(outside); await writeFile(join(outside, "keep"), "keep");
  await symlink(outside, join(library, ".tantalar-recycle", "00000000-0000-0000-0000-000000000000"));
  expect(cleanupRecycleBin([library], 7).removed).toBe(0);
  expect(await readdir(outside)).toEqual(["keep"]);
  expect((await lstat(file)).isFile()).toBe(true);
});
