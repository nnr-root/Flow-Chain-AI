"use client";
import { useStripePage } from "@/components/Pricing";
import { type CatalogueItem, LIVE, type PlanView } from "@/lib/billing";
import { credits } from "@/lib/credit";

const usd = (n: number): string => `$${n.toFixed(2)}`;
const button = "rounded-full bg-signal px-5 py-3 text-[1rem] font-bold text-paper hover:bg-ink disabled:opacity-50";

/** `minutes`: how many minutes of video in which every scene moves its credits cover, when that can be said (worked out by the page, never typed). */
function Offer({ item, action, minutes }: { item: CatalogueItem; action: React.ReactNode; minutes: number | null | undefined }) {
  return (
    <li data-testid={`offer-${item.key}`} className="ruled flex flex-col">
      <h3 className="printed text-[1.5rem] leading-none">{item.name}</h3>
      <p className="mt-4 text-[1.02rem]">
        <span className="display text-[3.4rem] leading-none text-ink">{usd(item.priceUsd)}</span>{item.kind === "plan" && " / month"}
      </p>
      <p className="mt-4 text-[1.15rem] font-bold" data-testid={`credits-${item.key}`}>{credits(item.creditUsd).toLocaleString("en-US")} credits{item.kind === "plan" ? " every month" : ""}</p>
      <p className="mt-2 max-w-[22rem] flex-1 text-graphite">
        {minutes ? `About ${minutes} ${minutes === 1 ? "minute" : "minutes"} of video in which every scene moves. With stills, they go further. ` : ""}
        {item.kind === "plan" ? "What is left at the end of a month does not carry over." : "They do not expire."}
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
export function Plans({ items, signedIn, plan, minutes = {} }: { items: CatalogueItem[]; signedIn: boolean; plan: PlanView | null; minutes?: Record<string, number | null> }) {
  const { busy, error, go } = useStripePage();
  const hasPlan = !!plan && LIVE.includes(plan.status);
  const buy = (item: CatalogueItem, label: string) =>
    signedIn ? (
      <button type="button" className={button} data-testid={`buy-${item.key}`} data-cta={`plans-buy-${item.key}`} disabled={!!busy} onClick={() => go(item.priceId, "/api/billing/checkout", { priceId: item.priceId })}>
        {busy === item.priceId ? "Opening Stripe…" : label}
      </button>
    ) : (
      <a href="/signup?next=%2Fpricing" data-cta={`plans-signup-${item.key}`} className={`${button} inline-block`}>Sign up to buy</a>
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
                minutes={minutes[item.priceId]}
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
            {topups.map((item) => <Offer key={item.priceId} item={item} minutes={minutes[item.priceId]} action={buy(item, "Buy")} />)}
          </ul>
        </section>
      )}
      {items.length === 0 && <p className="text-graphite">Nothing is on sale yet.</p>}
      <p className="mt-14 max-w-[44rem] text-[0.95rem] text-graphite">
        Credits are what a video is made with: before one is made you are shown the most it can use, and that is the limit. A plan's credits are spent before a top-up's. Payments are handled by Stripe; Flow Chain never sees your card.
      </p>
    </div>
  );
}
