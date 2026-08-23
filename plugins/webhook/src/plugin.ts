/**
 * Outbound webhook plugin (story 29, phase-2): first-party event consumer.
 * Translates subscribed reverse-DNS events to signed HTTP POSTs.
 *  - HMAC-SHA256 signature header (X-Tantalar-Signature: t=<ts>,v1=<hex>)
 *  - optional scoped API key auth header (X-Tantalar-Key) — env only
 *  - bounded retries with exponential backoff
 *  - secret material comes from env vars only; never from config or events
 */
import { createHmac } from "node:crypto";
import { runPlugin, definePlugin, type PluginDefinition } from "@tantalar/plugin-sdk";
import { PROTOCOL_VERSION, validateManifest, EventTypes } from "@tantalar/contracts";

interface WebhookTarget {
  url: string;
  eventTypes: string[];
  secretEnvVar: string;
  maxRetries: number;
}

function loadTargets(config: Record<string, unknown>): WebhookTarget[] {
  const raw = config.targets;
  if (!Array.isArray(raw)) return [];
  return raw
    .map((t) => {
      const rec = t as Record<string, unknown>;
      return {
        url: String(rec.url ?? ""),
        eventTypes: Array.isArray(rec.eventTypes) ? rec.eventTypes.map(String) : [],
        secretEnvVar: String(rec.secretEnvVar ?? ""),
        maxRetries: Number(rec.maxRetries ?? 3),
      };
    })
    .filter((t) => t.url.startsWith("http://") || t.url.startsWith("https://"));
}

function sign(secret: string, body: string, timestamp: number): string {
  const mac = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
  return `t=${timestamp},v1=${mac}`;
}

async function post(
  url: string,
  body: string,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<boolean> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body,
      signal: ctrl.signal,
    });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

const manifest = validateManifest({
  id: "dev.tantalar.plugin.webhook",
  version: "0.1.0",
  protocolVersion: PROTOCOL_VERSION,
  provides: ["dev.tantalar.capability.webhook.status"],
  requires: ["dev.tantalar.capability.event.emit", "dev.tantalar.capability.log"],
  subscriptions: ["dev.tantalar.event."],
  entry: { command: "node dist/plugin.js" },
});

const plugin: PluginDefinition = definePlugin({
  manifest,
  mount() {},
  unmount() {},
  handlers: {
    "dev.tantalar.capability.webhook.status": async () => ({
      targets: loadTargets(JSON.parse(process.env["TANTALAR_PLUGIN_CONFIG"] ?? "{}") as Record<string, unknown>).length,
    }),
  },
  onEventDelivery: async (envelope) => {
    const config = JSON.parse(process.env["TANTALAR_PLUGIN_CONFIG"] ?? "{}") as Record<string, unknown>;
    const targets = loadTargets(config);
    const body = JSON.stringify(envelope);
    for (const t of targets) {
      if (!t.eventTypes.some((p) => String(envelope["type"] ?? "").startsWith(p))) continue;
      const secret = process.env[t.secretEnvVar] ?? "";
      if (!secret) continue; // no secret configured: skip; never log it
      const headers: Record<string, string> = {
        "x-tantalar-signature": sign(secret, body, Math.floor(Date.now() / 1000)),
      };
      const apiKey = process.env["TANTALAR_WEBHOOK_API_KEY"];
      if (apiKey) headers["x-tantalar-key"] = apiKey;
      for (let attempt = 0; attempt <= t.maxRetries; attempt++) {
        if (await post(t.url, body, headers, 10_000)) break;
        if (attempt < t.maxRetries) {
          await new Promise((r) => setTimeout(r, 100 * 2 ** attempt));
        }
      }
    }
  },
});

runPlugin(plugin);
void EventTypes;
