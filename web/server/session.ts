import { BROWSER_COOKIE, OAUTH_COOKIE, SESSION_COOKIE } from "@/lib/accounts";
import { db } from "./db";
import { hashOf } from "@src/auth/passwords";
import type { TenantUser } from "./tenant";

/* The visitor's session: a random secret in a cookie, checked against the database. Used by route() and the pages. */

/**
 * How the studio's cookies are set. No script in the page ever needs them (the studio's own routes do the signing
 * in), so none can read them: a flaw in a page cannot hand the session to someone else.
 */
export const cookieOptions = (secure: boolean) => ({ path: "/", sameSite: "lax" as const, httpOnly: true, secure });

/** A request's cookies by name. */
export function readCookies(header: string | null): Map<string, string> {
  const jar = new Map<string, string>();
  for (const part of (header ?? "").split(";")) {
    const at = part.indexOf("=");
    if (at < 1) continue;
    const name = part.slice(0, at).trim();
    // the first of a name wins, as browsers send the most specific first
    if (!jar.has(name)) jar.set(name, part.slice(at + 1).trim());
  }
  return jar;
}

/**
 * Who a session's secret belongs to. The cookie is never taken at its word: the database is asked, with the
 * secret's hash, and answers only for a session that has not run out.
 */
export async function userOfSession(secret: string | undefined): Promise<TenantUser | null> {
  // (our secrets are 43 characters of base64url; anything else is not one, and the database is not asked)
  if (!secret || !/^[A-Za-z0-9_-]{43}$/.test(secret)) return null;
  const { data, error } = await db().rpc<Array<{ user_id: string; email: string }>>("auth.whose_session", { p_token_hash: hashOf(secret) });
  if (error) throw new Error(`the session could not be checked: ${error.message}`);
  const row = data?.[0];
  return row ? { id: row.user_id, email: row.email } : null;
}

const NAMES = [SESSION_COOKIE, BROWSER_COOKIE, OAUTH_COOKIE] as const;
export type CookieName = (typeof NAMES)[number];

/** The cookies of one request, and the ones its answer will set. */
export type RequestCookies = {
  get(name: CookieName): string | undefined;
  /** `maxAgeSec`: how long the browser keeps it. */
  set(name: CookieName, value: string, maxAgeSec: number): void;
  clear(name: CookieName): void;
};

/** The session of a plain `Request`: cookies are read from its header, and the ones to set are collected for the answer. */
export function requestSession(req: Request): { cookies: RequestCookies; finish: (res: Response) => Response } {
  const incoming = readCookies(req.headers.get("cookie"));
  const outgoing = new Map<CookieName, { value: string; maxAge: number }>();
  const secure = siteOrigin(req).startsWith("https://");
  const cookies: RequestCookies = {
    get: (name) => (outgoing.has(name) ? outgoing.get(name)!.value || undefined : incoming.get(name)),
    set: (name, value, maxAgeSec) => void outgoing.set(name, { value, maxAge: Math.floor(maxAgeSec) }),
    clear: (name) => void outgoing.set(name, { value: "", maxAge: 0 }),
  };
  const finish = (res: Response): Response => {
    if (outgoing.size === 0) return res;
    const headers = new Headers(res.headers);
    for (const [name, c] of outgoing) {
      headers.append("set-cookie", `${name}=${c.value}; Path=/; Max-Age=${c.maxAge}; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`);
    }
    // an answer that carries someone's session must never be stored and served to anyone else
    headers.set("cache-control", "private, no-store");
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  };
  return { cookies, finish };
}

/**
 * The site's own address as the visitor sees it. On a server it is the configured public name over HTTPS — never
 * what a request's Host header claims, because this address goes into the links that are emailed to people.
 * Locally (no `STUDIO_HOST`) it is the address the request came to.
 */
export function siteOrigin(req: Request): string {
  const configured = process.env.STUDIO_HOST?.trim();
  if (configured) return `https://${configured}`;
  const host = req.headers.get("host") ?? new URL(req.url).host;
  const proto = req.headers.get("x-forwarded-proto")?.split(",")[0].trim() || new URL(req.url).protocol.replace(":", "");
  return `${proto === "https" ? "https" : "http"}://${host}`;
}
