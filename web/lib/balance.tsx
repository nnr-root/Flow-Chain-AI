"use client";
import { useEffect, useState } from "react";
import { getJson, usd } from "./api";

/**
 * Whether this studio sells credit: learned with the balance and the same for everyone, so kept once for the page.
 * It is set before the balance is, and `CreditNote` shows nothing until there is a balance.
 */
let sells = false;

/**
 * The signed-in user's credit, or null where it does not apply (a studio without accounts) or is not known yet.
 * Asked again whenever `when` changes (a job starting or ending changes the balance) and when the window is
 * looked at again (credit may have been added meanwhile).
 */
export function useBalance(when: unknown = ""): number | null {
  const [balance, setBalance] = useState<number | null>(null);
  useEffect(() => {
    let gone = false;
    const ask = () =>
      getJson<{ account: { balanceUsd: number } | null; billing?: boolean }>("/api/account").then(
        (data) => {
          sells = data.billing === true;
          // no account: a studio without accounts, where credit does not apply
          if (!gone) setBalance(data.account ? data.account.balanceUsd : null);
        },
        () => {},
      );
    void ask();
    window.addEventListener("focus", ask);
    return () => {
      gone = true;
      window.removeEventListener("focus", ask);
    };
  }, [when]);
  return balance;
}

/**
 * Whether `needUsd` is more than the balance covers: never when the balance does not apply, and never for
 * something free. Compared in ten-thousandths, the unit amounts are kept in, so 0.1 + 0.2 is covered by 0.3.
 */
export function tooLittle(balance: number | null, needUsd: number | undefined): boolean {
  if (balance === null || needUsd === undefined || !(needUsd > 0)) return false;
  return Math.round(needUsd * 10_000) > Math.round(balance * 10_000);
}

/** Why a paid button is disabled, in the user's own numbers. */
export function CreditNote({ balance, needUsd }: { balance: number | null; needUsd: number | undefined }) {
  if (!tooLittle(balance, needUsd)) return null;
  return (
    <p className="text-xs text-warn" data-testid="credit-note" role="status">
      This needs up to {usd(needUsd!)}; you have {usd(Math.max(balance!, 0))}.{" "}
      {sells ? <a href="/pricing" className="underline" data-testid="add-credit">Add credit</a> : <a href="/account" className="underline">Your account</a>}
    </p>
  );
}
