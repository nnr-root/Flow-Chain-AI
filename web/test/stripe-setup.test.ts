import { spawn } from "node:child_process";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
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
const REPO = join(fileURLToPath(import.meta.url), "../../..");
// (by its address: the command runs in a folder that has no node_modules of its own)
const TSX = pathToFileURL(join(REPO, "node_modules/tsx/dist/loader.mjs")).href;
const URL_ = "https://studio.example.com/api/stripe/webhook";

describe("setting up Stripe", () => {
  let stripe: FakeStripe;
  let api: StripeApi;
  /** One run of the command's work; returns the steps it took and the secret it would write. `kept` is the endpoint whose secret "this machine" has. */
  const setup = async (text: string, kept?: string) => {
    const listing = await readListing(api);
    const steps = planSetup(parsePlans(text), listing);
    await applySteps(api, steps, listing);
    const portal = await ensurePortal(api, await readListing(api));
    let made: { id: string; secret: string } | undefined;
    await ensureWebhook(api, URL_, kept, (m) => (made = m));
    return { steps, portal, secret: made?.secret, endpoint: made?.id };
  };

  beforeEach(async () => {
    stripe = await startStripe();
    api = new StripeApi(stripeSettings(stripe.env)!);
  });
  afterEach(() => stripe.stop());

  it("leaves the account selling what the file lists, in the words the studio's catalogue and worker read", async () => {
    // something else lives in the same account: not the studio's, and not touched
    const foreign = stripe.addPrice({ key: "other", kind: "topup", priceUsd: 5, creditUsd: 5, metadata: { studio: "someone-else" } });
    const first = await setup(plans());
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
    const first = await setup(plans());
    const requestsBefore = stripe.requests.filter((r) => r.startsWith("POST") || r.startsWith("DELETE")).length;
    const again = await setup(plans(), first.endpoint);
    expect(again.steps).toEqual([]);
    expect(again.secret).toBeUndefined();
    expect(again.portal).toBe(first.portal);
    expect(stripe.webhookEndpoints).toHaveLength(1);
    // one request brings the portal up to date; nothing else is written
    expect(stripe.requests.filter((r) => r.startsWith("POST") || r.startsWith("DELETE")).length - requestsBefore).toBe(1);

    const old = [...stripe.prices.values()].find((p) => p.metadata.key === "starter")!;
    const dearer = await setup(plans(24), first.endpoint);
    expect(dearer.steps.map((s) => s.do)).toEqual(["create-price", "archive-price"]);
    expect(old.active).toBe(false);
    expect((await fetchCatalogue(api)).map((i) => [i.key, i.priceUsd])).toEqual([["starter", 24], ["pro", 49], ["topup-10", 10]]);
    expect(stripe.products.size).toBe(3);
  });

  it("makes a new endpoint when this machine has lost the secret, and removes the old one", async () => {
    const first = await setup(plans());
    const second = await setup(plans());
    expect(second.secret).toBeDefined();
    expect(second.secret).not.toBe(first.secret);
    expect(stripe.webhookEndpoints).toHaveLength(1);
    expect(stripe.webhookEndpoints[0].secret).toBe(second.secret);
  });

  it("stores a new endpoint's secret before it removes the old endpoint, so a failure in between loses nothing", async () => {
    const first = await setup(plans());
    const order: string[] = [];
    const before = stripe.requests.length;
    await ensureWebhook(api, URL_, undefined, () => order.push(`stored after ${stripe.requests.slice(before).filter((r) => r.startsWith("DELETE")).length} removals`));
    expect(order).toEqual(["stored after 0 removals"]);
    expect(stripe.webhookEndpoints.map((e) => e.id)).not.toContain(first.endpoint);
  });

  it("asks Stripe for what is active only, and tells a product's id from the product", async () => {
    await setup(plans());
    expect(stripe.requests).toContain("GET /v1/prices?active=true");
    expect(stripe.requests).toContain("GET /v1/products?active=true");
    // archived prices are still in the account, and are not what is on sale
    await setup(plans(24));
    expect([...stripe.prices.values()].filter((p) => p.metadata.key === "starter")).toHaveLength(2);
    expect((await readListing(api)).prices.filter((p) => p.key === "starter")).toHaveLength(1);
  });
});

