import { createHash } from "node:crypto";
import { z } from "zod";
import { BROWSER_COOKIE, type LINK_ERRORS, multiTenant, OAUTH_COOKIE, safeNext, SESSION_COOKIE, SESSION_DAYS } from "@/lib/accounts";
import { db } from "./db";
import { ApiError } from "./http";
import { mailOn, sendLink } from "./mail";
import { hashOf, hashPassword, newSecret, spendCheck, verifyPassword } from "@src/auth/passwords";
import { type RequestCookies, siteOrigin } from "./session";
import { scope, userDb } from "./tenant";

/*
 * Signing up, in and out, against the studio's own database (phase 5 spec §4.2). The database's `auth` functions
 * keep the accounts, the sessions and the emailed links; this module hashes and checks passwords, sets cookies,
 * sends the two emails and talks to Google.
 */

const Credentials = z.object({ email: z.string().trim().toLowerCase().email().max(254), password: z.string().min(8, "at least 8 characters").max(200) });
const Email = Credentials.pick({ email: true });
const Password = Credentials.pick({ password: true });

const DAY = 86_400;

/** The auth routes exist only in a studio with accounts; they act on the request's own cookies. */
function cookies(): RequestCookies {
  if (!multiTenant()) throw new ApiError("not_found", "this studio has no accounts");
  const jar = scope()?.cookies;
  if (!jar) throw new Error("no request in scope: signing in and out happens in a route");
  return jar;
}

/** A database function's answer, or an error nobody outside is shown the words of. */
async function call<T>(name: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await db().rpc<T>(name, args);
  if (error) throw new Error(`${name}: ${error.message}`);
  return data as T;
}

/** Not too often for one address, whoever asks and from wherever: the limit per visitor is the route's own. */
async function allow(key: string, max: number, minutes: number): Promise<void> {
  if (!(await call<boolean>("auth.allow", { p_key: key, p_max: max, p_window: `${minutes} minutes` }))) {
    throw new ApiError("busy", "too many attempts; try again in a few minutes");
  }
}

async function openSession(userId: string): Promise<void> {
  const secret = newSecret();
  await call("auth.open_session", { p_user_id: userId, p_token_hash: hashOf(secret), p_days: SESSION_DAYS });
  cookies().set(SESSION_COOKIE, secret, SESSION_DAYS * DAY);
}

/**
 * The browser's half of an emailed link: a secret in a cookie here, its hash with the link in the database. The
 * link signs the visitor in only where the cookie is. One secret serves every link asked for from this browser.
 */
function browserSecret(): string {
  const jar = cookies();
  const have = jar.get(BROWSER_COOKIE);
  const secret = have && /^[A-Za-z0-9_-]{43}$/.test(have) ? have : newSecret();
  jar.set(BROWSER_COOKIE, secret, DAY);
  return secret;
}

const callback = (req: Request, params: Record<string, string>) => `${siteOrigin(req)}/auth/callback?${new URLSearchParams(params)}`;

/** Creates the account. Where the studio sends email the visitor must open the emailed link first. */
export async function signUp(req: Request, input: unknown): Promise<{ confirm: boolean }> {
  // `next`: where the visitor was heading (a first video from the landing page, say). The emailed link brings
  // them back there; `safeNext` keeps it to a path on this site.
  cookies();
  const { email, password, next } = Credentials.extend({ next: z.string().max(2000).optional() }).parse(input);
  const confirm = mailOn();
  if (confirm) await allow(`mail:${email}`, 3, 60);
  const link = newSecret();
  const [made] = await call<Array<{ outcome: "new" | "pending" | "exists"; user_id: string | null }>>("auth.sign_up", {
    p_email: email, p_password_hash: await hashPassword(password), p_token_hash: hashOf(link), p_browser_hash: hashOf(browserSecret()), p_confirmed: !confirm,
  });
  // The same answer as for a new address: whether an address already has an account is nobody's business. (Where
  // no email is sent, an address that is taken cannot be answered like a new one — a session cannot be given
  // for someone else's account — so there, and only there, it says the sign-up did not work.)
  if (made.outcome === "exists") {
    if (confirm) return { confirm: true };
    throw new ApiError("validation", "the account could not be created with that address and password");
  }
  if (!confirm) {
    await openSession(made.user_id!);
    return { confirm: false };
  }
  await sendLink("confirm", email, callback(req, { code: link, next: safeNext(next ?? "/") })).catch((err: unknown) => {
    // the account exists and can ask again; what went wrong with the mail server is the owner's to read
    console.error(`the confirmation email could not be sent: ${err instanceof Error ? err.message : String(err)}`);
    throw new ApiError("busy", "the confirmation email could not be sent; try again in a few minutes");
  });
  return { confirm: true };
}

