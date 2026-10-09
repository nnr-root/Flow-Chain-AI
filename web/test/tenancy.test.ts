import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { GET as accountRoute } from "@/app/api/account/route";
import { POST as login } from "@/app/api/auth/login/route";
import { POST as logout } from "@/app/api/auth/logout/route";
import { POST as password } from "@/app/api/auth/password/route";
import { POST as reset } from "@/app/api/auth/reset/route";
import { POST as signup } from "@/app/api/auth/signup/route";
import { GET as kits } from "@/app/api/brand-kits/route";
import { GET as health } from "@/app/api/health/route";
import { GET as music } from "@/app/api/music/route";
import { GET as runs } from "@/app/api/runs/route";
import { GET as events } from "@/app/api/runs/[id]/events/route";
import { GET as file } from "@/app/api/runs/[id]/files/[...path]/route";
import { POST as generate } from "@/app/api/runs/[id]/generate/route";
import { DELETE as stop } from "@/app/api/runs/[id]/job/route";
import { POST as look } from "@/app/api/runs/[id]/look/route";
import { POST as modes } from "@/app/api/runs/[id]/modes/route";
import { POST as plan } from "@/app/api/runs/[id]/plan/route";
import { POST as props } from "@/app/api/runs/[id]/props/route";
import { POST as rerender } from "@/app/api/runs/[id]/rerender/route";
import { POST as reroll } from "@/app/api/runs/[id]/reroll/route";
import { GET as run } from "@/app/api/runs/[id]/route";
import { POST as unlock } from "@/app/api/runs/[id]/unlock/route";
import { GET as callback } from "@/app/auth/callback/route";
import { GET as googleStart } from "@/app/auth/google/route";
import { linkError, safeNext } from "@/lib/accounts";
import { roots } from "@/server/config";
import { resetAttempts } from "@/server/limits";
import { closeQueue } from "@/server/jobs/queue";
import { localDb, newUser, ownerDb, type TestUser } from "../../test/helpers/db";
import { draftManifest, finishedManifest, nextRunId, params, request, useStudio } from "./helpers";
import { hasRedisServer, startRedis, type TestRedis } from "./redis";
import { as, cookiesFrom, cookiesOf, saveRunFor, withAccounts } from "./tenant";

/*
 * The studio with accounts, against the local database: who may see what. Skipped when the database is not
 * running (`npm run db:start`) or there is no `redis-server`: with accounts the studio always works through
 * the queue, so it needs a Redis even where no job is started.
 */
const supa = localDb();
let redis: TestRedis;
beforeAll(async () => {
  if (supa && hasRedisServer()) redis = await startRedis();
});
afterAll(() => redis?.stop());
afterEach(() => closeQueue());
const studio = useStudio();
const code = async (res: Response) => ((await res.json()) as { error?: { code: string } }).error?.code;

describe("where a visitor may be sent after signing in", () => {
  it("is a path on this site and nothing else", () => {
    expect(safeNext("/runs/20261006-120000-abc001")).toBe("/runs/20261006-120000-abc001");
    expect(safeNext("/new?x=1")).toBe("/new?x=1");
    for (const bad of [undefined, null, "", "https://evil.example", "//evil.example", "/\\evil.example", "runs", "/a\nb"]) expect(safeNext(bad)).toBe("/");
    // a browser drops tabs and line breaks from an address and reads "\\" as "/": each of these would land on another site
    for (const smuggled of ["/\t/evil.example", "/\n/evil.example", "/\r/evil.example", "/ /evil.example", "/\\/evil.example", "/\u0000/evil.example", "/\u007f/evil.example"]) {
      expect(safeNext(smuggled), JSON.stringify(smuggled)).toBe("/");
    }
    expect(safeNext("/runs/../account")).toBe("/account");
    // a path that only becomes another site's address once it is tidied up
    for (const tidied of ["/a/..//evil.example", "/.//evil.example", "/x/../..//evil.example/path"]) expect(safeNext(tidied), tidied).toBe("/");
    expect(linkError("link")).toMatch(/no longer valid/);
    // only our own words are ever shown for a link that failed, never text from the address
    for (const text of ["Your account is locked, call 555-0100", "constructor", "", undefined]) expect(linkError(text)).toBe("");
  });
});

describe("a studio without accounts", () => {
  it("has no sign-in routes, and its data folders are the shared ones", async () => {
    for (const handler of [login, signup, reset, logout]) {
      expect((await handler(request("/api/auth/x", { json: { email: "a@example.test", password: "password-1" } }), undefined)).status).toBe(404);
    }
    expect(await (await accountRoute(request("/api/account"), undefined)).json()).toEqual({ account: null, ledger: [] });
    expect(roots().runs).toBe(studio.runs);
  });
});

