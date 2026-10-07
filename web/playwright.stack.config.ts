import { defineConfig } from "@playwright/test";
import { HOST, PASSWORD, PORT, USER } from "./stack/stack";

/**
 * The whole deployment on this machine (`npm run test:stack`; needs Docker): the Compose stack is built and
 * started by the global setup, and the browser goes through the proxy's login like a user would.
 */
export default defineConfig({
  testDir: "stack",
  testMatch: "*.spec.ts",
  timeout: 120_000,
  workers: 1,
  reporter: "list",
  outputDir: "test-results",
  globalSetup: "./stack/setup.ts",
  globalTeardown: "./stack/teardown.ts",
  globalTimeout: 30 * 60_000,
  use: {
    baseURL: `http://${HOST}:${PORT}`, viewport: { width: 1400, height: 1000 }, httpCredentials: { username: USER, password: PASSWORD },
    // No sound card needed: with a real audio device Chromium paces playback by it, and when that device stalls
    // (a sleeping laptop, a CI machine without one) the Player waits at frame 0 for ever.
    launchOptions: { args: ["--disable-audio-output", `--host-resolver-rules=MAP ${HOST} 127.0.0.1`] },
  },
});
