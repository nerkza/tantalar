import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DownloadClientError } from "@tantalar/contracts";

/** Call only after the client's VPN gate. Private HTTP indexers are supported. */
export async function cacheReleaseSource(source: string, root: string, extension: ".nzb" | ".torrent", maxBytes: number): Promise<string> {
  if (!root || !lstatSync(root).isDirectory() || lstatSync(root).isSymbolicLink()) {
    throw new DownloadClientError("blocked", "configured download root is not a regular directory");
  }
  const signal = AbortSignal.timeout(15_000);
  let body: Buffer | undefined;
  try {
    let url = new URL(source);
    for (let redirects = 0; redirects <= 3; redirects++) {
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("invalid URL");
      const response = await fetch(url, { redirect: "manual", signal });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel();
        const location = response.headers.get("location");
        if (!location) throw new Error("missing redirect");
        const next = new URL(location, url);
        if (url.protocol === "https:" && next.protocol !== "https:") throw new Error("insecure redirect");
        url = next;
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new DownloadClientError("unavailable", `Indexer release fetch failed (HTTP ${response.status}).`);
      }
      if (!response.body || Number(response.headers.get("content-length")) > maxBytes) {
        await response.body?.cancel();
        throw new DownloadClientError("invalid_request", "Indexer release file exceeds the metadata size limit.");
      }
      const chunks: Uint8Array[] = [];
      let size = 0;
      const reader = response.body.getReader();
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > maxBytes) {
          await reader.cancel();
          throw new DownloadClientError("invalid_request", "Indexer release file exceeds the metadata size limit.");
        }
        chunks.push(chunk.value);
      }
      body = Buffer.concat(chunks);
      break;
    }
    if (!body?.length) throw new Error("empty response or redirect limit");
  } catch (error) {
    if (error instanceof DownloadClientError) throw error;
    // Never expose the indexer's URL, API key, redirect target, or response body.
    throw new DownloadClientError("unavailable", "Indexer release fetch failed. Check the indexer connection and retry.");
  }
  const directory = join(root, ".tantalar-sources");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (lstatSync(directory).isSymbolicLink() || !lstatSync(directory).isDirectory()) throw new DownloadClientError("blocked", "release cache is not a regular directory");
  const path = join(directory, `${createHash("sha256").update(body).digest("hex")}${extension}`);
  try { writeFileSync(path, body, { flag: "wx", mode: 0o600 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size !== body.length || !readFileSync(path).equals(body)) throw new DownloadClientError("blocked", "release cache file failed verification");
  }
  // ponytail: keep bounded source files for durable retry; add reference-based cleanup when cache size requires it.
  return path;
}
