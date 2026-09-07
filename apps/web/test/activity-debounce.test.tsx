import React from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const apiMock = vi.hoisted(() => ({ events: vi.fn() }));
vi.mock("../src/api", () => ({ api: apiMock }));

import { ActivityView } from "../src/admin/views";

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
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("WebSocket", undefined);
  apiMock.events.mockReset().mockResolvedValue({ events: [] });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MantineProvider>
      <QueryClientProvider client={client}>
        <ActivityView />
      </QueryClientProvider>
    </MantineProvider>,
  );
}

describe("Trace filtering", () => {
  it("debounces rapid typing and passes the query AbortSignal", async () => {
    mount();
    await act(async () => { await Promise.resolve(); });
    expect(apiMock.events).toHaveBeenCalledTimes(1);

    const input = screen.getByLabelText("Filter by event type prefix");
    for (const value of ["d", "de", "dev", "dev.", "dev.tantalar.event"]) {
      fireEvent.change(input, { target: { value } });
    }
    await act(async () => {
      await vi.advanceTimersByTimeAsync(299);
    });
    expect(apiMock.events).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(apiMock.events).toHaveBeenCalledTimes(2);
    expect(apiMock.events).toHaveBeenLastCalledWith(
      { typePrefix: "dev.tantalar.event", limit: 500 },
      { signal: expect.any(AbortSignal) },
    );
  });

  it("presents stored events as a trace workspace", async () => {
    vi.useRealTimers();
    apiMock.events.mockResolvedValue({
      events: [{
        eventId: "event-1",
        type: "dev.tantalar.event.library.scan.completed",
        occurredAt: new Date().toISOString(),
        producer: "dev.tantalar.plugin.library",
        subject: "library-1",
        correlationId: "operation-1",
        payload: { discovered: 2 },
      }],
    });

    const { container } = mount();

    expect(screen.queryByText(/Timing and input\/output panes/)).toBeNull();
    expect(screen.queryByText(/trajectory/i)).toBeNull();
    expect(container.querySelector(".tantalar-audit-workspace")).toBeTruthy();
    expect(await screen.findByText("Timeline")).toBeTruthy();
    expect(await screen.findByRole("button", { name: /Media: dev\.tantalar\.event\.library\.scan\.completed/i })).toBeTruthy();
    expect(screen.queryByText("No activity in this window")).toBeNull();
    const eventRow = await screen.findByRole("row", { name: /Inspect dev\.tantalar\.event\.library\.scan\.completed/i });
    fireEvent.click(eventRow);
    expect(await screen.findByRole("region", { name: "Selected audit record" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Raw" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Trace" })).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "Trace" }));
    expect(screen.getByText("1 related operations under this correlation.")).toBeTruthy();
  });
});
