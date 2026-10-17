import React from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("../src/api", () => ({
  api: {
    me: vi.fn().mockResolvedValue({ user: { id: "admin-1", username: "admin", role: "admin" } }),
    userProfile: vi.fn().mockResolvedValue({ user: { id: "admin-1", username: "admin", role: "admin", avatar: { preset: "smile" } } }),
    history: vi.fn().mockResolvedValue({ history: [] }),
    logout: vi.fn().mockResolvedValue(undefined),
    version: vi.fn().mockResolvedValue({ version: "0.0.1-alpha.0", label: "0.0.1 Alpha" }),
    reportClientIncident: vi.fn().mockResolvedValue({ accepted: true }),
    bootstrapStatus: vi.fn().mockResolvedValue({ required: false }),
    onboarding: vi.fn().mockResolvedValue({ steps: {}, complete: true }),
    diagnostics: vi.fn(),
  },
}));

vi.mock("../src/theme/engine", () => ({
  ThemeEngineProvider: ({ children }: { children: React.ReactNode }) => children,
}));

vi.mock("../src/pages/ProductPages", () => ({
  HomePage: () => <div data-testid="home-page">Media home</div>,
  CalendarPage: () => <div data-testid="calendar-page">Upcoming</div>,
  CatalogPage: ({ heading }: { heading: string }) => <div>{heading}</div>,
}));
vi.mock("../src/pages/MediaActivityPage", () => ({
  MediaActivityPage: ({ onWatch }: { onWatch: (fileId: string) => void }) => (
    <div data-testid="activity-page">
      <h1>My activity</h1>
      <button type="button" onClick={() => onWatch("activity-fixture")}>Resume fixture</button>
    </div>
  ),
}));

vi.mock("../src/pages/PlayerPage", () => ({ PlayerPage: () => <div>Player</div> }));
vi.mock("../src/shell/OperationsViews", () => ({
  AcquisitionControl: ({ activeSection }: { activeSection?: string }) => <div>Acquisition view: {activeSection}</div>,
  DiscoveryView: () => <div data-testid="discover-page">Discover titles</div>,
  ManagedTitlesControl: () => <div>Managed titles view</div>,
  MetadataControl: () => <div>Metadata control</div>,
  PlaybackControl: () => <div>Playback control</div>,
  AutomationControl: () => <div>Automation control</div>,
}));
vi.mock("../src/pages/SetupPage", () => ({
  SetupPage: ({ bootstrapRequired }: { bootstrapRequired?: boolean }) => (
    <div data-testid="setup-page">Setup {bootstrapRequired ? "bootstrap" : "resume"}</div>
  ),
}));
vi.mock("../src/pages/SignInPage", () => ({
  SignInPage: ({ onSignedIn }: { onSignedIn: () => void }) => (
    <button type="button" onClick={onSignedIn}>Sign in</button>
  ),
}));

vi.mock("../src/admin/views", () => ({
  QueueView: () => <div>Queue view</div>,
  WantedView: () => <div>Wanted view</div>,
  HistoryView: () => <div>History view</div>,
  PluginsView: () => <div>Extensions view</div>,
  UsersView: () => <div>Users view</div>,
  AuditView: () => <div>Audit view</div>,
  ActivityView: () => <div>Automation view</div>,
  SettingsView: () => <div>Appearance view</div>,
  DensityToggle: () => <div>Density control</div>,
  SystemHealthView: () => <div>Health view</div>,
}));

import { App, hashFor, parseHash } from "../src/App";
import { api } from "../src/api";
import { ErrorBoundary } from "../src/shell/ErrorBoundary";
import { diagnosticsFixture } from "./diagnostics-fixture";

let desktopViewport = false;
const navigationStorage = new Map<string, string>();

function renderApp() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MantineProvider>
      <QueryClientProvider client={client}><App /></QueryClientProvider>
    </MantineProvider>,
  );
}

