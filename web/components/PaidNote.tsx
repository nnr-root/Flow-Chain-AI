"use client";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { ApiFailure, getJson } from "@/lib/api";
import { arrivedSince } from "@/lib/billing";

const EVERY_MS = 2000;
const TRIES = 30;

/**
 * Shown on the account page a visitor returns to from Stripe. The credit follows the payment by a moment (Stripe
 * tells the studio separately), so until a payment made since this purchase began (`since`) is on record, this
 * asks again every two seconds, for a minute, and then says that it is taking long. `confirmed` is the page's
 * own knowledge that the payment is already recorded.
 */
export function PaidNote({ since, confirmed }: { since: number; confirmed: boolean }) {
  const router = useRouter();
  const [state, setState] = useState<"waiting" | "confirmed" | "late">(confirmed ? "confirmed" : "waiting");
  useEffect(() => {
    if (confirmed) setState("confirmed");
  }, [confirmed]);
  useEffect(() => {
    if (state !== "waiting") return;
    let tries = 0;
    let asking = false;
    const timer = setInterval(() => {
      // counted here, whatever becomes of the request: a studio that does not answer must not be asked for ever
      if (++tries > TRIES) return setState("late");
      if (asking) return;
      asking = true;
      getJson<{ paidAt?: string | null }>("/api/account")
        .then(
          (data) => {
            if (!arrivedSince(data.paidAt, since)) return;
            setState("confirmed");
            // the balance, the plan and the list of payments are the page's own: have it load them again
            router.refresh();
          },
          (err: unknown) => {
            // signed out meanwhile: nothing more will be learned here
            if (err instanceof ApiFailure && err.code === "unauthenticated") setState("late");
          },
        )
        .finally(() => {
          asking = false;
        });
    }, EVERY_MS);
    return () => clearInterval(timer);
  }, [state, since, router]);
  const text = {
    waiting: "Thank you. Your payment is being confirmed; the credit appears here in a moment.",
    confirmed: "Thank you. Your payment is confirmed and the credit is on your account.",
    late: "Thank you. The confirmation is taking longer than usual. Nothing more is needed from you: the credit is added as soon as Stripe confirms the payment.",
  }[state];
  return <p role="status" data-testid="paid-note" data-state={state} className="rounded-lg border border-good/40 bg-good/10 px-3 py-2 text-sm text-good">{text}</p>;
}
