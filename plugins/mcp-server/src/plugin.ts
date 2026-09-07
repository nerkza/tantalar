/**
 * Dedicated MCP server plugin (ADR-0018, docs/mcp-server.md).
 * Phase 2 generic surface: health, capability discovery, activity query,
 * operation-status query, redacted effective-config inspection.
 *
 * Boundary: out-of-process plugin; speaks the public plugin contract only
 * (auth introspection + capability invocation). Transports: MCP Streamable
 * HTTP on loopback (default on). Mutating tools are globally disabled by
 * default and require explicit config plus operation-specific scopes. Every
 * call emits one immutable audit event (dev.tantalar.event.mcp.call).
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { runPlugin, definePlugin, type PluginContext, type PluginDefinition } from "@tantalar/plugin-sdk";
import { PROTOCOL_VERSION, validateManifest, EventTypes, isReverseDns } from "@tantalar/contracts";

interface McpConfig {
  http?: { enabled?: boolean; bind?: string; port?: number; tlsViaProxy?: boolean; clientEndpoint?: string };
  mutatingToolsEnabled?: boolean;
  limits?: { timeoutMs?: number; maxResultBytes?: number; rateLimitPerMinute?: number };
}

const MCP_AUDIT_TYPE = EventTypes.McpCall;
const MAX_REQUEST_BYTES = 1_048_576;

function isLoopbackBind(bind: string): boolean {
  return bind === "127.0.0.1" || bind === "localhost" || bind === "::1";
}

function normalizeMcpConfig(value: unknown): McpConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("MCP configuration must be an object");
  }
  const input = value as McpConfig;
  const http = input.http ?? {};
  const limits = input.limits ?? {};
  const bind = String(http.bind ?? "127.0.0.1").trim();
  const port = Number(http.port ?? 8642);
  const timeoutMs = Number(limits.timeoutMs ?? 30_000);
  const maxResultBytes = Number(limits.maxResultBytes ?? 1_048_576);
  const rateLimitPerMinute = Number(limits.rateLimitPerMinute ?? 120);
  if (!bind || !/^[A-Za-z0-9.:-]+$/.test(bind)) throw new Error("MCP bind address is invalid");
  if (!Number.isInteger(port) || port < 1024 || port > 65_535) throw new Error("MCP port must be between 1024 and 65535");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 120_000) throw new Error("MCP timeout is outside the server bounds");
  if (!Number.isInteger(maxResultBytes) || maxResultBytes < 4_096 || maxResultBytes > 8_388_608) throw new Error("MCP result limit is outside the server bounds");
  if (!Number.isInteger(rateLimitPerMinute) || rateLimitPerMinute < 1 || rateLimitPerMinute > 10_000) throw new Error("MCP rate limit is outside the server bounds");

  const loopback = isLoopbackBind(bind);
  const clientEndpoint = String(http.clientEndpoint ?? "").trim();
  if (!loopback && http.tlsViaProxy !== true) {
    throw new Error("non-loopback bind requires a trusted TLS reverse proxy");
  }
  if (!loopback && !clientEndpoint) throw new Error("non-loopback bind requires an HTTPS client endpoint");
  if (clientEndpoint) {
    let endpoint: URL;
    try {
      endpoint = new URL(clientEndpoint);
    } catch {
      throw new Error("MCP client endpoint must be an absolute URL");
    }
    if (endpoint.username || endpoint.password || endpoint.hash) {
      throw new Error("MCP client endpoint must not contain credentials or a fragment");
    }
    if (!loopback && endpoint.protocol !== "https:") throw new Error("non-loopback MCP client endpoint must use HTTPS");
    if (loopback && endpoint.protocol !== "http:" && endpoint.protocol !== "https:") {
      throw new Error("MCP client endpoint must use HTTP or HTTPS");
    }
  }
  return {
    http: {
      enabled: http.enabled !== false,
      bind,
      port,
      tlsViaProxy: http.tlsViaProxy === true,
      ...(clientEndpoint ? { clientEndpoint } : {}),
    },
    mutatingToolsEnabled: input.mutatingToolsEnabled === true,
    limits: { timeoutMs, maxResultBytes, rateLimitPerMinute },
  };
}

// ---- Tool registry ----------------------------------------------------------

type ToolHandler = (
  args: Record<string, unknown>,
  ctx: ToolCtx,
) => Promise<{ content: Array<Record<string, unknown>>; isError?: boolean }> | { content: Array<Record<string, unknown>>; isError?: boolean };

interface ToolCtx {
  plugin: PluginContext;
  scopes: string[];
  identity: string;
}

interface ToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  requiredScope?: string;
  mutates: boolean;
  handler: ToolHandler;
}

const NO_ARGUMENTS_SCHEMA = { type: "object", properties: {}, additionalProperties: false } as const;

const TOOLS: ToolSpec[] = [
  {
    name: "dev.tantalar.mcp.health",
    description: "Server health snapshot.",
    inputSchema: NO_ARGUMENTS_SCHEMA,
    mutates: false,
    handler: async (_args, ctx) => {
      const result = await ctx.plugin.invoke(
        "dev.tantalar.capability.mcp.operation.read",
        "health",
        {},
      );
      return {
        content: [
          { type: "text", text: JSON.stringify({ ok: true, server: "dev.tantalar.plugin.mcp", protocolVersion: PROTOCOL_VERSION, core: result }) },
        ],
      };
    },
  },
  {
    name: "dev.tantalar.mcp.capability.discovery",
    description: "List capabilities this server may access through its grants.",
    inputSchema: NO_ARGUMENTS_SCHEMA,
    mutates: false,
    handler: async (_args, ctx) => ({
      content: [{ type: "text", text: JSON.stringify({ capabilities: [...MCP_ACCESSIBLE_CAPABILITIES] }) }],
    }),
  },
  {
    name: "dev.tantalar.mcp.activity.query",
    description: "Query the append-only activity log.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "integer", minimum: 1, maximum: 200 },
        cursor: { type: "string" },
      },
      additionalProperties: false,
    },
    requiredScope: "events.read",
    mutates: false,
    handler: activityQuery,
  },
  {
    name: "dev.tantalar.mcp.operation.status",
    description: "Read current operation and plugin status.",
    inputSchema: NO_ARGUMENTS_SCHEMA,
    requiredScope: "operations.read",
    mutates: false,
    handler: operationStatusQuery,
  },
  {
    name: "dev.tantalar.mcp.config.inspect",
    description: "Inspect the redacted effective configuration.",
    inputSchema: NO_ARGUMENTS_SCHEMA,
    requiredScope: "config.read",
    mutates: false,
    handler: configInspect,
  },
];

/** Capabilities declared in the manifest — the only ones invocable. */
const MCP_ACCESSIBLE_CAPABILITIES = [
  "dev.tantalar.capability.mcp.activity.read",
  "dev.tantalar.capability.mcp.operation.read",
  "dev.tantalar.capability.mcp.config.read",
] as const;

