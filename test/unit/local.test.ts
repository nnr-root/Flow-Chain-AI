import { describe, expect, it } from "vitest";
import { isLocalSupabase, localEnvs } from "../../src/deploy/local.js";

const supabase = { url: "http://127.0.0.1:54321", anonKey: "anon", serviceKey: "service" };
const env = {
  GEMINI_API_KEY: "g", FAL_KEY: "f", ELEVENLABS_API_KEY: "e", RUNPOD_API_KEY: "r", PROVIDER_MODE: "runpod", R2_ACCESS_KEY_ID: "r2",
  STRIPE_SECRET_KEY: "sk_test_x", STRIPE_WEBHOOK_SECRET: "whsec_for_the_public_address", STRIPE_WEBHOOK_ENDPOINT: "we_1",
  SUPABASE_URL: "https://hosted.supabase.co", SUPABASE_ANON_KEY: "hosted-anon", SUPABASE_SERVICE_ROLE_KEY: "hosted-service", SUPABASE_DB_URL: "postgresql://x",
  STUDIO_BUCKET: "real-bucket", STUDIO_R2_SECRET_ACCESS_KEY: "s", STUDIO_HOST: "getflowchain.com", EMPTY: " ",
};
const input = { env, supabase, redisUrl: "redis://127.0.0.1:6399", stripeListenSecret: "whsec_listen" };

describe("a studio on this machine", () => {
  it("gives the web app no provider key and no key that settles credit; the worker has both", () => {
    const { web, worker, billing } = localEnvs(input);
    expect(billing).toBe(true);
    expect(web).toEqual({
      REDIS_URL: "redis://127.0.0.1:6399", SUPABASE_URL: supabase.url, SUPABASE_ANON_KEY: "anon",
      STRIPE_SECRET_KEY: "sk_test_x", STRIPE_WEBHOOK_SECRET: "whsec_listen",
    });
    expect(worker).toMatchObject({ GEMINI_API_KEY: "g", RUNPOD_API_KEY: "r", SUPABASE_SERVICE_ROLE_KEY: "service", SUPABASE_URL: supabase.url, STRIPE_SECRET_KEY: "sk_test_x" });
    // the listener's secret is the web app's alone, as on a server
    expect(worker).not.toHaveProperty("STRIPE_WEBHOOK_SECRET");
  });

  it("never points at anything hosted: not the project in .env, not the real bucket, not the public name", () => {
    const { web, worker } = localEnvs(input);
    for (const process of [web, worker]) {
      expect(process.SUPABASE_URL).toBe("http://127.0.0.1:54321");
      for (const name of ["STUDIO_BUCKET", "STUDIO_R2_SECRET_ACCESS_KEY", "STUDIO_HOST", "SUPABASE_DB_URL", "STRIPE_WEBHOOK_ENDPOINT", "EMPTY"]) expect(process, name).not.toHaveProperty(name);
      expect(JSON.stringify(process)).not.toMatch(/hosted|real-bucket|getflowchain|whsec_for_the_public_address/);
    }
    expect(() => localEnvs({ ...input, supabase: { ...supabase, url: "https://hosted.supabase.co" } })).toThrow("is not a local one");
    expect(isLocalSupabase("http://localhost:54321/")).toBe(true);
    for (const not of ["https://127.0.0.1:54321", "http://127.0.0.1.evil.example:54321", "http://example.com:54321", ""]) expect(isLocalSupabase(not)).toBe(false);
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
    for (const name of ["FAL_KEY", "PROVIDER_MODE"]) expect(localEnvs(input).worker, name).not.toHaveProperty(name);
  });
});
