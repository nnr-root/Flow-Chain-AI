/* The pure part of `npm run studio:local`: what each process of a studio on this machine is given, and what it is not. */

export type LocalInputs = {
  /** This machine's `.env`: the provider keys, and whatever else is in it. */
  env: Record<string, string>;
  /** The LOCAL Supabase stack (`npx supabase status`), never a hosted project. */
  supabase: { url: string; anonKey: string; serviceKey: string };
  redisUrl: string;
  /** The signing secret `stripe listen` forwards with; absent when payments are left out. */
  stripeListenSecret?: string;
};

/** Settings that would point a local studio at something real, or at a server's layout: never passed on. */
const NEVER_LOCAL = [
  // a hosted project's keys in .env must not reach a studio that is meant to use the local database
  "SUPABASE_URL", "SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_DB_URL", "SUPABASE_DB_PASSWORD", "SUPABASE_ACCESS_TOKEN",
  // the real bucket: a local studio keeps its runs on this disk
  "STUDIO_BUCKET", "STUDIO_S3_ENDPOINT", "STUDIO_R2_ACCOUNT_ID", "STUDIO_R2_ACCESS_KEY_ID", "STUDIO_R2_SECRET_ACCESS_KEY",
  // the public name and login mode of a deployed studio
  "STUDIO_HOST", "STUDIO_AUTH", "STUDIO_SITE",
  // the endpoint made for the public address: locally the signing secret is `stripe listen`'s
  "STRIPE_WEBHOOK_SECRET", "STRIPE_WEBHOOK_ENDPOINT", "STRIPE_API_BASE",
  "REDIS_URL", "NODE_ENV",
];

/** A Supabase address on this machine. Anything else is refused: this command must never act on a hosted project. */
export function isLocalSupabase(url: string): boolean {
  return /^http:\/\/(127\.0\.0\.1|localhost):\d+\/?$/.test(url);
}

/**
 * The environment of the web app and of the worker, as on a server (2.x–3.4): the web app gets where the
 * accounts live, their public key and the Stripe key; the worker alone gets the provider keys and the key that
 * settles credit. Payments are on only with a test key and a listener's secret; a live key is never used here.
 */
export function localEnvs(input: LocalInputs): { web: Record<string, string>; worker: Record<string, string>; billing: boolean } {
  if (!isLocalSupabase(input.supabase.url)) throw new Error(`the Supabase address ${input.supabase.url} is not a local one: start the local stack with npm run db:start`);
  const own = Object.fromEntries(Object.entries(input.env).filter(([name, value]) => !NEVER_LOCAL.includes(name) && value.trim() !== ""));
  const stripeKey = own.STRIPE_SECRET_KEY?.trim() ?? "";
  const billing = /^(sk|rk)_test_/.test(stripeKey) && !!input.stripeListenSecret;
  const { STRIPE_SECRET_KEY: _key, ...providers } = own;
  const shared = {
    REDIS_URL: input.redisUrl,
    SUPABASE_URL: input.supabase.url,
    SUPABASE_ANON_KEY: input.supabase.anonKey,
    ...(billing ? { STRIPE_SECRET_KEY: stripeKey } : {}),
  };
  return {
    billing,
    web: {
      ...shared,
      STUDIO_ENGINE: own.PROVIDER_MODE === "runpod" ? "runpod" : "fal",
      ...(own.STUDIO_USER_JOBS ? { STUDIO_USER_JOBS: own.STUDIO_USER_JOBS } : {}),
      ...(billing ? { STRIPE_WEBHOOK_SECRET: input.stripeListenSecret! } : {}),
    },
    worker: {
      ...providers,
      ...shared,
      SUPABASE_SERVICE_ROLE_KEY: input.supabase.serviceKey,
      // the local database is shared with the tests' thousands of accounts: only those with a folder here are looked after
      WORKER_RECONCILE_KNOWN_USERS_ONLY: "1",
    },
  };
}
