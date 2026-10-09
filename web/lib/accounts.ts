/* Whether the studio has accounts, and what its sign-in pages share. No imports: the proxy and the server both read this. */

/**
 * With `DATABASE_URL` set the studio is multi-tenant: every request belongs to a signed-in user and sees only
 * that user's runs, kits and tracks. Without it the studio is the single-user app it was, with no accounts.
 */
export const multiTenant = (): boolean => !!process.env.DATABASE_URL?.trim();

/**
 * On a server the stack says which login the studio is meant to have (`STUDIO_AUTH`, set by server:setup):
 * `proxy` (the proxy asks for the one login) or `accounts` (the studio asks every visitor to sign in). The proxy
 * is chosen from the same word. If it says "accounts" and this process has no database configured — a settings
 * file that was not written, or edited — the studio would be open to anyone: it then answers nothing at all.
 */
export const loginMissing = (): boolean => process.env.STUDIO_AUTH?.trim() === "accounts" && !multiTenant();
export const LOGIN_MISSING = "The studio is set up to have accounts but has none configured, so it answers nothing. Run npm run server:setup again.";

/**
 * The studio's own cookies. All are HttpOnly: no script in a page reads them, so a flaw in a page cannot hand
 * a session to someone else.
 *  - the session: a random secret; the database keeps its hash and knows whose it is;
 *  - the browser's half of an emailed link: a link signs a visitor in only where this cookie is;
 *  - what a sign-in at Google was started with, for the minutes it takes.
 */
export const SESSION_COOKIE = "fc_session";
export const BROWSER_COOKIE = "fc_browser";
export const OAUTH_COOKIE = "fc_oauth";
/** Whether visitors can sign in with Google: only where the owner has set it up (its two settings, on the server). */
export const googleOn = (): boolean => !!process.env.GOOGLE_CLIENT_ID?.trim() && !!process.env.GOOGLE_CLIENT_SECRET?.trim();

/** A session lasts this long from the sign-in. */
export const SESSION_DAYS = 30;

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

/**
 * Pages anyone may open. (`/pricing` exists only in a studio that takes payments; elsewhere it is "not found".
 * `/showcase/` is not a page but the landing page's own videos: files made for showing to anyone.)
 */
export const PUBLIC_PAGES = /^\/(welcome|showcase|terms|privacy|login|signup|reset|pricing|auth\/callback|auth\/google)(\/|$)/;

/** The landing page: what a visitor without a session is shown at `/`. */
export const LANDING_PAGE = "/welcome";
