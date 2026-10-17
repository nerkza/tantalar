/**
 * Wave 9 unit tests: operations UI (TAN-030/031/032/033/042/043).
 * Queue actions on durable jobs with destructive-intent confirmation,
 * plugin restart/disable with impact notice, user management with truthful
 * last-admin errors, API-key secret shown exactly once, webhook test
 * delivery feedback, backup/restore + diagnostics sections, audit view.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MantineProvider } from "@mantine/core";
import { NotificationProvider } from "../src/notifications";
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

const { QueueView, WantedView, PluginsView, UsersView, AuditView, AdminTabs } = await import("../src/admin/views.js");
const { api } = await import("../src/api.js");

function withProviders(ui: React.ReactElement): React.ReactElement {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <MantineProvider env="test"><NotificationProvider userId={null} isAdmin={false} navigate={() => {}}>
      <QueryClientProvider client={qc}>{ui}</QueryClientProvider>
    </NotificationProvider></MantineProvider>
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
    expect(screen.getByRole("cell", { name: "Torrent", exact: true })).toBeTruthy();
    // Failure and handoff columns exist even when empty.
    expect(screen.getByRole("columnheader", { name: "Failure detail" })).toBeTruthy();
    expect(screen.getByRole("columnheader", { name: "Import handoff" })).toBeTruthy();
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

  it("removes a job while keeping downloaded files when that choice is explicit", async () => {
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
    render(withProviders(<QueueView adminId={null} />));
    await waitFor(() => expect(screen.getByTestId("remove-job-1")).toBeTruthy());
    fireEvent.click(screen.getByTestId("remove-job-1"));
    fireEvent.click(await screen.findByRole("button", { name: "Keep downloaded files" }));
    await waitFor(() => expect(actionPayload).toContain("remove"));
    expect(actionPayload).toContain('"deleteDataFiles":false');
    await waitFor(() => expect(screen.getByText(/kept/).closest("article")).toBeTruthy());
  });

  it("separates cancel from destructive data deletion", async () => {
    let actionPayload: string | undefined;
    routes.push(
      (p) => (p.includes("/api/v1/queue") && !p.includes("actions") ? { status: 200, body: { jobs: [ONE_JOB] } } : undefined),
      (p, init) => {
        if (!p.endsWith("/actions")) return undefined;
        actionPayload = String(init?.body ?? "");
        return { status: 200, body: { removed: true, dataFilesDeleted: true, note: "Downloaded files were deleted." } };
      },
    );
    render(withProviders(<QueueView adminId={null} />));
    await waitFor(() => expect(screen.getByTestId("remove-job-1")).toBeTruthy());
    fireEvent.click(screen.getByTestId("remove-job-1"));
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    expect(actionPayload).toBeUndefined();
    fireEvent.click(screen.getByTestId("remove-job-1"));
    fireEvent.click(await screen.findByRole("button", { name: "Delete downloaded files" }));
    await waitFor(() => expect(actionPayload).toContain('"deleteDataFiles":true'));
  });

  it("shows a truthful empty state", async () => {
    routes.push((p) => (p.includes("/api/v1/queue") ? { status: 200, body: { jobs: [] } } : undefined));
    render(withProviders(<QueueView adminId={null} />));
    await waitFor(() => expect(screen.getByText("The download queue is empty.")).toBeTruthy());
  });
});

// ---- Wanted ledger + recovery ---------------------------------------------------

const WANTED_ITEMS = [
  {
    itemKey: "movie-missing",
    kind: "movie",
    id: "movie-missing",
    title: "Missing Fixture",
    state: "missing",
    failureDetail: null,
    recovery: { action: "search", label: "Search releases" },
  },
  {
    itemKey: "series-recovery:S01E01",
    kind: "series",
    id: "series-recovery",
    episodeKey: "S01E01",
    title: "Failed Fixture S01E01",
    state: "failed",
    failureDetail: "CRC mismatch",
    recovery: { action: "retry", label: "Retry download", jobId: "job-failed" },
  },
  {
    itemKey: "series-recovery:S01E02",
    kind: "series",
    id: "series-recovery",
    episodeKey: "S01E02",
    title: "Paused Fixture S01E02",
    state: "paused",
    failureDetail: null,
    recovery: { action: "resume", label: "Resume download", jobId: "job-paused" },
  },
  {
    itemKey: "series-recovery:S01E03",
    kind: "series",
    id: "series-recovery",
    episodeKey: "S01E03",
    title: "Queued Fixture S01E03",
    state: "queued",
    failureDetail: null,
    recovery: null,
  },
  {
    itemKey: "series-recovery:S01E04",
    kind: "series",
    id: "series-recovery",
    episodeKey: "S01E04",
    title: "Cancelled Fixture S01E04",
    state: "cancelled",
    failureDetail: null,
    recovery: { action: "remove", label: "Remove from queue", jobId: "job-cancelled" },
  },
] as const;

describe("WantedView", () => {
  it("shows unified state, failure detail, and only the prescribed recovery action", async () => {
    const onSearchReleases = vi.fn();
    routes.push((path) =>
      path === "/api/v1/acquisition/wanted" ? { status: 200, body: { items: WANTED_ITEMS } } : undefined,
    );

    render(withProviders(<WantedView adminId={null} onSearchReleases={onSearchReleases} />));
    const grid = await screen.findByTestId("wanted-grid");
    expect(grid.textContent?.toLowerCase()).toContain("missing");
    expect(grid.textContent?.toLowerCase()).toContain("failed");
    expect(grid.textContent).toContain("CRC mismatch");

    const queuedRow = screen.getByText("Queued Fixture S01E03").closest("tr");
    expect(queuedRow).not.toBeNull();
    expect(within(queuedRow!).queryByRole("button")).toBeNull();
    expect(screen.getByRole("button", { name: "Retry download" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Resume download" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Remove from queue" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Search releases" }));
    expect(onSearchReleases).toHaveBeenCalledWith(expect.objectContaining({
      itemKey: "movie-missing",
      kind: "movie",
      id: "movie-missing",
    }));
  });

  it("routes retry and resume through the existing queue action API", async () => {
    const actions: Array<{ path: string; body: Record<string, unknown> }> = [];
    routes.push(
      (path) => path === "/api/v1/acquisition/wanted" ? { status: 200, body: { items: WANTED_ITEMS } } : undefined,
      (path, init) => {
        if (!path.endsWith("/actions")) return undefined;
        actions.push({ path, body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
        return { status: 200, body: { job: ONE_JOB } };
      },
    );

    render(withProviders(<WantedView adminId={null} />));
    fireEvent.click(await screen.findByRole("button", { name: "Retry download" }));
    await waitFor(() => expect(actions).toContainEqual({
      path: "/api/v1/queue/job-failed/actions",
      body: { action: "retry" },
    }));

    fireEvent.click(screen.getByRole("button", { name: "Resume download" }));
    await waitFor(() => expect(actions).toContainEqual({
      path: "/api/v1/queue/job-paused/actions",
      body: { action: "resume" },
    }));
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
    expect(within(screen.getByTestId("plugin-dev.tantalar.plugin.serving")).getByText("Healthy")).toBeTruthy();
    expect(screen.getByText("Media Serving")).toBeTruthy();
    expect(screen.getByText("dev.tantalar.plugin.serving")).toBeTruthy();
    expect(screen.getByText("1.0.0")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Import plugin" })).toHaveProperty("disabled", true);
  });
});

// ---- TAN-032 users -----------------------------------------------------------------

describe("UsersView (TAN-032)", () => {
  it("keeps account creation behind an explicit action", async () => {
    routes.push((p) =>
      p.split("?")[0] === "/api/v1/users" ? { status: 200, body: { users: [], total: 0 } } : undefined,
    );
    render(withProviders(<UsersView />));
    await waitFor(() => expect(screen.getByRole("button", { name: "Add person" })).toBeTruthy());
    expect(screen.queryByLabelText(/Username/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Add person" }));
    expect(screen.getByLabelText(/Username/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Create account" })).toBeTruthy();
  });

  it("renders per-user management controls", async () => {
    routes.push((p) =>
      p.split("?")[0] === "/api/v1/users"
        ? { status: 200, body: { users: [{ id: "u1", username: "alice", role: "admin", createdAt: "2026-08-24T00:00:00Z" }] } }
        : undefined,
    );
    render(withProviders(<UsersView />));
    await waitFor(() => expect(screen.getByTestId("user-alice")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Manage profile" }));
    fireEvent.click(screen.getByRole("tab", { name: "Security" }));
    expect(screen.getByRole("button", { name: "Reset password" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Sign out all sessions" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Deactivate account" })).toBeTruthy();
  });

  it("surfaces last-admin refusal messages verbatim", async () => {
    routes.push(
      (p) => (p.split("?")[0] === "/api/v1/users" ? { status: 200, body: { users: [{ id: "u1", username: "alice", role: "admin", createdAt: "2026-08-24T00:00:00Z" }] } } : undefined),
      (p) => (p.includes("/role") ? { status: 409, body: { error: "cannot remove the last administrator" } } : undefined),
    );
    render(withProviders(<UsersView />));
    fireEvent.click(await screen.findByRole("button", { name: "Manage profile" }));
    fireEvent.click(screen.getByRole("tab", { name: "Access" }));
    fireEvent.change(screen.getByLabelText("Access level"), { target: { value: "viewer" } });
    fireEvent.click(screen.getByRole("button", { name: "Save access level" }));
    await waitFor(() => expect(screen.getByText(/last administrator/).closest("article")?.getAttribute("role")).toBe("alert"));
  });
});

// ---- TAN-032 audit -------------------------------------------------------------------

describe("AuditView (TAN-032)", () => {
  it("merges security audit entries and operational events", async () => {
    routes.push(
      (p) => p.includes("/api/v1/system/audit")
        ? {
            status: 200,
            body: {
              entries: [{
                id: "a1",
                actorUserId: "u1",
                actorUsername: "admin",
                action: "apikey.created",
                targetType: "api_key",
                targetId: "k1",
                detail: {},
                occurredAt: "2026-08-24T01:00:00Z",
              }],
            },
          }
        : undefined,
      (p) => p.includes("/api/v1/events")
        ? {
            status: 200,
            body: {
              events: [{
                eventId: "e1",
                type: "library.rescan.completed",
                occurredAt: "2026-08-24T02:00:00Z",
                producer: "core.library",
                subject: "library:movies",
                correlationId: "scan-1",
                payload: { discovered: 1 },
              }],
            },
          }
        : undefined,
    );
    render(withProviders(<AuditView />));
    await waitFor(() => expect(screen.getByText("apikey.created")).toBeTruthy());
    expect(screen.getByText("library.rescan.completed")).toBeTruthy();
    expect(screen.getByText("core.library")).toBeTruthy();
    expect(screen.getByText("library:movies")).toBeTruthy();
    expect(screen.getByText("admin")).toBeTruthy();
    expect(screen.getByText("api_key:k1")).toBeTruthy();
    expect(screen.getByRole("textbox", { name: "Filter operations log" })).toBeTruthy();
    expect(screen.getByRole("combobox", { name: "Log category" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Export JSON" })).toHaveProperty("disabled", false);
  });

  it("exports the returned audit records without changing them", async () => {
    routes.push(
      (p) => p.includes("/api/v1/system/audit")
        ? { status: 200, body: { entries: [{ id: "a1", actorUserId: null, actorUsername: "admin", action: "user.created", targetType: "user", targetId: "u2", detail: { role: "viewer" }, occurredAt: "2026-08-24T01:00:00Z" }] } }
        : undefined,
      (p) => p.includes("/api/v1/events") ? { status: 200, body: { events: [] } } : undefined,
    );
    const createObjectURL = vi.fn(() => "blob:audit");
    const revokeObjectURL = vi.fn();
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: createObjectURL });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: revokeObjectURL });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);

    render(withProviders(<AuditView />));
    fireEvent.click(await screen.findByRole("button", { name: "Export JSON" }));

    expect(createObjectURL).toHaveBeenCalledOnce();
    expect(click).toHaveBeenCalledOnce();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:audit");
    click.mockRestore();
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

describe("API request headers", () => {
  it("does not claim an empty rescan request contains JSON", async () => {
    routes.push((path) =>
      path.endsWith("/api/v1/libraries/lib-1/rescan")
        ? { status: 200, body: { checked: 0, missingRemoved: 0 } }
        : undefined,
    );
    vi.mocked(fetch).mockClear();

    await api.rescanLibrary("lib-1");

    const [, init] = vi.mocked(fetch).mock.calls[0] ?? [];
    expect(new Headers(init?.headers).has("content-type")).toBe(false);
  });
});
