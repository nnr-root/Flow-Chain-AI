import { createHmac, timingSafeEqual } from "node:crypto";

/*
 * The few things the studio asks of Stripe, over its plain HTTP API. Used by the web (sessions, the catalogue,
 * the webhook's signature), by the worker (fetching what an event is about) and by `npm run stripe:setup`.
 */

/**
 * The API version every request names. The fulfilment reads fields by the names they have in this version
 * (an invoice's `subscription` and `charge`, a subscription's `current_period_end`): pinned here, an account
 * whose default version is newer still answers in these terms.
 */
export const API_VERSION = "2024-06-20";

/** The events that mean something to the studio (3.4 spec §5.2); every other type is recorded as ignored. */
export const EVENT_TYPES = [
  "checkout.session.completed", "checkout.session.async_payment_succeeded", "invoice.paid",
  "customer.subscription.created", "customer.subscription.updated", "customer.subscription.deleted",
  "charge.refunded", "charge.dispute.created",
] as const;

export type StripeSettings = { secretKey: string; apiBase: string; live: boolean };

/** The account's key and where its API is (the real one, unless a test points elsewhere). Null when billing is off. */
export function stripeSettings(env: Record<string, string | undefined> = process.env): StripeSettings | null {
  const secretKey = env.STRIPE_SECRET_KEY?.trim();
  if (!secretKey) return null;
  return {
    secretKey,
    apiBase: (env.STRIPE_API_BASE?.trim() || "https://api.stripe.com").replace(/\/$/, ""),
    // only a key that says "test" is a test key: a restricted live key, or one mistyped, is never taken for one
    live: !/^(sk|rk)_test_/.test(secretKey),
  };
}

export class StripeError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
  }
}

type Params = { [key: string]: string | number | boolean | undefined | Params | Array<string | Params> };

/** Stripe takes forms, with nesting spelled as `a[b][0]=…`. */
export function formEncode(params: Params, prefix = ""): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    const name = prefix ? `${prefix}[${key}]` : key;
    if (Array.isArray(value)) {
      value.forEach((item, i) => parts.push(typeof item === "object" ? formEncode(item, `${name}[${i}]`) : `${encodeURIComponent(`${name}[${i}]`)}=${encodeURIComponent(item)}`));
    } else if (typeof value === "object") parts.push(formEncode(value, name));
    else parts.push(`${encodeURIComponent(name)}=${encodeURIComponent(String(value))}`);
  }
  return parts.filter(Boolean).join("&");
}

export class StripeApi {
  constructor(private readonly settings: StripeSettings) {}

  get live(): boolean {
    return this.settings.live;
  }

  private async send<T>(method: "GET" | "POST" | "DELETE", path: string, params?: Params, idempotencyKey?: string): Promise<T> {
    const query = method === "GET" && params ? `?${formEncode(params)}` : "";
    let res: Response;
    try {
      res = await fetch(`${this.settings.apiBase}${path}${query}`, {
        method,
        headers: {
          authorization: `Bearer ${this.settings.secretKey}`,
          "stripe-version": API_VERSION,
          ...(method === "POST" ? { "content-type": "application/x-www-form-urlencoded" } : {}),
          ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
        },
        body: method === "POST" ? formEncode(params ?? {}) : undefined,
        // the key goes to Stripe and nowhere a redirect might point
        redirect: "error",
        signal: AbortSignal.timeout(20_000),
      });
    } catch (err) {
      throw new StripeError(`Stripe could not be reached: ${err instanceof Error ? err.message : String(err)}`, 0);
    }
    const data = (await res.json().catch(() => null)) as (T & { error?: { message?: string; code?: string } }) | null;
    if (!res.ok || !data) throw new StripeError(data?.error?.message ?? `Stripe answered ${res.status}`, res.status, data?.error?.code);
    return data;
  }

  get<T>(path: string, params?: Params): Promise<T> {
    return this.send<T>("GET", path, params);
  }

  post<T>(path: string, params: Params, idempotencyKey?: string): Promise<T> {
    return this.send<T>("POST", path, params, idempotencyKey);
  }

