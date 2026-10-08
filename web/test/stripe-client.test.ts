import { describe, expect, it } from "vitest";
import { formEncode, signWebhook, stripeSettings, usdOf, verifyWebhook } from "@src/billing/stripe";
import { catalogueItem } from "@/server/billing/catalogue";

describe("a webhook's signature", () => {
  const secret = "whsec_test";
  const body = JSON.stringify({ id: "evt_1abc", type: "invoice.paid" });
  const at = 1_800_000_000;

  it("lets through what Stripe signed, and gives back the event's id", () => {
    expect(verifyWebhook(body, signWebhook(body, secret, at), secret, at + 10)).toBe("evt_1abc");
    // Stripe may send a second signature while a secret is being rolled: one that matches is enough
    expect(verifyWebhook(body, `${signWebhook(body, "whsec_old", at)},v1=${signWebhook(body, secret, at).split("v1=")[1]}`, secret, at)).toBe("evt_1abc");
  });

  it.each([
    ["nothing", null],
    ["another secret's", signWebhook(body, "whsec_other", at)],
    ["one for another body", signWebhook(`${body} `, secret, at)],
    ["a stale one", signWebhook(body, secret, at - 301)],
    ["one from the future", signWebhook(body, secret, at + 301)],
    ["garbage", "t=now,v1=zz"],
    ["no signature part", `t=${at}`],
    ["a wrong length", `t=${at},v1=abcd`],
  ])("refuses %s", (_what, header) => {
    expect(() => verifyWebhook(body, header, secret, at)).toThrow("signature is not valid");
  });

  it("refuses a signed body that is no event", () => {
    for (const other of ["not json", JSON.stringify({ id: "../../etc" }), JSON.stringify({ type: "x" })]) {
      expect(() => verifyWebhook(other, signWebhook(other, secret, at), secret, at)).toThrow("signature is not valid");
    }
  });
});

describe("talking to Stripe", () => {
  it("writes nested parameters the way Stripe reads forms", () => {
    expect(formEncode({ mode: "payment", line_items: [{ price: "price_1", quantity: 1 }], metadata: { user_id: "u 1" }, expand: ["a.b", "c"], skip: undefined }))
      .toBe("mode=payment&line_items%5B0%5D%5Bprice%5D=price_1&line_items%5B0%5D%5Bquantity%5D=1&metadata%5Buser_id%5D=u%201&expand%5B0%5D=a.b&expand%5B1%5D=c");
  });

  it("knows a live key from a test key, and counts cents as dollars", () => {
    expect(stripeSettings({})).toBeNull();
    expect(stripeSettings({ STRIPE_SECRET_KEY: "sk_test_x" })).toEqual({ secretKey: "sk_test_x", apiBase: "https://api.stripe.com", live: false });
    expect(stripeSettings({ STRIPE_SECRET_KEY: "sk_live_x", STRIPE_API_BASE: "http://127.0.0.1:1/" })).toEqual({ secretKey: "sk_live_x", apiBase: "http://127.0.0.1:1", live: true });
    expect(usdOf(1999)).toBe(19.99);
    expect(usdOf(undefined)).toBeNaN();
  });

  it("lists only prices that are the studio's and say what they grant", () => {
    const price = { id: "price_1", unit_amount: 1900, currency: "usd", recurring: { interval: "month" }, metadata: { studio: "flowchain", key: "starter", credit_usd: "12" }, product: { name: "Starter", active: true } };
    expect(catalogueItem(price)).toEqual({ priceId: "price_1", kind: "plan", key: "starter", name: "Starter", priceUsd: 19, creditUsd: 12 });
    expect(catalogueItem({ ...price, recurring: null })?.kind).toBe("topup");
    for (const not of [
      { ...price, metadata: { key: "starter", credit_usd: "12" } }, // somebody else's price in the same account
      { ...price, metadata: { studio: "flowchain", key: "starter" } }, // grants nothing it knows of
      { ...price, metadata: { studio: "flowchain", key: "starter", credit_usd: "lots" } },
      { ...price, currency: "eur" },
      { ...price, recurring: { interval: "year" } },
      { ...price, product: { name: "Starter", active: false } },
    ]) expect(catalogueItem(not as typeof price)).toBeNull();
  });
});
