import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { GET as health } from "@/app/api/health/route";
import { POST as generate } from "@/app/api/runs/[id]/generate/route";
import { POST as rerender } from "@/app/api/runs/[id]/rerender/route";
import { POST as reroll } from "@/app/api/runs/[id]/reroll/route";
import { NewVideoForm } from "@/components/NewVideoForm";
import { namesInternals, SELF_NAMES } from "@/lib/engines";
import { STAGE_LABELS } from "@/lib/labels";
import { readJob, type StudioHealth } from "@/server/jobs";
import { draftArgs, NewVideo } from "@/server/schemas";
import { calls, draftManifest, finishedManifest, nextRunId, params, request, saveRun, stub, until, useStudio } from "./helpers";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => {}, refresh: () => {} }) }));

/* Phase 14 spec §6: the studio offers scene sound where it is set up, says what it is, and holds credit that covers it. */
const studio = useStudio();
const sound = async (env: string) => {
  await writeFile(join(studio.root, ".env"), env);
  return JSON.parse(await (await health(request("/api/health"), undefined)).text()).sound;
};

describe("the health answer's scene sound", () => {
  it("is offered only when its endpoint is set AND the owner switched it on, and is absent otherwise", async () => {
    expect(await sound("RUNPOD_FOLEY_ENDPOINT=secret-f\n")).toBeUndefined();
    expect(await sound("FLOWCHAIN_SCENE_SOUND=on\n")).toBeUndefined();
    expect(await sound("RUNPOD_FOLEY_ENDPOINT=secret-f\nFLOWCHAIN_SCENE_SOUND=off\n")).toBeUndefined();
    expect(await sound("RUNPOD_FOLEY_ENDPOINT=secret-f\nFLOWCHAIN_SCENE_SOUND=on\n")).toBe(true);
  });

  it("never says where the sound is made", async () => {
    await writeFile(join(studio.root, ".env"), "RUNPOD_FOLEY_ENDPOINT=secret-f\nFLOWCHAIN_SCENE_SOUND=on\n");
    expect(await (await health(request("/api/health"), undefined)).text()).not.toContain("secret");
  });
});

describe("the new-video form's sound effects", () => {
  const form = (h: Partial<StudioHealth>) =>
    renderToStaticMarkup(createElement(NewVideoForm, { health: { missing: [], queue: { mode: "local" }, ...h }, kits: [], tracks: [], presets: [] }));

  it("are a switch and a level only where scene sound is offered, with a note that it is made for each scene and adds to the price", () => {
    const on = form({ sound: true });
    expect(on).toContain('aria-label="Sound effects"');
    expect(on).toContain('data-testid="sound-note"');
    expect(on).toMatch(/made for each scene/);
    expect(on).toMatch(/adds to the price/);
    const off = form({});
    expect(off).not.toContain('aria-label="Sound effects"');
    expect(off).not.toContain('data-testid="sound-note"');
  });

  it("are told of without a model's, a provider's or the studio's own part's name", () => {
    const note = /data-testid="sound-note"[^>]*>([^<]*)</.exec(form({ sound: true }))![1];
    expect(namesInternals(note)).toBe(false);
    expect(SELF_NAMES.some((n) => n.test(note))).toBe(false);
    // (and no place the licence leaves out is named on the form)
    expect(note).not.toMatch(/\b(EU|European|UK|United Kingdom|Korea)\b/);
  });

  it("change a draft's command only by --no-sfx when switched off, as before", () => {
    const run = "20261006-120000-abc001";
    const on = draftArgs(NewVideo.parse({ topic: "t" }), run);
    const off = draftArgs(NewVideo.parse({ topic: "t", sfx: false }), run);
    expect(off.filter((a) => !on.includes(a))).toEqual(["--no-sfx"]);
    expect(on.filter((a) => !off.includes(a))).toEqual([]);
  });
});

