/**
 * Real in-process BitTorrent transport.
 *
 * This intentionally exposes only a loopback-tracker tracer mode. DHT, LSD,
 * PEX, web seeds, NAT traversal and uTP stay disabled until Tantalar can bind
 * every socket to an enforced VPN network boundary. No external daemon is
 * started or contacted.
 *
 * WebTorrent and the quarantine store are MIT licensed. WebTorrent is pinned
 * to 1.9.7 because later releases require either obsolete JSON import syntax
 * on Node 22+ or a native WebRTC build blocked by this repository's dependency
 * policy. The upgrade remains explicit release debt, not hidden runtime magic.
 */
import { createHash } from "node:crypto";
import {
  createReadStream,
  existsSync,
  lstatSync,
  readFileSync,
} from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import WebTorrent from "webtorrent";
import MemoryChunkStore from "memory-chunk-store";
import {
  DEFAULT_TORRENT_LIMITS,
  parseMagnet,
  parseTorrentFile,
  pieceCoverage,
  type EngineFile,
  type EngineTorrent,
  type TorrentEngine,
  type TorrentInputLimits,
} from "./engine.js";

type NativeTorrent = WebTorrent.Torrent & {
  readonly torrentFile: Buffer;
  readonly pieces: Array<unknown | null>;
  readonly wires: Array<{ destroy(): void }>;
  readonly discovery?: { tracker?: { update(): void } };
};

type ParsedTorrent = ReturnType<typeof parseTorrentFile>;

interface LiveTorrent {
  readonly native: NativeTorrent;
  readonly parsed: ParsedTorrent;
  readonly view: EngineTorrent;
  readonly storageBase: string;
  completedAt: number | null;
}

export interface WebTorrentEngineOptions extends Partial<TorrentInputLimits> {
  /** Only disabled and loopback are accepted before the VPN boundary exists. */
  readonly trackerMode?: "disabled" | "loopback";
  readonly metadataTimeoutMs?: number;
  readonly maxConnections?: number;
  readonly downloadLimitBytesPerSecond?: number;
  readonly uploadLimitBytesPerSecond?: number;
}

function errorOf(value: Error | string): Error {
  return value instanceof Error ? value : new Error(value);
}

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return host === "localhost" || host === "::1" || /^127(?:\.[0-9]{1,3}){3}$/.test(host);
}

function expectedNativePaths(parsed: ParsedTorrent): string[] {
  return parsed.multiFile ? parsed.files.map((file) => `${parsed.name}/${file.path}`) : [parsed.name];
}

function assertNoSymlinkComponents(root: string, relativePath = ""): void {
  let cursor = resolve(root);
  if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink()) {
    throw new Error(`torrent: symlink path component rejected: ${cursor}`);
  }
  for (const segment of relativePath.split("/").filter(Boolean)) {
    cursor = join(cursor, segment);
    if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink()) {
      throw new Error(`torrent: symlink path component rejected: ${cursor}`);
    }
  }
}

function assertTargetLayout(
  storageBase: string,
  parsed: ParsedTorrent,
  allowExisting: boolean,
): void {
  const root = resolve(storageBase);
  assertNoSymlinkComponents(root);
  for (const [index, relativePath] of expectedNativePaths(parsed).entries()) {
    const target = resolve(root, relativePath);
    if (target !== root && !target.startsWith(root + sep)) throw new Error("torrent: target escapes download root");
    assertNoSymlinkComponents(root, relativePath.split("/").slice(0, -1).join("/"));
    if (!existsSync(target)) continue;
    const stat = lstatSync(target);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`torrent: unsafe existing target ${relativePath}`);
    if (!allowExisting) throw new Error(`torrent: target already exists ${relativePath}`);
    const expectedLength = parsed.files[index]?.lengthBytes ?? -1;
    if (stat.size > expectedLength) throw new Error(`torrent: existing target exceeds expected size ${relativePath}`);
  }
}

export class WebTorrentEngine implements TorrentEngine {
  readonly #client: WebTorrent.Instance;
  readonly #limits: TorrentInputLimits;
  readonly #trackerMode: "disabled" | "loopback";
  readonly #metadataTimeoutMs: number;
  readonly #live = new Map<string, LiveTorrent>();
  #fatalError: Error | null = null;

