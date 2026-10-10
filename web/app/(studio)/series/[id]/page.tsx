import Link from "next/link";
import { notFound } from "next/navigation";
import { PRESETS } from "@src/presets";
import { SeriesActions } from "@/components/SeriesActions";
import { Panel, StateBadge } from "@/components/ui";
import { ApiError } from "@/server/http";
import { accountsOnly, forUser } from "@/server/page";
import { getSeries } from "@/server/series";

export const dynamic = "force-dynamic";

/** One series: what it is, the videos it has made, and the button that starts the next (phase 6 spec §8). */
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  accountsOnly();
  const { id } = await params;
  // something that is not this user's does not exist
  const series = await forUser(() =>
    getSeries(id).catch((err: unknown) => {
      if (err instanceof ApiError && err.code === "not_found") return null;
      throw err;
    }),
  );
  if (!series) notFound();
  const look = series.style === "auto" ? "Chosen by the topic" : (PRESETS[series.style as keyof typeof PRESETS]?.label ?? series.style);
  return (
    <div className="max-w-[56rem] space-y-12">
      <div>
        <p className="text-[0.95rem]"><Link href="/series" className="text-graphite underline underline-offset-4 hover:text-ink">Your series</Link></p>
        <h1 className="display mt-3 text-[clamp(2.4rem,1.6rem+3vw,3.8rem)] leading-[0.95]" data-testid="series-title">{series.name}</h1>
        <p className="mt-4 max-w-[40rem] text-[1.1rem] text-graphite">{series.premise}</p>
        <p className="note mt-4 text-[0.95rem]">{look}, {series.scenes} scenes, {series.aspect}</p>
      </div>
      <SeriesActions id={series.id} name={series.name} episodes={series.episodes.length} />
      <Panel title="Its videos">
        {series.episodes.length === 0 ? (
          <p className="text-graphite">None yet. The first one is written from the sentence above; each one after it is told what the series has already made, so it is about something else.</p>
        ) : (
          <ol className="space-y-2" data-testid="episodes">
            {series.episodes.map((e, i) => (
              <li key={e.runId}>
                <Link href={`/runs/${e.runId}`} className="flex items-center gap-4 rounded-[18px] bg-sheet px-5 py-3.5 hover:bg-wash">
                  <span className="note w-6 text-graphite">{i + 1}</span>
                  <span className="min-w-0 flex-1 truncate font-bold">{e.title ?? "Being written"}</span>
                  {e.spendUsd !== undefined && <span className="note text-[0.9rem] text-graphite">${e.spendUsd.toFixed(2)}</span>}
                  <StateBadge state={e.state} />
                </Link>
              </li>
            ))}
          </ol>
        )}
      </Panel>
    </div>
  );
}
