import React from "react";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { UsersView } from "../src/admin/PeoplePage";
import { CollectionUserContext } from "../src/admin/DenseGrid";
import { NotificationProvider } from "../src/notifications";
import { api } from "../src/api";

vi.mock("../src/api", () => ({ api: {
  users: vi.fn(), userProfile: vi.fn(), createUser: vi.fn(), saveUserAvatar: vi.fn(),
  libraries: vi.fn(), userLibraries: vi.fn(), setUserLibraries: vi.fn(),
  setUserRole: vi.fn(), resetUserPassword: vi.fn(), revokeUserSessions: vi.fn(), setUserActive: vi.fn(),
  uiPreferences: vi.fn().mockResolvedValue({ preferences: {} }), saveUiPreferences: vi.fn().mockResolvedValue({ saved: true }),
} }));
const person = { id: "viewer-1", username: "Alex", role: "viewer", active: true, avatar: { preset: "smile" }, createdAt: "2026-09-07T00:00:00Z" };
beforeAll(() => {
  Object.defineProperty(window, "matchMedia", { writable: true, value: (query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {} }) });
  globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
});
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.users).mockResolvedValue({ users: [person], total: 1 });
  vi.mocked(api.userProfile).mockResolvedValue({ user: person });
  vi.mocked(api.saveUserAvatar).mockResolvedValue({ avatar: { preset: "cat" } });
  vi.mocked(api.libraries).mockResolvedValue({ libraries: [{ id: "movies", name: "Movies" }] } as never);
  vi.mocked(api.userLibraries).mockResolvedValue({ libraryIds: [] });
  vi.mocked(api.setUserLibraries).mockResolvedValue({ saved: true });
  vi.mocked(api.setUserActive).mockResolvedValue({ saved: true });
});
afterEach(cleanup);
function mount() { render(<MantineProvider env="test"><QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><NotificationProvider userId={null} isAdmin={false} navigate={() => {}}><CollectionUserContext.Provider value="admin-1"><UsersView /></CollectionUserContext.Provider></NotificationProvider></QueryClientProvider></MantineProvider>); }

it("edits an avatar, grants library access, and confirms deactivation", async () => {
  mount();
  await screen.findByRole("button", { name: "Manage profile" });
  fireEvent.click(screen.getByRole("button", { name: "Manage profile" }));
  const editor = within(await screen.findByRole("dialog", { name: "Manage Alex" }));
  fireEvent.click(editor.getByRole("button", { name: "Cat avatar" }));
  expect(api.saveUserAvatar).not.toHaveBeenCalled();
  fireEvent.click(editor.getByRole("button", { name: "Save picture" }));
  await waitFor(() => expect(api.saveUserAvatar).toHaveBeenCalledWith("viewer-1", { preset: "cat" }));
  fireEvent.click(editor.getByRole("tab", { name: "Access" }));
  fireEvent.click(await editor.findByRole("checkbox", { name: "Movies" }));
  fireEvent.click(editor.getByRole("button", { name: "Save library access" }));
  await waitFor(() => expect(api.setUserLibraries).toHaveBeenCalledWith("viewer-1", ["movies"]));
  fireEvent.click(editor.getByRole("tab", { name: "Security" }));
  await waitFor(() => expect(editor.getByRole("button", { name: "Deactivate account" }).matches(":disabled")).toBe(false));
  fireEvent.click(editor.getByRole("button", { name: "Deactivate account" }));
  expect(api.setUserActive).not.toHaveBeenCalled();
  fireEvent.click(editor.getByRole("button", { name: "Confirm deactivation" }));
  await waitFor(() => expect(api.setUserActive).toHaveBeenCalledWith("viewer-1", false));
  expect(await editor.findByRole("button", { name: "Reactivate account" })).toBeTruthy();
});

it("creates an account then opens its profile without browser prompts", async () => {
  vi.mocked(api.createUser).mockResolvedValue({ user: person });
  mount();
  fireEvent.click(screen.getByRole("button", { name: "Add person" }));
  const dialog = within(screen.getByRole("dialog", { name: "Add person" }));
  fireEvent.change(dialog.getByLabelText("Username", { exact: false }), { target: { value: "Alex" } });
  fireEvent.change(dialog.getByLabelText("Temporary password", { exact: false }), { target: { value: "temporary-password" } });
  fireEvent.click(dialog.getByRole("button", { name: "Create account" }));
  await waitFor(() => expect(api.createUser).toHaveBeenCalledWith("Alex", "temporary-password", "viewer"));
  expect(await screen.findByRole("dialog", { name: "Manage Alex" })).toBeTruthy();
});
