"use client";
import { useState } from "react";
import { useStripePage } from "@/components/Pricing";
import { type CatalogueItem, LIVE, type PlanView } from "@/lib/billing";
import { credits } from "@/lib/credit";

const usd = (n: number): string => `$${n.toFixed(2)}`;
const button = "rounded-full bg-signal px-5 py-3 text-[1rem] font-bold text-paper hover:bg-ink disabled:opacity-50";

/**
 * One thing on sale. `minutes`: how many minutes of video in which every scene moves its credits cover, when that
 * can be said (worked out by the page, never typed). `monthly`: the same plan's price by the month, beside which a
 * yearly price says how many months it is the price of.
 */
function Offer({ item, action, minutes, monthly }: { item: CatalogueItem; action: React.ReactNode; minutes: number | null | undefined; monthly?: CatalogueItem }) {
  const yearly = item.interval === "year";
  // twelve months for the price of how many: from the two prices themselves
  const paidFor = yearly && monthly && monthly.priceUsd > 0 ? Math.round((item.priceUsd / monthly.priceUsd) * 10) / 10 : null;
  return (
    <li data-testid={`offer-${item.key}`} className="ruled flex flex-col">
      <h3 className="printed text-[1.5rem] leading-none">{yearly && monthly ? monthly.name : item.name}</h3>
      <p className="mt-4 text-[1.02rem]">
        <span className="display text-[3.4rem] leading-none text-ink">{usd(item.priceUsd)}</span>{item.kind === "plan" && (yearly ? " / year" : " / month")}
      </p>
      {paidFor !== null && paidFor < 12 && <p className="mt-2 text-[0.95rem]" data-testid={`yearly-${item.key}`}><span className="marked">Twelve months for the price of {paidFor}</span></p>}
      <p className="mt-4 text-[1.15rem] font-bold" data-testid={`credits-${item.key}`}>
        {credits(item.creditUsd).toLocaleString("en-US")} credits{item.kind === "plan" ? " every month" : ""}
      </p>
      <p className="mt-2 max-w-[22rem] flex-1 text-graphite">
        {minutes ? `About ${minutes} ${minutes === 1 ? "minute" : "minutes"} of video in which every scene moves. With stills, they go further. ` : ""}
        {item.kind === "plan" ? "What is left at the end of a month does not carry over." : "They do not expire."}
      </p>
      <div className="mt-6">{action}</div>
    </li>
  );
}

/**
 * What is on sale, as Stripe lists it: the plans, by the month or by the year, and top-ups where there are any.
 * `signedIn` decides whether a button buys or leads to an account; `plan` is the visitor's own, and a visitor who
 * has one is offered to manage it rather than buy another.
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
  const all = items.filter((i) => i.kind === "plan");
  const byYear = all.filter((i) => i.interval === "year");
  const byMonth = all.filter((i) => i.interval !== "year");
  // the choice is there only when both ways of paying are on sale
  const [yearly, setYearly] = useState(false);
  const plans = yearly && byYear.length > 0 ? byYear : byMonth.length > 0 ? byMonth : byYear;
  const topups = items.filter((i) => i.kind === "topup");
  const planOf = (item: CatalogueItem) => item.plan ?? item.key;
  return (
    <div data-testid="plans">
      {error && <p role="alert" className="mb-8 max-w-[40rem] rounded-[14px] bg-wash px-4 py-3 text-[1.02rem]">{error}</p>}
      {plans.length > 0 && (
        <section aria-labelledby="plans-title">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <h2 id="plans-title" className="text-[1.02rem] text-graphite">Plans, paid {byYear.length > 0 && byMonth.length > 0 ? "by the month or by the year" : byYear.length > 0 ? "by the year" : "by the month"}</h2>
            {byYear.length > 0 && byMonth.length > 0 && (
              <div role="radiogroup" aria-label="How a plan is paid" data-testid="billing-interval" className="inline-flex gap-0.5 rounded-full bg-sheet p-1 text-[0.9rem]">
                {([[false, "Monthly"], [true, "Yearly"]] as const).map(([value, label]) => (
                  <button key={label} type="button" role="radio" aria-checked={yearly === value} onClick={() => setYearly(value)} className={`rounded-full px-4 py-1.5 font-bold ${yearly === value ? "bg-marker text-paper" : "text-graphite hover:text-ink"}`}>{label}</button>
                ))}
              </div>
            )}
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
                monthly={byMonth.find((m) => planOf(m) === planOf(item))}
                action={hasPlan ? <p className="text-graphite" data-testid={plan.plan === planOf(item) ? "your-plan" : undefined}>{plan.plan === planOf(item) ? "Your plan" : "Switch under Manage subscription"}</p> : buy(item, "Subscribe")}
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
        Credits are what a video is made with: before one is made you are shown the most it can use, and that is the limit.
        {topups.length > 0 ? " A plan's credits are spent before a top-up's." : ""} Payments are handled by Stripe; Flow Chain AI never sees your card.
      </p>
    </div>
  );
}
