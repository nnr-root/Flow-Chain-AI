"use client";
import { sendJson } from "@/lib/api";

export function SignOut() {
  return (
    <button
      type="button"
      data-testid="sign-out"
      className="text-xs text-dim underline hover:text-white"
      onClick={() => void sendJson("/api/auth/logout").finally(() => window.location.assign("/login"))}
    >
      Sign out
    </button>
  );
}
