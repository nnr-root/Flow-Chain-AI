import { z } from "zod";

/* The pure parts of `npm run stripe:setup` (3.4 spec §7): what is on sale, and what must change in Stripe for it to be. */

const Key = z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/, "a short name in lower-case letters, digits and dashes");
// whole cents, and credit to the cent: what Stripe charges and what the ledger keeps both stay exact
const Usd = z.number().positive().max(10_000).refine((n) => Number.isInteger(Math.round(n * 1e6) / 1e4), "at most two decimals");
const Name = z.string().trim().min(1).max(80);

const PlansFile = z.object({
  plans: z.array(z.object({ key: Key, name: Name, monthlyUsd: Usd, creditUsd: Usd }).strict()),
  topups: z.array(z.object({ key: Key, name: Name, priceUsd: Usd, creditUsd: Usd }).strict()),
}).strict();

/** One thing on sale, as `billing/plans.json` describes it. */
export type Wanted = { key: string; kind: "plan" | "topup"; name: string; priceUsd: number; creditUsd: number };

/** Reads `billing/plans.json`. Credit above the price would sell a dollar for less than a dollar: refused. */
export function parsePlans(text: string): Wanted[] {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("billing/plans.json is not valid JSON");
  }
  const parsed = PlansFile.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(`billing/plans.json: ${issue.path.join(".") || "the file"}: ${issue.message}`);
  }
  const wanted: Wanted[] = [
    ...parsed.data.plans.map((p) => ({ key: p.key, kind: "plan" as const, name: p.name, priceUsd: p.monthlyUsd, creditUsd: p.creditUsd })),
    ...parsed.data.topups.map((t) => ({ key: t.key, kind: "topup" as const, name: t.name, priceUsd: t.priceUsd, creditUsd: t.creditUsd })),
  ];
  const seen = new Set<string>();
  for (const w of wanted) {
    if (seen.has(w.key)) throw new Error(`billing/plans.json: the key "${w.key}" is used twice`);
    seen.add(w.key);
    if (w.creditUsd > w.priceUsd) throw new Error(`billing/plans.json: "${w.key}" grants $${w.creditUsd} of credit for $${w.priceUsd}: more than it costs`);
  }
  if (wanted.length === 0) throw new Error("billing/plans.json lists nothing to sell");
  return wanted;
}

/** The studio's own products and active prices as Stripe has them (those with `metadata.studio = flowchain`). */
export type Listing = {
  products: Array<{ id: string; key: string; name: string }>;
  prices: Array<{ id: string; productId: string; key: string; kind: "plan" | "topup"; priceUsd: number; creditUsd: number | null }>;
};

export type Step =
  | { do: "create-product"; key: string; name: string }
  | { do: "rename-product"; key: string; productId: string; name: string }
  | { do: "create-price"; key: string; kind: "plan" | "topup"; priceUsd: number; creditUsd: number }
  | { do: "archive-price"; key: string; priceId: string; why: string }
  | { do: "archive-product"; key: string; productId: string };

const cents = (usd: number | null): number => (usd === null ? Number.NaN : Math.round(usd * 100));

/**
 * What to do so that Stripe sells exactly what `wanted` lists. A price cannot be edited: one whose amount or
 * credit changed is archived and a new one created (the new one first, so there is never nothing to buy). A
 * subscriber on an archived price keeps it until they change plan — Stripe goes on charging it, and the worker
 * goes on reading what it grants from it. Running this twice changes nothing the second time.
 */
