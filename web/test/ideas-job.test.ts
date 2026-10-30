import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { Queue, QueueEvents } from "bullmq";
import { Redis } from "ioredis";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { NICHE_TEXT_MAX } from "@src/niches";
import { ideasJob, studioHealthRaw } from "@/server/jobs";
import { closeQueue } from "@/server/jobs/queue";
import { ideasRefusal, JOB_OPTIONS, QUEUES, refusal } from "@/server/jobs/redis";
import { inScope } from "@/server/tenant";
import { freshRunId, localDb, newUser, serviceClient, type TestUser } from "../../test/helpers/db";
import { until, useStudio } from "./helpers";
import { hasRedisServer, startRedis, startWorkerProcess, type TestRedis, type TestWorker } from "./redis";
import { withAccounts } from "./tenant";

/*
 * Topic ideas through the queue (phase 13 plan, task 4): the worker runs an `ideas` command only with credit held for
 * exactly it, keeps the price when ideas came and gives it all back when none did. The worker cases need the local
 * database and `redis-server` and are skipped without either, as in tenant-queue.test.ts. Nothing reaches a provider.
 */
describe("ideasRefusal", () => {
  const base = ["ideas", "--language", "en", "--cap", "0.05"];

  it("accepts the shape the studio builds, with any of the optional choices in any order", () => {
    expect(ideasRefusal(base)).toBeUndefined();
    expect(ideasRefusal([...base, "--niche", "scary-stories"])).toBeUndefined();
    expect(ideasRefusal([...base, "--region", "TR"])).toBeUndefined();
    expect(ideasRefusal([...base, "--format", "documentary"])).toBeUndefined();
    expect(ideasRefusal([...base, "--niche-text", "retro consoles"])).toBeUndefined();
    expect(ideasRefusal(["ideas", "--niche-text", "retro consoles", "--cap", "0.05", "--format", "story", "--region", "tr", "--language", "de", "--niche", "scary-stories"])).toBeUndefined();
  });

  it("refuses anything else that could reach the worker", () => {
    for (const args of [
      ["ideas", "--cap", "0.05"], // no language
      ["ideas", "--language", "en"], // no cap
      [...base, "--language", "de"], // repeated
      [...base, "--cap", "0.05"], // the cap twice: a command line reads the last one
      [...base, "--topic", "x"], // unknown option
      ["ideas", "--language", "english", "--cap", "0.05"],
      [...base, "--niche", "not-a-niche"],
      [...base, "--niche-text", "x".repeat(NICHE_TEXT_MAX + 1)],
      [...base, "--yes"],
      [...base, "--region"], // an option without its value
      ["ideas", "--language", "en", "--cap", "lots"],
      [...base, "--region", "TUR"],
      [...base, "--format", "not-a-type"],
      ["resume", "--language", "en", "--cap", "0.05"],
      ["plan", "x"],
      ["ideas", "--language", "en", "--cap", 0.05],
      [],
      "ideas --language en --cap 0.05",
      undefined,
    ] as unknown[]) {
      expect(ideasRefusal(args), JSON.stringify(args)).toEqual(expect.any(String));
    }
  });

  it("is not a free quick command: asked for as one, it would spend without credit held", () => {
    expect(refusal("quick", base)).toEqual(expect.any(String));
  });
});

const supa = localDb();
const studio = useStudio();
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