describe.skipIf(!supa || !hasRedisServer())("a studio with accounts", () => {
  const s = supa!;
  let a: TestUser;
  let b: TestUser;
  let aCookie: string;
  let bCookie: string;

  beforeEach(async () => {
    withAccounts(s);
    resetAttempts();
    process.env.REDIS_URL = redis.url;
    [a, b] = await Promise.all([newUser(s, "a"), newUser(s, "b")]);
    [aCookie, bCookie] = await Promise.all([cookiesOf(s, a), cookiesOf(s, b)]);
  });

  it("shows a visitor without a session the landing page at the bare address, and sends every other page to the login", async () => {
    const { proxy } = await import("@/proxy");
    const ask = (path: string, cookie?: string) => proxy(new NextRequest(`http://127.0.0.1:3131${path}`, { headers: { host: "127.0.0.1:3131", ...(cookie ? { cookie } : {}) } }));
    const bare = (await ask("/"))!;
    // shown in place: the address stays what the visitor typed
    expect(new URL(bare.headers.get("x-middleware-rewrite")!).pathname).toBe("/welcome");
    expect(bare.headers.get("location")).toBeNull();
    expect(bare.headers.get("cache-control")).toBe("private, no-store");
    const deep = (await ask("/runs/20261006-120000-e2e001"))!;
    const to = new URL(deep.headers.get("location")!);
    expect([deep.status, to.pathname + to.search]).toEqual([307, "/login?next=%2Fruns%2F20261006-120000-e2e001"]);
    // the landing page under its own name, and the pages anyone may open, pass as they are
    for (const open of ["/welcome", "/login", "/pricing", "/api/runs", "/_next/static/x.js"]) expect(await ask(open), open).toBeUndefined();
    // with a session cookie the bare address is the studio: nothing is rewritten here. (Whether the session is
    // real is decided where the data is read; a cookie someone made up gets this far and no further, below.)
    expect(await ask("/", aCookie)).toBeUndefined();
    expect(await ask("/runs/20261006-120000-e2e001", aCookie)).toBeUndefined();
  });

  it("answers nobody who is not signed in, except on the sign-in routes", async () => {
    expect((await runs(request("/api/runs"), undefined)).status).toBe(401);
    expect(await code(await health(request("/api/health"), undefined))).toBe("unauthenticated");
    expect((await run(request("/api/runs/x"), params({ id: nextRunId() }))).status).toBe(401);
    // a cookie that merely looks like a session is not one: a secret the studio never gave out signs nobody in
    const garbled = aCookie.replace(/=.{20}/, `=${"A".repeat(20)}`);
    expect(garbled).not.toBe(aCookie);
    expect((await runs(as(garbled, "/api/runs"), undefined)).status).toBe(401);
    for (const not of ["fc_session=", "fc_session=short", `fc_session=${"x".repeat(5000)}`, "fc_session=../../etc/passwd"]) expect((await runs(as(not, "/api/runs"), undefined)).status, not).toBe(401);
    expect((await runs(as(aCookie, "/api/runs"), undefined)).status).toBe(200);
  });

  it("takes a session's secret and nothing in its place: not a user's id, not what the database keeps of the secret", async () => {
    const mine = nextRunId();
    await saveRunFor(studio, b, finishedManifest(mine));
    const secret = bCookie.slice(bCookie.indexOf("=") + 1);
    // what the database stores is the secret's hash: a copy of the sessions table signs nobody in
    const stored = createHash("sha256").update(secret).digest();
    const [row] = await ownerDb(s).query<{ n: number }>("select count(*)::int as n from auth.sessions where token_hash = $1", [stored]);
    expect(row.n).toBe(1);
    for (const forged of [b.id, stored.toString("base64url"), stored.toString("hex"), Buffer.from(b.id).toString("base64url")]) {
      const res = await runs(as(`fc_session=${forged}`, "/api/runs"), undefined);
      expect(res.status, forged).toBe(401);
      expect((await run(as(`fc_session=${forged}`, `/api/runs/${mine}`), params({ id: mine }))).status).toBe(401);
    }
    // a's own session shows a's runs, never b's, whatever else the request claims
    const asA = await runs(as(`${aCookie}; user=${b.id}`, "/api/runs", { headers: { "x-user-id": b.id } }), undefined);
    expect([asA.status, JSON.stringify(await asA.json()).includes(mine)]).toEqual([200, false]);
    // and a session that has run out is no session
    await ownerDb(s).query("update auth.sessions set expires_at = now() - interval '1 second' where token_hash = $1", [stored]);
    expect((await runs(as(bCookie, "/api/runs"), undefined)).status).toBe(401);
  });

  it("signs in with a password, keeps the session in cookies, and signs out", async () => {
    const wrong = await login(request("/api/auth/login", { json: { email: a.email, password: "not-the-password" } }), undefined);
    expect(wrong.status).toBe(401);
    // the same answer for an address with no account
    const nobody = await login(request("/api/auth/login", { json: { email: "nobody@example.test", password: "whatever-123" } }), undefined);
    expect(await nobody.json()).toEqual(await wrong.json());

    const ok = await login(request("/api/auth/login", { json: { email: a.email.toUpperCase(), password: a.password } }), undefined);
    expect(ok.status).toBe(200);
    const cookie = cookiesFrom(ok);
    expect(cookie).toMatch(/^fc_session=[A-Za-z0-9_-]{43}$/);
    // no script in a page can read the session, and an answer that carries one is never stored
    for (const line of ok.headers.getSetCookie()) expect(line).toMatch(/; HttpOnly/i);
    expect(ok.headers.get("cache-control")).toBe("private, no-store");
    const me = await accountRoute(as(cookie, "/api/account"), undefined);
    expect(await me.json()).toEqual({ account: { email: a.email, balanceUsd: 0 }, ledger: [] });

    const out = await logout(as(cookie, "/api/auth/logout", { json: {} }), undefined);
    expect(out.status).toBe(200);
    expect(cookiesFrom(out, cookie)).toBe("");
    // signed out at the server, not only in this browser: the cookie someone kept a copy of is dead too
    expect((await accountRoute(as(cookie, "/api/account"), undefined)).status).toBe(401);
  });

  it("creates an account that starts with nothing to spend, and lets its owner change the password", async () => {
    const email = `new-${Date.now().toString(36)}@example.test`;
    const made = await signup(request("/api/auth/signup", { json: { email: `  ${email.toUpperCase()} `, password: "first-password" } }), undefined);
    // this studio sends no email (no mail server is set): the account works at once. One that does asks for the link first.
    expect(await made.json()).toEqual({ confirm: false });
    const cookie = cookiesFrom(made);
    expect(await (await accountRoute(as(cookie, "/api/account"), undefined)).json()).toEqual({ account: { email, balanceUsd: 0 }, ledger: [] });
    // the password is kept as a salted hash, never as it was typed
    const [kept] = await ownerDb(s).query<{ password_hash: string }>("select password_hash from auth.users where email = $1", [email]);
    expect(kept.password_hash).toMatch(/^scrypt\$32768\$8\$1\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{43}$/);
    expect(kept.password_hash).not.toContain("first-password");

    expect((await signup(request("/api/auth/signup", { json: { email, password: "short" } }), undefined)).status).toBe(400);
    // the address is taken: nobody is signed in to someone else's account, and its password stays what it was
    const again = await signup(request("/api/auth/signup", { json: { email, password: "another-password" } }), undefined);
    expect(again.status).toBe(400);
    expect(cookiesFrom(again)).not.toMatch(/fc_session=/);
    expect((await login(request("/api/auth/login", { json: { email, password: "another-password" } }), undefined)).status).toBe(401);

    expect((await password(request("/api/auth/password", { json: { password: "second-password" } }), undefined)).status).toBe(401);
    // signed in twice: the one that changes the password stays, the other is signed out
    const elsewhere = cookiesFrom(await login(request("/api/auth/login", { json: { email, password: "first-password" } }), undefined));
    expect((await accountRoute(as(elsewhere, "/api/account"), undefined)).status).toBe(200);
    expect((await password(as(cookie, "/api/auth/password", { json: { password: "second-password" } }), undefined)).status).toBe(200);
    expect((await accountRoute(as(cookie, "/api/account"), undefined)).status).toBe(200);
    expect((await accountRoute(as(elsewhere, "/api/account"), undefined)).status).toBe(401);
    expect((await login(request("/api/auth/login", { json: { email, password: "first-password" } }), undefined)).status).toBe(401);
    expect((await login(request("/api/auth/login", { json: { email, password: "second-password" } }), undefined)).status).toBe(200);
  });

  describe("where the studio sends email", () => {
    const mails = () => (existsSync(process.env.MAIL_DIR!) ? readdirSync(process.env.MAIL_DIR!) : []).sort().map((f) => JSON.parse(readFileSync(join(process.env.MAIL_DIR!, f), "utf8")) as { kind: string; to: string; link: string; text: string });
    const follow = (link: string, cookie = "") => callback(as(cookie, link.replace("http://127.0.0.1:3131", "")), undefined);
    beforeEach(() => {
      process.env.MAIL_DIR = join(studio.root, "mail");
    });

    it("an account is nobody's until its address is confirmed, and the link signs in only the browser that asked", async () => {
      const email = `confirm-${Date.now().toString(36)}@example.test`;
      const made = await signup(request("/api/auth/signup", { json: { email, password: "first-password", next: "/new?topic=foxes" } }), undefined);
      expect(await made.json()).toEqual({ confirm: true });
      const browser = cookiesFrom(made);
      // no session yet, and the password alone does not sign in
      expect(browser).not.toMatch(/fc_session=/);
      const early = await login(request("/api/auth/login", { json: { email, password: "first-password" } }), undefined);
      expect([early.status, ((await early.json()) as { error: { message: string } }).error.message]).toEqual([401, "confirm your email address first"]);
      // (and someone who does not know the password is not told the account exists)
      expect(((await (await login(request("/api/auth/login", { json: { email, password: "wrong-password" } }), undefined)).json()) as { error: { message: string } }).error.message).toBe("wrong email or password");

      const [mail] = mails();
      expect([mail.kind, mail.to]).toEqual(["confirm", email]);
      expect(mail.link).toMatch(/^http:\/\/127\.0\.0\.1:3131\/auth\/callback\?code=[A-Za-z0-9_-]{43}&next=%2Fnew%3Ftopic%3Dfoxes$/);
      expect(mail.text).toContain(mail.link);

      // Opened in another browser (someone was sent the link): the address is confirmed, and nobody is signed in there.
      const elsewhere = await follow(mail.link);
      expect(elsewhere.headers.get("location")).toBe("http://127.0.0.1:3131/login?confirmed=1");
      expect(cookiesFrom(elsewhere)).not.toMatch(/fc_session=/);
      // a link works once
      expect((await follow(mail.link, browser)).headers.get("location")).toBe("http://127.0.0.1:3131/login?error=link");
      expect((await login(request("/api/auth/login", { json: { email, password: "first-password" } }), undefined)).status).toBe(200);
    });

    it("opened in the browser that signed up, the link signs in and goes on to where the visitor was heading", async () => {
      const email = `same-${Date.now().toString(36)}@example.test`;
      const made = await signup(request("/api/auth/signup", { json: { email, password: "first-password", next: "/new?topic=foxes" } }), undefined);
      const browser = cookiesFrom(made);
      const back = await follow(mails()[0].link, browser);
      expect(back.headers.get("location")).toBe("http://127.0.0.1:3131/new?topic=foxes");
      const cookie = cookiesFrom(back, browser);
      expect(await (await accountRoute(as(cookie, "/api/account"), undefined)).json()).toMatchObject({ account: { email } });
      // a link never leads off this site, whatever was asked for at sign-up
      const other = `away-${Date.now().toString(36)}@example.test`;
      const away = await signup(request("/api/auth/signup", { json: { email: other, password: "first-password", next: "https://evil.example/x" } }), undefined);
      expect((await follow(mails().find((m) => m.to === other)!.link, cookiesFrom(away))).headers.get("location")).toBe("http://127.0.0.1:3131/");
    });

    it("answers a sign-up for a taken address like a new one, and gives an unconfirmed account to whoever proves the mailbox", async () => {
      // a confirmed account: the same answer, no email, nothing changed
      const taken = await signup(request("/api/auth/signup", { json: { email: a.email, password: "attacker-password" } }), undefined);
      expect([taken.status, await taken.json()]).toEqual([200, { confirm: true }]);
      expect(mails()).toEqual([]);
      expect((await login(request("/api/auth/login", { json: { email: a.email, password: "attacker-password" } }), undefined)).status).toBe(401);

      // Someone signs up with an address that is not theirs and cannot confirm it. Its owner signs up later:
      // the account becomes theirs, with their password, and the first link is dead.
      const email = `squat-${Date.now().toString(36)}@example.test`;
      const squatter = cookiesFrom(await signup(request("/api/auth/signup", { json: { email, password: "squatter-password" } }), undefined));
      const first = mails()[0].link;
      const owner = cookiesFrom(await signup(request("/api/auth/signup", { json: { email, password: "owner-password-1" }, headers: { "x-forwarded-for": "203.0.113.20" } }), undefined));
      expect((await follow(first, squatter)).headers.get("location")).toBe("http://127.0.0.1:3131/login?error=link");
      const second = mails().filter((m) => m.to === email).at(-1)!.link;
      expect(second).not.toBe(first);
      expect((await follow(second, owner)).headers.get("location")).toBe("http://127.0.0.1:3131/");
      expect((await login(request("/api/auth/login", { json: { email, password: "squatter-password" } }), undefined)).status).toBe(401);
      expect((await login(request("/api/auth/login", { json: { email, password: "owner-password-1" } }), undefined)).status).toBe(200);
    });

    it("answers a reset request the same way whether or not the address has an account, and mails only the one that has", async () => {
      const known = await reset(request("/api/auth/reset", { json: { email: a.email } }), undefined);
      const unknown = await reset(request("/api/auth/reset", { json: { email: "nobody@example.test" } }), undefined);
      expect([known.status, await known.json()]).toEqual([unknown.status, await unknown.json()]);
      expect(known.status).toBe(200);
      expect(mails().map((m) => [m.kind, m.to])).toEqual([["reset", a.email]]);
    });

    it("lets the browser that asked choose a new password with the link, once, and signs every older session out", async () => {
      const asked = await reset(request("/api/auth/reset", { json: { email: a.email } }), undefined);
      const browser = cookiesFrom(asked);
      const link = mails()[0].link;
      // in any other browser the link does nothing, and is not used up
      const elsewhere = await follow(link);
      expect(elsewhere.headers.get("location")).toBe("http://127.0.0.1:3131/login?error=link");
      expect(cookiesFrom(elsewhere)).not.toMatch(/fc_session=/);

      const back = await follow(link, browser);
      expect(back.headers.get("location")).toBe("http://127.0.0.1:3131/reset/new");
      const cookie = cookiesFrom(back, browser);
      expect((await password(as(cookie, "/api/auth/password", { json: { password: "brand-new-password" } }), undefined)).status).toBe(200);
      expect((await login(request("/api/auth/login", { json: { email: a.email, password: a.password } }), undefined)).status).toBe(401);
      expect((await login(request("/api/auth/login", { json: { email: a.email, password: "brand-new-password" } }), undefined)).status).toBe(200);
      // whoever was signed in with the old password is out
      expect((await accountRoute(as(aCookie, "/api/account"), undefined)).status).toBe(401);
      expect((await follow(link, browser)).headers.get("location")).toBe("http://127.0.0.1:3131/login?error=link");
    });

    it("does not mail one address without end", async () => {
      const ask = () => reset(request("/api/auth/reset", { json: { email: b.email }, headers: { "x-forwarded-for": `203.0.113.${Math.floor(Math.random() * 200) + 1}` } }), undefined);
      for (let i = 0; i < 3; i++) expect((await ask()).status).toBe(200);
      const fourth = await ask();
      expect([fourth.status, await code(fourth)]).toEqual([429, "busy"]);
      expect(mails().filter((m) => m.to === b.email)).toHaveLength(3);
    });
  });

  describe("signing in with Google", () => {
    /** What the stand-in for Google's token address was sent, and what it answers with next. */
    let asked: URLSearchParams[] = [];
    let answer: (form: URLSearchParams) => { status: number; claims?: Record<string, unknown> } = () => ({ status: 500 });
    let google: Server;
    const CLIENT = "client-123.apps.googleusercontent.com";
    const idToken = (claims: Record<string, unknown>) => `${Buffer.from('{"alg":"RS256"}').toString("base64url")}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.signature`;
    beforeAll(async () => {
      google = createServer((req, res) => {
        let body = "";
        req.on("data", (chunk: Buffer) => (body += chunk.toString()));
        req.on("end", () => {
          const form = new URLSearchParams(body);
          asked.push(form);
          const { status, claims } = answer(form);
          res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(claims ? { id_token: idToken(claims), access_token: "unused" } : { error: "invalid_grant" }));
        });
      });
      await new Promise<void>((done) => google.listen(0, "127.0.0.1", done));
    });
    afterAll(() => google?.close());
    beforeEach(() => {
      asked = [];
      Object.assign(process.env, { GOOGLE_CLIENT_ID: CLIENT, GOOGLE_CLIENT_SECRET: "google-secret", GOOGLE_TOKEN_URL: `http://127.0.0.1:${(google.address() as AddressInfo).port}/token` });
    });
    /** Starts a sign-in as a browser would: where Google is asked, and the cookie this browser now holds. */
    const start = async (next = "/new?topic=foxes") => {
      const res = await googleStart(request(`/auth/google?next=${encodeURIComponent(next)}`), undefined);
      const to = new URL(res.headers.get("location")!);
      return { res, to, cookie: cookiesFrom(res), state: to.searchParams.get("state")!, nonce: to.searchParams.get("nonce")! };
    };
    const good = (nonce: string, email: string, more: Record<string, unknown> = {}) => ({
      status: 200,
      claims: { iss: "https://accounts.google.com", aud: CLIENT, exp: Math.floor(Date.now() / 1000) + 300, nonce, sub: `google-${email}`, email, email_verified: true, ...more },
    });
    const finish = (cookie: string, state: string, code = "code-from-google") => callback(as(cookie, `/auth/callback?code=${code}&state=${state}`), undefined);

    it("is not offered where the owner has not set it up", async () => {
      delete process.env.GOOGLE_CLIENT_SECRET;
      const res = await googleStart(request("/auth/google"), undefined);
      expect([res.status, await code(res)]).toEqual([400, "validation"]);
    });

    it("sends the visitor to Google with what ties the answer to this browser, and signs in whoever Google vouches for", async () => {
      const { res, to, cookie, state, nonce } = await start();
      expect(res.status).toBe(302);
      expect(`${to.origin}${to.pathname}`).toBe("https://accounts.google.com/o/oauth2/v2/auth");
      expect(Object.fromEntries(to.searchParams)).toMatchObject({ client_id: CLIENT, redirect_uri: "http://127.0.0.1:3131/auth/callback", response_type: "code", scope: "openid email", code_challenge_method: "S256" });
      // what the browser keeps is out of any script's reach, and for minutes only
      expect(res.headers.getSetCookie().find((c) => c.startsWith("fc_oauth="))).toMatch(/; Max-Age=600; HttpOnly; SameSite=Lax/);
      // the secret never goes to Google's page: only its hash does
      expect(decodeURIComponent(cookie)).not.toContain(to.searchParams.get("code_challenge")!);

      const email = `gina-${Date.now().toString(36)}@example.test`;
      answer = () => good(nonce, email.toUpperCase());
      const back = await finish(cookie, state);
      expect(back.headers.get("location")).toBe("http://127.0.0.1:3131/new?topic=foxes");
      // what Google's token address was asked: the code, this studio's secret, and the proof that the same browser is back
      const [form] = asked;
      expect(Object.fromEntries(form)).toMatchObject({ code: "code-from-google", client_id: CLIENT, client_secret: "google-secret", grant_type: "authorization_code", redirect_uri: "http://127.0.0.1:3131/auth/callback" });
      expect(createHash("sha256").update(form.get("code_verifier")!).digest("base64url")).toBe(to.searchParams.get("code_challenge"));
      const session = cookiesFrom(back, cookie);
      expect(session).toMatch(/fc_session=/);
      expect(session).not.toMatch(/fc_oauth=/); // used once
      expect(await (await accountRoute(as(session, "/api/account"), undefined)).json()).toEqual({ account: { email, balanceUsd: 0 }, ledger: [] });
      // signing in again is the same account, and an account with that address and a password is joined, not doubled
      const again = await start("/");
      answer = () => good(again.nonce, email);
      await finish(again.cookie, again.state);
      const joined = await start("/");
      answer = () => good(joined.nonce, a.email);
      const asA = cookiesFrom(await finish(joined.cookie, joined.state), joined.cookie);
      expect(await (await accountRoute(as(asA, "/api/account"), undefined)).json()).toMatchObject({ account: { email: a.email } });
      expect((await ownerDb(s).query("select 1 from auth.users where email = any($1)", [[email, a.email]])).length).toBe(2);
    });

    it("signs nobody in when anything about the answer is not as it must be", async () => {
      const email = `nope-${Date.now().toString(36)}@example.test`;
      const refused = async (how: string, run: (s: Awaited<ReturnType<typeof start>>) => Promise<Response>) => {
        const res = await run(await start());
        expect(res.headers.get("location"), how).toBe("http://127.0.0.1:3131/login?error=incomplete");
        expect(cookiesFrom(res), how).not.toMatch(/fc_session=/);
      };
      await refused("another browser's state", async (b) => { answer = () => good(b.nonce, email); return finish(b.cookie, (await start()).state); });
      await refused("no cookie: the answer came to a browser that did not ask", async (b) => { answer = () => good(b.nonce, email); return finish("", b.state); });
      await refused("an identity made for another request", async (b) => { answer = () => good("someone-elses-nonce-0123456789", email); return finish(b.cookie, b.state); });
      await refused("an address Google has not verified", async (b) => { answer = () => good(b.nonce, email, { email_verified: false }); return finish(b.cookie, b.state); });
      await refused("a token made for another application", async (b) => { answer = () => good(b.nonce, email, { aud: "other-app" }); return finish(b.cookie, b.state); });
      await refused("a token from somebody who is not Google", async (b) => { answer = () => good(b.nonce, email, { iss: "https://accounts.evil.example" }); return finish(b.cookie, b.state); });
      await refused("a token that has run out", async (b) => { answer = () => good(b.nonce, email, { exp: Math.floor(Date.now() / 1000) - 5 }); return finish(b.cookie, b.state); });
      await refused("a code Google refuses", async (b) => { answer = () => ({ status: 400 }); return finish(b.cookie, b.state); });
      expect((await ownerDb(s).query("select 1 from auth.users where email = $1", [email])).length).toBe(0);
      // and the answer cannot be replayed: what the browser held is gone after the first try
      const once = await start();
      answer = () => good(once.nonce, email);
      const first = await finish(once.cookie, once.state);
      expect(first.headers.get("location")).toBe("http://127.0.0.1:3131/new?topic=foxes");
      expect((await finish(cookiesFrom(first, once.cookie), once.state)).headers.get("location")).toBe("http://127.0.0.1:3131/login?error=incomplete");
    });
  });

  it("offers no reset where the studio sends no email, and says so", async () => {
    const res = await reset(request("/api/auth/reset", { json: { email: a.email } }), undefined);
    expect([res.status, await code(res)]).toEqual([400, "validation"]);
  });

  it("sends a link that proves nothing back to the login page, and never to another site", async () => {
    const res = await callback(request("/auth/callback?code=not-a-code&next=https://evil.example"), undefined);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("http://127.0.0.1:3131/login?error=link");
    // whatever an address claims went wrong is not carried onto our page
    const claimed = await callback(request("/auth/callback?error_description=Call+555-0100+to+unlock+your+account"), undefined);
    expect(claimed.headers.get("location")).toBe("http://127.0.0.1:3131/login?error=incomplete");
    // A token link works in any browser, so it could be sent to someone to sign them into the sender's account:
    // only codes are taken (a code needs the cookie of the browser that asked for it).
    for (const who of [request, (path: string) => as(aCookie, path)]) {
      const token = await callback(who("/auth/callback?token_hash=abc&type=recovery"), undefined);
      expect(token.headers.get("location")).toBe("http://127.0.0.1:3131/login?error=incomplete");
      expect(cookiesFrom(token)).not.toMatch(/fc_session=/);
    }

    // on a server the links in emails are built from the configured name, never from what a request claims
    process.env.STUDIO_HOST = "studio.example.com";
    try {
      const onServer = await callback(request("/auth/callback?code=x", { headers: { host: "studio.example.com" } }), undefined);
      expect(onServer.headers.get("location")).toBe("https://studio.example.com/login?error=link");
    } finally {
      delete process.env.STUDIO_HOST;
    }
  });

  it("shows each user their own runs, and answers 404 for everything of anyone else's", async () => {
    const mine = nextRunId();
    const theirs = nextRunId();
    await saveRunFor(studio, a, finishedManifest(mine));
    const dir = await saveRunFor(studio, b, finishedManifest(theirs));
    await mkdir(join(dir, "keyframes"), { recursive: true });
    await writeFile(join(dir, "final.mp4"), "video");

    const list = async (cookie: string) => ((await (await runs(as(cookie, "/api/runs"), undefined)).json()) as { runs: Array<{ runId: string }> }).runs.map((r) => r.runId);
    expect(await list(aCookie)).toEqual([mine]);
    expect(await list(bCookie)).toEqual([theirs]);

    // b's run through a's session: every door answers as if the run did not exist
    const id = params({ id: theirs });
    const doors: Array<[string, () => Promise<Response> | Response]> = [
      ["run", () => run(as(aCookie, `/api/runs/${theirs}`), id)],
      ["events", () => events(as(aCookie, `/api/runs/${theirs}/events`), id)],
      ["file", () => file(as(aCookie, `/api/runs/${theirs}/files/final.mp4`), params({ id: theirs, path: ["final.mp4"] }))],
      ["props", () => props(as(aCookie, `/api/runs/${theirs}/props`, { json: {} }), id)],
      ["plan", () => plan(as(aCookie, `/api/runs/${theirs}/plan`, { json: {} }), id)],
      ["modes", () => modes(as(aCookie, `/api/runs/${theirs}/modes`, { json: { modes: [1, 1, 2] } }), id)],
      ["look", () => look(as(aCookie, `/api/runs/${theirs}/look`, { json: { look: { captionStyle: "mrbeast" } } }), id)],
      ["generate", () => generate(as(aCookie, `/api/runs/${theirs}/generate`, { json: { approvedUsd: 1 } }), id)],
      ["reroll", () => reroll(as(aCookie, `/api/runs/${theirs}/reroll`, { json: { scene: 1, stage: "clips", approvedUsd: 1 } }), id)],
      ["rerender", () => rerender(as(aCookie, `/api/runs/${theirs}/rerender`, { json: { look: {} } }), id)],
      ["stop", () => stop(as(aCookie, `/api/runs/${theirs}/job`, { method: "DELETE" }), id)],
      ["unlock", () => unlock(as(aCookie, `/api/runs/${theirs}/unlock`, { json: {} }), id)],
    ];
    for (const [name, open] of doors) expect((await open()).status, name).toBe(404);

    // and the same doors open for the owner
    expect((await run(as(bCookie, `/api/runs/${theirs}`), id)).status).toBe(200);
    const served = await file(as(bCookie, `/api/runs/${theirs}/files/final.mp4`), params({ id: theirs, path: ["final.mp4"] }));
    expect([served.status, await served.text()]).toEqual([200, "video"]);
  });

  it("follows a run's folder in its live feed for its owner (the feed outlives the request that opened it)", async () => {
    const id = nextRunId();
    await saveRunFor(studio, a, draftManifest(id));
    const abort = new AbortController();
    const res = await events(as(aCookie, `/api/runs/${id}/events`, { headers: {} }), params({ id }));
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    const next = async () => decoder.decode((await reader.read()).value);
    expect(await next()).toContain('"state":"draft"');
    // a change after the handler returned is read from the same user's folder
    await saveRunFor(studio, a, finishedManifest(id));
    let text = "";
    while (!text.includes("event: run")) text = await next();
    expect(text).not.toContain('"state":"draft"');
    abort.abort();
    await reader.cancel();
  });

  it("lets one visitor's wrong guesses lock out that visitor, not everybody", async () => {
    // guesses are counted per visitor, never per account: guessing at someone's password must not lock them out
    const from = (address: string, password: string) =>
      login(request("/api/auth/login", { json: { email: a.email, password }, headers: { "x-forwarded-for": `198.51.100.7, ${address}` } }), undefined);
    for (let i = 0; i < 20; i++) expect((await from("203.0.113.5", "not-the-password")).status).toBe(401);
    const locked = await from("203.0.113.5", a.password);
    expect([locked.status, await code(locked)]).toEqual([429, "busy"]);
    // what a client claims in front of the proxy's own entry does not change who it is
    expect((await login(request("/api/auth/login", { json: { email: a.email, password: a.password }, headers: { "x-forwarded-for": "203.0.113.99, 203.0.113.5" } }), undefined)).status).toBe(429);
    // someone else, at another address, signs in as ever
    expect((await from("203.0.113.6", a.password)).status).toBe(200);
  });

  it("registers an upload as the user's, with or without a bucket, so the account's limit counts it", async () => {
    const form = new FormData();
    form.set("name", "Night bed");
    form.set("file", new File([new Uint8Array([0x49, 0x44, 0x33, 0x04, 0, 0, 0, 0, 0, 0])], "bed.mp3", { type: "audio/mpeg" }));
    const { POST: addTrack } = await import("@/app/api/music/route");
    const res = await addTrack(as(aCookie, "/api/music", { body: form }), undefined);
    expect(res.status).toBe(201);
    expect((await a.client.from("music_tracks").select("id,name")).data).toEqual([{ id: "night-bed", name: "night-bed" }]);
    expect((await b.client.from("music_tracks").select("id")).data).toEqual([]);

    // an upload that says it is larger than a track may be is refused before any of it is read
    const huge = new Request("http://127.0.0.1:3131/api/music", {
      method: "POST", body: "x",
      headers: { host: "127.0.0.1:3131", "sec-fetch-site": "same-origin", cookie: aCookie, "content-type": "multipart/form-data; boundary=x", "content-length": String(500 * 1024 * 1024) },
    });
    const refused = await addTrack(huge, undefined);
    expect([refused.status, ((await refused.json()) as { error: { message: string } }).error.message]).toEqual([400, "the upload is too large (at most 21 MB in all)"]);
  });

  it("keeps each user's brand kits and tracks apart on disk", async () => {
    const kitDir = join(studio.root, "brand-kits", a.id, "mine");
    await mkdir(kitDir, { recursive: true });
    await writeFile(join(kitDir, "kit.json"), JSON.stringify({ name: "Mine", logo: "logo.png", colors: { primary: "#ffffff", accent: "#000000" } }));
    await mkdir(join(studio.root, "uploads/music", a.id), { recursive: true });
    await writeFile(join(studio.root, "uploads/music", a.id, "track.mp3"), "ID3");
    const names = async (cookie: string) => ((await (await music(as(cookie, "/api/music"), undefined)).json()) as { tracks: Array<{ id: string; source: string }> }).tracks.filter((t) => t.source === "upload").map((t) => t.id);
    expect(await names(aCookie)).toEqual(["upload:track.mp3"]);
    expect(await names(bCookie)).toEqual([]);
    expect((await kits(as(bCookie, "/api/brand-kits"), undefined)).status).toBe(200);
    expect(((await (await kits(as(bCookie, "/api/brand-kits"), undefined)).json()) as { kits: unknown[] }).kits).toEqual([]);
  });
});
