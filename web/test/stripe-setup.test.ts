import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { API_VERSION, EVENT_TYPES, StripeApi, stripeSettings } from "@src/billing/stripe";
import { applySteps, ensurePortal, ensureWebhook, readListing } from "@src/deploy/stripe-apply";
import { parsePlans, planSetup } from "@src/deploy/stripe-setup";
import { fetchCatalogue } from "@/server/billing/catalogue";
import { type FakeStripe, startStripe } from "./stripe";

/* `npm run stripe:setup` against the stand-in Stripe: what it leaves in the account, and that a second run changes nothing. */

const plans = (starterUsd = 19) => JSON.stringify({
  plans: [{ key: "starter", name: "Starter", monthlyUsd: starterUsd, creditUsd: 12 }, { key: "pro", name: "Pro", monthlyUsd: 49, creditUsd: 35 }],
  topups: [{ key: "topup-10", name: "Top-up $10", priceUsd: 10, creditUsd: 6 }],
});
const URL_ = "https://studio.example.com/api/stripe/webhook";

describe("setting up Stripe", () => {
  let stripe: FakeStripe;
  let api: StripeApi;
  /** One run of the command's work; returns the steps it took and the secret it would write. */
  const setup = async (text: string, haveSecret: boolean) => {
    const listing = await readListing(api);
    const steps = planSetup(parsePlans(text), listing);
    await applySteps(api, steps, listing);
    const portal = await ensurePortal(api, await readListing(api));
    return { steps, portal, secret: await ensureWebhook(api, URL_, haveSecret) };
  };

  beforeEach(async () => {
    stripe = await startStripe();
    api = new StripeApi(stripeSettings(stripe.env)!);
  });
  afterEach(() => stripe.stop());

  it("leaves the account selling what the file lists, in the words the studio's catalogue and worker read", async () => {
    // something else lives in the same account: not the studio's, and not touched
    const foreign = stripe.addPrice({ key: "other", kind: "topup", priceUsd: 5, creditUsd: 5, metadata: { studio: "someone-else" } });
    const first = await setup(plans(), false);
    expect(first.steps.map((s) => s.do)).toEqual(["create-product", "create-price", "create-product", "create-price", "create-product", "create-price"]);
    expect(await fetchCatalogue(api)).toEqual([
      { priceId: expect.stringMatching(/^price_/), kind: "plan", key: "starter", name: "Starter", priceUsd: 19, creditUsd: 12 },
      { priceId: expect.stringMatching(/^price_/), kind: "plan", key: "pro", name: "Pro", priceUsd: 49, creditUsd: 35 },
      { priceId: expect.stringMatching(/^price_/), kind: "topup", key: "topup-10", name: "Top-up $10", priceUsd: 10, creditUsd: 6 },
    ]);
    expect([...stripe.prices.values()].find((p) => p.metadata.key === "pro")!.metadata).toEqual({ studio: "flowchain", key: "pro", credit_usd: "35", plan: "pro" });
    expect(stripe.prices.get(foreign)!.active).toBe(true);

    // the portal: both plans to switch between, without charging in between; cancelling ends with the month
    expect(stripe.portalConfigurations).toHaveLength(1);
    const features = stripe.portalConfigurations[0].features;
    expect(features.subscription_cancel).toEqual({ enabled: "true", mode: "at_period_end" });
    expect(features.subscription_update).toMatchObject({ enabled: "true", proration_behavior: "none", default_allowed_updates: { 0: "price" } });
    expect(Object.keys(features.subscription_update.products)).toHaveLength(2);
    expect(stripe.portalConfigurations[0].metadata).toEqual({ studio: "flowchain" });

    // the webhook: the studio's events, in the version the fulfilment reads, and its secret handed over once
    expect(stripe.webhookEndpoints).toHaveLength(1);
    expect(stripe.webhookEndpoints[0]).toMatchObject({ url: URL_, enabled_events: [...EVENT_TYPES], api_version: API_VERSION });
    expect(first.secret).toBe(stripe.webhookEndpoints[0].secret);
  });

  it("changes nothing when run again, and replaces only the price that changed", async () => {
    const first = await setup(plans(), false);
    const requestsBefore = stripe.requests.filter((r) => r.startsWith("POST") || r.startsWith("DELETE")).length;
    const again = await setup(plans(), true);
    expect(again.steps).toEqual([]);
    expect(again.secret).toBeUndefined();
    expect(again.portal).toBe(first.portal);
    expect(stripe.webhookEndpoints).toHaveLength(1);
    // one request brings the portal up to date; nothing else is written
    expect(stripe.requests.filter((r) => r.startsWith("POST") || r.startsWith("DELETE")).length - requestsBefore).toBe(1);

    const old = [...stripe.prices.values()].find((p) => p.metadata.key === "starter")!;
    const dearer = await setup(plans(24), true);
    expect(dearer.steps.map((s) => s.do)).toEqual(["create-price", "archive-price"]);
    expect(old.active).toBe(false);
    expect((await fetchCatalogue(api)).map((i) => [i.key, i.priceUsd])).toEqual([["starter", 24], ["pro", 49], ["topup-10", 10]]);
    expect(stripe.products.size).toBe(3);
  });

  it("makes a new endpoint when this machine has lost the secret, and removes the old one", async () => {
    const first = await setup(plans(), false);
    const second = await setup(plans(), false);
    expect(second.secret).toBeDefined();
    expect(second.secret).not.toBe(first.secret);
    expect(stripe.webhookEndpoints).toHaveLength(1);
    expect(stripe.webhookEndpoints[0].secret).toBe(second.secret);
  });
});
