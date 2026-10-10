import Link from "next/link";
import { StateBadge } from "@/components/ui";
import { forUser } from "@/server/page";
import { listRuns } from "@/server/runs";

export const dynamic = "force-dynamic";

export default async function Page() {
  const runs = await forUser(listRuns);
  if (runs.length === 0) {
    return (
      <div className="max-w-[40rem] py-10">
        <h1 className="display text-[clamp(2.6rem,1.6rem+4vw,4.5rem)] leading-[0.92]">No videos yet.</h1>
        <p className="mt-5 text-[1.1rem] text-graphite">A video starts from one sentence. The script is written first, and you see what the rest will cost before any of it is made.</p>
        <Link href="/new" className="mt-7 inline-block rounded-full bg-signal px-5 py-3 font-bold text-paper hover:bg-ink">Make the first one</Link>
      </div>
    );
  }
  return (
    <>
    <h1 className="display text-[clamp(2.4rem,1.6rem+3vw,3.4rem)] leading-[0.95]">Your videos</h1>
    <ul className="mt-8 grid gap-x-6 gap-y-10 sm:grid-cols-2 lg:grid-cols-4" data-testid="runs">
      {runs.map((r) => (
        <li key={r.runId}>
          <Link href={`/runs/${r.runId}`} className="group block">
            <div className="relative">
            <div className="grid aspect-video place-items-center overflow-hidden rounded-[18px] bg-sheet ring-1 ring-hairline transition-opacity group-hover:opacity-85">
              {r.thumbnail ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={`/api/runs/${r.runId}/files/${r.thumbnail}`} alt="" className="h-full w-full object-cover" />
              ) : (
                <span className="text-[0.85rem] text-graphite">{r.state === "draft" ? "A draft: no pictures yet" : "No picture"}</span>
              )}
            </div>
            </div>
            <div className="mt-3 space-y-1.5">
              <div className="flex items-center justify-between gap-2">
                <StateBadge state={r.state} />
                {r.spendUsd !== undefined && <span className="note">${r.spendUsd.toFixed(2)}</span>}
              </div>
              <p className="line-clamp-2 font-bold leading-snug group-hover:underline group-hover:underline-offset-4">{r.title ?? r.topic ?? r.runId}</p>
              {r.sceneCount ? <p className="text-[0.85rem] text-graphite">{r.sceneCount} scenes, {r.aspect}</p> : null}
            </div>
          </Link>
        </li>
      ))}
    </ul>
    </>
  );
}
