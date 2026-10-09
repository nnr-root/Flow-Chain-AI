import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "@playwright/test";
import { LOCAL_DB, localUrls } from "@src/deploy/db";

const web = dirname(fileURLToPath(import.meta.url));
export const data = join(web, ".e2e/accounts");
const PORT = 3133;
const REDIS_PORT = 6391;
const STRIPE_PORT = 3134;

/** The local database (`npm run db:start`), each service by its own role; this test never touches a server. */
try {
  execFileSync("docker", ["exec", LOCAL_DB.container, "pg_isready", "-h", "127.0.0.1", "-U", "postgres", "-d", LOCAL_DB.database], { stdio: "ignore", timeout: 20_000 });
} catch {
  throw new Error("the local database is not running: start it with `npm run db:start`");
}
const database = localUrls();

const shared = {
  FLOWCHAIN_ROOT: join(web, ".."),
  RUNS_DIR: join(data, "runs"),
  BRAND_KITS_DIR: join(data, "brand-kits"),
  STUDIO_UPLOADS_DIR: join(data, "uploads"),
  REDIS_URL: `redis://127.0.0.1:${REDIS_PORT}`,
  // the web app's own address of the database: a role that can neither settle nor grant
  DATABASE_URL: database.web,
  // one test turns welcome credit on and looks at the page at once: the page must ask the database each time
  WELCOME_OFFER_TTL_MS: "0",
  // payments go to the stand-in Stripe below: these keys open nothing anywhere else
  STRIPE_SECRET_KEY: "sk_test_standin",
  STRIPE_API_BASE: `http://127.0.0.1:${STRIPE_PORT}`,
};
const WEBHOOK_SECRET = "whsec_standin";

/**
 * The studio with accounts in a real browser (`npm run test:accounts`): sign-up, the session, the proxy's
 * redirect, credit, buying credit, and isolation between two users. Needs the local database and
 * `redis-server`. The worker runs the stand-in CLI and payments go to a stand-in Stripe, so nothing can reach a
 * provider or charge anything.
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
      // Stripe's stand-in: its checkout page pays at once and calls the studio's webhook, signed, as Stripe would
      command: "node --import tsx test/stripe-server.ts",
      port: STRIPE_PORT,
      timeout: 60_000,
      reuseExistingServer: false,
      stdout: "ignore",
      env: { STRIPE_SECRET_KEY: shared.STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET, FAKE_STRIPE_PORT: String(STRIPE_PORT), FAKE_STRIPE_DELIVER_TO: `http://127.0.0.1:${PORT}/api/stripe/webhook`, FAKE_STRIPE_DELIVER_AFTER_MS: "1500" },
    },
    {
      // The worker first, in the background (it has no port to wait for), then the built studio. The worker alone
      // gets the database address that settles credit and the provider keys' stand-ins; the web process gets neither.
      command: [
        `(DATABASE_URL="$WORKER_DATABASE_URL" FLOWCHAIN_CLI="$WORKER_CLI" WORKER_RECONCILE_MS=2000 WORKER_RECONCILE_KNOWN_USERS_ONLY=1`,
        `GEMINI_API_KEY=t ELEVENLABS_API_KEY=t ELEVENLABS_VOICE_ID=t RUNPOD_API_KEY=t RUNPOD_KEYFRAME_ENDPOINT=t RUNPOD_CLIP_ENDPOINT=t R2_ACCOUNT_ID=t R2_BUCKET=t R2_ACCESS_KEY_ID=t R2_SECRET_ACCESS_KEY=t node --import tsx worker/main.ts > ${data}/worker.log 2>&1 &)`,
        // the signing secret is the web app's alone: the worker never sees a webhook
        `; npx next build --webpack && STRIPE_WEBHOOK_SECRET="$WEB_WEBHOOK_SECRET" exec npx next start -H 127.0.0.1 -p ${PORT}`,
      ].join(" "),
      url: `http://127.0.0.1:${PORT}/login`,
      timeout: 300_000,
      reuseExistingServer: false,
      stdout: "ignore",
      env: { ...shared, WORKER_DATABASE_URL: database.worker, WORKER_CLI: join(web, "test/stub-cli.mjs"), WEB_WEBHOOK_SECRET: WEBHOOK_SECRET },
    },
  ],
});
