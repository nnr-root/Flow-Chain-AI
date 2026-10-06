import type { NextRequest } from "next/server";
import { hostName, isLoopbackHost } from "./lib/loopback";

/**
 * Runs before every request Next answers — pages, their RSC payloads, the API and static files — and refuses
 * any whose `Host` is not a loopback name. The pages read runs, logs and settings directly, without `route()`,
 * so without this a DNS name pointed at 127.0.0.1 could read them from another site's page.
 */
export function proxy(request: NextRequest): Response | undefined {
  const host = request.headers.get("host");
  if (isLoopbackHost(host)) return undefined;
  return new Response(`The studio only answers on localhost, not ${host ? hostName(host) : "a request without a Host"}.\n`, {
    status: 403,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });
}

export const config = {
  // Everything except the two upload endpoints: Next buffers a request's body for the proxy and keeps only its
  // first 10 MB, which would cut a 20 MB track or a kit's files short. Their handlers check the Host themselves
  // through route(). The pattern is anchored at both ends, so /api/brand-kits/<slug>/logo is still covered.
  matcher: ["/((?!api/music$|api/brand-kits$).*)"],
};
