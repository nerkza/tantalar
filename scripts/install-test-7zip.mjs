// CI-only external tool installation. No executable enters Tantalar artifacts (ADR-0016).
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const hashes = {
  x64: "dc99eff5008f1ab79bd7084c68513701547a808a89502bf4133683535ab3c695",
  arm64: "2389ba20e4d8295e8709c20b6263b69bd1ec4972fe38a04ad7a1badbf595b996",
};
if (process.platform !== "linux" || !hashes[process.arch]) throw new Error("This CI installer supports Linux x64 and arm64.");
const root = resolve(process.env.RUNNER_TEMP, "tantalar-test-7zip");
mkdirSync(root, { recursive: true });
const response = await fetch(`https://www.7-zip.org/a/7z2603-linux-${process.arch}.tar.xz`, { signal: AbortSignal.timeout(60_000) });
if (!response.ok) throw new Error(`7-Zip download failed: HTTP ${response.status}`);
const bytes = Buffer.from(await response.arrayBuffer());
if (createHash("sha256").update(bytes).digest("hex") !== hashes[process.arch]) throw new Error("7-Zip checksum mismatch.");
writeFileSync(join(root, "7zip.tar.xz"), bytes);
execFileSync("tar", ["-xJf", join(root, "7zip.tar.xz"), "-C", root]);
appendFileSync(process.env.GITHUB_PATH, `${root}\n`);
