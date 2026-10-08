"use client";
import { useState } from "react";
import { errorText, sendJson, usd } from "@/lib/api";
import type { CatalogueItem, PlanView } from "@/lib/billing";
import { LIVE } from "@/lib/billing";
import { Button, ErrorNote, Panel } from "./ui";

/** Sends the browser to a page at Stripe that one of the studio's routes opened for this user. */
function useStripePage() {
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const go = (what: string, url: string, body: unknown = {}) => {
    setBusy(what);
    setError("");
    sendJson<{ url: string }>(url, body).then(
      (data) => window.location.assign(data.url),
      (err: unknown) => {
        setError(errorText(err));
        setBusy("");
      },
    );
  };
  return { busy, error, go };
}

/** Opens Stripe's own page for changing or cancelling the plan, the card, and the invoices. */
export function ManageBilling({ label = "Manage subscription" }: { label?: string }) {
  const { busy, error, go } = useStripePage();
  return (
    <>
      <Button data-testid="manage-billing" disabled={!!busy} onClick={() => go("portal", "/api/billing/portal")}>{busy ? "Opening…" : label}</Button>
      <ErrorNote>{error}</ErrorNote>
    </>
  );
}

function Offer({ item, action }: { item: CatalogueItem; action: React.ReactNode }) {
  return (
    <li data-testid={`offer-${item.key}`} className="flex flex-col gap-3 rounded-xl border border-line bg-ink/40 p-4">
      <div>
        <h3 className="font-semibold">{item.name}</h3>
        <p className="mt-1 text-2xl font-semibold">{usd(item.priceUsd)}{item.kind === "plan" && <span className="text-sm font-normal text-dim"> / month</span>}</p>
      </div>
      <p className="text-sm text-dim">
        <span className="font-medium text-white">{usd(item.creditUsd)}</span> of credit{item.kind === "plan" ? " every month. What is left at the end of a month does not carry over." : ". It does not expire."}
      </p>
      <div className="mt-auto">{action}</div>
    </li>
  );
}

/** What can be bought. `signedIn` decides whether a button buys or leads to signing up; `plan` is the user's own. */
export function Pricing({ items, signedIn, plan }: { items: CatalogueItem[]; signedIn: boolean; plan: PlanView | null }) {
  const { busy, error, go } = useStripePage();
  const hasPlan = !!plan && LIVE.includes(plan.status);
  const buy = (item: CatalogueItem, label: string) =>
    signedIn ? (
      <Button tone="primary" data-testid={`buy-${item.key}`} disabled={!!busy} onClick={() => go(item.priceId, "/api/billing/checkout", { priceId: item.priceId })}>
        {busy === item.priceId ? "Opening…" : label}
      </Button>
    ) : (
      <a href="/signup?next=%2Fpricing" className="inline-block rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-ink hover:brightness-110">Sign up to buy</a>
    );
  const plans = items.filter((i) => i.kind === "plan");
  const topups = items.filter((i) => i.kind === "topup");
  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <ErrorNote>{error}</ErrorNote>
      {plans.length > 0 && (
        <Panel title="Plans" aside={hasPlan ? <ManageBilling /> : undefined}>
          <ul className="grid gap-4 sm:grid-cols-2">
            {plans.map((item) => (
              <Offer
                key={item.priceId}
                item={item}
                action={hasPlan ? <p className="text-sm text-dim" data-testid={plan.plan === item.key ? "your-plan" : undefined}>{plan.plan === item.key ? "Your plan" : "Switch under Manage subscription"}</p> : buy(item, "Subscribe")}
              />
            ))}
          </ul>
        </Panel>
      )}
      {topups.length > 0 && (
        <Panel title="Top-ups">
          <ul className="grid gap-4 sm:grid-cols-2">
            {topups.map((item) => <Offer key={item.priceId} item={item} action={buy(item, "Buy")} />)}
          </ul>
        </Panel>
      )}
      {items.length === 0 && <p className="text-sm text-dim">Nothing is on sale yet.</p>}
      <p className="text-xs text-dim">Credit pays for what a video costs to generate. Plan credit is spent before top-up credit. Payments are handled by Stripe; the studio never sees your card.</p>
    </div>
  );
}
