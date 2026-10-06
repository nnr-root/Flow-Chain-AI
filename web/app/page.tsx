import Link from "next/link";
import { StateBadge } from "@/components/ui";
import { listRuns } from "@/server/runs";

export const dynamic = "force-dynamic";

export default async function Page() {
  const runs = await listRuns();
  if (runs.length === 0) {
    return (
      <div className="grid place-items-center gap-4 py-24 text-center">
        <p className="text-lg">No videos yet.</p>
        <Link href="/new" className="rounded-lg bg-accent px-4 py-2 font-medium text-ink">Create the first one</Link>
      </div>
    );
  }
  return (
    <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4" data-testid="runs">
      {runs.map((r) => (
        <li key={r.runId}>
          <Link href={`/runs/${r.runId}`} className="block overflow-hidden rounded-xl border border-line bg-panel hover:border-accent">
            <div className="grid aspect-video place-items-center bg-black">
              {r.thumbnail ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={`/api/runs/${r.runId}/files/${r.thumbnail}`} alt="" className="h-full w-full object-cover" />
              ) : (
                <span className="text-xs text-dim">{r.state === "draft" ? "draft — no pictures yet" : "no picture"}</span>
              )}
            </div>
            <div className="space-y-1 p-3">
              <div className="flex items-center justify-between gap-2">
                <StateBadge state={r.state} />
                {r.spendUsd !== undefined && <span className="text-xs text-dim">${r.spendUsd.toFixed(2)}</span>}
              </div>
              <p className="line-clamp-2 text-sm font-medium">{r.title ?? r.topic ?? r.runId}</p>
              <p className="text-xs text-dim">{r.sceneCount ? `${r.sceneCount} scenes · ${r.aspect} · ` : ""}{r.runId}</p>
            </div>
          </Link>
        </li>
      ))}
    </ul>
  );
}
