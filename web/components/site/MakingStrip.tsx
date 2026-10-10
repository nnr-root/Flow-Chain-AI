import { inCredits } from "@/lib/credit";
import type { Showcase } from "@/lib/site/showcases";

const exact = (usd: number): string => inCredits(usd);

/** The voice as it was spoken: one bar for each stretch of the recording. */
function Waveform({ peaks }: { peaks: number[] }) {
  const gap = 100 / peaks.length;
  return (
    <svg viewBox="0 0 100 28" preserveAspectRatio="none" className="h-16 w-full" role="img" aria-label="The recording's loudness over time">
      {peaks.map((p, i) => {
        const h = Math.max(0.8, p * 26);
        return <rect key={i} x={i * gap + gap * 0.2} y={(28 - h) / 2} width={gap * 0.6} height={h} fill="var(--color-ink)" />;
      })}
    </svg>
  );
}

/** One track of the timeline: what the step is called and cost on the left, what it made on the right, in time. */
function Track({ n, name, cost, note, children }: { n: number; name: string; cost: string; note: string; children: React.ReactNode }) {
  return (
    <li className="grid grid-cols-[9.5rem_minmax(0,1fr)] gap-x-5 border-t border-hairline py-5 first:border-t-0 lg:grid-cols-[13rem_minmax(0,1fr)] lg:gap-x-8">
      <div className="sticky left-0 z-10 bg-paper pr-2">
        <p className="printed text-[1.25rem] leading-none"><span className="figures mr-2 font-normal text-graphite">{n}</span>{name}</p>
        <p className="note mt-1">{cost}</p>
        <p className="mt-1.5 text-[0.85rem] leading-snug text-graphite">{note}</p>
      </div>
      <div className="min-w-0 self-center">{children}</div>
    </li>
  );
}

/**
 * How a video is made, laid out the way an editor would see it: one track for each step, in the order the steps
 * happen, and every track drawn against the video's own length, so a scene's words, its stretch of the voice and
 * its picture stand under one another (Phase 4 spec §5, block 3, and §14). Everything on it is what one real run
 * produced, with what that step cost. The steps are numbered because they are a sequence.
 */
export function MakingStrip({ showcase }: { showcase: Showcase }) {
  const { making, receipt, slug } = showcase;
  const cost = (label: string) => receipt.lines.find((l) => l.label === label)?.usd ?? 0;
  const clips = making.scenes.filter((s) => s.kind === "clip").length;
  const stills = making.scenes.length - clips;
  /** A scene's share of the width is its share of the time. */
  const span = (seconds: number) => ({ flexGrow: seconds, flexBasis: 0 });
  return (
    <div className="-mx-6 overflow-x-auto px-6 sm:-mx-10 sm:px-10 lg:mx-0 lg:overflow-visible lg:px-0">
      <ol className="ruled min-w-[54rem] !pt-1 lg:min-w-0" data-testid="making">
        <Track n={1} name="Topic" cost="free" note="One sentence is all it starts from.">
          <p className="display text-[clamp(1.5rem,1rem+1.4vw,2.1rem)] leading-[1.02]">“{making.topic}”</p>
        </Track>
        <Track n={2} name="Script" cost={exact(cost("Script"))} note="Written for you: a line, a picture and a camera move for each scene.">
          <ol className="flex">
            {making.scenes.map((s, i) => (
              <li key={i} style={span(s.seconds)} className="min-w-0 border-l-2 border-ink pl-2.5 pr-3 text-[0.9rem] leading-snug">{s.narration}</li>
            ))}
          </ol>
        </Track>
        <Track n={3} name="Voice" cost={exact(cost("Voice"))} note={`Spoken, with the pauses trimmed. Everything after is timed to these ${making.voice.seconds.toFixed(1)} seconds.`}>
          <Waveform peaks={making.voice.peaks} />
        </Track>
        <Track n={4} name="Pictures" cost={exact(cost("Pictures") + cost("Clips"))} note={`${clips} moving ${clips === 1 ? "clip" : "clips"}${stills > 0 ? ` and ${stills} ${stills === 1 ? "still" : "stills"} with a camera move` : ""}, each cut to the length of its line.`}>
          <ul className="flex gap-1">
            {making.scenes.map((s, i) => (
              <li key={i} style={span(s.seconds)} className="relative min-w-0">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={`/showcase/${slug}/${s.thumb}`} alt={`Scene ${i + 1}: a ${s.kind}`} loading="lazy" className="h-28 w-full rounded-[14px] object-cover" />
                <span className="absolute bottom-1.5 left-1.5 rounded-full bg-sheet px-1.5 text-[0.75rem] font-bold">{s.kind}, {s.seconds.toFixed(1)} s</span>
              </li>
            ))}
          </ul>
        </Track>
        <Track n={5} name="The cut" cost="free" note="Cutting it again with another look costs nothing.">
          <div className="flex items-center gap-4">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={`/showcase/${slug}/poster.jpg`} alt={`The finished video, “${receipt.title}”`} loading="lazy" className="aspect-[9/16] w-14 rounded-[14px] object-cover" />
            <p className="max-w-[34rem] text-[1.02rem] leading-snug">Captions word by word, the opening title, the cuts between scenes, music turned down under the voice, and a sound on each cut.</p>
          </div>
        </Track>
      </ol>
    </div>
  );
}
