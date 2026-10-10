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
export function AuthForm({ mode, next = "/", error: initialError = "", info = "", google = false, aside }: { mode: Mode; next?: string; error?: string; info?: string; google?: boolean; aside?: React.ReactNode }) {
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
      const answer = await sendJson<{ confirm?: boolean }>(ENDPOINT[mode], { ...(withEmail ? { email } : {}), ...(withPassword ? { password } : {}), ...(mode === "signup" ? { next } : {}) });
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
    <div className="mt-4 flex items-start justify-between gap-16 lg:mt-10">
    <div className="w-full max-w-[26rem] space-y-6">
      <h1 className="display text-[clamp(2.6rem,1.6rem+4vw,4rem)] leading-[0.92]">{TITLE[mode]}</h1>
      {info && !notice && <p role="status" data-testid="auth-info" className="bg-good/10 px-4 py-2.5 text-[0.95rem] text-good">{info}</p>}
      {notice ? (
        <p role="status" data-testid="auth-notice" className="bg-good/10 px-4 py-2.5 text-[0.95rem] text-good">{notice}</p>
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
          <Button type="submit" tone="primary" className="w-full !py-3 !text-[1.02rem]" disabled={busy}>{busy ? "One moment…" : SUBMIT[mode]}</Button>
        </form>
      )}
      {google && (mode === "login" || mode === "signup") && !notice && (
        <a href={`/auth/google?next=${encodeURIComponent(next)}`} className="block rounded-full border-[1.5px] border-ink/30 bg-sheet px-4 py-3 text-center font-bold hover:border-ink" data-testid="auth-google">
          Continue with Google
        </a>
      )}
      <p className="text-[0.95rem] text-graphite">
        {mode === "login" && <><Link href={next === "/" ? "/signup" : `/signup?next=${encodeURIComponent(next)}`} className="underline underline-offset-4">Create an account</Link>, or <Link href="/reset" className="underline underline-offset-4">reset your password</Link>.</>}
        {mode === "signup" && <>Already have an account? <Link href={next === "/" ? "/login" : `/login?next=${encodeURIComponent(next)}`} className="underline underline-offset-4">Sign in</Link>.</>}
        {mode === "reset" && <Link href="/login" className="underline underline-offset-4">Back to sign in</Link>}
      </p>
    </div>
    {aside}
    </div>
  );
}