beforeAll(() => {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: (query: string) => ({
      matches: desktopViewport && query.includes("min-width"),
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
  desktopViewport = false;
  navigationStorage.clear();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => navigationStorage.get(key) ?? null,
    setItem: (key: string, value: string) => navigationStorage.set(key, value),
    removeItem: (key: string) => navigationStorage.delete(key),
    clear: () => navigationStorage.clear(),
    key: (index: number) => [...navigationStorage.keys()][index] ?? null,
    get length() { return navigationStorage.size; },
  } satisfies Storage);
  vi.mocked(api.me).mockReset().mockResolvedValue({ user: { id: "admin-1", username: "admin", role: "admin" } });
  vi.mocked(api.bootstrapStatus).mockReset().mockResolvedValue({ required: false });
  vi.mocked(api.onboarding).mockReset().mockResolvedValue({ steps: {}, complete: true });
  vi.mocked(api.diagnostics).mockReset().mockResolvedValue(diagnosticsFixture);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  window.location.hash = "";
});

describe("Media and Control shell", () => {
  it("keeps account actions beside compact notifications in the navigation footer", async () => {
    desktopViewport = true;
    renderApp();
    await screen.findByTestId("home-page");
    const brand = within(screen.getByRole("banner")).getByRole("link", { name: "Tantalar home" });
    expect(brand.getAttribute("href")).toBe("#/");
    expect(within(brand).getByRole("img", { name: "Tantalar" })).toBeTruthy();
    const signOut = screen.getByRole("button", { name: "Sign out" });
    const footer = signOut.closest(".tantalar-account-footer")! as HTMLElement;
    expect(within(footer).getByRole("button", { name: "Notifications" })).toBeTruthy();
    expect(within(footer).getByRole("button", { name: "Edit profile for admin" })).toBeTruthy();
    expect(within(screen.getByRole("banner")).queryByRole("button", { name: "Sign out" })).toBeNull();
    fireEvent.click(signOut);
    const dialog = await screen.findByRole("dialog", { name: "Sign out of Tantalar?" });
    expect(api.logout).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(api.logout).not.toHaveBeenCalled();
    fireEvent.click(signOut);
    fireEvent.click(within(await screen.findByRole("dialog", { name: "Sign out of Tantalar?" })).getByRole("button", { name: "Sign out", exact: true }));
    await waitFor(() => expect(api.logout).toHaveBeenCalled());
    expect(await screen.findByRole("button", { name: "Sign in" })).toBeTruthy();
  });
  it("maps stable media and nested Control hash routes", () => {
    expect(parseHash("#/home")).toEqual({ name: "home" });
    expect(parseHash("#/discover")).toEqual({ name: "admin", area: "media", child: "discover" });
    expect(parseHash("#/admin/media/discover")).toEqual({ name: "admin", area: "media", child: "discover" });
    expect(parseHash("#/admin/media/managed")).toEqual({ name: "admin", area: "media", child: "managed" });
    expect(parseHash("#/admin/acquisition")).toEqual({ name: "admin", area: "acquisition" });
    expect(parseHash("#/admin/acquisition/torrent")).toEqual({ name: "admin", area: "acquisition", child: "torrent" });
    expect(parseHash("#/admin/system/appearance")).toEqual({ name: "admin", area: "system", child: "appearance" });
    expect(parseHash("#/admin/audit")).toEqual({ name: "admin", area: "audit" });
    expect(parseHash("#/admin/audit/trajectories")).toEqual({ name: "admin", area: "audit", child: "trace" });
    expect(parseHash("#/admin/acquisition/not-real")).toEqual({ name: "admin", area: "acquisition" });
    expect(parseHash("#/admin/not-a-page")).toEqual({ name: "admin", area: "overview" });
    expect(parseHash("#/settings")).toEqual({ name: "admin", area: "system" });
    expect(hashFor({ name: "admin", area: "extensions" })).toBe("/admin/extensions");
    expect(hashFor({ name: "admin", area: "media", child: "discover" })).toBe("/admin/media/discover");
    expect(hashFor({ name: "admin", area: "audit", child: "trace" })).toBe("/admin/audit/trace");
  });

  it("keeps personal activity in Media and administration in Control", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/v1/onboarding")) {
        return new Response(JSON.stringify({ complete: true }), { status: 200 });
      }
      if (url.endsWith("/api/v1/version")) {
        return new Response(JSON.stringify({ version: "0.0.1-alpha.0", label: "0.0.1 Alpha" }), { status: 200 });
      }
      return new Response(null, { status: 404 });
    }));

    renderApp();
    await screen.findByTestId("home-page");

    expect(screen.queryByTestId("nav-settings")).toBeNull();
    expect(screen.queryByTestId("nav-discover")).toBeNull();
    expect(screen.getByTestId("nav-admin").textContent).toContain("Control");
    await screen.findByText("0.0.1 Alpha");

    fireEvent.click(screen.getByTestId("nav-activity"));
    await screen.findByTestId("activity-page");
    expect(screen.getByRole("heading", { name: "My activity" })).toBeTruthy();
    expect(screen.queryByText("Queue view")).toBeNull();
    expect(screen.queryByText("Automation view")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Resume fixture" }));
    await screen.findByText("Player");

    fireEvent.click(screen.getByTestId("nav-admin"));
    await screen.findByTestId("control-page-overview");
    expect(screen.getByRole("navigation", { name: "Control navigation" })).toBeTruthy();
    for (const area of ["overview", "media", "acquisition", "extensions", "people", "audit", "system"]) {
      expect(screen.getByTestId(`control-nav-${area}`)).toBeTruthy();
    }

    fireEvent.click(screen.getByTestId("control-nav-media"));
    await screen.findByTestId("discover-page");
    expect(window.location.hash).toBe("#/admin/media/discover");
    expect(screen.getByTestId("control-nav-media-discover")).toBeTruthy();
    expect(screen.getByTestId("control-nav-media-metadata")).toBeTruthy();

    fireEvent.click(screen.getByTestId("control-nav-media-managed"));
    await screen.findByText("Managed titles view");
    expect(window.location.hash).toBe("#/admin/media/managed");

    fireEvent.click(screen.getByTestId("control-nav-media-metadata"));
    await screen.findByText("Metadata control");
    expect(window.location.hash).toBe("#/admin/media/metadata");

    fireEvent.click(screen.getByTestId("control-nav-acquisition"));
    await screen.findByTestId("control-page-acquisition");
    expect(screen.getByText("Acquisition view: indexers")).toBeTruthy();
    expect(window.location.hash).toBe("#/admin/acquisition/indexers");
    expect(screen.getByTestId("control-nav-acquisition-torrent")).toBeTruthy();

    fireEvent.click(screen.getByTestId("control-nav-acquisition-torrent"));
    await screen.findByText("Acquisition view: torrent");
    expect(window.location.hash).toBe("#/admin/acquisition/torrent");

    fireEvent.click(screen.getByTestId("control-nav-audit"));
    await screen.findByTestId("control-page-audit");
    expect(screen.getByText("Audit view")).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Audit log" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Trace" })).toBeTruthy();
    expect(window.location.hash).toBe("#/admin/audit/log");

    fireEvent.click(screen.getByRole("tab", { name: "Trace" }));
    expect(window.location.hash).toBe("#/admin/audit/trace");

    fireEvent.click(screen.getByTestId("back-to-media"));
    await screen.findByTestId("home-page");
  });

  it("keeps Discover inside administrator-only Control", async () => {
    vi.mocked(api.me).mockResolvedValue({ user: { id: "viewer-1", role: "viewer" } });
    window.location.hash = "#/admin/media/discover";

    renderApp();

    expect(await screen.findByRole("heading", { name: "Administrator access required" })).toBeTruthy();
    expect(screen.getByText("Control is only available to administrator accounts.")).toBeTruthy();
    expect(screen.queryByTestId("nav-discover")).toBeNull();
  });

  it("redirects the old Discover deep link into Control", async () => {
    window.location.hash = "#/discover";
    renderApp();

    await screen.findByTestId("discover-page");
    await waitFor(() => expect(window.location.hash).toBe("#/admin/media/discover"));
  });

  it("redirects the old audit deep link to the canonical Trace route", async () => {
    window.location.hash = "#/admin/audit/trajectories";
    renderApp();

    await screen.findByRole("tab", { name: "Trace" });
    await waitFor(() => expect(window.location.hash).toBe("#/admin/audit/trace"));
  });

  it("resumes incomplete onboarding after an existing administrator signs in", async () => {
    vi.mocked(api.me)
      .mockReset()
      .mockResolvedValueOnce({ user: null })
      .mockResolvedValue({ user: { id: "admin-1", role: "admin" } });
    vi.mocked(api.onboarding).mockResolvedValue({
      steps: { libraries: { status: "pending" } },
      complete: false,
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 404 })));

    renderApp();

    const signIn = await screen.findByRole("button", { name: "Sign in" });
    expect(api.onboarding).not.toHaveBeenCalled();

    fireEvent.click(signIn);

    expect((await screen.findByTestId("setup-page")).textContent).toContain("Setup resume");
    expect(api.me).toHaveBeenCalledTimes(2);
    expect(api.onboarding).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("home-page")).toBeNull();
  });

  it("persists the desktop icon rail and sends collapsed groups to their main route", async () => {
    desktopViewport = true;
    renderApp();
    await screen.findByTestId("home-page");

    const initialHash = window.location.hash;
    const navigationHeader = document.querySelector(".tantalar-nav-header");
    const firstMediaLink = screen.getByTestId("nav-home");
    expect(navigationHeader).toBeTruthy();
    expect(Boolean(navigationHeader!.compareDocumentPosition(firstMediaLink) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Collapse navigation" }));
    expect(window.location.hash).toBe(initialHash);
    expect(localStorage.getItem("tantalar.navigation.collapsed.admin-1")).toBe("true");
    expect(screen.getByRole("button", { name: "Expand navigation" })).toBeTruthy();
    expect(document.querySelector(".tantalar-nav-header")).toBe(navigationHeader);
    expect(screen.getByTestId("nav-home").textContent).toBe("");

    fireEvent.click(screen.getByTestId("nav-admin"));
    await screen.findByTestId("control-page-overview");
    fireEvent.click(screen.getByTestId("control-nav-acquisition"));
    expect(window.location.hash).toBe("#/admin/acquisition");
    expect(screen.queryByTestId("control-nav-acquisition-torrent")).toBeNull();

    cleanup();
    renderApp();
    await screen.findByTestId("control-page-acquisition");
    expect(screen.getByRole("button", { name: "Expand navigation" })).toBeTruthy();

    cleanup();
    vi.mocked(api.me).mockResolvedValue({ user: { id: "admin-2", role: "admin" } });
    renderApp();
    await screen.findByTestId("control-page-acquisition");
    expect(screen.getByRole("button", { name: "Collapse navigation" })).toBeTruthy();
  });

  it("keeps the mobile drawer expanded even when the desktop preference is collapsed", async () => {
    localStorage.setItem("tantalar.navigation.collapsed.admin-1", "true");
    renderApp();
    await screen.findByTestId("home-page");

    expect(screen.queryByRole("button", { name: "Expand navigation" })).toBeNull();
    expect(screen.getByTestId("nav-home").textContent).toContain("Home");
    const menu = screen.getByRole("button", { name: "Navigation menu" });
    expect(menu.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(menu);
    expect(menu.getAttribute("aria-expanded")).toBe("true");
  });
});

describe("ErrorBoundary", () => {
  it("offers a recovery action without exposing error details", () => {
    let shouldFail = true;
    const Broken = () => {
      if (shouldFail) throw new Error("private stack detail");
      return <p>Recovered</p>;
    };
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    render(
      <ErrorBoundary onReset={() => { shouldFail = false; }}>
        <Broken />
      </ErrorBoundary>,
    );

    expect(screen.getByRole("alert").textContent).not.toContain("private stack detail");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(screen.getByText("Recovered")).toBeTruthy();
  });
});
