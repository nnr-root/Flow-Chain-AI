import type { Showcase } from "@/lib/site/showcases";
import { ENGINES } from "@/lib/engines";

const exact = (usd: number): string => `$${usd.toFixed(4)}`;

/** The voice as it was spoken: one bar for each stretch of the recording. */
function Waveform({ peaks }: { peaks: number[] }) {
  const gap = 100 / peaks.length;
  return (
    <svg viewBox="0 0 100 28" preserveAspectRatio="none" className="h-14 w-full" role="img" aria-label="The recording's loudness over time">
      {peaks.map((p, i) => {
        const h = Math.max(0.8, p * 26);
        return <rect key={i} x={i * gap + gap * 0.2} y={(28 - h) / 2} width={gap * 0.6} height={h} fill="var(--color-ink)" />;
      })}
    </svg>
  );
}

function Step({ n, name, cost, children }: { n: number; name: string; cost: string; children: React.ReactNode }) {
  return (
    <li className="flex w-[78vw] max-w-[19rem] shrink-0 snap-start flex-col border-l border-hairline pl-5 pr-3 lg:w-auto lg:max-w-none lg:shrink">
      <p className="flex items-baseline justify-between gap-3">
        <span className="display text-[1.6rem] leading-none"><span className="figures mr-2 text-[0.8rem] text-graphite">{n}</span>{name}</span>
        <span className="figures text-[0.78rem] text-graphite">{cost}</span>
      </p>
      <div className="mt-4 flex-1 text-[0.92rem] leading-[1.45]">{children}</div>
    </li>
  );
}

/**
 * How a video is made, in the order it happens, shown with what one real run produced at each step and what
 * that step cost (Phase 4 spec §5, block 3). The steps are numbered because they are a sequence.
 */
export function MakingStrip({ showcase }: { showcase: Showcase }) {
  const { making, receipt, slug } = showcase;
  const cost = (label: string) => receipt.lines.find((l) => l.label === label)?.usd ?? 0;
  const clips = making.scenes.filter((s) => s.kind === "clip").length;
  const stills = making.scenes.length - clips;
  // an engine is named only on a video it made (one made before the studio had its own carries no name)
  const own = receipt.madeOn === "own";
  return (
    <ol className="-mx-6 flex snap-x snap-mandatory gap-0 overflow-x-auto px-6 pb-2 lg:mx-0 lg:grid lg:grid-cols-5 lg:overflow-visible lg:px-0" data-testid="making">
      <Step n={1} name="Topic" cost="free">
        <p className="display text-[1.35rem] leading-[1.15]">“{making.topic}”</p>
        <p className="mt-3 text-graphite">One sentence is all it starts from.</p>
      </Step>
      <Step n={2} name="Script" cost={exact(cost("Script"))}>
        <ol className="space-y-2">
          {making.scenes.map((s, i) => <li key={i}>{s.narration}</li>)}
        </ol>
        <p className="mt-3 text-graphite">Written for you: one line a scene, with a picture and a camera move for each.</p>
      </Step>
      <Step n={3} name="Voice" cost={exact(cost("Voice"))}>
        <Waveform peaks={making.voice.peaks} />
        <p className="mt-3 text-graphite">{own ? `Spoken by ${ENGINES.voice}` : "Spoken"}, with the pauses trimmed. Everything after is timed to these {making.voice.seconds.toFixed(1)} seconds.</p>
      </Step>
      <Step n={4} name="Pictures" cost={exact(cost("Pictures") + cost("Clips"))}>
        <ul className="grid grid-cols-4 gap-1.5">
          {making.scenes.map((s, i) => (
            <li key={i}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={`/showcase/${slug}/${s.thumb}`} alt={`Scene ${i + 1}: a ${s.kind}`} loading="lazy" className="aspect-[9/16] w-full rounded-[2px] object-cover" />
            </li>
          ))}
        </ul>
        <p className="mt-3 text-graphite">
          {clips} moving {clips === 1 ? "clip" : "clips"}{stills > 0 ? ` and ${stills} ${stills === 1 ? "still" : "stills"} with a camera move` : ""}, each cut to the length of its line.
          {own && ` Pictures by ${ENGINES.pictures}, clips by ${ENGINES.clips}.`}
        </p>
      </Step>
      <Step n={5} name="The cut" cost="free">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={`/showcase/${slug}/poster.jpg`} alt={`The finished video, “${receipt.title}”`} loading="lazy" className="aspect-[9/16] w-24 rounded-[2px] object-cover" />
        <p className="mt-3 text-graphite">Captions word by word, the opening title, transitions, music and sound effects. Cutting it again with another look costs nothing.</p>
      </Step>
    </ol>
  );
}