describe("what the studio calls the sound step", () => {
  it("is a word of its own, naming no model or provider", () => {
    expect(STAGE_LABELS.sound).toBe("Sound effects");
    expect(namesInternals(STAGE_LABELS.sound)).toBe(false);
  });

  it("never lets the sound model's name through to a customer", () => {
    for (const text of ["HunyuanVideo-Foley", "runpod:ep/sound-foley@1", "hunyuan-foley@1"]) expect(namesInternals(text), text).toBe(true);
  });
});

describe("the credit a video with scene sound holds", () => {
  const SOUND_PLAN = {
    items: [
      { stage: "clips", scene: 1, costUsd: 0.2 },
      { stage: "sound", scene: 1, costUsd: 0.0318 },
      { stage: "sound", scene: 2, costUsd: 0.0048 },
      { stage: "sound", scene: 3, costUsd: 0.0048 },
      { stage: "render", scene: null, costUsd: 0 },
    ],
    totalUsd: 0.2414,
  };
  const draft = async () => {
    const id = nextRunId();
    const m = draftManifest(id);
    m.request.sceneSound = true;
    await saveRun(studio, m);
    await stub(studio, "_plan.json", SOUND_PLAN);
    return id;
  };

  it("is the plan's whole figure, the sound in it, when a draft is generated", async () => {
    const id = await draft();
    expect((await generate(request(`/api/runs/${id}/generate`, { json: { approvedUsd: 0.2414 } }), params({ id }))).status).toBe(202);
    await until(() => readJob(join(studio.runs, id))?.state === "ended");
    expect((await calls(studio)).at(-1)).toEqual(["resume", id, "--budget", "0.2414", "--cap", "0.2414"]);
  });

  it("is refused when what was approved leaves the sound out, before anything starts", async () => {
    const id = await draft();
    const res = await generate(request(`/api/runs/${id}/generate`, { json: { approvedUsd: 0.2 } }), params({ id }));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatchObject({ code: "estimate_changed", totalUsd: 0.2414 });
    expect((await calls(studio)).filter((c) => c[0] !== "plan")).toEqual([]);
  });

  it("is the plan's figure for one scene's new sound", async () => {
    const id = nextRunId();
    const m = finishedManifest(id);
    m.request.sceneSound = true;
    await saveRun(studio, m);
    await stub(studio, "_plan-reroll.json", { items: [{ stage: "sound", scene: 2, costUsd: 0.0048 }, { stage: "render", scene: null, costUsd: 0 }], totalUsd: 0.0048 });
    const res = await reroll(request(`/api/runs/${id}/reroll`, { json: { scene: 2, stage: "sound", approvedUsd: 0.0048 } }), params({ id }));
    expect(res.status).toBe(202);
    await until(() => readJob(join(studio.runs, id))?.state === "ended");
    const all = await calls(studio);
    expect(all.find((c) => c[0] === "plan" && c[1] === id)).toEqual(["plan", id, "--json", "--reroll", "2:sound"]);
    expect(all.at(-1)).toEqual(["reroll", id, "--scene", "2", "--stage", "sound", "--budget", "0.0048", "--cap", "0.0048"]);
  });
});

describe("re-rendering a finished video with sound effects turned on", () => {
  const finished = async (made: boolean) => {
    const id = nextRunId();
    const m = finishedManifest(id);
    m.request.sceneSound = true;
    m.request.render.sfx = false;
    if (made) for (const s of m.scenes) s.stages.sound = { status: "done", inputHash: "h", costUsd: 0.01, finishedAt: "t" };
    await saveRun(studio, m);
    return id;
  };
  const turnOn = (id: string) => rerender(request(`/api/runs/${id}/rerender`, { json: { look: { sfx: true } } }), params({ id }));

  it("says in plain words that its sound was never made, and starts nothing", async () => {
    const id = await finished(false);
    const res = await turnOn(id);
    expect(res.status).toBe(400);
    const { message } = (await res.json()).error;
    expect(message).toMatch(/sound effects were off when this video was made/i);
    expect(message).not.toMatch(/resume|stage|--/);
    expect(await calls(studio)).toEqual([]);
  });

  it("goes ahead when its sound was made and only switched off", async () => {
    const id = await finished(true);
    expect((await turnOn(id)).status).toBe(202);
  });
});
