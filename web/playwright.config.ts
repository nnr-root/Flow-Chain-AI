import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "@playwright/test";

const web = dirname(fileURLToPath(import.meta.url));
const runs = join(web, ".e2e/runs");
const PORT = 3132;

/**
 * One browser flow against the built studio. The server gets a fixture runs folder and the stub CLI, so no
 * action started from the page can reach a provider; bundled fonts and sound effects come from the real repo.
 */
export default defineConfig({
  testDir: "e2e",
  timeout: 60_000,
  workers: 1,
  reporter: "list",
  outputDir: "test-results",
  use: { baseURL: `http://127.0.0.1:${PORT}`, viewport: { width: 1400, height: 1000 } },
  webServer: {
    command: `node --import tsx e2e/make-fixtures.ts ${runs} && npx next build --webpack && npx next start -H 127.0.0.1 -p ${PORT}`,
    url: `http://127.0.0.1:${PORT}/api/health`,
    timeout: 300_000,
    reuseExistingServer: false,
    stdout: "ignore",
    env: {
      FLOWCHAIN_ROOT: join(web, ".."),
      RUNS_DIR: runs,
      FLOWCHAIN_CLI: join(web, "test/stub-cli.mjs"),
      BRAND_KITS_DIR: join(web, ".e2e/brand-kits"),
      STUDIO_UPLOADS_DIR: join(web, ".e2e/uploads"),
    },
  },
});