describe.skipIf(!supa || !hasRedisServer())("an ideas job through the queue", () => {
  const s = supa!;
  const db = () => serviceClient(s);
  const PRICE = 0.05;
  const ARGS = ["ideas", "--language", "en", "--cap", "0.05", "--niche", "scary-stories"];
  let a: TestUser;
  let b: TestUser;

  const folder = (u: TestUser) => join(studio.runs, u.id);
  const balance = async (u: TestUser) => Number((await db().from("users").select("balance_usd").eq("id", u.id).single()).data!.balance_usd);
  const grant = async (u: TestUser, usd: number) => {
    const { error } = await db().rpc("grant_credit", { p_email: u.email, p_amount_usd: usd });
    if (error) throw new Error(error.message);
  };
  const request = async (u: TestUser) => {
    const id = freshRunId();
    const { error } = await u.client.rpc("create_idea_request", { p_id: id });
    if (error) throw new Error(error.message);
    return id;
  };
  const hold = async (u: TestUser, runId: string, cap = PRICE, kind = "ideas") => {
    const { data, error } = await u.client.rpc("reserve_credit", { p_run_id: runId, p_kind: kind, p_cap_usd: cap });
    if (error) throw new Error(error.message);
    return data as string;
  };
  const reservation = async (id: string) =>
    (await db().from("reservations").select("status,charged_usd").eq("id", id).single()).data as { status: string; charged_usd: number | null };
  const worker = async (env: Record<string, string> = {}): Promise<TestWorker> => {
    const w = startWorkerProcess({
      REDIS_URL: redis.url, FLOWCHAIN_ROOT: studio.root, RUNS_DIR: studio.runs, FLOWCHAIN_CLI: process.env.FLOWCHAIN_CLI!,
      DATABASE_URL: s.worker, WORKER_RECONCILE_MS: "1000",
      // other test files use the same database at the same time: this worker leaves their users' credit alone
      WORKER_RECONCILE_KNOWN_USERS_ONLY: "1",
      GEMINI_API_KEY: "g", RUNPOD_API_KEY: "r", RUNPOD_KEYFRAME_ENDPOINT: "ep-k", RUNPOD_CLIP_ENDPOINT: "ep-c", RUNPOD_VOICE_ENDPOINT: "ep-v", R2_ACCOUNT_ID: "a", R2_BUCKET: "b", R2_ACCESS_KEY_ID: "i", R2_SECRET_ACCESS_KEY: "s", ...env,
    });
    workers.push(w);
    await until(() => w.output().includes("ready") || w.child.exitCode !== null);
    return w;
  };
  /** As the studio asks: in the signed-in user's scope, through the queue runner. */
  const ask = (u: TestUser, args: string[], held?: { runId: string; reservationId: string }) => inScope({ user: { id: u.id, email: u.email } }, () => ideasJob(args, held));

  beforeEach(async () => {
    await admin.flushall();
    process.env.REDIS_URL = redis.url;
    withAccounts(s);
    [a, b] = await Promise.all([newUser(s, "a"), newUser(s, "b")]);
    await Promise.all([mkdir(folder(a), { recursive: true }), mkdir(folder(b), { recursive: true })]);
  });

  it("answers with the CLI's ideas and charges exactly the price held for them", async () => {
    await worker();
    await grant(a, 1);
    const runId = await request(a);
    const reservationId = await hold(a, runId);
    expect(await balance(a)).toBe(0.95);
    const answer = JSON.parse(await ask(a, ARGS, { runId, reservationId })) as { ideas: Array<{ topic: string }>; dropped: number };
    expect(answer).toEqual({ ideas: [{ topic: "A topic the stub made up", why: "Because a test asked", sources: [] }], dropped: 0 });
    expect(await reservation(reservationId)).toEqual({ status: "settled", charged_usd: PRICE });
    expect(await balance(a)).toBe(0.95);
    expect(await balance(b)).toBe(0);
  });

  it("gives the whole price back when no ideas came, and tells the user nothing of the CLI's own words", async () => {
    await worker({ FAIL_IDEAS: "1" });
    await grant(a, 1);
    const runId = await request(a);
    const reservationId = await hold(a, runId);
    const failed = await ask(a, ARGS, { runId, reservationId }).catch((err: unknown) => err);
    expect(failed).toMatchObject({ code: "ideas_failed", message: "no ideas could be made this time" });
    expect(String((failed as Error).message)).not.toMatch(/stub|provider/i);
    expect(await reservation(reservationId)).toEqual({ status: "settled", charged_usd: 0 });
    expect(await balance(a)).toBe(1);
  });

  it("does not refund a request still being made, however long it takes", async () => {
    // the reconcile passes several times while the request is made, and looks at reservations this young
    await worker({ WORKER_RECONCILE_MS: "1000", IDEAS_DELAY_MS: "4000" });
    await grant(a, 1);
    const runId = await request(a);
    // the queue's connections are made first, so the job is taken at once after the credit is held
    await inScope({ user: { id: a.id, email: a.email } }, () => studioHealthRaw());
    const reservationId = await hold(a, runId);
    await ask(a, ARGS, { runId, reservationId });
    expect(await reservation(reservationId)).toEqual({ status: "settled", charged_usd: PRICE });
    expect(await balance(a)).toBe(0.95);
  });

  it("refuses an ideas job that has no credit held for exactly it, and spends and settles nothing", async () => {
    // a reconcile pass so rare that it cannot be what settles here
    const w = await worker({ WORKER_RECONCILE_MS: "600000" });
    await grant(a, 1);
    await grant(b, 1);
    const runId = await request(a);
    const reservationId = await hold(a, runId);
    const otherRequest = await request(a);
    const bRequest = await request(b);
    const bReservation = await hold(b, bRequest);
    // a run of a's with a draft's credit held, not an ideas request's
    const draftRun = freshRunId();
    expect((await a.client.rpc("create_run", { p_id: draftRun, p_topic: "foxes" })).error).toBeNull();
    const draftReservation = await hold(a, draftRun, PRICE, "draft");
    const before = [await balance(a), await balance(b)];

    const quick = new Queue(QUEUES.quick, { connection: admin });
    const events = new QueueEvents(QUEUES.quick, { connection: new Redis(redis.url, { maxRetriesPerRequest: null }) });
    await events.waitUntilReady();
    const send = async (data: Record<string, unknown>) => {
      const job = await quick.add("ideas", { args: ARGS, userId: a.id, runId, reservationId, ...data }, JOB_OPTIONS);
      return job.waitUntilFinished(events, 20_000).then(() => "ran", (err: Error) => err.message);
    };
    try {
      for (const data of [
        { args: ["ideas", "--language", "en", "--cap", "0.5"] }, // a cap other than the one held
        { reservationId: undefined }, // no reservation
        { reservationId: bReservation }, // someone else's
        { reservationId: bReservation, userId: b.id }, // someone else's, for a request of a's
        { runId: draftRun, reservationId: draftReservation }, // a draft's
        { runId: otherRequest }, // a request the reservation is not for
      ]) {
        expect(await send(data), JSON.stringify(data)).toMatch(/no credit is held for this ideas/);
      }
      expect(await send({ args: [...ARGS, "--cap", "0.05"] })).toMatch(/may not repeat --cap/);
    } finally {
      await quick.close();
      await events.close();
    }
    // nothing ran, nothing was settled, and the credit is still held
    expect(w.output()).not.toMatch(/settled/);
    for (const id of [reservationId, bReservation, draftReservation]) expect((await reservation(id)).status).toBe("open");
    expect([await balance(a), await balance(b)]).toEqual(before);
  });
});