/* The command itself, as the owner runs it, in a folder of its own with the stand-in as its Stripe. */
describe("npm run stripe:setup", () => {
  let stripe: FakeStripe;
  let dir: string;
  /** (Not spawnSync: the stand-in Stripe lives in this process and must be able to answer meanwhile.) */
  const run = (args: string[], env: Record<string, string> = {}) =>
    new Promise<{ code: number | null; out: string }>((done) => {
      const child = spawn(process.execPath, ["--import", TSX, join(REPO, "scripts/stripe-setup.ts"), ...args], {
        cwd: dir, stdio: ["ignore", "pipe", "pipe"],
        // nothing of the environment the tests run in: only what this command is meant to see
        env: { NODE_ENV: "test", PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", STUDIO_HOST: "studio.example.com", ...stripe.env, ...env },
      });
      let out = "";
      child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString()));
      child.stderr.on("data", (chunk: Buffer) => (out += chunk.toString()));
      child.on("close", (code) => done({ code, out }));
    });
  const writes = () => stripe.requests.filter((r) => r.startsWith("POST") || r.startsWith("DELETE")).length;

  beforeEach(async () => {
    stripe = await startStripe();
    dir = await mkdtemp(join(tmpdir(), "stripe-setup-"));
    await mkdir(join(dir, "billing"));
    await copyFile(join(REPO, "billing/plans.json"), join(dir, "billing/plans.json"));
    await writeFile(join(dir, ".env"), "GEMINI_API_KEY=keep-me\n# a comment\nFAL_KEY=and-me\n", { mode: 0o644 });
  });
  afterEach(async () => {
    await stripe.stop();
    await rm(dir, { recursive: true, force: true });
  });

  it("changes nothing for a wrong option, a dry run, a key that is not a test key, or when nobody is there to ask", async () => {
    expect(await run(["--bogus"])).toMatchObject({ code: 2, out: expect.stringContaining("unknown option --bogus") });
    const dry = await run(["--dry-run"]);
    expect(dry).toMatchObject({ code: 0, out: expect.stringContaining('create the product "Starter" (starter)') });
    for (const key of ["sk_live_x", "rk_live_x", "sk_tset_typo"]) {
      expect(await run(["--yes"], { STRIPE_SECRET_KEY: key })).toMatchObject({ code: 1, out: expect.stringContaining("is not a test key") });
    }
    // no --yes and no terminal: it does not wait for an answer that cannot come
    expect(await run([])).toMatchObject({ code: 1, out: expect.stringContaining("nobody to ask") });
    expect(writes()).toBe(0);
    expect(readFileSync(join(dir, ".env"), "utf8")).toBe("GEMINI_API_KEY=keep-me\n# a comment\nFAL_KEY=and-me\n");
  }, 120_000);

  it("sets the account up, writes the secret beside the other keys without showing it, and does nothing the second time", async () => {
    const first = await run(["--yes"]);
    expect(first).toMatchObject({ code: 0, out: expect.stringContaining("Wrote STRIPE_WEBHOOK_SECRET to .env.") });
    const [endpoint] = stripe.webhookEndpoints;
    expect(first.out).not.toContain(endpoint.secret);
    expect(readFileSync(join(dir, ".env"), "utf8")).toBe(`GEMINI_API_KEY=keep-me\n# a comment\nFAL_KEY=and-me\nSTRIPE_WEBHOOK_SECRET=${endpoint.secret}\nSTRIPE_WEBHOOK_ENDPOINT=${endpoint.id}\n`);
    expect(statSync(join(dir, ".env")).mode & 0o777).toBe(0o600);
    expect([...stripe.prices.values()].filter((p) => p.active).map((p) => p.metadata.key).sort()).toEqual(["pro", "starter", "topup-10", "topup-25"]);

    const before = writes();
    const again = await run(["--yes"]);
    expect(again).toMatchObject({ code: 0, out: expect.stringContaining("already match billing/plans.json") });
    expect(again.out).toContain("is in place");
    expect(writes() - before).toBe(1); // the portal's settings, brought up to date
    expect(stripe.webhookEndpoints.map((e) => e.id)).toEqual([endpoint.id]);

    // the secret of another endpoint (the other mode's, or a pasted one) does not pass for this one's
    writeFileSync(join(dir, ".env"), `STRIPE_WEBHOOK_SECRET=whsec_other\nSTRIPE_WEBHOOK_ENDPOINT=we_other\n`);
    expect((await run(["--yes"])).out).toContain("replacing the one there");
    expect(stripe.webhookEndpoints).toHaveLength(1);
    expect(readFileSync(join(dir, ".env"), "utf8")).toBe(`STRIPE_WEBHOOK_SECRET=${stripe.webhookEndpoints[0].secret}\nSTRIPE_WEBHOOK_ENDPOINT=${stripe.webhookEndpoints[0].id}\n`);
  }, 120_000);
});
