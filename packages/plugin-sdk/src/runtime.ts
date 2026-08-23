/**
 * Public plugin SDK. Plugins link this, never core.
 * The runtime transport is the canonical protobuf contract (ADR-0004) framed
 * over the supervisor's control channel; `runPlugin` implements that framing
 * so a plugin author never touches protocol code.
 */
import { createInterface } from "node:readline";
import {
  PROTOCOL_VERSION,
  validateManifest,
  type PluginManifest,
} from "@tantalar/contracts";

export interface PluginContext {
  readonly pluginId: string;
  readonly config: Record<string, unknown>;
  /** Emit an event into the bus (appended to the log by core). */
  emit(
    type: string,
    payload: Record<string, unknown>,
    opts?: { subject?: string; correlationId?: string; causationId?: string },
  ): Promise<void>;
  /** Invoke a required capability provided by another plugin or core. */
  invoke(capability: string, operation: string, payload: Record<string, unknown>): Promise<unknown>;
  /**
   * Phase 2 auth introspection (mcp-server.md §3): validate a presented API
   * key and learn its identity + scopes. Raw keys are never returned or
   * logged by core; this call exists precisely to avoid DB access in plugins.
   */
  introspectApiKey(key: string): Promise<{ valid: boolean; identity: string; scopes: string[] }>;
  log(level: "debug" | "info" | "warn" | "error", message: string): void;
}

export interface PluginDefinition {
  manifest: PluginManifest;
  /** Called once after handshake when the plugin mounts. */
  mount(ctx: PluginContext): Promise<void> | void;
  /** Called on unmount; must release everything mount acquired. */
  unmount(ctx: PluginContext): Promise<void> | void;
  /** Capability invocation handlers keyed by capability name. */
  handlers?: Record<string, (operation: string, payload: Record<string, unknown>) => Promise<unknown>>;
  /**
   * Event delivery callback for plugins that declare `subscriptions`.
   * Return value is ignored; throwing marks the delivery failed.
   */
  onEventDelivery?: (envelope: Record<string, unknown>) => Promise<void> | void;
}

export function definePlugin(def: PluginDefinition): PluginDefinition {
  if (!def.manifest || def.manifest.protocolVersion !== PROTOCOL_VERSION) {
    throw new Error(`plugin protocol version mismatch: expected ${PROTOCOL_VERSION}`);
  }
  return def;
}

// ---- Runtime: control-channel server ----------------------------------------

interface IncomingMessage {
  id: string;
  op: string;
  payload?: Record<string, unknown>;
  result?: unknown;
}

/**
 * Serve the canonical control ops (handshake/mount/unmount/ping/call) for a
 * definition. Used by every Tantalar plugin process entrypoint.
 */
export function runPlugin(plugin: PluginDefinition): void {
  const pending = new Map<string, (v: unknown) => void>();
  let seq = 0;
  const nextId = () => `p${++seq}`;
  const send = (msg: Record<string, unknown>): void => {
    process.stdout.write(JSON.stringify(msg) + "\n");
  };
  const waitForResponse = (id: string, timeoutMs = 15000): Promise<unknown> =>
    new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`core request timed out (${timeoutMs}ms)`));
      }, timeoutMs);
      pending.set(id, (v) => {
        clearTimeout(t);
        resolve(v);
      });
    });

  let ctx: PluginContext | null = null;
  const baseCtx: PluginContext = {
    pluginId: plugin.manifest.id,
    config: JSON.parse(process.env["TANTALAR_PLUGIN_CONFIG"] ?? "{}") as Record<string, unknown>,
    emit: async (type, payload, opts) => {
      const id = nextId();
      send({ id, op: "emit", payload: { type, payload, ...opts } });
      await waitForResponse(id);
    },
    invoke: async (capability, operation, payload) => {
      const id = nextId();
      send({ id, op: "invoke", payload: { capability, operation, payload } });
      const raw = (await waitForResponse(id)) as
        | { value?: unknown; error?: string }
        | undefined;
      if (raw && typeof raw === "object" && "error" in raw && raw.error) {
        throw new Error(String(raw.error));
      }
      return raw && typeof raw === "object" && "value" in raw ? raw.value : raw;
    },
    introspectApiKey: async (key) => {
      const id = nextId();
      send({ id, op: "introspect", payload: { api_key: key } });
      const raw = (await waitForResponse(id)) as
        | { value?: { valid?: boolean; identity?: string; scopes?: string[] }; error?: string }
        | undefined;
      const res: { valid?: boolean; identity?: string; scopes?: string[] } | undefined =
        raw && typeof raw === "object" && "value" in raw ? raw.value : (raw as typeof res);
      return {
        valid: Boolean(res?.valid),
        identity: String(res?.identity ?? ""),
        scopes: Array.isArray(res?.scopes) ? (res?.scopes as string[]) : [],
      };
    },
    log: (level, message) => {
      // Fire-and-forget diagnostics; core records them in structured logs.
      send({ id: nextId(), op: "log", payload: { level, message } });
    },
  };

  const rl = createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    let msg: IncomingMessage & { result?: unknown };
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)?.(msg.result);
      pending.delete(msg.id);
      return;
    }
    if (msg.op === undefined) return;
    void (async () => {
      try {
        switch (msg.op) {
          case "handshake":
            send({ id: msg.id, result: { manifest: plugin.manifest, protocolVersion: PROTOCOL_VERSION } });
            break;
          case "mount":
            ctx = baseCtx;
            await plugin.mount(ctx);
            send({ id: msg.id, result: { ok: true } });
            break;
          case "unmount":
            await plugin.unmount(ctx ?? baseCtx);
            send({ id: msg.id, result: { ok: true } });
            break;
          case "ping":
            send({ id: msg.id, result: { pong: msg.payload?.nonce ?? 0 } });
            break;
          case "subscribe-delivery": {
            const envelope = (msg.payload?.envelope ?? {}) as Record<string, unknown>;
            if (!plugin.onEventDelivery) {
              send({ id: msg.id, result: { error: "plugin does not handle event deliveries" } });
            } else {
              await plugin.onEventDelivery(envelope);
              send({ id: msg.id, result: { ok: true } });
            }
            break;
          }
          case "call": {
            const { capability, operation, payload } = msg.payload ?? {};
            const handler = plugin.handlers?.[String(capability)];
            if (!handler) {
              send({ id: msg.id, result: { error: `no handler for ${String(capability)}` } });
            } else {
              try {
                const out = await handler(String(operation), (payload as Record<string, unknown>) ?? {});
                send({ id: msg.id, result: { value: out } });
              } catch (err) {
                // Typed plugin errors keep their stable code across the
                // control channel so core can map them onto HTTP statuses;
                // plain errors pass through as before.
                const e = err as Error & { code?: string };
                const text = e?.code ? `${e.code}: ${e?.message ?? String(err)}` : (e?.message ?? String(err));
                send({ id: msg.id, result: { error: text } });
              }
            }
            break;
          }
          default:
            send({ id: msg.id, result: { error: `unknown op ${msg.op}` } });
        }
      } catch (err) {
        send({ id: msg.id, result: { error: (err as Error).message } });
      }
    })();
  });
}
