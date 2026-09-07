import type { DiagnosticsReport } from "../src/api";

export const diagnosticsFixture: DiagnosticsReport = {
  versions: {
    tantalar: { version: "0.0.1-alpha.0", label: "0.0.1 Alpha", channel: "alpha" },
    node: "v22.0.0",
    platform: "linux",
    arch: "x64",
  },
  ready: true,
  plugins: [],
  eventCount: 0,
  missingCapabilities: [],
  resources: {
    uptimeSeconds: 60,
    startedAt: "2026-08-25T00:00:00.000Z",
    process: { rssBytes: 1_048_576, heapUsedBytes: 524_288, cpuUserSeconds: 1, cpuSystemSeconds: 0.5 },
    host: { totalMemoryBytes: 8_589_934_592, freeMemoryBytes: 4_294_967_296, usedMemoryBytes: 4_294_967_296, loadAverage: [0.1, 0.1, 0.1] },
  },
  storage: {
    dataVolume: { totalBytes: 1_099_511_627_776, usedBytes: 549_755_813_888, freeBytes: 549_755_813_888, unavailableReason: null },
    catalogKnownBytes: null,
    catalogKnownBytesReason: "Catalog file sizes are not stored yet.",
  },
  libraries: {
    configured: 1,
    enabled: 1,
    byKind: { movie: 1, series: 0, mixed: 0 },
    catalog: { files: 1, items: 1, movies: 1, series: 0, mixed: 0 },
    unavailableReason: null,
    lastScanAt: "2026-08-25T00:00:00.000Z",
  },
  work: {
    queue: { queued: 0, downloading: 0, paused: 0, failed: 0 },
    queueUnavailableReason: null,
    playbackStarts: 0,
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
    vpnMounted: true,
  },
  recentIncidents: [],
  incidentsUnavailableReason: null,
  unavailable: [],
  transcoder: { ffmpegAvailable: true },
  network: { vpnCapabilityMounted: true },
};
