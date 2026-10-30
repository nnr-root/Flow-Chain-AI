import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Redis } from "ioredis";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as suggest } from "@/app/api/ideas/route";
import { GET as healthRoute } from "@/app/api/health/route";
import type * as IdeasModule from "@/lib/ideas";
import { ideasPriceUsd } from "@/lib/ideas";
import { closeQueue } from "@/server/jobs/queue";
import { ideasRefusal } from "@/server/jobs/redis";
import { health as studioSettings } from "@/server/config";
import { ideasArgs, IdeasInput } from "@/server/schemas";
import { runRows } from "@/server/store/tenant";
import { db as webDb } from "@/server/db";
import { inScope } from "@/server/tenant";
import { freshRunId, localDb, newUser, serviceClient, type TestUser } from "../../test/helpers/db";
import { request, until, useStudio, withKeys } from "./helpers";
import { hasRedisServer, startRedis, startWorkerProcess, type TestRedis, type TestWorker } from "./redis";
import { as, cookiesOf, withAccounts } from "./tenant";

/*
 * Topic ideas in the studio (phase 13 plan, task 5). The price lives in a static file the owner fills after measuring,
 * which says nothing yet: a test that needs a price makes `ideasPriceUsd` answer one. The worker is a real process, and
 * its own health would not offer ideas for the same reason, so the web side's view of the health is given `ideas` too.
 */
const real = await vi.importActual<typeof IdeasModule>("@/lib/ideas");
vi.mock("@/lib/ideas", async (orig) => {
  const m = await orig<typeof IdeasModule>();
  return { ...m, ideasPriceUsd: vi.fn(m.ideasPriceUsd) };
});
vi.mock("@/server/jobs", async (orig) => {
  const m = await orig<typeof import("@/server/jobs")>();
  return { ...m, studioHealthRaw: vi.fn(m.studioHealthRaw) };
});
const jobs = await import("@/server/jobs");

const price = (usd: number | undefined) => vi.mocked(ideasPriceUsd).mockImplementation((raw?: unknown) => (usd !== undefined && raw === undefined ? usd : real.ideasPriceUsd(raw)));
const studio = useStudio();

beforeEach(() => {
  vi.mocked(ideasPriceUsd).mockImplementation(real.ideasPriceUsd);
  vi.mocked(jobs.studioHealthRaw).mockReset();
});
afterEach(() => {
  delete process.env.FLOWCHAIN_TREND_IDEAS;
});

describe("ideasPriceUsd", () => {
  it("reads a positive price from the dated file and nothing else", () => {
    expect(real.ideasPriceUsd({ usd: 0.05, measuredOn: "2026-10-30", basis: "x" })).toBe(0.05);
    for (const bad of [{ usd: null }, {}, { usd: -1 }, { usd: 0 }, { usd: "0.05" }, { usd: 6 }, null]) expect(real.ideasPriceUsd(bad), JSON.stringify(bad)).toBeUndefined();
  });

  it("is not set in the file as shipped: the button is not offered until the owner has measured", () => {
    expect(real.ideasPriceUsd()).toBeUndefined();
  });
});

describe("ideasArgs", () => {
  const input = IdeasInput.parse({ language: "en", niche: { kind: "known", id: "scary-stories" } });

  it("builds the one shape the worker accepts", () => {
    expect(ideasArgs(input)).toEqual(["ideas", "--language", "en", "--niche", "scary-stories"]);
    expect(ideasArgs(input, 0.05)).toEqual(["ideas", "--language", "en", "--niche", "scary-stories", "--cap", "0.05"]);
    expect(ideasArgs(IdeasInput.parse({ language: "de", niche: { kind: "custom", text: "retro consoles" } }))).toEqual(["ideas", "--language", "de", "--niche-text", "retro consoles"]);
    expect(ideasArgs(IdeasInput.parse({ language: "en", niche: { kind: "none" } }))).toEqual(["ideas", "--language", "en"]);
    expect(ideasArgs(IdeasInput.parse({ language: "en", format: "story" }), 0.05)).toEqual(["ideas", "--language", "en", "--format", "story", "--cap", "0.05"]);
  });

  it("always passes the worker's check when a cap is given", () => {
    for (const i of [input, IdeasInput.parse({ language: "tr" }), IdeasInput.parse({ language: "en", niche: { kind: "custom", text: "x" }, format: "story" })]) {
      expect(ideasRefusal(ideasArgs(i, 0.05))).toBeUndefined();
    }
  });
});

