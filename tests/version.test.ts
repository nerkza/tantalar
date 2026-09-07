import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  formatStartupBanner,
  getVersionMetadata,
  TANTALAR_RELEASE,
} from "../apps/server/src/version.js";

const root = new URL("../", import.meta.url);

describe("Tantalar release version", () => {
  it("uses the root manifest as the release source of truth", () => {
    const manifest = JSON.parse(readFileSync(new URL("package.json", root), "utf8")) as {
      version: string;
      tantalarRelease: { label: string; channel: string };
    };

    expect(TANTALAR_RELEASE).toEqual({
      version: manifest.version,
      label: manifest.tantalarRelease.label,
      channel: manifest.tantalarRelease.channel,
    });
    expect(TANTALAR_RELEASE).toEqual({
      version: "0.0.1-alpha.0",
      label: "0.0.1 Alpha",
      channel: "alpha",
    });
  });

  it("reports exact supplied build metadata and rejects a version mismatch", () => {
    expect(
      getVersionMetadata({
        TANTALAR_BUILD_VERSION: "0.0.1-alpha.0",
        TANTALAR_BUILD_COMMIT: "0123456789abcdef",
        TANTALAR_BUILD_DATE: "2026-08-24T19:00:00Z",
      }),
    ).toMatchObject({
      version: "0.0.1-alpha.0",
      label: "0.0.1 Alpha",
      build: {
        version: "0.0.1-alpha.0",
        commit: "0123456789abcdef",
        builtAt: "2026-08-24T19:00:00Z",
      },
    });
    expect(() => getVersionMetadata({ TANTALAR_BUILD_VERSION: "9.9.9" })).toThrow(
      "does not match application version",
    );
    expect(
      formatStartupBanner("http://127.0.0.1:8790", {
        TANTALAR_BUILD_VERSION: "0.0.1-alpha.0",
        TANTALAR_BUILD_COMMIT: "0123456789abcdef",
      }),
    ).toBe(
      "Tantalar 0.0.1 Alpha (0.0.1-alpha.0; 0123456789abcdef) listening on http://127.0.0.1:8790\n",
    );
  });

  it("passes the deterministic repository consistency check", () => {
    expect(
      execFileSync(process.execPath, ["scripts/version.mjs", "check"], {
        cwd: root,
        encoding: "utf8",
      }),
    ).toContain("0.0.1 Alpha (0.0.1-alpha.0, alpha)");
  });

  it("updates every derived release marker through the bump command", () => {
    const fixture = mkdtempSync(join(tmpdir(), "tantalar-version-"));
    const files = [
      "package.json",
      "apps/server/package.json",
      "apps/web/package.json",
      "Dockerfile",
      "docker/compose.sqlite.yml",
      "docker/compose.postgres.yml",
      "README.md",
      "docs/release.md",
      "docs/deploy.md",
      "scripts/version.mjs",
    ];

    try {
      for (const file of files) {
        const target = join(fixture, file);
        mkdirSync(dirname(target), { recursive: true });
        cpSync(new URL(file, root), target);
      }
      execFileSync(
        process.execPath,
        ["scripts/version.mjs", "set", "0.0.2-alpha.0", "0.02 Alpha", "alpha"],
        { cwd: fixture },
      );
      expect(
        execFileSync(process.execPath, ["scripts/version.mjs", "check"], {
          cwd: fixture,
          encoding: "utf8",
        }),
      ).toContain("0.02 Alpha (0.0.2-alpha.0, alpha)");
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });
});
