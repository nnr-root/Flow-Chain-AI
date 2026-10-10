import { Calculator, type Engine } from "@/components/site/Calculator";
import { Faq } from "@/components/site/Faq";
import { FeatureStage } from "@/components/site/FeatureStage";
import { HowItWorks } from "@/components/site/HowItWorks";
import { LiveStage } from "@/components/site/LiveStage";
import { MakingStrip } from "@/components/site/MakingStrip";
import { Plans } from "@/components/site/Plans";
import { Shelf } from "@/components/site/Shelf";
import { Spoken } from "@/components/site/Spoken";
import { TopicStart } from "@/components/site/TopicStart";
import comparison from "@/content/comparison.json";
import { billingOn, type CatalogueItem } from "@/lib/billing";
import { DRAFT_CAP_USD } from "@/lib/credit";
import { clipsClaimHolds, freshComparisons, inWords, mean } from "@/lib/site/calculator";
import type { Showcase } from "@/lib/site/showcases";
import { catalogue } from "@/server/billing/catalogue";
import { welcomeOffer } from "@/server/site/welcome";
import { SHOWCASES } from "@/lib/site/showcases";
import { currentPlan } from "@/server/billing/actions";
import { accountsOnly, forUser, headerAccount } from "@/server/page";

export const dynamic = "force-dynamic";

/**
 * A part of the page: its title and one line under it, centred, then what belongs to it. Every part is set the
 * same way and stands the same distance from the one before, so the page reads as one even run of them
 * (Phase 4 spec §17).
 */
function Part({ id, title, sub, children, narrow }: { id: string; title: string; sub?: React.ReactNode; children: React.ReactNode; narrow?: boolean }) {
  return (
    <section id={id} className="mt-28 scroll-mt-10 lg:mt-36" aria-labelledby={`${id}-title`}>
      <div className="mx-auto max-w-[46rem] text-center">
        <h2 id={`${id}-title`} className="display text-[clamp(1.8rem,1.2rem+2.4vw,3rem)] leading-[1]">{title}</h2>
        {sub && <p className="mx-auto mt-4 max-w-[38rem] text-[1.1rem] leading-[1.5] text-graphite">{sub}</p>}
      </div>
      <div className={`mt-12 ${narrow ? "mx-auto max-w-[52rem]" : ""}`}>{children}</div>
    </section>
  );
}

/**
 * What a video costs here, for the calculator: the mean of the videos on the page that were made the way the
 * studio makes them now. A video made before that, on rented models, stays on the shelf with its receipt but is
 * not what a customer would pay today, so it is not counted.
 */
function engineOf(showcases: Showcase[]): Engine | null {
  const of = showcases.filter((s) => s.receipt.madeOn === "own");
  if (of.length === 0) return null;
  return {
    videos: of.length,
    creditPerVideoUsd: mean(of.map((s) => s.receipt.totalUsd)),
    clipSeconds: mean(of.map((s) => s.making.scenes.filter((scene) => scene.kind === "clip").reduce((sum, scene) => sum + scene.seconds, 0))),
    seconds: mean(of.map((s) => s.receipt.seconds)),
  };
}

export default async function Page() {
  accountsOnly();
  const signedIn = (await headerAccount()) !== null;
  const sells = billingOn();
  // a new account is given credit for a first draft: only then does the page say "free"
  // (credit that does not cover a draft's hold would be a promise the form then breaks)
  const free = !signedIn && (await welcomeOffer()) >= DRAFT_CAP_USD;
  const hero = SHOWCASES[0];
  // the features are shown on a video that was made with a brand kit
  const branded = SHOWCASES.find((s) => s.looks.brand !== null) ?? hero;
  // what is on sale, from Stripe; without it (payments off, or Stripe away) the page simply has no prices on it
  const items: CatalogueItem[] = sells ? await catalogue().catch(() => []) : [];
  const plan = signedIn && items.length > 0 ? await forUser(currentPlan).catch(() => null) : null;
  const today = new Date();
  const others = freshComparisons(comparison, today);
  const read = [...new Set(others.map((c) => c.checkedOn))].sort();
  const asOf = read.length <= 1 ? `on ${read[0] ?? ""}` : `between ${read[0]} and ${read.at(-1)}`;
  // The headline compares with other companies only while the calculator below can show the comparison and it
  // holds — their prices fresh, ours on sale — for the way this studio usually makes its pictures: the claim and
  // its evidence stand or fall together.
  const engine = engineOf(SHOWCASES);
  // (no video on the page made the way the studio makes them now: nothing to hold the claim to, so it is not made)
  const claim = engine !== null && clipsClaimHolds(engine.creditPerVideoUsd, engine.clipSeconds, items, others);
  return (
    <div data-testid="landing">
      <main className="mx-auto max-w-[84rem] px-6 pb-4 sm:px-10">
        <LiveStage showcases={SHOWCASES} title={<h1 className="display mx-auto max-w-[62rem] text-display" data-claim={claim}><Spoken rest="finished" text={claim ? "A finished short video for about what others charge for the clips." : "Type a topic. Get a finished short video."} /></h1>}>
          <p className="mx-auto mt-5 max-w-[38rem] text-[1.12rem] leading-[1.5] text-graphite">
            Flow Chain writes the script, records the voice, generates the pictures and cuts the video to the words.
            You see what it will cost, and approve it, before anything is bought.
          </p>
          <TopicStart signedIn={signedIn} free={free} sells={sells} />
        </LiveStage>

        <Part id="how" title="How it works" sub="A video in three steps. Beside each one is what a real video on this page had at that point.">
          <HowItWorks showcase={hero} />
        </Part>

        <Part id="making" title="See one being made" sub={<>How “{hero.receipt.title}” came together, step by step, against its own {hero.receipt.seconds.toFixed(1)} seconds, and what each step cost.</>}>
          <MakingStrip showcase={hero} />
        </Part>

        <Part id="features" title="The parts an editor would do by hand" sub="Each one shown on a real video rather than described: press the buttons.">
          <FeatureStage showcase={branded} />
        </Part>

        <Part id="shelf" title={`${inWords(SHOWCASES.length).replace(/^./, (c) => c.toUpperCase())} videos, and what each one cost`} sub="Nobody has reviewed Flow Chain yet, so here is the work itself, with the receipts.">
          <Shelf showcases={SHOWCASES} />
        </Part>

        {items.length > 0 && engine && (
          <Part id="calculator" title="What your month would cost" sub="Worked out from what is on sale and from what the videos above really used.">
            <Calculator items={items} engine={engine} others={others} asOf={asOf} />
          </Part>
        )}

        {items.length > 0 && (
          <Part id="sale" title="What is on sale">
            <Plans items={items} signedIn={signedIn} plan={plan} />
          </Part>
        )}

        <Part id="faq" title="Before you ask" narrow>
          <Faq usedCents={SHOWCASES.map((s) => Math.round(s.receipt.totalUsd * 100))} sells={sells} clipHeight={SHOWCASES.find((s) => s.receipt.madeOn === "own" && s.receipt.clipHeight)?.receipt.clipHeight} />
        </Part>

        <section className="mt-28 rounded-[32px] bg-sheet px-6 py-14 text-center sm:px-10 lg:mt-36 lg:py-20" aria-labelledby="close-title">
          <h2 id="close-title" className="display mx-auto max-w-[40rem] text-[clamp(2rem,1.2rem+3.4vw,3.8rem)] leading-[0.98]">Start with one sentence.</h2>
          <TopicStart signedIn={signedIn} free={free} sells={sells} id="closing-topic" />
        </section>
      </main>
    </div>
  );
}