describe("the health answer's ideas", () => {
  const ideas = async (env: string, tenant = false) => {
    await writeFile(join(studio.root, ".env"), env);
    if (tenant) process.env.DATABASE_URL = "postgres://x";
    return JSON.parse(await (await healthRoute(request("/api/health"), undefined)).text()).ideas;
  };

  it("is offered only with the key AND the owner's switch, and is absent otherwise", async () => {
    expect(await ideas("GEMINI_API_KEY=g\n")).toBeUndefined();
    expect(await ideas("FLOWCHAIN_TREND_IDEAS=on\n")).toBeUndefined();
    expect(await ideas("GEMINI_API_KEY=g\nFLOWCHAIN_TREND_IDEAS=off\n")).toBeUndefined();
    expect(await ideas("GEMINI_API_KEY=g\nFLOWCHAIN_TREND_IDEAS=on\n")).toBe(true);
  });

  it("needs a price too in a studio with accounts", () => {
    process.env.GEMINI_API_KEY = "g";
    process.env.FLOWCHAIN_TREND_IDEAS = "on";
    process.env.DATABASE_URL = "postgres://x";
    expect(studioSettings().ideas).toBeUndefined();
    price(0.05);
    expect(studioSettings().ideas).toBe(true);
  });
});

describe("POST /api/ideas without accounts", () => {
  it("is not found while ideas are not in the health answer", async () => {
    const res = await suggest(request("/api/ideas", { json: { language: "en" } }), undefined);
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("not_found");
  });

  it("answers with the CLI's ideas when they are", async () => {
    withKeys();
    process.env.FLOWCHAIN_TREND_IDEAS = "on";
    const res = await suggest(request("/api/ideas", { json: { language: "en", niche: { kind: "known", id: "scary-stories" } } }), undefined);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ideas: [{ topic: "A topic the stub made up", why: "Because a test asked", sources: [] }], dropped: 0 });
  });

  it("refuses an unknown language as a validation error, before anything is asked", async () => {
    withKeys();
    process.env.FLOWCHAIN_TREND_IDEAS = "on";
    const res = await suggest(request("/api/ideas", { json: { language: "xx" } }), undefined);
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("validation");
  });
});

const supa = localDb();
let redis: TestRedis;
let admin: Redis;
let workers: TestWorker[] = [];

beforeAll(async () => {
  if (!supa || !hasRedisServer()) return;
  redis = await startRedis();
  admin = new Redis(redis.url, { maxRetriesPerRequest: null });
  admin.on("error", () => {});
});
afterAll(async () => {
  admin?.disconnect();
  await redis?.stop();
});
afterEach(async () => {
  await Promise.all(workers.map((w) => w.stop()));
  workers = [];
  await closeQueue();
});

