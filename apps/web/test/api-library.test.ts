import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../src/api";

afterEach(() => vi.unstubAllGlobals());

describe("library API", () => {
  it("updates a definition and its enabled state through the existing routes", async () => {
    const library = {
      id: "lib-1",
      name: "Films",
      rootPath: "/srv/films",
      kind: "movie",
      enabled: false,
      createdAt: "2026-08-24T00:00:00.000Z",
    };
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(new Response(JSON.stringify({ library }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })));
    vi.stubGlobal("fetch", fetchMock);

    await api.updateLibrary("lib-1", { name: "Films", rootPath: "/srv/films" });
    await api.setLibraryEnabled("lib-1", false);

    expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/v1/libraries/lib-1", expect.objectContaining({
      method: "PATCH",
      body: JSON.stringify({ name: "Films", rootPath: "/srv/films" }),
    }));
    expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/v1/libraries/lib-1/enabled", expect.objectContaining({
      method: "PUT",
      body: JSON.stringify({ enabled: false }),
    }));
  });
});
