import { createHash, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { Db } from "../../src/db/client.js";
import { freshRunId, localDb, newUser, ownerDb, visitorDb, workerDb } from "../helpers/db.js";

/*
 * The studio's own accounts in the database alone (phase 5 spec §4): what each of the two service roles can
 * and cannot do, and the sign-in functions' rules. Every test makes its own addresses and looks only at them:
 * other test files use the same database at the same time.
 */
const local = localDb();

describe.skipIf(!local)("accounts and sessions in the database", () => {
  const s = local!;
  const web = () => visitorDb(s);
  const owner = () => ownerDb(s);
  const secret = () => randomBytes(32).toString("base64url");
  const hash = (value: string) => createHash("sha256").update(value).digest();
  const address = (name: string) => `${name}-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}@example.test`;
  const HASH = "scrypt$32768$8$1$c2FsdHNhbHRzYWx0c2FsdA$a2V5a2V5a2V5a2V5a2V5a2V5a2V5a2V5a2V5a2V5a2U";
  const signUp = async (email: string, opts: { link?: string; browser?: string; confirmed?: boolean; password?: string } = {}) => {
    const { data, error } = await web().rpc<Array<{ outcome: string; user_id: string | null }>>("auth.sign_up", {
      p_email: email, p_password_hash: opts.password ?? HASH, p_token_hash: hash(opts.link ?? secret()), p_browser_hash: hash(opts.browser ?? secret()), p_confirmed: opts.confirmed ?? false,
    });
    if (error) throw new Error(error.message);
    return data[0];
  };
  const useLink = async (link: string, browser?: string) =>
    (await web().rpc<Array<{ user_id: string; purpose: string; same_browser: boolean }>>("auth.use_link", { p_token_hash: hash(link), p_browser_hash: browser ? hash(browser) : null })).data?.[0];
  const whose = async (token: string) => (await web().rpc<Array<{ user_id: string; email: string }>>("auth.whose_session", { p_token_hash: hash(token) })).data?.[0];
  const account = async (email: string) => (await owner().query<{ id: string; password_hash: string | null; google_sub: string | null; confirmed: boolean }>(
    "select id, password_hash, google_sub, email_confirmed_at is not null as confirmed from auth.users where email = $1", [email]))[0];

  describe("the two roles", () => {
    it("the web app's role reads nothing of the accounts themselves: not the tables, not through any other door", async () => {
      const u = await newUser(s, "wall");
      for (const table of ["users", "sessions", "email_tokens", "attempts"]) {
        for (const db of [web(), u.client]) {
          // 42501: permission denied — refused for who is asking
          const read = await db.query(`select * from auth.${table} limit 1`).then(() => "read", (e: { code?: string }) => e.code);
          expect(read, table).toBe("42501");
        }
      }
      // nor can it write one, sign somebody up behind the functions' back, or change a password hash
      for (const sql of [
        `insert into auth.users (email, email_confirmed_at) values ('${address("sneak")}', now())`,
        `update auth.users set password_hash = '${HASH}'`,
        `insert into auth.sessions (token_hash, user_id, expires_at) values ('\\x${"00".repeat(32)}', '${u.id}', now() + interval '1 day')`,
        `delete from auth.sessions`,
      ]) expect(await web().query(sql).then(() => "done", (e: { code?: string }) => e.code), sql).toBe("42501");
    });

    it("the web app's role cannot grant, settle or fulfil, with or without a user's name on the question", async () => {
      const u = await newUser(s, "nomoney");
      const calls: Array<[string, Record<string, unknown>]> = [
        ["grant_credit", { p_email: u.email, p_amount_usd: 100, p_note: "" }],
        ["settle", { p_reservation_id: "00000000-0000-4000-8000-000000000000", p_run_total_usd: 0 }],
        ["set_run_state", { p_run_id: freshRunId(), p_state: "done" }],
        ["grant_welcome_credit", { p_user_id: u.id, p_amount: 5, p_cap: 1000 }],
        ["link_stripe_customer", { p_user_id: u.id, p_customer_id: "cus_x" }],
        ["fulfil_topup", { p_event_id: "evt_x", p_user_id: u.id, p_payment_id: "pi_x", p_paid_usd: 10, p_credit_usd: 6, p_charge_id: "ch_x", p_invoice_url: "" }],
        ["refund_payment", { p_event_id: "evt_y", p_charge_id: "ch_x", p_refunded_usd: 1 }],
      ];
      for (const [name, args] of calls) {
        expect((await u.client.rpc(name, args)).error?.code, name).toBe("42501");
        expect((await web().rpc(name, args)).error?.code, `${name} (nobody)`).toBe("42501");
      }
      const [row] = await owner().query<{ balance_usd: number }>("select balance_usd from public.users where id = $1", [u.id]);
      expect(row.balance_usd).toBe(0);
    });

    it("the worker's role runs the money functions and reads what it settles from, and writes no table itself", async () => {
      const u = await newUser(s, "worker");
      const worker = workerDb(s);
      expect((await worker.rpc("grant_credit", { p_email: u.email, p_amount_usd: 2, p_note: "test" })).data).toBe(2);
      for (const table of ["users", "runs", "reservations", "stripe_events"]) expect((await worker.from(table).select("*").limit(1)).error, table).toBeNull();
      // it sees every user's row (it settles for all of them), which the web app's role never does
      expect((await worker.from("users").select("id").eq("id", u.id)).data).toEqual([{ id: u.id }]);
      for (const sql of [
        `update public.users set balance_usd = 1000 where id = '${u.id}'`,
        `insert into public.ledger (user_id, kind, amount_usd, balance_after_usd) values ('${u.id}', 'grant', 50, 50)`,
        `delete from public.reservations`,
        `update public.settings set welcome_credit_usd = 5`,
      ]) expect(await worker.query(sql).then(() => "done", (e: { code?: string }) => e.code), sql).toBe("42501");
      // signing people in is not its business
      expect((await worker.rpc("auth.open_session", { p_user_id: u.id, p_token_hash: hash(secret()), p_days: 1 })).error?.code).toBe("42501");
      expect((await worker.rpc("auth.credentials", { p_email: u.email })).error?.code).toBe("42501");
    });

    it("neither role can make a table, a function or a role, or become the other", async () => {
      for (const [db, other] of [[web(), "studio_worker"], [workerDb(s), "studio_web"]] as const) {
        for (const sql of [
          "create table public.mine (x int)", "create function public.mine() returns int language sql as 'select 1'",
          "create role intruder", "set role postgres", `set role ${other}`, `alter role ${other} bypassrls`, "alter role postgres password 'x'",
          "alter table public.users disable row level security", `grant ${other} to current_user`, "create schema mine",
        ]) expect(await db.query(sql).then(() => "done", () => "refused"), `${other === "studio_worker" ? "web" : "worker"}: ${sql}`).toBe("refused");
      }
    });
  });

  describe("who is asking", () => {
    it("is nobody unless the web app says who, for one statement at a time", async () => {
      const [a, b] = await Promise.all([newUser(s, "who-a"), newUser(s, "who-b")]);
      const uid = async (db: Db) => (await db.query<{ uid: string | null }>("select auth.uid() as uid"))[0].uid;
      expect(await uid(web())).toBeNull();
      expect(await uid(a.client)).toBe(a.id);
      expect(await uid(b.client)).toBe(b.id);
      // a function that acts for the caller refuses when there is none
      expect((await web().rpc("create_run", { p_id: freshRunId(), p_topic: "x" })).error?.message).toBe("unauthenticated");
      expect((await web().rpc("reserve_credit", { p_run_id: freshRunId(), p_kind: "draft", p_cap_usd: 0 })).error?.message).toBe("unauthenticated");
      expect((await web().from("users").select("id")).data).toEqual([]);
    });

    it("never carries one visitor's name into another's statement, however the connections are shared", async () => {
      // one connection for everything: each statement must still see only who it was asked for
      const one = Db.connect(s.web, { max: 1 });
      try {
        const users = await Promise.all(Array.from({ length: 6 }, (_, i) => newUser(s, `pool${i}`)));
        const asked = await Promise.all(
          Array.from({ length: 60 }, (_, i) => {
            const u = users[i % users.length];
            return i % 7 === 3
              ? one.query<{ id: string }>("select id from public.users").then((rows) => ({ want: [] as string[], got: rows.map((r) => r.id) }))
              : one.as(u.id).query<{ id: string }>("select id from public.users").then((rows) => ({ want: [u.id], got: rows.map((r) => r.id) }));
          }),
        );
        for (const { want, got } of asked) expect(got).toEqual(want);
        // a statement that fails leaves nothing behind either: the next one on that connection is nobody again
        await one.as(users[0].id).query("select 1/0").catch(() => {});
        expect((await one.query("select id from public.users")).length).toBe(0);
        expect((await one.query<{ v: string | null }>("select current_setting('app.user_id', true) as v"))[0].v ?? "").toBe("");
      } finally {
        await one.end();
      }
    });

    it("takes only an id as an id: anything else is nobody, never an error that says more", async () => {
      const u = await newUser(s, "shape");
      const as = async (value: string) => {
        const one = Db.connect(s.web, { max: 1 });
        try {
          return (await one.query<{ uid: string | null; n: number }>(`select set_config('app.user_id', $1, false), auth.uid() as uid, (select count(*)::int from public.users) as n`, [value]))[0];
        } finally {
          await one.end();
        }
      };
      expect(await as(u.id)).toMatchObject({ uid: u.id, n: 1 });
      for (const not of ["", "not-an-id", `${u.id}' or '1'='1`, u.id.toUpperCase(), ` ${u.id}`, "00000000-0000-0000-0000-000000000000"]) {
        const seen = await as(not);
        expect(seen.n, JSON.stringify(not)).toBe(0);
      }
    });
  });

  describe("signing up", () => {
    it("makes an account that is nobody's until its address is confirmed, and has nothing to spend", async () => {
      const email = address("new");
      const link = secret();
      const browser = secret();
      expect(await signUp(`  ${email.toUpperCase()} `, { link, browser })).toMatchObject({ outcome: "new" });
      const made = await account(email);
      expect(made).toMatchObject({ confirmed: false, google_sub: null });
      // it has its row in the studio's own table already, and no credit
      expect((await owner().query("select balance_usd from public.users where id = $1", [made.id]))).toEqual([{ balance_usd: 0 }]);
      // no session can be opened for it, by any path
      expect((await web().rpc("auth.open_session", { p_user_id: made.id, p_token_hash: hash(secret()), p_days: 30 })).error?.message).toBe("invalid_session");
      expect(await useLink(link, browser)).toEqual({ user_id: made.id, purpose: "confirm", same_browser: true });
      expect((await account(email)).confirmed).toBe(true);
      expect((await web().rpc("auth.open_session", { p_user_id: made.id, p_token_hash: hash(secret()), p_days: 30 })).error).toBeNull();
    });

    it("says nothing about an address that has an account, and changes nothing of it", async () => {
      const u = await newUser(s, "taken");
      const before = await account(u.email);
      expect(await signUp(u.email, { password: `${HASH}x` })).toEqual({ outcome: "exists", user_id: null });
      expect(await account(u.email)).toEqual(before);
    });

    it("gives an account nobody confirmed to whoever signs up next: the earlier password, link and sessions are gone", async () => {
      const email = address("squat");
      const [first, second] = [secret(), secret()];
      const squatter = await signUp(email, { link: first, password: `${HASH}1` });
      const again = await signUp(email, { link: second, password: `${HASH}2` });
      expect([squatter.outcome, again.outcome, again.user_id]).toEqual(["new", "pending", squatter.user_id]);
      expect((await account(email)).password_hash).toBe(`${HASH}2`);
      expect(await useLink(first)).toBeUndefined();
      expect(await useLink(second)).toMatchObject({ purpose: "confirm", same_browser: false });
    });

    it("takes two sign-ups with one address at the same moment as one account", async () => {
      const email = address("race");
      const outcomes = (await Promise.all(Array.from({ length: 8 }, () => signUp(email)))).map((r) => r.outcome).sort();
      expect(outcomes).toEqual(["new", ...Array.from({ length: 7 }, () => "pending")]);
      expect((await owner().query("select 1 from auth.users where email = $1", [email])).length).toBe(1);
    });

    it("refuses an address that is none, or one not written the one way addresses are kept", async () => {
      expect((await web().rpc("auth.sign_up", { p_email: "  ", p_password_hash: HASH, p_token_hash: hash(secret()), p_browser_hash: hash(secret()), p_confirmed: false })).error?.message).toBe("invalid_account");
      expect((await web().rpc("auth.sign_up", { p_email: address("nohash"), p_password_hash: null, p_token_hash: hash(secret()), p_browser_hash: hash(secret()), p_confirmed: false })).error?.message).toBe("invalid_account");
      // the table itself refuses what the functions would never write
      for (const bad of ["Upper@Example.test", " spaced@example.test", ""]) {
        expect(await owner().query("insert into auth.users (email) values ($1)", [bad]).then(() => "kept", (e: { code?: string }) => e.code), JSON.stringify(bad)).toBe("23514");
      }
    });
  });

  describe("emailed links", () => {
    it("work once, for a day, and a link to confirm does not sign in a browser that did not ask for it", async () => {
      const email = address("link");
      const [link, browser] = [secret(), secret()];
      const { user_id } = await signUp(email, { link, browser });
      // someone else's browser: the address is confirmed (it is proven either way), and that is all
      expect(await useLink(link, secret())).toEqual({ user_id, purpose: "confirm", same_browser: false });
      expect(await useLink(link, browser)).toBeUndefined();
      expect(await useLink(secret(), browser)).toBeUndefined();

      const late = address("late");
      const stale = secret();
      await signUp(late, { link: stale });
      await owner().query("update auth.email_tokens set expires_at = now() - interval '1 second' where token_hash = $1", [hash(stale)]);
      expect(await useLink(stale)).toBeUndefined();
      expect((await account(late)).confirmed).toBe(false);
    });

    it("a link to choose a new password works only in the browser that asked, and is not used up anywhere else", async () => {
      const u = await newUser(s, "reset");
      const [link, browser] = [secret(), secret()];
      expect((await web().rpc("auth.request_reset", { p_email: u.email.toUpperCase(), p_token_hash: hash(link), p_browser_hash: hash(browser) })).data).toBe(true);
      expect((await web().rpc("auth.request_reset", { p_email: address("nobody"), p_token_hash: hash(secret()), p_browser_hash: hash(secret()) })).data).toBe(false);
      expect(await useLink(link)).toBeUndefined();
      expect(await useLink(link, secret())).toBeUndefined();
      expect(await useLink(link, browser)).toEqual({ user_id: u.id, purpose: "reset", same_browser: true });
      expect(await useLink(link, browser)).toBeUndefined();
      // asking again makes the earlier link worthless
      const [older, newer] = [secret(), secret()];
      await web().rpc("auth.request_reset", { p_email: u.email, p_token_hash: hash(older), p_browser_hash: hash(browser) });
      await web().rpc("auth.request_reset", { p_email: u.email, p_token_hash: hash(newer), p_browser_hash: hash(browser) });
      expect(await useLink(older, browser)).toBeUndefined();
      expect(await useLink(newer, browser)).toMatchObject({ purpose: "reset" });
    });
  });

  describe("sessions and passwords", () => {
    it("a session is its secret's hash and an end date; it answers for nobody once it has run out or was closed", async () => {
      const u = await newUser(s, "session");
      const token = secret();
      expect((await web().rpc("auth.open_session", { p_user_id: u.id, p_token_hash: hash(token), p_days: 30 })).error).toBeNull();
      expect(await whose(token)).toEqual({ user_id: u.id, email: u.email });
      expect(await whose(secret())).toBeUndefined();
      // the hash itself is not the secret
      expect((await web().rpc("auth.whose_session", { p_token_hash: hash(hash(token).toString("base64url")) })).data).toEqual([]);
      await owner().query("update auth.sessions set expires_at = now() where token_hash = $1", [hash(token)]);
      expect(await whose(token)).toBeUndefined();

      const second = secret();
      await web().rpc("auth.open_session", { p_user_id: u.id, p_token_hash: hash(second), p_days: 1 });
      await web().rpc("auth.close_session", { p_token_hash: hash(second) });
      expect(await whose(second)).toBeUndefined();
      for (const days of [0, -1, 91, null]) expect((await web().rpc("auth.open_session", { p_user_id: u.id, p_token_hash: hash(secret()), p_days: days })).error?.message, String(days)).toBe("invalid_session");
      // a hash of the wrong length is not a hash
      expect((await web().rpc("auth.open_session", { p_user_id: u.id, p_token_hash: Buffer.from("short"), p_days: 1 })).error?.code).toBe("23514");
    });

    it("a new password is set by its owner alone, and ends every session but the one that set it", async () => {
      const [a, b] = await Promise.all([newUser(s, "pw-a"), newUser(s, "pw-b")]);
      const [mine, other, theirs] = [secret(), secret(), secret()];
      for (const [user, token] of [[a, mine], [a, other], [b, theirs]] as const) await web().rpc("auth.open_session", { p_user_id: user.id, p_token_hash: hash(token), p_days: 30 });
      // nobody's name on the question: refused
      expect((await web().rpc("auth.set_password", { p_password_hash: `${HASH}n`, p_keep_session: null })).error?.message).toBe("unauthenticated");
      expect((await a.client.rpc("auth.set_password", { p_password_hash: `${HASH}n`, p_keep_session: hash(mine) })).error).toBeNull();
      expect((await account(a.email)).password_hash).toBe(`${HASH}n`);
      expect((await account(b.email)).password_hash).not.toBe(`${HASH}n`);
      expect([!!(await whose(mine)), !!(await whose(other)), !!(await whose(theirs))]).toEqual([true, false, true]);
    });

    it("what is needed to check a password is given for an address with one, and for no other", async () => {
      const u = await newUser(s, "creds");
      const { data } = await web().rpc<Array<{ user_id: string; password_hash: string; confirmed: boolean }>>("auth.credentials", { p_email: ` ${u.email.toUpperCase()} ` });
      expect(data).toEqual([{ user_id: u.id, password_hash: expect.stringMatching(/^scrypt\$/), confirmed: true }]);
      expect((await web().rpc("auth.credentials", { p_email: address("nobody") })).data).toEqual([]);
      // an account that only signs in with Google has no password to check
      const google = address("g-only");
      await web().rpc("auth.google", { p_sub: `sub-${google}`, p_email: google });
      expect((await web().rpc("auth.credentials", { p_email: google })).data).toEqual([]);
    });
  });

  describe("signing in with Google", () => {
    const google = async (sub: string, email: string) => (await web().rpc<string>("auth.google", { p_sub: sub, p_email: email })).data;

    it("makes an account that is confirmed at once, and finds it again by Google's own id whatever its address is now", async () => {
      const email = address("g-new");
      const id = await google(`sub-${email}`, email.toUpperCase());
      expect(await account(email)).toMatchObject({ id, confirmed: true, password_hash: null, google_sub: `sub-${email}` });
      expect(await google(`sub-${email}`, address("moved"))).toBe(id);
    });

    it("joins a confirmed account with the same address, and keeps its password", async () => {
      const u = await newUser(s, "g-join");
      expect(await google(`sub-${u.email}`, u.email)).toBe(u.id);
      expect(await account(u.email)).toMatchObject({ google_sub: `sub-${u.email}`, password_hash: expect.stringMatching(/^scrypt\$/) });
    });

    it("takes an account nobody confirmed away from whoever made it: their password and sessions are gone", async () => {
      const email = address("g-squat");
      const stale = secret();
      const { user_id } = await signUp(email, { link: stale });
      expect(await google(`sub-${email}`, email)).toBe(user_id);
      expect(await account(email)).toMatchObject({ confirmed: true, password_hash: null });
      expect(await useLink(stale)).toBeUndefined();
    });

    it("refuses a Google identity without an id or an address", async () => {
      expect((await web().rpc("auth.google", { p_sub: "", p_email: address("x") })).error?.message).toBe("invalid_account");
      expect((await web().rpc("auth.google", { p_sub: "sub", p_email: " " })).error?.message).toBe("invalid_account");
    });
  });

  describe("counting attempts", () => {
    const allow = async (key: string, max: number, window = "10 minutes") => (await web().rpc<boolean>("auth.allow", { p_key: key, p_max: max, p_window: window })).data;

    it("lets the first few through and refuses the rest, even when they all come at once", async () => {
      const key = `test:${secret()}`;
      const answers = await Promise.all(Array.from({ length: 9 }, () => allow(key, 3)));
      expect(answers.filter(Boolean)).toHaveLength(3);
      // another key is counted on its own
      expect(await allow(`test:${secret()}`, 1)).toBe(true);
    });

    it("forgets what is older than the window, and takes no key or limit that is none", async () => {
      const key = `test:${secret()}`;
      expect([await allow(key, 1), await allow(key, 1)]).toEqual([true, false]);
      await owner().query("update auth.attempts set at = now() - interval '11 minutes' where key = $1", [key]);
      expect(await allow(key, 1)).toBe(true);
      for (const [k, max] of [["", 3], [key, 0], [key, null]] as const) expect(await allow(k as string, max as number), JSON.stringify([k, max])).toBe(false);
    });
  });
});
