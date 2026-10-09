import { AsyncLocalStorage } from "node:async_hooks";
import type { Db } from "@src/db/client";
import { multiTenant } from "@/lib/accounts";
import type { RequestCookies } from "./session";

export { multiTenant } from "@/lib/accounts";

/* Who the code is working for right now. Set once per request (or per job in the worker) and read wherever a path or a row is chosen. */

export type TenantUser = { id: string; email: string };
/**
 * `db` asks the database in the user's name (row-level security then shows it that user's rows only) or, for a
 * visitor who is not signed in, in nobody's; the worker has none. `cookies`: the request's own, for the routes
 * that sign someone in or out.
 */
export type Scope = { user?: TenantUser; db?: Db; cookies?: RequestCookies };

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// one store per process, also when a bundler loads this module more than once
const KEY = Symbol.for("flowchain.studio.scope");
const shared = globalThis as { [KEY]?: AsyncLocalStorage<Scope> };
const store = (shared[KEY] ??= new AsyncLocalStorage<Scope>());

/** Runs `work` for a user (or, with no user, for a visitor who is signing in). */
export function inScope<T>(scope: Scope, work: () => T): T {
  if (scope.user && !UUID.test(scope.user.id)) throw new Error("a user id must be a UUID");
  return store.run(scope, work);
}

export const scope = (): Scope | undefined => store.getStore();

/** The signed-in user, or undefined in local mode. In a studio with accounts, code that runs for nobody is a bug. */
export function currentUser(): TenantUser | undefined {
  if (!multiTenant()) return undefined;
  const user = store.getStore()?.user;
  if (!user) throw new Error("no user in scope: in a studio with accounts every read and write belongs to a user");
  return user;
}

/** The database as the current user may see it (row-level security applies to everything asked through it). */
export function userDb(): Db {
  const db = store.getStore()?.db;
  if (!db) throw new Error("no database client in scope");
  return db;
}

/**
 * The folder that holds the current user's part of a data root: `<root>/<userId>` with accounts, the root itself
 * without. The id comes from the verified session or the job's checked data, never from a request.
 */
export const tenantFolder = (): string => currentUser()?.id ?? "";
