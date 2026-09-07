import React from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { NotificationProvider } from "../src/notifications";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const state = vi.hoisted(() => ({ queueShouldThrow: false }));
const apiMock = vi.hoisted(() => ({
  indexers: vi.fn(),
  createIndexer: vi.fn(),
  updateIndexer: vi.fn(),
  deleteIndexer: vi.fn(),
  testIndexer: vi.fn(),
  setIndexerEnabled: vi.fn(),
  metadataStatus: vi.fn(),
  configureMetadata: vi.fn(),
  searchMedia: vi.fn(),
  managedMedia: vi.fn(),
  managedMediaPage: vi.fn(),
  addManagedMedia: vi.fn(),
  managedReleases: vi.fn(),
  grabManagedRelease: vi.fn(),
  managedMediaDetail: vi.fn(),
  updateManagedMedia: vi.fn(),
  refreshManagedMedia: vi.fn(),
  managedEpisodes: vi.fn(),
  matchManagedMedia: vi.fn(),
  deleteManagedMedia: vi.fn(),
  catalogPage: vi.fn(),
  libraries: vi.fn(),
  createDownload: vi.fn(),
  plugins: vi.fn(),
  diagnostics: vi.fn(),
  events: vi.fn(),
  usenetConfiguration: vi.fn(),
  configureUsenet: vi.fn(),
  testUsenetServer: vi.fn(),
  torrentStatus: vi.fn(),
  configureTorrent: vi.fn(),
  vpnStatus: vi.fn(),
  vpnPreflight: vi.fn(),
  playbackAdmin: vi.fn(),
  updatePlaybackPolicy: vi.fn(),
  previewPlaybackDecision: vi.fn(),
  stopPlaybackSession: vi.fn(),
  browse: vi.fn(),
}));

vi.mock("../src/api", () => ({ api: apiMock }));
vi.mock("../src/admin/views", () => ({
  QueueView: () => {
    if (state.queueShouldThrow) throw new Error("broken queue renderer");
    return <div>Queue view</div>;
  },
  WantedView: ({ onSearchReleases }: { onSearchReleases?: (item: Record<string, unknown>) => void }) => (
    <div>
      Wanted view
      <button
        type="button"
        onClick={() => onSearchReleases?.({
          itemKey: "series-recovery:S02E03",
          kind: "series",
          id: "series-recovery",
          episodeKey: "S02E03",
          title: "Recovery Series S02E03",
          state: "missing",
          failureDetail: null,
          recovery: { action: "search", label: "Search releases" },
        })}
      >
        Search releases
      </button>
    </div>
  ),
  HistoryView: () => <div>History view</div>,
}));

import { AcquisitionControl, AutomationControl, DiscoveryView, ManagedTitlesControl, MetadataControl, PlaybackControl } from "../src/shell/OperationsViews";
import { ReleaseSearchPage } from "../src/shell/ReleaseSearchPage";
import { LocalCatalogFiles } from "../src/shell/LocalCatalogFiles";

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

function mount(
  node: React.ReactElement,
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } }),
) {
  return render(
    <MantineProvider env="test"><NotificationProvider userId={null} isAdmin={false} navigate={() => {}}>
      <QueryClientProvider client={client}>{node}</QueryClientProvider>
    </NotificationProvider></MantineProvider>,
  );
}

const plugins = {
  plugins: [
    {
      manifest: {
        id: "dev.tantalar.plugin.series",
        version: "0.1.0",
        provides: ["dev.tantalar.capability.automation.series"],
      },
      state: "healthy",
      restartCount: 0,
    },
    {
      manifest: {
        id: "dev.tantalar.plugin.vpn-manager",
        version: "0.1.0",
        provides: ["dev.tantalar.capability.vpn-binding"],
      },
      state: "healthy",
      restartCount: 0,
    },
  ],
};

