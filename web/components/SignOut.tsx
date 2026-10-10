"use client";
import { sendJson } from "@/lib/api";

export function SignOut() {
  return (
    <button
      type="button"
      data-testid="sign-out"
      className="text-[0.85rem] text-graphite underline hover:text-signal"
      onClick={() => void sendJson("/api/auth/logout").finally(() => window.location.assign("/login"))}
    >
      Sign out
    </button>
  );
}
