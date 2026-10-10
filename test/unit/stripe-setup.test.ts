import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { describeStep, type Endpoint, type Listing, parsePlans, planSetup, planWebhook, priceParams, webhookUrl, withEnvValue } from "../../src/deploy/stripe-setup.js";

const file = (plans: unknown[], topups: unknown[] = [], more: object = {}) => JSON.stringify({ plans, topups, ...more });
const starter = { key: "starter", name: "Starter", monthlyUsd: 19, creditUsd: 12 };
const topup = { key: "topup-10", name: "Top-up $10", priceUsd: 10, creditUsd: 6 };

describe("billing/plans.json", () => {
  it("is read as the things on sale, and the one in the repository is valid", () => {
    expect(parsePlans(file([starter], [topup]))).toEqual([
      { key: "starter", kind: "plan", name: "Starter", priceUsd: 19, creditUsd: 12, interval: "month", plan: "starter" },
      { key: "topup-10", kind: "topup", name: "Top-up $10", priceUsd: 10, creditUsd: 6 },
    ]);
    const shipped = parsePlans(readFileSync("billing/plans.json", "utf8"));
    expect(shipped.map((w) => [w.key, w.priceUsd, w.creditUsd, w.minutes])).toEqual([
      ["starter", 39, 2.5, 5], ["creator", 99, 7.5, 15], ["pro", 199, 22.5, 45],
      ["starter-yearly", 390, 2.5, 5], ["creator-yearly", 990, 7.5, 15], ["pro-yearly", 1990, 22.5, 45],
    ]);
    // nothing is sold once: only plans
    expect(shipped.every((w) => w.kind === "plan")).toBe(true);
  });

  it("sells each plan by the year too when the file says for how many months' price, and a yearly price says what a month of it grants", () => {
    expect(parsePlans(file([{ ...starter, minutes: 5 }], [], { yearlyMonths: 10 }))).toEqual([
      { key: "starter", kind: "plan", name: "Starter", priceUsd: 19, creditUsd: 12, interval: "month", plan: "starter", minutes: 5 },
      { key: "starter-yearly", kind: "plan", name: "Starter, yearly", priceUsd: 190, creditUsd: 12, interval: "year", plan: "starter", minutes: 5 },
    ]);
    // without the line, nothing is sold by the year
    expect(parsePlans(file([starter])).map((w) => w.key)).toEqual(["starter"]);
    expect(() => parsePlans(file([starter], [], { yearlyMonths: 13 }))).toThrow("yearlyMonths");
    expect(() => parsePlans(file([starter, { ...starter, key: "starter-yearly" }], [], { yearlyMonths: 10 }))).toThrow('the key "starter-yearly" is used twice');
  });

  it.each([
    ["{", "not valid JSON"],
    [file([]), "lists nothing to sell"],
    [file([starter, { ...starter, name: "Again" }]), 'the key "starter" is used twice'],
    [file([starter], [{ ...topup, key: "starter" }]), 'the key "starter" is used twice'],
    [file([{ ...starter, creditUsd: 20 }]), "more than it costs"],
    [file([{ ...starter, monthlyUsd: 19.999 }]), "plans.0.monthlyUsd"],
    [file([{ ...starter, monthlyUsd: 0 }]), "plans.0.monthlyUsd"],
    [file([{ ...starter, monthlyUsd: 19.0000001 }]), "plans.0.monthlyUsd"],
    [file([{ ...starter, monthlyUsd: 0.3, creditUsd: 0.2 }]), "plans.0.monthlyUsd"],
    [file([{ ...starter, key: "Starter Plan" }]), "plans.0.key"],
    [file([{ ...starter, yearlyUsd: 190 }]), "plans.0"],
    [JSON.stringify({ plans: [starter] }), "topups"],
  ])("refuses %s", (text, message) => {
    expect(() => parsePlans(text)).toThrow(message);
  });
});