async function activityQuery(args: Record<string, unknown>, ctx: ToolCtx): Promise<{ content: Array<Record<string, unknown>>; isError?: boolean }> {
  // Activity reads flow through the event-log read scope gate enforced by core
  // HTTP surface; the MCP tool proxies with pagination + size limits.
  const limitRaw = Number(args.limit ?? 50);
  const limit = Math.min(Math.max(1, Number.isFinite(limitRaw) ? limitRaw : 50), 200);
  const cursor = typeof args.cursor === "string" ? args.cursor : undefined;
  const payload: Record<string, unknown> = { limit };
  if (cursor) payload["afterEventId"] = cursor;
  const result = (await invokeCore("dev.tantalar.capability.mcp.activity.read", "query", payload)) as
    | { events?: Array<Record<string, unknown>> }
    | undefined;
  const events = result?.events ?? [];
  const nextCursor =
    events.length === limit ? String(events[events.length - 1]?.["eventId"] ?? "") : null;
  return {
    content: [
      { type: "text", text: JSON.stringify({ events, nextCursor }) },
    ],
  };
}

async function operationStatusQuery(_args: Record<string, unknown>, _ctx: ToolCtx): Promise<{ content: Array<Record<string, unknown>> }> {
  const result = (await invokeCore("dev.tantalar.capability.mcp.operation.read", "status", {})) as unknown;
  return { content: [{ type: "text", text: JSON.stringify(result ?? { operations: [] }) }] };
}

