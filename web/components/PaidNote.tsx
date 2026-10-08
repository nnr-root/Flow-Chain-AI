"use client";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { getJson } from "@/lib/api";

/**
 * Shown on the account page a visitor returns to from Stripe. The credit follows the payment by a moment (Stripe
 * tells the studio separately), so until the balance moves this asks again every two seconds, for a minute.
 * `confirmed` is the page's own knowledge that the payment is already recorded.
 */
export function PaidNote({ balanceUsd, confirmed }: { balanceUsd: number; confirmed: boolean }) {
  const router = useRouter();
  const [state, setState] = useState<"waiting" | "confirmed" | "late">(confirmed ? "confirmed" : "waiting");
  useEffect(() => {
    if (state !== "waiting") return;
    let tries = 0;
    const timer = setInterval(() => {
      tries += 1;
      getJson<{ account: { balanceUsd: number } | null }>("/api/account").then(
        (data) => {
          if (data.account && data.account.balanceUsd !== balanceUsd) {
            setState("confirmed");
            router.refresh();
          } else if (tries >= 30) setState("late");
        },
        () => {},
      );
    }, 2000);
    return () => clearInterval(timer);
  }, [state, balanceUsd, router]);
  const text = {
    waiting: "Thank you. Your payment is being confirmed; the credit appears here in a moment.",
    confirmed: "Thank you. Your payment is confirmed and the credit is on your account.",
    late: "Thank you. The confirmation is taking longer than usual. Nothing more is needed from you: the credit is added as soon as Stripe confirms the payment.",
  }[state];
  return <p role="status" data-testid="paid-note" data-state={state} className="rounded-lg border border-good/40 bg-good/10 px-3 py-2 text-sm text-good">{text}</p>;
}
