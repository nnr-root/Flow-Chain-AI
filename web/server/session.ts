import { createServerClient, parseCookieHeader, serializeCookieHeader } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";
import { supabaseSettings } from "@/lib/supabase/settings";
import type { TenantUser } from "./tenant";

/* The visitor's Supabase session, kept in cookies. Used by route(), the pages and the proxy. */

type Cookie = { name: string; value: string; options?: Record<string, unknown> };
export type CookieJar = { getAll: () => Array<{ name: string; value: string }>; setAll: (cookies: Cookie[]) => void };

/** A client that acts as whoever the cookies say is signed in; row-level security applies to everything it does. */
export function sessionClient(jar: CookieJar): SupabaseClient {
  const { url, anonKey } = supabaseSettings();
  return createServerClient(url, anonKey, { cookies: jar }) as unknown as SupabaseClient;
}

/**
 * Who is signed in. The token is verified (by its signature, or by asking the auth server): what a cookie claims
 * is never taken at its word.
 */
export async function sessionUser(client: SupabaseClient): Promise<TenantUser | null> {
  const { data, error } = await client.auth.getClaims();
  const claims = data?.claims;
  if (error || !claims?.sub) return null;
  return { id: claims.sub, email: typeof claims.email === "string" ? claims.email : "" };
}

/** The session of a plain `Request`: cookies are read from its header, and the ones to set are collected for the answer. */
export function requestSession(req: Request): { client: SupabaseClient; finish: (res: Response) => Response } {
  const incoming = parseCookieHeader(req.headers.get("cookie") ?? "").map((c) => ({ name: c.name, value: c.value ?? "" }));
  const outgoing = new Map<string, Cookie>();
  const client = sessionClient({
    getAll: () => incoming,
    setAll: (cookies) => {
      for (const c of cookies) {
        outgoing.set(c.name, c);
        const at = incoming.findIndex((i) => i.name === c.name);
        if (at >= 0) incoming[at] = { name: c.name, value: c.value };
        else incoming.push({ name: c.name, value: c.value });
      }
    },
  });
  const finish = (res: Response): Response => {
    if (outgoing.size === 0) return res;
    const headers = new Headers(res.headers);
    for (const c of outgoing.values()) headers.append("set-cookie", serializeCookieHeader(c.name, c.value, c.options ?? {}));
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  };
  return { client, finish };
}

/** The site's own address as the visitor sees it (behind the proxy the scheme comes from its header). */
export function siteOrigin(req: Request): string {
  const host = req.headers.get("host") ?? new URL(req.url).host;
  const proto = req.headers.get("x-forwarded-proto")?.split(",")[0].trim() || new URL(req.url).protocol.replace(":", "");
  return `${proto === "https" ? "https" : "http"}://${host}`;
}