async function configInspect(_args: Record<string, unknown>, _ctx: ToolCtx): Promise<{ content: Array<Record<string, unknown>> }> {
  const result = (await invokeCore("dev.tantalar.capability.mcp.config.read", "inspect", {})) as unknown;
  return { content: [{ type: "text", text: JSON.stringify(result ?? {}) }] };
}

/* Core invocation bridge: set at mount by the runtime wrapper. The plugin
 * process reaches core capabilities strictly via the control channel using
 * names declared in `requires`. */
let coreInvoke:
  ((capability: string, operation: string, payload: Record<string, unknown>) => Promise<unknown>) | null = null;
let coreStorage: PluginContext["storage"] | null = null;

function invokeCore(capability: string, operation: string, payload: Record<string, unknown>): Promise<unknown> {
  if (!coreInvoke) throw new Error("mcp server not mounted");
  return coreInvoke(capability, operation, payload);
}

const manifest = validateManifest({
  id: "dev.tantalar.plugin.mcp",
  version: "0.1.0",
  protocolVersion: PROTOCOL_VERSION,
  provides: ["dev.tantalar.capability.mcp.status"],
  requires: [
    "dev.tantalar.capability.auth.introspection",
    "dev.tantalar.capability.event.emit",
    "dev.tantalar.capability.mcp.activity.read",
    "dev.tantalar.capability.mcp.operation.read",
    "dev.tantalar.capability.mcp.config.read",
  ],
  subscriptions: [],
  entry: { command: "mcp-plugin" },
});

// ---- Audit ------------------------------------------------------------------

interface AuditFields {
  clientIdentity: string;
  toolOrResourceName: string;
  redactedArguments: Record<string, unknown>;
  outcome: string;
  correlationId: string;
  causationId?: string;
}

const SECRET_ARG_RE = /secret|password|token|apikey|api_key|authorization/i;

export function redactArguments(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (SECRET_ARG_RE.test(k)) out[k] = "[REDACTED]";
    else if (v !== null && typeof v === "object") out[k] = redactArguments(v as Record<string, unknown>);
    else out[k] = v;
  }
  return out;
}

// ---- Rate limiting per client key -------------------------------------------

class RateLimiter {
  readonly #hits = new Map<string, number[]>();
  constructor(readonly perMinute: number) {}
  allow(key: string): boolean {
    const now = Date.now();
    const arr = (this.#hits.get(key) ?? []).filter((t) => now - t < 60_000);
    if (arr.length >= this.perMinute) {
      this.#hits.set(key, arr);
      return false;
    }
    arr.push(now);
    this.#hits.set(key, arr);
    return true;
  }
}

// ---- JSON-RPC / MCP Streamable HTTP -----------------------------------------

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: { name?: string; arguments?: Record<string, unknown> };
}

const ERROR_CODES = { parse: -32700, invalidRequest: -32600, methodNotFound: -32601, invalidParams: -32602, internal: -32603 } as const;

