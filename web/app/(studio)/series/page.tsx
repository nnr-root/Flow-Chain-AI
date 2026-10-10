import Link from "next/link";
import { PRESETS } from "@src/presets";
import { accountsOnly, forUser } from "@/server/page";
import { listSeries } from "@/server/series";

export const dynamic = "force-dynamic";

const lookOf = (style: string): string => (style === "auto" ? "look chosen by the topic" : (PRESETS[style as keyof typeof PRESETS]?.label ?? style));

/** The user's series: what each is about, how its videos look, and how many it has made (phase 6 spec §3). */
export default async function Page() {
  accountsOnly();
  const series = await forUser(listSeries);
  if (series.length === 0) {
    return (
      <div className="max-w-[40rem] py-10">
        <h1 className="display text-[clamp(2.6rem,1.6rem+4vw,4.5rem)] leading-[0.92]">No series yet.</h1>
        <p className="mt-5 text-[1.1rem] text-graphite">A series is one kind of video, set up once: what its videos are about and how they look. After that the next video is a click, each about something the series has not done yet.</p>
        <Link href="/series/new" className="mt-7 inline-block rounded-full bg-signal px-5 py-3 font-bold text-paper hover:bg-ink">Set up the first one</Link>
      </div>
    );
  }
  return (
    <>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <h1 className="display text-[clamp(2.4rem,1.6rem+3vw,3.4rem)] leading-[0.95]">Your series</h1>
        <Link href="/series/new" className="rounded-full bg-wash px-4 py-2 text-[0.95rem] font-bold hover:bg-[#333]">New series</Link>
      </div>
      <ul className="mt-8 grid gap-4 md:grid-cols-2" data-testid="series">
        {series.map((s) => (
          <li key={s.id}>
            <Link href={`/series/${s.id}`} className="block h-full rounded-[22px] bg-sheet p-6 hover:bg-wash">
              <p className="printed text-[1.35rem] leading-tight">{s.name}</p>
              <p className="mt-2 line-clamp-2 text-graphite">{s.premise}</p>
              <p className="note mt-4 text-[0.9rem]">{s.episodes.length === 0 ? "No videos yet" : `${s.episodes.length} ${s.episodes.length === 1 ? "video" : "videos"}`}, {lookOf(s.style)}</p>
            </Link>
          </li>
        ))}
      </ul>
    </>
  );
}
