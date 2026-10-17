/**
 * SABnzbd download-client plugin (phase 3b, story 3).
 *
 * First-party adapter over the provider-neutral download-client schema,
 * mapped onto the SABnzbd JSON API. The API transport is injectable via
 * config (`transport`) so tests run fully in-process — no real SABnzbd and
 * no network in CI.
 *
 * The SABnzbd api key lives only inside the transport layer built from
 * redacted config; it is never logged or placed into event payloads.
 */
import { runPlugin, definePlugin, type PluginDefinition } from "@tantalar/plugin-sdk";
import {
  PROTOCOL_VERSION,
  validateManifest,
  validateDownloadRequest,
  DownloadClientError,
  EventTypes,
  type DownloadRequest,
  type DownloadState,
  type DownloadStatus,
} from "@tantalar/contracts";

const CLIENT_CAPABILITY = "dev.tantalar.capability.download-client";
const PLUGIN_ID = "dev.tantalar.plugin.sabnzbd";

const manifest = validateManifest({
  id: PLUGIN_ID,
  version: "0.1.0",
  protocolVersion: PROTOCOL_VERSION,
  provides: [CLIENT_CAPABILITY],
  requires: ["dev.tantalar.capability.event.emit", "dev.tantalar.capability.log"],
  subscriptions: [],
  entry: { command: "node dist/plugin.js" },
});

/** Minimal SABnzbd JSON-API surface; a transport maps calls onto responses. */
export interface SabTransport {
  call(mode: string, params?: Record<string, unknown>): Promise<Record<string, unknown>>;
}

function defaultTransport(cfg: Record<string, unknown>): SabTransport {
  if (cfg.transport === "memory") return memoryTransport();
  const baseUrl = String(cfg.baseUrl ?? "http://127.0.0.1:8081");
  const apiKey = String(cfg.apiKey ?? ""); // secret; never logged
  return {
    async call(mode, params) {
      const qs = new URLSearchParams({ mode, output: "json", ...(apiKey ? { apikey: apiKey } : {}) });
      for (const [k, v] of Object.entries(params ?? {})) qs.set(k, String(v));
      const res = await fetch(`${baseUrl}/api?${qs.toString()}`);
      if (!res.ok) throw new DownloadClientError("unavailable", `SABnzbd API ${res.status} on ${mode}`);
      return (await res.json()) as Record<string, unknown>;
    },
  };
}

/**
 * In-memory transport (config `transport: "memory"`): simulates the SABnzbd
 * JSON API in-process so tests run with no network and no real instance.
 */
export function memoryTransport(): SabTransport {
  const slots = new Map<string, QueueSlot>();
  let n = 0;
  return {
    async call(mode, params) {
      if (mode === "addurl") {
        n += 1;
        const id = `nzo${n}`;
        slots.set(id, { nzo_id: id, filename: "fixture.nzb", status: "Queued", percentage: 0, size: 256 });
        return { nzo_id: id };
      }
      if (mode === "queue") {
        const search = params?.search ? String(params.search) : undefined;
        return { queue: { slots: [...slots.values()].filter((s) => !search || s.nzo_id === search) } };
      }
      return {};
    },
  };
}

/** Map a SABnzbd status string onto the normalized state machine. */
export function mapSabState(status: string): DownloadState {
  switch (status) {
    case "Downloading":
      return "downloading";
    case "Paused":
      return "paused";
    case "Completed":
      return "completed";
    case "Failed":
      return "failed";
    case "Queued":
    default:
      return "queued";
  }
}

interface QueueSlot {
  nzo_id: string;
  filename: string;
  status: string;
  percentage: number | string;
  size: number | string;
}

function toStatus(slot: QueueSlot): DownloadStatus {
  return {
    downloadId: slot.nzo_id,
    itemKey: itemKeyByNzo.get(slot.nzo_id) ?? slot.nzo_id,
    state: mapSabState(slot.status),
    progressPercent: Number(slot.percentage) || 0,
    sizeBytes: Number(slot.size) || 0,
  };
}

let transport: SabTransport | null = null;
let emitFn: ((type: string, payload: Record<string, unknown>, opts?: { correlationId?: string }) => Promise<void>) | null =
  null;
const itemKeyByNzo = new Map<string, string>();

const plugin: PluginDefinition = definePlugin({
  manifest,
  mount(ctx) {
    transport = defaultTransport(ctx.config);
    emitFn = async (type, payload, opts) => {
      await ctx.emit(type, payload, opts);
    };
    ctx.log("info", "sabnzbd plugin mounted");
  },
  unmount(ctx) {
    transport = null;
    emitFn = null;
    ctx.log("info", "sabnzbd plugin unmounted");
  },
  handlers: {
    [CLIENT_CAPABILITY]: async (operation, payload) => {
      if (!transport) throw new DownloadClientError("unavailable", "plugin not mounted");
      switch (operation) {
        case "add": {
          const req: DownloadRequest = validateDownloadRequest(payload);
          if (req.kind !== "nzb") {
            throw new DownloadClientError("invalid_request", "SABnzbd accepts nzb releases only");
          }
          const out = await transport.call("addurl", { name: req.sourceUrl, category: "tantalar" });
          const nzoId = String((out as { nzo_id?: string }).nzo_id ?? req.itemKey);
          itemKeyByNzo.set(nzoId, req.itemKey);
          const status: DownloadStatus = {
            downloadId: nzoId,
            itemKey: req.itemKey,
            state: "queued",
            progressPercent: 0,
            sizeBytes: 0,
          };
          await emitFn?.(EventTypes.DownloadQueued, {
            downloadId: nzoId,
            itemKey: req.itemKey,
            state: "queued",
          }, req.correlationId !== undefined ? { correlationId: req.correlationId } : undefined);
          return status;
        }
        case "status": {
          const out = await transport.call("queue", { search: String(payload.downloadId) });
          const slots = (out as { queue?: { slots?: QueueSlot[] } }).queue?.slots ?? [];
          const slot = slots.find((s) => s.nzo_id === String(payload.downloadId));
          if (!slot) throw new DownloadClientError("unknown_download", "unknown download");
          return toStatus(slot);
        }
        case "list": {
          const out = await transport.call("queue", {});
          const slots = (out as { queue?: { slots?: QueueSlot[] } }).queue?.slots ?? [];
          return { downloads: slots.map(toStatus) };
        }
        case "pause":
          await transport.call("pause", { nzo_ids: String(payload.downloadId) });
          return { paused: true };
        case "resume":
          await transport.call("resume", { nzo_ids: String(payload.downloadId) });
          return { resumed: true };
        case "remove":
          await transport.call("queue", { name: "delete", del_files: 1, nzo_ids: String(payload.downloadId) });
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
