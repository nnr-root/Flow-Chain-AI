import { SiteFooter } from "@/components/site/SiteFooter";
import { SiteNav } from "@/components/site/SiteNav";
import { FeatureStage } from "@/components/site/FeatureStage";
import { LiveStage } from "@/components/site/LiveStage";
import { MakingStrip } from "@/components/site/MakingStrip";
import { Shelf } from "@/components/site/Shelf";
import { billingOn } from "@/lib/billing";
import { SHOWCASES } from "@/lib/site/showcases";
import { accountsOnly, headerAccount } from "@/server/page";

export const dynamic = "force-dynamic";

/**
 * The landing page (Phase 4 spec §5). A visitor without a session who asks for `/` is shown this page at that
 * address (the proxy rewrites it); a studio without accounts has no landing page at all.
 */
export default async function Page() {
  accountsOnly();
  const signedIn = (await headerAccount()) !== null;
  const sells = billingOn();
  const hero = SHOWCASES[0];
  // the features are shown on a video that was made with a brand kit
  const branded = SHOWCASES.find((s) => s.looks.brand !== null) ?? hero;
  return (
    <div data-testid="landing">
      <SiteNav signedIn={signedIn} sells={sells} />
      <main className="mx-auto max-w-[84rem] px-6 sm:px-10">
        <LiveStage showcases={SHOWCASES}>
          <h1 className="display text-display">Type a topic. Get a finished short video.</h1>
          <p className="mt-8 max-w-[34rem] text-[1.2rem] leading-[1.45] text-graphite">
            Flow Chain writes the script, records the voice, generates the pictures and cuts the video to the words.
            You see what it will cost, and approve it, before anything is bought.
          </p>
          <div className="mt-10 flex flex-wrap items-baseline gap-x-8 gap-y-4">
            {signedIn ? (
              <a href="/new" data-cta="hero-new" className="rounded-md bg-ink px-6 py-3.5 text-[1.05rem] font-medium text-paper hover:bg-stage">Make a video</a>
            ) : (
              <a href="/signup?next=%2Fnew" data-cta="hero-signup" className="rounded-md bg-ink px-6 py-3.5 text-[1.05rem] font-medium text-paper hover:bg-stage">Create an account</a>
            )}
            {sells && <a href="/pricing" data-cta="hero-pricing" className="underline decoration-hairline decoration-2 underline-offset-[6px] hover:decoration-ink">See pricing</a>}
          </div>
        </LiveStage>

        <section className="mt-24" aria-labelledby="making-title">
          <h2 id="making-title" className="display max-w-[50rem] text-[clamp(2rem,1.2rem+3.2vw,3.5rem)] leading-[1.02] tracking-[-0.025em]">From one sentence to a finished video, in five steps</h2>
          <p className="mt-5 max-w-[40rem] text-[1.1rem] text-graphite">This is how “{hero.receipt.title}”, the first video in the player above, was made, and what each step cost.</p>
          <div className="mt-12"><MakingStrip showcase={hero} /></div>
        </section>

        <section className="mt-28" aria-labelledby="features-title">
          <h2 id="features-title" className="display max-w-[50rem] text-[clamp(2rem,1.2rem+3.2vw,3.5rem)] leading-[1.02] tracking-[-0.025em]">The parts an editor would do by hand</h2>
          <div className="mt-12"><FeatureStage showcase={branded} /></div>
        </section>

        <section className="mt-28" aria-labelledby="shelf-title">
          <h2 id="shelf-title" className="display max-w-[50rem] text-[clamp(2rem,1.2rem+3.2vw,3.5rem)] leading-[1.02] tracking-[-0.025em]">Three videos, and what each one cost</h2>
          <p className="mt-5 max-w-[40rem] text-[1.1rem] text-graphite">Nobody has reviewed Flow Chain yet, so here is the work itself, with the receipts.</p>
          <div className="mt-12"><Shelf showcases={SHOWCASES} /></div>
        </section>
      </main>
      <SiteFooter sells={sells} />
    </div>
  );
}
