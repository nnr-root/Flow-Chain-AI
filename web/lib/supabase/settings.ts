/* Whether the studio has accounts, and where they live. No imports: the proxy and the server both read this. */

export type SupabaseSettings = { url: string; anonKey: string };

/**
 * With `SUPABASE_URL` set the studio is multi-tenant: every request belongs to a signed-in user and sees only
 * that user's runs, kits and tracks. Without it the studio is the single-user app it was, with no accounts.
 */
export const multiTenant = (): boolean => !!process.env.SUPABASE_URL?.trim();

/** The project's address and its public key (safe in a browser: row-level security is what protects the data). */
export function supabaseSettings(): SupabaseSettings {
  const url = process.env.SUPABASE_URL?.trim();
  const anonKey = process.env.SUPABASE_ANON_KEY?.trim();
  if (!url || !anonKey) throw new Error("SUPABASE_URL and SUPABASE_ANON_KEY must both be set for a studio with accounts");
  return { url, anonKey };
}

/** Where a visitor is sent after signing in: a path on this site and nothing else (never another site's address). */
export function safeNext(next: string | null | undefined): string {
  if (!next || !next.startsWith("/") || next.startsWith("//") || next.includes("\\") || /[\r\n]/.test(next)) return "/";
  return next;
}

/** Pages anyone may open. */
export const PUBLIC_PAGES = /^\/(login|signup|reset|auth\/callback|auth\/google)(\/|$)/;
