/**
 * qBittorrent download-client plugin (phase 3b, story 3).
 *
 * First-party adapter: speaks the provider-neutral download-client schema
 * from @tantalar/contracts and maps it onto the qBittorrent WebUI API v2.
 * The transport is injected (`transport` config or the default fetch-based
 * adapter) so tests run against an in-process fake — no real qBittorrent
 * instance and no network in CI.
 *
 * Secrets (username/password/API key) come from redacted config and are
 * never logged or emitted in event payloads.
 */
import { runPlugin, definePlugin, type PluginDefinition } from "@tantalar/plugin-sdk";
import {
  PROTOCOL_VERSION,
  validateManifest,
  validateDownloadRequest,
  DownloadClientError,
  type DownloadRequest,
  type DownloadState,
  type DownloadStatus,
  EventTypes,
} from "@tantalar/contracts";

const CLIENT_CAPABILITY = "dev.tantalar.capability.download-client";
const PLUGIN_ID = "dev.tantalar.plugin.qbittorrent";

const manifest = validateManifest({
  id: PLUGIN_ID,
  version: "0.1.0",
  protocolVersion: PROTOCOL_VERSION,
  provides: [CLIENT_CAPABILITY],
  requires: ["dev.tantalar.capability.event.emit", "dev.tantalar.capability.log"],
  subscriptions: [],
  entry: { command: "node dist/plugin.js" },
});

/**
 * Minimal qBittorrent WebUI API surface this plugin uses. A transport maps
 * a (method, path, body) call onto a response; the default transport uses
 * fetch against the configured baseUrl with a login cookie.
 */
export interface QbitTransport {
  call(method: string, path: string, body?: Record<string, unknown>): Promise<unknown>;
}

