import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // the studio (web/) imports the pipeline as @src and itself as @
  resolve: { alias: { "@src": resolve("src"), "@": resolve("web") } },
  test: {
    include: ["test/**/*.test.ts", "web/test/**/*.test.ts"],
    testTimeout: 180_000,
    hookTimeout: 180_000,
  },
});
