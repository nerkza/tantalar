import React from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const apiMock = vi.hoisted(() => ({ auditLog: vi.fn(), events: vi.fn() }));
vi.mock("../src/api", () => ({ api: apiMock }));

import { AuditView } from "../src/admin/views";

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
  apiMock.auditLog.mockReset().mockResolvedValue({ entries: [] });
  apiMock.events.mockReset().mockResolvedValue({
    events: [{
      eventId: "event-1",
      type: "dev.tantalar.event.download.completed",
      occurredAt: "2026-08-24T10:00:00.000Z",
      producer: "dev.tantalar.plugin.usenet-native",
      subject: "job-1",
      correlationId: "trace-1",
      causationId: "cause-1",
      payload: { bytes: 42 },
    }],
  });
});

afterEach(() => cleanup());

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MantineProvider>
      <QueryClientProvider client={client}><AuditView /></QueryClientProvider>
    </MantineProvider>,
  );
}

describe("operations log selected-record inspector", () => {
  it("keeps the activity map, log, and stored record inspector in one workspace", async () => {
    mount();
    expect(await screen.findByTestId("audit-activity-map")).toBeTruthy();
    const row = await screen.findByRole("row", { name: /Inspect dev\.tantalar\.event\.download\.completed/i });
    fireEvent.click(row);
    expect(screen.queryByRole("button", { name: "Open" })).toBeNull();
    expect(screen.getByRole("complementary", { name: "Audit inspector panel" })).toBeTruthy();
    const inspector = screen.getByRole("region", { name: "Selected audit record" });
    expect(within(inspector).getByRole("tab", { name: "Summary" })).toBeTruthy();
    expect(within(inspector).getByText("dev.tantalar.plugin.usenet-native")).toBeTruthy();
    expect(within(inspector).getByText("job-1")).toBeTruthy();

    fireEvent.click(within(inspector).getByRole("tab", { name: "Raw" }));
    expect(within(inspector).getByText(/"bytes": 42/)).toBeTruthy();

    fireEvent.click(within(inspector).getByRole("tab", { name: "Links" }));
    expect(within(inspector).getByText(/trace-1/)).toBeTruthy();
    expect(within(inspector).getByText(/cause-1/)).toBeTruthy();
    expect(within(inspector).queryByRole("tab", { name: "Input" })).toBeNull();
    expect(within(inspector).queryByRole("tab", { name: "Output" })).toBeNull();
    expect(within(inspector).queryByRole("tab", { name: "Timing" })).toBeNull();
  });
});
