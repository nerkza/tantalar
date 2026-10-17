import { beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ConfigurationBackup, ConfigurationImport } from "../src/components/ConfigurationBackup";
import { api } from "../src/api";

vi.mock("../src/api", () => ({ api: { backupSettings: vi.fn(), updateBackupSettings: vi.fn(), importConfiguration: vi.fn(), cancelConfigurationImport: vi.fn(), backup: vi.fn(), exportConfiguration: vi.fn() } }));
const mock = vi.mocked(api);
const settings = { supported: true, enabled: true, schedule: "daily 02:00", directory: "/data/backups", retention: 7, nextRunAt: null, latestRun: null, pendingImport: false };
function mount(component: React.ReactNode) {
  render(<MantineProvider><QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{component}</QueryClientProvider></MantineProvider>);
}
beforeEach(() => {
  cleanup(); vi.clearAllMocks();
  window.matchMedia = vi.fn().mockImplementation(query => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));
  mock.backupSettings.mockResolvedValue(settings);
  vi.spyOn(window, "confirm").mockReturnValue(true);
});

it("shows saved daily settings and persists an operator's changes", async () => {
  mount(<ConfigurationBackup />);
  const schedule = await screen.findByRole("textbox", { name: /Schedule \(UTC\)/ });
  expect((schedule as HTMLInputElement).value).toBe("daily 02:00");
  fireEvent.change(schedule, { target: { value: "every 48h" } });
  fireEvent.click(screen.getByLabelText("Enable automatic backups"));
  fireEvent.click(screen.getByRole("button", { name: "Save backup settings" }));
  await waitFor(() => expect(mock.updateBackupSettings).toHaveBeenCalledWith({ directory: "/data/backups", retention: 7, enabled: false, schedule: "every 48h" }));
});

it("validates an uploaded file and shows a persistent restart requirement", async () => {
  mount(<ConfigurationImport />);
  await screen.findByLabelText("Configuration file");
  const file = new File(['{"format":"tantalar-configuration"}'], "configuration.json", { type: "application/json" });
  Object.defineProperty(file, "text", { value: async () => '{"format":"tantalar-configuration"}' });
  fireEvent.change(document.querySelector('input[type="file"]')!, { target: { files: [file] } });
  fireEvent.click(screen.getByRole("button", { name: "Validate and import" }));
  await waitFor(() => expect(mock.importConfiguration).toHaveBeenCalledWith({ format: "tantalar-configuration" }));
  await screen.findByText("Restart required");
  fireEvent.click(screen.getByRole("button", { name: "Cancel pending import" }));
  await waitFor(() => expect(mock.cancelConfigurationImport).toHaveBeenCalled());
});

it("keeps malformed-file errors beside the import control", async () => {
  mount(<ConfigurationImport />);
  await screen.findByLabelText("Configuration file");
  const file = new File(["invalid"], "bad.json");
  Object.defineProperty(file, "text", { value: async () => "invalid" });
  fireEvent.change(document.querySelector('input[type="file"]')!, { target: { files: [file] } });
  fireEvent.click(screen.getByRole("button", { name: "Validate and import" }));
  await screen.findByText("Select a valid Tantalar configuration JSON file.");
  expect(mock.importConfiguration).not.toHaveBeenCalled();
});
