/**
 * npm run stripe:setup [-- --yes] [-- --dry-run] [-- --live]: makes the Stripe account sell what billing/plans.json
 * lists — products and prices, the Customer Portal, and the webhook endpoint for https://<STUDIO_HOST> — and writes
 * the endpoint's signing secret to .env (3.4 spec §7). Safe to run again: it changes only what differs.
 */
import { chmodSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { parseEnv } from "node:util";
import { API_VERSION, EVENT_TYPES, StripeApi, stripeSettings } from "../src/billing/stripe.js";
import { applySteps, ensurePortal, ensureWebhook, readListing } from "../src/deploy/stripe-apply.js";
import { describeStep, type Endpoint, parsePlans, planSetup, planWebhook, webhookUrl, withEnvValue } from "../src/deploy/stripe-setup.js";

const ENV_FILE = ".env";
const SECRET = "STRIPE_WEBHOOK_SECRET";
/** Which endpoint the secret is of: a secret from another account or mode must not pass for this one's. */
const ENDPOINT = "STRIPE_WEBHOOK_ENDPOINT";

/** A file's text; nothing when there is no such file. A file that is there and cannot be read is an error, not an empty file. */
function readText(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw new Error(`cannot read ${path}: ${(err as Error).message}`);
  }
}

/** Replaces .env in one step: a crash half-way leaves the old file, with every other key in it, whole. */
function writeEnv(text: string): void {
  const temp = `${ENV_FILE}.${process.pid}.tmp`;
  writeFileSync(temp, text, { mode: 0o600 });
  chmodSync(temp, 0o600);
  renameSync(temp, ENV_FILE);
}

async function main(): Promise<void> {
  const flags = process.argv.slice(2);
  const unknown = flags.filter((f) => !["--yes", "--dry-run", "--live"].includes(f));
  if (unknown.length > 0) {
    console.error(`unknown option ${unknown.join(" ")}\nusage: npm run stripe:setup [-- --yes] [-- --dry-run] [-- --live]`);
    process.exit(2);
  }
  const local = parseEnv(readText(ENV_FILE)) as Record<string, string>;
  // deploy/server.env says where the studio is. Its other lines are about the server (a key set to nothing there
  // keeps this machine's key off the server; it does not take it away from this command).
  const server = parseEnv(readText("deploy/server.env")) as Record<string, string>;
  const env = { ...local, ...(server.STUDIO_HOST?.trim() ? { STUDIO_HOST: server.STUDIO_HOST } : {}), ...process.env };
  const settings = stripeSettings(env);
  if (!settings) throw new Error("STRIPE_SECRET_KEY is not set in .env (Stripe dashboard → Developers → API keys; begin with the test-mode key, sk_test_…)");
  if (settings.live && !flags.includes("--live")) {
    throw new Error("STRIPE_SECRET_KEY is not a test key (sk_test_…): this would set up real products that take real money. Run with -- --live if that is meant.");
  }
  const wanted = parsePlans(readText("billing/plans.json"));
  const url = webhookUrl(env.STUDIO_HOST);
  const stripe = new StripeApi(settings);
  const secretOf = local[SECRET]?.trim() ? local[ENDPOINT]?.trim() || undefined : undefined;

  const listing = await readListing(stripe);
  const steps = planSetup(wanted, listing);
  const hook = planWebhook(await stripe.list<Endpoint>("/v1/webhook_endpoints"), url, EVENT_TYPES, API_VERSION, secretOf);

  console.log(`Stripe account in ${settings.live ? "LIVE mode" : "test mode"}; the studio is ${new URL(url).host}.`);
  console.log(steps.length === 0 ? "Products and prices already match billing/plans.json." : `Products and prices:\n${steps.map((s) => `  - ${describeStep(s)}`).join("\n")}`);
  console.log("Customer Portal: plans end with the paid month when cancelled; a plan change starts with the next month.");
  console.log(hook.create ? `Webhook: create an endpoint for ${url}${hook.remove.length > 0 ? " (replacing the one there)" : ""} and write its signing secret to ${ENV_FILE}.` : `Webhook: the endpoint for ${url} is in place.`);
  if (flags.includes("--dry-run")) return;
  if (!flags.includes("--yes")) {
    // nobody there to answer: say so, rather than wait on an input that will not come
    if (!process.stdin.isTTY) throw new Error("Nothing was changed: there is nobody to ask. Run with -- --yes to go ahead without asking.");
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
  const made = await ensureWebhook(stripe, url, secretOf, ({ id, secret }) => {
    // written at once and never shown: Stripe will not say it a second time
    writeEnv(withEnvValue(withEnvValue(readText(ENV_FILE), SECRET, secret), ENDPOINT, id));
  });
  if (made) console.log(`Wrote ${SECRET} to ${ENV_FILE}.`);
  console.log("Done. Run npm run server:setup to give the server its Stripe keys.");
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
