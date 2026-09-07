import { expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { createServer as httpServer } from "node:http";
import { createServer as tlsServer, type TLSSocket } from "node:tls";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { connect, type AddressInfo, type Socket } from "node:net";
import { once } from "node:events";
import { boot, type Kernel } from "../apps/server/src/kernel.js";
import { encodeYenc } from "../plugins/usenet-native/src/fixtures.js";
import { postprocessTools } from "../plugins/usenet-native/src/postprocess.js";

const importErrors = vi.hoisted(() => [] as string[]);
vi.mock("../apps/server/src/download-manager.js", async original => {
  const module = await original<typeof import("../apps/server/src/download-manager.js")>();
  return { syncDownloadJobs: (jobs: any, container: any, completed: any) => module.syncDownloadJobs(jobs, container, async (job, provider) => {
    try { return await completed(job, provider); }
    catch (error) { importErrors.push(String(error)); throw error; }
  }) };
});

it.each(["movie", "series"] as const)("searches, downloads, imports, manages, and plays a %s across restart", async (kind) => {
  importErrors.length = 0;
  const root = realpathSync(mkdtempSync(join(tmpdir(), "tantalar-journey-")));
  const cert = resolve("tests/fixtures/usenet/localhost-cert.pem");
  const previousCa = process.env.NODE_EXTRA_CA_CERTS;
  process.env.NODE_EXTRA_CA_CERTS = cert;
  const sockets = new Set<TLSSocket>();
  let kernel: Kernel | undefined;
  let idle: Socket | undefined;
  const nntp = tlsServer({ cert: readFileSync(cert), key: readFileSync(resolve("tests/fixtures/usenet/localhost-key.pem")) });
  const indexer = httpServer();
  try {
    const videoPath = join(root, "Journey.mp4");
    execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "testsrc2=size=160x90:rate=24", "-f", "lavfi", "-i", "sine=frequency=440", "-t", "2", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-movflags", "+faststart", videoPath], { stdio: "pipe" });
    const video = readFileSync(videoPath);
    execFileSync(postprocessTools.archive!, ["a", "Journey.zip", "Journey.mp4"], { cwd: root, stdio: "pipe" });
    const archive = readFileSync(join(root, "Journey.zip"));
    const article = encodeYenc(archive, "Journey.zip").split(/\r?\n/).map(line => line.startsWith(".") ? `.${line}` : line).join("\r\n");
    nntp.on("secureConnection", socket => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      socket.setEncoding("latin1");
      socket.write("200 fixture ready\r\n");
      let buffer = "";
      socket.on("data", chunk => {
        buffer += chunk;
        let end: number;
        while ((end = buffer.indexOf("\r\n")) >= 0) {
          const command = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          if (command === "AUTHINFO USER fixture") socket.write("381 password required\r\n");
          else if (command === "AUTHINFO PASS fixture-password") socket.write("281 accepted\r\n");
          else if (command === "ARTICLE <video@fixture.invalid>") socket.write(`220 article follows\r\n\r\n${article}\r\n.\r\n`, "latin1");
          else if (command.startsWith("ARTICLE ")) socket.write("220 informational sidecar\r\n\r\nPlain text release notes.\r\n.\r\n");
          else if (command === "QUIT") socket.end("205 bye\r\n");
          else socket.write("500 unsupported\r\n");
        }
      });
    });
    nntp.on("tlsClientError", () => undefined);
    await new Promise<void>(done => nntp.listen(0, "127.0.0.1", done));
    await new Promise<void>(done => indexer.listen(0, "127.0.0.1", done));
    const indexerUrl = `http://127.0.0.1:${(indexer.address() as AddressInfo).port}`;
    const nzb = `<nzb><file subject="Journey.nfo"><segments><segment number="1" bytes="10">missing@fixture.invalid</segment></segments></file><file subject="Journey.zip"><segments><segment number="1" bytes="${archive.length}">video@fixture.invalid</segment></segments></file></nzb>`;
    let nzbRequests = 0;
    indexer.on("request", (req, res) => {
      const url = new URL(req.url!, indexerUrl);
      res.setHeader("content-type", "application/xml");
      if (url.pathname === "/release.nzb") {
        expect(url.searchParams.get("token")).toBe("fixture");
        nzbRequests++;
        res.end(nzb);
      } else if (url.searchParams.get("t") === "caps") {
        res.end('<caps><searching><search available="yes"/><movie-search available="yes"/><tv-search available="yes"/></searching><categories><category id="2000" name="Movies"/><category id="5000" name="TV"/></categories></caps>');
      } else {
        res.end(`<rss xmlns:newznab="http://www.newznab.com/DTD/2010/feeds/attributes/"><channel><item><title>Journey ${kind === "series" ? "S01E01" : "2024"} 1080p WEB-DL</title><guid>journey-fixture</guid><pubDate>${new Date().toUTCString()}</pubDate><enclosure url="${indexerUrl}/release.nzb?id=1&amp;token=fixture" length="${archive.length}" type="application/x-nzb"/><newznab:attr name="category" value="${kind === "series" ? "5000" : "2000"}"/></item></channel></rss>`);
      }
    });
    kernel = await boot({ cliOverrides: { database: { dialect: "sqlite", sqlite: { path: join(root, "tantalar.db") } } } });
    await kernel.supervisor.unmount("dev.tantalar.plugin.metadata-tmdb-tvdb");
    const metadata = { externalId: "tmdb-990001", kind, name: "Journey", year: 2024, releaseDate: "2024-01-01", provider: "tmdb", source: "fixture", locale: "en-US", fetchedAt: new Date().toISOString() };
    let episodes = [{ season: 1, episode: 1, externalId: "tmdb-990002", title: "First steps", airDate: "2024-01-01", runtimeMinutes: 42, stillPath: "/episode.jpg", overview: "Episode summary" }];
    kernel.container.register({ pluginId: "dev.tantalar.plugin.fixture-metadata", capability: "dev.tantalar.capability.metadata-provider", invoke: async operation => operation === "search" ? { candidates: [metadata] } : { found: true, metadata, episodes } });
    let address = await kernel.listen("127.0.0.1", 0);
    let cookie = "", csrf = "";
    const request = async (path: string, method = "GET", body?: unknown, expected = 200) => {
      const response = await fetch(`${address}${path}`, { method, headers: { cookie, "x-csrf-token": csrf, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
      const data = await response.json() as any;
      expect(response.status, `${path}: ${JSON.stringify(data)}`).toBe(expected);
      return { response, data };
    };
    await request("/api/v1/bootstrap/admin", "POST", { username: "admin", password: "fixture-password" });
    const login = await request("/api/v1/auth/login", "POST", { username: "admin", password: "fixture-password" });
    cookie = login.response.headers.getSetCookie().map(value => value.split(";")[0]).join("; ");
    csrf = login.data.csrfToken;
    // The legal short fixture is smaller than production episode size minimums.
    const quality = (await request("/api/v1/quality")).data;
    for (const rule of Object.values(quality.sizes.series) as Array<{ min: number }>) rule.min = 0;
    await request("/api/v1/quality", "PUT", quality);
    const mediaRoot = join(root, "library");
    mkdirSync(mediaRoot);
    const library = await request("/api/v1/libraries", "POST", { name: "Journey", rootPath: mediaRoot, kind }, 201);
    await request("/api/v1/acquisition/usenet", "PUT", { servers: [{ id: "fixture", name: "Fixture", host: "localhost", port: (nntp.address() as AddressInfo).port, tls: "implicit", username: "fixture", password: "fixture-password", confirmPassword: "fixture-password", priority: 0, connections: 1 }] });
    await request("/api/v1/indexers", "POST", { name: "Fixture", protocol: "newznab", baseUrl: indexerUrl, apiKey: "fixture", enabled: true }, 201);
    const search = await request(`/api/v1/acquisition/search?query=Journey&kind=${kind}`);
    const managed = await request("/api/v1/acquisition/managed", "POST", { ...search.data.candidates[0], destinationLibraryId: library.data.library.id, qualityProfile: "any", minimumAvailability: "announced" }, 201);
    const path = `/api/v1/acquisition/managed/${kind}/${managed.data.item.id}`;
    const itemKey = managed.data.item.id + (kind === "series" ? ":S01E01" : "");
    const releases = await request(`${path}/releases${kind === "series" ? "?episodeKey=S01E01" : ""}`);
    expect(releases.data.releases, JSON.stringify(releases.data)).toHaveLength(1);
    await request(`${path}/grab`, "POST", { releaseId: releases.data.releases[0].releaseId, ...(kind === "series" ? { episodeKey: "S01E01" } : {}) }, 202);
    let row: any;
    const deadline = Date.now() + 30_000;
    do {
      row = await kernel.db.selectFrom("download_jobs").selectAll().where("itemKey", "=", itemKey).executeTakeFirst();
      expect(row?.state === "failed" ? row.failureReason : undefined).toBeUndefined();
      if (row?.importHandoffPath) break;
      await new Promise(done => setTimeout(done, 200));
    } while (Date.now() < deadline);
    expect(nzbRequests).toBe(1);
    expect(row?.state).toBe("completed");
    expect(row?.importHandoffPath, importErrors.join("\n")).toBeTruthy();
    expect(readFileSync(row.importHandoffPath)).toEqual(video);
    const catalog = await kernel.db.selectFrom("media_catalog").selectAll().where("itemKey", "=", itemKey).executeTakeFirstOrThrow();
    const detail = await request(path);
    expect(detail.data.files.map((file: any) => file.fileId)).toContain(catalog.fileId);
    if (kind === "movie") {
      const movie = await kernel.container.resolve("dev.tantalar.capability.automation.movies").invoke("get-movie", { movieId: managed.data.item.id }) as { acquiredGuid: string };
      expect(movie.acquiredGuid).toBe(`file:${catalog.fileId}`);
    } else {
      expect(catalog.path).toMatch(/Season 01.*S01E01/);
      expect(detail.data.item.episodes[0]).toMatchObject({ title: "First steps", runtimeMinutes: 42, airDate: "2024-01-01", artworkUrl: expect.stringContaining("/artwork/") });
      const page = await request(`${path}/episodes?search=First&filter_season=1&pageSize=1`);
      expect(page.data.total).toBe(1);
      expect((await request(`${path}/episodes?filter_season=2`)).data.total).toBe(0);
      const local = await request("/api/v1/library");
      expect(local.data.items.find((item: any) => item.fileId === catalog.fileId).episode).toMatchObject({ title: "First steps", runtimeMinutes: 42 });
      const originalId = metadata.externalId;
      metadata.externalId = "tmdb-999999";
      expect((await request(`${path}/refresh`, "POST", {}, 409)).data.error).toContain("different identity");
      metadata.externalId = originalId;
      episodes = [{ ...episodes[0]!, externalId: "tmdb-990003", title: "Provider correction" }];
      const review = (await request(`${path}/refresh`, "POST", {}, 409)).data.review;
      expect((await request(path)).data.item.episodes[0].title).toBe("First steps");
      episodes[0]!.title = "Changed again";
      const newer = (await request(`${path}/refresh`, "POST", { reviewToken: review.token }, 409)).data.review;
      await request(`${path}/refresh`, "POST", { reviewToken: newer.token });
      episodes = [];
      await request(`${path}/refresh`, "POST", {}, 409);
      episodes = [{ season: 1, episode: 2, externalId: "tmdb-990004", title: "Second steps", airDate: "2024-01-08", runtimeMinutes: 44, stillPath: "/two.jpg", overview: "Another episode" }];
      const removed = (await request(`${path}/refresh`, "POST", {}, 409)).data.review;
      await request(`${path}/refresh`, "POST", { reviewToken: removed.token });
      expect((await request(path)).data.item.episodes.map((episode: any) => episode.episodeKey)).toContain("S01E01");
      const series = kernel.container.resolve("dev.tantalar.capability.automation.series");
      const other = await series.invoke("add-series", { ...metadata, externalId: "tmdb-990999", episodes, monitorMode: "none" }) as { seriesId: string };
      expect(other.seriesId).not.toBe(managed.data.item.id);
      expect(await series.invoke("get-series", { seriesId: managed.data.item.id })).toMatchObject({ externalId: originalId, acquiredEpisodeKeys: ["S01E01"] });
    }
    const negotiated = await request(`/api/v1/negotiate/${catalog.fileId}`, "POST", { canPlayContainers: ["mp4"], canPlayVideo: ["h264"], canPlayAudio: ["aac"], canDirectSubtitles: ["srt", "vtt"] });
    expect(negotiated.data.decision.mode).toBe("direct");
    const stream = await fetch(`${address}${negotiated.data.decision.streamUrl}`, { headers: { cookie } });
    expect(stream.status).toBe(200);
    expect(Buffer.from(await stream.arrayBuffer())).toEqual(video);
    const range = await fetch(`${address}${negotiated.data.decision.streamUrl}`, { headers: { cookie, range: "bytes=0-1023" } });
    expect(range.status).toBe(206);
    expect(Buffer.from(await range.arrayBuffer())).toEqual(video.subarray(0, 1024));
    await kernel.shutdown();
    kernel = await boot({ cliOverrides: { database: { dialect: "sqlite", sqlite: { path: join(root, "tantalar.db") } } } });
    address = await kernel.listen("127.0.0.1", 0);
    const resumed = await request(`/api/v1/negotiate/${catalog.fileId}`, "POST", { canPlayContainers: ["mp4"], canPlayVideo: ["h264"], canPlayAudio: ["aac"], canDirectSubtitles: [] });
    const restoredStream = await fetch(`${address}${resumed.data.decision.streamUrl}`, { headers: { cookie } });
    expect(restoredStream.status).toBe(200);
    expect(Buffer.from(await restoredStream.arrayBuffer())).toEqual(video);
    expect(await kernel.db.selectFrom("media_catalog").selectAll().execute()).toHaveLength(1);
    if (kind === "series") {
      const restoredSeries = await kernel.container.resolve("dev.tantalar.capability.automation.series").invoke("get-series", { seriesId: managed.data.item.id }) as { episodes: unknown[] };
      expect(restoredSeries.episodes).toEqual(expect.arrayContaining([expect.objectContaining({ episodeKey: "S01E01", title: "Changed again", runtimeMinutes: 42 })]));
      // Browsers may preconnect without sending an HTTP request. Such sockets
      // must not keep the server alive indefinitely during a restart.
      idle = connect(Number(new URL(address).port), "127.0.0.1");
      idle.on("error", error => expect((error as NodeJS.ErrnoException).code).toBe("ECONNRESET"));
      await once(idle, "connect");
    }
  } finally {
    await kernel?.shutdown();
    idle?.destroy();
    for (const socket of sockets) socket.destroy();
    await Promise.all([new Promise<void>(done => nntp.close(() => done())), new Promise<void>(done => indexer.close(() => done()))]);
    if (previousCa === undefined) delete process.env.NODE_EXTRA_CA_CERTS;
    else process.env.NODE_EXTRA_CA_CERTS = previousCa;
    rmSync(root, { recursive: true, force: true });
  }
}, 60_000);
