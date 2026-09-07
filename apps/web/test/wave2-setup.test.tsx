import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { SetupPage } from "../src/pages/SetupPage";
import { api } from "../src/api";

vi.mock("../src/api", () => ({
  api: {
    login: vi.fn(),
    bootstrapAdmin: vi.fn(),
    onboarding: vi.fn(),
    onboardStep: vi.fn(),
    diagnostics: vi.fn(),
    libraries: vi.fn(),
    createLibrary: vi.fn(),
    validateLibrary: vi.fn(),
    rescanLibrary: vi.fn(),
    removeLibrary: vi.fn(),
  },
}));

const mockApi = vi.mocked(api, true);

const ids = [
  "administrator",
  "storage",
  "libraries",
  "download-engines",
  "indexers",
  "metadata",
  "vpn-policy",
  "final-health",
] as const;

const allPending = {
  steps: Object.fromEntries(ids.map((id) => [id, { status: "pending" as const }])),
  complete: false,
};

const existingLibrary = {
  id: "lib-1",
  name: "Movies",
  rootPath: "/media/movies",
  kind: "movie" as const,
  enabled: true,
  createdAt: "2026-08-24T00:00:00.000Z",
};

function renderSetup(options: { bootstrapRequired?: boolean; onFinished?: () => void } = {}) {
  const onFinished = options.onFinished ?? vi.fn();
  render(
    <MantineProvider>
      <SetupPage onFinished={onFinished} bootstrapRequired={options.bootstrapRequired} />
    </MantineProvider>,
  );
  return onFinished;
}

function fillPassword(value: string) {
  const input = document.querySelector('input[name="password"]') as HTMLInputElement;
  fireEvent.change(input, { target: { value } });
}

function installProgressingOnboarding() {
  let current = structuredClone(allPending);
  mockApi.onboarding.mockResolvedValue(current);
  mockApi.onboardStep.mockImplementation(async (stepId, action) => {
    current = {
      steps: {
        ...current.steps,
        [stepId]: { status: action === "skip" ? "skipped" : "done" },
      },
      complete: false,
    };
    current.complete = ids.every((id) => current.steps[id]?.status !== "pending");
    return current;
  });
}

describe("SetupPage", () => {
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
    cleanup();
    vi.clearAllMocks();
    mockApi.login.mockResolvedValue({ ok: true });
    mockApi.libraries.mockResolvedValue({ libraries: [] });
    mockApi.diagnostics.mockResolvedValue({
      versions: { node: "24", platform: "darwin", arch: "arm64" },
      ready: true,
      plugins: [],
      eventCount: 0,
      missingCapabilities: [],
      transcoder: { ffmpegAvailable: true },
      network: { vpnCapabilityMounted: false },
    });
  });

  it("creates the administrator and opens real library configuration", async () => {
    mockApi.bootstrapAdmin.mockResolvedValue({ ok: true });
    installProgressingOnboarding();
    renderSetup();

    fillPassword("password-admin-1");
    fireEvent.click(screen.getByTestId("setup-create-admin"));

    await waitFor(() => expect(mockApi.bootstrapAdmin).toHaveBeenCalledWith("admin", "password-admin-1"));
    await screen.findByRole("heading", { name: "Storage and libraries" });
    expect(screen.getByRole("form", { name: /add a media library/i })).toBeTruthy();
    expect(mockApi.onboardStep).toHaveBeenCalledWith("administrator", "complete");
  });

  it("surfaces a product-facing error when bootstrap is closed", async () => {
    mockApi.bootstrapAdmin.mockRejectedValue(
      Object.assign(new Error("Setup is already complete. Sign in with your administrator account."), { status: 403 }),
    );
    renderSetup();

    fillPassword("password-admin-1");
    fireEvent.click(screen.getByTestId("setup-create-admin"));

    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/already complete/i));
  });

  it("resumes with a configured library, records optional steps as skipped, and runs health", async () => {
    installProgressingOnboarding();
    mockApi.libraries.mockResolvedValue({ libraries: [existingLibrary] });
    mockApi.validateLibrary.mockResolvedValue({
      results: [{ library: existingLibrary, ok: true, issues: [] }],
    });
    const onFinished = renderSetup({ bootstrapRequired: false });

    await screen.findByRole("heading", { name: "Storage and libraries" });
    await screen.findByText("/media/movies", { exact: false });
    fireEvent.click(screen.getByRole("button", { name: /test path/i }));
    await screen.findByText(/path is ready/i);
    fireEvent.click(screen.getByRole("button", { name: /continue with this library/i }));

    for (const step of ["download-engines", "indexers", "metadata", "vpn-policy"]) {
      await waitFor(() => expect(screen.getByTestId(`setup-step-${step}`)).toBeTruthy());
      fireEvent.click(screen.getByRole("button", { name: /skip for now/i }));
    }

    await waitFor(() => expect(screen.getByTestId("setup-step-final-health")).toBeTruthy());
    await screen.findByText(/core services are ready/i);
    fireEvent.click(screen.getByRole("button", { name: /finish setup/i }));

    await waitFor(() => expect(onFinished).toHaveBeenCalledTimes(1));
    expect(mockApi.onboardStep).toHaveBeenCalledWith("storage", "complete");
    expect(mockApi.onboardStep).toHaveBeenCalledWith("libraries", "complete");
    expect(mockApi.onboardStep).toHaveBeenCalledWith("download-engines", "skip");
    expect(mockApi.diagnostics).toHaveBeenCalled();
  });

  it("does not complete library setup until a current path validation succeeds", async () => {
    installProgressingOnboarding();
    mockApi.libraries.mockResolvedValue({ libraries: [existingLibrary] });
    mockApi.validateLibrary.mockResolvedValue({
      results: [{
        library: existingLibrary,
        ok: false,
        issues: [{ code: "root_missing", detail: "The saved root no longer exists." }],
      }],
    });
    renderSetup({ bootstrapRequired: false });

    await screen.findByText("/media/movies", { exact: false });
    const continueButton = screen.getByRole("button", { name: /continue with this library/i });
    expect((continueButton as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/test at least one saved library path successfully/i)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /test path/i }));
    await screen.findByText(/saved root no longer exists/i);
    expect((continueButton as HTMLButtonElement).disabled).toBe(true);
    expect(mockApi.onboardStep).not.toHaveBeenCalledWith("storage", "complete");
    expect(mockApi.onboardStep).not.toHaveBeenCalledWith("libraries", "complete");
  });

  it("explains that optional capability setup is skipped, not configured", async () => {
    const state = structuredClone(allPending);
    state.steps.administrator.status = "done";
    state.steps.storage.status = "done";
    state.steps.libraries.status = "done";
    mockApi.onboarding.mockResolvedValue(state);
    mockApi.onboardStep.mockRejectedValue(new Error("Download engine state could not be saved."));
    renderSetup({ bootstrapRequired: false });

    await screen.findByTestId("setup-step-download-engines");
    expect(screen.getByText(/records it as skipped, not configured/i)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /skip for now/i }));
    await waitFor(() => expect(screen.getByText(/download engine state could not be saved/i)).toBeTruthy());
  });
});
