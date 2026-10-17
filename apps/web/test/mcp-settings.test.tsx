import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { NotificationProvider } from "../src/notifications";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import { ControlPage, isControlArea, isControlChild } from "../src/shell/ControlSurface";

const STATUS = {
  mounted: true,
  state: "healthy",
  healthy: true,
  version: "1.0.0",
  capabilities: ["dev.tantalar.capability.mcp.status"],
  auditedCalls: 12,
  defaultPolicy: "loopback bind, read-only tools, per-call immutable audit",
  activeTransport: "Streamable HTTP",
  endpoint: "http://127.0.0.1:8642/",
  mutatingToolsEnabled: false,
  limits: { timeoutMs: 30_000, maxResultBytes: 1_048_576, rateLimitPerMinute: 120 },
  tools: [{
    name: "dev.tantalar.tool.health",
    purpose: "Read module health.",
    mutates: false,
    enabled: true,
    requiredScopes: [],
  }],
  configuration: {
    http: { enabled: true, bind: "127.0.0.1", port: 8642, tlsViaProxy: false },
    mutatingToolsEnabled: false,
    limits: { timeoutMs: 30_000, maxResultBytes: 1_048_576, rateLimitPerMinute: 120 },
  },
  configError: null,
  recovery: null,
};

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function renderControl(onNavigate = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <MantineProvider><NotificationProvider userId={null} isAdmin={false} navigate={() => {}}>
      <QueryClientProvider client={client}>
        <ControlPage area="integrations" child="mcp" adminId="admin-1" onNavigate={onNavigate} />
      </QueryClientProvider>
    </NotificationProvider></MantineProvider>,
  );
  return onNavigate;
}

beforeAll(() => {
  window.matchMedia = window.matchMedia ?? ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
  });
});

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => cleanup());

