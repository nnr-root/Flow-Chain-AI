import { inCredits } from "@/lib/credit";
import { Stage } from "@/components/site/Stage";
import { SHOWCASES } from "@/lib/site/showcases";

/**
 * What stands beside the account forms: a frame of a real video the studio made and what it cost, from its own
 * receipt. The form is one step of the same visit that began on the landing page, and looks it.
 */
export function AuthAside() {
  const { slug, receipt } = SHOWCASES[0];
  return (
    <div className="hidden w-full max-w-[17rem] lg:block">
      <Stage caption={[`${receipt.seconds.toFixed(1)} s, ${receipt.scenes} scenes`, inCredits(receipt.totalUsd)]}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={`/showcase/${slug}/poster.jpg`} alt={`A frame of “${receipt.title}”, a video made with Flow Chain AI`} className="absolute inset-0 h-full w-full object-cover" />
      </Stage>
    </div>
  );
}
