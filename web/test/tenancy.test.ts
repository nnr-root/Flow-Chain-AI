import { mkdir, writeFile } from "node:fs/promises";
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
import { linkError, safeNext } from "@/lib/supabase/settings";
import { roots } from "@/server/config";
import { resetAttempts } from "@/server/limits";
import { closeQueue } from "@/server/jobs/queue";
import { localSupabase, newUser, type TestUser } from "../../test/helpers/supabase";
import { draftManifest, finishedManifest, nextRunId, params, request, useStudio } from "./helpers";
import { hasRedisServer, startRedis, type TestRedis } from "./redis";
import { as, cookiesFrom, cookiesOf, saveRunFor, withAccounts } from "./tenant";

/*
 * The studio with accounts, against the local Supabase stack: who may see what. Skipped when the stack is not
 * running (`npm run db:start`) or there is no `redis-server`: with accounts the studio always works through
 * the queue, so it needs a Redis even where no job is started.
 */
const supa = localSupabase();
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
    [aCookie, bCookie] = await Promise.all([cookiesOf(a), cookiesOf(b)]);
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
    for (const open of ["/welcome", "/login", "/pricing"]) expect((await ask(open))!.headers.get("x-middleware-rewrite"), open).toBeNull();
    // with a session the bare address is the studio: nothing is rewritten
    const mine = (await ask("/", aCookie))!;
    expect([mine.headers.get("x-middleware-rewrite"), mine.headers.get("location")]).toEqual([null, null]);
  });

  it("answers nobody who is not signed in, except on the sign-in routes", async () => {
    expect((await runs(request("/api/runs"), undefined)).status).toBe(401);
    expect(await code(await health(request("/api/health"), undefined))).toBe("unauthenticated");
    expect((await run(request("/api/runs/x"), params({ id: nextRunId() }))).status).toBe(401);
    // a cookie that merely claims to be a session is not one
    const garbled = aCookie.replace(/=base64-[A-Za-z0-9_-]{20}/, "=base64-AAAAAAAAAAAAAAAAAAAA");
    expect((await runs(as(garbled, "/api/runs"), undefined)).status).toBe(401);
    expect((await runs(as(aCookie, "/api/runs"), undefined)).status).toBe(200);
  });

  it("is not fooled by a well-formed token that names another user: the signature decides", async () => {
    // a's real session, with the user id inside its token swapped for b's and a's signature kept
    const [name, value] = [aCookie.slice(0, aCookie.indexOf("=")), aCookie.slice(aCookie.indexOf("=") + 1)];
    expect(aCookie).not.toContain("; "); // one cookie holds the session here
    const session = JSON.parse(Buffer.from(value.replace(/^base64-/, ""), "base64url").toString()) as { access_token: string; user: { id: string } };
    const [header, payload, signature] = session.access_token.split(".");
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString()) as Record<string, unknown>;
    const forgedToken = [header, Buffer.from(JSON.stringify({ ...claims, sub: b.id, email: b.email })).toString("base64url"), signature].join(".");
    const forged = `${name}=base64-${Buffer.from(JSON.stringify({ ...session, access_token: forgedToken, user: { ...session.user, id: b.id } })).toString("base64url")}`;

    const mine = nextRunId();
    await saveRunFor(studio, b, finishedManifest(mine));
    const res = await runs(as(forged, "/api/runs"), undefined);
    // refused outright, or at the very least never answered as b
    expect(res.status === 401 || !JSON.stringify(await res.json()).includes(mine)).toBe(true);
    expect((await run(as(forged, `/api/runs/${mine}`), params({ id: mine }))).status).not.toBe(200);
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
    expect(cookie).toMatch(/^sb-.+-auth-token/);
    // no script in a page can read the session, and an answer that carries one is never stored
    for (const line of ok.headers.getSetCookie()) expect(line).toMatch(/; HttpOnly/i);
    expect(ok.headers.get("cache-control")).toBe("private, no-store");
    const me = await accountRoute(as(cookie, "/api/account"), undefined);
    expect(await me.json()).toEqual({ account: { email: a.email, balanceUsd: 0 }, ledger: [] });

    const out = await logout(as(cookie, "/api/auth/logout", { json: {} }), undefined);
    expect(out.status).toBe(200);
    expect(cookiesFrom(out, cookie)).toBe("");
  });

  it("creates an account that starts with nothing to spend, and lets its owner change the password", async () => {
    const email = `new-${Date.now().toString(36)}@example.test`;
    const made = await signup(request("/api/auth/signup", { json: { email, password: "first-password" } }), undefined);
    // the local stack does not ask for email confirmation; production does (`confirm: true`, and no session yet)
    expect(await made.json()).toEqual({ confirm: false });
    const cookie = cookiesFrom(made);
    expect(await (await accountRoute(as(cookie, "/api/account"), undefined)).json()).toEqual({ account: { email, balanceUsd: 0 }, ledger: [] });

    expect((await signup(request("/api/auth/signup", { json: { email, password: "short" } }), undefined)).status).toBe(400);
    // signing up with an address that has an account answers like a new one: "check your inbox"
    const again = await signup(request("/api/auth/signup", { json: { email, password: "another-password" } }), undefined);
    expect([again.status, await again.json()]).toEqual([200, { confirm: true }]);
    expect(cookiesFrom(again)).not.toMatch(/auth-token(\.\d+)?=/); // and signs nobody in
    expect((await password(request("/api/auth/password", { json: { password: "second-password" } }), undefined)).status).toBe(401);
    expect((await password(as(cookie, "/api/auth/password", { json: { password: "second-password" } }), undefined)).status).toBe(200);
    expect((await login(request("/api/auth/login", { json: { email, password: "first-password" } }), undefined)).status).toBe(401);
    expect((await login(request("/api/auth/login", { json: { email, password: "second-password" } }), undefined)).status).toBe(200);
  });

  it("answers a reset request the same way whether or not the address has an account", async () => {
    const known = await reset(request("/api/auth/reset", { json: { email: a.email } }), undefined);
    const unknown = await reset(request("/api/auth/reset", { json: { email: "nobody@example.test" } }), undefined);
    expect([known.status, await known.json()]).toEqual([unknown.status, await unknown.json()]);
    expect(known.status).toBe(200);
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
      expect(cookiesFrom(token)).not.toMatch(/auth-token(\.\d+)?=/);
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
    // every sign-in reaches the accounts service from this server's one address: the studio counts per visitor itself
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
