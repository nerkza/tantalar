/**
 * Phase 2 contract, SDK, and packaging security tests.
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PROTOCOL_VERSION,
  validateManifest,
  isContractCompatible,
  isValidSemver,
} from "@tantalar/contracts";
import {
  packPlugin,
  verifyTpkEntries,
  PackageError,
  installDirFor,
  extractTo,
} from "@tantalar/plugin-sdk";

const goodManifest = {
  id: "dev.tantalar.plugin.sample",
  version: "1.0.0",
  protocolVersion: PROTOCOL_VERSION,
  provides: ["dev.tantalar.capability.sample.ping"],
  requires: ["dev.tantalar.capability.event.emit"],
  subscriptions: [],
  entry: { command: "node dist/plugin.js" },
};

describe("contract compatibility (ADR-0004 semver rule)", () => {
  it("accepts same major", () => {
    expect(isContractCompatible(1, 1)).toBe(true);
  });
  it("rejects any major mismatch", () => {
    expect(isContractCompatible(1, 2)).toBe(false);
    expect(isContractCompatible(2, 1)).toBe(false);
  });
});

describe("manifest hardening", () => {
  it("rejects non-semver versions", () => {
    expect(() => validateManifest({ ...goodManifest, version: "not-semver" })).toThrow(/semver/);
    expect(isValidSemver("0.1.0")).toBe(true);
    expect(isValidSemver("1.0")).toBe(false);
  });
  it("rejects empty provides", () => {
    expect(() => validateManifest({ ...goodManifest, provides: [] })).toThrow(/provides/);
  });
  it("rejects duplicate provided capabilities (identifier collision)", () => {
    expect(() =>
      validateManifest({
        ...goodManifest,
        provides: ["dev.tantalar.capability.a.x", "dev.tantalar.capability.a.x"],
      }),
    ).toThrow(/duplicate/);
  });
  it("rejects provide/require overlap", () => {
    expect(() =>
      validateManifest({
        ...goodManifest,
        provides: ["dev.tantalar.capability.a.x"],
        requires: ["dev.tantalar.capability.a.x"],
      }),
    ).toThrow(/both provided and required/);
  });
  it("rejects path traversal in entry", () => {
    expect(() =>
      validateManifest({ ...goodManifest, entry: { command: "node ../evil/plugin.js" } }),
    ).toThrow(/traversal/);
    expect(() =>
      validateManifest({ ...goodManifest, entry: { command: "node dist/../evil.js" } }),
    ).toThrow(/traversal/);
  });
  it("still accepts the well-formed manifest", () => {
    expect(validateManifest(goodManifest).id).toBe(goodManifest.id);
  });
});

function writePackage(dir: string, manifest: unknown): string {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest));
  mkdirSync(join(dir, "dist"), { recursive: true });
  writeFileSync(join(dir, "dist/plugin.js"), "console.log('x')");
  return dir;
}

describe(".tpk packaging security", () => {
  it("packs a valid package deterministically with a stable hash", async () => {
    const dir = writePackage(join(mkdtempSync(join(tmpdir(), "tpk-")), "pkg"), goodManifest);
    const a = await packPlugin(dir);
    const b = await packPlugin(dir);
    expect(a.sha256).toBe(b.sha256);
    expect(a.entries.map((e) => e.name)).toContain("manifest.json");
  });

  it("verifies a packed archive round-trip", async () => {
    const dir = writePackage(join(mkdtempSync(join(tmpdir(), "tpk-")), "pkg"), goodManifest);
    const { entries } = await packPlugin(dir);
    const verified = await verifyTpkEntries(entries);
    expect(verified.manifest.id).toBe(goodManifest.id);
  });

  it("rejects traversal member names on verify", async () => {
    const dir = writePackage(join(mkdtempSync(join(tmpdir(), "tpk-")), "pkg"), goodManifest);
    const { entries } = await packPlugin(dir);
    await expect(
      verifyTpkEntries([...entries, { name: "../../etc/passwd", data: Buffer.from("x") }]),
    ).rejects.toThrow(PackageError);
  });

  it("rejects absolute member paths", async () => {
    await expect(
      verifyTpkEntries([{ name: "/etc/passwd", data: Buffer.from("x") }, { name: "manifest.json", data: Buffer.from(JSON.stringify(goodManifest)) }]),
    ).rejects.toThrow(PackageError);
  });

  it("rejects duplicate members", async () => {
    const m = Buffer.from(JSON.stringify(goodManifest));
    await expect(verifyTpkEntries([{ name: "manifest.json", data: m }, { name: "manifest.json", data: m }])).rejects.toThrow(/duplicate/);
  });

  it("refuses to pack a directory containing symlinks", async () => {
    const root = mkdtempSync(join(tmpdir(), "tpk-symlink-"));
    const dir = join(root, "pkg");
    writePackage(dir, goodManifest);
    symlinkSync("/etc/hosts", join(dir, "link"));
    await expect(packPlugin(dir)).rejects.toThrow(PackageError);
  });

  it("extracts entries only inside the destination", async () => {
    const dest = mkdtempSync(join(tmpdir(), "tpk-extract-"));
    const m = Buffer.from(JSON.stringify(goodManifest));
    await extractTo([{ name: "sub/manifest.json", data: m }], dest);
    const stat = await (await import("node:fs/promises")).stat(join(dest, "sub/manifest.json"));
    expect(stat.isFile()).toBe(true);
  });
});

describe("install layout", () => {
  it("maps plugin ids into nested safe dirs", () => {
    expect(installDirFor("/srv/plugins", "dev.tantalar.plugin.x").endsWith("dev/tantalar/plugin/x")).toBe(true);
  });
  it("rejects unsafe ids", () => {
    expect(() => installDirFor("/srv/plugins", "../evil")).toThrow(PackageError);
    expect(() => installDirFor("/srv/plugins", "a/b/c")).toThrow(PackageError);
  });
});
