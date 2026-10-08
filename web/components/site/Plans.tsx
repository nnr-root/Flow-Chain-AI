"use client";
import { useStripePage } from "@/components/Pricing";
import { type CatalogueItem, LIVE, type PlanView } from "@/lib/billing";

const usd = (n: number): string => `$${n.toFixed(2)}`;
const button = "rounded-md bg-ink px-5 py-3 text-[1rem] font-medium text-paper hover:bg-stage disabled:opacity-50";

function Offer({ item, action }: { item: CatalogueItem; action: React.ReactNode }) {
  return (
    <li data-testid={`offer-${item.key}`} className="flex flex-col border-t border-ink/30 pt-5">
      <h3 className="display text-[1.9rem] leading-none">{item.name}</h3>
      <p className="mt-4 text-[1.02rem]">
        <span className="display text-[2.6rem] leading-none">{usd(item.priceUsd)}</span>{item.kind === "plan" && " / month"}
      </p>
      <p className="mt-3 max-w-[22rem] flex-1 text-graphite">
        {usd(item.creditUsd)} of credit{item.kind === "plan" ? " every month. What is left at the end of a month does not carry over." : ". It does not expire."}
      </p>
      <div className="mt-6">{action}</div>
    </li>
  );
}

/**
 * What is on sale, in the landing page's look: the plans and top-ups as Stripe lists them. `signedIn` decides
 * whether a button buys or leads to an account; `plan` is the visitor's own, and a visitor who has one is
 * offered to manage it rather than buy another.
 */
export function Plans({ items, signedIn, plan }: { items: CatalogueItem[]; signedIn: boolean; plan: PlanView | null }) {
  const { busy, error, go } = useStripePage();
  const hasPlan = !!plan && LIVE.includes(plan.status);
  const buy = (item: CatalogueItem, label: string) =>
    signedIn ? (
      <button type="button" className={button} data-testid={`buy-${item.key}`} disabled={!!busy} onClick={() => go(item.priceId, "/api/billing/checkout", { priceId: item.priceId })}>
        {busy === item.priceId ? "Opening Stripe…" : label}
      </button>
    ) : (
      <a href="/signup?next=%2Fpricing" className={`${button} inline-block`}>Sign up to buy</a>
    );
  const plans = items.filter((i) => i.kind === "plan");
  const topups = items.filter((i) => i.kind === "topup");
  return (
    <div data-testid="plans">
      {error && <p role="alert" className="mb-8 max-w-[40rem] border-l-2 border-signal pl-4 text-[1.02rem]">{error}</p>}
      {plans.length > 0 && (
        <section aria-labelledby="plans-title">
          <div className="flex flex-wrap items-baseline justify-between gap-4">
            <h2 id="plans-title" className="text-[1.02rem] text-graphite">Plans, billed by the month</h2>
            {hasPlan && (
              <button type="button" data-testid="manage-billing" disabled={!!busy} onClick={() => go("portal", "/api/billing/portal")} className="underline decoration-hairline decoration-2 underline-offset-4 hover:decoration-ink">
                {busy === "portal" ? "Opening Stripe…" : "Manage subscription"}
              </button>
            )}
          </div>
          <ul className="mt-5 grid gap-x-12 gap-y-10 sm:grid-cols-2 lg:grid-cols-3">
            {plans.map((item) => (
              <Offer
                key={item.priceId}
                item={item}
                action={hasPlan ? <p className="text-graphite" data-testid={plan.plan === item.key ? "your-plan" : undefined}>{plan.plan === item.key ? "Your plan" : "Switch under Manage subscription"}</p> : buy(item, "Subscribe")}
              />
            ))}
          </ul>
        </section>
      )}
      {topups.length > 0 && (
        <section aria-labelledby="topups-title" className={plans.length > 0 ? "mt-16" : ""}>
          <h2 id="topups-title" className="text-[1.02rem] text-graphite">Top-ups, bought once</h2>
          <ul className="mt-5 grid gap-x-12 gap-y-10 sm:grid-cols-2 lg:grid-cols-3">
            {topups.map((item) => <Offer key={item.priceId} item={item} action={buy(item, "Buy")} />)}
          </ul>
        </section>
      )}
      {items.length === 0 && <p className="text-graphite">Nothing is on sale yet.</p>}
      <p className="mt-14 max-w-[44rem] text-[0.95rem] text-graphite">
        Credit pays for what a video costs to generate, and you are shown the most a video can cost before it is made. Plan credit is spent before top-up credit. Payments are handled by Stripe; Flow Chain never sees your card.
      </p>
    </div>
  );
}
