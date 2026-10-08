import { verifyWebhook } from "@src/billing/stripe";
import { billingOn } from "@/lib/billing";
import { ApiError, json, route } from "@/server/http";
import { runner } from "@/server/jobs";

export const dynamic = "force-dynamic";

/** A webhook is a small JSON document; nothing larger is read. */
const MAX_BYTES = 1024 * 1024;

async function rawBody(req: Request): Promise<string> {
  const declared = req.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > MAX_BYTES)) throw new ApiError("validation", "the request is too large");
  if (!req.body) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = req.body.getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BYTES) {
      await reader.cancel().catch(() => {});
      throw new ApiError("validation", "the request is too large");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Stripe tells the studio that something happened. This route is not a page's request and has no session: what
 * proves where it comes from is Stripe's signature over the body, checked before anything else is done. Then
 * only the event's id goes to the worker, which asks Stripe itself what the event is and fulfils it. The answer
 * is 200 once that is done (or was done before), and an error otherwise, so that Stripe tries again.
 */
export const POST = route({ write: true, public: true, external: true }, async (req) => {
  const secret = process.env.STRIPE_WEBHOOK_SECRET?.trim();
  if (!billingOn() || !secret) throw new ApiError("not_found", "this studio takes no payments");
  const body = await rawBody(req);
  let eventId: string;
  try {
    eventId = verifyWebhook(body, req.headers.get("stripe-signature"), secret);
  } catch (err) {
    throw new ApiError("validation", err instanceof Error ? err.message : "the webhook's signature is not valid");
  }
  return json({ received: true, outcome: await runner().stripeEvent(eventId) });
});
