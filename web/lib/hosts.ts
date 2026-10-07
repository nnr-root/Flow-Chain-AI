const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** A `Host` header without its port, lower-cased. */
export const hostName = (host: string): string => host.replace(/:\d+$/, "").toLowerCase();

/**
 * Whether a `Host` header names this machine itself. A DNS name that merely resolves to 127.0.0.1 does not
 * (that is how another site reaches a local server through the browser), and neither does a missing header.
 * No imports: both the request interceptor (`proxy.ts`) and the route guard use it.
 */
export const isLoopbackHost = (host: string | null | undefined): boolean => typeof host === "string" && LOOPBACK.has(hostName(host));

/**
 * Whether the studio answers a request for this `Host`: this machine's own names, and — on a server — the one
 * public name it was deployed under (`STUDIO_HOST`, e.g. studio.example.com). Unset, only loopback names pass,
 * as on a developer's machine. Any other name is refused: the proxy in front asks for the login, and this is
 * what still holds if the proxy is misconfigured or bypassed.
 */
export function isAllowedHost(host: string | null | undefined, publicHost: string | undefined = process.env.STUDIO_HOST): boolean {
  if (isLoopbackHost(host)) return true;
  const name = publicHost?.trim().toLowerCase();
  return typeof host === "string" && !!name && hostName(host) === name;
}