describe("what setup would change in Stripe", () => {
  const wanted = parsePlans(file([starter], [topup]));
  const inPlace: Listing = {
    products: [{ id: "prod_s", key: "starter", name: "Starter" }, { id: "prod_t", key: "topup-10", name: "Top-up $10" }],
    prices: [
      { id: "price_s", productId: "prod_s", key: "starter", kind: "plan", priceUsd: 19, creditUsd: 12 },
      { id: "price_t", productId: "prod_t", key: "topup-10", kind: "topup", priceUsd: 10, creditUsd: 6 },
    ],
  };

  it("creates everything in an empty account, and nothing in one that already matches", () => {
    expect(planSetup(wanted, { products: [], prices: [] })).toEqual([
      { do: "create-product", key: "starter", name: "Starter" },
      { do: "create-price", key: "starter", kind: "plan", priceUsd: 19, creditUsd: 12, interval: "month", plan: "starter" },
      { do: "create-product", key: "topup-10", name: "Top-up $10" },
      { do: "create-price", key: "topup-10", kind: "topup", priceUsd: 10, creditUsd: 6 },
    ]);
    expect(planSetup(wanted, inPlace)).toEqual([]);
  });

  it("replaces a price whose amount or credit changed, the new one first", () => {
    const dearer = parsePlans(file([{ ...starter, monthlyUsd: 24 }], [{ ...topup, creditUsd: 7 }]));
    expect(planSetup(dearer, inPlace)).toEqual([
      { do: "create-price", key: "starter", kind: "plan", priceUsd: 24, creditUsd: 12, interval: "month", plan: "starter" },
      { do: "create-price", key: "topup-10", kind: "topup", priceUsd: 10, creditUsd: 7 },
      { do: "archive-price", key: "starter", priceId: "price_s", why: "its price or credit changed" },
      { do: "archive-price", key: "topup-10", priceId: "price_t", why: "its price or credit changed" },
    ]);
  });

  it("renames, removes what is no longer listed, and keeps one of two identical prices", () => {
    const listing: Listing = {
      products: [...inPlace.products, { id: "prod_old", key: "team", name: "Team" }],
      prices: [
        ...inPlace.prices,
        { id: "price_s2", productId: "prod_s", key: "starter", kind: "plan", priceUsd: 19, creditUsd: 12 },
        { id: "price_old", productId: "prod_old", key: "team", kind: "plan", priceUsd: 99, creditUsd: 80 },
        // a price made by hand in the dashboard without saying what it grants
        { id: "price_bare", productId: "prod_t", key: "topup-10", kind: "topup", priceUsd: 10, creditUsd: null },
      ],
    };
    expect(planSetup(parsePlans(file([{ ...starter, name: "Starter plan" }], [topup])), listing)).toEqual([
      { do: "rename-product", key: "starter", productId: "prod_s", name: "Starter plan" },
      { do: "archive-price", key: "starter", priceId: "price_s2", why: "a second copy" },
      { do: "archive-price", key: "topup-10", priceId: "price_bare", why: "its price or credit changed" },
      { do: "archive-price", key: "team", priceId: "price_old", why: "no longer in billing/plans.json" },
      { do: "archive-product", key: "team", productId: "prod_old" },
    ]);
  });

  it("keeps the first of two products with one key, and comes to rest", () => {
    const twice: Listing = { products: [...inPlace.products, { id: "prod_s2", key: "starter", name: "Starter" }], prices: inPlace.prices };
    expect(planSetup(wanted, twice)).toEqual([{ do: "archive-product", key: "starter", productId: "prod_s2" }]);
    // a price that sits on the second product is replaced by one on the first
    const astray: Listing = { products: twice.products, prices: [{ ...inPlace.prices[0], productId: "prod_s2" }, inPlace.prices[1]] };
    expect(planSetup(wanted, astray).map((s) => s.do)).toEqual(["create-price", "archive-price", "archive-product"]);
  });

  it("says each step in words, and tells Stripe what a price grants", () => {
    const steps = planSetup(wanted, { products: [], prices: [] });
    expect(steps.map(describeStep)).toEqual([
      'create the product "Starter" (starter)',
      "create a price for starter: $19.00 a month for $12.00 of credit",
      'create the product "Top-up $10" (topup-10)',
      "create a price for topup-10: $10.00 for $6.00 of credit",
    ]);
    expect(priceParams(steps[1] as never, "prod_1")).toEqual({
      product: "prod_1", currency: "usd", unit_amount: 1900, recurring: { interval: "month" }, metadata: { studio: "flowchain", key: "starter", credit_usd: "12", plan: "starter" },
    });
    expect(priceParams(steps[3] as never, "prod_2")).toEqual({ product: "prod_2", currency: "usd", unit_amount: 1000, metadata: { studio: "flowchain", key: "topup-10", credit_usd: "6" } });
  });

  it("makes a yearly price a price of its own: billed by the year, named for the plan it pays for, replaced when only its interval or minutes differ", () => {
    const yearly = parsePlans(file([{ ...starter, minutes: 5 }], [], { yearlyMonths: 10 }));
    const steps = planSetup(yearly, { products: [], prices: [] });
    expect(describeStep(steps[3])).toBe("create a price for starter-yearly: $190.00 a year for $12.00 of credit each month");
    expect(priceParams(steps[3] as never, "prod_y")).toEqual({
      product: "prod_y", currency: "usd", unit_amount: 19000, recurring: { interval: "year" },
      metadata: { studio: "flowchain", key: "starter-yearly", credit_usd: "12", plan: "starter", minutes: "5" },
    });
    const there: Listing = {
      products: [{ id: "prod_s", key: "starter", name: "Starter" }, { id: "prod_y", key: "starter-yearly", name: "Starter, yearly" }],
      prices: [
        { id: "price_s", productId: "prod_s", key: "starter", kind: "plan", priceUsd: 19, creditUsd: 12, interval: "month", plan: "starter", minutes: 5 },
        { id: "price_y", productId: "prod_y", key: "starter-yearly", kind: "plan", priceUsd: 190, creditUsd: 12, interval: "year", plan: "starter", minutes: 5 },
      ],
    };
    expect(planSetup(yearly, there)).toEqual([]);
    // the same amount billed every month would be another thing altogether
    const monthly: Listing = { ...there, prices: [there.prices[0], { ...there.prices[1], interval: "month" }] };
    expect(planSetup(yearly, monthly).map((s) => [s.do, s.key])).toEqual([["create-price", "starter-yearly"], ["archive-price", "starter-yearly"]]);
    const otherMinutes: Listing = { ...there, prices: [{ ...there.prices[0], minutes: 4 }, there.prices[1]] };
    expect(planSetup(yearly, otherMinutes).map((s) => [s.do, s.key])).toEqual([["create-price", "starter"], ["archive-price", "starter"]]);
  });
});

