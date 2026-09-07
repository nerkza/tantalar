import React from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const apiMock = vi.hoisted(() => ({ uiPreferences: vi.fn(), saveUiPreferences: vi.fn(), saveNotification: vi.fn(), notificationHistory: vi.fn() }));
const feedState = vi.hoisted(() => ({ events: [] as Array<Record<string, unknown>> }));
const feedMock = vi.hoisted(() => vi.fn((
  _filters: Record<string, unknown> = {},
  _options: { enabled?: boolean; limit?: number } = {},
) => ({ events: feedState.events, status: "live" })));
vi.mock("../src/api", () => ({ api: apiMock }));
vi.mock("../src/live-event-feed", () => ({ useLiveEventFeed: feedMock }));

import {
  DEFAULT_NOTIFICATION_PREFERENCES,
  NotificationPreferencesPage,
  NotificationsPage,
  NotificationProvider,
  normalizeNotificationPreferences,
  noticeForLiveEvent,
  useNotifications,
} from "../src/notifications";

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
  vi.useRealTimers();
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  feedState.events = [];
  feedMock.mockClear();
  apiMock.uiPreferences.mockReset().mockResolvedValue({ preferences: {} });
  apiMock.saveUiPreferences.mockReset().mockResolvedValue({ saved: true });
  apiMock.saveNotification.mockReset().mockResolvedValue({ saved: true });
  apiMock.notificationHistory.mockReset().mockResolvedValue({ items: [], total: 0 });
});

afterEach(() => cleanup());

function Harness() {
  const notices = useNotifications();
  return (
    <>
      <button onClick={() => notices.show({ key: "same", severity: "success", title: "Saved" })}>Show saved</button>
      <button onClick={() => notices.show({ key: "warning", severity: "warning", title: "Needs attention", durationMs: 1_000 })}>Show warning</button>
      <button onClick={() => notices.show({ key: "persistent", severity: "warning", title: "Persistent warning", durationMs: null })}>Show persistent</button>
      <button onClick={() => notices.show({ key: "local-result", severity: "success", title: "Local result", correlationId: "corr-shared" })}>Show correlated</button>
      <button onClick={() => notices.show({
        key: "route",
        severity: "error",
        title: "Download failed",
        route: { name: "admin", area: "acquisition", child: "downloads" },
        actionLabel: "Open Downloads",
      })}>Show route</button>
    </>
  );
}

function renderProvider(children: React.ReactNode, navigate = vi.fn(), isAdmin = true) {
  return {
    navigate,
    ...render(
      <MantineProvider>
        <NotificationProvider userId="user-1" isAdmin={isAdmin} navigate={navigate}>
          {children}
        </NotificationProvider>
      </MantineProvider>,
    ),
  };
}