export async function signIn(input: unknown): Promise<void> {
  // (No limit per address here: it would let anyone lock a user out by guessing at their address. Guessing is
  // limited per visitor, by the route.)
  cookies();
  const { email, password } = Credentials.parse(input);
  const [account] = await call<Array<{ user_id: string; password_hash: string; confirmed: boolean }>>("auth.credentials", { p_email: email });
  // one answer, after the same work, for "no such account" and "wrong password": which addresses have accounts
  // is nobody's business, and must not show in how long the answer takes either
  if (!account) {
    await spendCheck(password);
    throw new ApiError("unauthenticated", "wrong email or password");
  }
  if (!(await verifyPassword(password, account.password_hash))) throw new ApiError("unauthenticated", "wrong email or password");
  // (said only to someone who knows the password)
  if (!account.confirmed) throw new ApiError("unauthenticated", "confirm your email address first", "open the link in the email we sent you");
  await openSession(account.user_id);
}

export async function signOut(): Promise<void> {
  const jar = cookies();
  const secret = jar.get(SESSION_COOKIE);
  if (secret) await call("auth.close_session", { p_token_hash: hashOf(secret) });
  jar.clear(SESSION_COOKIE);
}

/** Always answers the same, whether or not the address has an account. */
export async function requestReset(req: Request, input: unknown): Promise<void> {
  cookies();
  const { email } = Email.parse(input);
  if (!mailOn()) throw new ApiError("validation", "this studio sends no email; ask its owner to set a new password");
  await allow(`mail:${email}`, 3, 60);
  const link = newSecret();
  const known = await call<boolean>("auth.request_reset", { p_email: email, p_token_hash: hashOf(link), p_browser_hash: hashOf(browserSecret()) });
  if (!known) return;
  await sendLink("reset", email, callback(req, { code: link, next: "/reset/new" })).catch((err: unknown) => {
    // the visitor is told the same as ever: an answer that differs would say the address has an account
    console.error(`the reset email could not be sent: ${err instanceof Error ? err.message : String(err)}`);
  });
}

export async function setPassword(input: unknown): Promise<void> {
  cookies();
  const { password } = Password.parse(input);
  if (!scope()?.user) throw new ApiError("unauthenticated", "sign in first");
  const secret = cookies().get(SESSION_COOKIE);
  // asked in the user's own name: the function changes the password of whoever is signed in, and nobody else's
  const { error } = await userDb().rpc("auth.set_password", { p_password_hash: await hashPassword(password), p_keep_session: secret ? hashOf(secret) : null });
  if (error) throw new ApiError("validation", "password: that password cannot be used; choose a longer or less common one");
}

// ---------------------------------------------------------------------------------------------------------------
// Google

const GOOGLE = {
  authorize: "https://accounts.google.com/o/oauth2/v2/auth",
  // (a test's stand-in answers here instead)
  token: () => process.env.GOOGLE_TOKEN_URL?.trim() || "https://oauth2.googleapis.com/token",
  issuers: ["https://accounts.google.com", "accounts.google.com"],
};

function googleClient(): { id: string; secret: string } {
  const id = process.env.GOOGLE_CLIENT_ID?.trim();
  const secret = process.env.GOOGLE_CLIENT_SECRET?.trim();
  if (!id || !secret) throw new ApiError("validation", "Google sign-in is not available");
  return { id, secret };
}

const Pending = z.object({ state: z.string().min(20), verifier: z.string().min(40), nonce: z.string().min(20), next: z.string() });

/** The address at Google to send the visitor to; the answer comes back to /auth/callback. */
export async function googleUrl(req: Request, next: string | null): Promise<string> {
  const jar = cookies();
  const client = googleClient();
  // What this browser started: checked when Google sends the visitor back. `state` ties the answer to this
  // browser, `verifier` (PKCE) ties the code to it, `nonce` ties the identity Google states to this request.
  const pending = { state: newSecret(), verifier: newSecret(), nonce: newSecret(), next: safeNext(next) };
  jar.set(OAUTH_COOKIE, Buffer.from(JSON.stringify(pending)).toString("base64url"), 600);
  return `${GOOGLE.authorize}?${new URLSearchParams({
    client_id: client.id, redirect_uri: `${siteOrigin(req)}/auth/callback`, response_type: "code", scope: "openid email",
    state: pending.state, nonce: pending.nonce, code_challenge: createHash("sha256").update(pending.verifier).digest("base64url"), code_challenge_method: "S256",
  })}`;
}

