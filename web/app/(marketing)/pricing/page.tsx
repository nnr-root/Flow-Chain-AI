import { notFound } from "next/navigation";
import { Plans } from "@/components/site/Plans";
import { billingOn, type CatalogueItem } from "@/lib/billing";
import measured from "@/content/measured.json";
import { minutesOnSale } from "@/lib/site/calculator";
import { SHOWCASES } from "@/lib/site/showcases";
import { currentPlan } from "@/server/billing/actions";
import { catalogue } from "@/server/billing/catalogue";
import { forUser, headerAccount } from "@/server/page";

export const dynamic = "force-dynamic";
export const metadata = { title: "Pricing — Flow Chain AI" };

/** What the studio sells, in the landing page's look. Anyone may read it; buying needs an account. Only in a studio that takes payments. */
export default async function Page() {
  if (!billingOn()) notFound();
  const me = await headerAccount();
  let items: CatalogueItem[] | null;
  try {
    items = await catalogue();
  } catch {
    items = null;
  }
  // what is on sale can be shown without knowing the visitor's plan
  const plan = me && items ? await forUser(currentPlan).catch(() => null) : null;
  const on = (what: (i: CatalogueItem) => boolean) => (items ?? []).some(what);
  const yearly = on((i) => i.kind === "plan" && i.interval === "year");
  const topups = on((i) => i.kind === "topup");
  return (
    <>
      <main className="mx-auto max-w-[84rem] px-6 pb-10 pt-14 sm:px-10 lg:pt-20">
        <h1 className="display max-w-[52rem] text-[clamp(2.4rem,1.2rem+5vw,5.5rem)] leading-[0.92]">Buy credits. Make videos with them.</h1>
        <p className="mt-7 max-w-[38rem] text-[1.15rem] leading-[1.5] text-graphite">
          A plan gives you credits every month{yearly ? ", whether you pay by the month or, for less, by the year" : ""}{topups ? "; a top-up gives you credits that stay until you use them" : ""}. A video takes credits by its length and by how many of its scenes move, and you see the most it can take before it is made.
        </p>
        <div className="mt-16">
          {items ? <Plans items={items} signedIn={me !== null} plan={plan} minutes={minutesOnSale(items, measured, SHOWCASES.map((s) => s.receipt), new Date())} /> : <p className="text-graphite" data-testid="pricing-unavailable">Prices are not available right now. Try again in a moment.</p>}
        </div>
      </main>
    </>
  );
}
