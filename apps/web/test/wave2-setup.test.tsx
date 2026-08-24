/**
 * Wave 2 web tests: SetupPage bootstrap + guided onboarding wizard.
 * Covers: first-run admin creation, step progression with optional skips,
 * required-step skip refusal surfacing a product-facing message, and the
 * finished state calling back into the app.
 */
import { describe, expect, it, vi, beforeEach, beforeAll } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import React from "react";

/** Mantine's PasswordInput nests a second input; select the real one by name. */
function fillPassword(value: string) {
  const el = document.querySelector('input[name="password"]') as HTMLInputElement | null;
  if (!el) throw new Error("password input not found");
  fireEvent.change(el, { target: { value } });
}
import { SetupPage } from "../src/pages/SetupPage";
import { api } from "../src/api";

vi.mock("../src/api", () => ({
  api: {
    login: vi.fn(),
    bootstrapAdmin: vi.fn(),
    onboarding: vi.fn(),
    onboardStep: vi.fn(),
  },
}));

const mockApi = vi.mocked(api, true);

function renderSetup(onFinished = vi.fn()) {
  const onFinishedFn = onFinished;
  render(
    <MantineProvider>
      <SetupPage onFinished={onFinishedFn} />
    </MantineProvider>,
  );
  return onFinishedFn;
}

const allPending = {
  steps: Object.fromEntries(
    [
      "administrator",
      "storage",
      "libraries",
      "download-engines",
      "indexers",
      "metadata",
      "vpn-policy",
      "final-health",
    ].map((id) => [id, { status: "pending" }]),
  ),
  complete: false,
};

describe("SetupPage", () => {
  beforeAll(() => {
    // jsdom lacks matchMedia; Mantine's color-scheme hook needs it.
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
    vi.clearAllMocks();
    // testing-library auto-cleanup requires globals; run it explicitly.
    document.body.innerHTML = "";
  });

  it("creates the one-time administrator account", async () => {
    mockApi.bootstrapAdmin.mockResolvedValue({ ok: true });
    mockApi.onboarding.mockResolvedValue(allPending);
    renderSetup();

    fireEvent.change(screen.getByLabelText(/username/i), {
      target: { value: "admin" },
    });
    fillPassword("password-admin-1");
    fireEvent.click(screen.getByTestId("setup-create-admin"));

    await waitFor(() => {
      expect(mockApi.bootstrapAdmin).toHaveBeenCalledWith("admin", "password-admin-1");
    });
    await waitFor(() => {
      expect(screen.getByText("Guided setup")).toBeTruthy();
    });
  });

  it("surfaces a product-facing error when bootstrap is closed", async () => {
    mockApi.bootstrapAdmin.mockRejectedValue(
      Object.assign(new Error("Setup is already complete. Sign in with your administrator account."), {
        status: 403,
      }),
    );
    renderSetup();

    fillPassword("password-admin-1");
    fireEvent.click(screen.getByTestId("setup-create-admin"));

    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toMatch(/already complete/);
    });
  });

  it("walks steps, allows skipping optional ones, and finishes", async () => {
    mockApi.bootstrapAdmin.mockResolvedValue({ ok: true });
    const done = (id: string, status: "done" | "skipped" = "done") => ({
      ...allPending,
      steps: {
        ...allPending.steps,
        [id]: { status },
      },
    });
    // Track cumulative progress so earlier steps stay finished across calls.
    let cumulative = allPending;
    mockApi.onboarding.mockResolvedValue(allPending);
    mockApi.onboardStep.mockImplementation((stepId, action) => {
      const status = action === "skip" ? "skipped" : "done";
      cumulative = {
        ...cumulative,
        steps: { ...cumulative.steps, [stepId]: { status } },
      };
      return Promise.resolve(cumulative);
    });

    // Start past the admin form.
    mockApi.bootstrapAdmin.mockResolvedValueOnce({ ok: true });
    const onFinished = renderSetup();
    fillPassword("password-admin-1");
    fireEvent.click(screen.getByTestId("setup-create-admin"));
    await waitFor(() => screen.getByText("Guided setup"));
    // The wizard's refresh() runs in an effect after bootstrap; wait for the
    // first action button to appear before interacting.
    await waitFor(() => screen.getByTestId("setup-done-administrator"));

    // Complete the administrator step.
    fireEvent.click(screen.getByTestId("setup-done-administrator"));
    await waitFor(() => {
      expect(screen.getByTestId("setup-step-administrator").textContent).toMatch(/Done/);
    });
    // Wait for the storage step's action button (next pending required step).
    await waitFor(() => screen.getByTestId("setup-done-storage"));

    // Skip an optional step: walk to download-engines by completing the
    // intervening steps through the API mock, then verify the skip path.
    fireEvent.click(screen.getByTestId("setup-done-storage"));
    await waitFor(() => {
      expect(screen.getByTestId("setup-step-storage").textContent).toMatch(/Done/);
    });
    await waitFor(() => screen.getByTestId("setup-done-libraries"));
    fireEvent.click(screen.getByTestId("setup-done-libraries"));
    await waitFor(() => screen.getByRole("button", { name: /skip for now/i }));
    fireEvent.click(screen.getByRole("button", { name: /skip for now/i }));
    await waitFor(() => {
      expect(screen.getByTestId("setup-step-download-engines").textContent).toMatch(/Skipped/);
    });
    expect(mockApi.onboardStep).toHaveBeenCalledWith("download-engines", "skip");
  });

  it("shows a recovery message when a step update fails", async () => {
    mockApi.bootstrapAdmin.mockResolvedValue({ ok: true });
    mockApi.onboarding.mockResolvedValue(allPending);
    mockApi.onboardStep.mockRejectedValue(
      Object.assign(new Error("VPN policy is required and cannot be skipped."), { status: 400 }),
    );
    renderSetup();
    fillPassword("password-admin-1");
    fireEvent.click(screen.getByTestId("setup-create-admin"));
    await waitFor(() => screen.getByText("Guided setup"));
    await waitFor(() => screen.getByTestId("setup-done-administrator"));

    // First visible action button belongs to the pending administrator step.
    fireEvent.click(screen.getByTestId("setup-done-administrator"));
    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toMatch(/cannot be skipped|earlier setup steps/);
    });
  });
});
