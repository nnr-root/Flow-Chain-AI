import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { hashPassword } from "../../src/auth/passwords.js";
import { Db } from "../../src/db/client.js";
import { LOCAL_DB, localUrls } from "../../src/deploy/db.js";

/* The local database (`npm run db:start`, a Postgres container) for the database tests. Nothing here can reach a server. */

export type LocalDb = { owner: string; web: string; worker: string };

let found: LocalDb | null | undefined;

/** The running local database's addresses, or null when it is not running (the tests are then skipped). */
export function localDb(): LocalDb | null {
  if (found !== undefined) return found;
  try {
    execFileSync("docker", ["exec", LOCAL_DB.container, "pg_isready", "-h", "127.0.0.1", "-U", "postgres", "-d", LOCAL_DB.database], { stdio: "ignore", timeout: 20_000 });
    found = localUrls();
  } catch {
    found = null;
  }
  // `npm run test:db` exists to test the database: there, a database that is not running is a failure, not a skip
  if (!found && process.env.REQUIRE_DB) throw new Error("the local database is not running: start it with `npm run db:start`");
  return found;
}

const pools = new Map<string, Db>();
const pool = (url: string): Db => {
  let db = pools.get(url);
  if (!db) pools.set(url, (db = Db.connect(url, { max: 4 })));
  return db;
};

/** The owner of the database: for setting a test up and looking at what happened. No running service connects as it. */
export const ownerDb = (s: LocalDb): Db => pool(s.owner);
/** The worker's view (`studio_worker`): the functions that move money, and the tables it settles from. */
export const workerDb = (s: LocalDb): Db => pool(s.worker);
/** The web app's view with nobody signed in (`studio_web`, no user). */
export const visitorDb = (s: LocalDb): Db => pool(s.web);

export type TestUser = { id: string; email: string; password: string; client: Db };

let counter = 0;
/** Every test account has this password: hashing one is deliberately slow, and the tests make thousands of accounts. */
export const TEST_PASSWORD = "test-password-A1!";
let hashed: Promise<string> | undefined;

/**
 * A confirmed account, and the web app's view of the database when it asks in that user's name: everything a
 * user can reach, by any page or request, goes through this role with this user's id.
 */
export async function newUser(s: LocalDb, name = "user"): Promise<TestUser> {
  // test files run side by side in processes of their own: the counter alone would collide
  const email = `${name}-${Date.now().toString(36)}-${++counter}-${Math.random().toString(36).slice(2, 8)}@example.test`;
  const [row] = await ownerDb(s).query<{ id: string }>("insert into auth.users (email, password_hash, email_confirmed_at) values ($1, $2, now()) returning id", [email, await (hashed ??= hashPassword(TEST_PASSWORD))]);
  return { id: row.id, email, password: TEST_PASSWORD, client: pool(s.web).as(row.id) };
}

/** A session for a user, as the database keeps one: returns the secret their browser's cookie would hold. */
export async function openSession(s: LocalDb, userId: string): Promise<string> {
  const secret = randomBytes(32).toString("base64url");
  await ownerDb(s).query("insert into auth.sessions (token_hash, user_id, expires_at) values ($1, $2, now() + interval '1 day')", [createHash("sha256").update(secret).digest(), userId]);
  return secret;
}

/**
 * A run id nobody has used: run ids are unique across every user, and the test files share one database (they
 * run side by side and never wipe it), so every test makes up its own.
 */
export function freshRunId(): string {
  const now = new Date().toISOString().replace(/[-:T]/g, "");
  return `${now.slice(0, 8)}-${now.slice(8, 14)}-${Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, "0")}`;
}

/**
 * What the tests call "the service": the functions are run as the worker's role, so a function the worker may
 * not run fails the test that needs it; tables are read and prepared as the owner, who sees everything.
 */
export function serviceClient(s: LocalDb): Pick<Db, "rpc" | "from" | "query"> {
  const owner = ownerDb(s);
  const worker = workerDb(s);
  return { rpc: (name, args) => worker.rpc(name, args), from: (table) => owner.from(table), query: (sql, params) => owner.query(sql, params) };
}