beforeEach(() => {
  state.queueShouldThrow = false;
  apiMock.indexers.mockReset().mockResolvedValue({ indexers: [] });
  apiMock.createIndexer.mockReset().mockResolvedValue({ indexer: { id: "idx-1" } });
  apiMock.updateIndexer.mockReset().mockResolvedValue({ indexer: { id: "idx-1" } });
  apiMock.deleteIndexer.mockReset().mockResolvedValue(undefined);
  apiMock.testIndexer.mockReset().mockResolvedValue({ ok: true });
  apiMock.setIndexerEnabled.mockReset().mockResolvedValue({});
  apiMock.metadataStatus.mockReset().mockResolvedValue({ provider: "tmdb", state: "ready", mode: "hosted", configured: true, directKeyConfigured: false, locale: "en-GB" });
  apiMock.configureMetadata.mockReset().mockResolvedValue({ provider: "tmdb", state: "ready", mode: "direct", configured: true, directKeyConfigured: true });
  apiMock.searchMedia.mockReset().mockResolvedValue({ candidates: [] });
  apiMock.managedMedia.mockReset().mockResolvedValue({ items: [] });
  apiMock.managedMediaPage.mockReset().mockImplementation(async () => { const result = await apiMock.managedMedia(); return { ...result, total: result.items.length, tags: [], facets: {} }; });
  apiMock.addManagedMedia.mockReset().mockResolvedValue({ item: { id: "movie-tmdb-9001", kind: "movie", title: "Fixture Movie", monitored: true }, created: true });
  apiMock.managedReleases.mockReset().mockResolvedValue({ item: { id: "movie-tmdb-9001", kind: "movie", title: "Fixture Movie", itemKey: "movie-tmdb-9001" }, releases: [], failures: [] });
  apiMock.grabManagedRelease.mockReset().mockResolvedValue({ download: { downloadId: "job-1", state: "downloading" } });
  apiMock.managedMediaDetail.mockReset().mockResolvedValue({ item: { id: "movie-tmdb-9001", kind: "movie", title: "Fixture Movie", monitored: true, episodes: [], manualFields: [] }, files: [] });
  apiMock.updateManagedMedia.mockReset().mockResolvedValue({ updated: true });
  apiMock.refreshManagedMedia.mockReset().mockResolvedValue({ refreshed: true });
  apiMock.managedEpisodes.mockReset().mockResolvedValue({ items: [], total: 0, facets: { season: [] } });
  apiMock.matchManagedMedia.mockReset().mockResolvedValue({ matched: true, itemKey: "movie-tmdb-9001" });
  apiMock.deleteManagedMedia.mockReset().mockResolvedValue(undefined);
  apiMock.catalogPage.mockReset().mockResolvedValue({ items: [], page: 1, pageSize: 200, total: 0, totalPages: 1 });
  apiMock.libraries.mockReset().mockResolvedValue({ libraries: [{ id: "movies", name: "Movies", rootPath: "/media/movies", kind: "movie", enabled: true, createdAt: "2026-08-26T00:00:00.000Z" }] });
  apiMock.createDownload.mockReset().mockResolvedValue({ created: true, job: { jobId: "job-1" } });
  apiMock.plugins.mockReset().mockResolvedValue(plugins);
  apiMock.diagnostics.mockReset().mockResolvedValue({
    plugins: [{ id: "dev.tantalar.plugin.serving", state: "healthy", version: "0.1.0", restarts: 0, provides: [] }],
    transcoder: { ffmpegAvailable: false },
  });
  apiMock.events.mockReset().mockResolvedValue({ events: [{ id: "event-1" }] });
  apiMock.usenetConfiguration.mockReset().mockResolvedValue({ ready: false, servers: [], downloadRoots: [], limitations: { starttls: false, par2: false, archives: false } });
  apiMock.configureUsenet.mockReset().mockResolvedValue({ ready: false, servers: [], downloadRoots: [], limitations: { starttls: false, par2: false, archives: false } });
  apiMock.testUsenetServer.mockReset().mockResolvedValue({ ok: true, server: {} });
  apiMock.torrentStatus.mockReset().mockResolvedValue({ ready: true, engine: "WebTorrent", dhtEnabled: false, publicDiscoveryEnabled: false, downloadRootsConfigured: true, activeJobs: 0, limitations: [] });
  apiMock.configureTorrent.mockReset().mockResolvedValue({ ready: true, engine: "WebTorrent", dhtEnabled: false, publicDiscoveryEnabled: false, downloadRootsConfigured: true, activeJobs: 0, limitations: [] });
  apiMock.vpnStatus.mockReset().mockResolvedValue({
    host: { platform: "darwin", tools: {}, tunDevice: false, netAdmin: false, supported: false, missing: ["linux-host"], checkedAt: "2026-08-25T00:00:00.000Z" },
    lifecycleControlReady: false,
    enforcementReady: false,
    openvpnApplySupported: false,
    profiles: [],
    bindings: [],
    checkedAt: "2026-08-25T00:00:00.000Z",
  });
  apiMock.vpnPreflight.mockReset().mockResolvedValue({ supported: false, missing: ["linux-host"] });
  const playbackPolicy = {
    preferDirectPlay: true,
    localBitrateKbps: 40_000,
    remoteBitrateKbps: 8_000,
    maxConcurrentTranscodes: 2,
    hardwareAcceleration: "auto",
    defaultAudioLanguage: "und",
    defaultSubtitleLanguage: "und",
    subtitleMode: "manual",
    transcodeCacheMaxBytes: 10 * 1024 * 1024 * 1024,
    idleTimeoutMs: 60_000,
  };
  apiMock.playbackAdmin.mockReset().mockResolvedValue({
    policy: playbackPolicy,
    sessions: [{
      sessionId: "session-1",
      fileId: "file-1",
      title: "Example movie",
      viewer: "lewis",
      client: "Firefox",
      network: "local",
      mode: "hls",
      state: "transcoding",
      positionMs: 65_000,
      durationMs: 120_000,
      startedAt: "2026-08-26T10:00:00.000Z",
      endedAt: null,
      closeReason: null,
      workerAlive: true,
      maxBitrateKbps: 40_000,
    }],
    probe: { available: true, version: "ffmpeg 8", hardwareAcceleration: ["videotoolbox"], encoders: ["libx264", "aac"] },
    storage: { contained: true, freeBytes: 100 * 1024 * 1024 * 1024, totalBytes: 200 * 1024 * 1024 * 1024 },
  });
  apiMock.updatePlaybackPolicy.mockReset().mockResolvedValue({ policy: playbackPolicy });
  apiMock.previewPlaybackDecision.mockReset().mockResolvedValue({ fileId: "file-1", title: "Example movie", mode: "hls", reason: "MKV requires HLS.", video: "hevc to H.264", audio: "dts to AAC", subtitles: "manual", maxBitrateKbps: 40_000, network: "local" });
  apiMock.stopPlaybackSession.mockReset().mockResolvedValue({ closed: true });
  apiMock.browse.mockReset().mockResolvedValue({ items: [{ fileId: "file-1", title: "Example movie" }], collections: [], continueWatching: [] });
});

