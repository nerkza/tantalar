import React from "react";
import { it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { DownloadProgress, downloadRate } from "../src/admin/DownloadProgress";
import type { DownloadJob } from "../src/api";

it("shows measured byte speed and rejects stale, restarted, or reversed samples", () => {
  Object.defineProperty(window, "matchMedia", { writable: true, value: vi.fn(() => ({ matches: false, addEventListener() {}, removeEventListener() {} })) });
  const job = { jobId: "one", title: "Release", media: { title: "Movie", kind: "movie" }, state: "downloading", retryCount: 0, receivedBytes: 1_000_000, sizeBytes: 4_000_000, progressPercent: 25, updatedAt: "2026-09-06T12:00:00Z" } as DownloadJob;
  const next = { ...job, receivedBytes: 2_000_000, progressPercent: 50, updatedAt: "2026-09-06T12:00:02Z" };
  expect(downloadRate(job, next)).toBe(500_000);
  expect(downloadRate(undefined, next)).toBeNull();
  expect(downloadRate(job, { ...next, receivedBytes: 1 })).toBeNull();
  expect(downloadRate(job, { ...next, retryCount: 1 })).toBeNull();
  expect(downloadRate(job, { ...next, updatedAt: "2026-09-06T12:01:00Z" })).toBeNull();
  expect(downloadRate(job, { ...next, state: "paused" })).toBe(0);
  render(<MantineProvider><DownloadProgress job={next} bytesPerSecond={downloadRate(job, next)} /></MantineProvider>);
  expect(screen.getByText(/50% · 488 KB\/s/)).toBeTruthy();
  expect(screen.getByRole("progressbar", { name: "Movie download progress" }).getAttribute("aria-valuenow")).toBe("50");
});
