import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cacheReleaseSource } from "../packages/plugin-sdk/src/release-source.js";

afterEach(() => vi.unstubAllGlobals());

it("fetches bounded release files through redirects and redacts failed sources", async () => {
  const root = mkdtempSync(join(tmpdir(), "tantalar-source-"));
  const source = "https://indexer.invalid/api?apikey=private-key";
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  try {
    for (const extension of [".nzb", ".torrent"] as const) {
      fetcher.mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: "/file" } }))
        .mockResolvedValueOnce(new Response("fixture"));
      const file = await cacheReleaseSource(source, root, extension, 10);
      expect(file).toMatch(new RegExp(`\\${extension}$`));
      expect(readFileSync(file, "utf8")).toBe("fixture");
      expect(fetcher.mock.lastCall?.[0].href).toBe("https://indexer.invalid/file");
    }
    fetcher.mockResolvedValueOnce(new Response("oversized fixture"));
    await expect(cacheReleaseSource(source, root, ".nzb", 10)).rejects.toThrow("metadata size limit");
    fetcher.mockResolvedValueOnce(new Response(null, { status: 403 }));
    await expect(cacheReleaseSource(source, root, ".nzb", 10)).rejects.toThrow("HTTP 403");
    fetcher.mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: "http://indexer.invalid/private-key" } }));
    await expect(cacheReleaseSource(source, root, ".nzb", 10)).rejects.toThrow(/^Indexer release fetch failed\. Check the indexer connection and retry\.$/);
    await expect(cacheReleaseSource("invalid private-key", root, ".nzb", 10)).rejects.toThrow(/^Indexer release fetch failed\. Check the indexer connection and retry\.$/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
