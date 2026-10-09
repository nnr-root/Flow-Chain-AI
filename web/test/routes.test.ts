import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { RenderProps } from "@src/media/remotion/props";
import { loadManifest } from "@src/manifest/store";
import { RUN_ID } from "@src/studio/commands";
import { POST as createDraft } from "@/app/api/drafts/route";
import { GET as health } from "@/app/api/health/route";
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
import { decodeLookToken, encodeLookToken } from "@/lib/look-token";
import { readJob } from "@/server/jobs";
import { calls, draftManifest, finishedManifest, nextRunId, params, request, saveRun, stub, until, useStudio, withKeys } from "./helpers";

const studio = useStudio();
const error = async (res: Response) => (await res.json()).error as { code: string; message: string; totalUsd?: number };
const jobDone = (id: string) => until(() => readJob(join(studio.runs, id))?.state === "ended");

describe("reads", () => {
  it("health names what is missing and never a value", async () => {
    await writeFile(join(studio.root, ".env"), "GEMINI_API_KEY=secret-g\nELEVENLABS_API_KEY=secret-e\nRUNPOD_API_KEY=secret-r\nFLOWCHAIN_BUDGET_USD=5\n");
    const res = await health(request("/api/health"), undefined);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({
      missing: ["ELEVENLABS_VOICE_ID", "RUNPOD_KEYFRAME_ENDPOINT", "RUNPOD_CLIP_ENDPOINT", "R2_ACCOUNT_ID", "R2_BUCKET", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"],
      defaults: { budgetUsd: 5 },
      queue: { mode: "local" },
    });
    expect(text).not.toContain("secret");
  });

  it("lists runs and shows one with its state, status and log tail", async () => {
    const id = nextRunId();
    const dir = await saveRun(studio, finishedManifest(id));
    await writeFile(join(dir, "job.log"), "a\nb\n");
    expect((await (await runs(request("/api/runs"), undefined)).json()).runs).toEqual([expect.objectContaining({ runId: id, state: "done" })]);
    const one = await (await run(request(`/api/runs/${id}`), params({ id }))).json();
    expect(one).toMatchObject({ runId: id, state: "done", job: null, log: ["a", "b"], status: { topic: "foxes at night", draft: false } });
    expect((await run(request("/api/runs/nope"), params({ id: "nope" }))).status).toBe(404);
    expect((await run(request(`/api/runs/${nextRunId()}`), params({ id: nextRunId() }))).status).toBe(404);
  });

  it("props are valid RenderProps: draft stand-ins for a draft, real media once it exists, with the pending look", async () => {
    const draft = nextRunId();
    await saveRun(studio, draftManifest(draft));
    const a = await (await props(request(`/api/runs/${draft}/props`, { json: {} }), params({ id: draft }))).json();
    expect(a.draft).toBe(true);
    expect(() => RenderProps.parse(a.props)).not.toThrow();
    expect(a.props.scenes[0].src).toBe("draft/scene_01.svg");

    const done = nextRunId();
    await saveRun(studio, finishedManifest(done));
    const b = await (await props(request(`/api/runs/${done}/props`, { json: { look: { hook: false, captionStyle: "mrbeast" } } }), params({ id: done }))).json();
    expect(b.draft).toBe(false);
    expect(b.props.hook).toBeNull();
    expect(b.props.captions.style.font.family).toBe("Luckiest Guy");
    expect((await loadManifest(join(studio.runs, done))).request.render.hook).toBe(true); // a preview saves nothing

    const bad = await props(request(`/api/runs/${done}/props`, { json: { look: { seed: 1 } } }), params({ id: done }));
    expect(bad.status).toBe(400);
  });

  it("files: a draft's cards, a run's media with ranges, the pending look's font, and nothing else", async () => {
    const id = nextRunId();
    const dir = await saveRun(studio, finishedManifest(id));
    await mkdir(join(dir, "fitted"));
    await writeFile(join(dir, "fitted/scene_01.mp4"), "0123456789");
    const get = (path: string, headers = {}) => file(request(`/api/runs/${id}/files/${path}`, { headers }), params({ id, path: path.split("/") }));
    const part = await get("fitted/scene_01.mp4", { range: "bytes=0-3" });
    expect(part.status).toBe(206);
    expect(await part.text()).toBe("0123");
    for (const path of ["manifest.json", "job.json", "../x", "audio/scene_01.wav"]) expect((await get(path)).status).toBe(404);

    // the bundled font of a caption style is published only while that style is the (pending) look
    await mkdir(join(studio.root, "assets/fonts"), { recursive: true });
    await writeFile(join(studio.root, "assets/fonts/LuckiestGuy-Regular.ttf"), "font");
    expect((await get("LuckiestGuy-Regular.ttf")).status).toBe(404);
    const font = await get(`${encodeLookToken({ v: "1", look: { captionStyle: "mrbeast" } })}/LuckiestGuy-Regular.ttf`);
    expect(font.status).toBe(200);
    expect(font.headers.get("content-type")).toBe("font/ttf");
    // the token is only a look and a cache-buster: it opens nothing the props do not publish
    expect((await get(`${encodeLookToken({ v: "2" })}/fitted/scene_01.mp4`)).status).toBe(200);
    expect((await get(`${encodeLookToken({ v: "2" })}/manifest.json`)).status).toBe(404);
    expect((await get("~not-a-token/LuckiestGuy-Regular.ttf")).status).toBe(400);
    expect((await get(`${encodeLookToken({ look: { seed: 1 } })}/final.mp4`)).status).toBe(400);

    const draft = nextRunId();
    await saveRun(studio, draftManifest(draft));
    const card = await file(request(`/api/runs/${draft}/files/draft/scene_01.svg`), params({ id: draft, path: ["draft", "scene_01.svg"] }));
    expect(await card.text()).toContain("SCENE 1 OF 3");
  });

  it("events answer with a stream for a run and 404 for none", async () => {
    const id = nextRunId();
    await saveRun(studio, draftManifest(id));
    const abort = new AbortController();
    const res = await events(new Request(`http://127.0.0.1:3131/api/runs/${id}/events`, { headers: { host: "127.0.0.1:3131" }, signal: abort.signal }), params({ id }));
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const first = new TextDecoder().decode((await res.body!.getReader().read()).value);
    expect(first).toContain("event: run");
    expect(first).toContain('"state":"draft"');
    abort.abort();
    const missing = nextRunId();
    expect((await events(request(`/api/runs/${missing}/events`), params({ id: missing }))).status).toBe(404);
  });
});

describe("the look token", () => {
  it("round-trips a look with any characters and always leaves the URL ending in the file name", () => {
    const token = encodeLookToken({ v: "done::20", look: { hook: "Ünïcode / hook?" } });
    expect(token).toMatch(/^~[A-Za-z0-9_-]+$/);
    expect(decodeLookToken(token)).toEqual({ v: "done::20", look: { hook: "Ünïcode / hook?" } });
    expect(() => decodeLookToken("~bm9wZQ")).toThrow();
  });
});

describe("creating a draft", () => {
  it("refuses, naming the variables, while keys are missing — before any run exists", async () => {
    const res = await createDraft(request("/api/drafts", { json: { topic: "foxes", budgetUsd: 3 } }), undefined);
    expect(res.status).toBe(400);
    expect(await error(res)).toMatchObject({ code: "missing_keys", message: "not set in .env: GEMINI_API_KEY, ELEVENLABS_API_KEY, ELEVENLABS_VOICE_ID, RUNPOD_API_KEY, RUNPOD_KEYFRAME_ENDPOINT, RUNPOD_CLIP_ENDPOINT, R2_ACCOUNT_ID, R2_BUCKET, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY" });
    expect(await calls(studio)).toEqual([]);
  });

  it("starts `run --draft` with a new run id and the form's options; the run then shows as a draft", async () => {
    withKeys();
    await stub(studio, "_draft-manifest.json", draftManifest("placeholder"));
    const res = await createDraft(request("/api/drafts", { json: { topic: "foxes at night", budgetUsd: 2, scenes: 3, motion: "stills" } }), undefined);
    expect(res.status).toBe(202);
    const { runId, job } = await res.json();
    expect(RUN_ID.test(runId)).toBe(true);
    expect(job).toMatchObject({ kind: "draft", state: "running" });
    await jobDone(runId);
    const [args] = await calls(studio);
    expect(args.slice(0, 5)).toEqual(["run", "--draft", "--yes", "--run-id", runId]);
    expect(args).toEqual(expect.arrayContaining(["--topic", "foxes at night", "--scenes", "3", "--budget", "2", "--pin-modes", "2"]));
    expect((await (await run(request(`/api/runs/${runId}`), params({ id: runId }))).json()).state).toBe("draft");
  });

  it("validates the form and unknown kits or tracks", async () => {
    withKeys();
    const post = (json: unknown) => createDraft(request("/api/drafts", { json }), undefined);
    expect((await post({ budgetUsd: 3 })).status).toBe(400);
    expect(await error(await post({ topic: "x", budgetUsd: 3, brandKit: "ghost" }))).toMatchObject({ code: "validation", message: 'brandKit: no kit "ghost"' });
    expect(await error(await post({ topic: "x", budgetUsd: 3, music: "upload:ghost.mp3" }))).toMatchObject({ code: "validation" });
    expect(await calls(studio)).toEqual([]);
  });

  it("cannot be triggered from another site, or without JSON", async () => {
    withKeys();
    const cross = await createDraft(request("/api/drafts", { json: { topic: "x", budgetUsd: 3 }, headers: { "sec-fetch-site": "cross-site", origin: "https://evil.example" } }), undefined);
    expect(cross.status).toBe(403);
    const form = await createDraft(request("/api/drafts", { body: "topic=x", headers: { "content-type": "application/x-www-form-urlencoded" } }), undefined);
    expect(form.status).toBe(400);
    expect(await calls(studio)).toEqual([]);
  });
});

describe("pricing and paid actions", () => {
  it("plan asks the CLI's planner, also for a reroll or other modes", async () => {
    const id = nextRunId();
    await saveRun(studio, draftManifest(id));
    await stub(studio, "_plan.json", { items: [{ stage: "tts", scene: 1, costUsd: 0.02 }], totalUsd: 0.25 });
    await stub(studio, "_plan-modes.json", { items: [], totalUsd: 0.1 });
    expect(await (await plan(request(`/api/runs/${id}/plan`, { json: {} }), params({ id }))).json()).toMatchObject({ totalUsd: 0.25 });
    expect(await (await plan(request(`/api/runs/${id}/plan`, { json: { modes: [2, null, 2] } }), params({ id }))).json()).toMatchObject({ totalUsd: 0.1 });
    await plan(request(`/api/runs/${id}/plan`, { json: { reroll: { scene: 2, stage: "clips" } } }), params({ id }));
    expect(await calls(studio)).toEqual([
      ["plan", id, "--json"],
      ["plan", id, "--json", "--modes", "2,auto,2"],
      ["plan", id, "--json", "--reroll", "2:clips"],
    ]);
  });

  it("generate starts a resume capped at the approved amount — without --yes, so the CLI stops instead of overspending", async () => {
    const id = nextRunId();
    await saveRun(studio, draftManifest(id));
    await stub(studio, "_plan.json", { items: [], totalUsd: 0.25 });
    const res = await generate(request(`/api/runs/${id}/generate`, { json: { approvedUsd: 0.25 } }), params({ id }));
    expect(res.status).toBe(202);
    expect((await res.json()).job).toMatchObject({ kind: "generate", approvedUsd: 0.25 });
    await jobDone(id);
    const all = await calls(studio);
    expect(all.at(-1)).toEqual(["resume", id, "--budget", "0.25", "--cap", "0.25"]);
    expect(all.flat()).not.toContain("--yes");
  });

  it("refuses to start when the estimate rose above what was approved, and says the new figure", async () => {
    const id = nextRunId();
    await saveRun(studio, draftManifest(id));
    await stub(studio, "_plan.json", { items: [], totalUsd: 0.4 });
    const res = await generate(request(`/api/runs/${id}/generate`, { json: { approvedUsd: 0.25 } }), params({ id }));
    expect(res.status).toBe(409);
    expect(await error(res)).toMatchObject({ code: "estimate_changed", totalUsd: 0.4 });
    expect((await calls(studio)).some((c) => c[0] === "resume")).toBe(false);
    expect((await generate(request(`/api/runs/${id}/generate`, { json: {} }), params({ id }))).status).toBe(400);
  });

  it("compares the estimate with the approved amount exactly: a plan a fraction of a cent higher is refused", async () => {
    const id = nextRunId();
    await saveRun(studio, draftManifest(id));
    await stub(studio, "_plan.json", { items: [], totalUsd: 0.3 });
    const res = await generate(request(`/api/runs/${id}/generate`, { json: { approvedUsd: 0.2996 } }), params({ id }));
    expect(res.status).toBe(409);
    expect(await error(res)).toMatchObject({ code: "estimate_changed", totalUsd: 0.3 });
    expect((await calls(studio)).some((c) => c[0] === "resume")).toBe(false);
  });

  it("starts nothing when the CLI's plan has no usable total", async () => {
    const id = nextRunId();
    await saveRun(studio, finishedManifest(id));
    for (const plan of [{ items: [] }, { items: [], totalUsd: null }, { items: [], totalUsd: "0.1" }]) {
      await stub(studio, "_plan.json", plan);
      const res = await generate(request(`/api/runs/${id}/generate`, { json: { approvedUsd: 5 } }), params({ id }));
      expect(res.status).toBe(500);
      expect((await error(res)).code).toBe("internal");
      const again = await reroll(request(`/api/runs/${id}/reroll`, { json: { scene: 2, stage: "clips", approvedUsd: 5 } }), params({ id }));
      expect((await error(again)).code).toBe("internal");
    }
    expect((await calls(studio)).every((c) => c[0] === "plan")).toBe(true);
    expect(readJob(join(studio.runs, id))).toBeNull();
  });

  it("a run whose job the CLI ended with 'not confirmed' shows as needing approval", async () => {
    const id = nextRunId();
    await saveRun(studio, draftManifest(id));
    await stub(studio, "_plan.json", { items: [], totalUsd: 0.25 });
    await stub(studio, "_behave.json", { exitCode: 2 });
    await generate(request(`/api/runs/${id}/generate`, { json: { approvedUsd: 0.25 } }), params({ id }));
    await jobDone(id);
    expect((await (await run(request(`/api/runs/${id}`), params({ id }))).json()).state).toBe("needs_approval");
  });

  it("reroll prices that reroll, then starts it with the approved amount as its cap", async () => {
    const id = nextRunId();
    await saveRun(studio, finishedManifest(id));
    await stub(studio, "_plan-reroll.json", { items: [{ stage: "clips", scene: 2, costUsd: 0.03 }], totalUsd: 0.03 });
    const low = await reroll(request(`/api/runs/${id}/reroll`, { json: { scene: 2, stage: "clips", approvedUsd: 0.01 } }), params({ id }));
    expect(await error(low)).toMatchObject({ code: "estimate_changed", totalUsd: 0.03 });
    const ok = await reroll(request(`/api/runs/${id}/reroll`, { json: { scene: 2, stage: "clips", approvedUsd: 0.03 } }), params({ id }));
    expect(ok.status).toBe(202);
    await jobDone(id);
    expect((await calls(studio)).at(-1)).toEqual(["reroll", id, "--scene", "2", "--stage", "clips", "--budget", "0.03", "--cap", "0.03"]);
    expect((await reroll(request(`/api/runs/${id}/reroll`, { json: { scene: 2, stage: "fit", approvedUsd: 1 } }), params({ id }))).status).toBe(400);
  });

  it("rerender starts the free re-render with the look's flags", async () => {
    const id = nextRunId();
    await saveRun(studio, finishedManifest(id));
    const res = await rerender(request(`/api/runs/${id}/rerender`, { json: { look: { captionStyle: "minimalist", sfx: false } } }), params({ id }));
    expect(res.status).toBe(202);
    await jobDone(id);
    expect((await calls(studio)).at(-1)).toEqual(["rerender", id, "--caption-style", "minimalist", "--no-sfx"]);
    expect(await error(await rerender(request(`/api/runs/${id}/rerender`, { json: { look: { brandKit: "ghost" } } }), params({ id })))).toMatchObject({ code: "validation" });
  });

  it("look saves a look without rendering, on a draft too", async () => {
    const id = nextRunId();
    await saveRun(studio, draftManifest(id));
    const res = await look(request(`/api/runs/${id}/look`, { json: { look: { captionStyle: "mrbeast", hook: false } } }), params({ id }));
    expect(await res.json()).toEqual({ ok: true });
    expect(await calls(studio)).toEqual([["look", id, "--caption-style", "mrbeast", "--no-hook"]]);
    expect((await look(request(`/api/runs/${id}/look`, { json: { look: {} }, headers: { "sec-fetch-site": "cross-site" } }), params({ id }))).status).toBe(403);
  });

  it("modes can be pinned on a draft only", async () => {
    const draft = nextRunId();
    await saveRun(studio, draftManifest(draft));
    await stub(studio, "_plan.json", { items: [], totalUsd: 0.12 });
    const ok = await modes(request(`/api/runs/${draft}/modes`, { json: { modes: [2, null, 1] } }), params({ id: draft }));
    expect(await ok.json()).toMatchObject({ totalUsd: 0.12 });
    expect((await calls(studio))[0]).toEqual(["draft-modes", draft, "--modes", "2,auto,1", "--json"]);

    const done = nextRunId();
    await saveRun(studio, finishedManifest(done));
    const refused = await modes(request(`/api/runs/${done}/modes`, { json: { modes: [1, 1, 1] } }), params({ id: done }));
    expect(refused.status).toBe(409);
    expect((await error(refused)).code).toBe("not_draft");
  });

  it("one job per run across actions; stop ends it; every write is refused cross-site", async () => {
    const id = nextRunId();
    await saveRun(studio, finishedManifest(id));
    await stub(studio, "_behave.json", { sleepMs: 30_000 });
    await rerender(request(`/api/runs/${id}/rerender`, { json: {} }), params({ id }));
    const second = await rerender(request(`/api/runs/${id}/rerender`, { json: {} }), params({ id }));
    expect(second.status).toBe(409);
    expect((await error(second)).code).toBe("job_active");
    expect((await (await run(request(`/api/runs/${id}`), params({ id }))).json()).state).toBe("running");

    const cross = { "sec-fetch-site": "cross-site" };
    for (const res of [
      await stop(request(`/api/runs/${id}/job`, { method: "DELETE", headers: cross }), params({ id })),
      await generate(request(`/api/runs/${id}/generate`, { json: { approvedUsd: 9 }, headers: cross }), params({ id })),
      await reroll(request(`/api/runs/${id}/reroll`, { json: { scene: 1, stage: "tts", approvedUsd: 9 }, headers: cross }), params({ id })),
      await rerender(request(`/api/runs/${id}/rerender`, { json: {}, headers: cross }), params({ id })),
      await modes(request(`/api/runs/${id}/modes`, { json: { modes: [1, 1, 1] }, headers: cross }), params({ id })),
      await unlock(request(`/api/runs/${id}/unlock`, { method: "POST", headers: cross }), params({ id })),
    ]) {
      expect(res.status).toBe(403);
    }

    const stopped = await stop(request(`/api/runs/${id}/job`, { method: "DELETE" }), params({ id }));
    expect((await stopped.json()).job.stoppedAt).toBeDefined();
    await until(() => readJob(join(studio.runs, id))?.state === "stopped");
    expect((await stop(request(`/api/runs/${id}/job`, { method: "DELETE" }), params({ id }))).status).toBe(404);
  });
});

describe("every route", () => {
  /** The POSTs that only read (a preview's props, a price): the one place a handler other than GET may be `write: false`. */
  const READ_POSTS = ["runs/[id]/props/route.ts", "runs/[id]/plan/route.ts"];
  const api = resolve("web/app/api");

  it("that is not a GET demands the studio's own origin, except the two POSTs that only read", async () => {
    const files = (await readdir(api, { recursive: true })).filter((f) => f.endsWith("route.ts")).map((f) => f.split("\\").join("/")).sort();
    expect(files.length).toBeGreaterThanOrEqual(18);
    for (const read of READ_POSTS) expect(files).toContain(read);
    let checked = 0;
    for (const file of files) {
      const mod = (await import(/* @vite-ignore */ join(api, file))) as Record<string, unknown>;
      for (const [name, handler] of Object.entries(mod)) {
        if (typeof handler !== "function") continue;
        const where = `${name} ${relative(api, join(api, file))}`;
        const write = (handler as { write?: boolean }).write;
        expect(write, `${where} is not wrapped by route()`).toBeTypeOf("boolean");
        if (name === "GET") continue;
        expect(write, where).toBe(!READ_POSTS.includes(file));
        checked++;
      }
    }
    expect(checked).toBeGreaterThanOrEqual(11);
  });
});
