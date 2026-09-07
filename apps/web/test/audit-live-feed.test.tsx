import React from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const apiMock = vi.hoisted(() => ({ auditLog: vi.fn(), events: vi.fn() }));
vi.mock("../src/api", () => ({ api: apiMock }));

import { AuditView } from "../src/admin/views";
import { isTrajectoryEvent, useLiveEventFeed } from "../src/live-event-feed";

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(readonly url: URL) {
    FakeWebSocket.instances.push(this);
  }

  close() {
    this.onclose?.({ code: 1000 });
  }

  open() {
    this.onopen?.();
  }

  message(value: unknown) {
    this.onmessage?.({ data: JSON.stringify(value) });
  }

  raw(value: string) {
    this.onmessage?.({ data: value });
  }

  drop() {
    this.onclose?.({ code: 1006 });
  }
}

beforeAll(() => {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: vi.fn().mockImplementation(() => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
    })),
  });
  vi.stubGlobal("ResizeObserver", class {
    observe() {}
    unobserve() {}
    disconnect() {}
  });
  vi.stubGlobal("WebSocket", FakeWebSocket);
});

beforeEach(() => {
  FakeWebSocket.instances = [];
  apiMock.auditLog.mockReset().mockResolvedValue({ entries: [] });
  apiMock.events.mockReset().mockResolvedValue({
    events: [{
      eventId: "stored-1",
      type: "dev.tantalar.event.library.scan.completed",
      occurredAt: new Date().toISOString(),
      producer: "core",
      subject: "library-1",
      payload: {},
    }],
  });
});

afterEach(() => cleanup());

function FeedProbe({ enabled = true, limit }: { enabled?: boolean; limit?: number }) {
  const feed = useLiveEventFeed({}, { enabled, limit });
  return <div data-testid="feed-probe" data-status={feed.status}>{feed.events.map((event) => event.eventId).join(",")}</div>;
}

describe("shared live event feed", () => {
  it("does not open a socket while disabled", () => {
    render(<FeedProbe enabled={false} />);
    expect(screen.getByTestId("feed-probe").dataset.status).toBe("unavailable");
    expect(FakeWebSocket.instances).toHaveLength(0);
  });

  it("validates, bounds, and de-duplicates frames", async () => {
    render(<FeedProbe limit={1} />);
    const socket = FakeWebSocket.instances[0]!;
    const event = {
      eventId: "live-1",
      type: "dev.tantalar.event.test",
      occurredAt: new Date().toISOString(),
      producer: "core",
      payload: {},
    };
    expect(isTrajectoryEvent(event)).toBe(true);
    expect(isTrajectoryEvent({ ...event, payload: [] })).toBe(false);
    act(() => {
      socket.raw("not json");
      socket.message({ ...event, payload: [] });
      socket.message(event);
      socket.message(event);
      socket.message({ ...event, eventId: "live-2" });
    });
    await waitFor(() => expect(screen.getByTestId("feed-probe").textContent).toBe("live-2"));
  });
});

describe("live Audit activity map", () => {
  it("scopes historical and live entries to a type prefix", async () => {
    const typePrefix = "dev.tantalar.event.mcp.call";
    apiMock.auditLog.mockResolvedValue({
      entries: [{
        id: "audit-1",
        actorUserId: "user-1",
        actorUsername: "operator",
        action: "user.updated",
        targetType: "user",
        targetId: "user-1",
        detail: {},
        occurredAt: new Date().toISOString(),
      }],
    });
    apiMock.events.mockResolvedValue({
      events: [{
        eventId: "stored-mcp",
        type: typePrefix,
        occurredAt: new Date().toISOString(),
        producer: "mcp",
        subject: "tool:test",
        payload: {},
      }, {
        eventId: "stored-other",
        type: "dev.tantalar.event.library.scan.completed",
        occurredAt: new Date().toISOString(),
        producer: "core",
        subject: "library-1",
        payload: {},
      }],
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <MantineProvider>
        <QueryClientProvider client={client}><AuditView typePrefix={typePrefix} /></QueryClientProvider>
      </MantineProvider>,
    );

    expect(await screen.findByRole("row", { name: new RegExp(`Inspect ${typePrefix.replaceAll(".", "\\.")}`, "i") })).toBeTruthy();
    expect(apiMock.events.mock.calls[0]?.[0]).toEqual({ typePrefix, limit: 500 });
    const socket = FakeWebSocket.instances[0]!;
    expect(socket.url.searchParams.get("typePrefix")).toBe(typePrefix);
    expect(screen.queryByText("user.updated")).toBeNull();
    expect(screen.queryByText("dev.tantalar.event.library.scan.completed")).toBeNull();

    act(() => {
      socket.message({
        eventId: "live-other",
        type: "dev.tantalar.event.system.client.incident",
        occurredAt: new Date().toISOString(),
        producer: "web",
        payload: {},
      });
      socket.message({
        eventId: "live-mcp",
        type: `${typePrefix}.completed`,
        occurredAt: new Date().toISOString(),
        producer: "mcp",
        payload: {},
      });
    });
    expect(await screen.findByRole("button", { name: new RegExp(`${typePrefix.replaceAll(".", "\\.")}\\.completed`, "i") })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /system\.client\.incident/i })).toBeNull();
  });

  it("streams and de-duplicates new events without changing the table snapshot", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <MantineProvider>
        <QueryClientProvider client={client}><AuditView /></QueryClientProvider>
      </MantineProvider>,
    );

    expect(await screen.findByRole("row", { name: /Inspect dev\.tantalar\.event\.library\.scan\.completed/i })).toBeTruthy();
    expect(await screen.findByRole("button", { name: /Media: dev\.tantalar\.event\.library\.scan\.completed/i })).toBeTruthy();
    expect(screen.queryByText("No activity in this window")).toBeNull();
    expect(screen.getByText("Connecting…")).toBeTruthy();
    const socket = FakeWebSocket.instances[0]!;
    act(() => socket.open());
    expect(await screen.findByLabelText("Timeline connection: live")).toBeTruthy();
    expect(screen.queryByText("live")).toBeNull();

    const liveEvent = {
      eventId: "live-1",
      type: "dev.tantalar.event.system.client.incident",
      occurredAt: new Date().toISOString(),
      producer: "web",
      subject: "browser",
      payload: { kind: "test" },
    };
    act(() => {
      socket.message({
        eventId: "stored-1",
        type: "dev.tantalar.event.library.scan.completed",
        occurredAt: new Date().toISOString(),
        producer: "core",
        subject: "library-1",
        payload: {},
      });
      socket.message(liveEvent);
      socket.message(liveEvent);
    });
    expect(await screen.findAllByRole("button", { name: /Media: dev\.tantalar\.event\.library\.scan\.completed/i })).toHaveLength(1);
    expect(await screen.findByRole("button", { name: /System: dev\.tantalar\.event\.system\.client\.incident/i })).toBeTruthy();
    expect(screen.getAllByRole("button", { name: /System: dev\.tantalar\.event\.system\.client\.incident/i })).toHaveLength(1);
    expect(screen.queryByRole("row", { name: /Inspect dev\.tantalar\.event\.system\.client\.incident/i })).toBeNull();

    act(() => socket.drop());
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2), { timeout: 1_000 });
  });
});
