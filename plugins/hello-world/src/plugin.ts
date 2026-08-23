/**
 * Hello-world plugin (Phase 1 exit fixture).
 * Out-of-process: speaks the gRPC contract over a Unix socket or loopback TCP.
 * Provides dev.tantalar.capability.hello.greet; subscribes to nothing.
 */
import { createInterface } from "node:readline";
import { definePlugin, type PluginContext, type PluginDefinition } from "@tantalar/plugin-sdk";
import { PROTOCOL_VERSION, validateManifest } from "@tantalar/contracts";

const manifest = {
  id: "dev.tantalar.plugin.hello-world",
  version: "0.1.0",
  protocolVersion: PROTOCOL_VERSION,
  provides: ["dev.tantalar.capability.hello.greet"],
  requires: ["dev.tantalar.capability.event.emit"],
  subscriptions: [],
  entry: { command: "hello-world-plugin" },
};

const plugin: PluginDefinition = definePlugin({
  manifest: validateManifest(manifest),
  mount(ctx: PluginContext) {
    ctx.log("info", "hello-world mounted");
    return ctx
      .emit("dev.tantalar.event.hello.mounted", { plugin: ctx.pluginId })
      .then(() => undefined);
  },
  unmount(ctx: PluginContext) {
    ctx.log("info", "hello-world unmounted");
  },
  handlers: {
    "dev.tantalar.capability.hello.greet": async (_op: string, payload: Record<string, unknown>) => {
      const name = (payload.name as string) ?? "world";
      return { greeting: `hello, ${name}` };
    },
  },
});

// ---- transport: newline-delimited JSON-RPC-ish over stdin/stdout ----------
// The supervisor spawns this process with a control pipe; Phase 1 uses stdio
// framing for the handshake and gRPC-equivalent messages. Kept deliberately
// simple: each line is a JSON message, responses carry the request id.

interface IncomingMessage {
  id: string;
  op: string;
  payload?: Record<string, unknown>;
}

async function main(): Promise<void> {
  const config = JSON.parse(process.env.TANTALAR_PLUGIN_CONFIG ?? "{}") as Record<string, unknown>;
  let ctx: PluginContext | null = null;

  const baseCtx = {
    pluginId: plugin.manifest.id,
    config,
    emit: async (
      type: string,
      payload: Record<string, unknown>,
      opts?: { subject?: string; correlationId?: string; causationId?: string },
    ) => {
      send({ id: nextId(), op: "emit", payload: { type, payload, ...opts } });
    },
    invoke: async (capability: string, operation: string, payload: Record<string, unknown>) => {
      // Phase 1: capability invocation from plugin side goes over the same pipe.
      const id = nextId();
      send({ id, op: "invoke", payload: { capability, operation, payload } });
      return await waitForResponse(id);
    },
    introspectApiKey: async (key: string) => {
      const id = nextId();
      send({ id, op: "introspect", payload: { api_key: key } });
      const raw = (await waitForResponse(id)) as
        | { value?: { valid?: boolean; identity?: string; scopes?: string[] } }
        | undefined;
      const res: { valid?: boolean; identity?: string; scopes?: string[] } | undefined =
        raw && typeof raw === "object" && "value" in raw ? raw.value : (raw as typeof res);
      return {
        valid: Boolean(res?.valid),
        identity: String(res?.identity ?? ""),
        scopes: Array.isArray(res?.scopes) ? res.scopes : [],
      };
    },
    log: (level: "debug" | "info" | "warn" | "error", message: string) => {
      send({ id: nextId(), op: "log", payload: { level, message } });
    },
  };

  const pending = new Map<string, (v: unknown) => void>();
  let seq = 0;
  const nextId = () => `p${++seq}`;
  function send(msg: Record<string, unknown>): void {
    process.stdout.write(JSON.stringify(msg) + "\n");
  }
  function waitForResponse(id: string): Promise<unknown> {
    return new Promise((resolve) => pending.set(id, resolve));
  }

  const rl = createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    let msg: IncomingMessage & { result?: unknown };
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (pending.has(msg.id)) {
      pending.get(msg.id)!(msg.result);
      pending.delete(msg.id);
      return;
    }
    void (async () => {
      try {
        if (msg.op === "handshake") {
          send({ id: msg.id, result: { manifest: plugin.manifest, protocolVersion: PROTOCOL_VERSION } });
        } else if (msg.op === "mount") {
          ctx = baseCtx;
          await plugin.mount(ctx);
          send({ id: msg.id, result: { ok: true } });
        } else if (msg.op === "unmount") {
          await plugin.unmount(ctx ?? baseCtx);
          send({ id: msg.id, result: { ok: true } });
        } else if (msg.op === "ping") {
          send({ id: msg.id, result: { pong: msg.payload?.nonce ?? 0 } });
        } else if (msg.op === "call") {
          const { capability, operation, payload } = msg.payload ?? {};
          const handler = plugin.handlers?.[capability as string];
          if (!handler) {
            send({ id: msg.id, result: { error: `no handler for ${String(capability)}` } });
          } else {
            const out = await handler(operation as string, (payload as Record<string, unknown>) ?? {});
            send({ id: msg.id, result: { value: out } });
          }
        }
      } catch (err) {
        send({ id: msg.id, result: { error: (err as Error).message } });
      }
    })();
  });
}

if (process.argv[1]?.endsWith("plugin.js")) {
  void main();
}
