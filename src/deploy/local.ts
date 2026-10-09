/* The pure part of `npm run studio:local`: what each process of a studio on this machine is given, and what it is not. */

import { isLocalDatabase } from "./db.js";
import { RETIRED_KEYS } from "./server.js";

export type LocalInputs = {
  /** This machine's `.env`: the provider keys, and whatever else is in it. */
  env: Record<string, string>;
  /** The LOCAL database (`npm run db:start`), never a server's: the web app's address of it and the worker's. */
  database: { web: string; worker: string };
  redisUrl: string;
  /** The signing secret `stripe listen` forwards with; absent when payments are left out. */
  stripeListenSecret?: string;
};

/** Settings that would point a local studio at something real, or at a server's layout: never passed on. */
const NEVER_LOCAL = [
  // an address of a database in .env must not reach a studio that is meant to use the local one
  "DATABASE_URL",
  // a real mail server: a studio on this machine sends nothing, and takes an address at its word
  "SMTP_URL", "MAIL_FROM", "MAIL_DIR",
  // the real bucket: a local studio keeps its runs on this disk
  "STUDIO_BUCKET", "STUDIO_S3_ENDPOINT", "STUDIO_R2_ACCOUNT_ID", "STUDIO_R2_ACCESS_KEY_ID", "STUDIO_R2_SECRET_ACCESS_KEY",
  // the public name and login mode of a deployed studio
  "STUDIO_HOST", "STUDIO_AUTH", "STUDIO_SITE",
  // the endpoint made for the public address: locally the signing secret is `stripe listen`'s
  "STRIPE_WEBHOOK_SECRET", "STRIPE_WEBHOOK_ENDPOINT", "STRIPE_API_BASE",
  "REDIS_URL", "NODE_ENV",
  ...RETIRED_KEYS,
];

/**
 * The environment of the web app and of the worker, as on a server (2.x–3.4): the web app gets its own
 * address of the database (a role that cannot settle or grant) and the Stripe key; the worker alone gets the
 * provider keys and the address that can settle credit. Payments are on only with a test key and a listener's secret; a live key is never used here.
 */
export function localEnvs(input: LocalInputs): { web: Record<string, string>; worker: Record<string, string>; billing: boolean } {
  for (const url of Object.values(input.database)) {
    if (!isLocalDatabase(url)) throw new Error("the database address is not the local one: start the local database with npm run db:start");
  }
  const own = Object.fromEntries(Object.entries(input.env).filter(([name, value]) => !NEVER_LOCAL.includes(name) && value.trim() !== ""));
  const stripeKey = own.STRIPE_SECRET_KEY?.trim() ?? "";
  const billing = /^(sk|rk)_test_/.test(stripeKey) && !!input.stripeListenSecret;
  // Google sign-in is the web app's; everything else that is left is a provider's key or setting, the worker's
  const { STRIPE_SECRET_KEY: _key, GOOGLE_CLIENT_ID: googleId, GOOGLE_CLIENT_SECRET: googleSecret, ...providers } = own;
  const shared = {
    REDIS_URL: input.redisUrl,
    ...(billing ? { STRIPE_SECRET_KEY: stripeKey } : {}),
  };
  return {
    billing,
    web: {
      ...shared,
      DATABASE_URL: input.database.web,
      ...(googleId && googleSecret ? { GOOGLE_CLIENT_ID: googleId, GOOGLE_CLIENT_SECRET: googleSecret } : {}),
      ...(own.STUDIO_USER_JOBS ? { STUDIO_USER_JOBS: own.STUDIO_USER_JOBS } : {}),
      ...(billing ? { STRIPE_WEBHOOK_SECRET: input.stripeListenSecret! } : {}),
    },
    worker: {
      ...providers,
      ...shared,
      DATABASE_URL: input.database.worker,
      // the local database is shared with the tests' thousands of accounts: only those with a folder here are looked after
      WORKER_RECONCILE_KNOWN_USERS_ONLY: "1",
    },
  };
}
