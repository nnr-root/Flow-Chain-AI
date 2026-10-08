import { createServerClient } from "@supabase/ssr";
import { type NextRequest, NextResponse } from "next/server";
import { hostName, isAllowedHost } from "./lib/hosts";
import { LANDING_PAGE, LOGIN_MISSING, loginMissing, multiTenant, PUBLIC_PAGES, supabaseSettings } from "./lib/supabase/settings";

/**
 * Runs before every request Next answers — pages, their RSC payloads, the API and static files — and refuses
 * any whose `Host` is neither a loopback name nor the configured public name (`STUDIO_HOST`). The pages read runs, logs and settings directly, without `route()`,
 * so without this a DNS name pointed at 127.0.0.1 could read them from another site's page.
 *
 * In a studio with accounts it also keeps the visitor's session fresh and sends a page request without one to
 * the login page — except the bare address `/`, which shows the landing page. The API answers for itself (401) through `route()`.
 */
export async function proxy(request: NextRequest): Promise<Response | undefined> {
  const host = request.headers.get("host");
  if (!isAllowedHost(host)) {
    return new Response(`The studio does not answer for ${host ? hostName(host) : "a request without a Host"}.\n`, {
      status: 403,
      headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
    });
  }
  if (loginMissing()) {
    return new Response(`${LOGIN_MISSING}\n`, { status: 503, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
  }
  if (!multiTenant()) return undefined;

  const { url, anonKey } = supabaseSettings();
  let response = NextResponse.next({ request });
  // the same rules as the routes set them with (web/server/session.ts): no script reads a session cookie
  const forwarded = request.headers.get("x-forwarded-proto")?.split(",")[0].trim();
  const secure = !!process.env.STUDIO_HOST?.trim() || (forwarded ?? request.nextUrl.protocol.replace(":", "")) === "https";
  const cookieOptions = { path: "/", sameSite: "lax" as const, httpOnly: true, secure };
  const client = createServerClient(url, anonKey, {
    cookieOptions,
    cookies: {
      getAll: () => request.cookies.getAll(),
      // a refreshed session goes both to the code that handles this request and back to the browser
      setAll: (cookies) => {
        for (const c of cookies) request.cookies.set(c.name, c.value);
        response = NextResponse.next({ request });
        for (const c of cookies) response.cookies.set(c.name, c.value, { ...c.options, ...cookieOptions });
      },
    },
  });
  const { data } = await client.auth.getClaims();
  const { pathname, search } = request.nextUrl;
  if (data?.claims?.sub || pathname.startsWith("/api/") || pathname.startsWith("/_next/") || PUBLIC_PAGES.test(pathname)) return response;
  // The bare address is what people share: without a session it shows the landing page, at that same address.
  if (pathname === "/") {
    const landing = request.nextUrl.clone();
    landing.pathname = LANDING_PAGE;
    const shown = NextResponse.rewrite(landing, { request });
    for (const c of response.cookies.getAll()) shown.cookies.set(c);
    shown.headers.set("cache-control", "private, no-store");
    return shown;
  }
  const login = request.nextUrl.clone();
  login.pathname = "/login";
  login.search = pathname === "/" ? "" : `?next=${encodeURIComponent(pathname + search)}`;
  const redirect = NextResponse.redirect(login);
  // a session that could not be refreshed was cleared above: the clearing must reach the browser with the redirect
  for (const c of response.cookies.getAll()) redirect.cookies.set(c);
  redirect.headers.set("cache-control", "private, no-store");
  return redirect;
}

export const config = {
  // Everything except the two upload endpoints: Next buffers a request's body for the proxy and keeps only its
  // first 10 MB, which would cut a 20 MB track or a kit's files short. Their handlers check the Host themselves
  // through route(). The pattern is anchored at both ends, so /api/brand-kits/<slug>/logo is still covered.
  matcher: ["/((?!api/music$|api/brand-kits$).*)"],
};
