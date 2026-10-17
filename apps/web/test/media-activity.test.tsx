import React from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MantineProvider } from "@mantine/core";

vi.mock("../src/api", () => ({
  api: {
    history: vi.fn(),
    setResume: vi.fn(),
  },
}));

import { api } from "../src/api";
import { MediaActivityPage } from "../src/pages/MediaActivityPage";

const IN_PROGRESS = {
  fileId: "movie-in-progress",
  title: "A Film With A Long but Useful Title",
  kind: "movie" as const,
  positionMs: 30 * 60_000,
  durationMs: 60 * 60_000,
  completed: false,
  lastWatchedAt: "2026-08-25T12:30:00.000Z",
  artworkUrl: null,
};

const COMPLETED = {
  fileId: "series-completed",
  title: "Completed Series",
  kind: "series" as const,
  positionMs: 59 * 60_000,
  durationMs: 60 * 60_000,
  completed: true,
  lastWatchedAt: "2026-08-24T18:15:00.000Z",
  artworkUrl: "https://image.tmdb.org/t/p/w342/poster.jpg",
};

function renderPage(onWatch = vi.fn()) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <MantineProvider defaultColorScheme="dark">
      <QueryClientProvider client={queryClient}>
        <MediaActivityPage onWatch={onWatch} />
      </QueryClientProvider>
    </MantineProvider>,
  );
  return onWatch;
}

beforeAll(() => {
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
});

beforeEach(() => {
  vi.mocked(api.history).mockReset();
  vi.mocked(api.setResume).mockReset();
  vi.mocked(api.setResume).mockResolvedValue({
    accepted: true,
    resumePoint: {
      userId: "viewer",
      fileId: COMPLETED.fileId,
      positionMs: 0,
      durationMs: COMPLETED.durationMs,
      updatedAt: "2026-08-25T13:00:00.000Z",
    },
  });
});

afterEach(() => cleanup());

describe("My activity", () => {
  it("shows compact viewer history and routes Resume and Play again", async () => {
    vi.mocked(api.history).mockResolvedValue({ history: [IN_PROGRESS, COMPLETED] });
    const onWatch = renderPage();

    expect(await screen.findByTestId("activity-row-movie-in-progress")).toBeTruthy();
    expect(screen.getByRole("progressbar", { name: "50% watched" })).toBeTruthy();
    expect(screen.getByTestId("activity-artwork-fallback-movie-in-progress")).toBeTruthy();
    expect(screen.queryByText(/trajectory|correlation/i)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: `Resume ${IN_PROGRESS.title}` }));
    expect(onWatch).toHaveBeenCalledWith(IN_PROGRESS.fileId);

    fireEvent.click(screen.getByRole("tab", { name: "History" }));
    expect(await screen.findByTestId("activity-row-series-completed")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: `Play again ${COMPLETED.title}` }));

    await waitFor(() => {
      expect(api.setResume).toHaveBeenCalledWith(
        COMPLETED.fileId,
        0,
        COMPLETED.durationMs,
        true,
      );
      expect(onWatch).toHaveBeenCalledWith(COMPLETED.fileId);
    });
  });

  it("falls back locally when allowed artwork fails", async () => {
    vi.mocked(api.history).mockResolvedValue({ history: [COMPLETED] });
    renderPage();
    fireEvent.click(await screen.findByRole("tab", { name: "History" }));

    const artwork = await screen.findByTestId("activity-artwork-series-completed");
    fireEvent.error(artwork);
    expect(screen.getByTestId("activity-artwork-fallback-series-completed")).toBeTruthy();
  });

  it("shows a truthful empty state", async () => {
    vi.mocked(api.history).mockResolvedValue({ history: [] });
    renderPage();

    expect(await screen.findByRole("heading", { name: "Nothing watched yet" })).toBeTruthy();
    expect(screen.getByText("Start something from Home or your library.")).toBeTruthy();
  });

  it("shows a retryable error without exposing an admin activity view", async () => {
    vi.mocked(api.history)
      .mockRejectedValueOnce(new Error("History is unavailable"))
      .mockResolvedValueOnce({ history: [] });
    renderPage();

    expect(await screen.findByText("History is unavailable")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("heading", { name: "Nothing watched yet" })).toBeTruthy();
    expect(screen.queryByText(/activity & trajectory/i)).toBeNull();
  });
});
