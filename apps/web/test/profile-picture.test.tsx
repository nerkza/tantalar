import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { PictureEditor } from "../src/components/ProfilePicture";
import { api } from "../src/api";

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("saves bundled artwork through the image API and allows reverting a selection", async () => {
  window.matchMedia = vi.fn().mockImplementation(query => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, blob: async () => new Blob(["image bytes"], { type: "image/jpeg" }) }));
  const save = vi.spyOn(api, "saveUserAvatar").mockResolvedValue({ avatar: { preset: null, url: "/saved.jpg" } });
  vi.spyOn(api, "profileAlbum").mockResolvedValue({ canManage: true, pictures: [], hiddenDefaults: [] });
  const onSaved = vi.fn();
  render(<MantineProvider><QueryClientProvider client={new QueryClient()}><PictureEditor userId="admin" username="admin" onSaved={onSaved} /></QueryClientProvider></MantineProvider>);
  expect(await screen.findAllByRole("button", { name: /avatar$/ })).toHaveLength(5);
  fireEvent.click(screen.getByRole("button", { name: "Previous artwork" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "logo cinematic avatar" }).getAttribute("aria-pressed")).toBe("true"));
  expect(screen.getByRole("button", { name: "logo cinematic avatar" }).getAttribute("aria-current")).toBe("true");
  expect(screen.queryByRole("button", { name: "logo clay avatar", hidden: true })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Next artwork" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "cinematic astronaut avatar" }).getAttribute("aria-pressed")).toBe("true"));
  fireEvent.click(screen.getByRole("button", { name: "clay cat avatar" }));
  await waitFor(() => expect((screen.getByRole("button", { name: "Save picture" }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole("button", { name: "Save picture" }));
  await waitFor(() => expect(save).toHaveBeenCalledWith("admin", { image: btoa("image bytes") }));
  expect(onSaved).toHaveBeenCalledWith({ preset: null, url: "/saved.jpg" });
  fireEvent.click(screen.getByRole("button", { name: "geometric fox avatar" }));
  await screen.findByText("Unsaved selection");
  fireEvent.click(screen.getByRole("button", { name: "Revert" }));
  expect(screen.getByRole("button", { name: "geometric fox avatar" }).getAttribute("aria-pressed")).toBe("false");
});

it("imports, exports and deletes album pictures, including the last entry", async () => {
  window.matchMedia = vi.fn().mockImplementation(query => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));
  const hiddenDefaults = ["cinematic-astronaut", "cinematic-explorer", "clay-cat", "clay-robot", "geometric-fox", "geometric-owl", "logo-cinematic", "logo-clay"].map(name => `default:${name}`);
  const state = { canManage: true, pictures: [] as Array<{ id: string; name: string; url: string }>, hiddenDefaults };
  vi.spyOn(api, "profileAlbum").mockImplementation(async () => structuredClone(state));
  const importPicture = vi.spyOn(api, "importAlbumPicture").mockImplementation(async name => {
    const picture = { id: name, name, url: "data:image/png;base64,aW1hZ2U=" }; state.pictures.push(picture); return { picture };
  });
  const remove = vi.spyOn(api, "deleteAlbumPicture").mockImplementation(async id => { state.pictures = state.pictures.filter(picture => picture.id !== id); });
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, blob: async () => new Blob(["image"], { type: "image/png" }) }));
  const download = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  vi.stubGlobal("URL", class extends URL { static createObjectURL() { return "blob:export"; } static revokeObjectURL() {} });
  render(<MantineProvider><QueryClientProvider client={new QueryClient()}><PictureEditor userId="admin" username="admin" onSaved={vi.fn()} /></QueryClientProvider></MantineProvider>);
  await screen.findByText("The profile album is empty.");
  fireEvent.change(screen.getByLabelText("Import album pictures"), { target: { files: [new File(["image"], "one.png", { type: "image/png" }), new File(["image"], "two.png", { type: "image/png" })] } });
  await screen.findByRole("button", { name: "one avatar" });
  expect(importPicture).toHaveBeenCalledTimes(2);
  fireEvent.click(screen.getByRole("button", { name: "Export picture" }));
  await waitFor(() => expect(download).toHaveBeenCalledOnce());
  for (const id of ["one", "two"]) {
    await waitFor(() => expect((screen.getByRole("button", { name: "Delete picture" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Delete picture" }));
    expect(remove).not.toHaveBeenCalledWith(id);
    fireEvent.click(screen.getByRole("button", { name: "Remove from album" }));
    await waitFor(() => expect(remove).toHaveBeenCalledWith(id));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Remove from album" })).toBeNull());
  }
  await screen.findByText("The profile album is empty.");
});
