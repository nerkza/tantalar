import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@tantalar/contracts": r("./packages/contracts/src/index.ts"),
      "@tantalar/config": r("./packages/config/src/index.ts"),
      "@tantalar/db": r("./packages/db/src/index.ts"),
      "@tantalar/plugin-sdk": r("./packages/plugin-sdk/src/index.ts"),
      "@tantalar/testkit": r("./packages/testkit/src/index.ts"),
    },
  },
  test: {
    include: ["tests/**/*.test.ts"],
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