  delete<T>(path: string): Promise<T> {
    return this.send<T>("DELETE", path);
  }

  /** Every object of a list, following its pages. */
  async list<T extends { id: string }>(path: string, params: Params = {}, max = 1000): Promise<T[]> {
    const out: T[] = [];
    let after: string | undefined;
    for (;;) {
      const page = await this.get<{ data: T[]; has_more: boolean }>(path, { ...params, limit: 100, ...(after ? { starting_after: after } : {}) });
      out.push(...page.data);
      if (!page.has_more || page.data.length === 0 || out.length >= max) return out;
      after = page.data.at(-1)!.id;
    }
  }
}

/** The studio's Stripe account, or null when billing is off. */
export function stripeApi(): StripeApi | null {
  const settings = stripeSettings();
  return settings ? new StripeApi(settings) : null;
}

/** How old a webhook's timestamp may be: a captured request cannot be sent again later. */
export const SIGNATURE_TOLERANCE_SEC = 300;

/**
 * Checks that a webhook's body is what Stripe signed, with the endpoint's signing secret: the header carries a
 * timestamp and one or more signatures over "<timestamp>.<body>". Returns the event's id. The body must be the
 * bytes as they arrived; anything re-serialised would not match.
 */
export function verifyWebhook(rawBody: string, header: string | null, secret: string, nowSec = Math.floor(Date.now() / 1000)): string {
  const refuse = (why: string): never => {
    throw new StripeError(`the webhook's signature is not valid (${why})`, 400);
  };
  if (!header) return refuse("no signature");
  const fields = header.split(",").map((part) => part.trim().split("=") as [string, string | undefined]);
  const timestamp = fields.find(([k]) => k === "t")?.[1];
  const signatures = fields.filter(([k, v]) => k === "v1" && v).map(([, v]) => v!);
  if (!timestamp || !/^\d+$/.test(timestamp) || signatures.length === 0) return refuse("malformed");
  if (Math.abs(nowSec - Number(timestamp)) > SIGNATURE_TOLERANCE_SEC) return refuse("too old");
  const expected = createHmac("sha256", secret).update(`${timestamp}.${rawBody}`, "utf8").digest();
  const matches = signatures.some((s) => {
    const given = /^[0-9a-f]+$/i.test(s) ? Buffer.from(s, "hex") : Buffer.alloc(0);
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
  if (!matches) return refuse("no match");
  let id: unknown;
  try {
    id = (JSON.parse(rawBody) as { id?: unknown }).id;
  } catch {
    return refuse("not JSON");
  }
  if (typeof id !== "string" || !/^evt_[A-Za-z0-9_]+$/.test(id)) return refuse("no event id");
  return id;
}

/** A header Stripe would send for this body (tests, and the stand-in Stripe). */
export function signWebhook(rawBody: string, secret: string, nowSec = Math.floor(Date.now() / 1000)): string {
  return `t=${nowSec},v1=${createHmac("sha256", secret).update(`${nowSec}.${rawBody}`, "utf8").digest("hex")}`;
}

/** An object's id as part of a request's path. Ids are letters, digits and underscores; anything else is not one. */
export function pathId(id: unknown): string {
  if (typeof id !== "string" || !/^[A-Za-z0-9_]{1,255}$/.test(id)) throw new StripeError("not a Stripe id", 400);
  return id;
}

/**
 * The credit a price says it grants (`metadata.credit_usd`), or null when it does not say so in plain decimals:
 * "12", "12.5" — not "1e5", not "0x10", not nothing, not zero.
 */
export function creditOf(metadata: Record<string, unknown> | null | undefined): number | null {
  const text = metadata?.credit_usd;
  if (typeof text !== "string" || !/^\d{1,6}(\.\d{1,4})?$/.test(text)) return null;
  const credit = Number(text);
  return credit > 0 ? credit : null;
}

/** Cents, as Stripe counts, to dollars to four decimals. */
export const usdOf = (cents: unknown): number => (typeof cents === "number" && Number.isFinite(cents) ? Math.round(cents * 100) / 10_000 : Number.NaN);
