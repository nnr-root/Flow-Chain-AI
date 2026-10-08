/**
 * npm run stripe:setup [-- --yes] [-- --dry-run] [-- --live]: makes the Stripe account sell what billing/plans.json
 * lists — products and prices, the Customer Portal, and the webhook endpoint for https://<STUDIO_HOST> — and writes
 * the endpoint's signing secret to .env (3.4 spec §7). Safe to run again: it changes only what differs.
 */
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { parseEnv } from "node:util";
import { API_VERSION, EVENT_TYPES, StripeApi, stripeSettings } from "../src/billing/stripe.js";
import { applySteps, ensurePortal, ensureWebhook, readListing } from "../src/deploy/stripe-apply.js";
import { describeStep, type Endpoint, parsePlans, planSetup, planWebhook, webhookUrl, withEnvValue } from "../src/deploy/stripe-setup.js";

const ENV_FILE = ".env";
const SECRET = "STRIPE_WEBHOOK_SECRET";

function readText(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

async function main(): Promise<void> {
  const flags = process.argv.slice(2);
  const unknown = flags.filter((f) => !["--yes", "--dry-run", "--live"].includes(f));
  if (unknown.length > 0) {
    console.error(`unknown option ${unknown.join(" ")}\nusage: npm run stripe:setup [-- --yes] [-- --dry-run] [-- --live]`);
    process.exit(2);
  }
  const local = parseEnv(readText(ENV_FILE)) as Record<string, string>;
  const env = { ...local, ...(parseEnv(readText("deploy/server.env")) as Record<string, string>), ...process.env };
  const settings = stripeSettings(env);
  if (!settings) throw new Error("STRIPE_SECRET_KEY is not set in .env (Stripe dashboard → Developers → API keys; begin with the test-mode key, sk_test_…)");
  if (settings.live && !flags.includes("--live")) {
    throw new Error("STRIPE_SECRET_KEY is a LIVE key: this would set up real products that take real money. Run with -- --live if that is meant.");
  }
  const wanted = parsePlans(readText("billing/plans.json"));
  const url = webhookUrl(env.STUDIO_HOST);
  const stripe = new StripeApi(settings);

  const listing = await readListing(stripe);
  const steps = planSetup(wanted, listing);
  const hook = planWebhook(await stripe.list<Endpoint>("/v1/webhook_endpoints"), url, EVENT_TYPES, API_VERSION, !!local[SECRET]?.trim());

  console.log(`Stripe account in ${settings.live ? "LIVE mode" : "test mode"}; the studio is ${new URL(url).host}.`);
  console.log(steps.length === 0 ? "Products and prices already match billing/plans.json." : `Products and prices:\n${steps.map((s) => `  - ${describeStep(s)}`).join("\n")}`);
  console.log("Customer Portal: plans end with the paid month when cancelled; a plan change starts with the next month.");
  console.log(hook.create ? `Webhook: create an endpoint for ${url}${hook.remove.length > 0 ? " (replacing the one there)" : ""} and write its signing secret to ${ENV_FILE}.` : `Webhook: the endpoint for ${url} is in place.`);
  if (flags.includes("--dry-run")) return;
  if (!flags.includes("--yes")) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await rl.question("Do this? (yes/no) ");
    rl.close();
    if (!/^y(es)?$/i.test(answer.trim())) {
      console.log("Nothing was changed.");
      return;
    }
  }

  await applySteps(stripe, steps, listing);
  await ensurePortal(stripe, await readListing(stripe));
  const secret = await ensureWebhook(stripe, url, !!local[SECRET]?.trim());
  if (secret) {
    // written at once and never shown: Stripe will not say it a second time
    writeFileSync(ENV_FILE, withEnvValue(readText(ENV_FILE), SECRET, secret), { mode: 0o600 });
    chmodSync(ENV_FILE, 0o600);
    console.log(`Wrote ${SECRET} to ${ENV_FILE}.`);
  }
  console.log("Done. Run npm run server:setup to give the server its Stripe keys.");
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