export function createMcpHttpHandler(deps: {
  config: McpConfig;
  audit: (fields: AuditFields) => Promise<void>;
  introspect: (key: string) => Promise<{ valid: boolean; identity: string; scopes: string[] }>;
}): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const limiter = new RateLimiter(Number(deps.config.limits?.rateLimitPerMinute ?? 120));
  const timeoutMs = Number(deps.config.limits?.timeoutMs ?? 30_000);
  const maxResultBytes = Number(deps.config.limits?.maxResultBytes ?? 1_048_576);
  const mutationsEnabled = deps.config.mutatingToolsEnabled === true;

  return async (req, res) => {
    const started = async (identity: string, name: string, outcome: string, args: Record<string, unknown>, causationId?: string) => {
      await deps.audit({
        clientIdentity: identity,
        toolOrResourceName: name,
        redactedArguments: redactArguments(args),
        outcome,
        correlationId: randomUUID(),
        ...(causationId ? { causationId } : {}),
      });
    };

    if (req.method !== "POST") {
      res.writeHead(405, { "content-type": "application/json", allow: "POST" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: ERROR_CODES.invalidRequest, message: "method not allowed" } }));
      return;
    }

    const chunks: Buffer[] = [];
    let requestBytes = 0;
    for await (const chunk of req) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      requestBytes += bytes.length;
      if (requestBytes > MAX_REQUEST_BYTES) {
        res.writeHead(413, { "content-type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: ERROR_CODES.invalidRequest, message: "request too large" } }));
        return;
      }
      chunks.push(bytes);
    }
    const body = Buffer.concat(chunks).toString("utf8");

    let rpc: JsonRpcRequest;
    try {
      rpc = JSON.parse(body) as JsonRpcRequest;
    } catch {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: ERROR_CODES.parse, message: "parse error" } }));
      return;
    }

    const respond = (payload: unknown): void => {
      let text = JSON.stringify(payload);
      if (Buffer.byteLength(text) > maxResultBytes) {
        text = JSON.stringify({ jsonrpc: "2.0", id: rpc.id ?? null, error: { code: ERROR_CODES.internal, message: "result too large" } });
      }
      res.writeHead(200, {
        "content-type": "application/json",
        "mcp-session-id": `s-${randomUUID()}`,
      });
      res.end(text);
    };

    const method = String(rpc.method ?? "");
    const toolName = String(rpc.params?.name ?? "");
    const toolArgs = rpc.params?.arguments ?? {};

    // Authentication: scoped Tantalar API keys via auth introspection only.
    const presented = String(req.headers["x-tantalar-key"] ?? "");
    const authz = presented ? await deps.introspect(presented) : { valid: false, identity: "", scopes: [] };
    if (!authz.valid) {
      await started("anonymous", toolName || method, "unauthorized", toolArgs);
      respond({ jsonrpc: "2.0", id: rpc.id ?? null, error: { code: -32001, message: "unauthorized" } });
      return;
    }
    if (!limiter.allow(authz.identity)) {
      await started(authz.identity, toolName || method, "rate-limited", toolArgs);
      respond({ jsonrpc: "2.0", id: rpc.id ?? null, error: { code: -32002, message: "rate limit exceeded" } });
      return;
    }

    try {
      switch (method) {
        case "initialize":
          await started(authz.identity, "initialize", "ok", {});
          respond({
            jsonrpc: "2.0",
            id: rpc.id,
            result: {
              protocolVersion: "2024-11-05",
              capabilities: { tools: {} },
              serverInfo: { name: "dev.tantalar.plugin.mcp", version: manifest.version },
            },
          });
          return;
        case "tools/list":
          await started(authz.identity, "tools/list", "ok", {});
          respond({
            jsonrpc: "2.0",
            id: rpc.id,
            result: {
              tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
            },
          });
          return;
        case "ping":
          await started(authz.identity, "ping", "ok", {});
          respond({ jsonrpc: "2.0", id: rpc.id, result: {} });
          return;
        case "tools/call":
          break; // handled below
        default:
          await started(authz.identity, method || "unknown-method", "unknown-method", toolArgs);
          respond({ jsonrpc: "2.0", id: rpc.id ?? null, error: { code: ERROR_CODES.methodNotFound, message: "method not found" } });
          return;
      }

      const spec = TOOLS.find((t) => t.name === toolName);
      if (!spec) {
        await started(authz.identity, toolName, "unknown-tool", toolArgs);
        respond({ jsonrpc: "2.0", id: rpc.id ?? null, error: { code: ERROR_CODES.invalidParams, message: "unknown tool" } });
        return;
      }
      if (spec.mutates && !mutationsEnabled) {
        // Mutation gate (ADR-0018 §5): off by default, opt-in + scoped.
        await started(authz.identity, toolName, "mutation-disabled", toolArgs);
        respond({
          jsonrpc: "2.0",
          id: rpc.id ?? null,
          error: { code: -32003, message: "mutating tools are disabled" },
        });
        return;
      }
      if (spec.requiredScope && !authz.scopes.includes(spec.requiredScope)) {
        await started(authz.identity, toolName, "forbidden", toolArgs);
        respond({ jsonrpc: "2.0", id: rpc.id ?? null, error: { code: -32001, message: "insufficient scope" } });
        return;
      }
      if (!isReverseDns(toolName.replace(/\.mcp\./, ".capability."))) {
        // naming sanity only; never leaks internals
        void toolName;
      }
      const result = await Promise.race([
        spec.handler(toolArgs, { plugin: makeToolPlugin(), scopes: authz.scopes, identity: authz.identity }),
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error("timeout")), timeoutMs)),
      ]);
      await started(authz.identity, toolName, "ok", toolArgs);
      respond({ jsonrpc: "2.0", id: rpc.id, result });
    } catch (err) {
      const msg = (err as Error).message === "timeout" ? "timeout" : "tool-error";
      await started(authz.identity, toolName, msg, toolArgs);
      // Stable error mapping: internal details are never leaked (§7).
      respond({ jsonrpc: "2.0", id: rpc.id ?? null, error: { code: ERROR_CODES.internal, message: msg } });
    }
  };
}

