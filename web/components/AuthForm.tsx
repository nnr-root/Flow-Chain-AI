"use client";
import Link from "next/link";
import { useState } from "react";
import { errorText, sendJson } from "@/lib/api";
import { Button, ErrorNote, Field } from "./ui";

type Mode = "login" | "signup" | "reset" | "new-password";
const TITLE: Record<Mode, string> = { login: "Sign in", signup: "Create your account", reset: "Reset your password", "new-password": "Choose a new password" };
const SUBMIT: Record<Mode, string> = { login: "Sign in", signup: "Create account", reset: "Send reset link", "new-password": "Save password" };
const ENDPOINT: Record<Mode, string> = { login: "/api/auth/login", signup: "/api/auth/signup", reset: "/api/auth/reset", "new-password": "/api/auth/password" };

/** The one form behind every sign-in page. `next` is where to go afterwards (a path on this site, checked by the server). */
export function AuthForm({ mode, next = "/", error: initialError = "" }: { mode: Mode; next?: string; error?: string }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(initialError);
  const [notice, setNotice] = useState("");
  const withEmail = mode !== "new-password";
  const withPassword = mode !== "reset";

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const answer = await sendJson<{ confirm?: boolean }>(ENDPOINT[mode], { ...(withEmail ? { email } : {}), ...(withPassword ? { password } : {}) });
      if (mode === "reset") return setNotice("If that address has an account, a reset link is on its way.");
      if (mode === "signup" && answer.confirm) return setNotice("Check your inbox: open the link we sent to finish creating your account.");
      // a full page load, so every part of the page is built for the signed-in user
      window.location.assign(next);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto mt-16 max-w-sm space-y-5 rounded-xl border border-line bg-panel p-6">
      <h1 className="text-lg font-semibold">{TITLE[mode]}</h1>
      {notice ? (
        <p role="status" data-testid="auth-notice" className="rounded-lg border border-good/40 bg-good/10 px-3 py-2 text-sm text-good">{notice}</p>
      ) : (
        <form onSubmit={submit} className="space-y-4" data-testid={`auth-${mode}`}>
          {withEmail && (
            <Field label="Email">
              <input type="email" name="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} className="w-full" />
            </Field>
          )}
          {withPassword && (
            <Field label="Password" hint={mode === "login" ? undefined : "At least 8 characters."}>
              <input type="password" name="password" autoComplete={mode === "login" ? "current-password" : "new-password"} required minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} className="w-full" />
            </Field>
          )}
          <ErrorNote>{error}</ErrorNote>
          <Button type="submit" tone="primary" className="w-full" disabled={busy}>{busy ? "One moment…" : SUBMIT[mode]}</Button>
        </form>
      )}
      {(mode === "login" || mode === "signup") && !notice && (
        <a href={`/auth/google?next=${encodeURIComponent(next)}`} className="block rounded-lg border border-line px-3 py-1.5 text-center text-sm font-medium hover:border-dim" data-testid="auth-google">
          Continue with Google
        </a>
      )}
      <p className="text-center text-xs text-dim">
        {mode === "login" && <><Link href="/signup" className="underline">Create an account</Link> · <Link href="/reset" className="underline">Forgot your password?</Link></>}
        {mode === "signup" && <>Already have an account? <Link href="/login" className="underline">Sign in</Link></>}
        {mode === "reset" && <Link href="/login" className="underline">Back to sign in</Link>}
      </p>
    </div>
  );
}