describe("notification system", () => {
  it("honors the saved timeout despite repeats and a hidden tab", async () => {
    vi.useFakeTimers();
    apiMock.uiPreferences.mockResolvedValue({ preferences: { notifications: { durations: { success: 1_000 } } } });
    renderProvider(<Harness />);
    await act(async () => Promise.resolve());
    fireEvent.click(screen.getByRole("button", { name: "Show saved" }));
    fireEvent.pointerEnter(screen.getByRole("status"));
    act(() => vi.advanceTimersByTime(700));
    fireEvent.click(screen.getByRole("button", { name: "Show saved" }));
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    act(() => vi.advanceTimersByTime(301));
    act(() => vi.advanceTimersByTime(181));
    expect(screen.queryByText("Saved (2)")).toBeNull();
  });
  it("normalizes preferences and maps only reviewed safe event copy", () => {
    expect(normalizeNotificationPreferences({ corner: "elsewhere", maxVisible: 99 })).toEqual(DEFAULT_NOTIFICATION_PREFERENCES);
    const notice = noticeForLiveEvent({
      eventId: "event-1",
      correlationId: "corr-1",
      type: "dev.tantalar.event.download.failed",
      occurredAt: "2026-01-01T00:00:00.000Z",
      producer: "test",
      payload: { path: "/private/media/title.mkv", error: "secret provider detail" },
    }, DEFAULT_NOTIFICATION_PREFERENCES);
    expect(notice).toMatchObject({
      key: "event:event-1",
      severity: "error",
      title: "Download failed",
      route: { name: "admin", area: "acquisition", child: "downloads" },
    });
    expect(JSON.stringify(notice)).not.toContain("/private/media");
    expect(JSON.stringify(notice)).not.toContain("secret provider detail");
    expect(noticeForLiveEvent({
      eventId: "event-vpn",
      type: "dev.tantalar.event.tunnel.health.changed",
      occurredAt: "2026-01-01T00:00:00.000Z",
      producer: "test",
      payload: { health: "down", providerError: "secret provider detail" },
    }, DEFAULT_NOTIFICATION_PREFERENCES)).toMatchObject({
      severity: "error",
      title: "VPN tunnel unavailable",
      route: { name: "admin", area: "acquisition", child: "vpn" },
    });
    expect(noticeForLiveEvent({
      eventId: "event-2",
      type: "dev.tantalar.event.download.progress",
      occurredAt: "2026-01-01T00:00:00.000Z",
      producer: "test",
      payload: {},
    }, DEFAULT_NOTIFICATION_PREFERENCES)).toBeNull();
  });

  it("coalesces repeated keys and keeps activation separate from dismissal", async () => {
    const { navigate } = renderProvider(<Harness />);
    await waitFor(() => expect(apiMock.uiPreferences).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: "Show saved" }));
    fireEvent.click(screen.getByRole("button", { name: "Show saved" }));
    expect(screen.getByRole("region", { name: "Notifications" })).toBeTruthy();
    expect(screen.getByText("Saved (2)")).toBeTruthy();
    expect(screen.getByText("Success")).toBeTruthy();
    expect(screen.getByRole("status").getAttribute("aria-live")).toBe("polite");

    fireEvent.click(screen.getByRole("button", { name: "Show route" }));
    const alert = screen.getByRole("alert");
    expect(alert.getAttribute("aria-live")).toBe("assertive");
    fireEvent.click(screen.getByRole("button", { name: "Open Downloads" }));
    expect(navigate).toHaveBeenCalledWith({ name: "admin", area: "acquisition", child: "downloads" });
    expect(screen.getByRole("button", { name: "Dismiss Saved" })).toBeTruthy();
  });

  it("pauses expiry while hovered", async () => {
    vi.useFakeTimers();
    renderProvider(<Harness />);
    await act(async () => Promise.resolve());
    fireEvent.click(screen.getByRole("button", { name: "Show warning" }));
    const notice = screen.getByRole("status");
    fireEvent.pointerMove(notice);
    act(() => vi.advanceTimersByTime(2_000));
    expect(screen.getByText("Needs attention")).toBeTruthy();
    fireEvent.pointerLeave(notice);
    act(() => vi.advanceTimersByTime(1_181));
    expect(screen.queryByText("Needs attention")).toBeNull();
  });

  it("pauses expiry while focused and continues in hidden tabs", async () => {
    vi.useFakeTimers();
    renderProvider(<Harness />);
    await act(async () => Promise.resolve());
    fireEvent.click(screen.getByRole("button", { name: "Show warning" }));
    const dismiss = screen.getByRole("button", { name: "Dismiss Needs attention" });

    fireEvent.focus(dismiss);
    act(() => vi.advanceTimersByTime(2_000));
    expect(screen.getByText("Needs attention")).toBeTruthy();
    fireEvent.blur(dismiss);
    act(() => vi.advanceTimersByTime(400));
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    act(() => vi.advanceTimersByTime(2_000));
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    act(() => vi.advanceTimersByTime(781));
    expect(screen.queryByText("Needs attention")).toBeNull();
  });

  it("keeps a stable bounded viewport and supports persistent notices", async () => {
    vi.useFakeTimers();
    apiMock.uiPreferences.mockResolvedValue({ preferences: { notifications: { maxVisible: 2 } } });
    renderProvider(<Harness />);
    await act(async () => Promise.resolve());
    fireEvent.click(screen.getByRole("button", { name: "Show saved" }));
    fireEvent.click(screen.getByRole("button", { name: "Show warning" }));
    fireEvent.click(screen.getByRole("button", { name: "Show route" }));
    expect(screen.getByText("Saved")).toBeTruthy();
    expect(screen.getByText("Needs attention")).toBeTruthy();
    expect(screen.queryByText("Download failed")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Dismiss Saved" }));
    act(() => vi.advanceTimersByTime(181));
    expect(screen.getByText("Download failed")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Dismiss Needs attention" }));
    act(() => vi.advanceTimersByTime(181));
    fireEvent.click(screen.getByRole("button", { name: "Show persistent" }));
    act(() => vi.advanceTimersByTime(60_000));
    expect(screen.getByText("Persistent warning")).toBeTruthy();
  });

  it("suppresses direct and event double-delivery by correlation ID", async () => {
    const rendered = renderProvider(<Harness />);
    await waitFor(() => expect(apiMock.uiPreferences).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: "Show correlated" }));
    feedState.events = [{
      eventId: "event-correlated",
      correlationId: "corr-shared",
      type: "dev.tantalar.event.download.failed",
      occurredAt: "2026-01-01T00:00:00.000Z",
      producer: "test",
      payload: {},
    }];
    rendered.rerender(
      <MantineProvider>
        <NotificationProvider userId="user-1" isAdmin navigate={rendered.navigate}>
          <Harness />
        </NotificationProvider>
      </MantineProvider>,
    );
    await act(async () => Promise.resolve());
    expect(screen.getByText("Local result")).toBeTruthy();
    expect(screen.queryByText("Download failed")).toBeNull();
  });

  it("persists the notification namespace and keeps event controls administrator-only", async () => {
    const { rerender } = renderProvider(<NotificationPreferencesPage isAdmin={false} />, vi.fn(), false);
    expect(await screen.findByText("Operational event notices require an administrator account.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Save preferences" }));
    await waitFor(() => expect(apiMock.saveUiPreferences).toHaveBeenCalledWith(
      "user-1",
      { notifications: DEFAULT_NOTIFICATION_PREFERENCES },
    ));

    rerender(
      <MantineProvider>
        <NotificationProvider userId="user-1" isAdmin navigate={vi.fn()}>
          <NotificationPreferencesPage isAdmin />
        </NotificationProvider>
      </MantineProvider>,
    );
    expect(await screen.findByLabelText("Downloads")).toBeTruthy();
  });

  it("loads saved preferences before subscribing to operational events", async () => {
    let resolvePreferences!: (value: { preferences: Record<string, unknown> }) => void;
    apiMock.uiPreferences.mockReturnValue(new Promise((resolve) => {
      resolvePreferences = resolve;
    }));
    renderProvider(<NotificationPreferencesPage isAdmin />);

    expect(screen.getByRole("status").textContent).toBe("Loading notification preferences…");
    expect(screen.queryByRole("button", { name: "Save preferences" })).toBeNull();
    expect(feedMock.mock.calls.every((call) => call[1]?.enabled === false)).toBe(true);

    await act(async () => resolvePreferences({
      preferences: { notifications: { enabled: false } },
    }));
    expect(await screen.findByRole("button", { name: "Save preferences" })).toBeTruthy();
    expect(feedMock.mock.calls.at(-1)?.[1]?.enabled).toBe(true);
  });

  it("keeps history when popups are disabled and opens history before settings", async () => {
    apiMock.uiPreferences.mockResolvedValue({ preferences: { notifications: { enabled: false } } });
    apiMock.notificationHistory.mockResolvedValue({ items: [{ id: "earlier", title: "Earlier download", severity: "success", createdAt: "2026-09-06T12:00:00Z", count: 1 }], total: 1 });
    renderProvider(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><Harness /><NotificationsPage isAdmin /></QueryClientProvider>);
    expect(await screen.findByText("Earlier download")).toBeTruthy();
    expect(screen.getByRole("tab", { name: "History" }).getAttribute("aria-selected")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Show saved" }));
    await waitFor(() => expect(apiMock.saveNotification).toHaveBeenCalledWith(expect.objectContaining({ title: "Saved", count: 1 })));
    expect(screen.queryByRole("button", { name: "Dismiss Saved" })).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: "Settings" }));
    fireEvent.change(screen.getByLabelText("Position"), { target: { value: "top-left" } });
    fireEvent.click(screen.getByLabelText("Show in-app notifications"));
    fireEvent.click(screen.getByRole("button", { name: "Save preferences" }));
    await waitFor(() => expect(apiMock.saveUiPreferences).toHaveBeenCalledWith("user-1", expect.objectContaining({ notifications: expect.objectContaining({ enabled: true, corner: "top-left" }) })));
  });

  it("drops pending history writes when the account provider unmounts", async () => {
    let finish!: (value: { saved: boolean }) => void;
    apiMock.saveNotification.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const view = renderProvider(<Harness />);
    await act(async () => Promise.resolve());
    fireEvent.click(screen.getByRole("button", { name: "Show saved" }));
    fireEvent.click(screen.getByRole("button", { name: "Show warning" }));
    await waitFor(() => expect(apiMock.saveNotification).toHaveBeenCalledTimes(1));
    view.unmount();
    await act(async () => finish({ saved: true }));
    expect(apiMock.saveNotification).toHaveBeenCalledTimes(1);
  });
});
