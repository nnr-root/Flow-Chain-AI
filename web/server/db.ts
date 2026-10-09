import { Db } from "@src/db/client";

/* The web app's connection to the studio's database, as the role `studio_web` (phase 5 spec §4.2). */

// one pool per address and per process, also when a bundler loads this module more than once
const KEY = Symbol.for("flowchain.studio.db");
const shared = globalThis as { [KEY]?: Map<string, Db> };
const pools = (shared[KEY] ??= new Map<string, Db>());

/**
 * The database with nobody's name on the question: the sign-in functions, and what any visitor may ask. For a
 * signed-in user's own rows use `userDb()`, which asks in that user's name.
 */
export function db(): Db {
  const url = process.env.DATABASE_URL?.trim();
  if (!url) throw new Error("DATABASE_URL is not set: this studio has no accounts");
  let pool = pools.get(url);
  if (!pool) pools.set(url, (pool = Db.connect(url)));
  return pool;
}
