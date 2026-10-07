import { execFileSync } from "node:child_process";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/* The local Supabase stack (`npx supabase start`, Docker) for the database tests. Nothing here can reach a hosted project. */

export type LocalSupabase = { url: string; anonKey: string; serviceKey: string };

let found: LocalSupabase | null | undefined;

/** The running local stack's address and keys, or null when it is not running (the tests are then skipped). */
export function localSupabase(): LocalSupabase | null {
  if (found !== undefined) return found;
  try {
    const out = execFileSync("npx", ["supabase", "status", "-o", "env"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 60_000 });
    const value = (name: string) => new RegExp(`^${name}="?([^"\n]+)"?$`, "m").exec(out)?.[1];
    const [url, anonKey, serviceKey] = [value("API_URL"), value("ANON_KEY"), value("SERVICE_ROLE_KEY")];
    // only ever a stack on this machine
    found = url && anonKey && serviceKey && /^http:\/\/(127\.0\.0\.1|localhost):/.test(url) ? { url, anonKey, serviceKey } : null;
  } catch {
    found = null;
  }
  return found;
}

const options = { auth: { persistSession: false, autoRefreshToken: false } };

/** The worker's view: the service role, which row-level security does not bind. */
export const serviceClient = (s: LocalSupabase): SupabaseClient => createClient(s.url, s.serviceKey, options);

export type TestUser = { id: string; email: string; password: string; client: SupabaseClient };

let counter = 0;

/** A confirmed account and a client signed in as it: what a user's own browser, or their own script, can do. */
export async function newUser(s: LocalSupabase, name = "user"): Promise<TestUser> {
  const email = `${name}-${Date.now().toString(36)}-${++counter}@example.test`;
  const password = `pw-${Math.random().toString(36).slice(2)}-A1!`;
  const admin = serviceClient(s);
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error || !data.user) throw new Error(`could not create ${email}: ${error?.message}`);
  const client = createClient(s.url, s.anonKey, options);
  const signedIn = await client.auth.signInWithPassword({ email, password });
  if (signedIn.error) throw new Error(`could not sign in as ${email}: ${signedIn.error.message}`);
  return { id: data.user.id, email, password, client };
}

/**
 * A run id nobody has used: run ids are unique across every user, and the test files share one database (they
 * run side by side and never wipe it), so every test makes up its own.
 */
export function freshRunId(): string {
  const now = new Date().toISOString().replace(/[-:T]/g, "");
  return `${now.slice(0, 8)}-${now.slice(8, 14)}-${Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, "0")}`;
}
