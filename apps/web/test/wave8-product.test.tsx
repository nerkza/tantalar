/**
 * Wave 8 unit tests: product shell navigation, Home/Catalog/Calendar states,
 * Settings page sections (role gating, human-readable theme labels, indexer
 * and library wiring against mocked fetch).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MantineProvider } from "@mantine/core";
import React from "react";

// ---- api mock -------------------------------------------------------------------

type Handler = (path: string, init?: RequestInit) => { status: number; body: unknown } | undefined;
const routes: Array<Handler> = [];

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// jsdom fetch mock routed through the handler table.
vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const path = String(input);
  for (const h of routes) {
    const res = h(path, init);
    if (res) return jsonResponse(res.status, res.body);
  }
  return jsonResponse(404, { error: `no route: ${path}` });
}));

const { HomePage, CatalogPage, CalendarPage } = await import("../src/pages/ProductPages.js");
const { SettingsPage: RawSettingsPage } = await import("../src/pages/SettingsPage.js");
const { TOKEN_LABELS } = await import("../src/theme/tokens.js");
const { ThemeEngineProvider } = await import("../src/theme/engine.js");

/** SettingsPage needs the theme context; wrap it the way App does. */
function SettingsPage(props: { adminId: string | null; isAdmin: boolean }): React.ReactElement {
  return (
    <ThemeEngineProvider adminId={props.adminId}>
      <RawSettingsPage {...props} />
    </ThemeEngineProvider>
  );
}

// Mantine needs matchMedia in jsdom.
if (!window.matchMedia) {
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
}

function renderUi(node: React.ReactElement): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <MantineProvider defaultColorScheme="dark">
      <QueryClientProvider client={qc}>{node}</QueryClientProvider>
    </MantineProvider>,
  );
}

const BROWSE = {
  items: [
    { fileId: "f-ep1", itemKey: "show/s01e01", title: "Show E1", kind: "series", libraryId: "l1" },
    { fileId: "f-mov", itemKey: "mov/1", title: "A Movie", kind: "movie", libraryId: "l1" },
  ],
  collections: [],
  continueWatching: [{ fileId: "f-ep1", positionMs: 30_000, durationMs: 60_000 }],
};

function seedProductRoutes(overrides: Record<string, () => unknown> = {}): void {
  routes.push((path, init) => {
    const method = init?.method ?? "GET";
    if (path === "/api/v1/library") return { status: 200, body: BROWSE };
    if (path.startsWith("/api/v1/libraries")) {
      return {
        status: 200,
        body: {
          libraries: [
            { id: "lib-1", name: "Movies", rootPath: "/media/movies", kind: "movie", enabled: true, createdAt: "2026-01-01T00:00:00Z" },
          ],
        },
      };
    }
    if (path === "/api/v1/indexers") {
      return {
        status: 200,
        body: {
          indexers: [
            { id: "ix-1", name: "Fixture", protocol: "torznab", baseUrl: "http://fixture/api", hasApiKey: true, priority: 10, enabled: true, limits: { maxSearchesPerWindow: 5, windowMs: 60_000, retentionDays: 100 } },
          ],
        },
      };
    }
    if (path === "/api/v1/users") {
      return { status: 200, body: { users: [{ id: "u1", username: "admin", role: "admin", createdAt: "" }] } };
    }
    if (path === "/api/v1/plugins") {
      return { status: 200, body: { plugins: [] } };
    }
    if (path === "/api/v1/system/health") {
      return { status: 200, body: { ready: true, plugins: [], eventCount: 0 } };
    }
    if (path.includes("/capabilities/") && path.endsWith("/calendar")) {
      if (overrides["calendar"]) {
        const body = overrides["calendar"]();
        if (body === null) return jsonResponse(500, { error: "capability unavailable" });
        return { status: 200, body };
      }
      return { status: 200, body: { result: { upcoming: [{ itemKey: "k", kind: "series", title: "Upcoming Show", date: "2099-01-01" }] } } };
    }
    if (path === "/api/v1/catalog") {
      return { status: 200, body: { items: overrides["catalog"]?.() ?? [] } };
    }
    if (path === "/api/v1/themes") return { status: 200, body: { themes: [] } };
    if (/\/ui-preferences$/.test(path)) return { status: 200, body: { preferences: {} } };
    if (/\/resume$/.test(path)) return { status: 200, body: { resumePoint: null } };
    return undefined;
  });
}

