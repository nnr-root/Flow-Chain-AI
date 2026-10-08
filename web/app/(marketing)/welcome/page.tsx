import { SiteFooter } from "@/components/site/SiteFooter";
import { SiteNav } from "@/components/site/SiteNav";
import { Calculator, type Engine } from "@/components/site/Calculator";
import { Faq } from "@/components/site/Faq";
import { FeatureStage } from "@/components/site/FeatureStage";
import { LiveStage } from "@/components/site/LiveStage";
import { MakingStrip } from "@/components/site/MakingStrip";
import { Plans } from "@/components/site/Plans";
import { Shelf } from "@/components/site/Shelf";
import { TopicStart } from "@/components/site/TopicStart";
import comparison from "@/content/comparison.json";
import { billingOn, type CatalogueItem } from "@/lib/billing";
import { freshComparisons, mean } from "@/lib/site/calculator";
import type { Showcase } from "@/lib/site/showcases";
import { catalogue } from "@/server/billing/catalogue";
import { welcomeOffer } from "@/server/site/welcome";
import { SHOWCASES } from "@/lib/site/showcases";
import { currentPlan } from "@/server/billing/actions";
import { accountsOnly, forUser, headerAccount } from "@/server/page";

export const dynamic = "force-dynamic";

const H2 = "display max-w-[50rem] text-[clamp(2rem,1.2rem+3.2vw,3.5rem)] leading-[1.02] tracking-[-0.025em]";

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
  // a new account is given credit for a first draft: only then does the page say "free"
  const free = !signedIn && (await welcomeOffer()) > 0;
  const hero = SHOWCASES[0];
  // the features are shown on a video that was made with a brand kit
  const branded = SHOWCASES.find((s) => s.looks.brand !== null) ?? hero;
  // what is on sale, from Stripe; without it (payments off, or Stripe away) the page simply has no prices on it
  const items: CatalogueItem[] = sells ? await catalogue().catch(() => []) : [];
  const plan = signedIn && items.length > 0 ? await forUser(currentPlan).catch(() => null) : null;
  const today = new Date();
  const others = freshComparisons(comparison, today);
  const asOf = others.map((c) => c.checkedOn).sort()[0] ?? "";
  return (
    <div data-testid="landing">
      <SiteNav signedIn={signedIn} sells={sells} free={free} />
      <main className="mx-auto max-w-[84rem] px-6 sm:px-10">
        <LiveStage showcases={SHOWCASES}>
          <h1 className="display text-display">Type a topic. Get a finished short video.</h1>
          <p className="mt-8 max-w-[34rem] text-[1.2rem] leading-[1.45] text-graphite">
            Flow Chain writes the script, records the voice, generates the pictures and cuts the video to the words.
            You see what it will cost, and approve it, before anything is bought.
          </p>
          <TopicStart signedIn={signedIn} free={free} />
          {sells && (
            <p className="mt-6">
              <a href="/pricing" data-cta="hero-pricing" className="underline decoration-hairline decoration-2 underline-offset-[6px] hover:decoration-ink">See pricing</a>
            </p>
          )}
        </LiveStage>

        <section className="mt-24" aria-labelledby="making-title">
          <h2 id="making-title" className={H2}>From one sentence to a finished video, in five steps</h2>
          <p className="mt-5 max-w-[40rem] text-[1.1rem] text-graphite">This is how “{hero.receipt.title}”, the first video in the player above, was made, and what each step cost.</p>
          <div className="mt-12"><MakingStrip showcase={hero} /></div>
        </section>

        <section className="mt-28" aria-labelledby="features-title">
          <h2 id="features-title" className={H2}>The parts an editor would do by hand</h2>
          <div className="mt-12"><FeatureStage showcase={branded} /></div>
        </section>

        <section className="mt-28" aria-labelledby="shelf-title">
          <h2 id="shelf-title" className={H2}>Three videos, and what each one cost</h2>
          <p className="mt-5 max-w-[40rem] text-[1.1rem] text-graphite">Nobody has reviewed Flow Chain yet, so here is the work itself, with the receipts.</p>
          <div className="mt-12"><Shelf showcases={SHOWCASES} /></div>
        </section>

        {items.length > 0 && (
          <section className="mt-28" aria-labelledby="calculator-title">
            <h2 id="calculator-title" className={H2}>What your month would cost</h2>
            <div className="mt-12"><Calculator items={items} engines={enginesOf(SHOWCASES)} others={others} asOf={asOf} /></div>
          </section>
        )}

        {items.length > 0 && (
          <section className="mt-28" aria-labelledby="sale-title">
            <h2 id="sale-title" className={H2}>What is on sale</h2>
            <div className="mt-12"><Plans items={items} signedIn={signedIn} plan={plan} /></div>
          </section>
        )}

        <section className="mt-28" aria-labelledby="faq-title">
          <h2 id="faq-title" className={H2}>Before you ask</h2>
          <div className="mt-10"><Faq usedCents={SHOWCASES.map((s) => Math.round(s.receipt.totalUsd * 100))} /></div>
        </section>

        <section className="mt-28 border-t border-ink/30 pt-14" aria-labelledby="close-title">
          <h2 id="close-title" className="display max-w-[46rem] text-[clamp(2.4rem,1.2rem+5vw,5rem)] leading-[0.98] tracking-[-0.03em]">Start with one sentence.</h2>
          <TopicStart signedIn={signedIn} free={free} id="closing-topic" />
        </section>
      </main>
      <SiteFooter sells={sells} />
    </div>
  );
}
