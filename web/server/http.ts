import { ZodError } from "zod";
import { hostName, isAllowedHost } from "@/lib/hosts";
import { LOGIN_MISSING, loginMissing, multiTenant } from "@/lib/accounts";

export type ErrorCode =
  | "validation" | "not_found" | "job_active" | "busy" | "estimate_changed" | "not_draft" | "missing_keys"
  | "forbidden_origin" | "queue_unavailable" | "worker_offline" | "internal"
  | "unauthenticated" | "insufficient_credit" | "too_many_jobs" | "storage_unavailable"
  | "billing_unavailable" | "already_subscribed";

const STATUS: Record<ErrorCode, number> = {
  validation: 400, not_found: 404, job_active: 409, busy: 429, estimate_changed: 409, not_draft: 409,
  missing_keys: 400, forbidden_origin: 403, queue_unavailable: 503, worker_offline: 503, internal: 500,
  unauthenticated: 401, insufficient_credit: 402, too_many_jobs: 429, storage_unavailable: 503,
  billing_unavailable: 503, already_subscribed: 409,
};

/** An error the client is meant to see; anything else becomes a generic 500. */
export class ApiError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly hint?: string,
    /** Extra fields for the client (e.g. the new estimate). */
    readonly data?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });

export function errorResponse(err: unknown): Response {
  if (err instanceof ApiError) {
    return json({ error: { code: err.code, message: err.message, ...(err.hint ? { hint: err.hint } : {}), ...err.data } }, STATUS[err.code]);
  }
  if (err instanceof ZodError) {
    const message = err.issues.map((i) => `${i.path.join(".") || "request"}: ${i.message}`).join("; ");
    return json({ error: { code: "validation", message } }, 400);
  }
  console.error(err);
  return json({ error: { code: "internal", message: "something went wrong in the studio server; see its log" } }, 500);
}

/**
 * Where a request comes from, checked before who sent it: the server answers loopback names and its one public
 * name only (a DNS name pointed at 127.0.0.1 is refused), and a write must come from the studio's own pages —
 * never from another site open in the same browser, which could otherwise spend the visitor's money.
 */
export function guard(req: Request, opts: { write: boolean }): void {
  const host = req.headers.get("host") ?? new URL(req.url).host;
  if (!isAllowedHost(host)) throw new ApiError("forbidden_origin", `the studio does not answer for ${hostName(host)}`);
  if (!opts.write) return;
  const site = req.headers.get("sec-fetch-site");
  const origin = req.headers.get("origin");
  const sameOrigin = site === "same-origin" || (site === null && origin !== null && URL.canParse(origin) && new URL(origin).host === host);
  if (!sameOrigin) throw new ApiError("forbidden_origin", "this action can only be started from the studio itself");
}

type Handler<C> = (req: Request, ctx: C) => Promise<Response> | Response;

/**
 * Wraps a route handler: origin guard first, then (in a studio with accounts) the session — a request without
 * one is refused unless the route is `public`, and the handler runs for that user: every path and row it
 * touches is the user's own. Every thrown error becomes the one error shape. The handler it returns carries
 * its `write` value (not enumerable), so a test can check every route file's label.
 */
export function route<C>(opts: { write: boolean; public?: boolean; external?: boolean }, handler: Handler<C>): Handler<C> {
  // a route that skips the same-origin rule must not act for whoever's cookies came along
  if (opts.external && !opts.public) throw new Error("an external route must be public: it cannot act on a session");
  const wrapped: Handler<C> = async (req, ctx) => {
    try {
      // `external`: a write that comes from outside the studio's own pages by design (a payment provider's
      // webhook). It is not a page's request, so the same-origin rule does not apply; its handler must prove
      // where it comes from by other means (a signature) before it does anything.
      guard(req, { write: opts.write && !opts.external });
      // meant to have accounts and has none: nothing is answered, the health check included, so a deploy fails loudly
      if (loginMissing()) return new Response(JSON.stringify({ error: { code: "internal", message: LOGIN_MISSING } }), { status: 503, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
      if (!multiTenant()) return await handler(req, ctx);
      // loaded only where there are accounts: the single-user studio and the worker never need it
      const [{ requestSession, userOfSession }, { inScope }, { db }, { SESSION_COOKIE }] = await Promise.all([import("./session"), import("./tenant"), import("./db"), import("@/lib/accounts")]);
      const session = requestSession(req);
      try {
        const user = await userOfSession(session.cookies.get(SESSION_COOKIE));
        if (!user && !opts.public) throw new ApiError("unauthenticated", "sign in first");
        // the handler asks the database in this user's name, or (a public route, nobody signed in) in nobody's
        return session.finish(await inScope({ user: user ?? undefined, db: user ? db().as(user.id) : db(), cookies: session.cookies }, () => handler(req, ctx)));
      } catch (err) {
        return session.finish(errorResponse(err));
      }
    } catch (err) {
      return errorResponse(err);
    }
  };
  return Object.defineProperty(wrapped, "write", { value: opts.write });
}

/** The JSON body of a write; anything else (a form post from another page, for instance) is refused. */
export async function body(req: Request): Promise<unknown> {
  if (!(req.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) {
    throw new ApiError("validation", "send JSON (content-type: application/json)");
  }
  try {
    return await req.json();
  } catch {
    throw new ApiError("validation", "the request body is not valid JSON");
  }
}
