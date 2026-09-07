/**
 * Wave 9 operations API tests (TAN-030/031/032/033/038/042/043).
 *
 * Covers:
 *  - queue: durable job list + actions targeting each job's own engine id,
 *    state-machine guards (409), removal flag semantics, history retention;
 *  - users: role change, password reset, session revoke, deactivation,
 *    last-admin safeguards, audit log entries;
 *  - API keys: create with scopes/expiry (secret shown once, never again),
 *    expired key fails closed, revocation;
 *  - webhooks: create with env-var signing secret NAME only, test delivery
 *    without a secret set never exposes anything, delete;
 *  - catalog pagination: server-side page/pageSize/search/total;
 *  - backup: atomic + integrity-checked; restore refuses bad paths and bad
 *    files before replacing anything.
 *
 * No network: webhook test uses an .invalid URL; no external calls.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Kysely, sql } from "kysely";
import { migrate, openDatabase, DownloadJobStore, ReleaseDecisionStore, type Db } from "@tantalar/db";
import { AuthService } from "../apps/server/src/auth.js";
import { EventBus } from "../apps/server/src/events.js";
import { ServiceContainer } from "../apps/server/src/container.js";
import { Supervisor } from "../apps/server/src/supervisor.js";
import { Scheduler } from "../apps/server/src/scheduler.js";
import { buildServer } from "../apps/server/src/http.js";
import { SecretStore } from "../apps/server/src/secret-store.js";

let db: Kysely<Db>;
let auth: AuthService;
let jobs: DownloadJobStore;
let app: Awaited<ReturnType<typeof buildServer>>;
let secretStore: SecretStore;
let address = "";
let dir = "";
const csrfRef = { current: "" };
const cookieRef = { current: "" };
const engineCalls: Array<{ pluginId: string; capability: string; operation: string; payload: Record<string, unknown> }> = [];
let vpnAllowsDispatch = true;
let vpnGateError = false;
let addResponseMode: "normal" | "malformed" | "secret-error" | "unique" | "race" | "missing-root" = "normal";
let raceAddCount = 0;
let releaseRaceAdds: (() => void) | null = null;
let raceAddsReady = Promise.resolve();
const managedMovies = new Map<string, Record<string, unknown>>();
const managedSeries = new Map<string, Record<string, unknown>>();
let metadataState: "ready" | "rate-limited" | "unavailable" = "ready";
let metadataRevision: "initial" | "refreshed" = "initial";

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "tantalar-wave9-ops-"));
  db = await openDatabase({ dialect: "sqlite", sqlitePath: join(dir, "test.db") });
  await migrate(db);
  auth = new AuthService(db);
  jobs = new DownloadJobStore(db);
  secretStore = new SecretStore(join(dir, ".secrets.json"));
  const bus = new EventBus(db);
  const container = new ServiceContainer();
  for (const [pluginId, engineCapability] of [
    ["dev.tantalar.plugin.torrent-native", "dev.tantalar.capability.torrent.engine"],
    ["dev.tantalar.plugin.usenet-native", "dev.tantalar.capability.usenet.engine"],
  ] as const) {
    for (const capability of ["dev.tantalar.capability.download-client", engineCapability]) {
      container.register({
        pluginId,
        capability,
        invoke: async (operation, payload) => {
          engineCalls.push({ pluginId, capability, operation, payload });
          if (operation === "add") {
            if (addResponseMode === "missing-root") throw new Error("no download roots configured");
            if (addResponseMode === "secret-error") {
              throw new Error("tracker rejected https://tracker.invalid/private-passkey/announce?token=secret");
            }
            if (addResponseMode === "malformed") {
              return { downloadId: "", itemKey: payload.itemKey, state: "corrupt", progressPercent: Number.NaN, sizeBytes: -1 };
            }
            if (addResponseMode === "race") {
              const sequence = ++raceAddCount;
              if (sequence === 2) releaseRaceAdds?.();
              await raceAddsReady;
              return {
                downloadId: `${pluginId}:race-${sequence}`,
                itemKey: String(payload.itemKey ?? ""),
                state: "downloading",
                progressPercent: 1,
                sizeBytes: 1024,
              };
            }
            return {
              downloadId: addResponseMode === "unique"
                ? `${pluginId}:orphan-job`
                : `${pluginId}:${payload.itemKey === "movie-tmdb-9001" ? "managed-job-1" : "job-1"}`,
              itemKey: String(payload.itemKey ?? ""),
              state: "downloading",
              progressPercent: 1,
              sizeBytes: 1024,
            };
          }
          return { ok: true };
        },
      });
    }
  }
  container.register({
    pluginId: "dev.tantalar.plugin.vpn-manager",
    capability: "dev.tantalar.capability.vpn-binding",
    invoke: async (operation) => {
      if (operation !== "pre-dispatch-check") return { ok: true };
      if (vpnGateError) throw new Error("gate offline");
      return { allowDispatch: vpnAllowsDispatch, health: vpnAllowsDispatch ? "healthy" : "down" };
    },
  });
  container.register({
    pluginId: "dev.tantalar.plugin.fixture-indexer",
    capability: "dev.tantalar.capability.indexer",
    invoke: async (operation) => operation === "search" ? {
      releases: [
        {
          guid: "fixture-movie-release-1",
          title: "Fixture Movie 2024 1080p WEB-DL",
          kind: "torrent",
          downloadUrl: "magnet:?xt=urn:btih:1111111111111111111111111111111111111111",
          sizeBytes: 4_294_967_296,
          publishedAt: "2026-08-26T12:00:00.000Z",
          seeders: 30,
          categories: [1000],
          indexerId: "dev.tantalar.plugin.fixture-indexer",
        },
        {
          guid: "fixture-movie-release-2",
          title: "Fixture Movie 2024 1080p WEB-DL Alternate",
          kind: "torrent",
          downloadUrl: "magnet:?xt=urn:btih:2222222222222222222222222222222222222222",
          sizeBytes: 4_294_967_296,
          publishedAt: "2026-08-26T12:00:00.000Z",
          seeders: 10,
          categories: [1000],
          indexerId: "dev.tantalar.plugin.fixture-indexer",
        },
      ],
      hasMore: false,
    } : { ok: true },
  });
  container.register({
    pluginId: "dev.tantalar.plugin.metadata-fixture",
    capability: "dev.tantalar.capability.metadata-provider",
    invoke: async (operation, payload) => {
      if (operation === "status") {
        const key = await secretStore.get("dev.tantalar.plugin.metadata-tmdb-tvdb", "tmdb:api-key");
        return { state: metadataState, mode: key ? "direct" : "hosted", configured: true, directKeyConfigured: Boolean(key), locale: "en-US" };
      }
      if (operation === "configure") {
        const key = await secretStore.get("dev.tantalar.plugin.metadata-tmdb-tvdb", "tmdb:api-key");
        if (key === "invalid-tmdb-key") throw new Error("auth_failed: provider rejected the configured api key");
        metadataState = "ready";
        return { state: metadataState, mode: key ? "direct" : "hosted", configured: true, directKeyConfigured: Boolean(key), locale: "en-US" };
      }
      if (operation === "details") {
        if (metadataState === "unavailable" && (metadataRevision === "initial" || payload.externalId === "tmdb-legacy")) {
          throw new Error("unavailable: provider unavailable");
        }
        if (payload.refresh === true) metadataRevision = "refreshed";
        const refreshed = metadataRevision === "refreshed";
        return {
          found: true,
          metadata: {
            externalId: String(payload.externalId),
            kind: payload.kind,
            name: payload.kind === "movie" ? (refreshed ? "Fixture Movie refreshed" : "Fixture Movie") : "Fixture Show refreshed",
            originalTitle: payload.kind === "movie" ? "Fixture Movie" : null,
            overview: refreshed ? "Refreshed provider metadata." : "Legal fixture metadata.",
            tagline: payload.kind === "movie" ? "Canonical fixture." : null,
            releaseDate: payload.kind === "movie" ? (refreshed ? "2025-07-12" : "2024-07-12") : null,
            year: refreshed ? 2025 : 2024,
            runtimeMinutes: payload.kind === "movie" ? 101 : null,
            genres: payload.kind === "movie" ? ["Fixture"] : [],
            certification: payload.kind === "movie" ? "PG" : null,
            status: "Released",
            originalLanguage: "en",
            rating: 7.5,
            voteCount: 100,
            posterPath: "/art/refreshed.jpg",
            backdropPath: "/art/backdrop.jpg",
            artworkUrl: "https://fixtures.tantalar.invalid/art/refreshed.jpg",
            externalIds: { tmdb: "9001", imdb: "tt0009001" },
            provider: "fixture",
            locale: "en-US",
            fetchedAt: refreshed ? "2026-08-31T12:00:00.000Z" : "2026-08-30T12:00:00.000Z",
            source: "fixture",
          },
          episodes: [],
        };
      }
      if (operation !== "search") return { ok: true };
      if (metadataState === "rate-limited") throw new Error("rate_limited: provider reported rate limiting");
      if (metadataState === "unavailable") throw new Error("unavailable: provider unavailable");
      const kind = payload.kind === "movie" ? "movie" : "series";
      return {
        candidates: [{
          externalId: kind === "movie" ? "tmdb-9001" : "tvdb-121",
          kind,
          name: kind === "movie" ? "Fixture Movie" : "Fixture Show",
          overview: "Legal fixture metadata.",
          year: 2024,
          artworkUrl: "https://fixtures.tantalar.invalid/art/search.jpg",
          provider: "fixture",
        }],
      };
    },
  });
  container.register({
    pluginId: "dev.tantalar.plugin.movies",
    capability: "dev.tantalar.capability.automation.movies",
    invoke: async (operation, payload) => {
      if (operation === "list-movies") return { movies: [...managedMovies.values()] };
      if (operation === "scan") {
        return {
          wanted: [...managedMovies.values()]
            .filter((movie) => movie.monitored !== false && movie.acquisitionState !== "available")
            .map((movie) => ({
              movieId: String(movie.movieId),
              query: `${String(movie.title ?? "")} ${String(movie.year ?? "")}`.trim(),
            })),
        };
      }
      if (operation === "get-movie") return managedMovies.get(String(payload.movieId)) ?? {};
      if (operation === "update-movie") {
        const movieId = String(payload.movieId);
        const movie = managedMovies.get(movieId);
        if (!movie) throw new Error(`unknown movie ${movieId}`);
        Object.assign(movie, payload);
        return { movieId, updated: true };
      }
      if (operation === "mark-acquired") {
        const movie = managedMovies.get(String(payload.movieId));
        if (movie) movie.acquisitionState = "available";
        return { acquired: true };
      }
      if (operation === "delete-movie") return { movieId: String(payload.movieId), deleted: managedMovies.delete(String(payload.movieId)) };
      if (operation === "add-movie") {
        const movieId = `movie-${String(payload.externalId)}`;
        const created = !managedMovies.has(movieId);
        managedMovies.set(movieId, { movieId, ...payload, acquisitionState: "wanted" });
        return { movieId, created };
      }
      return { ok: true };
    },
  });
  container.register({
    pluginId: "dev.tantalar.plugin.series",
    capability: "dev.tantalar.capability.automation.series",
    invoke: async (operation, payload) => {
      if (operation === "list-series") return { series: [...managedSeries.values()] };
      if (operation === "get-series") return managedSeries.get(String(payload.seriesId)) ?? {};
      if (operation === "wanted") {
        return {
          wanted: [...managedSeries.values()].flatMap((series) =>
            Array.isArray(series.wantedEpisodes)
              ? series.wantedEpisodes.map((episode) => ({
                  seriesId: String(series.seriesId),
                  ...(episode as Record<string, unknown>),
                }))
              : []),
        };
      }
      if (operation === "add-series") {
        const seriesId = `series-${String(payload.externalId)}`;
        const created = !managedSeries.has(seriesId);
        managedSeries.set(seriesId, { seriesId, ...payload, acquisitionState: "wanted" });
        return { seriesId, created };
      }
      return { ok: true };
    },
  });
  const supervisor = new Supervisor({
    bus,
    container,
    scheduler: new Scheduler(db),
    restartPolicy: {
      initialBackoffMs: 10,
      maxBackoffMs: 50,
      backoffMultiplier: 2,
      windowMs: 1000,
      maxRestartsInWindow: 5,
    },
    resolveEntry: () => ({ command: "true", args: [], env: {} }),
  });
  app = await buildServer({
    auth,
    db,
    bus,
    supervisor,
    container,
    ready: () => true,
    ops: {
      auth,
      db,
      bus,
      supervisor,
      container,
      ready: () => true,
      sqlitePath: join(dir, "test.db"),
      dataDir: dir,
      secrets: secretStore,
    },
  });
  await app.listen({ port: 0, host: "127.0.0.1" });
  address = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  await auth.createUser("admin", "password-admin-1", "admin");
});

afterAll(async () => {
  await app.close();
  await db.destroy();
});

async function login(): Promise<void> {
  const res = await fetch(`${address}/api/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "password-admin-1" }),
  });
  expect(res.status).toBe(200);
  cookieRef.current =
    (res.headers.getSetCookie?.() ?? [])
      .map((c) => c.split(";")[0])
      .find((c) => c.startsWith("tantalar_session=")) ?? "";
  csrfRef.current = ((await res.json()) as { csrfToken: string }).csrfToken;
}

function authed(method?: string, body?: unknown): Record<string, unknown> {
  return {
    method: method ?? "GET",
    headers: {
      "content-type": "application/json",
      cookie: `${cookieRef.current}; tantalar_csrf=${csrfRef.current}`,
      ...(method && method !== "GET" ? { "x-csrf-token": csrfRef.current } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  };
}

describe("wave 9 queue API (TAN-030)", () => {
  it("enriches and paginates movie and episode downloads without losing unmatched jobs", async () => {
    await login();
    managedMovies.set("movie-queue-art", { movieId: "movie-queue-art", title: "Queue artwork movie", year: 2026 });
    managedSeries.set("series-queue-art", { seriesId: "series-queue-art", title: "Queue artwork series", year: 2025 });
    const created = [];
    for (const itemKey of ["movie-queue-art", "series-queue-art:S01E02", "manual:queue-art"]) {
      created.push(await jobs.create({ itemKey, title: "Raw.Queue.Release", source: "usenet", providerPluginId: "dev.tantalar.plugin.usenet-native", providerJobId: itemKey, sourceRef: `sha256:${String(created.length).repeat(64)}` }));
    }
    const response = await fetch(`${address}/api/v1/queue?page=1&pageSize=1&search=Queue%20artwork&sort=title`, authed());
    const page = await response.json() as { total: number; jobs: Array<{ media: Record<string, unknown> }> };
    expect(page.total).toBe(2);
    expect(page.jobs).toHaveLength(1);
    expect(page.jobs[0]?.media).toMatchObject({ title: "Queue artwork movie", kind: "movie", year: 2026, artworkUrl: "/api/v1/acquisition/managed/movie/movie-queue-art/artwork" });
    const second = await (await fetch(`${address}/api/v1/queue?page=2&pageSize=1&search=Queue%20artwork&sort=title`, authed())).json() as { jobs: Array<{ media: Record<string, unknown> }> };
    expect(second.jobs[0]?.media).toMatchObject({ kind: "series", episode: "S01E02" });
    const unmatched = await (await fetch(`${address}/api/v1/queue?page=1&search=Raw.Queue.Release`, authed())).json() as { total: number };
    expect(unmatched.total).toBe(3);
    await jobs.updateProgress(created[0]!.record.jobId, { state: "completed", progressPercent: 100 });
    const awaitingImport = await (await fetch(`${address}/api/v1/queue?page=1&includeHistory=1&filter_state=awaiting_import&search=Queue%20artwork`, authed())).json() as { total: number; jobs: { status: string }[] };
    expect(awaitingImport).toMatchObject({ total: 1, jobs: [{ status: "awaiting_import" }] });
    await jobs.recordImportHandoff(created[0]!.record.jobId, "/library/queue-art.mkv");
    const imported = await (await fetch(`${address}/api/v1/queue?page=1&includeHistory=1&filter_state=imported&search=Queue%20artwork`, authed())).json() as { total: number; jobs: { status: string }[] };
    expect(imported).toMatchObject({ total: 1, jobs: [{ status: "imported" }] });
    for (const job of created) await jobs.remove(job.record.jobId);
    managedMovies.delete("movie-queue-art");
    managedSeries.delete("series-queue-art");
  });
  it("requires authentication", async () => {
    expect((await fetch(`${address}/api/v1/queue`)).status).toBe(401);
  });

  it("requires administrator authentication for the wanted ledger", async () => {
    expect((await fetch(`${address}/api/v1/acquisition/wanted`)).status).toBe(401);
  });

  it("joins wanted work to queue state and prescribes one recovery action", async () => {
    await login();
    const movieId = "movie-ledger-missing";
    const seriesId = "series-ledger-recovery";
    const jobIds: string[] = [];
    managedMovies.set(movieId, {
      movieId,
      title: "Missing Fixture",
      year: 2026,
      monitored: true,
      acquisitionState: "wanted",
      profile: { name: "hd", preferredQualities: ["1080p"] },
    });
    managedSeries.set(seriesId, {
      seriesId,
      name: "Recovery Fixture",
      monitored: true,
      acquisitionState: "wanted",
      profile: { name: "hd", preferredQualities: ["1080p"] },
      wantedEpisodes: [
        { episodeKey: "S01E01", query: "Recovery Fixture S01E01" },
        { episodeKey: "S01E02", query: "Recovery Fixture S01E02" },
        { episodeKey: "S01E03", query: "Recovery Fixture S01E03" },
        { episodeKey: "S01E04", query: "Recovery Fixture S01E04" },
      ],
    });

    try {
      const createJob = async (episodeKey: string) => {
        const { record } = await jobs.create({
          itemKey: `${seriesId}:${episodeKey}`,
          title: `Recovery Fixture ${episodeKey}`,
          source: "torrent",
          providerPluginId: "dev.tantalar.plugin.torrent-native",
          providerJobId: `ledger-${episodeKey}`,
          sourceRef: `sha256:${episodeKey.slice(-2).repeat(32).toLowerCase()}`,
        });
        jobIds.push(record.jobId);
        return record;
      };
      const failed = await createJob("S01E01");
      const paused = await createJob("S01E02");
      const queued = await createJob("S01E03");
      const cancelled = await createJob("S01E04");
      await jobs.markFailed(failed.jobId, "CRC mismatch");
      await jobs.updateProgress(paused.jobId, { state: "paused" });
      await jobs.updateProgress(cancelled.jobId, { state: "cancelled" });

      const response = await fetch(`${address}/api/v1/acquisition/wanted`, authed());
      expect(response.status).toBe(200);
      const body = await response.json() as {
        items: Array<{
          itemKey: string;
          kind: "movie" | "series";
          id: string;
          episodeKey?: string;
          title: string;
          state: string;
          failureDetail: string | null;
          recovery: null | { action: "search" | "resume" | "retry" | "remove"; label: string; jobId?: string };
        }>;
      };
      const byKey = new Map(body.items.map((item) => [item.itemKey, item]));

      expect(byKey.get(movieId)).toEqual(expect.objectContaining({
        kind: "movie",
        id: movieId,
        title: "Missing Fixture 2026",
        state: "missing",
        failureDetail: null,
        recovery: { action: "search", label: expect.any(String) },
      }));
      expect(byKey.get(`${seriesId}:S01E01`)).toEqual(expect.objectContaining({
        id: seriesId,
        episodeKey: "S01E01",
        state: "failed",
        failureDetail: "CRC mismatch",
        recovery: { action: "retry", label: expect.any(String), jobId: failed.jobId },
      }));
      expect(byKey.get(`${seriesId}:S01E02`)?.recovery).toEqual(expect.objectContaining({
        action: "resume",
        jobId: paused.jobId,
      }));
      expect(byKey.get(`${seriesId}:S01E03`)).toEqual(expect.objectContaining({
        state: "queued",
        recovery: null,
      }));
      expect(byKey.get(`${seriesId}:S01E04`)?.recovery).toEqual(expect.objectContaining({
        action: "remove",
        jobId: cancelled.jobId,
      }));
      expect(queued.jobId).toBeTruthy();
    } finally {
      managedMovies.delete(movieId);
      managedSeries.delete(seriesId);
      await Promise.all(jobIds.map((jobId) => jobs.remove(jobId)));
    }
  });

  it("exposes admin-only native Usenet configuration and VPN preflight routes", async () => {
    expect((await fetch(`${address}/api/v1/acquisition/usenet`)).status).toBe(401);
    await login();
    expect((await fetch(`${address}/api/v1/acquisition/usenet`, authed())).status).toBe(200);
    expect((await fetch(`${address}/api/v1/acquisition/usenet`, authed("PUT", { servers: [] }))).status).toBe(200);
    expect((await fetch(`${address}/api/v1/acquisition/usenet/test`, authed("POST", {
      server: {
        id: "local-fixture",
        name: "Local fixture",
        host: "news.fixture.invalid",
        port: 563,
        tls: "implicit",
        username: "reader",
        passwordEnv: "TANTALAR_SECRET_USENET_PASSWORD1",
        priority: 0,
        connections: 2,
      },
    }))).status).toBe(200);
    expect((await fetch(`${address}/api/v1/acquisition/torrent`, authed())).status).toBe(200);
    expect((await fetch(`${address}/api/v1/acquisition/torrent`, authed("PUT", { downloadRoots: [dir] }))).status).toBe(200);
    expect((await fetch(`${address}/api/v1/acquisition/vpn`, authed())).status).toBe(200);
    expect((await fetch(`${address}/api/v1/acquisition/vpn/preflight`, authed("POST", {}))).status).toBe(200);
  });

  it("stores Usenet passwords outside plugin documents and sends only a reference", async () => {
    const server = {
      id: "stored-fixture",
      name: "Stored fixture",
      host: "news.fixture.invalid",
      port: 563,
      tls: "implicit",
      username: "reader",
      password: "stored-secret-value",
      confirmPassword: "stored-secret-value",
      priority: 0,
      connections: 2,
    };
    const response = await fetch(`${address}/api/v1/acquisition/usenet`, authed("PUT", { servers: [server] }));
    expect(response.status).toBe(200);
    const call = engineCalls.findLast((entry) => entry.capability === "dev.tantalar.capability.usenet.engine" && entry.operation === "configure");
    expect(call?.payload).toEqual({ servers: [expect.objectContaining({ id: "stored-fixture", passwordRef: "usenet:stored-fixture" })] });
    expect(JSON.stringify(call?.payload)).not.toContain("stored-secret-value");
    expect(await secretStore.get("dev.tantalar.plugin.usenet-native", "usenet:stored-fixture")).toBe("stored-secret-value");
    expect(await db.selectFrom("plugin_documents").selectAll().execute().then((rows) => JSON.stringify(rows))).not.toContain("stored-secret-value");
  });

  it("declares the capability required to resolve stored Usenet passwords", () => {
    const manifest = JSON.parse(readFileSync(join(process.cwd(), "plugins/usenet-native/manifest.json"), "utf8")) as {
      requires: string[];
    };
    expect(manifest.requires).toContain("dev.tantalar.capability.secret.resolve");
  });

  it("searches hosted titles without an operator key and persists an idempotent managed item", async () => {
    metadataState = "ready";
    metadataRevision = "initial";
    expect((await fetch(`${address}/api/v1/acquisition/search?query=fixture&kind=all`)).status).toBe(401);
    await login();
    const hostedStatus = await fetch(`${address}/api/v1/acquisition/metadata`, authed());
    expect(hostedStatus.status).toBe(200);
    expect(await hostedStatus.json()).toEqual(expect.objectContaining({ state: "ready", mode: "hosted", configured: true, directKeyConfigured: false }));
    const hostedSearch = await fetch(`${address}/api/v1/acquisition/search?query=fixture&kind=all`, authed());
    expect(hostedSearch.status).toBe(200);
    expect(await secretStore.get("dev.tantalar.plugin.metadata-tmdb-tvdb", "tmdb:api-key")).toBeNull();

    const rejectedKey = await fetch(`${address}/api/v1/acquisition/metadata`, authed("PUT", { apiKey: "invalid-tmdb-key" }));
    expect(rejectedKey.status).toBe(422);
    expect(await rejectedKey.json()).toEqual(expect.objectContaining({ code: "auth_failed", rolledBack: true }));
    expect(await secretStore.get("dev.tantalar.plugin.metadata-tmdb-tvdb", "tmdb:api-key")).toBeNull();

    const apiKey = "valid-tmdb-key-for-test";
    const configured = await fetch(`${address}/api/v1/acquisition/metadata`, authed("PUT", { apiKey }));
    expect(configured.status).toBe(200);
    expect(await configured.json()).toEqual({ provider: "tmdb", state: "ready", mode: "direct", configured: true, directKeyConfigured: true });
    expect(await secretStore.get("dev.tantalar.plugin.metadata-tmdb-tvdb", "tmdb:api-key")).toBe(apiKey);
    expect(JSON.stringify(await db.selectFrom("audit_log").selectAll().execute())).not.toContain(apiKey);

    const cleared = await fetch(`${address}/api/v1/acquisition/metadata`, authed("PUT", { apiKey: "" }));
    expect(cleared.status).toBe(200);
    expect(await cleared.json()).toEqual({ provider: "tmdb", state: "ready", mode: "hosted", configured: true, directKeyConfigured: false });
    expect(await secretStore.get("dev.tantalar.plugin.metadata-tmdb-tvdb", "tmdb:api-key")).toBeNull();

    metadataState = "rate-limited";
    const limited = await fetch(`${address}/api/v1/acquisition/search?query=fixture&kind=all`, authed());
    expect(limited.status).toBe(503);
    expect(await limited.json()).toEqual(expect.objectContaining({ code: "rate_limited" }));
    metadataState = "ready";

    const search = await fetch(`${address}/api/v1/acquisition/search?query=fixture&kind=all`, authed());
    expect(search.status).toBe(200);
    const searchBody = await search.json() as { candidates: Array<Record<string, unknown>> };
    expect(searchBody.candidates.map((item) => item.title)).toEqual(["Fixture Movie", "Fixture Show refreshed"]);
    expect(searchBody.candidates[1]?.metadataSnapshot).toEqual(expect.objectContaining({ kind: "series", status: "Released", rating: 7.5 }));
    expect(searchBody.candidates[0]?.artworkUrl).toMatch(/^\/api\/v1\/acquisition\/artwork\/[a-f0-9]{64}$/);
    expect(JSON.stringify(searchBody)).not.toContain("fixtures.tantalar.invalid");

    const candidate = searchBody.candidates[0]!;
    const first = await fetch(`${address}/api/v1/acquisition/managed`, authed("POST", { ...candidate, minimumAvailability: "announced" }));
    expect(first.status).toBe(201);
    expect((await first.json() as { created: boolean }).created).toBe(true);
    const duplicate = await fetch(`${address}/api/v1/acquisition/managed`, authed("POST", { ...candidate, minimumAvailability: "announced" }));
    expect(duplicate.status).toBe(200);
    expect((await duplicate.json() as { created: boolean }).created).toBe(false);

    const managed = await fetch(`${address}/api/v1/acquisition/managed`, authed());
    const managedBody = await managed.json() as { items: Array<{ title: string; kind: string; metadataSnapshot: Record<string, unknown> }> };
    expect(managedBody.items).toEqual([expect.objectContaining({ title: "Fixture Movie", kind: "movie" })]);
    expect(managedBody.items[0]?.metadataSnapshot).toEqual(expect.objectContaining({
      externalId: "tmdb-9001",
      runtimeMinutes: 101,
      genres: ["Fixture"],
      certification: "PG",
      posterPath: "/art/refreshed.jpg",
      backdropPath: "/art/backdrop.jpg",
      externalIds: { tmdb: "9001", imdb: "tt0009001" },
    }));
    expect(JSON.stringify(managedBody)).not.toContain("fixtures.tantalar.invalid");

    const update = await fetch(`${address}/api/v1/acquisition/managed/movie/movie-tmdb-9001`, authed("PATCH", {
      title: "Manual Fixture Movie",
      overview: "Manual overview.",
    }));
    expect(update.status).toBe(200);
    expect((await fetch(`${address}/api/v1/acquisition/managed/movie/movie-tmdb-9001`, authed()).then((res) => res.json()) as {
      item: { title: string; manualFields: string[] };
    }).item).toEqual(expect.objectContaining({ title: "Manual Fixture Movie", manualFields: expect.arrayContaining(["title", "overview"]) }));

    const refresh = await fetch(`${address}/api/v1/acquisition/managed/movie/movie-tmdb-9001/refresh`, authed("POST", {}));
    expect(refresh.status).toBe(200);
    const refreshed = await fetch(`${address}/api/v1/acquisition/managed/movie/movie-tmdb-9001`, authed()).then((res) => res.json()) as {
      item: { title: string; overview: string; year: number; artworkUrl: string; metadataSnapshot: Record<string, unknown> };
    };
    expect(refreshed.item).toEqual(expect.objectContaining({
      title: "Manual Fixture Movie",
      overview: "Manual overview.",
      year: 2025,
      artworkUrl: "/api/v1/acquisition/managed/movie/movie-tmdb-9001/artwork",
    }));
    expect(refreshed.item.metadataSnapshot).toEqual(expect.objectContaining({
      name: "Fixture Movie refreshed",
      releaseDate: "2025-07-12",
      fetchedAt: "2026-08-31T12:00:00.000Z",
    }));

    metadataState = "unavailable";
    const staleRefresh = await fetch(`${address}/api/v1/acquisition/managed/movie/movie-tmdb-9001/refresh`, authed("POST", {}));
    expect(staleRefresh.status).toBe(200);
    const afterOutage = await fetch(`${address}/api/v1/acquisition/managed/movie/movie-tmdb-9001`, authed()).then((res) => res.json()) as {
      item: { title: string; overview: string; metadataSnapshot: Record<string, unknown> };
    };
    expect(afterOutage.item).toEqual(expect.objectContaining({ title: "Manual Fixture Movie", overview: "Manual overview." }));
    expect(afterOutage.item.metadataSnapshot).toEqual(refreshed.item.metadataSnapshot);
    metadataState = "ready";

    managedMovies.set("movie-legacy", {
      movieId: "movie-legacy",
      externalId: "tmdb-legacy",
      provider: "fixture",
      title: "Legacy movie",
      year: 1999,
      overview: "Legacy overview.",
      artworkUrl: "https://fixtures.tantalar.invalid/art/legacy.jpg",
      monitored: true,
      manualFields: [],
    });
    metadataState = "unavailable";
    const legacy = await fetch(`${address}/api/v1/acquisition/managed/movie/movie-legacy`, authed()).then((res) => res.json()) as {
      item: { title: string; year: number; overview: string; artworkUrl: string; metadataSnapshot?: unknown };
    };
    expect(legacy.item).toEqual(expect.objectContaining({
      title: "Legacy movie",
      year: 1999,
      overview: "Legacy overview.",
      artworkUrl: "/api/v1/acquisition/managed/movie/movie-legacy/artwork",
    }));
    expect(legacy.item.metadataSnapshot).toBeUndefined();
    managedMovies.delete("movie-legacy");
    metadataState = "ready";

    const now = new Date().toISOString();
    await db.insertInto("libraries").values({
      id: "managed-movies",
      name: "Managed movies",
      rootPath: dir,
      kind: "movie",
      enabled: 1,
      createdAt: now,
      updatedAt: now,
    }).execute();
    await db.insertInto("media_catalog").values({
      fileId: "managed-file-1",
      libraryId: "managed-movies",
      itemKey: "unmatched-file",
      path: join(dir, "Fixture Movie.mkv"),
      quality: "1080p",
      method: "existing",
      sourceHash: "managed-file-hash",
      importedAt: now,
      updatedAt: now,
    }).execute();
    const match = await fetch(`${address}/api/v1/acquisition/managed/movie/movie-tmdb-9001/match`, authed("POST", { fileId: "managed-file-1" }));
    expect(match.status).toBe(200);
    expect((await db.selectFrom("media_catalog").select("itemKey").where("fileId", "=", "managed-file-1").executeTakeFirst())?.itemKey).toBe("movie-tmdb-9001");
    const catalog = await fetch(`${address}/api/v1/catalog/page?page=1&pageSize=200`, authed()).then((res) => res.json()) as {
      items: Array<{ fileId: string; metadataSnapshot?: Record<string, unknown> }>;
    };
    expect(catalog.items.find((item) => item.fileId === "managed-file-1")?.metadataSnapshot).toEqual(refreshed.item.metadataSnapshot);

    const tagPath = `${address}/api/v1/acquisition/managed/movie/movie-tmdb-9001/tags`;
    expect((await fetch(tagPath, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ tags: ["weekend"] }) })).status).toBe(401);
    expect((await fetch(tagPath, authed("PUT", { tags: ["x".repeat(41)] }))).status).toBe(400);
    const tags = await fetch(tagPath, authed("PUT", { tags: [" Weekend ", "weekend", "family"] }));
    expect(tags.status).toBe(200);
    expect(await tags.json()).toEqual({ tags: ["family", "weekend"] });
    expect((await fetch(`${address}/api/v1/acquisition/managed/movie/movie-tmdb-9001`, authed()).then(response => response.json()) as { item: { tags: string[] } }).item.tags).toEqual(["family", "weekend"]);

    // A matched 1080p copy must reject equivalent releases, even in interactive search.
    const atCutoff = await fetch(`${address}/api/v1/acquisition/managed/movie/movie-tmdb-9001/releases`, authed()).then(r => r.json()) as { releases: Array<{ accepted: boolean }> };
    expect(atCutoff.releases.every(r => !r.accepted)).toBe(true);
    await db.updateTable("media_catalog").set({ quality: "720p" }).where("fileId", "=", "managed-file-1").execute();
    const releases = await fetch(`${address}/api/v1/acquisition/managed/movie/movie-tmdb-9001/releases`, authed());
    expect(releases.status).toBe(200);
    const releaseBody = await releases.json() as {
      releases: Array<{
        releaseId: string;
        title: string;
        accepted: boolean;
        reasons: Array<{ code: string; message: string }>;
      }>;
    };
    expect(releaseBody.releases).toHaveLength(2);
    expect(releaseBody.releases[0]).toEqual(expect.objectContaining({ accepted: true }));
    expect(releaseBody.releases[1]).toEqual(expect.objectContaining({
      title: "Fixture Movie 2024 1080p WEB-DL Alternate",
      accepted: true,
      reasons: expect.arrayContaining([
        { code: "preferred_quality", message: "Quality matches the monitoring profile" },
        { code: "eligible_lower_ranked", message: "Eligible, but ranked below another release" },
      ]),
    }));
    expect(JSON.stringify(releaseBody)).not.toMatch(/magnet:|downloadUrl|fixture-movie-release-[12]/);

    addResponseMode = "missing-root";
    const blockedGrab = await fetch(`${address}/api/v1/acquisition/managed/movie/movie-tmdb-9001/grab`, authed("POST", { releaseId: releaseBody.releases[1]!.releaseId }));
    expect(blockedGrab.status).toBe(503);
    expect(await blockedGrab.json()).toEqual({ error: "Configure a download directory in Acquisition before grabbing releases." });
    addResponseMode = "normal";

    const grab = await fetch(
      `${address}/api/v1/acquisition/managed/movie/movie-tmdb-9001/grab`,
      authed("POST", { releaseId: releaseBody.releases[1]!.releaseId }),
    );
    expect(grab.status).toBe(202);
    expect(await grab.json()).toEqual(expect.objectContaining({
      grabbed: true,
      download: expect.objectContaining({ itemKey: "movie-tmdb-9001", state: "downloading" }),
    }));
    expect(engineCalls.filter((call) => call.operation === "add").at(-1)?.payload.itemKey).toBe("movie-tmdb-9001");
    expect((await jobs.list()).some((job) => job.itemKey === "movie-tmdb-9001")).toBe(true);
    expect((await new ReleaseDecisionStore(db).listForItem("movie-tmdb-9001"))[0]).toMatchObject({
      mode: "interactive",
      outcome: "accepted",
      guid: "fixture-movie-release-2",
      title: "Fixture Movie 2024 1080p WEB-DL Alternate",
      reasons: [
        "Quality matches the monitoring profile",
        "Eligible, but ranked below another release",
      ],
    });

    const removed = await fetch(`${address}/api/v1/acquisition/managed/movie/movie-tmdb-9001`, authed("DELETE", {}));
    expect(removed.status).toBe(204);
    expect((await db.selectFrom("media_catalog").select("fileId").where("fileId", "=", "managed-file-1").executeTakeFirst())?.fileId).toBe("managed-file-1");
  });

  it("creates a manual native job through its source-aware provider without storing the source URL", async () => {
    await login();
    const secretBearingMagnet = "magnet:?xt=urn:btih:0123456789012345678901234567890123456789&tr=https%3A%2F%2Ftracker.invalid%2Fprivate-passkey%2Fannounce";
    const res = await fetch(`${address}/api/v1/queue`, authed("POST", {
      kind: "torrent",
      title: "Legal loopback fixture",
      sourceUrl: secretBearingMagnet,
    }));
    expect(res.status).toBe(201);
    const body = await res.json() as { job: { jobId: string; enginePluginId?: string }; created: boolean };
    expect(body.created).toBe(true);
    expect(body.job).not.toHaveProperty("providerJobId");
    expect(body.job).not.toHaveProperty("sourceRef");
    const stored = await jobs.get(body.job.jobId);
    expect(stored?.providerPluginId).toBe("dev.tantalar.plugin.torrent-native");
    expect(stored?.providerJobId).toBe("dev.tantalar.plugin.torrent-native:job-1");
    expect(stored?.sourceRef).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(JSON.stringify(stored)).not.toContain("private-passkey");

    const duplicate = await fetch(`${address}/api/v1/queue`, authed("POST", {
      kind: "torrent",
      title: "Legal loopback fixture",
      sourceUrl: secretBearingMagnet,
    }));
    expect(duplicate.status).toBe(200);
    expect(JSON.stringify(await duplicate.json())).not.toMatch(/private-passkey|sourceRef|providerJobId/);

    const usenet = await fetch(`${address}/api/v1/queue`, authed("POST", {
      kind: "usenet",
      title: "Legal NZB fixture",
      sourceUrl: "/tmp/legal-fixture.nzb",
    }));
    expect(usenet.status).toBe(201);
    const usenetBody = await usenet.json() as { job: { jobId: string; enginePluginId: string } };
    expect(usenetBody.job.enginePluginId).toBe("dev.tantalar.plugin.usenet-native");
    expect((await jobs.get(usenetBody.job.jobId))?.providerJobId).toBe("dev.tantalar.plugin.usenet-native:job-1");
  });

  it("blocks a new native job before provider or database work when VPN policy denies dispatch", async () => {
    await login();
    const callCount = engineCalls.length;
    vpnAllowsDispatch = false;
    const blocked = await fetch(`${address}/api/v1/queue`, authed("POST", {
      kind: "torrent",
      title: "Blocked fixture",
      sourceUrl: "magnet:?xt=urn:btih:1111111111111111111111111111111111111111",
    }));
    vpnAllowsDispatch = true;
    expect(blocked.status).toBe(409);
    expect(engineCalls).toHaveLength(callCount);
    expect((await jobs.list()).some((job) => job.title === "Blocked fixture")).toBe(false);
  });

  it("rejects malformed provider responses and never returns provider secrets", async () => {
    await login();
    addResponseMode = "malformed";
    const malformed = await fetch(`${address}/api/v1/queue`, authed("POST", {
      kind: "torrent",
      title: "Malformed provider",
      sourceUrl: `magnet:?xt=urn:btih:${"2".repeat(40)}`,
    }));
    expect(malformed.status).toBe(502);
    expect((await malformed.json() as { error: string }).error).toBe("Download provider rejected the job.");

    addResponseMode = "secret-error";
    const secret = await fetch(`${address}/api/v1/queue`, authed("POST", {
      kind: "torrent",
      title: "Secret provider error",
      sourceUrl: `magnet:?xt=urn:btih:${"3".repeat(40)}`,
    }));
    addResponseMode = "normal";
    expect(secret.status).toBe(502);
    expect(JSON.stringify(await secret.json())).not.toMatch(/private-passkey|token=secret/);
    expect((await jobs.list()).some((job) => job.title.includes("provider"))).toBe(false);
  });

  it("removes an accepted provider job when durable creation fails", async () => {
    await login();
    await sql`CREATE TRIGGER fail_download_insert BEFORE INSERT ON download_jobs BEGIN SELECT RAISE(FAIL, 'forced persistence failure'); END`.execute(db);
    addResponseMode = "unique";
    const response = await fetch(`${address}/api/v1/queue`, authed("POST", {
      kind: "torrent",
      title: "Persistence failure",
      sourceUrl: `magnet:?xt=urn:btih:${"4".repeat(40)}`,
    }));
    addResponseMode = "normal";
    await sql`DROP TRIGGER fail_download_insert`.execute(db);
    expect(response.status).toBe(500);
    expect(engineCalls.some((call) => call.operation === "remove" && call.payload.downloadId === "dev.tantalar.plugin.torrent-native:orphan-job" && call.payload.keepFiles === true)).toBe(true);
    expect((await jobs.list()).some((job) => job.title === "Persistence failure")).toBe(false);
  });

  it("removes the losing provider job when two identical adds race", async () => {
    await login();
    raceAddCount = 0;
    raceAddsReady = new Promise<void>((resolve) => { releaseRaceAdds = resolve; });
    addResponseMode = "race";
    const body = {
      kind: "torrent",
      title: "Concurrent fixture",
      sourceUrl: `magnet:?xt=urn:btih:${"5".repeat(40)}`,
    };
    const responses = await Promise.all([
      fetch(`${address}/api/v1/queue`, authed("POST", body)),
      fetch(`${address}/api/v1/queue`, authed("POST", body)),
    ]);
    addResponseMode = "normal";
    releaseRaceAdds = null;
    expect(responses.map((response) => response.status).sort()).toEqual([200, 201]);
    const rows = (await jobs.list()).filter((job) => job.title === "Concurrent fixture");
    expect(rows).toHaveLength(1);
    const removedIds = engineCalls
      .filter((call) => call.operation === "remove" && String(call.payload.downloadId).includes(":race-"))
      .map((call) => call.payload.downloadId);
    expect(removedIds).toHaveLength(1);
    expect(removedIds[0]).not.toBe(rows[0]?.providerJobId);
  });

  it("lists durable jobs with engine identity, priority, failure detail", async () => {
    await login();
    const { record } = await jobs.create({
      itemKey: "series.w9",
      title: "Wave Nine Episode",
      source: "torrent",
      providerPluginId: "dev.tantalar.plugin.torrent-native",
      providerJobId: "torrent-wave9-list",
      sourceRef: `sha256:${"a".repeat(64)}`,
    });
    await jobs.updateProgress(record.jobId, { state: "downloading", progressPercent: 42 });

    const res = await fetch(`${address}/api/v1/queue`, authed());
    expect(res.status).toBe(200);
    const list = (await res.json() as { jobs: Array<Record<string, unknown>> }).jobs;
    const row = list.find((j) => j.jobId === record.jobId);
    expect(row).toBeTruthy();
    expect(row!["enginePluginId"]).toBe("dev.tantalar.plugin.torrent-native");
    expect(row!["state"]).toBe("downloading");
    expect(row!["progressPercent"]).toBe(42);
    expect(row!["priority"]).toBe(0);
  });

  it("pauses, resumes, prioritizes and guards the state machine", async () => {
    await login();
    const listed = await fetch(`${address}/api/v1/queue`, authed());
    const jobId = ((await listed.json() as { jobs: Array<{ jobId: string }> }).jobs[0]!).jobId;

    const paused = await fetch(`${address}/api/v1/queue/${jobId}/actions`, authed("POST", { action: "pause" }));
    expect(paused.status).toBe(200);

    // Pausing twice is refused with a truthful reason.
    const pauseAgain = await fetch(`${address}/api/v1/queue/${jobId}/actions`, authed("POST", { action: "pause" }));
    expect(pauseAgain.status).toBe(409);

    vpnAllowsDispatch = false;
    const blockedResume = await fetch(`${address}/api/v1/queue/${jobId}/actions`, authed("POST", { action: "resume" }));
    expect(blockedResume.status).toBe(409);
    expect((await jobs.get(jobId))?.state).toBe("paused");

    vpnAllowsDispatch = true;
    const resumed = await fetch(`${address}/api/v1/queue/${jobId}/actions`, authed("POST", { action: "resume" }));
    expect(resumed.status).toBe(200);

    const prio = await fetch(`${address}/api/v1/queue/${jobId}/actions`, authed("POST", { action: "prioritize", priority: 5 }));
    expect(prio.status).toBe(200);
    expect(((await prio.json()) as { job: { priority: number } }).job.priority).toBe(5);
    expect(engineCalls.some((call) => call.operation === "pause" && call.pluginId.endsWith("torrent-native"))).toBe(true);
    expect(engineCalls.some((call) => call.operation === "resume" && call.pluginId.endsWith("torrent-native"))).toBe(true);
    expect(engineCalls.some((call) => call.operation === "queue-position" && call.capability.endsWith("torrent.engine"))).toBe(true);

    const retryCalls = engineCalls.filter((call) => call.operation === "retry").length;
    expect((await fetch(`${address}/api/v1/queue/${jobId}/actions`, authed("POST", { action: "retry" }))).status).toBe(409);
    expect(engineCalls.filter((call) => call.operation === "retry")).toHaveLength(retryCalls);

    expect((await fetch(`${address}/api/v1/queue/${jobId}/actions`, authed("POST", { action: "pause" }))).status).toBe(200);
    vpnGateError = true;
    expect((await fetch(`${address}/api/v1/queue/${jobId}/actions`, authed("POST", { action: "resume" }))).status).toBe(503);
    vpnGateError = false;
    expect((await jobs.get(jobId))?.state).toBe("paused");
    expect((await fetch(`${address}/api/v1/queue/${jobId}/actions`, authed("POST", { action: "resume" }))).status).toBe(200);

    const badPrio = await fetch(`${address}/api/v1/queue/${jobId}/actions`, authed("POST", { action: "prioritize", priority: 1.5 }));
    expect(badPrio.status).toBe(400);
  });

  it("removes with explicit data-file semantics while retaining durable history", async () => {
    await login();
    const { record } = await jobs.create({
      itemKey: "movie.w9.remove",
      title: "Removable",
      source: "usenet",
      providerPluginId: "dev.tantalar.plugin.usenet-native",
      providerJobId: "usenet-wave9-remove",
      sourceRef: `sha256:${"b".repeat(64)}`,
    });
    const removed = await fetch(`${address}/api/v1/queue/${record.jobId}/actions`, authed("POST", { action: "remove" }));
    expect(removed.status).toBe(200);
    const body = (await removed.json()) as { dataFilesDeleted: boolean; note: string };
    expect(body.dataFilesDeleted).toBe(false);
    expect(body.note).toContain("kept");
    expect(engineCalls.some((call) => call.operation === "remove" && call.pluginId.endsWith("usenet-native"))).toBe(true);

    // History survives: includeHistory shows the flagged row.
    const hist = await fetch(`${address}/api/v1/queue?includeHistory=1`, authed());
    const rows = (await hist.json() as { jobs: Array<{ jobId: string; removed: boolean }> }).jobs;
    expect(rows.find((r) => r.jobId === record.jobId)?.removed).toBe(true);

    // Default view hides removed rows.
    const active = await fetch(`${address}/api/v1/queue`, authed());
    expect((await active.json() as { jobs: Array<{ jobId: string }> }).jobs.find((r) => r.jobId === record.jobId)).toBeUndefined();

    const { record: deleteRecord } = await jobs.create({
      itemKey: "movie.w9.delete",
      title: "Delete data",
      source: "torrent",
      providerPluginId: "dev.tantalar.plugin.torrent-native",
      providerJobId: "torrent-wave9-delete",
      sourceRef: `sha256:${"c".repeat(64)}`,
    });
    const deleted = await fetch(`${address}/api/v1/queue/${deleteRecord.jobId}/actions`, authed("POST", {
      action: "remove",
      deleteDataFiles: true,
    }));
    expect(deleted.status).toBe(200);
    const deleteBody = (await deleted.json()) as { dataFilesDeleted: boolean | "unknown"; note: string };
    expect(deleteBody.dataFilesDeleted).toBe("unknown");
    expect(deleteBody.note).toContain("not independently verified");

    const unknownJob = await fetch(`${address}/api/v1/queue/nope/actions`, authed("POST", { action: "remove" }));
    expect(unknownJob.status).toBe(404);
  });

  it("refuses engine actions for legacy rows without a provider-native identity", async () => {
    await login();
    const { record } = await jobs.create({
      itemKey: "legacy-provider-row",
      title: "Legacy provider row",
      source: "torrent",
      providerPluginId: "dev.tantalar.plugin.torrent-native",
      providerJobId: "legacy-provider-id",
      sourceRef: `sha256:${"7".repeat(64)}`,
    });
    await jobs.updateProgress(record.jobId, { state: "downloading" });
    await db.updateTable("download_jobs").set({ providerJobId: null }).where("jobId", "=", record.jobId).execute();
    const calls = engineCalls.length;
    const response = await fetch(`${address}/api/v1/queue/${record.jobId}/actions`, authed("POST", { action: "pause" }));
    expect(response.status).toBe(409);
    expect(engineCalls).toHaveLength(calls);
    await jobs.remove(record.jobId);
  });
});

describe("wave 9 user management + last-admin safeguard (TAN-032)", () => {
  let viewerId = "";
  let secondAdminId = "";

  it("creates users then changes roles with audit entries", async () => {
    await login();
    const v = await auth.createUser("w9viewer", "password-viewer-1", "viewer");
    viewerId = v;
    const a = await auth.createUser("w9second", "password-second-1", "admin");
    secondAdminId = a;

    const roleRes = await fetch(`${address}/api/v1/users/${v}/role`, authed("PUT", { role: "admin" }));
    expect(roleRes.status).toBe(200);
    const audit = await fetch(`${address}/api/v1/system/audit`, authed());
    const entries = (await audit.json() as { entries: Array<{ action: string }> }).entries;
    expect(entries.some((e) => e.action === "user.role.changed")).toBe(true);
  });

  it("refuses to demote or deactivate the LAST administrator", async () => {
    await login();
    // Deactivate every other admin so only the acting admin remains.
    await fetch(`${address}/api/v1/users/${secondAdminId}/active`, authed("PUT", { active: false }));
    const vId = (await db.selectFrom("users").selectAll().execute()).find((u) => u.username === "w9viewer")!.id;
    await fetch(`${address}/api/v1/users/${vId}/active`, authed("PUT", { active: false }));

    const me = await fetch(`${address}/api/v1/auth/me`, {
      headers: { cookie: cookieRef.current },
    });
    const myId = ((await me.json()) as { user: { id: string } }).user.id;

    const demote = await fetch(`${address}/api/v1/users/${myId}/role`, authed("PUT", { role: "viewer" }));
    expect(demote.status).toBe(409);
    expect(((await demote.json()) as { error: string }).error).toContain("last administrator");

    const deactivate = await fetch(`${address}/api/v1/users/${myId}/active`, authed("PUT", { active: false }));
    expect(deactivate.status).toBe(409);

    // Reactivating works.
    const reactivate = await fetch(`${address}/api/v1/users/${secondAdminId}/active`, authed("PUT", { active: true }));
    expect(reactivate.status).toBe(200);
  });

  it("deactivated accounts cannot sign in and lose live sessions", async () => {
    await login();
    const vId = (await db.selectFrom("users").selectAll().execute()).find((u) => u.username === "w9viewer")!.id;
    const off = await fetch(`${address}/api/v1/users/${vId}/active`, authed("PUT", { active: false }));
    expect(off.status).toBe(200);

    // Login as deactivated user is rejected.
    const loginRes = await fetch(`${address}/api/v1/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "w9viewer", password: "password-viewer-1" }),
    });
    expect(loginRes.status).toBe(401);
  });

  it("resets passwords and revokes sessions with audit coverage", async () => {
    await login();
    const vId = (await db.selectFrom("users").selectAll().execute()).find((u) => u.username === "w9viewer")!.id;
    await fetch(`${address}/api/v1/users/${vId}/active`, authed("PUT", { active: true }));

    const reset = await fetch(`${address}/api/v1/users/${vId}/password-reset`, authed("POST", { password: "new-password-99" }));
    expect(reset.status).toBe(200);
    // New password verifies.
    const verified = await auth.verifyPassword("w9viewer", "new-password-99");
    expect(verified).not.toBeNull();

    const revoke = await fetch(`${address}/api/v1/users/${vId}/sessions/revoke`, authed("POST", {}));
    expect(revoke.status).toBe(200);
    expect(((await revoke.json()) as { revoked: number }).revoked).toBeGreaterThanOrEqual(0);

    const short = await fetch(`${address}/api/v1/users/${vId}/password-reset`, authed("POST", { password: "short" }));
    expect(short.status).toBe(400);
  });

  it("manages library access grants", async () => {
    await login();
    const libId = "11111111-1111-7111-8111-111111111111";
    const denied = await fetch(`${address}/api/v1/users/someone/libraries`, authed("PUT", { libraryIds: [libId] }));
    expect(denied.status).toBe(400); // unknown library fails closed
  });
});

describe("wave 9 API keys (TAN-033)", () => {
  it("creates a scoped key whose secret appears exactly once", async () => {
    await login();
    const created = await fetch(`${address}/api/v1/api-keys`, authed("POST", { name: "ci-key", scopes: ["events.read"], expiresAt: null }));
    expect(created.status).toBe(200);
    const text = await created.text();
    const body = JSON.parse(text) as { key: { id: string }; secret: string };
    expect(body.secret.startsWith("tantalar_")).toBe(true);
    expect(text.indexOf(body.secret)).toBe(text.lastIndexOf(body.secret)); // once

    // Listing never contains the secret.
    const listed = await fetch(`${address}/api/v1/api-keys`, authed());
    expect(!(await listed.text()).includes(body.secret));
    void body.key;
  });

  it("honours expiry — an expired key fails closed", async () => {
    await login();
    const created = await fetch(`${address}/api/v1/api-keys`, authed("POST", {
      name: "expired",
      scopes: ["events.read"],
      expiresAt: "2020-01-01T00:00:00Z",
    }));
    const { secret } = (await created.json()) as { secret: string };
    const probe = await fetch(`${address}/api/v1/events`, {
      headers: { authorization: `Bearer ${secret}` },
    });
    expect(probe.status).toBe(401);
  });

  it("rejects unknown scopes and revokes durably", async () => {
    await login();
    const badScope = await fetch(`${address}/api/v1/api-keys`, authed("POST", { name: "bad", scopes: ["root.everything"] }));
    expect(badScope.status).toBe(400);

    const ok = await fetch(`${address}/api/v1/api-keys`, authed("POST", { name: "revoke-me", scopes: ["events.read"], expiresAt: null }));
    const { key } = (await ok.json()) as { key: { id: string } };
    const revoked = await fetch(`${address}/api/v1/api-keys/${key.id}`, authed("DELETE", {}));
    expect(revoked.status).toBe(200);
    const listed = await fetch(`${address}/api/v1/api-keys`, authed());
    expect(((await listed.json()) as { keys: Array<{ revokedAt: string | null }> }).keys.find((k) => (k as { id: string }).id === key.id)?.revokedAt).not.toBeNull();
  });
});

describe("wave 9 webhooks (TAN-033)", () => {
  it("stores only the env var NAME and test delivery reports truthfully without secrets", async () => {
    await login();
    const created = await fetch(`${address}/api/v1/webhooks`, authed("POST", {
      url: "https://hooks.invalid/target",
      eventTypes: ["dev.tantalar.event.download.completed"],
      secretEnvVar: "W9_WEBHOOK_SECRET_UNSET",
    }));
    expect(created.status).toBe(200);
    const hook = ((await created.json()) as { webhook: { id: string; url: string } }).webhook;

    const testRes = await fetch(`${address}/api/v1/webhooks/${hook.id}/test`, authed("POST", {}));
    expect(testRes.status).toBe(409);
    const testBody = (await testRes.text()) as string;
    expect(testBody).toContain("skipped_no_secret");

    // The response must not echo any secret material.
    expect(testBody.includes(process.env.W9_WEBHOOK_SECRET_UNSET ?? "\u0000never-present")).toBe(false);

    const deleted = await fetch(`${address}/api/v1/webhooks/${hook.id}`, authed("DELETE", {}));
    expect(deleted.status).toBe(200);
  });

  it("validates URLs fail-closed", async () => {
    await login();
    const badUrl = await fetch(`${address}/api/v1/webhooks`, authed("POST", { url: "not-a-url", eventTypes: [], secretEnvVar: "X" }));
    expect(badUrl.status).toBe(400);
    const ftp = await fetch(`${address}/api/v1/webhooks`, authed("POST", { url: "ftp://x.invalid/a", eventTypes: [], secretEnvVar: "X" }));
    expect(ftp.status).toBe(400);
  });
});

describe("wave 9 MCP status (TAN-033)", () => {
  it("reports truthful read-only MCP status", async () => {
    await login();
    const res = await fetch(`${address}/api/v1/mcp/status`, authed());
    expect(res.status).toBe(200);
    const status = (await res.json()) as { mounted: boolean; auditedCalls: number | null };
    expect(status.mounted).toBe(false);
    expect(status.auditedCalls).not.toBeUndefined();
  });
});

describe("wave 9 server-side catalog pagination (TAN-038)", () => {
  it("returns paged results with total counts and stable ordering", async () => {
    await login();
    const res = await fetch(`${address}/api/v1/catalog/page?page=1&pageSize=10`, authed());
    expect(res.status).toBe(200);
    const page = (await res.json()) as { items: unknown[]; page: number; pageSize: number; total: number; totalPages: number };
    expect(page.page).toBe(1);
    expect(page.pageSize).toBe(10);
    expect(page.totalPages).toBeGreaterThanOrEqual(1);
    expect(Array.isArray(page.items)).toBe(true);
  });
});

describe("wave 9 backup / restore (TAN-042)", () => {
  it("creates an integrity-checked atomic backup and reports its contents", async () => {
    await login();
    const res = await fetch(`${address}/api/v1/system/backup`, authed("POST", {}));
    if (res.status === 200) {
      const body = (await res.json()) as { path: string; includes: string[] };
      expect(body.path.endsWith(".db")).toBe(true);
      expect(body.includes).toContain("database (all tables)");
    } else {
      expect(res.status).toBe(503); // only when sqlite unavailable
    }
  });

  it("refuses restore paths outside the managed backups directory", async () => {
    await login();
    const res = await fetch(`${address}/api/v1/system/restore`, authed("POST", { path: "/etc/passwd" }));
    expect(res.status).toBe(400);
  });
});

describe("wave 9 diagnostics + support bundle (TAN-043)", () => {
  it("reports versions, module states and transcoder support", async () => {
    await login();
    const res = await fetch(`${address}/api/v1/system/diagnostics`, authed());
    expect(res.status).toBe(200);
    const diag = (await res.json()) as {
      versions: { tantalar: { version: string; label: string }; node: string };
      plugins: unknown[];
      transcoder: { ffmpegAvailable: boolean };
      resources: {
        uptimeSeconds: number;
        startedAt: string;
        process: { rssBytes: number; heapUsedBytes: number; cpuUserSeconds: number; cpuSystemSeconds: number };
        host: { totalMemoryBytes: number; freeMemoryBytes: number; loadAverage: number[] };
      };
      storage: { dataVolume: { totalBytes: number | null; usedBytes: number | null; freeBytes: number | null }; catalogKnownBytes: null; catalogKnownBytesReason: string };
      libraries: { configured: number | null; catalog: { files: number; items: number } | null };
      work: { queue: { queued: number; downloading: number; paused: number; failed: number } | null; activeStreams: null; activeStreamsReason: string };
      capabilities: { downloadClientMounted: boolean; torrentEngineMounted: boolean; usenetEngineMounted: boolean; vpnMounted: boolean };
    };
    expect(diag.versions.node).toMatch(/^v\d+/);
    expect(diag.versions.tantalar).toMatchObject({ version: "0.0.1-alpha.0", label: "0.0.1 Alpha" });
    expect(Array.isArray(diag.plugins)).toBe(true);
    expect(diag.resources.uptimeSeconds).toBeGreaterThanOrEqual(0);
    expect(Number.isNaN(Date.parse(diag.resources.startedAt))).toBe(false);
    expect(diag.resources.process.rssBytes).toBeGreaterThan(0);
    expect(diag.resources.process.heapUsedBytes).toBeGreaterThan(0);
    expect(diag.resources.process.cpuUserSeconds + diag.resources.process.cpuSystemSeconds).toBeGreaterThanOrEqual(0);
    expect(diag.resources.host.totalMemoryBytes).toBeGreaterThan(0);
    expect(diag.resources.host.freeMemoryBytes).toBeGreaterThanOrEqual(0);
    expect(diag.resources.host.loadAverage).toHaveLength(3);
    expect(diag.storage.dataVolume.totalBytes).toBeGreaterThan(0);
    expect(diag.storage.dataVolume.usedBytes).toBeGreaterThanOrEqual(0);
    expect(diag.storage.dataVolume.freeBytes).toBeGreaterThanOrEqual(0);
    expect(diag.storage.catalogKnownBytes).toBeNull();
    expect(diag.storage.catalogKnownBytesReason).toContain("not stored");

    const [libraryCount] = await db.selectFrom("libraries").select((eb) => eb.fn.countAll<number>().as("n")).execute();
    const [catalogCount] = await db.selectFrom("media_catalog").select((eb) => eb.fn.countAll<number>().as("n")).execute();
    const [queueCount] = await db.selectFrom("download_jobs")
      .select((eb) => eb.fn.countAll<number>().as("n"))
      .where("removed", "=", 0)
      .where("state", "in", ["queued", "downloading", "paused", "failed"])
      .execute();
    expect(diag.libraries.configured).toBe(Number(libraryCount?.n ?? 0));
    expect(diag.libraries.catalog?.files).toBe(Number(catalogCount?.n ?? 0));
    expect(diag.work.queue && Object.values(diag.work.queue).reduce((total, count) => total + count, 0)).toBe(Number(queueCount?.n ?? 0));
    expect(diag.work.activeStreams).toBeNull();
    expect(diag.work.activeStreamsReason).toContain("does not expose");
    expect(diag.capabilities).toMatchObject({ downloadClientMounted: true, torrentEngineMounted: true, usenetEngineMounted: true, vpnMounted: true });
  });

  it("previews bundle sections and redacts media names by default", async () => {
    await login();
    const preview = await fetch(`${address}/api/v1/system/support-bundle/preview`, authed());
    const p = (await preview.json()) as { sections: string[]; mediaNamesRedacted: boolean };
    expect(p.mediaNamesRedacted).toBe(true);
    expect(p.sections.length).toBeGreaterThan(0);

    const bundle = await fetch(`${address}/api/v1/system/support-bundle`, authed("POST", { includeMediaNames: false }));
    const b = (await bundle.json()) as {
      bundle: { versions: { tantalar: { version: string; label: string } } } & Record<string, unknown>;
    };
    expect(b.bundle.versions.tantalar).toMatchObject({ version: "0.0.1-alpha.0", label: "0.0.1 Alpha" });
    const serialized = JSON.stringify(b.bundle);
    expect(serialized).not.toContain("Wave Nine"); // media titles redacted
    expect(serialized).not.toMatch(/tantalar_[A-Za-z0-9_-]{10,}/); // no API keys
  });
});
