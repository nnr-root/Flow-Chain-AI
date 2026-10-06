const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** A `Host` header without its port, lower-cased. */
export const hostName = (host: string): string => host.replace(/:\d+$/, "").toLowerCase();

/**
 * Whether a `Host` header names this machine itself. A DNS name that merely resolves to 127.0.0.1 does not
 * (that is how another site reaches a local server through the browser), and neither does a missing header.
 * No imports: both the request interceptor (`proxy.ts`) and the route guard use it.
 */
export const isLoopbackHost = (host: string | null | undefined): boolean => typeof host === "string" && LOOPBACK.has(hostName(host));
