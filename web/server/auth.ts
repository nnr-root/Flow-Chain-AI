import { z } from "zod";
import { type LINK_ERRORS, multiTenant, safeNext } from "@/lib/supabase/settings";
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
  if (error) {
    // the same answer as for a new address: whether an address already has an account is nobody's business
    if (error.code === "user_already_exists" || error.code === "email_exists") return { confirm: true };
    if (error.code === "weak_password") throw new ApiError("validation", "password: choose a longer or less common password");
    if (error.code === "over_request_rate_limit" || error.code === "over_email_send_rate_limit") throw new ApiError("busy", "too many attempts; try again in a few minutes");
    throw new ApiError("validation", "the account could not be created with that address and password");
  }
  return { confirm: !data.session };
}

export async function signIn(input: unknown): Promise<void> {
  const { email, password } = Credentials.parse(input);
  const { error } = await auth().signInWithPassword({ email, password });
  if (!error) return;
  // one answer for "no such account" and "wrong password": which addresses have accounts is nobody's business
  if (error.code === "email_not_confirmed") throw new ApiError("unauthenticated", "confirm your email address first", "open the link in the email we sent you");
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
  if (error) throw new ApiError("validation", error.code === "same_password" ? "password: choose one you have not used here before" : "password: that password cannot be used; choose a longer or less common one");
}

/** The address at Google to send the visitor to; the answer comes back to /auth/callback. */
export async function googleUrl(req: Request, next: string | null): Promise<string> {
  const { data, error } = await auth().signInWithOAuth({ provider: "google", options: { redirectTo: callback(req, next ?? "/"), skipBrowserRedirect: true } });
  if (error || !data.url) throw new ApiError("validation", "Google sign-in is not available");
  return data.url;
}

const LinkType = z.enum(["signup", "recovery", "email", "invite", "email_change"]);

/**
 * Turns the code of a Google login or an emailed link into a session. Returns where to go next.
 *
 * A code only works in the browser that asked for it (its other half is in a cookie there). A token from an
 * email works anywhere, so it could be sent to someone else to sign them into the sender's account: it is
 * therefore never allowed to replace a session that already exists.
 */
export async function finishCallback(req: Request): Promise<string> {
  const url = new URL(req.url);
  const next = safeNext(url.searchParams.get("next"));
  const code = url.searchParams.get("code");
  const tokenHash = url.searchParams.get("token_hash");
  const type = LinkType.safeParse(url.searchParams.get("type"));
  // the login page shows its own words for each of these names (LINK_ERRORS), never text taken from an address
  const failed = (why: keyof typeof LINK_ERRORS) => `/login?error=${why}`;
  if (code) {
    const { error } = await auth().exchangeCodeForSession(code);
    return error ? failed("link") : next;
  }
  if (tokenHash && type.success) {
    if (scope()?.user) return failed("signed-in");
    const { error } = await auth().verifyOtp({ token_hash: tokenHash, type: type.data });
    return error ? failed("link") : next;
  }
  return failed("incomplete");
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
