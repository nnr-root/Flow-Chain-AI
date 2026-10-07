"use client";
import { useEffect, useState } from "react";
import { getJson, usd } from "./api";

/**
 * The signed-in user's credit, or null where it does not apply (a studio without accounts) or is not known yet.
 * Asked again whenever `when` changes (a job ending changes the balance).
 */
export function useBalance(when: unknown = ""): number | null {
  const [balance, setBalance] = useState<number | null>(null);
  useEffect(() => {
    let gone = false;
    getJson<{ account: { balanceUsd: number } | null }>("/api/account").then(
      (data) => {
        // no account: a studio without accounts, where credit does not apply
        if (!gone) setBalance(data.account ? data.account.balanceUsd : null);
      },
      () => {},
    );
    return () => {
      gone = true;
    };
  }, [when]);
  return balance;
}

/** Whether `needUsd` is more than the balance covers (never when the balance does not apply). */
export const tooLittle = (balance: number | null, needUsd: number | undefined): boolean => balance !== null && needUsd !== undefined && needUsd > balance;

/** Why a paid button is disabled, in the user's own numbers. */
export function CreditNote({ balance, needUsd }: { balance: number | null; needUsd: number | undefined }) {
  if (!tooLittle(balance, needUsd)) return null;
  return (
    <p className="text-xs text-warn" data-testid="credit-note">
      This needs up to {usd(needUsd!)}; you have {usd(Math.max(balance!, 0))}. <a href="/account" className="underline">Your account</a>
    </p>
  );
}
