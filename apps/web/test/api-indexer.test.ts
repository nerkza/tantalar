import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../src/api";

afterEach(() => vi.unstubAllGlobals());

describe("indexer API", () => {
  it("creates an indexer through the existing admin route", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ indexer: { id: "idx-1" } }), {
      status: 201,
      headers: { "content-type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    await api.createIndexer({
      name: "Example",
      protocol: "newznab",
      baseUrl: "https://indexer.example",
      apiKey: "secret",
      priority: 25,
      enabled: true,
    });

    expect(fetchMock).toHaveBeenCalledWith("/api/v1/indexers", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({
        name: "Example",
        protocol: "newznab",
        baseUrl: "https://indexer.example",
        apiKey: "secret",
        priority: 25,
        enabled: true,
      }),
    }));
  });

  it("updates and deletes an indexer, including a no-content delete response", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ indexer: { id: "idx-1" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await api.updateIndexer("idx-1", { name: "Edited", apiKey: "" });
    await expect(api.deleteIndexer("idx-1")).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/v1/indexers/idx-1", expect.objectContaining({
      method: "PATCH",
      body: JSON.stringify({ name: "Edited", apiKey: "" }),
    }));
    expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/v1/indexers/idx-1", expect.objectContaining({
      method: "DELETE",
      body: "{}",
    }));
  });
});
