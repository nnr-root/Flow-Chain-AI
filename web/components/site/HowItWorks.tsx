import { PRESETS } from "@src/presets";
import { inCredits } from "@/lib/credit";
import { inWords } from "@/lib/site/calculator";
import type { Showcase } from "@/lib/site/showcases";

const exact = (usd: number): string => inCredits(usd);
const usd = exact;

/** One step: what it is called, what happens in it, and beside the words a picture of it made from a real video's own data. */
function Step({ n, name, lead, points, flip, children }: { n: number; name: string; lead: string; points: string[]; flip?: boolean; children: React.ReactNode }) {
  return (
    <li className="grid items-center gap-x-14 gap-y-8 lg:grid-cols-2">
      <div className={`rounded-[26px] bg-sheet p-6 sm:p-8 ${flip ? "lg:order-2" : ""}`}>{children}</div>
      <div>
        <p><span className="note rounded-full bg-wash px-3 py-1 text-[0.85rem]">Step {n}</span></p>
        <h3 className="printed mt-4 text-[clamp(1.6rem,1.2rem+1.4vw,2.2rem)] leading-[1.08]">{name}</h3>
        <p className="mt-3 max-w-[30rem] text-[1.08rem] leading-[1.5] text-graphite">{lead}</p>
        <ul className="mt-5 space-y-2.5">
          {points.map((point) => (
            <li key={point} className="flex gap-3 text-[1.02rem] leading-snug">
              <span aria-hidden="true" className="mt-[0.45em] h-2 w-2 shrink-0 rounded-full bg-signal" />
              {point}
            </li>
          ))}
        </ul>
      </div>
    </li>
  );
}

/**
 * How a video is made here, as three steps a visitor takes (Phase 4 spec §17). Beside each step is not a drawing
 * of the product but what one real run produced at that point: the sentence it began with and the lines written
 * from it, the looks there are to choose from, the finished video and what it used. The steps are numbered
 * because they are a sequence.
 */
export function HowItWorks({ showcase }: { showcase: Showcase }) {
  const { making, receipt, slug } = showcase;
  const script = receipt.lines.find((l) => l.label === "Script")?.usd ?? 0;
  const looks = Object.values(PRESETS);
  return (
    <ol className="space-y-20" data-testid="how">
      <Step n={1} name="Type one sentence" lead="The script is written from it: an opening title, a line for each scene, and for each line a picture and a camera move." points={["Only the script is bought at this point", `This one's script used ${exact(script)}`, "Upright for a phone, or wide"]}>
        <p className="note text-[0.85rem] text-graphite">The sentence</p>
        <p className="mt-2 rounded-[18px] bg-wash px-4 py-3 text-[1.02rem] leading-snug">{making.topic}</p>
        <p className="note mt-6 text-[0.85rem] text-graphite">The script written from it</p>
        <ol className="mt-2 space-y-2">
          {making.scenes.map((scene, i) => (
            <li key={i} className="flex gap-3 text-[0.92rem] leading-snug text-graphite"><span className="note text-ink">{i + 1}</span>{scene.narration}</li>
          ))}
        </ol>
      </Step>
      <Step flip n={2} name="Pick a look and approve the price" lead="You see a draft with the real captions, cuts and music before a single picture is made, and what the rest can cost at most." points={[`${inWords(looks.length).replace(/^./, (c) => c.toUpperCase())} looks, or let the topic choose`, "Each scene a moving clip or a still, as you like", "That amount is the limit: nothing more is spent without you"]}>
        <p className="note text-[0.85rem] text-graphite">The looks</p>
        <ul className="mt-3 flex flex-wrap gap-2">
          {looks.map((look, i) => (
            <li key={look.name} className={`rounded-full px-3.5 py-1.5 text-[0.9rem] font-bold ${i === 0 ? "bg-marker text-paper" : "bg-wash"}`}>{look.label}</li>
          ))}
        </ul>
      </Step>
      <Step n={3} name="Get the video, and change it for free" lead="The voice is recorded first and everything is cut to it. When it is done you can give it another look as often as you like." points={["Captions, cuts and the opening title change at no cost", "Any single scene can be made again", "Download the MP4, with your logo on it if you have a brand kit"]}>
        <div className="flex items-center gap-6">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={`/showcase/${slug}/poster.jpg`} alt={`The finished video, “${receipt.title}”`} loading="lazy" className="aspect-[9/16] w-32 shrink-0 rounded-[18px] object-cover ring-1 ring-hairline" />
          <dl className="space-y-3 text-[1.02rem]">
            <div><dt className="text-[0.85rem] text-graphite">The video</dt><dd className="note">{receipt.title}</dd></div>
            <div><dt className="text-[0.85rem] text-graphite">Length</dt><dd className="note">{receipt.seconds.toFixed(1)} s, {receipt.scenes} scenes</dd></div>
            <div><dt className="text-[0.85rem] text-graphite">Used, all in</dt><dd className="note text-[1.6rem] leading-none">{usd(receipt.totalUsd)}</dd></div>
          </dl>
        </div>
      </Step>
    </ol>
  );
}
