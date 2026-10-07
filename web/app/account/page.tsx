import Link from "next/link";
import { SignOut } from "@/components/SignOut";
import { Panel } from "@/components/ui";
import { usd } from "@/lib/api";
import { account, ledger } from "@/server/auth";
import { accountsOnly, forUser } from "@/server/page";

export const dynamic = "force-dynamic";

const WHAT = { grant: "Credit added", reserve: "Held for a job", settle: "Job settled" } as const;

export default async function Page() {
  accountsOnly();
  const { me, rows } = await forUser(async () => ({ me: await account(), rows: await ledger() }));
  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <Panel title="Account" aside={<SignOut />}>
        <p className="text-sm text-dim">{me.email}</p>
        <p className="mt-2 text-3xl font-semibold" data-testid="balance">{usd(me.balanceUsd)}</p>
        <p className="mt-1 text-xs text-dim">Your credit. A job holds the amount you approve and gives back what it does not spend.</p>
      </Panel>
      <Panel title="History">
        {rows.length === 0 ? (
          <p className="text-sm text-dim">Nothing yet.</p>
        ) : (
          <table className="w-full text-sm" data-testid="ledger">
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-t border-line first:border-t-0">
                  <td className="py-2 text-xs text-dim">{new Date(r.at).toISOString().slice(0, 16).replace("T", " ")}</td>
                  <td className="py-2">{WHAT[r.kind]}{r.runId && <> · <Link href={`/runs/${r.runId}`} className="underline">{r.runId}</Link></>}{r.note && r.kind !== "reserve" ? <span className="text-dim"> · {r.note}</span> : null}</td>
                  <td className={`py-2 text-right tabular-nums ${r.amountUsd < 0 ? "text-warn" : "text-good"}`}>{r.amountUsd < 0 ? "−" : "+"}${Math.abs(r.amountUsd).toFixed(4)}</td>
                  <td className="py-2 text-right tabular-nums text-dim">${r.balanceAfterUsd.toFixed(4)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>
    </div>
  );
}
