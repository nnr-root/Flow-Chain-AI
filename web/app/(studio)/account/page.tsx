import Link from "next/link";
import { PaidNote } from "@/components/PaidNote";
import { Channels } from "@/components/Publishing";
import { ManageBilling } from "@/components/Pricing";
import { SignOut } from "@/components/SignOut";
import { Panel } from "@/components/ui";
import { amount, money } from "@/lib/api";
import { arrivedSince, billingOn, LIVE, purchaseTime } from "@/lib/billing";
import { ledgerEntry } from "@/lib/ledger";
import { CHANNEL_NOTES, publishingOn } from "@/lib/publishing";
import { account, ledger } from "@/server/auth";
import { billingView } from "@/server/billing/actions";
import { listChannels } from "@/server/channels";
import { accountsOnly, forUser } from "@/server/page";

export const dynamic = "force-dynamic";

/** Rows whose note is an identifier for the books, not something to read. */
const QUIET = ["reserve", "purchase", "refund"];
const STATUS: Record<string, string> = { active: "Active", trialing: "Trial", past_due: "Payment failed, Stripe is retrying", canceled: "Ended", unpaid: "Unpaid", incomplete: "Waiting for the first payment", incomplete_expired: "Ended", paused: "Paused" };
const day = (iso: string) => new Date(iso).toISOString().slice(0, 10);
const minute = (iso: string) => new Date(iso).toISOString().slice(0, 16).replace("T", " ");

export default async function Page({ searchParams }: { searchParams: Promise<{ paid?: string; channel?: string }> }) {
  accountsOnly();
  const sells = billingOn();
  // the account itself must open whatever becomes of the billing panels (a database that is behind, say): signing
  // out and the balance are here
  const { me, rows, billing, channels } = await forUser(async () => ({ me: await account(), rows: await ledger(), billing: sells ? await billingView().catch(() => null) : null , channels: await listChannels().catch(() => []) }));
  // came back from Stripe: which purchase the note is about (nothing for an old address or a made-up one)
  const since = sells ? purchaseTime((await searchParams).paid) : null;
  // back from the consent page: which of the studio's own sentences to show (never text taken from the address)
  const came = (await searchParams).channel;
  const channelNote = came && Object.hasOwn(CHANNEL_NOTES, came) ? CHANNEL_NOTES[came as keyof typeof CHANNEL_NOTES] : undefined;
  const plan = billing?.plan && !["canceled", "incomplete_expired"].includes(billing.plan.status) ? billing.plan : null;
  const planCredit = Math.max(Math.min(billing?.planCreditUsd ?? 0, me.balanceUsd), 0);
  return (
    <div className="max-w-[52rem] space-y-12">
      {since !== null && billing && <PaidNote since={since} confirmed={billing.payments.some((p) => arrivedSince(p.at, since))} />}
      <Panel title="Account" aside={<SignOut />}>
        <p className="text-[0.95rem] text-graphite">{me.email}</p>
        <p className="display mt-3 text-[clamp(3.5rem,2rem+6vw,6rem)] leading-[0.9] text-ink" data-testid="balance">{amount(me.balanceUsd)}</p>
        <p className="mt-1 text-[0.85rem] text-graphite">A job holds the amount you approve and gives back what it does not use.</p>
        {billing && (
          <>
            {planCredit > 0 && (
              <p className="mt-2 text-[0.95rem]" data-testid="balance-split">
                {amount(planCredit)} from your plan{plan?.nextCreditsAt ?? plan?.periodEnd ? `, to use by ${day((plan?.nextCreditsAt ?? plan?.periodEnd)!)}` : ""}, and {amount(Math.max(me.balanceUsd - planCredit, 0))} that do not expire
              </p>
            )}
            <p className="mt-3"><Link href="/pricing" className="text-[0.95rem] underline" data-testid="add-credit">Add credit</Link></p>
          </>
        )}
      </Panel>
      {billing && (plan || billing.payments.length > 0) && (
        <Panel title="Plan and payments" aside={<ManageBilling label={plan ? "Manage subscription" : "Invoices and card"} />}>
          {plan ? (
            <p className="text-[0.95rem]" data-testid="plan">
              <span className="font-bold capitalize">{plan.plan}</span>, {(STATUS[plan.status] ?? plan.status).toLowerCase()}
              {plan.periodEnd && LIVE.includes(plan.status) && <span className="text-graphite">, {plan.cancelAtPeriodEnd ? "ends" : "renews"} on {day(plan.periodEnd)}{plan.nextCreditsAt ? `; the next month's credits come on ${day(plan.nextCreditsAt)}` : ""}</span>}
            </p>
          ) : (
            <p className="text-[0.95rem] text-graphite" data-testid="plan">No plan.</p>
          )}
          {billing.payments.length > 0 && (
            <table className="mt-3 w-full text-[0.95rem]" data-testid="payments">
              <thead>
                <tr className="text-left text-[0.85rem] text-graphite"><th className="py-1 font-normal">Date</th><th className="font-normal">What</th><th className="text-right font-normal">Paid</th><th className="text-right font-normal">Credit</th><th /></tr>
              </thead>
              <tbody>
                {billing.payments.map((p) => (
                  <tr key={p.id} className="border-t border-hairline">
                    <td className="py-2 text-[0.85rem] text-graphite">{day(p.at)}</td>
                    <td className="py-2">{p.kind === "plan" ? <span className="capitalize">{p.plan ?? "Plan"} plan</span> : "Top-up"}{p.refundedUsd > 0 && <span className="text-warn">, {money(p.refundedUsd)} refunded</span>}</td>
                    <td className="py-2 text-right tabular-nums">{money(p.paidUsd)}</td>
                    <td className="py-2 text-right tabular-nums text-good">+{amount(p.creditUsd)}</td>
                    <td className="py-2 text-right text-[0.85rem]">{p.invoiceUrl?.startsWith("https://") && <a href={p.invoiceUrl} target="_blank" rel="noreferrer" className="underline">Receipt</a>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>
      )}
      {publishingOn() && <Channels channels={channels} note={channelNote} />}
      <Panel title="History">
        {rows.length === 0 ? (
          <p className="text-[0.95rem] text-graphite">Nothing yet.</p>
        ) : (
          <table className="w-full text-[0.95rem]" data-testid="ledger">
            <tbody>
              {rows.map((r) => {
                const { what, href } = ledgerEntry(r);
                return (
                <tr key={r.id} className="border-t border-hairline first:border-t-0">
                  <td className="py-2 text-[0.85rem] text-graphite">{minute(r.at)}</td>
                  <td className="py-2">{what}{href && <>, <Link href={href} className="underline underline-offset-4">this video</Link></>}{r.note && !QUIET.includes(r.kind) ? <span className="text-graphite">, {r.note}</span> : null}</td>
                  <td className={`py-2 text-right tabular-nums ${r.amountUsd < 0 ? "text-warn" : "text-good"}`}>{r.amountUsd < 0 ? "−" : "+"}{amount(Math.abs(r.amountUsd))}</td>
                  <td className="py-2 text-right tabular-nums text-graphite">{amount(r.balanceAfterUsd)}</td>
                </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Panel>
    </div>
  );
}
