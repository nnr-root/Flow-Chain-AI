import { SiteFooter } from "@/components/site/SiteFooter";
import { SiteNav } from "@/components/site/SiteNav";
import { billingOn } from "@/lib/billing";
import { accountsOnly, headerAccount } from "@/server/page";

export const dynamic = "force-dynamic";
export const metadata = { title: "Privacy — Flow Chain" };

/**
 * A place for the privacy policy, which the owner has yet to supply (Phase 4 spec §11). It says so, rather than
 * carry text nobody with the authority to write it has written. It must be replaced before real money is taken.
 */
export default async function Page() {
  accountsOnly();
  const signedIn = (await headerAccount()) !== null;
  return (
    <>
      <SiteNav signedIn={signedIn} sells={billingOn()} />
      <main className="mx-auto max-w-[84rem] px-6 pb-10 pt-14 sm:px-10 lg:pt-20" data-testid="legal-pending">
        <h1 className="display text-[clamp(2.4rem,1.2rem+5vw,5rem)] leading-[0.98] tracking-[-0.03em]">Privacy</h1>
        <p className="mt-7 max-w-[38rem] text-[1.15rem] leading-[1.5]">The privacy policy is being written and is not published yet. What exists today: an account is an email address, and a password unless you sign in with Google, kept by Supabase; the sentences you type, the videos made from them and the files you upload are kept with your account; payments are made on Stripe’s pages, and Flow Chain never receives a card number; this site sets no advertising or tracking cookies.</p>
      </main>
      <SiteFooter sells={billingOn()} />
    </>
  );
}
