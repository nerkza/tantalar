import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

it("keeps metadata staging routes and rate limits separate", () => {
  const worker = JSON.parse(readFileSync("apps/metadata-gateway/wrangler.jsonc", "utf8"));
  expect(worker.env.staging.ratelimits[0].namespace_id).not.toBe(worker.ratelimits[0].namespace_id);
  expect(worker.env.staging.routes).toEqual([{ pattern: "metadata-staging.tantalar.app", custom_domain: true }]);
});
