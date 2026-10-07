import { join } from "node:path";
import type { Manifest } from "@src/manifest/schema";
import { saveManifest } from "@src/manifest/store";
import { sessionClient } from "@/server/session";
import type { LocalSupabase, TestUser } from "../../test/helpers/supabase";
import { request, type Studio } from "./helpers";

/* Helpers for the tests of a studio with accounts: they need the local Supabase stack (`npm run db:start`). */

/** Points the studio under test at the local stack: from here on it has accounts. */
export function withAccounts(s: LocalSupabase): void {
  Object.assign(process.env, { SUPABASE_URL: s.url, SUPABASE_ANON_KEY: s.anonKey });
}

/** The session cookies a browser would hold after signing in as `user`, as a Cookie header. */
export async function cookiesOf(user: Pick<TestUser, "email" | "password">): Promise<string> {
  const jar = new Map<string, string>();
  const client = sessionClient({
    getAll: () => [...jar].map(([name, value]) => ({ name, value })),
    setAll: (cookies) => {
      for (const c of cookies) jar.set(c.name, c.value);
    },
  });
  const { error } = await client.auth.signInWithPassword({ email: user.email, password: user.password });
  if (error) throw new Error(`could not sign in as ${user.email}: ${error.message}`);
  return [...jar].map(([name, value]) => `${name}=${value}`).join("; ");
}

/** A request from the studio's own pages by someone who is signed in. */
export const as = (cookie: string, path: string, init: Parameters<typeof request>[1] = {}): Request =>
  request(path, { ...init, headers: { cookie, ...init.headers } });

/** The cookies an answer sets, as the Cookie header of the next request (a cleared cookie is dropped). */
export function cookiesFrom(res: Response, before = ""): string {
  const jar = new Map(before.split("; ").filter(Boolean).map((pair) => [pair.slice(0, pair.indexOf("=")), pair.slice(pair.indexOf("=") + 1)] as const));
  for (const line of res.headers.getSetCookie()) {
    const [pair] = line.split(";");
    const name = pair.slice(0, pair.indexOf("="));
    const value = pair.slice(pair.indexOf("=") + 1);
    if (!value || /max-age=0/i.test(line)) jar.delete(name);
    else jar.set(name, value);
  }
  return [...jar].map(([name, value]) => `${name}=${value}`).join("; ");
}

/** A run folder in a user's own part of the runs root, as the worker makes it. */
export async function saveRunFor(studio: Studio, user: Pick<TestUser, "id">, m: Manifest): Promise<string> {
  const dir = join(studio.runs, user.id, m.runId);
  await saveManifest(dir, m);
  return dir;
}
