import { credits } from "@/lib/credit";
import type { ShowcaseReceipt } from "@/lib/site/showcases";

/** In credits, the unit a customer is shown (phase 6 spec §12): each line is what that part of the video used. */
const exact = (usd: number): string => credits(usd).toLocaleString("en-US");

/**
 * What a video cost, as a till slip: every line from the run's own ledger (Phase 4 spec §3.3). The amounts are
 * the credit the video used; nothing on it is rounded in the page's favour.
 */
export function Receipt({ receipt }: { receipt: ShowcaseReceipt }) {
  return (
    <div className="receipt figures w-full max-w-[19rem] px-5 pb-7 pt-5 text-[0.88rem] leading-[1.55] text-ink" data-testid="receipt">
      <p className="font-bold leading-snug">{receipt.title}</p>
      <p className="text-graphite">{receipt.date}, {receipt.seconds.toFixed(1)} s, {receipt.scenes} scenes</p>
      <dl className="mt-3 border-t border-dashed border-ink/30 pt-3">
        {receipt.lines.map((line) => (
          <div key={line.label} className="mt-1.5 first:mt-0">
            <div className="flex items-baseline gap-2">
              <dt>{line.label}</dt>
              <span aria-hidden="true" className="min-w-4 flex-1 border-b border-dotted border-ink/35" />
              <dd>{exact(line.usd)}</dd>
            </div>
          </div>
        ))}
        <div className="mt-1.5 flex items-baseline gap-2">
          <dt>The cut</dt>
          <span aria-hidden="true" className="min-w-4 flex-1 border-b border-dotted border-ink/35" />
          <dd>free</dd>
        </div>
      </dl>
      <p className="mt-3 flex items-baseline justify-between border-t border-dashed border-ink/30 pt-3 text-[1rem] font-bold">
        <span>Credits used</span>
        {/* (the sum of the lines as they are shown, so that a slip adds up to its own total to the credit) */}
        <span data-testid="receipt-total" className="note !text-[1.7rem]">{receipt.lines.reduce((sum, line) => sum + credits(line.usd), 0).toLocaleString("en-US")}</span>
      </p>
    </div>
  );
}
