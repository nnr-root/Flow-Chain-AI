/** Marks the path segment that carries a pending look (and a cache-busting version) in a files URL. */
export const LOOK_PREFIX = "~";

type Token = { v?: string; look?: unknown };

const toBase64Url = (text: string): string =>
  btoa(String.fromCharCode(...new TextEncoder().encode(text))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const fromBase64Url = (text: string): string =>
  new TextDecoder().decode(Uint8Array.from(atob(text.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0)));

/** `~<base64url JSON>`: works in the browser and on the server. */
export const encodeLookToken = (token: Token): string => LOOK_PREFIX + toBase64Url(JSON.stringify(token));

export function decodeLookToken(segment: string): Token {
  const value: unknown = JSON.parse(fromBase64Url(segment.slice(LOOK_PREFIX.length)));
  if (typeof value !== "object" || value === null) throw new Error("not a look token");
  return value as Token;
}
