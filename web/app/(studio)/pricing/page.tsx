import { notFound } from "next/navigation";
import { Pricing } from "@/components/Pricing";
import { billingOn, type CatalogueItem } from "@/lib/billing";
import { currentPlan } from "@/server/billing/actions";
import { catalogue } from "@/server/billing/catalogue";
import { forUser, headerAccount } from "@/server/page";

export const dynamic = "force-dynamic";

/** What the studio sells. Anyone may read it; buying needs an account. Only in a studio that takes payments. */
export default async function Page() {
  if (!billingOn()) notFound();
  let items: CatalogueItem[];
  try {
    items = await catalogue();
  } catch {
    return <p className="mx-auto max-w-4xl text-sm text-dim" data-testid="pricing-unavailable">Prices are not available right now. Try again in a moment.</p>;
  }
  const me = await headerAccount();
  // what is on sale can be shown without knowing the visitor's plan
  const plan = me ? await forUser(currentPlan).catch(() => null) : null;
  return <Pricing items={items} signedIn={!!me} plan={plan} />;
}
