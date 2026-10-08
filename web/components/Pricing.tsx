"use client";
import { useEffect, useState } from "react";
import { errorText, sendJson } from "@/lib/api";
import { Button, ErrorNote } from "./ui";

/** Sends the browser to a page at Stripe that one of the studio's routes opened for this user. */
export function useStripePage() {
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  // back from Stripe with the browser's back button: the page is as it was left, and must be usable again
  useEffect(() => {
    const restored = (e: PageTransitionEvent) => {
      if (e.persisted) setBusy("");
    };
    window.addEventListener("pageshow", restored);
    return () => window.removeEventListener("pageshow", restored);
  }, []);
  const go = (what: string, url: string, body: unknown = {}) => {
    setBusy(what);
    setError("");
    sendJson<{ url: string }>(url, body).then(
      (data) => window.location.assign(data.url),
      (err: unknown) => {
        setError(errorText(err));
        setBusy("");
      },
    );
  };
  return { busy, error, go };
}

/** Opens Stripe's own page for changing or cancelling the plan, the card, and the invoices. */
export function ManageBilling({ label = "Manage subscription" }: { label?: string }) {
  const { busy, error, go } = useStripePage();
  return (
    <>
      <Button data-testid="manage-billing" disabled={!!busy} onClick={() => go("portal", "/api/billing/portal")}>{busy ? "Opening…" : label}</Button>
      <ErrorNote>{error}</ErrorNote>
    </>
  );
}
