import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ONBOARDING_STEPS, type OnboardingState } from "@tantalar/contracts";
import { SetupPage } from "../src/pages/SetupPage";
import { api } from "../src/api";

vi.mock("../src/api", () => ({ api: {
  me: vi.fn(), login: vi.fn(), bootstrapAdmin: vi.fn(), onboarding: vi.fn(), onboardPreferences: vi.fn(), onboardStep: vi.fn(),
  libraries: vi.fn(), catalog: vi.fn(), metadataStatus: vi.fn(), setResume: vi.fn(),
  diagnostics: vi.fn(), profileAlbum: vi.fn().mockResolvedValue({ canManage: true, pictures: [], hiddenDefaults: [] }),
  backupSettings: vi.fn().mockResolvedValue({ supported: true, pendingImport: false }),
} }));
const mock = vi.mocked(api);
let state: OnboardingState;

function renderSetup(bootstrapRequired = false) {
  const onFinished = vi.fn(), onExit = vi.fn();
  render(<MantineProvider><QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <SetupPage bootstrapRequired={bootstrapRequired} onFinished={onFinished} onExit={onExit} />
  </QueryClientProvider></MantineProvider>);
  return { onFinished, onExit };
}

beforeEach(() => {
  cleanup(); vi.clearAllMocks();
  window.matchMedia = vi.fn().mockImplementation(query => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));
  state = { version: 2, steps: Object.fromEntries(ONBOARDING_STEPS.map(id => [id, { status: "pending" }])) as OnboardingState["steps"], currentStep: "experience", mediaEnabled: false, acquisitionMode: "none", titleFileId: null, metadataQuery: "", complete: false };
  state.steps.administrator = { status: "done" };
  mock.me.mockResolvedValue({ user: { id: "admin", username: "admin", role: "admin" } });
  mock.libraries.mockResolvedValue({ libraries: [] });
  mock.catalog.mockResolvedValue({ items: [] });
  mock.diagnostics.mockResolvedValue({ ready: true, missingCapabilities: [], transcoder: { ffmpegAvailable: false } } as Awaited<ReturnType<typeof api.diagnostics>>);
  mock.metadataStatus.mockResolvedValue({ provider: "tmdb", mode: "hosted", state: "ready", configured: true, directKeyConfigured: false });
  mock.onboarding.mockImplementation(async () => structuredClone(state));
  mock.onboardPreferences.mockImplementation(async preferences => {
    state = { ...state, ...preferences };
    return structuredClone(state);
  });
  mock.onboardStep.mockImplementation(async (id, action) => {
    const step = id as keyof OnboardingState["steps"];
    state.steps[step] = { status: action === "skip" ? "skipped" : "done" };
    if (id === "experience" && !state.mediaEnabled) state.steps.playback = { status: "skipped" };
    state.currentStep = ONBOARDING_STEPS.find(key => !["done", "skipped"].includes(state.steps[key].status)) ?? "final-health";
    state.complete = id === "final-health";
    return structuredClone(state);
  });
});

describe("Control-first onboarding", () => {
  it("offers configuration import during onboarding after administrator creation", async () => {
    mock.bootstrapAdmin.mockResolvedValue({ ok: true }); mock.login.mockResolvedValue({ csrfToken: "test" });
    renderSetup(true);
    fireEvent.click(screen.getByRole("button", { name: "Import a configuration file" }));
    fireEvent.change(screen.getByLabelText(/^Password/), { target: { value: "password-admin-1" } });
    fireEvent.click(screen.getByRole("button", { name: "Create administrator" }));
    await screen.findByRole("heading", { name: "Restore Tantalar" });
    await screen.findByLabelText("Configuration file");
  });
  it("creates an administrator before offering the frontend choice", async () => {
    mock.bootstrapAdmin.mockResolvedValue({ ok: true }); mock.login.mockResolvedValue({ csrfToken: "test" });
    renderSetup(true);
    fireEvent.change(screen.getByLabelText(/^Password/), { target: { value: "password-admin-1" } });
    fireEvent.click(screen.getByRole("button", { name: "Create administrator" }));
    await screen.findByRole("heading", { name: "Choose your frontend" });
    expect(mock.bootstrapAdmin).toHaveBeenCalledWith("admin", "password-admin-1");
    expect(mock.login).toHaveBeenCalledWith("admin", "password-admin-1");
  });

  it("finishes Control with no library, providers, title or playback", async () => {
    const { onFinished } = renderSetup();
    await screen.findByRole("heading", { name: "Choose your frontend" });
    expect((screen.getByRole("radio", { name: "Control only" }) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    for (const heading of ["Libraries", "Acquisition", "Metadata", "First title"]) {
      await screen.findByRole("heading", { name: heading, level: 1 });
      fireEvent.click(screen.getByRole("button", { name: "Leave for later" }));
    }
    await screen.findByRole("heading", { name: "Review setup" });
    expect(screen.getByText("Control only")).toBeTruthy();
    await screen.findByText("Backend capability check passed.");
    fireEvent.click(screen.getByRole("button", { name: "Finish setup" }));
    await waitFor(() => expect(onFinished).toHaveBeenCalledWith(expect.objectContaining({ complete: true, mediaEnabled: false })));
    expect(mock.onboardStep).not.toHaveBeenCalledWith("playback", "complete");
  });

  it("persists the frontend choice and restores the server's current step", async () => {
    renderSetup();
    fireEvent.click(await screen.findByRole("radio", { name: "Control and Tantalar Media" }));
    await waitFor(() => expect(mock.onboardPreferences).toHaveBeenCalledWith(expect.objectContaining({ mediaEnabled: true })));
    fireEvent.click(screen.getByRole("button", { name: /Metadata.*Not checked/ }));
    await screen.findByRole("heading", { name: "Metadata", level: 1 });
    fireEvent.change(screen.getByLabelText("Title to search"), { target: { value: "Alien" } });
    fireEvent.click(screen.getByRole("button", { name: "Save and exit" }));
    await waitFor(() => expect(mock.onboardPreferences).toHaveBeenCalledWith({ metadataQuery: "Alien" }));
    cleanup(); renderSetup();
    await screen.findByRole("heading", { name: "Metadata", level: 1 });
    expect((screen.getByLabelText("Title to search") as HTMLInputElement).value).toBe("Alien");
  });

  it("keeps failed evidence and entered search text visible", async () => {
    state.currentStep = "metadata";
    mock.onboardStep.mockImplementationOnce(async () => ({ ...state, steps: { ...state.steps, metadata: { status: "failed", detail: "Provider unavailable. Retry later." } } }));
    renderSetup();
    fireEvent.change(await screen.findByLabelText("Title to search"), { target: { value: "Alien" } });
    fireEvent.click(screen.getByRole("button", { name: "Search and verify" }));
    await screen.findByRole("alert");
    expect(screen.getByText("Provider unavailable. Retry later.")).toBeTruthy();
    expect((screen.getByLabelText("Title to search") as HTMLInputElement).value).toBe("Alien");
  });

  it("does not pretend a setup load error means completion", async () => {
    mock.onboarding.mockRejectedValueOnce(new Error("offline"));
    const { onFinished } = renderSetup();
    await screen.findByRole("button", { name: "Retry setup" });
    expect(onFinished).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Retry setup" }));
    await screen.findByRole("heading", { name: "Choose your frontend" });
  });
});
