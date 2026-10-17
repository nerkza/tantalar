/**
 * Fixture private-tracker rules plugin (phase 3b, story 8).
 *
 * Owns ALL tracker-specific logic (ADR-0015): the announce-URL guard against
 * this tracker's DECLARED host patterns, and seed/ratio goals. Core asks
 * neutral questions over `dev.tantalar.capability.tracker.rules` and never
 * stores or evaluates tracker rules itself.
 *
 * Announce safety: a download URL passes only when its announce host matches
 * one of the configured host patterns. Verdict reasons are redacted codes —
 * passkeys and full announce URLs never appear in results or events.
 */
import { runPlugin, definePlugin, type PluginDefinition } from "@tantalar/plugin-sdk";
import {
  PROTOCOL_VERSION,
  validateManifest,
  type SeedGoal,
  type TrackerAnnounceVerdict,
} from "@tantalar/contracts";

const RULES_CAPABILITY = "dev.tantalar.capability.tracker.rules";
const PLUGIN_ID = "dev.tantalar.plugin.fixture-tracker";

const manifest = validateManifest({
  id: PLUGIN_ID,
  version: "0.1.0",
  protocolVersion: PROTOCOL_VERSION,
  provides: [RULES_CAPABILITY],
  requires: ["dev.tantalar.capability.event.emit", "dev.tantalar.capability.log"],
  subscriptions: [],
  entry: { command: "node dist/plugin.js" },
});

function loadConfig(): Record<string, unknown> {
  return JSON.parse(process.env["TANTALAR_PLUGIN_CONFIG"] ?? "{}") as Record<string, unknown>;
}

/** Declared host patterns, e.g. ["tracker.fixture.invalid"]. Config-driven. */
let hostPatterns: string[] = ["tracker.fixture.invalid"];
/** Seed goal: ratio 1.0 or 60 minutes, whichever first (config-overridable). */
let seedGoal: SeedGoal = { ratio: 1, seedMinutes: 60 };

function safeUrl(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

function checkAnnounce(downloadUrl: string): TrackerAnnounceVerdict {
  const parsed = safeUrl(downloadUrl);
  if (!parsed) return { allowed: false, reason: "malformed_url" };
  // The guard evaluates the ANNOUNCE host inside the URL (query param or
  // hostname); passkey values are ignored and never echoed.
  const announceParam = parsed.searchParams.get("announce");
  const candidateHosts = [parsed.hostname];
  if (announceParam !== null) {
    const announceUrl = safeUrl(announceParam);
    if (!announceUrl) return { allowed: false, reason: "malformed_url" };
    candidateHosts.push(announceUrl.hostname);
  }
  const matched = candidateHosts.some((h) =>
    hostPatterns.some((p) => h === p || h.endsWith(`.${p}`)),
  );
  if (!matched) return { allowed: false, reason: "host_not_declared" };
  return { allowed: true, reason: "host_allowed" };
}

let emitFn: ((type: string, payload: Record<string, unknown>, opts?: { correlationId?: string }) => Promise<void>) | null =
  null;

const plugin: PluginDefinition = definePlugin({
  manifest,
  mount(ctx) {
    const cfg = ctx.config;
    if (Array.isArray(cfg.hostPatterns)) {
      hostPatterns = (cfg.hostPatterns as unknown[]).map(String);
    }
    if (typeof cfg.ratio === "number" || typeof cfg.seedMinutes === "number") {
      seedGoal = {
        ratio: typeof cfg.ratio === "number" ? cfg.ratio : null,
        seedMinutes: typeof cfg.seedMinutes === "number" ? cfg.seedMinutes : null,
      };
    }
    emitFn = async (type, payload, opts) => {
      await ctx.emit(type, payload, opts);
    };
    ctx.log("info", "fixture-tracker mounted");
  },
  unmount(ctx) {
    emitFn = null;
    ctx.log("info", "fixture-tracker unmounted");
  },
  handlers: {
    [RULES_CAPABILITY]: async (operation, payload) => {
      switch (operation) {
        case "check-announce": {
          const url = String(payload.downloadUrl ?? "");
          const verdict = checkAnnounce(url);
          await emitFn?.("dev.tantalar.event.tracker.announce.checked", {
            allowed: verdict.allowed,
            reason: verdict.reason,
            // Redaction invariant: no raw URL material in the event.
          });
          return verdict;
        }
        case "seed-goal":
          return seedGoal;
        case "declared-hosts":
          return { hosts: hostPatterns };
        case "conformance-probe":
          return { ok: true };
        default:
          throw new Error(`unknown operation ${operation}`);
      }
    },
  },
});

runPlugin(plugin);
