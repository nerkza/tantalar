import React from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const apiMock = vi.hoisted(() => ({ diagnostics: vi.fn() }));
vi.mock("../src/api", () => ({ api: apiMock }));

import { OverviewDashboard, SystemHealthDashboard } from "../src/shell/HealthViews";

beforeAll(() => {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: vi.fn().mockImplementation(() => ({
      matches: false,
      media: "",
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
});

const report = {
  versions: {
    tantalar: { version: "0.0.1-alpha.0", label: "0.0.1 Alpha", channel: "alpha" },
    node: "v22.0.0",
    platform: "linux",
    arch: "x64",
  },
  ready: true,
  plugins: [{ id: "dev.tantalar.plugin.usenet-native", version: "0.0.1", state: "healthy", restarts: 0, provides: ["dev.tantalar.capability.usenet.engine"] }],
  eventCount: 227,
  missingCapabilities: [],
  resources: {
    uptimeSeconds: 90_061,
    startedAt: "2026-08-24T10:00:00.000Z",
    process: { rssBytes: 268_435_456, heapUsedBytes: 67_108_864, cpuUserSeconds: 12.5, cpuSystemSeconds: 2.5 },
    host: { totalMemoryBytes: 8_589_934_592, freeMemoryBytes: 3_221_225_472, usedMemoryBytes: 5_368_709_120, loadAverage: [0.25, 0.2, 0.15] },
  },
  storage: {
    dataVolume: { totalBytes: 1_099_511_627_776, usedBytes: 549_755_813_888, freeBytes: 549_755_813_888, unavailableReason: null },
    catalogKnownBytes: null,
    catalogKnownBytesReason: "Catalog file sizes are not stored yet.",
  },
  libraries: {
    configured: 2,
    enabled: 2,
    byKind: { movie: 1, series: 1, mixed: 0 },
    catalog: { files: 18, items: 12, movies: 7, series: 5, mixed: 0 },
    unavailableReason: null,
    lastScanAt: "2026-08-25T10:00:00.000Z",
  },
  work: {
    queue: { queued: 2, downloading: 1, paused: 0, failed: 1 },
    queueUnavailableReason: null,
    playbackStarts: 25,
    activeStreams: null,
    activeStreamsReason: "The runtime does not expose active playback sessions yet.",
    activeTranscodes: null,
    activeTranscodesReason: "The runtime does not expose active transcode sessions yet.",
  },
  capabilities: {
    indexerMounted: true,
    downloadClientMounted: true,
    torrentEngineMounted: true,
    usenetEngineMounted: true,
    vpnMounted: false,
  },
  recentIncidents: [{ id: "incident-1", type: "dev.tantalar.event.download.failed", occurredAt: "2026-08-25T11:00:00.000Z", subject: "job-1" }],
  incidentsUnavailableReason: null,
  unavailable: [],
  transcoder: { ffmpegAvailable: false },
  network: { vpnCapabilityMounted: false },
} as const;

function mount(node: React.ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<MantineProvider><QueryClientProvider client={client}>{node}</QueryClientProvider></MantineProvider>);
}

beforeEach(() => apiMock.diagnostics.mockReset().mockResolvedValue(report));
afterEach(() => cleanup());

describe("Control overview hub", () => {
  it("puts attention first, shows live work and routes required actions", async () => {
    const navigate = vi.fn();
    mount(<OverviewDashboard onNavigate={navigate} />);

    expect(await screen.findByTestId("control-overview-dashboard")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Needs attention" })).toBeTruthy();
    expect(screen.getByText("Install FFmpeg")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Active work" })).toBeTruthy();
    expect(screen.getByText("Downloading")).toBeTruthy();
    expect(screen.getByText("2 queued · 1 failed")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Refresh overview" })).toBeTruthy();
    fireEvent.click(screen.getByText("Install FFmpeg").closest("li")!.querySelector("button")!);
    expect(navigate).toHaveBeenCalledWith("playback", undefined);
    expect(apiMock.diagnostics).toHaveBeenCalledWith(expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });

  it("reports native downloaders that are not mounted", async () => {
    apiMock.diagnostics.mockResolvedValue({
      ...report,
      capabilities: { ...report.capabilities, torrentEngineMounted: false, usenetEngineMounted: false },
    });
    mount(<OverviewDashboard onNavigate={vi.fn()} />);

    expect(await screen.findByText("Usenet and Torrent downloaders are not mounted")).toBeTruthy();
    expect(screen.getByText("Enable the modules in the host configuration, then restart Tantalar.")).toBeTruthy();
  });

  it("keeps host diagnostics off the page", async () => {
    mount(<OverviewDashboard onNavigate={vi.fn()} />);

    expect(await screen.findByTestId("control-overview-dashboard")).toBeTruthy();
    expect(screen.queryByText("Process memory")).toBeNull();
    expect(screen.queryByText("CPU time")).toBeNull();
    expect(screen.queryByText("Host memory")).toBeNull();
    expect(screen.queryByRole("heading", { name: "Current state" })).toBeNull();
  });

  it("renders one fact tile per area and marks faulted areas with the queue tone", async () => {
    const navigate = vi.fn();
    mount(<OverviewDashboard onNavigate={navigate} />);

    expect(await screen.findByTestId("control-overview-dashboard")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Services" })).toBeTruthy();

    const media = screen.getByTestId("overview-tile-media");
    expect(within(media).getByText(/2 libraries · 12 titles · scanned/)).toBeTruthy();
    fireEvent.click(media);
    expect(navigate).toHaveBeenCalledWith("media");

    const acquisition = screen.getByTestId("overview-tile-acquisition");
    expect(within(acquisition).getByText("1 downloading · 2 queued · 1 failed")).toBeTruthy();
    expect(within(acquisition).getByText("Needs attention")).toBeTruthy();

    const extensions = screen.getByTestId("overview-tile-extensions");
    expect(within(extensions).getByText("1 mounted · all running")).toBeTruthy();
    expect(within(extensions).queryByText("Needs attention")).toBeNull();

    const audit = screen.getByTestId("overview-tile-audit");
    expect(within(audit).getByText("227 recorded events · 1 recent incident")).toBeTruthy();

    const system = screen.getByTestId("overview-tile-system");
    expect(within(system).getByText("Up 1d 1h · 0.0.1 Alpha")).toBeTruthy();
  });
});

describe("System Health", () => {
  it("groups measured state, keeps unknown state explicit and reveals technical extension details", async () => {
    const navigate = vi.fn();
    apiMock.diagnostics.mockResolvedValue({
      ...report,
      ready: false,
      missingCapabilities: ["dev.tantalar.capability.metadata-provider"],
      plugins: [{ ...report.plugins[0], state: "failed", restarts: 2 }],
      recentIncidents: [],
      incidentsUnavailableReason: "Recent incidents are unavailable.",
      unavailable: ["Event history is unavailable."],
    });
    mount(<SystemHealthDashboard onNavigate={navigate} />);

    expect(await screen.findByTestId("system-health-dashboard")).toBeTruthy();
    const toolbar = screen.getByTestId("health-toolbar");
    expect(within(toolbar).getByText("Overall")).toBeTruthy();
    expect(within(toolbar).getByText("Blocked")).toBeTruthy();
    expect(within(toolbar).getByRole("button", { name: "Refresh checks" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Problems" })).toBeTruthy();
    expect(screen.queryByText("Priority order")).toBeNull();
    expect(screen.queryByText("Fix these first")).toBeNull();
    expect(screen.getByRole("heading", { name: "Resources" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Storage and libraries" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Media pipeline" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Acquisition and network" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Extensions" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Recent incidents" })).toBeTruthy();
    expect(screen.getByText("Native Usenet")).toBeTruthy();
    expect(screen.getByText("2 restarts")).toBeTruthy();
    expect(screen.getByText("Recent incidents are unavailable.")).toBeTruthy();
    expect(screen.getByText("VPN binding")).toBeTruthy();
    expect(screen.getAllByText("Unavailable").length).toBeGreaterThan(1);
    expect(screen.getByText("Required services are not ready")).toBeTruthy();
    expect(screen.getByText("Install FFmpeg")).toBeTruthy();
    expect(screen.getByText("Review network protection")).toBeTruthy();
    expect(screen.getByText("Some diagnostics are unavailable")).toBeTruthy();
    for (const row of screen.getAllByTestId("health-row")) expect(row.children).toHaveLength(4);
    for (const row of screen.getAllByTestId("health-problem-row")) expect(row.children).toHaveLength(4);

    fireEvent.click(screen.getByText("Technical details"));
    expect(screen.getByText("dev.tantalar.plugin.usenet-native")).toBeTruthy();
    fireEvent.click(screen.getByText("Open queue"));
    expect(navigate).toHaveBeenCalledWith("acquisition", "downloads");
  });
});