function defaultTransport(cfg: Record<string, unknown>): QbitTransport {
  if (cfg.transport === "memory") return memoryTransport(cfg.memoryState as Record<string, unknown> | undefined);
  const baseUrl = String(cfg.baseUrl ?? "http://127.0.0.1:8080");
  let cookie: string | null = null;
  return {
    async call(method, path, body) {
      if (path === "/api/v2/auth/login") {
        const res = await fetch(`${baseUrl}${path}`, { method: "POST" });
        cookie = res.headers.get("set-cookie");
        return { ok: res.ok };
      }
      const res = await fetch(`${baseUrl}${path}`, {
        method,
        headers: cookie ? { cookie } : {},
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      if (!res.ok) throw new DownloadClientError("unavailable", `qBittorrent API ${res.status} on ${path}`);
      return res.json();
    },
  };
}

/**
 * In-memory transport (config `transport: "memory"`): simulates the qBittorrent
 * WebUI API in-process so tests run with no network and no real instance.
 * Optional `memoryState.initialState` seeds the state new torrents get.
 */
export function memoryTransport(state?: Record<string, unknown>): QbitTransport {
  const torrents = new Map<string, TorrentRow>();
  let n = 0;
  const initial = String((state?.initialState as string | undefined) ?? "queuedDL");
  return {
    async call(method, path, body) {
      if (path === "/api/v2/torrents/add") {
        n += 1;
        const hash = `mem${String(n).padStart(3, "0")}`;
        torrents.set(hash, { hash, name: String(body?.urls ?? ""), state: initial, progress: 0, size: 512 });
        return { ok: true, hash };
      }
      if (path === "/api/v2/torrents/info") {
        const hash = body?.hash ? String(body.hash) : undefined;
        return [...torrents.values()].filter((t) => !hash || t.hash === hash);
      }
      if (path === "/api/v2/torrents/pause") {
        for (const h of String(body?.hashes ?? "").split(",")) {
          const t = torrents.get(h);
          if (t) t.state = "pausedDL";
        }
        return {};
      }
      if (path === "/api/v2/torrents/resume") {
        for (const h of String(body?.hashes ?? "").split(",")) {
          const t = torrents.get(h);
          if (t) t.state = "downloading";
        }
        return {};
      }
      return {};
    },
  };
}

/** Map a qBittorrent torrent state string onto the normalized state machine. */export function mapQbitState(qbitState: string): DownloadState {
  switch (qbitState) {
    case "downloading":
    case "metaDL":
    case "forcedDL":
      return "downloading";
    case "pausedDL":
    case "stoppedDL":
      return "paused";
    case "pausedUP":
    case "stoppedUP":
    case "uploading":
    case "completed":
      return "completed";
    case "error":
    case "missingFiles":
      return "failed";
    case "queuedDL":
    case "queuedUP":
    default:
      return "queued";
  }
}

interface TorrentRow {
  hash: string;
  name: string;
  state: string;
  progress: number; // 0..1
  size: number;
}

function loadConfig(): Record<string, unknown> {
  return JSON.parse(process.env["TANTALAR_PLUGIN_CONFIG"] ?? "{}") as Record<string, unknown>;
}

let transport: QbitTransport | null = null;
let emitFn: ((type: string, payload: Record<string, unknown>, opts?: { correlationId?: string }) => Promise<void>) | null =
  null;
const itemKeyByHash = new Map<string, string>();

function toStatus(row: TorrentRow): DownloadStatus {
  return {
    downloadId: row.hash,
    itemKey: itemKeyByHash.get(row.hash) ?? row.hash,
    state: mapQbitState(row.state),
    progressPercent: Math.round(row.progress * 100),
    sizeBytes: row.size,
  };
}

const plugin: PluginDefinition = definePlugin({
  manifest,
  mount(ctx) {
    const cfg = ctx.config;
    transport = defaultTransport(cfg);
    emitFn = async (type, payload, opts) => {
      await ctx.emit(type, payload, opts);
    };
    ctx.log("info", "qbittorrent plugin mounted");
  },
  unmount(ctx) {
    transport = null;
    emitFn = null;
    ctx.log("info", "qbittorrent plugin unmounted");
  },
  handlers: {
    [CLIENT_CAPABILITY]: async (operation, payload) => {
      if (!transport) throw new DownloadClientError("unavailable", "plugin not mounted");
      switch (operation) {
        case "add": {
          const req: DownloadRequest = validateDownloadRequest(payload);
          const out = (await transport.call("POST", "/api/v2/torrents/add", {
            urls: req.sourceUrl,
            category: "tantalar",
          })) as { ok?: boolean; hash?: string };
          if (!out?.ok && !out?.hash) throw new DownloadClientError("invalid_request", "qBittorrent rejected the add");
          const hash = String(out.hash ?? req.itemKey);
          itemKeyByHash.set(hash, req.itemKey);
          const row = (await transport.call("GET", "/api/v2/torrents/info", { hash })) as TorrentRow[];
          const found = Array.isArray(row) ? row[0] : undefined;
          const status: DownloadStatus = found
            ? toStatus(found)
            : { downloadId: hash, itemKey: req.itemKey, state: "queued", progressPercent: 0, sizeBytes: 0 };
          await emitFn?.(EventTypes.DownloadQueued, {
            downloadId: status.downloadId,
            itemKey: status.itemKey,
            state: status.state,
          }, req.correlationId !== undefined ? { correlationId: req.correlationId } : undefined);
          return status;
        }
        case "status": {
          const rows = (await transport.call("GET", "/api/v2/torrents/info", { hash: String(payload.downloadId) })) as TorrentRow[];
          const row = Array.isArray(rows) ? rows[0] : undefined;
          if (!row) throw new DownloadClientError("unknown_download", "unknown download");
          return toStatus(row);
        }
        case "list": {
          const rows = (await transport.call("GET", "/api/v2/torrents/info", {})) as TorrentRow[];
          return { downloads: (Array.isArray(rows) ? rows : []).map(toStatus) };
        }
        case "pause":
          await transport.call("POST", "/api/v2/torrents/pause", { hashes: String(payload.downloadId) });
          return { paused: true };
        case "resume":
          await transport.call("POST", "/api/v2/torrents/resume", { hashes: String(payload.downloadId) });
          return { resumed: true };
        case "remove":
          await transport.call("POST", "/api/v2/torrents/delete", { hashes: String(payload.downloadId), deleteFiles: false });
          return { removed: true };
        case "conformance-probe":
          return { ok: true };
        default:
          throw new DownloadClientError("invalid_request", `unknown operation ${operation}`);
      }
    },
  },
});

runPlugin(plugin);
