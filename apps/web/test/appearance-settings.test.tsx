import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { NotificationProvider } from "../src/notifications";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { api } from "../src/api";
import { AppearanceSettings } from "../src/pages/SettingsPage";
import { ThemeEngineProvider } from "../src/theme/engine";
import {
  BUILT_IN_THEMES,
  DEFAULT_TOKENS,
  readableTextOn,
  resolveThemeTokens,
  validateThemeContrast,
} from "../src/theme/tokens";

vi.mock("../src/api", () => ({
  api: {
    uiPreferences: vi.fn(),
    saveUiPreferences: vi.fn(),
    themes: vi.fn(),
    saveTheme: vi.fn(),
    events: vi.fn(),
  },
}));

vi.mock("../src/admin/views", () => ({
  DensityToggle: () => <span>Comfortable density</span>,
}));

vi.mock("../src/components/LibraryManager", () => ({
  LibraryManager: () => null,
}));

const mockApi = vi.mocked(api, true);

beforeAll(() => {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
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

beforeEach(() => {
  vi.clearAllMocks();
  mockApi.uiPreferences.mockResolvedValue({ preferences: { colorScheme: "dark", tokenOverrides: {} } });
  mockApi.saveUiPreferences.mockResolvedValue({ preferences: {} });
  mockApi.themes.mockResolvedValue({ themes: [] });
  mockApi.saveTheme.mockResolvedValue({ theme: { id: "theme-1" } });
});

afterEach(() => {
  cleanup();
  document.documentElement.removeAttribute("style");
});

async function renderAppearance() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <MantineProvider><NotificationProvider userId={null} isAdmin={false} navigate={() => {}}>
      <QueryClientProvider client={client}>
        <ThemeEngineProvider adminId="admin-1">
          <AppearanceSettings adminId="admin-1" />
        </ThemeEngineProvider>
      </QueryClientProvider>
    </NotificationProvider></MantineProvider>,
  );
  await waitFor(() => expect(mockApi.themes).toHaveBeenCalled());
}

async function editHex(label: string, value: string) {
  const trigger = screen.getByRole("button", { name: `Edit ${label}` });
  if (trigger.getAttribute("aria-expanded") !== "true") fireEvent.click(trigger);
  fireEvent.change(await screen.findByLabelText(`${label} hex value`), { target: { value } });
}

