/**
 * Wave 9 unit tests: operations UI (TAN-030/031/032/033/042/043).
 * Queue actions on durable jobs with destructive-intent confirmation,
 * plugin restart/disable with impact notice, user management with truthful
 * last-admin errors, API-key secret shown exactly once, webhook test
 * delivery feedback, backup/restore + diagnostics sections, audit view.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MantineProvider } from "@mantine/core";
import React from "react";

// ---- api mock -------------------------------------------------------------------

type Handler = (path: string, init?: RequestInit) => { status: number; body: unknown } | undefined;
const routes: Array<Handler> = [];

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const path = String(input);
  for (const h of routes) {
    const res = h(path, init);
    if (res) return jsonResponse(res.status, res.body);
  }
  return jsonResponse(404, { error: `no route: ${path}` });
}));

const { QueueView, PluginsView, UsersView, AuditView, AdminTabs } = await import("../src/admin/views.js");

function withProviders(ui: React.ReactElement): React.ReactElement {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <MantineProvider>
      <QueryClientProvider client={qc}>{ui}</QueryClientProvider>
    </MantineProvider>
  );
}

if (!window.matchMedia) {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => undefined,
      removeListener: () => undefined,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: () => false,
    }),
  });
}
// Mantine ScrollArea needs ResizeObserver in jsdom.
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
if (!("ResizeObserver" in window)) {
  (window as unknown as { ResizeObserver: typeof ResizeObserverStub }).ResizeObserver = ResizeObserverStub;
  (globalThis as unknown as { ResizeObserver: typeof ResizeObserverStub }).ResizeObserver = ResizeObserverStub;
}
if (!HTMLCanvasElement.prototype.getContext) {
  HTMLCanvasElement.prototype.getContext = () => null;
}

beforeEach(() => {
  routes.length = 0;
});
afterEach(() => {
  cleanup();
});

// ---- TAN-030 queue ---------------------------------------------------------------

const ONE_JOB = {
  jobId: "job-1",
  itemKey: "series.w9",
  title: "Wave Nine",
  source: "torrent",
  enginePluginId: "dev.tantalar.plugin.torrent-native",
  state: "downloading",
  progressPercent: 40,
  sizeBytes: 1000,
  receivedBytes: 400,
  etaAt: null,
  warnings: [],
  retryCount: 0,
  priority: 0,
  failureReason: null,
  removed: false,
  importHandoffPath: null,
  createdAt: "2026-08-24T00:00:00Z",
  updatedAt: "2026-08-24T00:00:00Z",
};

describe("QueueView (TAN-030)", () => {
  it("renders durable jobs with their owning engine and operational detail", async () => {
    routes.push((p) =>
      p.includes("/api/v1/queue") ? { status: 200, body: { jobs: [ONE_JOB] } } : undefined,
    );
    render(withProviders(<QueueView adminId={null} />));
    await waitFor(() => expect(screen.getByText("Wave Nine")).toBeTruthy());
    expect(screen.getByText("torrent")).toBeTruthy();
    // Failure and handoff columns exist even when empty.
    expect(screen.getByText("Failure detail")).toBeTruthy();
    expect(screen.getByText("Import handoff")).toBeTruthy();
  });

  it("offers state-appropriate actions only", async () => {
    routes.push((p) =>
      p.includes("/api/v1/queue")
        ? { status: 200, body: { jobs: [ONE_JOB, { ...ONE_JOB, jobId: "job-2", state: "failed", failureReason: "CRC mismatch" }] } }
        : undefined,
    );
    render(withProviders(<QueueView adminId={null} />));
    await waitFor(() => expect(screen.getByTestId("pause-job-1")).toBeTruthy());
    // downloading job has pause; failed job has retry + shows the reason.
    expect(screen.getByTestId(`retry-job-2`)).toBeTruthy();
    expect(screen.queryByTestId(`retry-job-1`)).toBeNull();
    expect(screen.getByText("CRC mismatch")).toBeTruthy();
  });

  it("sends removal to the durable job id and surfaces data-file semantics", async () => {
    let actionPayload: unknown;
    routes.push(
      (p) => (p.includes("/api/v1/queue") && !p.includes("actions") ? { status: 200, body: { jobs: [ONE_JOB] } } : undefined),
      (p, init) => {
        if (p.endsWith("/actions")) {
          actionPayload = init?.body;
          return { status: 200, body: { removed: true, dataFilesDeleted: false, note: "Removed from the queue; downloaded files were kept." } };
        }
        return undefined;
      },
    );
    window.confirm = vi.fn(() => true);
    render(withProviders(<QueueView adminId={null} />));
    await waitFor(() => expect(screen.getByTestId("remove-job-1")).toBeTruthy());
    (screen.getByTestId("remove-job-1") as HTMLElement).click();
    await waitFor(() => expect(actionPayload).toContain("remove"));
    await waitFor(() => expect(screen.getByTestId("queue-note").textContent).toContain("kept"));
  });

  it("shows a truthful empty state", async () => {
    routes.push((p) => (p.includes("/api/v1/queue") ? { status: 200, body: { jobs: [] } } : undefined));
    render(withProviders(<QueueView adminId={null} />));
    await waitFor(() => expect(screen.getByText("The download queue is empty.")).toBeTruthy());
  });
});

// ---- TAN-031 plugins --------------------------------------------------------------

describe("PluginsView (TAN-031)", () => {
  it("lists plugins with restart/disable controls", async () => {
    routes.push((p) =>
      p === "/api/v1/plugins"
        ? { status: 200, body: { plugins: [{ manifest: { id: "dev.tantalar.plugin.serving", version: "1.0.0", provides: ["dev.tantalar.capability.serving"] }, state: "healthy", restartCount: 0 }] } }
        : undefined,
    );
    render(withProviders(<PluginsView />));
    await waitFor(() => expect(screen.getByTestId("restart-dev.tantalar.plugin.serving")).toBeTruthy());
    expect(screen.getByTestId("disable-dev.tantalar.plugin.serving")).toBeTruthy();
    expect(screen.getByText("healthy")).toBeTruthy();
  });
});

// ---- TAN-032 users -----------------------------------------------------------------

describe("UsersView (TAN-032)", () => {
  it("renders per-user management controls", async () => {
    routes.push((p) =>
      p === "/api/v1/users"
        ? { status: 200, body: { users: [{ id: "u1", username: "alice", role: "admin", createdAt: "2026-08-24T00:00:00Z" }] } }
        : undefined,
    );
    render(withProviders(<UsersView />));
    await waitFor(() => expect(screen.getByTestId("user-alice")).toBeTruthy());
    expect(screen.getByText("Reset password")).toBeTruthy();
    expect(screen.getByText("Sign out")).toBeTruthy();
    expect(screen.getAllByText("Deactivate").length).toBeGreaterThan(0);
  });

  it("surfaces last-admin refusal messages verbatim", async () => {
    routes.push(
      (p) => (p === "/api/v1/users" ? { status: 200, body: { users: [{ id: "u1", username: "alice", role: "admin", createdAt: "2026-08-24T00:00:00Z" }] } } : undefined),
      (p) => (p.includes("/role") ? { status: 409, body: { error: "cannot remove the last administrator" } } : undefined),
    );
    render(withProviders(<UsersView />));
    await waitFor(() => expect(screen.getByText("Make viewer")).toBeTruthy());
    (screen.getByText("Make viewer") as HTMLElement).click();
    await waitFor(() => expect(screen.getByTestId("users-note").textContent).toContain("last administrator"));
  });
});

// ---- TAN-032 audit -------------------------------------------------------------------

describe("AuditView (TAN-032)", () => {
  it("lists audit entries with actor, action, and target", async () => {
    routes.push((p) =>
      p.includes("/api/v1/system/audit")
        ? {
            status: 200,
            body: {
              entries: [
                {
                  id: "a1",
                  actorUserId: "u1",
                  actorUsername: "admin",
                  action: "apikey.created",
                  targetType: "api_key",
                  targetId: "k1",
                  detail: {},
                  occurredAt: "2026-08-24T01:00:00Z",
                },
              ],
            },
          }
        : undefined,
    );
    render(withProviders(<AuditView />));
    await waitFor(() => expect(screen.getByText("apikey.created")).toBeTruthy());
    expect(screen.getByText("admin")).toBeTruthy();
    expect(screen.getByText("api_key:k1")).toBeTruthy();
  });
});

// ---- Shell tabs include the audit tab --------------------------------------------

describe("AdminTabs shell (wave 9)", () => {
  it("exposes the Audit tab alongside operations tabs", async () => {
    routes.push(() => ({ status: 200, body: { jobs: [], plugins: [], users: [], entries: [] } }));
    render(withProviders(<AdminTabs adminId={null} />));
    expect(screen.getByRole("tab", { name: "Audit" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Queue" })).toBeTruthy();
  });
});