afterEach(() => cleanup());

describe("Control operation views", () => {
  it("searches for a title, adds it, and hands release search to managed titles", async () => {
    const openManagedReleases = vi.fn();
    apiMock.searchMedia.mockResolvedValue({
      candidates: [{
        kind: "movie",
        externalId: "tmdb-9001",
        provider: "fixture",
        title: "Fixture Movie",
        year: 2024,
        overview: "Legal fixture metadata.",
      }],
    });
    mount(<DiscoveryView onOpenManagedReleases={openManagedReleases} />);
    fireEvent.change(screen.getByRole("textbox", { name: /Title/ }), { target: { value: "Fixture" } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    expect(await screen.findByText("Fixture Movie (2024)")).toBeTruthy();
    fireEvent.click(await screen.findByRole("button", { name: "Add" }));
    expect(await screen.findByRole("dialog", { name: "Add Fixture Movie" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Add & search" }));
    expect(await screen.findByText("Fixture Movie added.")).toBeTruthy();
    expect(apiMock.addManagedMedia).toHaveBeenCalledWith(
      expect.objectContaining({ externalId: "tmdb-9001" }),
      expect.objectContaining({ destinationLibraryId: "movies", qualityProfile: "uhd" }),
    );
    expect(openManagedReleases).toHaveBeenCalledWith(expect.objectContaining({ id: "movie-tmdb-9001" }));
  });

  it("shows a recoverable error when hosted metadata is unavailable", async () => {
    apiMock.searchMedia
      .mockRejectedValueOnce(Object.assign(new Error("TMDB is unavailable. Retry the connection."), { code: "unavailable" }))
      .mockResolvedValue({ candidates: [] });
    mount(<DiscoveryView />);
    fireEvent.change(screen.getByRole("textbox", { name: /Title/ }), { target: { value: "Fixture" } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    expect(await screen.findByText("TMDB is unavailable. Retry the connection.")).toBeTruthy();
    expect(screen.queryByText("No matching titles.")).toBeNull();
    expect(screen.queryByLabelText("TMDB API key")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(apiMock.searchMedia).toHaveBeenCalledTimes(2));
  });

  it("searches releases for managed media and grabs an accepted result", async () => {
    apiMock.managedMedia.mockResolvedValue({
      items: [{ id: "movie-tmdb-9001", kind: "movie", title: "Fixture Movie", year: 2024, monitored: true, acquisitionState: "wanted", qualityProfile: "hd" }],
    });
    apiMock.managedReleases.mockResolvedValue({
      item: { id: "movie-tmdb-9001", kind: "movie", title: "Fixture Movie", itemKey: "movie-tmdb-9001" },
      releases: [{
        releaseId: "opaque-release-id",
        title: "Fixture Movie 2024 1080p WEB-DL",
        kind: "torrent",
        sizeBytes: 4_294_967_296,
        publishedAt: "2026-08-26T12:00:00.000Z",
        indexerId: "Fixture Indexer",
        seeders: 30,
        quality: "1080p",
        accepted: true,
        reasons: [
          { code: "preferred_quality", message: "Quality matches the monitoring profile" },
          { code: "seeders_sufficient", message: "Enough seeders" },
          { code: "best_quality_available", message: "Best quality available (1080p)" },
        ],
        rank: 0,
      }, {
        releaseId: "opaque-rejected-id",
        title: "Fixture Movie 2024 720p WEB-DL",
        kind: "torrent",
        sizeBytes: 6_442_450_944,
        publishedAt: "2026-08-26T12:00:00.000Z",
        indexerId: "Fixture Indexer",
        seeders: 2,
        quality: "720p",
        accepted: false,
        reasons: [
          { code: "quality_below_profile", message: "Rejected: quality below the profile minimum" },
          { code: "seeders_below_minimum", message: "Rejected: too few seeders" },
        ],
        rank: null,
      }],
      failures: [],
    });

    const mounted = mount(<ManagedTitlesControl />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Search releases" }).matches(":disabled")).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Search releases" }));
    await waitFor(() => expect(window.location.hash).toBe("#/admin/media/releases/movie/movie-tmdb-9001"));
    mounted.unmount();
    mount(<ReleaseSearchPage target={{ kind: "movie", id: "movie-tmdb-9001" }} />);
    expect(await screen.findByRole("heading", { name: "Fixture Movie", level: 1 })).toBeTruthy();
    expect(await screen.findByText("Fixture Movie 2024 1080p WEB-DL")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Filter Quality: 1080p" })).toBeTruthy();
    expect(screen.getByText("4.0 GB")).toBeTruthy();
    expect(screen.getByText("Quality matches the monitoring profile")).toBeTruthy();
    expect(screen.getByText("Enough seeders")).toBeTruthy();
    expect(screen.getByText("Best quality available (1080p)")).toBeTruthy();
    expect(screen.getByText("Rejected: quality below the profile minimum")).toBeTruthy();
    expect(screen.getByText("Rejected: too few seeders")).toBeTruthy();
    fireEvent.click(screen.getAllByRole("button", { name: "Grab" }).find((button) => !(button as HTMLButtonElement).disabled)!);
    await waitFor(() => expect(apiMock.grabManagedRelease).toHaveBeenCalledWith("movie", "movie-tmdb-9001", "opaque-release-id", undefined, ""));
    expect((await screen.findByText("Release queued.")).closest("article")?.getAttribute("role")).toBe("status");
    apiMock.grabManagedRelease.mockRejectedValueOnce(new Error("The indexer could not provide the release file."));
    fireEvent.click(screen.getAllByRole("button", { name: "Grab" }).find((button) => !(button as HTMLButtonElement).disabled)!);
    const failure = await screen.findByText("The indexer could not provide the release file.");
    expect(failure.closest("article")?.getAttribute("role")).toBe("alert");
    expect(screen.queryAllByText("The indexer could not provide the release file.")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Dismiss Download failed" }));
    await waitFor(() => expect(screen.queryByText("The indexer could not provide the release file.")).toBeNull());
    fireEvent.change(screen.getByLabelText("Search indexers"), { target: { value: "custom release query" } });
    await waitFor(() => expect(apiMock.managedReleases).toHaveBeenLastCalledWith("movie", "movie-tmdb-9001", expect.any(AbortSignal), undefined, "custom release query"));
  });

  it("corrects a local file to a series without changing existing monitoring", async () => {
    apiMock.catalogPage.mockResolvedValue({ items: [{ fileId: "local-episode", path: "/Movies/Lanterns - S01E01 - Pilot.mkv", itemKey: "movie-lanterns", libraryId: "local" }], page: 1, total: 1, totalPages: 1 });
    apiMock.managedMedia.mockResolvedValue({ items: [{ id: "series-lanterns", kind: "series", provider: "tmdb", externalId: "123", title: "Lanterns", monitored: true }] });
    apiMock.searchMedia.mockResolvedValue({ candidates: [{ kind: "series", provider: "tmdb", externalId: "123", title: "Lanterns", year: 2026, overview: "Series overview" }] });
    mount(<LocalCatalogFiles />);
    const details = screen.getByText("Local files and identification").closest("details")!;
    details.open = true;
    fireEvent(details, new Event("toggle"));
    fireEvent.click(await screen.findByRole("button", { name: "Identify", exact: true }));
    expect((screen.getByLabelText("Media type") as HTMLSelectElement).value).toBe("series");
    fireEvent.click(await screen.findByRole("button", { name: "Use this series" }));
    await waitFor(() => expect(apiMock.matchManagedMedia).toHaveBeenCalledWith("series", "series-lanterns", "local-episode", "S01E01"));
    expect(apiMock.addManagedMedia).not.toHaveBeenCalled();
  });

  it("opens release search for the wanted series episode", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    apiMock.managedMedia.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return {
      items: [{
        id: "series-recovery",
        kind: "series",
        title: "Recovery Series",
        monitored: true,
        acquisitionState: "wanted",
        qualityProfile: "hd",
      }],
      };
    });
    apiMock.managedReleases.mockResolvedValue({
      item: {
        id: "series-recovery",
        kind: "series",
        title: "Recovery Series S02E03",
        itemKey: "series-recovery:S02E03",
      },
      releases: [],
      failures: [],
    });

    function RoutedAcquisition() {
      const [releaseTarget, setReleaseTarget] = React.useState<React.ComponentProps<typeof ManagedTitlesControl>["releaseTarget"]>(null);
      return (
        <>
          <AcquisitionControl adminId="admin-1" activeSection="downloads" onSearchManagedReleases={setReleaseTarget} />
          <ManagedTitlesControl releaseTarget={releaseTarget} onReleaseTargetOpened={() => setReleaseTarget(null)} />
        </>
      );
    }

    mount(<RoutedAcquisition />, client);
    fireEvent.click(screen.getByRole("tab", { name: "Wanted" }));
    fireEvent.click(await screen.findByRole("button", { name: "Search releases" }));

    await waitFor(() => expect(window.location.hash).toBe("#/admin/media/releases/series/series-recovery/S02E03"));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("edits managed metadata and matches an existing catalog file", async () => {
    const item = {
      id: "movie-tmdb-9001",
      kind: "movie" as const,
      title: "Fixture Movie",
      year: 2024,
      overview: "Provider overview.",
      monitored: true,
      destinationLibraryId: "movies",
      qualityProfile: "hd",
      minimumAvailability: "released",
      manualFields: [],
    };
    apiMock.managedMedia.mockResolvedValue({ items: [item] });
    apiMock.managedMediaDetail.mockResolvedValue({ item: { ...item, episodes: [] }, files: [] });
    apiMock.catalogPage.mockResolvedValue({
      items: [{ fileId: "file-1", libraryId: "movies", itemKey: "unmatched", path: "/media/movies/Fixture Movie.mkv", quality: "1080p", method: "existing", importedAt: "2026-08-26T00:00:00.000Z" }],
      page: 1,
      pageSize: 200,
      total: 1,
      totalPages: 1,
    });

    mount(<ManagedTitlesControl />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    const dialog = await screen.findByRole("dialog", { name: "Manage Fixture Movie" });
    fireEvent.change(within(dialog).getByRole("textbox", { name: /Title/ }), { target: { value: "Manual Fixture Movie" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(apiMock.updateManagedMedia).toHaveBeenCalledWith(
      "movie",
      "movie-tmdb-9001",
      expect.objectContaining({ title: "Manual Fixture Movie", qualityProfile: "hd" }),
    ));

    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Manage Fixture Movie" })).toBeNull());
    await waitFor(() => expect(screen.getByRole("button", { name: "Edit" }).matches(":disabled")).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.change(await screen.findByLabelText("Catalog file"), { target: { value: "file-1" } });
    fireEvent.click(screen.getByRole("button", { name: "Match file" }));
    await waitFor(() => expect(apiMock.matchManagedMedia).toHaveBeenCalledWith("movie", "movie-tmdb-9001", "file-1", undefined));

    fireEvent.click(screen.getByRole("button", { name: "Refresh metadata" }));
    await waitFor(() => expect(apiMock.refreshManagedMedia).toHaveBeenCalledWith("movie", "movie-tmdb-9001", undefined));
  });

  it("shows episode facts and requires an explicit reviewed refresh", async () => {
    const item = { id: "series-journey", kind: "series", title: "Journey", monitored: true, qualityProfile: "hd" };
    const episode = { episodeKey: "S01E01", title: "First steps", runtimeMinutes: 42, airDate: "2024-01-01", artworkUrl: "/still" };
    apiMock.managedMedia.mockResolvedValue({ items: [item] });
    apiMock.managedMediaDetail.mockResolvedValue({ item: { ...item, episodes: [episode], manualFields: [] }, files: [] });
    apiMock.managedEpisodes.mockResolvedValue({ items: [episode], total: 1, facets: { season: ["1"] } });
    const review = { token: "a".repeat(64), changes: [{ label: "S01E01", before: "First steps", after: "Provider correction" }] };
    apiMock.refreshManagedMedia.mockRejectedValueOnce(Object.assign(new Error("Review required"), { review }));
    mount(<ManagedTitlesControl />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    fireEvent.click(await screen.findByText("Episodes", { selector: "summary" }));
    expect(await screen.findByRole("img", { name: "First steps backdrop" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Refresh metadata" }));
    const region = await screen.findByRole("region", { name: "Review metadata changes" });
    expect(apiMock.refreshManagedMedia).toHaveBeenCalledTimes(1);
    expect(within(region).getByText("Current: First steps")).toBeTruthy();
    fireEvent.click(within(region).getByRole("button", { name: "Apply reviewed changes" }));
    await waitFor(() => expect(apiMock.refreshManagedMedia).toHaveBeenLastCalledWith("series", "series-journey", review.token));
    await waitFor(() => expect(screen.queryByRole("region", { name: "Review metadata changes" })).toBeNull());
  });

  it("shows hosted metadata state and supports a personal-key override", async () => {
    mount(<MetadataControl />);

    expect(await screen.findByText("Mode: Hosted")).toBeTruthy();
    expect(screen.getByText("Status: Ready")).toBeTruthy();
    expect(screen.getByText(/Hosted searches send the query and request IP address/i)).toBeTruthy();

    fireEvent.click(screen.getByText("Direct provider override"));
    fireEvent.change(screen.getByLabelText("Personal TMDB API key"), { target: { value: "personal-key" } });
    fireEvent.click(screen.getByRole("button", { name: "Use personal key" }));

    await waitFor(() => expect(apiMock.configureMetadata).toHaveBeenCalledWith("personal-key"));
    expect(await screen.findByText("Direct TMDB access enabled.")).toBeTruthy();
  });

  it("returns a direct metadata override to hosted access", async () => {
    apiMock.metadataStatus.mockResolvedValue({ provider: "tmdb", state: "ready", mode: "direct", configured: true, directKeyConfigured: true });
    apiMock.configureMetadata.mockResolvedValue({ provider: "tmdb", state: "ready", mode: "hosted", configured: true, directKeyConfigured: false });
    mount(<MetadataControl />);

    expect(await screen.findByText("Mode: Direct")).toBeTruthy();
    fireEvent.click(screen.getByText("Direct provider override"));
    fireEvent.click(screen.getByRole("button", { name: "Use hosted access" }));

    await waitFor(() => expect(apiMock.configureMetadata).toHaveBeenCalledWith(""));
    expect(await screen.findByText("Hosted metadata access enabled.")).toBeTruthy();
  });

  it("makes indexer setup discoverable without opening a wall of fields", async () => {
    mount(<AcquisitionControl adminId="admin-1" />);
    expect(await screen.findByText("No indexers configured.")).toBeTruthy();
    const addButton = screen.getByRole("button", { name: "Add indexer" });
    expect(addButton).toBeTruthy();
    expect(screen.queryByLabelText("API key")).toBeNull();
    fireEvent.click(addButton);
    expect(await screen.findByRole("dialog", { name: "Add indexer" })).toBeTruthy();
    expect(screen.getByLabelText("API key")).toBeTruthy();
  });

  it("uses a compact indexer row and renders a successful test as success", async () => {
    apiMock.indexers.mockResolvedValue({
      indexers: [{
        id: "idx-1",
        name: "Nzb.su",
        protocol: "newznab",
        baseUrl: "https://api.nzb.su",
        hasApiKey: true,
        priority: 0,
        enabled: true,
        limits: { maxSearchesPerWindow: 30, windowMs: 60_000, retentionDays: 30 },
      }],
    });
    mount(<AcquisitionControl adminId="admin-1" />);

    const row = await screen.findByTestId("indexer-idx-1");
    expect(row.className).toContain("tantalar-explorer__item");
    fireEvent.click(screen.getByRole("button", { name: "Test" }));
    expect(await screen.findByText("Nzb.su is reachable.")).toBeTruthy();
    expect(screen.getByText("Nzb.su is reachable.").closest("article")?.getAttribute("data-severity")).toBe("success");
  });

  it("edits and removes an indexer through the protected editor", async () => {
    const indexer = {
      id: "idx-1",
      name: "Nzb.su",
      protocol: "newznab" as const,
      baseUrl: "https://api.nzb.su",
      hasApiKey: true,
      priority: 0,
      enabled: true,
      searchModes: { interactive: true, automatic: true },
      categories: [],
      tags: [],
      limits: { maxSearchesPerWindow: 30, windowMs: 60_000, retentionDays: 30 },
    };
    apiMock.indexers.mockResolvedValue({ indexers: [indexer] });
    mount(<AcquisitionControl adminId="admin-1" />);

    await screen.findByTestId("indexer-idx-1");
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect(await screen.findByRole("dialog", { name: "Edit Nzb.su" })).toBeTruthy();
    expect(screen.getByText("Leave blank to keep the saved key.")).toBeTruthy();
    fireEvent.change(screen.getByRole("textbox", { name: /Name/ }), { target: { value: "Nzb edited" } });
    fireEvent.click(screen.getByRole("button", { name: "Save indexer" }));
    await waitFor(() => expect(apiMock.updateIndexer).toHaveBeenCalledWith(
      "idx-1",
      expect.objectContaining({ name: "Nzb edited", apiKey: "", priority: 0 }),
    ));

    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    expect(screen.getByText("This removes the saved indexer and API key. It does not delete downloaded media.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Confirm remove" }));
    await waitFor(() => expect(apiMock.deleteIndexer).toHaveBeenCalledWith("idx-1"));
  });

  it("keeps a broken download renderer inside Acquisition", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    state.queueShouldThrow = true;
    mount(<AcquisitionControl adminId="admin-1" />);
    await screen.findByText("No indexers configured.");
    fireEvent.click(screen.getByRole("tab", { name: "Downloads" }));
    expect(await screen.findByText("This acquisition section could not be displayed")).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Indexers" })).toBeTruthy();
    log.mockRestore();
  });

  it("separates process health from functional downloader readiness", async () => {
    mount(<AcquisitionControl adminId="admin-1" activeSection="vpn" />);
    expect(await screen.findByText("Process running")).toBeTruthy();
    expect(screen.getByText("Enforcement not ready")).toBeTruthy();
    expect(screen.getByText(/does not create a tunnel or enforce a network kill switch/i)).toBeTruthy();
    expect(await screen.findByText("Host enforcement")).toBeTruthy();
    expect(screen.getByText("Blocked")).toBeTruthy();

    fireEvent.click(screen.getByRole("tab", { name: "Torrents" }));
    expect(await screen.findByText("Not mounted")).toBeTruthy();
    expect(screen.getByText(/Public discovery and DHT remain disabled/i)).toBeTruthy();
    expect(screen.getByText("Enable this module in the host configuration, then restart Tantalar.")).toBeTruthy();
  });

  it("shows VPN preflight failures instead of leaving an unhandled rejection", async () => {
    apiMock.vpnPreflight.mockRejectedValueOnce(new Error("VPN preflight unavailable"));
    mount(<AcquisitionControl adminId="admin-1" activeSection="vpn" />);
    fireEvent.click(await screen.findByRole("button", { name: "Run preflight again" }));
    expect(await screen.findByText("VPN preflight unavailable")).toBeTruthy();
  });

  it("keeps Usenet server setup behind an explicit action and accepts a saved password", async () => {
    apiMock.usenetConfiguration.mockResolvedValue({
      ready: true,
      servers: [{ id: "existing", name: "Existing", host: "news.existing.test", port: 563, tls: "implicit", username: "reader", priority: 0, connections: 2, hasPassword: true, passwordSource: "stored" }],
      downloadRoots: ["/srv/usenet"],
      limitations: { starttls: false, par2: false, archives: false },
    });
    apiMock.plugins.mockResolvedValue({
      plugins: [{
        manifest: { id: "dev.tantalar.plugin.usenet-native", version: "0.1.0", provides: ["dev.tantalar.capability.usenet.engine"] },
        state: "healthy",
        restartCount: 0,
      }],
    });
    mount(<AcquisitionControl adminId="admin-1" activeSection="usenet" />);
    expect(await screen.findByRole("button", { name: "Add server" })).toBeTruthy();
    expect(screen.queryByLabelText(/^Host/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Add server" }));
    fireEvent.change(await screen.findByLabelText(/^Host/), { target: { value: "news.example.test" } });
    fireEvent.change(screen.getByLabelText(/^Username/), { target: { value: "reader" } });
    fireEvent.change(document.getElementById("usenet-server-password")!, { target: { value: "usenet-password" } });
    fireEvent.change(document.getElementById("usenet-server-password-confirm")!, { target: { value: "usenet-password" } });
    fireEvent.click(screen.getByRole("button", { name: "Test connection" }));
    expect(apiMock.testUsenetServer).toHaveBeenCalledWith(expect.objectContaining({
      host: "news.example.test",
      password: "usenet-password",
      confirmPassword: "usenet-password",
      tls: "implicit",
    }));
    expect(await screen.findByText("Server connection succeeded.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm remove" }));
    await waitFor(() => expect(apiMock.configureUsenet).toHaveBeenCalledWith([]));
  });

  it("shows how to recover when Usenet has no download root", async () => {
    apiMock.plugins.mockResolvedValue({
      plugins: [{
        manifest: { id: "dev.tantalar.plugin.usenet-native", version: "0.1.0", provides: ["dev.tantalar.capability.usenet.engine"] },
        state: "healthy",
        restartCount: 0,
      }],
    });
    mount(<AcquisitionControl adminId="admin-1" activeSection="usenet" />);

    expect(await screen.findByText("Needs setup")).toBeTruthy();
    expect(screen.getByText("No download root is configured. Add a download root to the Usenet host configuration, then restart Tantalar.")).toBeTruthy();
  });

  it("keeps manual native job creation behind an explicit action", async () => {
    apiMock.plugins.mockResolvedValue({
      plugins: [{
        manifest: { id: "dev.tantalar.plugin.torrent-native", version: "0.1.0", provides: ["dev.tantalar.capability.download-client"] },
        state: "healthy",
        restartCount: 0,
      }],
    });
    mount(<AcquisitionControl adminId="admin-1" activeSection="torrent" />);
    expect(await screen.findByRole("button", { name: "Add Torrent job" })).toBeTruthy();
    expect(screen.queryByLabelText(/^Absolute download root/)).toBeNull();
    fireEvent.click(await screen.findByRole("button", { name: "Set download root" }));
    fireEvent.change(screen.getByLabelText(/^Absolute download root/), { target: { value: "/srv/tantalar/downloads" } });
    fireEvent.click(screen.getByRole("button", { name: "Save root" }));
    expect(apiMock.configureTorrent).toHaveBeenCalledWith(["/srv/tantalar/downloads"]);
    expect(screen.queryByLabelText(/^Title/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Add Torrent job" }));
    expect(await screen.findByRole("button", { name: "Cancel" })).toBeTruthy();
    fireEvent.change(await screen.findByLabelText(/^Title/), { target: { value: "Legal fixture" } });
    fireEvent.change(screen.getByLabelText(/^Magnet link, torrent URL or server path/), { target: { value: "magnet:?xt=urn:btih:0123456789012345678901234567890123456789" } });
    fireEvent.click(screen.getByRole("button", { name: "Add to Downloads" }));
    expect(apiMock.createDownload).toHaveBeenCalledWith(expect.objectContaining({ kind: "torrent", title: "Legal fixture" }));
    expect(await screen.findByText("Job added to Downloads.")).toBeTruthy();
  });

  it("manages live playback sessions, durable policy and decision previews", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    mount(<PlaybackControl />);
    expect((await screen.findAllByText("Example movie")).length).toBeGreaterThan(0);
    expect(screen.getByText("lewis")).toBeTruthy();
    expect(screen.getByText("1 active sessions")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Stop transcode" }));
    await waitFor(() => expect(apiMock.stopPlaybackSession).toHaveBeenCalledWith("session-1", true));

    fireEvent.change(screen.getByLabelText("Maximum concurrent transcodes"), { target: { value: "3" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply policy" }));
    await waitFor(() => expect(apiMock.updatePlaybackPolicy).toHaveBeenCalledWith(expect.objectContaining({ maxConcurrentTranscodes: 3 })));

    fireEvent.click(screen.getByRole("button", { name: "Check playback" }));
    expect(await screen.findByText("MKV requires HLS.")).toBeTruthy();
    expect(apiMock.previewPlaybackDecision).toHaveBeenCalledWith("file-1", "local");
    confirm.mockRestore();
  });

  it("defines Automation as rules and scheduled work instead of activity", async () => {
    mount(<AutomationControl />);
    expect(await screen.findByText("Automation means rules and scheduled work")).toBeTruthy();
    expect(screen.getByText("Series monitoring")).toBeTruthy();
    expect(screen.getByText("Scheduled work")).toBeTruthy();
    expect(screen.queryByText("Activity & Trajectory")).toBeNull();
  });
});
