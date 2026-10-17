import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { NotificationProvider } from "../src/notifications";
import { LibraryManager } from "../src/components/LibraryManager";
import { api } from "../src/api";

vi.mock("../src/api", () => ({
  api: {
    libraries: vi.fn(),
    createLibrary: vi.fn(),
    updateLibrary: vi.fn(),
    setLibraryEnabled: vi.fn(),
    validateLibrary: vi.fn(),
    rescanLibrary: vi.fn(),
    removeLibrary: vi.fn(),
  },
}));

const mockApi = vi.mocked(api, true);
const library = {
  id: "lib-1",
  name: "Movies",
  rootPath: "/media/movies",
  kind: "movie" as const,
  enabled: true,
  createdAt: "2026-08-24T00:00:00.000Z",
};

function renderManager(
  onConfigured?: Parameters<typeof LibraryManager>[0]["onConfigured"],
  defaultFormOpen = false,
) {
  render(
    <MantineProvider><NotificationProvider userId={null} isAdmin={false} navigate={() => {}}>
      <LibraryManager defaultFormOpen={defaultFormOpen} onConfigured={onConfigured} />
    </NotificationProvider></MantineProvider>,
  );
}

describe("LibraryManager", () => {
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
    mockApi.libraries.mockResolvedValue({ libraries: [] });
  });

  it("creates a library and reports server validation", async () => {
    mockApi.createLibrary.mockResolvedValue({ library });
    mockApi.validateLibrary.mockResolvedValue({
      results: [{ library, ok: true, issues: [] }],
    });
    renderManager();
    await screen.findByText(/no libraries yet/i);

    fireEvent.click(screen.getByRole("button", { name: /add library/i }));
    fireEvent.change(screen.getByLabelText(/library name/i), { target: { value: "Movies" } });
    fireEvent.change(screen.getByLabelText(/root path/i), { target: { value: "/media/movies" } });
    fireEvent.click(screen.getByRole("button", { name: /save library/i }));

    await waitFor(() => {
      expect(mockApi.createLibrary).toHaveBeenCalledWith({ name: "Movies", rootPath: "/media/movies", kind: "movie" });
    });
    await screen.findByText(/path is ready/i);
    expect(screen.getByText(/verified its root path/i)).toBeTruthy();
  });

  it("validates and rescans an existing library", async () => {
    mockApi.libraries.mockResolvedValue({ libraries: [library] });
    mockApi.validateLibrary.mockResolvedValue({
      results: [{ library, ok: false, issues: [{ code: "not_writable", detail: "The directory is not writable." }] }],
    });
    mockApi.rescanLibrary.mockResolvedValue({
      checked: 3,
      discovered: 1,
      existing: 2,
      missingRemoved: 1,
      skipped: 0,
      errors: [],
    });
    renderManager();
    await screen.findByText("/media/movies", { exact: false });

    fireEvent.click(screen.getByRole("button", { name: /test path/i }));
    await screen.findByText(/directory is not writable/i);
    fireEvent.click(screen.getByRole("button", { name: /scan library/i }));
    await screen.findByText(/1 new file found; 2 already catalogued; 1 missing entry removed/i);
  });

  it("edits a library definition and marks a changed root for reconciliation", async () => {
    const updated = {
      ...library,
      name: "Films",
      rootPath: "/srv/films",
      kind: "mixed" as const,
      enabled: false,
    };
    mockApi.libraries.mockResolvedValue({ libraries: [library] });
    mockApi.updateLibrary.mockResolvedValue({ library: { ...updated, enabled: true } });
    mockApi.setLibraryEnabled.mockResolvedValue({ library: updated });
    renderManager();
    await screen.findByText("/media/movies", { exact: false });

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.change(await screen.findByLabelText(/library name/i), { target: { value: "Films" } });
    fireEvent.change(screen.getByLabelText(/media type/i), { target: { value: "mixed" } });
    fireEvent.change(screen.getByLabelText(/root path/i), { target: { value: "/srv/films" } });
    fireEvent.click(screen.getByRole("switch", { name: /library enabled/i }));
    expect(screen.getByText(/scan required after saving/i)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(mockApi.updateLibrary).toHaveBeenCalledWith("lib-1", {
      name: "Films",
      rootPath: "/srv/films",
      kind: "mixed",
    }));
    expect(mockApi.setLibraryEnabled).toHaveBeenCalledWith("lib-1", false);
    expect(await screen.findByText("/srv/films", { exact: false })).toBeTruthy();
    expect(screen.getByText(/reconcile its catalog with the new root/i)).toBeTruthy();
  });

  it("keeps the editor open when server-side root validation fails", async () => {
    mockApi.libraries.mockResolvedValue({ libraries: [library] });
    mockApi.updateLibrary.mockRejectedValue(new Error("library root does not exist: /missing"));
    renderManager();
    await screen.findByText("/media/movies", { exact: false });

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.change(await screen.findByLabelText(/root path/i), { target: { value: "/missing" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    expect(await screen.findByText(/root does not exist/i)).toBeTruthy();
    expect(screen.getByLabelText(/root path/i)).toBeTruthy();
    expect(mockApi.setLibraryEnabled).not.toHaveBeenCalled();
  });

  it("enables setup continuation only after a successful current validation", async () => {
    const onConfigured = vi.fn();
    mockApi.libraries.mockResolvedValue({ libraries: [library] });
    mockApi.validateLibrary
      .mockResolvedValueOnce({
        results: [{ library, ok: false, issues: [{ code: "root_missing", detail: "The root is unavailable." }] }],
      })
      .mockResolvedValueOnce({ results: [{ library, ok: true, issues: [] }] });
    renderManager(onConfigured);
    await screen.findByText("/media/movies", { exact: false });

    const continueButton = screen.getByRole("button", { name: /continue with this library/i });
    expect((continueButton as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: /test path/i }));
    await screen.findByText(/root is unavailable/i);
    expect((continueButton as HTMLButtonElement).disabled).toBe(true);
    expect(onConfigured).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /test path/i }));
    await waitFor(() => expect((continueButton as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(continueButton);
    await waitFor(() => expect(onConfigured).toHaveBeenCalledWith([library]));
  });

  it("requires explicit confirmation before removing only the definition", async () => {
    mockApi.libraries.mockResolvedValue({ libraries: [library] });
    mockApi.removeLibrary.mockResolvedValue({ removed: true, mediaFilesDeleted: false });
    renderManager();
    await screen.findByText("/media/movies", { exact: false });

    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    expect(mockApi.removeLibrary).not.toHaveBeenCalled();
    expect(screen.getByText(/does not delete media files/i)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /remove definition/i }));

    await waitFor(() => expect(mockApi.removeLibrary).toHaveBeenCalledWith("lib-1"));
    await screen.findByText(/media files were not deleted/i);
  });

  it("shows the backend reason when a root cannot be created", async () => {
    mockApi.createLibrary.mockRejectedValue(new Error("library root does not exist: /missing"));
    renderManager();
    await screen.findByText(/no libraries yet/i);

    fireEvent.click(screen.getByRole("button", { name: /add library/i }));
    fireEvent.change(screen.getByLabelText(/library name/i), { target: { value: "Missing" } });
    fireEvent.change(screen.getByLabelText(/root path/i), { target: { value: "/missing" } });
    fireEvent.click(screen.getByRole("button", { name: /save library/i }));

    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/root does not exist/i));
  });

  it("keeps creation collapsed and treats zero libraries as a normal empty state", async () => {
    renderManager();

    await screen.findByText(/no libraries yet/i);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByLabelText(/library name/i)).toBeNull();

    const addButton = screen.getByRole("button", { name: /add library/i });
    expect(addButton.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(addButton);
    expect(screen.getByLabelText(/library name/i)).toBeTruthy();
  });

  it("starts creation open during onboarding", async () => {
    renderManager(vi.fn(), true);

    await screen.findByText(/no libraries yet/i);
    expect(screen.getByLabelText(/library name/i)).toBeTruthy();
  });

  it("keeps genuine connection failures visible with retry guidance", async () => {
    mockApi.libraries.mockRejectedValueOnce(new Error("Failed to fetch"));
    renderManager();

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/check that the server is running/i);
    expect(alert.textContent).toMatch(/failed to fetch/i);
    expect(screen.queryByText(/no libraries yet/i)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /retry connection/i }));
    await screen.findByText(/no libraries yet/i);
  });
});