describe("the webhook endpoint", () => {
  const url = "https://studio.example.com/api/stripe/webhook";
  const events = ["invoice.paid", "charge.refunded"];
  const endpoint = (over: Partial<Endpoint> = {}): Endpoint => ({ id: "we_1", url, status: "enabled", enabled_events: ["charge.refunded", "invoice.paid"], api_version: "2024-06-20", ...over });

  it("is created when there is none, and kept when it is right and its secret is here", () => {
    expect(planWebhook([], url, events, "2024-06-20", undefined)).toEqual({ remove: [], create: true });
    expect(planWebhook([endpoint(), endpoint({ id: "we_other", url: "https://other.example.com/hook" })], url, events, "2024-06-20", "we_1")).toEqual({ keep: "we_1", remove: [], create: false });
  });

  it.each([
    ["its secret is not on this machine", endpoint(), undefined],
    ["the secret on this machine is another endpoint's (the other mode's, say)", endpoint(), "we_live"],
    ["it listens for other events", endpoint({ enabled_events: ["invoice.paid"] }), "we_1"],
    ["it speaks another version", endpoint({ api_version: null }), "we_1"],
    ["it is switched off", endpoint({ status: "disabled" }), "we_1"],
  ])("is replaced when %s", (_why, existing, secretOf) => {
    expect(planWebhook([existing], url, events, "2024-06-20", secretOf)).toEqual({ remove: ["we_1"], create: true });
  });

  it("is addressed at the studio's public name", () => {
    expect(webhookUrl(" Studio.Example.com ")).toBe(url);
    for (const bad of [undefined, "", "localhost", "studio.example.com/x", "https://studio.example.com"]) expect(() => webhookUrl(bad)).toThrow("STUDIO_HOST is not set");
  });
});

describe("writing the signing secret to .env", () => {
  it("replaces the line where it is, or adds one, and touches nothing else", () => {
    expect(withEnvValue("A=1\nSTRIPE_WEBHOOK_SECRET=old\nB=2\n", "STRIPE_WEBHOOK_SECRET", "whsec_new")).toBe("A=1\nSTRIPE_WEBHOOK_SECRET=whsec_new\nB=2\n");
    expect(withEnvValue("A=1", "STRIPE_WEBHOOK_SECRET", "whsec_new")).toBe("A=1\nSTRIPE_WEBHOOK_SECRET=whsec_new\n");
    expect(withEnvValue("", "STRIPE_WEBHOOK_SECRET", "whsec_new")).toBe("STRIPE_WEBHOOK_SECRET=whsec_new\n");
    expect(withEnvValue("# STRIPE_WEBHOOK_SECRET=x\n", "STRIPE_WEBHOOK_SECRET", "whsec_new")).toBe("# STRIPE_WEBHOOK_SECRET=x\nSTRIPE_WEBHOOK_SECRET=whsec_new\n");
    expect(() => withEnvValue("", "STRIPE_WEBHOOK_SECRET", "a b\nC=1")).toThrow("cannot carry");
    // two lines of the name: the later one would be the one read, so there is one afterwards
    expect(withEnvValue("STRIPE_WEBHOOK_SECRET=a\nB=2\nSTRIPE_WEBHOOK_SECRET=b\n", "STRIPE_WEBHOOK_SECRET", "whsec_new")).toBe("STRIPE_WEBHOOK_SECRET=whsec_new\nB=2\n");
  });
});