describe("Appearance settings", () => {
  it("ships ten complete presets that pass the shared contrast gate", () => {
    expect(BUILT_IN_THEMES).toHaveLength(10);
    expect(new Set(BUILT_IN_THEMES.map((preset) => preset.id)).size).toBe(10);
    for (const preset of BUILT_IN_THEMES) {
      expect(Object.keys(preset.tokens).sort()).toEqual(Object.keys(DEFAULT_TOKENS).sort());
      expect(validateThemeContrast(preset.tokens), preset.name).toEqual([]);
    }
  });

  it("expands one colour card inline at a time", async () => {
    await renderAppearance();
    fireEvent.click(screen.getByRole("button", { name: "Edit Accent" }));
    expect(await screen.findByTestId("color-primary-editor")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Edit Accent" }).getAttribute("aria-expanded")).toBe("true");

    fireEvent.click(screen.getByRole("button", { name: "Edit Text" }));
    expect(await screen.findByTestId("color-text-editor")).toBeTruthy();
    expect(screen.queryByTestId("color-primary-editor")).toBeNull();
  });

  it("applies a complete built-in preset without creating a custom theme", async () => {
    await renderAppearance();
    fireEvent.click(screen.getByRole("button", { name: "Use Sage light theme" }));

    await waitFor(() => expect(mockApi.saveUiPreferences).toHaveBeenCalledWith(
      "admin-1",
      expect.objectContaining({
        colorScheme: "light",
        themeId: null,
        tokenOverrides: BUILT_IN_THEMES.find((preset) => preset.id === "sage-light")!.tokens,
      }),
    ));
    expect((await screen.findByText("Sage light applied.")).closest("article")?.getAttribute("role")).toBe("status");
    expect(mockApi.saveTheme).not.toHaveBeenCalled();
  });

  it("keeps custom colour drafts inside the representative preview", async () => {
    const resolved = resolveThemeTokens("dark", { "color-surface": "#20242f" }, { "color-primary": "#5da2ff" });
    expect(resolved["color-bg"]).toBe("#10121a");
    expect(resolved["color-surface"]).toBe("#20242f");
    expect(resolved["color-primary"]).toBe("#5da2ff");

    await renderAppearance();
    const preview = screen.getByRole("region", { name: "Tantalar preview" });
    const rootPrimary = document.documentElement.style.getPropertyValue("--tantalar-color-primary");
    const rootText = document.documentElement.style.getPropertyValue("--tantalar-color-text");
    expect(preview).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Tantalar preview" })).toBeTruthy();
    expect(preview.querySelector(".tantalar-theme-preview__bar")).toBeNull();
    expect(preview.querySelector(".tantalar-preview-window")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Readability" })).toBeNull();
    expect(document.querySelector(".tantalar-appearance-section--colours")).toBeTruthy();
    expect(document.querySelector(".tantalar-appearance-aside")).toBeTruthy();
    expect(screen.getByText("Library health")).toBeTruthy();
    expect(screen.getByLabelText("Preview input")).toBeTruthy();
    expect(screen.getByText("Healthy")).toBeTruthy();
    expect(screen.getByText("Attention")).toBeTruthy();
    expect(screen.getByText("Failed")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Edit Text" })).toBeTruthy();

    await editHex("Accent", "#5da2ff");
    await waitFor(() => {
      expect(preview.style.getPropertyValue("--tantalar-color-primary")).toBe("#5da2ff");
      expect(preview.style.getPropertyValue("--tantalar-color-primary-contrast"))
        .toBe(readableTextOn("#5da2ff"));
      expect(document.documentElement.style.getPropertyValue("--tantalar-color-primary")).toBe(rootPrimary);
    });

    await editHex("Text", "#f0e8d6");
    await waitFor(() => {
      expect(preview.style.getPropertyValue("--tantalar-color-text")).toBe("#f0e8d6");
      expect(document.documentElement.style.getPropertyValue("--tantalar-color-text")).toBe(rootText);
    });
  });

  it("allows a low-contrast custom palette without readability blocking", async () => {
    expect(validateThemeContrast(resolveThemeTokens("dark", undefined, { "color-bg": "#ffffff" })).length).toBeGreaterThan(0);
    await renderAppearance();

    await editHex("Text", "#10121a");
    fireEvent.change(screen.getByLabelText("Theme name"), { target: { value: "Low contrast" } });
    expect(screen.queryByRole("alert")).toBeNull();
    expect((screen.getByTestId("save-theme") as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByTestId("save-theme"));
    await waitFor(() => expect(mockApi.saveTheme).toHaveBeenCalledWith(
      null,
      "Low contrast",
      expect.objectContaining({ "--tantalar-color-text": "#10121a" }),
    ));
  });

  it("imports theme JSON by drop and exposes native import and export controls", async () => {
    await renderAppearance();
    fireEvent.click(screen.getByRole("button", { name: "Advanced appearance" }));

    const input = screen.getByLabelText("Import theme") as HTMLInputElement;
    const dropzone = screen.getByTestId("import-theme-dropzone");
    const exportButton = screen.getByRole("button", { name: "Export theme" });
    expect(input.type).toBe("file");
    expect(input.accept).toContain(".json");
    expect(dropzone.querySelector("svg")).toBeTruthy();
    expect(exportButton.querySelector("svg")).toBeTruthy();

    const file = {
      text: vi.fn().mockResolvedValue(JSON.stringify({ tokens: { "color-primary": "#123456" } })),
    } as unknown as File;
    fireEvent.drop(dropzone, { dataTransfer: { files: [file] } });

    const preview = screen.getByRole("region", { name: "Tantalar preview" });
    await waitFor(() => expect(preview.style.getPropertyValue("--tantalar-color-primary")).toBe("#123456"));
  });

  it("saves a named theme and reverts later preview changes", async () => {
    await renderAppearance();
    const preview = screen.getByRole("region", { name: "Tantalar preview" });
    const rootPrimary = document.documentElement.style.getPropertyValue("--tantalar-color-primary");
    await editHex("Accent", "#5da2ff");
    expect(document.documentElement.style.getPropertyValue("--tantalar-color-primary")).toBe(rootPrimary);
    fireEvent.change(screen.getByLabelText("Theme name"), { target: { value: "Quiet blue" } });
    fireEvent.click(screen.getByTestId("save-theme"));

    await waitFor(() => expect(mockApi.saveTheme).toHaveBeenCalledWith(
      null,
      "Quiet blue",
      expect.objectContaining({
        "--tantalar-color-primary": "#5da2ff",
        "--tantalar-color-primary-contrast": readableTextOn("#5da2ff"),
      }),
    ));
    await waitFor(() => expect(document.documentElement.style.getPropertyValue("--tantalar-color-primary")).toBe("#5da2ff"));

    await editHex("Accent", "#75c78f");
    await waitFor(() => expect(preview.style.getPropertyValue("--tantalar-color-primary")).toBe("#75c78f"));
    expect(document.documentElement.style.getPropertyValue("--tantalar-color-primary")).toBe("#5da2ff");
    fireEvent.click(screen.getByTestId("revert-theme"));
    expect(document.documentElement.style.getPropertyValue("--tantalar-color-primary")).toBe("#5da2ff");
    expect(preview.style.getPropertyValue("--tantalar-color-primary")).toBe("#5da2ff");
  });

  it("shows saved themes below built-in themes with the same preview card", async () => {
    const savedTokens = BUILT_IN_THEMES[0]!.tokens;
    mockApi.themes.mockResolvedValue({
      themes: [{ id: "saved-1", name: "Saved sample", tokens: savedTokens }],
    });
    await renderAppearance();

    const card = screen.getByRole("button", { name: "Use Saved sample theme" });
    const mock = card.querySelector<HTMLElement>(".tantalar-preset__mock");
    const expected = document.createElement("span");
    expected.style.background = savedTokens["color-bg"]!;
    expect(card.classList.contains("tantalar-preset")).toBe(true);
    expect(mock?.style.background).toBe(expected.style.background);

    const headings = Array.from(document.querySelectorAll(".tantalar-appearance-main section h4"), (heading) => heading.textContent);
    expect(headings.indexOf("Saved themes")).toBe(headings.indexOf("Themes") + 1);
    expect(headings.indexOf("Saved themes")).toBeLessThan(headings.indexOf("Custom colours"));
  });
});
