/**
 * Legal loopback-only proof for the embedded WebTorrent transport.
 * No public tracker, DHT, external daemon, or copyrighted fixture is used.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { WebTorrentEngine } from "../plugins/torrent-native/src/webtorrent-engine.js";
import {
  DEFAULT_TORRENT_LIMITS,
  parseTorrentFile,
} from "../plugins/torrent-native/src/engine.js";
import { makeSyntheticTorrent, type SyntheticTorrent } from "../plugins/torrent-native/src/synthetic.js";

type RuntimeTorrent = {
  readonly infoHash: string;
  readonly magnetURI: string;
  readonly done: boolean;
  once(event: string, listener: (...args: unknown[]) => void): void;
};

type RuntimeClient = {
  add(source: Buffer, options: Record<string, unknown>): RuntimeTorrent;
  destroy(callback: () => void): void;
};

type RuntimeClientConstructor = new (options: Record<string, unknown>) => RuntimeClient;

type TrackerServer = {
  readonly http: { address(): { port: number } | string | null };
  listen(port: number, hostname: string, callback: () => void): void;
  close(callback: (error?: Error | null) => void): void;
  on(event: string, listener: (error: Error) => void): void;
};

type TrackerConstructor = new (options: Record<string, unknown>) => TrackerServer;

const requireFromPlugin = createRequire(resolve("plugins/torrent-native/package.json"));

async function runtimeConstructors(): Promise<{
  WebTorrent: RuntimeClientConstructor;
  Tracker: TrackerConstructor;
}> {
  const webTorrentPath = pathToFileURL(requireFromPlugin.resolve("webtorrent")).href;
  const trackerPath = pathToFileURL(resolve("plugins/torrent-native/node_modules/bittorrent-tracker/server.js")).href;
  const [webTorrentModule, trackerModule] = await Promise.all([
    import(webTorrentPath),
    import(trackerPath),
  ]);
  return {
    WebTorrent: webTorrentModule.default as RuntimeClientConstructor,
    Tracker: trackerModule.default as TrackerConstructor,
  };
}

function waitForTorrentEvent(torrent: RuntimeTorrent, event: string, timeoutMs = 10_000): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${event}`)), timeoutMs);
    torrent.once(event, () => {
      clearTimeout(timer);
      resolvePromise();
    });
    torrent.once("error", (error) => {
      clearTimeout(timer);
      reject(error instanceof Error ? error : new Error(String(error)));
    });
  });
}

async function waitUntil(predicate: () => boolean, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("condition timed out");
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  }
}

function materializeSeed(root: string, fixture: SyntheticTorrent): void {
  for (const [relativePath, payload] of Object.entries(fixture.payloads)) {
    const target = join(root, fixture.name, relativePath);
    mkdirSync(resolve(target, ".."), { recursive: true });
    writeFileSync(target, payload);
  }
}

describe("torrent-native real WebTorrent loopback tracer", () => {
  let directory: string;
  let tracker: TrackerServer;
  let trackerUrl: string;
  let seedClient: RuntimeClient;
  let seedTorrent: RuntimeTorrent;
  let fixture: SyntheticTorrent;

  beforeAll(async () => {
    directory = mkdtempSync(join(tmpdir(), "tantalar-webtorrent-"));
    const { WebTorrent, Tracker } = await runtimeConstructors();
    tracker = new Tracker({ http: true, udp: false, ws: false, stats: false });
    tracker.on("error", (error) => { throw error; });
    tracker.on("warning", () => undefined);
    await new Promise<void>((resolvePromise) => tracker.listen(0, "127.0.0.1", resolvePromise));
    const address = tracker.http.address();
    if (!address || typeof address === "string") throw new Error("tracker did not expose a TCP port");
    trackerUrl = `http://127.0.0.1:${address.port}/announce`;

    fixture = makeSyntheticTorrent(join(directory, "metainfo"), "LegalLoopback", {
      fileCount: 2,
      fileBytes: 128 * 1024,
      pieceLength: 16 * 1024,
      announceUrls: [trackerUrl],
    });
    const seedRoot = join(directory, "seed");
    materializeSeed(seedRoot, fixture);
    seedClient = new WebTorrent({
      dht: false,
      tracker: {},
      lsd: false,
      utPex: false,
      utp: false,
      webSeeds: false,
      natUpnp: false,
      natPmp: false,
    });
    seedTorrent = seedClient.add(readFileSync(fixture.torrentPath), {
      path: seedRoot,
      private: true,
      skipVerify: false,
    });
    await waitForTorrentEvent(seedTorrent, "ready");
    expect(seedTorrent.done).toBe(true);
  }, 20_000);

  afterAll(async () => {
    if (seedClient) await new Promise<void>((resolvePromise) => seedClient.destroy(resolvePromise));
    if (tracker) {
      await new Promise<void>((resolvePromise, reject) => {
        tracker.close((error) => error ? reject(error) : resolvePromise());
      });
    }
  });

  it("downloads and verifies a .torrent through the real loopback tracker", async () => {
    const root = join(directory, "download-file");
    mkdirSync(root, { recursive: true });
    const engine = new WebTorrentEngine({
      trackerMode: "loopback",
      metadataTimeoutMs: 10_000,
      downloadLimitBytesPerSecond: 64 * 1024,
    });
    try {
      const added = await engine.add({
        source: fixture.torrentPath,
        sourceKind: "file",
        downloadPath: join(root, fixture.name),
      });
      await waitUntil(() => engine.get(added.infoHash)!.receivedBytes >= fixture.pieceLength);
      engine.pause(added.infoHash);
      expect(engine.get(added.infoHash)?.paused).toBe(true);
      // Already-requested pieces may finish after deselection. Once those
      // bounded requests drain, no new piece may start while paused.
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_000));
      const settledBytes = engine.get(added.infoHash)!.receivedBytes;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
      expect(engine.get(added.infoHash)!.receivedBytes).toBe(settledBytes);
      engine.resume(added.infoHash);
      expect(engine.get(added.infoHash)?.paused).toBe(false);
      await waitUntil(() => engine.get(added.infoHash)?.done === true);
      const completed = engine.get(added.infoHash)!;
      for (const file of completed.files) {
        const relative = file.path.slice(`${fixture.name}/`.length);
        expect(readFileSync(join(completed.downloadPath, file.path))).toEqual(Buffer.from(fixture.payloads[relative]!));
      }
      expect(await engine.verify(added.infoHash)).toEqual({
        verifiedPieces: fixture.piecesTotal,
        totalPieces: fixture.piecesTotal,
        corruptedFiles: [],
      });
      await engine.remove(added.infoHash, { keepFiles: true });
      expect(engine.get(added.infoHash)).toBeUndefined();
      expect(existsSync(join(completed.downloadPath, completed.files[0]!.path))).toBe(true);
    } finally {
      await engine.destroy();
    }
  }, 20_000);

  it("obtains magnet metadata and payload over the same loopback-only swarm", async () => {
    expect(seedTorrent.magnetURI).toContain(encodeURIComponent(trackerUrl));
    const root = join(directory, "download-magnet");
    mkdirSync(root, { recursive: true });
    const engine = new WebTorrentEngine({ trackerMode: "loopback", metadataTimeoutMs: 10_000 });
    try {
      const added = await engine.add({
        source: seedTorrent.magnetURI,
        sourceKind: "magnet",
        downloadPath: join(root, fixture.name),
      });
      await waitUntil(() => engine.get(added.infoHash)?.done === true);
      const completed = engine.get(added.infoHash)!;
      expect(completed.infoHash).toBe(fixture.infoHash);
      expect((await engine.verify(completed.infoHash)).corruptedFiles).toEqual([]);
    } finally {
      await engine.destroy();
    }
  }, 20_000);

  it("recovers verified partial pieces without returning progress to zero", async () => {
    const root = join(directory, "download-resume");
    mkdirSync(root, { recursive: true });
    const first = new WebTorrentEngine({
      trackerMode: "loopback",
      metadataTimeoutMs: 10_000,
      downloadLimitBytesPerSecond: 16 * 1024,
    });
    const added = await first.add({
      source: fixture.torrentPath,
      sourceKind: "file",
      downloadPath: join(root, fixture.name),
    });
    await waitUntil(() => {
      const current = first.get(added.infoHash);
      return Boolean(current && current.receivedBytes >= fixture.pieceLength && !current.done);
    });
    const beforeRestart = first.get(added.infoHash)!.receivedBytes;
    await first.destroy();

    const recovered = new WebTorrentEngine({ trackerMode: "loopback", metadataTimeoutMs: 10_000 });
    try {
      const restored = await recovered.add({
        source: fixture.torrentPath,
        sourceKind: "file",
        downloadPath: join(root, fixture.name),
        allowExisting: true,
      });
      expect(restored.infoHash).toBe(added.infoHash);
      expect(restored.receivedBytes).toBeGreaterThanOrEqual(fixture.pieceLength);
      expect(restored.receivedBytes).toBeLessThanOrEqual(beforeRestart + fixture.pieceLength);
      await waitUntil(() => recovered.get(restored.infoHash)?.done === true);
    } finally {
      await recovered.destroy();
    }
  }, 25_000);

  it("rejects hostile paths, oversized metadata, collisions, and public trackers", async () => {
    const safe = makeSyntheticTorrent(join(directory, "strict"), "Safe", {
      fileCount: 1,
      fileBytes: 32 * 1024,
      pieceLength: 16 * 1024,
      announceUrls: [trackerUrl],
    });
    const malicious = Buffer.from(readFileSync(safe.torrentPath));
    const pathOffset = malicious.indexOf(Buffer.from("Safe.txt"));
    expect(pathOffset).toBeGreaterThanOrEqual(0);
    Buffer.from("../x.txt").copy(malicious, pathOffset);
    expect(() => parseTorrentFile(malicious)).toThrow(/unsafe path/);
    expect(() => parseTorrentFile(Buffer.alloc(DEFAULT_TORRENT_LIMITS.maxMetadataBytes + 1))).toThrow(/metadata exceeds/);

    const publicFixture = makeSyntheticTorrent(join(directory, "strict-public"), "PublicBlocked", {
      fileCount: 1,
      fileBytes: 32 * 1024,
      pieceLength: 16 * 1024,
      announceUrls: ["https://tracker.example.invalid/announce"],
    });
    const root = join(directory, "strict-download");
    mkdirSync(join(root, publicFixture.name), { recursive: true });
    writeFileSync(join(root, publicFixture.name, `${publicFixture.name}.txt`), "collision");
    const engine = new WebTorrentEngine({ trackerMode: "loopback" });
    try {
      await expect(engine.add({
        source: publicFixture.torrentPath,
        sourceKind: "file",
        downloadPath: join(root, publicFixture.name),
      })).rejects.toThrow(/public tracker blocked|target already exists/);
    } finally {
      await engine.destroy();
    }
  });
});
