import { notFound } from "next/navigation";
import { Plans } from "@/components/site/Plans";
import { SiteFooter } from "@/components/site/SiteFooter";
import { SiteNav } from "@/components/site/SiteNav";
import { billingOn, type CatalogueItem } from "@/lib/billing";
import { pricePerCreditDollar } from "@/lib/site/calculator";
import { currentPlan } from "@/server/billing/actions";
import { catalogue } from "@/server/billing/catalogue";
import { forUser, headerAccount } from "@/server/page";

export const dynamic = "force-dynamic";
export const metadata = { title: "Pricing — Flow Chain" };

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
  // "at a better rate" is said only when it is so: every plan's dollar of credit cheaper than every top-up's
  const rate = (kind: "plan" | "topup") => (items ?? []).filter((i) => i.kind === kind && i.creditUsd > 0).map(pricePerCreditDollar);
  const plansCheaper = rate("plan").length > 0 && rate("topup").length > 0 && Math.max(...rate("plan")) < Math.min(...rate("topup"));
  return (
    <>
      <SiteNav signedIn={me !== null} sells />
      <main className="mx-auto max-w-[84rem] px-6 pb-10 pt-14 sm:px-10 lg:pt-20">
        <h1 className="display max-w-[52rem] text-[clamp(2.4rem,1.2rem+5vw,5.5rem)] leading-[0.98] tracking-[-0.03em]">Buy credit. Spend it at what a video costs.</h1>
        <p className="mt-7 max-w-[38rem] text-[1.15rem] leading-[1.5] text-graphite">
          A plan gives you credit every month{plansCheaper ? " at a better rate" : ""}; a top-up gives you credit that stays until you use it. Either way a video takes only what it cost to make.
        </p>
        <div className="mt-16">
          {items ? <Plans items={items} signedIn={me !== null} plan={plan} /> : <p className="text-graphite" data-testid="pricing-unavailable">Prices are not available right now. Try again in a moment.</p>}
        </div>
      </main>
      <SiteFooter sells />
    </>
  );
}
