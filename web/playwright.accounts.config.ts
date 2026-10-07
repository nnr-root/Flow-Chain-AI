import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "@playwright/test";

const web = dirname(fileURLToPath(import.meta.url));
export const data = join(web, ".e2e/accounts");
const PORT = 3133;
const REDIS_PORT = 6391;

/** The local Supabase stack's address and keys (`npm run db:start`); this test never touches a hosted project. */
function localSupabase(): { url: string; anonKey: string; serviceKey: string } {
  let out: string;
  try {
    out = execFileSync("npx", ["supabase", "status", "-o", "env"], { cwd: join(web, ".."), encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    throw new Error("the local Supabase stack is not running: start it with `npm run db:start`");
  }
  const value = (name: string) => new RegExp(`^${name}="?([^"\n]+)"?$`, "m").exec(out)?.[1] ?? "";
  const url = value("API_URL");
  if (!/^http:\/\/(127\.0\.0\.1|localhost):/.test(url)) throw new Error("the Supabase address is not a local one");
  return { url, anonKey: value("ANON_KEY"), serviceKey: value("SERVICE_ROLE_KEY") };
}
const supabase = localSupabase();
process.env.ACCOUNTS_SUPABASE_URL = supabase.url;
process.env.ACCOUNTS_SERVICE_KEY = supabase.serviceKey;

const shared = {
  FLOWCHAIN_ROOT: join(web, ".."),
  RUNS_DIR: join(data, "runs"),
  BRAND_KITS_DIR: join(data, "brand-kits"),
  STUDIO_UPLOADS_DIR: join(data, "uploads"),
  REDIS_URL: `redis://127.0.0.1:${REDIS_PORT}`,
  SUPABASE_URL: supabase.url,
  SUPABASE_ANON_KEY: supabase.anonKey,
};

/**
 * The studio with accounts in a real browser (`npm run test:accounts`): sign-up, the session, the proxy's
 * redirect, credit and isolation between two users. Needs the local Supabase stack and `redis-server`. The
 * worker runs the stand-in CLI, so nothing can reach a provider.
 */
export default defineConfig({
  testDir: "accounts",
  testMatch: "*.spec.ts",
  timeout: 120_000,
  workers: 1,
  reporter: "list",
  outputDir: "test-results",
  use: {
    baseURL: `http://127.0.0.1:${PORT}`, viewport: { width: 1400, height: 1000 },
    launchOptions: { args: ["--disable-audio-output"] },
  },
  webServer: [
    {
      command: `rm -rf ${data} && mkdir -p ${data}/redis && node --import tsx e2e/make-fixtures.ts ${data}/fixtures/runs && redis-server --port ${REDIS_PORT} --bind 127.0.0.1 --dir ${data}/redis --save ""`,
      port: REDIS_PORT,
      timeout: 120_000,
      reuseExistingServer: false,
      stdout: "ignore",
    },
    {
      // The worker first, in the background (it has no port to wait for), then the built studio. The worker alone
      // gets the key that settles credit and the provider keys' stand-ins; the web process gets neither.
      command: [
        `(SUPABASE_SERVICE_ROLE_KEY="$WORKER_SERVICE_KEY" FLOWCHAIN_CLI="$WORKER_CLI" WORKER_RECONCILE_MS=2000`,
        `GEMINI_API_KEY=t ELEVENLABS_API_KEY=t ELEVENLABS_VOICE_ID=t FAL_KEY=t node --import tsx worker/main.ts > ${data}/worker.log 2>&1 &)`,
        `; npx next build --webpack && exec npx next start -H 127.0.0.1 -p ${PORT}`,
      ].join(" "),
      url: `http://127.0.0.1:${PORT}/login`,
      timeout: 300_000,
      reuseExistingServer: false,
      stdout: "ignore",
      env: { ...shared, WORKER_SERVICE_KEY: supabase.serviceKey, WORKER_CLI: join(web, "test/stub-cli.mjs") },
    },
  ],
});