describe.skipIf(!supa || !hasRedisServer())("POST /api/ideas in a studio with accounts", () => {
  const s = supa!;
  const db = () => serviceClient(s);
  const PRICE = 0.05;
  let a: TestUser;

  const worker = async (env: Record<string, string> = {}) => {
    const w = startWorkerProcess({
      REDIS_URL: redis.url, FLOWCHAIN_ROOT: studio.root, RUNS_DIR: studio.runs, FLOWCHAIN_CLI: process.env.FLOWCHAIN_CLI!,
      DATABASE_URL: s.worker, WORKER_RECONCILE_MS: "1000", WORKER_RECONCILE_KNOWN_USERS_ONLY: "1",
      GEMINI_API_KEY: "g", RUNPOD_API_KEY: "r", RUNPOD_KEYFRAME_ENDPOINT: "ep-k", RUNPOD_CLIP_ENDPOINT: "ep-c", RUNPOD_VOICE_ENDPOINT: "ep-v", R2_ACCOUNT_ID: "a", R2_BUCKET: "b", R2_ACCESS_KEY_ID: "i", R2_SECRET_ACCESS_KEY: "s", ...env,
    });
    workers.push(w);
    await until(() => w.output().includes("ready") || w.child.exitCode !== null);
  };
  const balance = async (u: TestUser) => Number((await db().from("users").select("balance_usd").eq("id", u.id).single()).data!.balance_usd);
  const grant = async (u: TestUser, usd: number) => {
    const { error } = await db().rpc("grant_credit", { p_email: u.email, p_amount_usd: usd });
    if (error) throw new Error(error.message);
  };
  const ledger = async (u: TestUser) => (await db().from("ledger").select("kind").eq("user_id", u.id).order("id")).data!.map((r) => r.kind as string);
  const post = async (cookie: string | null, json: unknown = { language: "en", niche: { kind: "known", id: "scary-stories" } }) =>
    suggest(cookie === null ? request("/api/ideas", { json }) : as(cookie, "/api/ideas", { json }), undefined);

  beforeEach(async () => {
    await admin.flushall();
    process.env.REDIS_URL = redis.url;
    withAccounts(s);
    price(PRICE);
    // the worker's own health cannot know the price the web side was given
    vi.mocked(jobs.studioHealthRaw).mockImplementation(async () => ({ missing: [], ideas: true, queue: { mode: "queue", redis: true, worker: true } }));
    a = await newUser(s, "a");
    await mkdir(join(studio.runs, a.id), { recursive: true });
  });

  it("charges the price for ideas that came: the ledger shows a reserve and a settle, and the balance is down by the price", async () => {
    await worker();
    await grant(a, 1);
    const res = await post(await cookiesOf(s, a));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ideas: [{ topic: "A topic the stub made up", why: "Because a test asked", sources: [] }], dropped: 0 });
    expect(await ledger(a)).toEqual(["grant", "reserve", "settle"]);
    expect(await balance(a)).toBe(1 - PRICE);
  });

  it("gives the whole price back and answers only with the fixed words when none came", async () => {
    await worker({ FAIL_IDEAS: "1" });
    await grant(a, 1);
    const res = await post(await cookiesOf(s, a));
    expect(res.status).toBe(502);
    const { error } = await res.json();
    expect(error).toMatchObject({ code: "ideas_failed", message: "no ideas could be made this time" });
    expect(JSON.stringify(error)).not.toMatch(/stub|provider|gemini/i);
    expect(await balance(a)).toBe(1);
  });

  it("refuses a user without credit, and holds nothing", async () => {
    await worker();
    const res = await post(await cookiesOf(s, a));
    expect(res.status).toBe(402);
    expect((await res.json()).error.code).toBe("insufficient_credit");
    expect(await ledger(a)).toEqual([]);
    expect(await balance(a)).toBe(0);
  });

  it("refuses a request nobody signed in made, as every route does", async () => {
    await worker();
    expect((await post(null)).status).toBe(401);
  });

  it("stops registering requests after fifty in a day", async () => {
    await worker();
    await grant(a, 1);
    for (let i = 0; i < 50; i++) expect((await a.client.rpc("create_idea_request", { p_id: freshRunId() })).error).toBeNull();
    const res = await post(await cookiesOf(s, a));
    expect(res.status).toBe(429);
    expect((await res.json()).error.code).toBe("too_many_jobs");
    expect(await ledger(a)).toEqual(["grant"]);
  });

  it("is not found when the price is not set, even if the health said ideas", async () => {
    await worker();
    price(undefined);
    await grant(a, 1);
    expect((await post(await cookiesOf(s, a))).status).toBe(404);
    expect(await balance(a)).toBe(1);
  });

  it("keeps a request out of the user's list of videos", async () => {
    const topicRun = freshRunId();
    expect((await a.client.rpc("create_run", { p_id: topicRun, p_topic: "foxes" })).error).toBeNull();
    expect((await a.client.rpc("create_idea_request", { p_id: freshRunId() })).error).toBeNull();
    const rows = await inScope({ user: { id: a.id, email: a.email }, db: webDb().as(a.id) }, () => runRows());
    expect(rows.map((r) => r.runId)).toEqual([topicRun]);
    expect(rows.some((r) => r.state === "ideas")).toBe(false);
  });
});
