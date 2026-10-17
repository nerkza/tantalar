/**
 * Fixture download-client plugin (phase 3b).
 *
 * Implements `dev.tantalar.capability.download-client` (add, status, pause,
 * resume, remove, conformance-probe) with the provider-neutral schemas from
 * @tantalar/contracts. Simulates both NZB (SABnzbd-style) and torrent
 * (qBittorrent-style) jobs entirely in-process — no network, no real
 * trackers or usenet providers. Jobs advance through the normalized state
 * machine queued → downloading → completed; failure and cancellation paths
 * are driven by config so tests stay deterministic.
 *
 * Emits `download.progress` and `download.completed` / `download.failed`
 * events with the caller's correlationId for event-log tracing.
 */
import { runPlugin, definePlugin, type PluginDefinition } from "@tantalar/plugin-sdk";
import {
  PROTOCOL_VERSION,
  validateManifest,
  validateDownloadRequest,
  EventTypes,
  DownloadClientError,
  type DownloadRequest,
  type DownloadState,
  type DownloadStatus,
} from "@tantalar/contracts";

const CLIENT_CAPABILITY = "dev.tantalar.capability.download-client";
const PLUGIN_ID = "dev.tantalar.plugin.fixture-download-client";

const manifest = validateManifest({
  id: PLUGIN_ID,
  version: "0.1.0",
  protocolVersion: PROTOCOL_VERSION,
  provides: [CLIENT_CAPABILITY],
  requires: ["dev.tantalar.capability.event.emit", "dev.tantalar.capability.log"],
  subscriptions: [],
  entry: { command: "node dist/plugin.js" },
});

interface Job {
  request: DownloadRequest;
  downloadId: string;
  state: DownloadState;
  progressPercent: number;
  sizeBytes: number;
  error?: string;
}

function loadConfig(): Record<string, unknown> {
  return JSON.parse(process.env["TANTALAR_PLUGIN_CONFIG"] ?? "{}") as Record<string, unknown>;
}

/** Config knobs: failItemKeys (array), cancelItemKeys (array). */
const cfg = loadConfig();
const failItemKeys = new Set(
  Array.isArray(cfg.failItemKeys) ? (cfg.failItemKeys as unknown[]).map(String) : [],
);
const cancelItemKeys = new Set(
  Array.isArray(cfg.cancelItemKeys) ? (cfg.cancelItemKeys as unknown[]).map(String) : [],
);

let emitFn: ((type: string, payload: Record<string, unknown>, opts?: { correlationId?: string }) => Promise<void>) | null =
  null;

const jobs = new Map<string, Job>();
let seq = 0;

async function add(rawPayload: unknown): Promise<DownloadStatus> {
  const req = validateDownloadRequest(rawPayload);
  const existing = [...jobs.values()].find((j) => j.request.itemKey === req.itemKey && j.state !== "failed" && j.state !== "cancelled");
  if (existing) return statusOf(existing); // idempotent add

  seq += 1;
  const job: Job = {
    request: req,
    downloadId: `fixture-dl-${String(seq).padStart(4, "0")}`,
    state: "queued",
    progressPercent: 0,
    sizeBytes: 1024,
  };
  jobs.set(job.downloadId, job);
  await tick(job);
  return statusOf(job);
}

function statusOf(job: Job): DownloadStatus {
  return {
    downloadId: job.downloadId,
    itemKey: job.request.itemKey,
    state: job.state,
    progressPercent: job.progressPercent,
    sizeBytes: job.sizeBytes,
    ...(job.error !== undefined ? { error: job.error } : {}),
  };
}

/** Advance a job one simulated step and emit the matching lifecycle event. */
async function tick(job: Job): Promise<void> {
  if (cancelItemKeys.has(job.request.itemKey)) {
    job.state = "cancelled";
    return;
  }
  if (failItemKeys.has(job.request.itemKey) && job.progressPercent >= 50) {
    job.state = "failed";
    job.error = "simulated transfer failure";
    await emitFn?.(EventTypes.DownloadFailed, {
      downloadId: job.downloadId,
      itemKey: job.request.itemKey,
      error: "simulated transfer failure",
    }, job.request.correlationId !== undefined ? { correlationId: job.request.correlationId } : undefined);
    return;
  }
  job.state = "downloading";
  job.progressPercent = Math.min(100, job.progressPercent + 50);
  await emitFn?.(EventTypes.DownloadProgress, {
    downloadId: job.downloadId,
    itemKey: job.request.itemKey,
    progressPercent: job.progressPercent,
  }, job.request.correlationId !== undefined ? { correlationId: job.request.correlationId } : undefined);
  if (job.progressPercent >= 100) {
    job.state = "completed";
    await emitFn?.(EventTypes.DownloadCompleted, {
      downloadId: job.downloadId,
      itemKey: job.request.itemKey,
      state: "completed",
    }, job.request.correlationId !== undefined ? { correlationId: job.request.correlationId } : undefined);
  }
}

const plugin: PluginDefinition = definePlugin({
  manifest,
  mount(ctx) {
    emitFn = async (type, payload, opts) => {
      await ctx.emit(type, payload, opts);
    };
    ctx.log("info", "fixture-download-client mounted");
  },
  unmount(ctx) {
    emitFn = null;
    ctx.log("info", "fixture-download-client unmounted");
  },
  handlers: {
    [CLIENT_CAPABILITY]: async (operation, payload) => {
      switch (operation) {
        case "add":
          return add(payload);
        case "status": {
          const job = jobs.get(String(payload.downloadId));
          if (!job) throw new DownloadClientError("unknown_download", `unknown download ${String(payload.downloadId)}`);
          return statusOf(job);
        }
        case "list":
          return { downloads: [...jobs.values()].map(statusOf) };
        case "pause": {
          const job = jobs.get(String(payload.downloadId));
          if (!job) throw new DownloadClientError("unknown_download", "unknown download");
          if (job.state === "downloading") job.state = "paused";
          return statusOf(job);
        }
        case "resume": {
          const job = jobs.get(String(payload.downloadId));
          if (!job) throw new DownloadClientError("unknown_download", "unknown download");
          if (job.state === "paused") {
            job.state = "downloading";
            await tick(job);
          }
          return statusOf(job);
        }
        case "remove": {
          const job = jobs.get(String(payload.downloadId));
          if (!job) throw new DownloadClientError("unknown_download", "unknown download");
          job.state = "cancelled";
          jobs.delete(job.downloadId);
          return { removed: true };
        }
        case "advance": {
          // Test surface: drive every active job one deterministic step.
          for (const job of jobs.values()) {
            if (job.state === "queued" || job.state === "downloading") await tick(job);
          }
          return { downloads: [...jobs.values()].map(statusOf) };
        }
        case "conformance-probe":
          return { ok: true };
        default:
          throw new DownloadClientError("invalid_request", `unknown operation ${operation}`);
      }
    },
  },
});

runPlugin(plugin);
