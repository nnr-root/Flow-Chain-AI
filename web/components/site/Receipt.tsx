import { ENGINE_OF_LINE } from "@/lib/engines";
import type { ShowcaseReceipt } from "@/lib/site/showcases";

/** To the hundredth of a cent, as the ledger keeps it. */
const exact = (usd: number): string => `$${usd.toFixed(4)}`;

/**
 * What a video cost, as a till slip: every line from the run's own ledger (Phase 4 spec §3.3). The amounts are
 * the credit the video used; nothing on it is rounded in the page's favour.
 */
export function Receipt({ receipt }: { receipt: ShowcaseReceipt }) {
  return (
    <div className="receipt figures w-full max-w-[19rem] px-5 pb-7 pt-5 text-[0.78rem] leading-[1.55] text-ink" data-testid="receipt">
      <p className="font-medium">{receipt.title}</p>
      <p className="text-graphite">{receipt.date}, {receipt.seconds.toFixed(1)} s, {receipt.scenes} scenes</p>
      <dl className="mt-3 border-t border-dashed border-ink/30 pt-3">
        {receipt.lines.map((line) => (
          <div key={line.label} className="mt-1.5 first:mt-0">
            <div className="flex items-baseline gap-2">
              <dt>{line.label}</dt>
              <span aria-hidden="true" className="min-w-4 flex-1 border-b border-dotted border-ink/35" />
              <dd>{exact(line.usd)}</dd>
            </div>
            {/* an engine is named only on a video it made: one made before the studio had its own carries no name */}
            {receipt.madeOn === "own" && ENGINE_OF_LINE[line.label] && <p className="text-graphite">{ENGINE_OF_LINE[line.label]}</p>}
          </div>
        ))}
        <div className="mt-1.5 flex items-baseline gap-2">
          <dt>The cut</dt>
          <span aria-hidden="true" className="min-w-4 flex-1 border-b border-dotted border-ink/35" />
          <dd>free</dd>
        </div>
      </dl>
      <p className="mt-3 flex items-baseline justify-between border-t border-dashed border-ink/30 pt-3 text-[0.9rem] font-medium">
        <span>Credit used</span>
        <span data-testid="receipt-total">{exact(receipt.totalUsd)}</span>
      </p>
    </div>
  );
}
