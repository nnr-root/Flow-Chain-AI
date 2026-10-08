import { startStripe } from "./stripe";

/*
 * The stand-in Stripe as a process of its own, for the browser test: `node --import tsx test/stripe-server.ts`.
 * It sells what `billing/plans.json` lists by default, and its checkout page pays at once and tells the studio.
 */
const need = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
};

const stripe = await startStripe({
  port: Number(need("FAKE_STRIPE_PORT")), secretKey: need("STRIPE_SECRET_KEY"), webhookSecret: need("STRIPE_WEBHOOK_SECRET"), deliverTo: need("FAKE_STRIPE_DELIVER_TO"),
});
stripe.addPrice({ key: "starter", kind: "plan", priceUsd: 19, creditUsd: 12, name: "Starter" });
stripe.addPrice({ key: "topup-10", kind: "topup", priceUsd: 10, creditUsd: 6, name: "Top-up $10" });
console.log(`stand-in Stripe at ${stripe.url}`);
