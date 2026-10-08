import { SiteFooter } from "@/components/site/SiteFooter";
import { SiteNav } from "@/components/site/SiteNav";
import { Calculator, type Engine } from "@/components/site/Calculator";
import { FeatureStage } from "@/components/site/FeatureStage";
import { LiveStage } from "@/components/site/LiveStage";
import { MakingStrip } from "@/components/site/MakingStrip";
import { Shelf } from "@/components/site/Shelf";
import comparison from "@/content/comparison.json";
import { billingOn, type CatalogueItem } from "@/lib/billing";
import { freshComparisons, mean } from "@/lib/site/calculator";
import type { Showcase } from "@/lib/site/showcases";
import { catalogue } from "@/server/billing/catalogue";
import { SHOWCASES } from "@/lib/site/showcases";
import { accountsOnly, headerAccount } from "@/server/page";

export const dynamic = "force-dynamic";

/** The showcase videos as the calculator's two ways of making pictures, each with what its videos really used. */
function enginesOf(showcases: Showcase[]): Engine[] {
  const group = (id: string, name: string, of: Showcase[]): Engine[] =>
    of.length === 0 ? [] : [{
      id, name, videos: of.length,
      models: `${of[0].receipt.engines.pictures.replace(/, on .*/, "")} and ${of[0].receipt.engines.clips.replace(/, on .*/, "")}`,
      creditPerVideoUsd: mean(of.map((s) => s.receipt.totalUsd)),
      clipSeconds: mean(of.map((s) => s.making.scenes.filter((scene) => scene.kind === "clip").reduce((sum, scene) => sum + scene.seconds, 0))),
    }];
  const own = showcases.filter((s) => /our own GPU/.test(s.receipt.engines.clips));
  return [...group("own", "Our own GPU", own), ...group("hosted", "Hosted models", showcases.filter((s) => !own.includes(s)))];
}

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
  // what is on sale, from Stripe; without it (payments off, or Stripe away) the page simply has no prices on it
  const items: CatalogueItem[] = sells ? await catalogue().catch(() => []) : [];
  const today = new Date();
  const others = freshComparisons(comparison, today);
  const asOf = others.map((c) => c.checkedOn).sort()[0] ?? "";
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

        {items.length > 0 && (
          <section className="mt-28" aria-labelledby="calculator-title">
            <h2 id="calculator-title" className="display max-w-[50rem] text-[clamp(2rem,1.2rem+3.2vw,3.5rem)] leading-[1.02] tracking-[-0.025em]">What your month would cost</h2>
            <div className="mt-12"><Calculator items={items} engines={enginesOf(SHOWCASES)} others={others} asOf={asOf} /></div>
          </section>
        )}
      </main>
      <SiteFooter sells={sells} />
    </div>
  );
}