function makeToolPlugin(): PluginContext {
  if (!coreInvoke || !coreStorage) throw new Error("mcp server not mounted");
  return {
    pluginId: manifest.id,
    config: {},
    emit: async () => undefined,
    invoke: (cap, op, payload) => coreInvoke!(cap, op, payload),
    introspectApiKey: async () => ({ valid: true, identity: "", scopes: [] }),
    log: () => undefined,
    storage: coreStorage,
  };
}

const plugin: PluginDefinition = definePlugin({
  manifest,
  async mount(ctx: PluginContext) {
    coreInvoke = (cap, op, payload) => ctx.invoke(cap, op, payload);
    coreStorage = ctx.storage;
    const cfg = normalizeMcpConfig(ctx.config ?? {});
    const httpCfg = cfg.http ?? {};
    const bind = String(httpCfg.bind ?? "127.0.0.1");
    const port = Number(httpCfg.port ?? 8642);
    if (httpCfg.enabled === false) {
      activeConfig = cfg;
      return;
    }
    const handler = createMcpHttpHandler({
      config: cfg,
      audit: async (fields) => {
        const { correlationId, causationId, ...payload } = fields as unknown as Record<string, unknown>;
        await ctx.emit(MCP_AUDIT_TYPE, payload as Record<string, unknown>, {
          ...(typeof correlationId === "string" ? { correlationId } : {}),
          ...(typeof causationId === "string" ? { causationId } : {}),
        });
      },
      introspect: (key) => ctx.introspectApiKey(key),
    });
    const server = createServer((req, res) => {
      void handler(req, res);
    });
    await new Promise<void>((resolve, reject) => {
      const failed = (error: Error) => reject(error);
      server.once("error", failed);
      server.listen(port, bind, () => {
        server.off("error", failed);
        resolve();
      });
    });
    httpServer = server;
    activeConfig = cfg;
    ctx.log("info", `mcp http listening on ${bind}:${port}`);
    process.once("exit", () => server.close());
  },
  unmount(ctx: PluginContext) {
    httpServer?.close();
    httpServer = null;
    activeConfig = null;
    coreInvoke = null;
    coreStorage = null;
    ctx.log("info", "mcp server unmounted");
  },
  handlers: {
    "dev.tantalar.capability.mcp.status": async () => {
      const cfg = activeConfig ?? normalizeMcpConfig(JSON.parse(process.env["TANTALAR_PLUGIN_CONFIG"] ?? "{}"));
      const http = cfg.http ?? {};
      const bind = String(http.bind ?? "127.0.0.1");
      const port = Number(http.port ?? 8642);
      const httpEnabled = http.enabled !== false;
      const transportActive = httpEnabled && httpServer?.listening === true;
      return {
        server: manifest.id,
        httpEnabled,
        activeTransport: transportActive ? "Streamable HTTP" : "Disabled",
        endpoint: transportActive ? (http.clientEndpoint || `http://${bind === "::1" ? "[::1]" : bind}:${port}/`) : null,
        mutatingToolsEnabled: cfg.mutatingToolsEnabled === true,
        limits: {
          timeoutMs: Number(cfg.limits?.timeoutMs ?? 30_000),
          maxResultBytes: Number(cfg.limits?.maxResultBytes ?? 1_048_576),
          rateLimitPerMinute: Number(cfg.limits?.rateLimitPerMinute ?? 120),
        },
        tools: TOOLS.map((tool) => ({
          name: tool.name,
          purpose: tool.description,
          mutates: tool.mutates,
          enabled: !tool.mutates || cfg.mutatingToolsEnabled === true,
          requiredScopes: tool.requiredScope ? [tool.requiredScope] : [],
        })),
      };
    },
  },
});

let httpServer: Server | null = null;
let activeConfig: McpConfig | null = null;

export { plugin, manifest as mcpManifest };

runPlugin(plugin);
