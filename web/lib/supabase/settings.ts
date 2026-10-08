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

/**
 * Where a visitor is sent after signing in: a path on this site and nothing else (never another site's address).
 * The path is read the way a browser will read it — which drops tabs and line breaks and takes "\\" for "/" —
 * and only kept if it still points here.
 */
export function safeNext(next: string | null | undefined): string {
  if (!next || !next.startsWith("/")) return "/";
  // control characters and spaces have no business in a path, and are how "//other.site" is smuggled past a check
  for (let i = 0; i < next.length; i++) {
    const code = next.charCodeAt(i);
    if (code <= 0x20 || code === 0x7f) return "/";
  }
  if (next.includes("\\") || !URL.canParse(next, "http://studio.invalid")) return "/";
  const url = new URL(next, "http://studio.invalid");
  if (url.origin !== "http://studio.invalid") return "/";
  // "/a/..//other.site" keeps the origin here and still comes out as "//other.site": a path to another site
  const path = url.pathname + url.search;
  return path.startsWith("//") ? "/" : path;
}

/**
 * What the sign-in pages may say about a link that did not work. The address carries only one of these names,
 * never the text itself: a page of ours must not show words that someone put into a link.
 */
export const LINK_ERRORS = {
  link: "That link is no longer valid. Sign in, or ask for a new one.",
  incomplete: "Sign-in was not completed.",
} as const;
export const linkError = (code: string | null | undefined): string => (code && Object.hasOwn(LINK_ERRORS, code) ? LINK_ERRORS[code as keyof typeof LINK_ERRORS] : "");

/** Pages anyone may open. */
export const PUBLIC_PAGES = /^\/(login|signup|reset|auth\/callback|auth\/google)(\/|$)/;