describe("Control MCP setup", () => {
  it("uses the URL-backed MCP child and completes the safe HTTP setup flow", async () => {
    let savedConfiguration: Record<string, unknown> | null = null;
    let rejectConfiguration = false;
    let createdKey: { name: string; scopes: string[]; expiresAt: string | null } | null = null;
    let testedKey: string | null = null;
    const keys: unknown[] = [];

    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/v1/mcp/status") return response(STATUS);
      if (path === "/api/v1/api-keys" && (!init?.method || init.method === "GET")) return response({ keys });
      if (path === "/api/v1/api-keys" && init?.method === "POST") {
        createdKey = JSON.parse(String(init.body));
        const key = {
          id: "key-1",
          name: createdKey!.name,
          scopes: createdKey!.scopes,
          createdAt: "2026-08-30T00:00:00.000Z",
          revokedAt: null,
          expiresAt: createdKey!.expiresAt,
        };
        keys.push(key);
        return response({ key, secret: "tantalar_once_only" });
      }
      if (path === "/api/v1/mcp/config" && init?.method === "PUT") {
        if (rejectConfiguration) {
          return response({
            error: "MCP could not start with the new configuration.",
            code: "port_conflict",
            rolledBack: true,
          }, 409);
        }
        savedConfiguration = JSON.parse(String(init.body));
        return response({ saved: true, status: { ...STATUS, configuration: savedConfiguration } });
      }
      if (path === "/api/v1/mcp/test" && init?.method === "POST") {
        testedKey = (JSON.parse(String(init.body)) as { apiKey: string }).apiKey;
        return response({
          ok: true,
          code: null,
          checks: [
            { name: "initialize", ok: true },
            { name: "ping", ok: true },
            { name: "tools/list", ok: true },
          ],
          tools: [],
        });
      }
      return response({ error: `No test route for ${path}` }, 404);
    }));

    expect(isControlArea("integrations")).toBe(true);
    expect(isControlChild("integrations", "mcp")).toBe(true);
    const onNavigate = renderControl();

    expect(await screen.findByRole("heading", { name: "MCP setup" })).toBeTruthy();
    expect(screen.getByText("dev.tantalar.tool.health")).toBeTruthy();
    expect(screen.getByText("http://127.0.0.1:8642/")).toBeTruthy();
    expect(screen.queryByText(/stdio/i)).toBeNull();
    expect(screen.getByText("Server settings").closest("details")?.open).toBe(false);
    expect(screen.getByText(/Loopback addresses work only/)).toBeTruthy();

    fireEvent.click(screen.getByText("Server settings"));
    fireEvent.click(screen.getByText("Advanced settings"));

    fireEvent.change(screen.getByLabelText("Bind address"), { target: { value: "127.0.0.1" } });
    fireEvent.change(screen.getByLabelText("Port"), { target: { value: "8650" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply configuration" }));
    await waitFor(() => expect(savedConfiguration).not.toBeNull());
    expect((savedConfiguration as { http: { port: number } }).http.port).toBe(8650);
    expect(JSON.stringify(savedConfiguration)).not.toContain("stdio");

    fireEvent.click(screen.getByRole("button", { name: "Create read-only key" }));
    await waitFor(() => expect(createdKey).not.toBeNull());
    expect(await screen.findByTestId("apikey-secret-once")).toBeTruthy();
    expect(createdKey?.scopes).toEqual(["events.read", "operations.read", "config.read"]);
    await waitFor(() => expect(testedKey).toBe("tantalar_once_only"));

    const clientConfig = screen.getByRole("textbox", { name: "Generic MCP client configuration" }) as HTMLTextAreaElement;
    expect(clientConfig.value).toContain("<TANTALAR_API_KEY>");
    expect(clientConfig.value).not.toContain("tantalar_once_only");

    fireEvent.click(screen.getByRole("button", { name: "Copy configuration with key" }));
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith(expect.stringContaining("tantalar_once_only")));

    fireEvent.click(screen.getByRole("button", { name: "Run protocol test" }));
    expect(await screen.findByText("Protocol test passed")).toBeTruthy();
    expect(testedKey).toBe("tantalar_once_only");
    expect(screen.getByText("tools/list: Passed")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Clear key" }));
    expect((screen.getByRole("button", { name: "Copy configuration with key" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByTestId("apikey-secret-once")).toBeNull();
    expect(screen.queryByText("Protocol test passed")).toBeNull();

    rejectConfiguration = true;
    fireEvent.change(screen.getByLabelText("Port"), { target: { value: "8651" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply configuration" }));
    const recovery = await screen.findByText(/The last working configuration is active/);
    expect(recovery.textContent).toContain("The last working configuration is active.");
    expect(recovery.textContent).toContain("Choose an unused port");

    fireEvent.click(screen.getByRole("button", { name: "Open MCP Audit" }));
    expect(onNavigate).toHaveBeenCalledWith("audit", "mcp");
  });

  it("keeps a new key available when automatic verification fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/v1/mcp/status") return response(STATUS);
      if (path === "/api/v1/api-keys" && init?.method === "POST") return response({ key: {}, secret: "tantalar_recoverable" });
      if (path === "/api/v1/api-keys") return response({ keys: [] });
      if (path === "/api/v1/mcp/test") return response({ ok: false, code: "transport", checks: [], tools: [] });
      return response({}, 404);
    }));
    renderControl();
    fireEvent.click(await screen.findByRole("button", { name: "Create read-only key" }));
    expect(await screen.findByText("Protocol test failed")).toBeTruthy();
    expect(screen.getByText(/Check the endpoint and reverse proxy/)).toBeTruthy();
    expect(screen.getByTestId("apikey-secret-once")).toBeTruthy();
    expect((screen.getByLabelText("Client API key") as HTMLInputElement).value).toBe("tantalar_recoverable");
  });

  it("does not offer a working connection when the endpoint is unavailable", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => response(String(input) === "/api/v1/mcp/status"
      ? { ...STATUS, healthy: false, endpoint: null }
      : { keys: [] })));
    renderControl();
    const create = await screen.findByRole("button", { name: "Create read-only key" });
    expect((create as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Copy client configuration" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByLabelText("Generic MCP client configuration") as HTMLTextAreaElement).value).toContain("<MCP_ENDPOINT>");
    expect(screen.getByText(/Open Server settings to enable MCP/)).toBeTruthy();
  });
});
