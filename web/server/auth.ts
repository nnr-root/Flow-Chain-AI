import { z } from "zod";
import { multiTenant, safeNext } from "@/lib/supabase/settings";
import { ApiError } from "./http";
import { siteOrigin } from "./session";
import { scope, userDb } from "./tenant";

/* Signing up, in and out. Supabase Auth does the work; these turn its answers into the studio's own. */

const Credentials = z.object({ email: z.string().trim().toLowerCase().email().max(254), password: z.string().min(8, "at least 8 characters").max(200) });
const Email = Credentials.pick({ email: true });
const Password = Credentials.pick({ password: true });

/** The auth routes exist only in a studio with accounts. */
function auth() {
  if (!multiTenant()) throw new ApiError("not_found", "this studio has no accounts");
  return userDb().auth;
}

const callback = (req: Request, next = "/") => `${siteOrigin(req)}/auth/callback?next=${encodeURIComponent(safeNext(next))}`;

/** Creates the account. With email confirmation on (production) the visitor must open the emailed link first. */
export async function signUp(req: Request, input: unknown): Promise<{ confirm: boolean }> {
  const { email, password } = Credentials.parse(input);
  const { data, error } = await auth().signUp({ email, password, options: { emailRedirectTo: callback(req) } });
  if (error) throw new ApiError("validation", error.message);
  return { confirm: !data.session };
}

export async function signIn(input: unknown): Promise<void> {
  const { email, password } = Credentials.parse(input);
  const { error } = await auth().signInWithPassword({ email, password });
  if (!error) return;
  // one answer for "no such account" and "wrong password": which addresses have accounts is nobody's business
  if (/not confirmed/i.test(error.message)) throw new ApiError("unauthenticated", "confirm your email address first", "open the link in the email we sent you");
  throw new ApiError("unauthenticated", "wrong email or password");
}

export async function signOut(): Promise<void> {
  await auth().signOut({ scope: "local" });
}

/** Always answers the same, whether or not the address has an account. */
export async function requestReset(req: Request, input: unknown): Promise<void> {
  const { email } = Email.parse(input);
  await auth().resetPasswordForEmail(email, { redirectTo: callback(req, "/reset/new") });
}

export async function setPassword(input: unknown): Promise<void> {
  const { password } = Password.parse(input);
  if (!scope()?.user) throw new ApiError("unauthenticated", "sign in first");
  const { error } = await auth().updateUser({ password });
  if (error) throw new ApiError("validation", error.message);
}

/** The address at Google to send the visitor to; the answer comes back to /auth/callback. */
export async function googleUrl(req: Request, next: string | null): Promise<string> {
  const { data, error } = await auth().signInWithOAuth({ provider: "google", options: { redirectTo: callback(req, next ?? "/"), skipBrowserRedirect: true } });
  if (error || !data.url) throw new ApiError("validation", error?.message ?? "Google sign-in is not available");
  return data.url;
}

/** Turns the code of a Google login or an emailed link into a session. Returns where to go next. */
export async function finishCallback(req: Request): Promise<string> {
  const url = new URL(req.url);
  const next = safeNext(url.searchParams.get("next"));
  const code = url.searchParams.get("code");
  const tokenHash = url.searchParams.get("token_hash");
  const type = url.searchParams.get("type");
  const failed = (why: string) => `/login?error=${encodeURIComponent(why)}`;
  if (code) {
    const { error } = await auth().exchangeCodeForSession(code);
    return error ? failed("That link is no longer valid. Sign in, or ask for a new one.") : next;
  }
  if (tokenHash && type) {
    const { error } = await auth().verifyOtp({ token_hash: tokenHash, type: type as "signup" | "recovery" | "email" });
    return error ? failed("That link is no longer valid. Sign in, or ask for a new one.") : next;
  }
  return failed(url.searchParams.get("error_description") ?? "Sign-in was not completed.");
}

export type Account = { email: string; balanceUsd: number };
export type LedgerRow = { id: number; kind: "grant" | "reserve" | "settle"; amountUsd: number; balanceAfterUsd: number; runId: string | null; note: string; at: string };

/** The signed-in user's balance; row-level security makes "the one row I can see" exactly that. */
export async function account(): Promise<Account> {
  const { data, error } = await userDb().from("users").select("email,balance_usd").single();
  if (error || !data) throw new ApiError("unauthenticated", "sign in first");
  return { email: data.email as string, balanceUsd: Number(data.balance_usd) };
}

export async function ledger(limit = 100): Promise<LedgerRow[]> {
  const { data, error } = await userDb().from("ledger").select("id,kind,amount_usd,balance_after_usd,run_id,note,created_at").order("id", { ascending: false }).limit(limit);
  if (error) throw new Error(error.message);
  return (data ?? []).map((r) => ({
    id: r.id as number, kind: r.kind as LedgerRow["kind"], amountUsd: Number(r.amount_usd), balanceAfterUsd: Number(r.balance_after_usd),
    runId: r.run_id as string | null, note: r.note as string, at: r.created_at as string,
  }));
}