beforeEach(() => {
  routes.length = 0;
});
afterEach(() => {
  cleanup();
});

describe("Home page", () => {
  it("renders continue watching with progress and library rows", async () => {
    seedProductRoutes();
    renderUi(<HomePage onWatch={() => undefined} />);
    await waitFor(() => expect(screen.getByTestId("continue-f-ep1")).toBeTruthy());
    expect(screen.getByText(/50% watched/)).toBeTruthy();
    expect(screen.getByTestId("home-item-f-mov")).toBeTruthy();
  });

  it("shows a truthful empty state when nothing is in progress or present", async () => {
    routes.push((path) => {
      if (path === "/api/v1/library") {
        return { status: 200, body: { items: [], collections: [], continueWatching: [] } };
      }
      return undefined;
    });
    renderUi(<HomePage onWatch={() => undefined} />);
    await waitFor(() => expect(screen.getByText(/Nothing in progress/i)).toBeTruthy());
    expect(screen.getByText(/library is empty/i)).toBeTruthy();
  });
});

describe("Catalog page (Movies / Series)", () => {
  it("filters by kind and search text", async () => {
    seedProductRoutes();
    renderUi(<CatalogPage kindFilter="series" heading="Series" onWatch={() => undefined} />);
    await waitFor(() => expect(screen.getByTestId("catalog-f-ep1")).toBeTruthy());
    expect(document.querySelector('[data-testid="catalog-f-mov"]')).toBeNull();

    // Search narrows to no matches with a truthful message.
    const input = screen.getByLabelText("Search Series") as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
    setter.call(input, "zzz-nothing");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await waitFor(() => expect(screen.getByText(/No series match/i)).toBeTruthy());
  });
});

describe("Calendar page", () => {
  it("lists upcoming monitored releases via the importer capability", async () => {
    seedProductRoutes();
    renderUi(<CalendarPage />);
    await waitFor(() => expect(screen.getByText("Upcoming Show")).toBeTruthy());
  });

  it("degrades truthfully when the calendar capability is unavailable", async () => {
    seedProductRoutes({ calendar: () => null });
    renderUi(<CalendarPage />);
    // Capability invoke fails → truthful degraded copy, not an error wall.
    await waitFor(() =>
      expect(screen.getByText(/No monitored media is registered/)).toBeTruthy(),
    );
  });
});

describe("Settings page", () => {
  it("shows admin-gated notice to viewers instead of hidden controls", async () => {
    seedProductRoutes();
    renderUi(<SettingsPage adminId="u1" isAdmin={false} />);
    await waitFor(() => expect(screen.getByTestId("settings-page")).toBeTruthy());
    // Switch to Libraries tab.
    const tab = [...document.querySelectorAll('[role="tab"]')].find((t) => t.textContent === "Libraries") as HTMLElement;
    tab.click();
    await waitFor(() => expect(screen.getAllByText(/Administrator access required/).length).toBeGreaterThan(0));
  });

  it("exposes theme scheme with human labels only — never raw token names", async () => {
    seedProductRoutes();
    renderUi(<SettingsPage adminId="u1" isAdmin={true} />);
    await waitFor(() => expect(screen.getByTestId("scheme-select")).toBeTruthy());
    // No internal CSS variable name appears anywhere as a visible label.
    expect(document.body.textContent ?? "").not.toContain("--tantalar-color");
    expect(TOKEN_LABELS["color-primary"]).toBe("Accent color");
  });

  it("wires libraries and indexers to their real endpoints", async () => {
    seedProductRoutes();
    renderUi(<SettingsPage adminId="u1" isAdmin={true} />);

    const openTab = (name: string) => {
      const t = [...document.querySelectorAll('[role="tab"]')].find((x) => x.textContent === name) as HTMLElement;
      t.click();
    };

    await waitFor(() => {
      openTab("Indexers");
      expect(screen.getByTestId("settings-indexers")).toBeTruthy();
    });
    await waitFor(() => expect(screen.getByText("Fixture")).toBeTruthy());

    await waitFor(() => {
      openTab("Libraries");
      expect(screen.getByTestId("settings-libraries")).toBeTruthy();
    });
    await waitFor(() => expect(screen.getByText("Movies")).toBeTruthy());
  });
});
