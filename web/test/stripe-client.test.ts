import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import { API_VERSION, creditOf, formEncode, pathId, signWebhook, StripeApi, stripeSettings, usdOf, verifyWebhook } from "@src/billing/stripe";
import { arrivedSince, purchaseTime } from "@/lib/billing";
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

describe("the note for a visitor who comes back from paying", () => {
  const now = Date.parse("2026-10-08T12:00:00Z");
  it("is about a purchase that began within the hour, as the address says", () => {
    expect(purchaseTime(String(now - 5000), now)).toBe(now - 5000);
    for (const not of [undefined, "", "1", "abc", String(now - 3600_001), String(now + 120_000), `${now}0`, `${now} `]) expect(purchaseTime(not, now)).toBeNull();
  });
  it("counts a payment recorded since that purchase began, not one from before it", () => {
    expect(arrivedSince("2026-10-08T12:00:07Z", now)).toBe(true);
    expect(arrivedSince("2026-10-08T11:59:55Z", now)).toBe(false);
    for (const nothing of [null, undefined, "", "not a time"]) expect(arrivedSince(nothing, now)).toBe(false);
  });
});

describe("talking to Stripe", () => {
  it("names its version and key on every request, follows a list's pages, and puts nothing but ids in a path", async () => {
    const seen: Array<{ url: string; version: unknown; auth: unknown }> = [];
    const server = createServer((req, res) => {
      seen.push({ url: req.url ?? "", version: req.headers["stripe-version"], auth: req.headers.authorization });
      const after = new URL(req.url ?? "/", "http://x").searchParams.get("starting_after");
      const page = after === null ? ["a", "b"] : after === "b" ? ["c", "d"] : after === "d" ? ["e"] : [];
      if (req.url?.startsWith("/v1/broken")) {
        res.writeHead(402, { "content-type": "application/json" });
        return res.end(JSON.stringify({ error: { message: "Your card was declined.", code: "card_declined" } }));
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: page.map((id) => ({ id })), has_more: after !== "d" }));
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    try {
      const api = new StripeApi({ secretKey: "sk_test_k", apiBase: `http://127.0.0.1:${(server.address() as { port: number }).port}`, live: false });
      expect((await api.list("/v1/things", { active: true })).map((t) => t.id)).toEqual(["a", "b", "c", "d", "e"]);
      expect(seen.map((s) => s.url)).toEqual(["/v1/things?active=true&limit=100", "/v1/things?active=true&limit=100&starting_after=b", "/v1/things?active=true&limit=100&starting_after=d"]);
      expect(new Set(seen.map((s) => `${String(s.version)} ${String(s.auth)}`))).toEqual(new Set([`${API_VERSION} Bearer sk_test_k`]));
      // a list is cut where asked, with what it has so far
      expect(await api.list("/v1/things", {}, 3)).toHaveLength(4);
      await expect(api.get("/v1/broken")).rejects.toMatchObject({ message: "Your card was declined.", status: 402, code: "card_declined" });
    } finally {
      await new Promise((done) => server.close(done));
    }
    expect(pathId("evt_1Abc")).toBe("evt_1Abc");
    for (const not of ["../../x", "evt_1/../../v1/customers", "", "a b", undefined, 7]) expect(() => pathId(not)).toThrow("not a Stripe id");
    expect(creditOf({ credit_usd: "12.5" })).toBe(12.5);
    for (const not of [{ credit_usd: " 12 " }, { credit_usd: "0x10" }, { credit_usd: "-1" }, { credit_usd: 12 }, {}, null]) expect(creditOf(not as never)).toBeNull();
  });

  it("writes nested parameters the way Stripe reads forms", () => {
    expect(formEncode({ mode: "payment", line_items: [{ price: "price_1", quantity: 1 }], metadata: { user_id: "u 1" }, expand: ["a.b", "c"], skip: undefined }))
      .toBe("mode=payment&line_items%5B0%5D%5Bprice%5D=price_1&line_items%5B0%5D%5Bquantity%5D=1&metadata%5Buser_id%5D=u%201&expand%5B0%5D=a.b&expand%5B1%5D=c");
  });

  it("knows a live key from a test key, and counts cents as dollars", () => {
    expect(stripeSettings({})).toBeNull();
    expect(stripeSettings({ STRIPE_SECRET_KEY: "sk_test_x" })).toEqual({ secretKey: "sk_test_x", apiBase: "https://api.stripe.com", live: false });
    expect(stripeSettings({ STRIPE_SECRET_KEY: "sk_live_x", STRIPE_API_BASE: "http://127.0.0.1:1/" })).toEqual({ secretKey: "sk_live_x", apiBase: "http://127.0.0.1:1", live: true });
    // a restricted key is live or not like any other
    expect(stripeSettings({ STRIPE_SECRET_KEY: "rk_live_x" })?.live).toBe(true);
    expect(stripeSettings({ STRIPE_SECRET_KEY: "rk_test_x" })?.live).toBe(false);
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
      { ...price, metadata: { studio: "flowchain", key: "starter", credit_usd: "1e1" } }, // plain decimals only
      { ...price, metadata: { studio: "flowchain", key: "starter", credit_usd: "0" } },
      { ...price, metadata: { studio: "flowchain", key: "starter", credit_usd: "20" } }, // more than its $19: not an offer
    ]) expect(catalogueItem(not as typeof price)).toBeNull();
  });
});
