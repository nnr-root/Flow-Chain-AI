import { describe, expect, it } from "vitest";
import { isLocalDatabase, localUrls } from "../../src/deploy/db.js";
import { localEnvs } from "../../src/deploy/local.js";

const database = { web: localUrls().web, worker: localUrls().worker };
const env = {
  GEMINI_API_KEY: "g", FAL_KEY: "f", ELEVENLABS_API_KEY: "e", RUNPOD_API_KEY: "r", PROVIDER_MODE: "runpod", R2_ACCESS_KEY_ID: "r2",
  STRIPE_SECRET_KEY: "sk_test_x", STRIPE_WEBHOOK_SECRET: "whsec_for_the_public_address", STRIPE_WEBHOOK_ENDPOINT: "we_1",
  DATABASE_URL: "postgres://studio_web:real@db.example.com:5432/flowchain", SMTP_URL: "smtps://real@smtp.example.com", MAIL_FROM: "x@example.com",
  GOOGLE_CLIENT_ID: "gid", GOOGLE_CLIENT_SECRET: "gsecret",
  STUDIO_BUCKET: "real-bucket", STUDIO_R2_SECRET_ACCESS_KEY: "s", STUDIO_HOST: "getflowchain.com", EMPTY: " ",
};
const input = { env, database, redisUrl: "redis://127.0.0.1:6399", stripeListenSecret: "whsec_listen" };

describe("a studio on this machine", () => {
  it("gives the web app no provider key and no key that settles credit; the worker has both", () => {
    const { web, worker, billing } = localEnvs(input);
    expect(billing).toBe(true);
    expect(web).toEqual({
      REDIS_URL: "redis://127.0.0.1:6399", DATABASE_URL: database.web, GOOGLE_CLIENT_ID: "gid", GOOGLE_CLIENT_SECRET: "gsecret",
      STRIPE_SECRET_KEY: "sk_test_x", STRIPE_WEBHOOK_SECRET: "whsec_listen",
    });
    expect(worker).toMatchObject({ GEMINI_API_KEY: "g", RUNPOD_API_KEY: "r", DATABASE_URL: database.worker, STRIPE_SECRET_KEY: "sk_test_x" });
    // the address that can settle credit is the worker's alone, and Google sign-in is the web app's alone
    expect(web.DATABASE_URL).not.toBe(worker.DATABASE_URL);
    expect(worker).not.toHaveProperty("GOOGLE_CLIENT_SECRET");
    // the listener's secret is the web app's alone, as on a server
    expect(worker).not.toHaveProperty("STRIPE_WEBHOOK_SECRET");
  });

  it("never points at anything hosted: not the project in .env, not the real bucket, not the public name", () => {
    const { web, worker } = localEnvs(input);
    for (const process of [web, worker]) {
      expect(isLocalDatabase(process.DATABASE_URL)).toBe(true);
      for (const name of ["STUDIO_BUCKET", "STUDIO_R2_SECRET_ACCESS_KEY", "STUDIO_HOST", "SMTP_URL", "MAIL_FROM", "STRIPE_WEBHOOK_ENDPOINT", "EMPTY"]) expect(process, name).not.toHaveProperty(name);
      expect(JSON.stringify(process)).not.toMatch(/hosted|real-bucket|getflowchain|whsec_for_the_public_address/);
    }
    expect(() => localEnvs({ ...input, database: { ...database, worker: "postgres://studio_worker:real@db.example.com:5432/flowchain" } })).toThrow("is not the local one");
    expect(isLocalDatabase("postgres://postgres:x@localhost:54330/flowchain")).toBe(true);
    for (const not of ["postgres://postgres:x@127.0.0.1:5432/flowchain", "postgres://x@127.0.0.1.evil.example:54330/flowchain", "postgres://x@db.example.com:54330/flowchain", "http://127.0.0.1:54330/", ""]) expect(isLocalDatabase(not), not).toBe(false);
  });

  it("takes payments only with a test key and a listener; a live key is left out altogether", () => {
    expect(localEnvs({ ...input, stripeListenSecret: undefined })).toMatchObject({ billing: false });
    expect(localEnvs({ ...input, stripeListenSecret: undefined }).web).not.toHaveProperty("STRIPE_SECRET_KEY");
    for (const key of ["sk_live_x", "rk_live_x", "sk_tset_typo", ""]) {
      const { web, worker, billing } = localEnvs({ ...input, env: { ...env, STRIPE_SECRET_KEY: key } });
      expect(billing, key).toBe(false);
      expect(web).not.toHaveProperty("STRIPE_SECRET_KEY");
      expect(worker).not.toHaveProperty("STRIPE_SECRET_KEY");
    }
    // a key of the hosted models the studio stopped using is still in this .env: no process is handed it
    for (const name of ["FAL_KEY", "PROVIDER_MODE", "ELEVENLABS_API_KEY"]) expect(localEnvs(input).worker, name).not.toHaveProperty(name);
  });
});
