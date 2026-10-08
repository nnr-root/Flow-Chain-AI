"use client";
import { useId, useState } from "react";
import type { CatalogueItem } from "@/lib/billing";
import { clipsCostUsd, type Comparison, quote } from "@/lib/site/calculator";

const usd = (n: number): string => `$${n.toFixed(2)}`;

export type Engine = {
  id: string;
  /** "Our own GPU", "Hosted models". */
  name: string;
  /** What the pictures are made with, in the receipts' words. */
  models: string;
  /** The mean credit a showcase video made this way used, and from how many videos that is. */
  creditPerVideoUsd: number;
  videos: number;
  /** The mean seconds of generated clips in such a video: what is compared with a company that sells clips. */
  clipSeconds: number;
  /** The mean length of such a video. */
  seconds: number;
};

/**
 * What a month of videos costs (Phase 4 spec §7). Every figure is worked out by lib/site/calculator from the
 * live catalogue, the showcase videos' receipts, and — for other companies — dated, sourced entries. The table
 * of other companies only appears when there are entries fresh enough to show.
 */
export function Calculator({ items, engines, others, asOf }: { items: CatalogueItem[]; engines: Engine[]; others: Comparison[]; asOf: string }) {
  const [videos, setVideos] = useState(20);
  const [engineId, setEngineId] = useState(engines[0].id);
  const slider = useId();
  const engine = engines.find((e) => e.id === engineId) ?? engines[0];
  const q = quote(videos, engine.creditPerVideoUsd, items);
  const seconds = Math.round(engine.clipSeconds * 10) / 10;

  return (
    <div data-testid="calculator">
      <div className="grid gap-x-16 gap-y-10 lg:grid-cols-12">
        <div className="lg:col-span-5">
          <label htmlFor={slider} className="block text-[1.02rem]">
            Videos a month
            <output htmlFor={slider} className="display float-right text-[2.6rem] leading-none" data-testid="calc-videos">{videos}</output>
          </label>
          <input id={slider} type="range" min={1} max={150} step={1} value={videos} onChange={(e) => setVideos(Number(e.target.value))} className="range mt-5 w-full" />
          <fieldset className="mt-8">
            <legend className="text-[1.02rem]">Pictures made with</legend>
            <div className="mt-3 space-y-2.5">
              {engines.map((e) => (
                <label key={e.id} className="flex cursor-pointer items-baseline gap-3">
                  <input type="radio" name="engine" value={e.id} checked={e.id === engineId} onChange={() => setEngineId(e.id)} className="accent-[var(--color-ink)]" />
                  <span>
                    {e.name} <span className="figures text-[0.8rem] text-graphite">about {usd(e.creditPerVideoUsd)} of credit a video</span>
                    <span className="block text-[0.9rem] text-graphite">{e.models}</span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
        </div>

        <div className="lg:col-span-7">
          {q ? (
            <>
              <p className="display text-[clamp(2.2rem,1.4rem+3vw,3.6rem)] leading-[1.02] tracking-[-0.02em]" data-testid="calc-answer">
                {usd(q.monthUsd)} for the month, which is {usd(q.perVideoUsd)} a video.
              </p>
              <p className="mt-5 max-w-[36rem] text-[1.02rem] leading-[1.5]" data-testid="calc-buy">
                Buy {q.buy.map((b) => `${b.times > 1 ? `${b.times} × ` : ""}${b.item.name} (${usd(b.item.priceUsd)}${b.item.kind === "plan" ? " a month" : ""})`).join(" and ")}: {usd(q.creditUsd)} of credit, enough for about {q.videos} such videos.
                {q.buy.some((b) => b.item.kind === "plan") ? " A plan's credit is for its month; a top-up's does not expire." : " A top-up's credit does not expire, so what you do not use this month is still there the next."}
              </p>
            </>
          ) : (
            <p className="max-w-[36rem] text-[1.1rem]" data-testid="calc-answer">That many videos is more than what is on sale covers in one month. <a href="/pricing" className="underline underline-offset-4">See what is on sale.</a></p>
          )}
          <p className="mt-4 max-w-[36rem] text-[0.92rem] text-graphite">
            “About {usd(engine.creditPerVideoUsd)}” is the mean of the {engine.videos === 1 ? "one video" : `${engine.videos} videos`} above made this way, about {Math.round(engine.seconds)} seconds each. Yours will use more or less with their length and how many scenes move; you are shown the most a video can cost before it is made.
          </p>
        </div>
      </div>

      {others.length > 0 && q && seconds > 0 && (
        <div className="mt-16" data-testid="calc-others">
          <h3 className="display text-[1.9rem] leading-[1.05]">The same month elsewhere</h3>
          <p className="mt-3 max-w-[44rem] text-[1.02rem] leading-[1.5]">
            Other tools sell generated clips by the second. {videos} such videos hold about {Math.round(videos * seconds)} seconds of generated clips ({seconds} each), so that is what is priced below, at each plan’s price per credit. The script, the voice, the captions and the edit are not part of what they sell.
          </p>
          <div className="mt-6 overflow-x-auto">
            <table className="w-full min-w-[34rem] border-collapse text-left text-[0.98rem]">
              <thead>
                <tr className="border-b border-ink/30 text-[0.85rem] text-graphite">
                  <th scope="col" className="py-2 pr-4 font-normal">Where</th>
                  <th scope="col" className="py-2 pr-4 font-normal">What you get</th>
                  <th scope="col" className="py-2 pr-4 text-right font-normal">For the month</th>
                  <th scope="col" className="py-2 text-right font-normal">A video</th>
                </tr>
              </thead>
              <tbody className="figures text-[0.9rem]">
                <tr className="border-b border-hairline" data-testid="calc-row-ours">
                  <th scope="row" className="py-3 pr-4 font-medium">Flow Chain, {engine.name.charAt(0).toLowerCase() + engine.name.slice(1)}</th>
                  <td className="py-3 pr-4">The finished video. {engine.models}</td>
                  <td className="py-3 pr-4 text-right">{usd(q.monthUsd)}</td>
                  <td className="py-3 text-right">{usd(q.perVideoUsd)}</td>
                </tr>
                {others.map((c) => (
                  <tr key={`${c.name}-${c.model}-${c.resolution}`} className="border-b border-hairline" data-testid="calc-row-other">
                    <th scope="row" className="py-3 pr-4 font-normal">
                      <a href={c.source} target="_blank" rel="noreferrer" className="underline decoration-hairline decoration-2 underline-offset-4 hover:decoration-ink">{c.name}, {c.plan}</a>
                    </th>
                    <td className="py-3 pr-4">Clips only. {c.model}{c.resolution ? ` at ${c.resolution}` : ""}</td>
                    <td className="py-3 pr-4 text-right">{usd(clipsCostUsd(c, videos * seconds))}</td>
                    <td className="py-3 text-right">{usd(clipsCostUsd(c, seconds))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-4 max-w-[44rem] text-[0.92rem] text-graphite">
            Prices as their own pricing pages stated them {asOf}; each name links to its page. This compares prices, not pictures: the models differ, and so does how sharp and how lifelike their clips are. Their plans also hold a set number of credits a month, which a large month would exceed.
          </p>
        </div>
      )}
    </div>
  );
}