/** Who Google says the visitor is, or null when anything about the answer is not as it must be. */
async function googleIdentity(req: Request, code: string, pending: z.infer<typeof Pending>): Promise<{ sub: string; email: string } | null> {
  const client = googleClient();
  const res = await fetch(GOOGLE.token(), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ code, client_id: client.id, client_secret: client.secret, redirect_uri: `${siteOrigin(req)}/auth/callback`, grant_type: "authorization_code", code_verifier: pending.verifier }),
    signal: AbortSignal.timeout(15_000),
  }).catch(() => null);
  if (!res?.ok) return null;
  const token = ((await res.json().catch(() => ({}))) as { id_token?: unknown }).id_token;
  if (typeof token !== "string" || token.split(".").length !== 3) return null;
  // The token came straight from Google's own address over TLS, in answer to this server's request with its
  // secret: that is what vouches for it (OpenID Connect Core §3.1.3.7), so its claims are read, not its signature.
  let claims: Record<string, unknown>;
  try {
    claims = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
  const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  const good =
    GOOGLE.issuers.includes(String(claims.iss)) && audience.includes(client.id) && typeof claims.exp === "number" && claims.exp * 1000 > Date.now() &&
    claims.nonce === pending.nonce && typeof claims.sub === "string" && claims.sub.length > 0 &&
    // an address Google has not verified proves nothing about who owns it
    typeof claims.email === "string" && (claims.email_verified === true || claims.email_verified === "true");
  return good ? { sub: claims.sub as string, email: (claims.email as string).trim().toLowerCase() } : null;
}

/**
 * Finishes a Google sign-in or an emailed link. Returns where to go next.
 *
 * Either way a visitor is signed in only in the browser that started it: Google's answer must match what this
 * browser's cookie holds, and an emailed link must meet the cookie it was asked for with. So a link cannot be
 * made by one person to sign another into the maker's account.
 */
export async function finishCallback(req: Request): Promise<string> {
  const jar = cookies();
  const url = new URL(req.url);
  // the login page shows its own words for each of these names (LINK_ERRORS), never text taken from an address
  const failed = (why: keyof typeof LINK_ERRORS) => `/login?error=${why}`;
  const code = url.searchParams.get("code");
  if (!code || code.length > 2000) return failed("incomplete");

  const state = url.searchParams.get("state");
  if (state !== null) {
    const raw = jar.get(OAUTH_COOKIE);
    jar.clear(OAUTH_COOKIE);
    let pending: z.infer<typeof Pending>;
    try {
      pending = Pending.parse(JSON.parse(Buffer.from(raw ?? "", "base64url").toString("utf8")));
    } catch {
      return failed("incomplete");
    }
    const a = Buffer.from(state);
    const b = Buffer.from(pending.state);
    if (a.length !== b.length || !a.equals(b)) return failed("incomplete");
    const who = await googleIdentity(req, code, pending);
    if (!who) return failed("incomplete");
    await openSession(await call<string>("auth.google", { p_sub: who.sub, p_email: who.email }));
    return safeNext(pending.next);
  }

  const next = safeNext(url.searchParams.get("next"));
  if (!/^[A-Za-z0-9_-]{43}$/.test(code)) return failed("link");
  const browser = jar.get(BROWSER_COOKIE);
  const [used] = await call<Array<{ user_id: string; purpose: "confirm" | "reset"; same_browser: boolean }>>("auth.use_link", {
    p_token_hash: hashOf(code), p_browser_hash: browser ? hashOf(browser) : null,
  });
  if (!used) return failed("link");
  // the address is confirmed either way; in another browser the visitor signs in there with their password
  if (!used.same_browser) return "/login?confirmed=1";
  await openSession(used.user_id);
  return used.purpose === "reset" ? "/reset/new" : next;
}

export type Account = { email: string; balanceUsd: number };
export type LedgerRow = { id: number; kind: "grant" | "reserve" | "settle" | "purchase" | "plan" | "expire" | "refund"; amountUsd: number; balanceAfterUsd: number; runId: string | null; note: string; at: string };

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