export function planSetup(wanted: Wanted[], existing: Listing): Step[] {
  const steps: Step[] = [];
  const archive: Step[] = [];
  const keys = new Set(wanted.map((w) => w.key));
  for (const w of wanted) {
    const product = existing.products.find((p) => p.key === w.key);
    if (!product) steps.push({ do: "create-product", key: w.key, name: w.name });
    else if (product.name !== w.name) steps.push({ do: "rename-product", key: w.key, productId: product.id, name: w.name });
    let kept = false;
    for (const price of existing.prices.filter((p) => p.key === w.key)) {
      const same = price.kind === w.kind && cents(price.priceUsd) === cents(w.priceUsd) && cents(price.creditUsd) === cents(w.creditUsd) && price.productId === product?.id;
      if (same && !kept) kept = true;
      else archive.push({ do: "archive-price", key: w.key, priceId: price.id, why: same ? "a second copy" : "its price or credit changed" });
    }
    if (!kept) steps.push({ do: "create-price", key: w.key, kind: w.kind, priceUsd: w.priceUsd, creditUsd: w.creditUsd });
  }
  for (const price of existing.prices) {
    if (!keys.has(price.key)) archive.push({ do: "archive-price", key: price.key, priceId: price.id, why: "no longer in billing/plans.json" });
  }
  for (const product of existing.products) {
    if (!keys.has(product.key)) archive.push({ do: "archive-product", key: product.key, productId: product.id });
  }
  return [...steps, ...archive];
}

const money = (usd: number): string => `$${usd.toFixed(2)}`;

/** One line per step, for the owner to read before agreeing. */
export function describeStep(step: Step): string {
  switch (step.do) {
    case "create-product":
      return `create the product "${step.name}" (${step.key})`;
    case "rename-product":
      return `rename the product ${step.key} to "${step.name}"`;
    case "create-price":
      return `create a price for ${step.key}: ${money(step.priceUsd)}${step.kind === "plan" ? " a month" : ""} for ${money(step.creditUsd)} of credit`;
    case "archive-price":
      return `archive the price ${step.priceId} of ${step.key} (${step.why})`;
    case "archive-product":
      return `archive the product ${step.key} (no longer in billing/plans.json)`;
  }
}

/** What Stripe is told about a price: the metadata is what the studio later reads to know what a payment grants. */
export function priceParams(step: Extract<Step, { do: "create-price" }>, productId: string) {
  return {
    product: productId,
    currency: "usd",
    unit_amount: cents(step.priceUsd),
    ...(step.kind === "plan" ? { recurring: { interval: "month" } } : {}),
    metadata: { studio: "flowchain", key: step.key, credit_usd: String(step.creditUsd), ...(step.kind === "plan" ? { plan: step.key } : {}) },
  };
}

export type Endpoint = { id: string; url: string; status: string; enabled_events: string[]; api_version: string | null };

/**
 * What to do about the webhook endpoint. Its signing secret is shown only when it is created, so an endpoint
 * whose secret this machine does not have is of no use: it is replaced. So is one that listens for other events
 * or speaks another API version.
 */
export function planWebhook(endpoints: Endpoint[], url: string, events: readonly string[], apiVersion: string, haveSecret: boolean): { keep?: string; remove: string[]; create: boolean } {
  const ours = endpoints.filter((e) => e.url === url);
  const good = (e: Endpoint) => haveSecret && e.status === "enabled" && e.api_version === apiVersion && [...e.enabled_events].sort().join() === [...events].sort().join();
  const keep = ours.find(good);
  return { ...(keep ? { keep: keep.id } : {}), remove: ours.filter((e) => e !== keep).map((e) => e.id), create: !keep };
}

/** The studio's public address for Stripe to call. */
export function webhookUrl(studioHost: string | undefined): string {
  const host = studioHost?.trim().toLowerCase();
  if (!host || !/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(host) || !host.includes(".")) {
    throw new Error("STUDIO_HOST is not set (deploy/server.env): Stripe needs the studio's public name to send payments' confirmations to");
  }
  return `https://${host}/api/stripe/webhook`;
}

/** An env file's text with `name` set to `value`: its line replaced where it is, or added at the end. */
export function withEnvValue(text: string, name: string, value: string): string {
  if (!/^[A-Za-z0-9_]+$/.test(value)) throw new Error(`${name} has a value an env file cannot carry`);
  const line = `${name}=${value}`;
  const lines = text.split("\n");
  const at = lines.findIndex((l) => new RegExp(`^\\s*(export\\s+)?${name}\\s*=`).test(l));
  if (at >= 0) {
    lines[at] = line;
    return lines.join("\n");
  }
  return `${text}${text === "" || text.endsWith("\n") ? "" : "\n"}${line}\n`;
}
