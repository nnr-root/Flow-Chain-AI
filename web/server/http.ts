import { ZodError } from "zod";

export type ErrorCode =
  | "validation" | "not_found" | "job_active" | "busy" | "estimate_changed" | "not_draft" | "missing_keys"
  | "forbidden_origin" | "internal";

const STATUS: Record<ErrorCode, number> = {
  validation: 400, not_found: 404, job_active: 409, busy: 429, estimate_changed: 409, not_draft: 409,
  missing_keys: 400, forbidden_origin: 403, internal: 500,
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

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);
const hostName = (host: string) => host.replace(/:\d+$/, "").toLowerCase();

/**
 * There is no login, so the only protection is where a request comes from: the server answers loopback names
 * only (a DNS name pointed at 127.0.0.1 is refused), and a write must come from the studio's own pages — never
 * from another site open in the same browser, which could otherwise spend money through localhost.
 */
export function guard(req: Request, opts: { write: boolean }): void {
  const host = req.headers.get("host") ?? new URL(req.url).host;
  if (!LOOPBACK.has(hostName(host))) throw new ApiError("forbidden_origin", `the studio only answers on localhost, not ${hostName(host)}`);
  if (!opts.write) return;
  const site = req.headers.get("sec-fetch-site");
  const origin = req.headers.get("origin");
  const sameOrigin = site === "same-origin" || (site === null && origin !== null && URL.canParse(origin) && new URL(origin).host === host);
  if (!sameOrigin) throw new ApiError("forbidden_origin", "this action can only be started from the studio itself");
}

type Handler<C> = (req: Request, ctx: C) => Promise<Response> | Response;

/** Wraps a route handler: origin guard first, then every thrown error becomes the one error shape. */
export function route<C>(opts: { write: boolean }, handler: Handler<C>): Handler<C> {
  return async (req, ctx) => {
    try {
      guard(req, opts);
      return await handler(req, ctx);
    } catch (err) {
      return errorResponse(err);
    }
  };
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
