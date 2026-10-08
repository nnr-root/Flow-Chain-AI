import Link from "next/link";
import { PaidNote } from "@/components/PaidNote";
import { ManageBilling } from "@/components/Pricing";
import { SignOut } from "@/components/SignOut";
import { Panel } from "@/components/ui";
import { usd } from "@/lib/api";
import { arrivedSince, billingOn, LIVE, purchaseTime } from "@/lib/billing";
import { account, ledger } from "@/server/auth";
import { billingView } from "@/server/billing/actions";
import { accountsOnly, forUser } from "@/server/page";

export const dynamic = "force-dynamic";

const WHAT = {
  grant: "Credit added", reserve: "Held for a job", settle: "Job settled",
  purchase: "Top-up bought", plan: "Plan credit for the month", expire: "Plan credit expired", refund: "Refund",
} as const;
/** Rows whose note is an identifier for the books, not something to read. */
const QUIET = ["reserve", "purchase", "refund"];
const STATUS: Record<string, string> = { active: "Active", trialing: "Trial", past_due: "Payment failed — Stripe is retrying", canceled: "Ended", unpaid: "Unpaid", incomplete: "Waiting for the first payment", incomplete_expired: "Ended", paused: "Paused" };
const day = (iso: string) => new Date(iso).toISOString().slice(0, 10);
const minute = (iso: string) => new Date(iso).toISOString().slice(0, 16).replace("T", " ");

export default async function Page({ searchParams }: { searchParams: Promise<{ paid?: string }> }) {
  accountsOnly();
  const sells = billingOn();
  // the account itself must open whatever becomes of the billing panels (a database that is behind, say): signing
  // out and the balance are here
  const { me, rows, billing } = await forUser(async () => ({ me: await account(), rows: await ledger(), billing: sells ? await billingView().catch(() => null) : null }));
  // came back from Stripe: which purchase the note is about (nothing for an old address or a made-up one)
  const since = sells ? purchaseTime((await searchParams).paid) : null;
  const plan = billing?.plan && !["canceled", "incomplete_expired"].includes(billing.plan.status) ? billing.plan : null;
  const planCredit = Math.max(Math.min(billing?.planCreditUsd ?? 0, me.balanceUsd), 0);
  return (
    <div className="mx-auto max-w-3xl space-y-6">
      {since !== null && billing && <PaidNote since={since} confirmed={billing.payments.some((p) => arrivedSince(p.at, since))} />}
      <Panel title="Account" aside={<SignOut />}>
        <p className="text-sm text-dim">{me.email}</p>
        <p className="mt-2 text-3xl font-semibold" data-testid="balance">{usd(me.balanceUsd)}</p>
        <p className="mt-1 text-xs text-dim">Your credit. A job holds the amount you approve and gives back what it does not spend.</p>
        {billing && (
          <>
            {planCredit > 0 && (
              <p className="mt-2 text-sm" data-testid="balance-split">
                {usd(planCredit)} from your plan{plan?.periodEnd ? `, to use by ${day(plan.periodEnd)}` : ""} · {usd(Math.max(me.balanceUsd - planCredit, 0))} that does not expire
              </p>
            )}
            <p className="mt-3"><Link href="/pricing" className="text-sm underline" data-testid="add-credit">Add credit</Link></p>
          </>
        )}
      </Panel>
      {billing && (plan || billing.payments.length > 0) && (
        <Panel title="Plan and payments" aside={<ManageBilling label={plan ? "Manage subscription" : "Invoices and card"} />}>
          {plan ? (
            <p className="text-sm" data-testid="plan">
              <span className="font-medium capitalize">{plan.plan}</span> · {STATUS[plan.status] ?? plan.status}
              {plan.periodEnd && LIVE.includes(plan.status) && <span className="text-dim"> · {plan.cancelAtPeriodEnd ? "ends" : "renews"} on {day(plan.periodEnd)}</span>}
            </p>
          ) : (
            <p className="text-sm text-dim" data-testid="plan">No plan.</p>
          )}
          {billing.payments.length > 0 && (
            <table className="mt-3 w-full text-sm" data-testid="payments">
              <thead>
                <tr className="text-left text-xs text-dim"><th className="py-1 font-normal">Date</th><th className="font-normal">What</th><th className="text-right font-normal">Paid</th><th className="text-right font-normal">Credit</th><th /></tr>
              </thead>
              <tbody>
                {billing.payments.map((p) => (
                  <tr key={p.id} className="border-t border-line">
                    <td className="py-2 text-xs text-dim">{day(p.at)}</td>
                    <td className="py-2">{p.kind === "plan" ? <span className="capitalize">{p.plan ?? "Plan"} — a month</span> : "Top-up"}{p.refundedUsd > 0 && <span className="text-warn"> · {usd(p.refundedUsd)} refunded</span>}</td>
                    <td className="py-2 text-right tabular-nums">{usd(p.paidUsd)}</td>
                    <td className="py-2 text-right tabular-nums text-good">+{usd(p.creditUsd)}</td>
                    <td className="py-2 text-right text-xs">{p.invoiceUrl?.startsWith("https://") && <a href={p.invoiceUrl} target="_blank" rel="noreferrer" className="underline">Receipt</a>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>
      )}
      <Panel title="History">
        {rows.length === 0 ? (
          <p className="text-sm text-dim">Nothing yet.</p>
        ) : (
          <table className="w-full text-sm" data-testid="ledger">
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-t border-line first:border-t-0">
                  <td className="py-2 text-xs text-dim">{minute(r.at)}</td>
                  <td className="py-2">{WHAT[r.kind]}{r.runId && <> · <Link href={`/runs/${r.runId}`} className="underline">{r.runId}</Link></>}{r.note && !QUIET.includes(r.kind) ? <span className="text-dim"> · {r.note}</span> : null}</td>
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
