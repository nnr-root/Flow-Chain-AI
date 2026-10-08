import { ApiError } from "./http";

/* Limits the studio keeps itself, before work is done for a request. */

/**
 * Reads an uploaded form, but never more than `maxBytes` of it (what the route's files may add up to, plus room
 * for the form's own fields). A form is held in memory whole, so its size is bounded before and while it is
 * read: a declared size above the limit is refused without reading anything, and a body that turns out larger
 * than it said — or says nothing — is cut off at the limit.
 */
export async function boundedForm(req: Request, maxBytes: number): Promise<FormData> {
  const tooLarge = () => new ApiError("validation", `the upload is too large (at most ${Math.floor(maxBytes / (1024 * 1024))} MB in all)`);
  const declared = req.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maxBytes)) throw tooLarge();
  const type = req.headers.get("content-type") ?? "";
  if (!type.toLowerCase().startsWith("multipart/form-data") || !req.body) throw new ApiError("validation", "send the file as a form (multipart/form-data)");
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = req.body.getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => {});
      throw tooLarge();
    }
    chunks.push(value);
  }
  try {
    return await new Response(new Blob(chunks as BlobPart[]), { headers: { "content-type": type } }).formData();
  } catch {
    throw new ApiError("validation", "send the file as a form (multipart/form-data)");
  }
}

type Window = { count: number; resetAt: number };
const attempts = new Map<string, Window>();

/**
 * Who a request comes from, as far as that can be told. On a server it is the last address in X-Forwarded-For:
 * the one the proxy itself saw (anything before it is what the client claimed). Without a proxy there is one
 * visitor, the machine itself.
 */
export function clientOf(req: Request): string {
  const forwarded = req.headers.get("x-forwarded-for");
  return forwarded?.split(",").at(-1)?.trim() || "local";
}

/**
 * At most `max` attempts of one kind per client in `windowMs` (twenty in five minutes: several people behind
 * one address still get in, a guessing script does not get far). Signing in, signing up and asking for a reset all reach the
 * accounts service from this server's one address, where its own limits count every visitor together: without
 * a limit per client here, one visitor's wrong guesses would lock everybody out.
 */
export function limitAttempts(req: Request, what: string, max = 20, windowMs = 5 * 60_000, now = Date.now()): void {
  const key = `${what}:${clientOf(req)}`;
  const current = attempts.get(key);
  const window = current && current.resetAt > now ? current : { count: 0, resetAt: now + windowMs };
  window.count++;
  attempts.set(key, window);
  // the map does not grow without end: what has run out is dropped as newcomers arrive
  if (attempts.size > 10_000) for (const [k, w] of attempts) if (w.resetAt <= now) attempts.delete(k);
  if (window.count > max) {
    throw new ApiError("busy", "too many attempts from this address", `try again in ${Math.ceil((window.resetAt - now) / 60_000)} minute(s)`);
  }
}

/** Tests only. */
export const resetAttempts = (): void => attempts.clear();