  constructor(options: WebTorrentEngineOptions = {}) {
    this.#trackerMode = options.trackerMode ?? "disabled";
    this.#metadataTimeoutMs = Math.min(120_000, Math.max(1_000, options.metadataTimeoutMs ?? 30_000));
    this.#limits = {
      maxMetadataBytes: options.maxMetadataBytes ?? DEFAULT_TORRENT_LIMITS.maxMetadataBytes,
      maxFiles: options.maxFiles ?? DEFAULT_TORRENT_LIMITS.maxFiles,
      maxPathBytes: options.maxPathBytes ?? DEFAULT_TORRENT_LIMITS.maxPathBytes,
      maxPathDepth: options.maxPathDepth ?? DEFAULT_TORRENT_LIMITS.maxPathDepth,
      maxPayloadBytes: options.maxPayloadBytes ?? DEFAULT_TORRENT_LIMITS.maxPayloadBytes,
      maxPieces: options.maxPieces ?? DEFAULT_TORRENT_LIMITS.maxPieces,
    };
    this.#client = new WebTorrent({
      maxConns: Math.min(200, Math.max(1, options.maxConnections ?? 40)),
      tracker: this.#trackerMode === "loopback" ? {} : false,
      dht: false,
      lsd: false,
      webSeeds: false,
      utp: false,
      // Not represented by the older bundled type declaration, but supported
      // by the pinned runtime. These prevent ambient peer/NAT discovery.
      utPex: false,
      natUpnp: false,
      natPmp: false,
      downloadLimit: options.downloadLimitBytesPerSecond ?? -1,
      uploadLimit: options.uploadLimitBytesPerSecond ?? -1,
    } as WebTorrent.Options);
    this.#client.on("error", (error) => {
      this.#fatalError = errorOf(error);
    });
  }

  async add(input: {
    source: string;
    sourceKind: "file" | "magnet";
    downloadPath: string;
    fileSelection?: string[];
    allowExisting?: boolean;
  }): Promise<EngineTorrent> {
    if (this.#fatalError) throw this.#fatalError;
    if (input.sourceKind === "magnet") {
      const magnet = parseMagnet(input.source);
      const existing = this.#live.get(magnet.infoHash);
      if (existing) return this.#sync(existing);
      if (this.#trackerMode !== "loopback") {
        throw new Error("torrent: magnet metadata requires explicitly enabled loopback tracker mode");
      }
      this.#assertTrackerPolicy(magnet.trackers);
      const metadata = await this.#fetchMagnetMetadata(input.source, magnet.infoHash);
      const parsed = parseTorrentFile(metadata, this.#limits);
      if (parsed.infoHash !== magnet.infoHash) throw new Error("torrent: magnet metadata hash mismatch");
      return this.#addValidated(metadata, parsed, input, input.source);
    }

    const stat = lstatSync(input.source);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("torrent: metainfo must be a regular file");
    if (stat.size > this.#limits.maxMetadataBytes) throw new Error("torrent: metadata exceeds limit");
    const metadata = readFileSync(input.source);
    const parsed = parseTorrentFile(metadata, this.#limits);
    const existing = this.#live.get(parsed.infoHash);
    if (existing) return this.#sync(existing);
    return this.#addValidated(metadata, parsed, input);
  }

  get(infoHash: string): EngineTorrent | undefined {
    const live = this.#live.get(infoHash.toLowerCase());
    return live ? this.#sync(live) : undefined;
  }

  list(): EngineTorrent[] {
    return [...this.#live.values()].map((live) => this.#sync(live));
  }

  pause(infoHash: string): void {
    const live = this.#require(infoHash);
    live.native.pause();
    for (const [index, file] of live.native.files.entries()) {
      if (live.view.files[index]?.selected) file.deselect();
    }
    // WebTorrent's pause() only stops new connections. Drop existing peer
    // wires so already-pipelined requests cannot continue indefinitely.
    for (const wire of [...live.native.wires]) wire.destroy();
    live.view.paused = true;
  }

  resume(infoHash: string): void {
    const live = this.#require(infoHash);
    for (const [index, file] of live.native.files.entries()) {
      if (live.view.files[index]?.selected) file.select();
    }
    live.native.resume();
    live.native.discovery?.tracker?.update();
    live.view.paused = false;
  }

  selectFiles(infoHash: string, paths: readonly string[]): void {
    const live = this.#require(infoHash);
    const wanted = new Set(paths);
    for (const [index, file] of live.native.files.entries()) {
      const view = live.view.files[index];
      if (!view) continue;
      view.selected = wanted.has(view.path);
      if (view.selected) file.select();
      else file.deselect();
    }
  }

  async remove(infoHash: string, opts: { keepFiles?: boolean } = {}): Promise<void> {
    const live = this.#require(infoHash);
    await this.#removeNative(live.native.infoHash, opts.keepFiles === false);
    this.#live.delete(live.native.infoHash);
  }

  async verify(infoHash: string): Promise<{
    verifiedPieces: number;
    totalPieces: number;
    corruptedFiles: string[];
  }> {
    const live = this.#require(infoHash);
    const coverage = pieceCoverage(live.view);
    const corrupted = new Set<string>();
    let pending = Buffer.alloc(0);
    let pieceIndex = 0;
    let verifiedPieces = 0;

    const verifyPiece = (piece: Buffer): void => {
      const expected = live.parsed.pieceHashes[pieceIndex];
      const actual = createHash("sha1").update(piece).digest("hex");
      if (expected === actual) verifiedPieces += 1;
      else for (const fileIndex of coverage[pieceIndex] ?? []) corrupted.add(live.view.files[fileIndex]!.path);
      pieceIndex += 1;
    };

    try {
      for (const file of live.view.files) {
        const stream = createReadStream(join(live.view.downloadPath, file.path));
        for await (const chunk of stream) {
          pending = Buffer.concat([pending, Buffer.from(chunk)]);
          while (pending.length >= live.parsed.pieceLength) {
            verifyPiece(pending.subarray(0, live.parsed.pieceLength));
            pending = pending.subarray(live.parsed.pieceLength);
          }
        }
      }
      if (pending.length > 0) verifyPiece(pending);
    } catch {
      for (const file of live.view.files) corrupted.add(file.path);
      verifiedPieces = 0;
    }

    if (pieceIndex !== live.parsed.piecesTotal) {
      for (const file of live.view.files) corrupted.add(file.path);
      verifiedPieces = 0;
    }
    return {
      verifiedPieces,
      totalPieces: live.parsed.piecesTotal,
      corruptedFiles: [...corrupted].sort(),
    };
  }

  async destroy(): Promise<void> {
    if ((this.#client as WebTorrent.Instance & { destroyed?: boolean }).destroyed) return;
    await new Promise<void>((resolvePromise) => {
      this.#client.destroy(() => resolvePromise());
    });
    this.#live.clear();
  }

  async #addValidated(
    metadata: Buffer,
    parsed: ParsedTorrent,
    input: {
      downloadPath: string;
      fileSelection?: string[];
      allowExisting?: boolean;
    },
    originalMagnet?: string,
  ): Promise<EngineTorrent> {
    this.#assertTrackerPolicy(parsed.announceUrls);
    const storageBase = dirname(resolve(input.downloadPath));
    assertTargetLayout(storageBase, parsed, input.allowExisting === true);
    const native = await this.#waitForReady(metadata, storageBase);
    if (native.infoHash.toLowerCase() !== parsed.infoHash) throw new Error("torrent: engine metadata identity mismatch");

    const expected = expectedNativePaths(parsed);
    const actual = native.files.map((file) => file.path);
    if (expected.length !== actual.length || expected.some((path, index) => path !== actual[index])) {
      await this.#removeNative(native.infoHash, true);
      throw new Error("torrent: engine produced an unexpected file layout");
    }

    const wanted = input.fileSelection ? new Set(input.fileSelection) : null;
    const files: EngineFile[] = native.files.map((file) => ({
      path: file.path,
      lengthBytes: file.length,
      selected: wanted ? wanted.has(file.path) : true,
      downloadedBytes: file.downloaded,
    }));
    const unknownSelections = wanted ? [...wanted].filter((path) => !files.some((file) => file.path === path)) : [];
    if (unknownSelections.length > 0) {
      await this.#removeNative(native.infoHash, true);
      throw new Error(`torrent: unknown selected file ${unknownSelections[0]}`);
    }

    const view: EngineTorrent = {
      infoHash: native.infoHash.toLowerCase(),
      name: parsed.name,
      sizeBytes: parsed.files.reduce((total, file) => total + file.lengthBytes, 0),
      pieceLength: parsed.pieceLength,
      piecesTotal: parsed.piecesTotal,
      announceUrls: parsed.announceUrls,
      magnetUri: originalMagnet ?? native.magnetURI,
      files,
      downloadPath: storageBase,
      paused: false,
      receivedBytes: native.downloaded,
      done: native.done,
      piecesVerified: 0,
      seedingSeconds: 0,
      uploadedBytes: native.uploaded,
    };
    const live: LiveTorrent = {
      native,
      parsed,
      view,
      storageBase,
      completedAt: native.done ? Date.now() : null,
    };
    native.on("done", () => {
      live.completedAt ??= Date.now();
      this.#sync(live);
    });
    native.on("warning", () => undefined);
    native.on("error", (error) => {
      this.#fatalError = errorOf(error);
    });
    this.#live.set(view.infoHash, live);
    this.selectFiles(view.infoHash, wanted ? [...wanted] : files.map((file) => file.path));
    return this.#sync(live);
  }

  async #fetchMagnetMetadata(magnetUri: string, expectedInfoHash: string): Promise<Buffer> {
    const torrent = this.#client.add(magnetUri, {
      store: MemoryChunkStore as unknown as WebTorrent.TorrentOptions["store"],
      private: true,
      skipVerify: true,
      storeCacheSlots: 0,
    }) as NativeTorrent;
    let timer: NodeJS.Timeout | null = null;
    try {
      const metadata = await new Promise<Buffer>((resolvePromise, reject) => {
        timer = setTimeout(() => reject(new Error("torrent: magnet metadata timed out")), this.#metadataTimeoutMs);
        torrent.once("metadata", () => resolvePromise(Buffer.from(torrent.torrentFile)));
        torrent.once("error", (error) => reject(errorOf(error)));
      });
      if (metadata.length > this.#limits.maxMetadataBytes) throw new Error("torrent: metadata exceeds limit");
      return metadata;
    } finally {
      if (timer) clearTimeout(timer);
      const nativeClient = this.#client as unknown as { get(id: string): NativeTorrent | undefined };
      if (nativeClient.get(expectedInfoHash)) await this.#removeNative(expectedInfoHash, true);
    }
  }

  #waitForReady(metadata: Buffer, storageBase: string): Promise<NativeTorrent> {
    return new Promise((resolvePromise, reject) => {
      let timer: NodeJS.Timeout | null = setTimeout(
        () => reject(new Error("torrent: engine readiness timed out")),
        this.#metadataTimeoutMs,
      );
      const torrent = this.#client.add(metadata, {
        path: storageBase,
        private: true,
        skipVerify: false,
        storeCacheSlots: 0,
        // WebTorrent 1.x supports BEP53's `so` option. Starting with no
        // selected files keeps network writes stopped until all Tantalar
        // path, collision and quota checks have passed.
        so: [],
      } as WebTorrent.TorrentOptions) as NativeTorrent;
      const settle = (fn: () => void): void => {
        if (timer) clearTimeout(timer);
        timer = null;
        fn();
      };
      torrent.once("ready", () => settle(() => resolvePromise(torrent)));
      torrent.once("error", (error) => settle(() => reject(errorOf(error))));
    });
  }

  #assertTrackerPolicy(urls: readonly string[]): void {
    if (this.#trackerMode === "disabled") return;
    if (urls.length === 0) throw new Error("torrent: loopback tracker mode requires an announce URL");
    for (const value of urls) {
      const url = new URL(value);
      if (!isLoopbackHost(url.hostname)) throw new Error("torrent: public tracker blocked by loopback-only policy");
    }
  }

  #require(infoHash: string): LiveTorrent {
    const live = this.#live.get(infoHash.toLowerCase());
    if (!live) throw new Error(`unknown torrent ${infoHash}`);
    return live;
  }

  #sync(live: LiveTorrent): EngineTorrent {
    const { native, view } = live;
    view.paused = native.paused || view.paused;
    view.receivedBytes = native.downloaded;
    view.done = native.done;
    view.piecesVerified = native.pieces.reduce((count, piece) => count + (piece === null ? 1 : 0), 0);
    view.uploadedBytes = native.uploaded;
    if (native.done) live.completedAt ??= Date.now();
    view.seedingSeconds = live.completedAt ? Math.max(0, Math.floor((Date.now() - live.completedAt) / 1000)) : 0;
    for (const [index, file] of native.files.entries()) {
      const target = view.files[index];
      if (target) target.downloadedBytes = file.downloaded;
    }
    return view;
  }

  #removeNative(infoHash: string, destroyStore: boolean): Promise<void> {
    return new Promise((resolvePromise, reject) => {
      try {
        this.#client.remove(infoHash, { destroyStore }, (error) => {
          if (error) reject(errorOf(error));
          else resolvePromise();
        });
      } catch (error) {
        reject(error as Error);
      }
    });
  }
}
