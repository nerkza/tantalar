import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { loadConfig } from "@tantalar/config";
import { parseConfigYaml } from "@tantalar/config";
import { expect, it } from "vitest";

it("keeps staging data, metadata and network access separate", () => {
  const { config } = loadConfig({ hostFile: "docker/staging.yaml", env: {} });
  expect(config).toMatchObject({
    database: { dialect: "sqlite", sqlite: { path: "/data/tantalar.db" } },
    plugins: { set: { "dev.tantalar.plugin.metadata-tmdb-tvdb": {
      enabled: true,
      config: { metadataGatewayUrl: "https://metadata-staging.tantalar.app/v1/tmdb" },
    } } },
  });
  const compose = parseConfigYaml(readFileSync("docker/compose.staging.yml", "utf8"));
  expect(compose).toMatchObject({
    name: "tantalar-staging",
    services: { tantalar: {
      ports: ["127.0.0.1:8791:8790"],
      volumes: ["staging-data:/data", "./staging.yaml:/config/tantalar.yaml:ro"],
    } },
  });
  const worker = JSON.parse(readFileSync("apps/metadata-gateway/wrangler.jsonc", "utf8"));
  expect(worker.env.staging.ratelimits[0].namespace_id).not.toBe(worker.ratelimits[0].namespace_id);
  expect(worker.env.staging.routes).toEqual([{ pattern: "metadata-staging.tantalar.app", custom_domain: true }]);
});

it("rejects mutable tags and invalid deployment arguments before Docker runs", () => {
  for (const [image, commit] of [
    ["ghcr.io/nerkza/tantalar:latest", "a".repeat(40)],
    ["a".repeat(64), "a".repeat(40)],
    [`ghcr.io/other/image@sha256:${"a".repeat(64)}`, "a".repeat(40)],
    [`ghcr.io/nerkza/tantalar@sha256:${"a".repeat(64)}`, "main"],
  ]) {
    const result = spawnSync("sh", ["scripts/deploy-staging.sh", image, commit], { encoding: "utf8" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Invalid");
  }
});
