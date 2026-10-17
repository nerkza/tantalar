import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("../src/api", () => ({ api: { diagnostics: vi.fn() } }));

vi.mock("../src/admin/views", () => ({
  ActivityView: () => <div>Activity</div>,
  AuditView: () => <div>Audit</div>,
  DensityToggle: () => <div>Density control</div>,
  HistoryView: () => <div>History</div>,
  PluginsView: () => <div>Plugins</div>,
  QueueView: () => <div>Queue</div>,
  SystemHealthView: () => <div>Health view</div>,
  UsersView: () => <div>Users</div>,
  WantedView: () => <div>Wanted</div>,
}));

vi.mock("../src/pages/SettingsPage", () => ({
  AppearanceSettings: () => <div data-testid="appearance-settings">Canonical appearance settings</div>,
}));

import { ControlPage } from "../src/shell/ControlSurface";
import { api } from "../src/api";
import { diagnosticsFixture } from "./diagnostics-fixture";

describe("Control appearance routing", () => {
  beforeAll(() => {
    window.matchMedia =
      window.matchMedia ??
      ((query: string) =>
        ({
          matches: false,
          media: query,
          onchange: null,
          addEventListener: () => undefined,
          removeEventListener: () => undefined,
          addListener: () => undefined,
          removeListener: () => undefined,
          dispatchEvent: () => false,
        }) as unknown as MediaQueryList);
  });

  beforeEach(() => {
    vi.mocked(api.diagnostics).mockReset().mockResolvedValue(diagnosticsFixture);
  });

  it("keeps Advanced inside Appearance instead of presenting it as a System peer", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <MantineProvider>
        <QueryClientProvider client={client}>
          <ControlPage area="system" adminId="admin-1" onNavigate={vi.fn()} />
        </QueryClientProvider>
      </MantineProvider>,
    );

    expect(await screen.findByTestId("system-health-dashboard")).toBeTruthy();
    expect(screen.queryByRole("tab", { name: "Advanced" })).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: "Appearance" }));

    expect(screen.getByTestId("appearance-settings").textContent).toBe("Canonical appearance settings");
    expect(screen.queryByText("Built-in modes")).toBeNull();
  });
});
