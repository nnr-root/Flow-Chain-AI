import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { GET as health } from "@/app/api/health/route";
import { POST as createDraft } from "@/app/api/drafts/route";
import { POST as rerender } from "@/app/api/runs/[id]/rerender/route";
import { NewVideoForm, sfxToSend } from "@/components/NewVideoForm";
import { namesInternals, SELF_NAMES } from "@/lib/engines";
import { STAGE_LABELS } from "@/lib/labels";
import { readJob, type StudioHealth } from "@/server/jobs";
import { refusal } from "@/server/jobs/redis";
import { draftArgs, NewVideo } from "@/server/schemas";
import { calls, draftManifest, finishedManifest, nextRunId, params, request, saveRun, stub, until, useStudio, withKeys } from "./helpers";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => {}, refresh: () => {} }) }));

/*
 * Phase 14 spec §6, phase 15 spec §6 and §13.12: a scene's sound is its own clip's, so the studio offers sound effects
 * exactly where its clips are made with sound, and says they cost nothing more. (The scene-sound worker that once bought a
 * sound for each scene was removed: its switch and its endpoint offer nothing now.)
 */
const studio = useStudio();
const sound = async (env: string) => {
  await writeFile(join(studio.root, ".env"), env);
  return JSON.parse(await (await health(request("/api/health"), undefined)).text()).sound;
};

describe("the health answer's scene sound", () => {
  const LTX = "RUNPOD_LTX_ENDPOINT=secret-l\nFLOWCHAIN_LTX=on\n";
  // (the clip engine's endpoint and switch are read from the studio's .env here, not from what other tests left behind)
  const fresh = () => {
    delete process.env.FLOWCHAIN_LTX;
    delete process.env.RUNPOD_LTX_ENDPOINT;
  };

  it("is offered exactly when the clip engine, whose clips carry their own sound, is set up and switched on", async () => {
    fresh();
    expect(await sound(LTX)).toBe(true);
    expect(await sound("RUNPOD_LTX_ENDPOINT=secret-l\n")).toBeUndefined();
    expect(await sound("FLOWCHAIN_LTX=on\n")).toBeUndefined();
    expect(await sound("")).toBeUndefined();
  });

  it("is not offered by the removed scene-sound worker's endpoint and switch, with the clip engine or without it", async () => {
    fresh();
    expect(await sound("RUNPOD_FOLEY_ENDPOINT=secret-f\nFLOWCHAIN_SCENE_SOUND=on\n")).toBeUndefined();
    expect(await sound(`RUNPOD_LTX_ENDPOINT=secret-l\nRUNPOD_FOLEY_ENDPOINT=secret-f\nFLOWCHAIN_SCENE_SOUND=on\n`)).toBeUndefined();
    expect(await sound(`${LTX}RUNPOD_FOLEY_ENDPOINT=secret-f\nFLOWCHAIN_SCENE_SOUND=off\n`)).toBe(true);
  });

  it("never says where the sound is made", async () => {
    fresh();
    await writeFile(join(studio.root, ".env"), `${LTX}RUNPOD_FOLEY_ENDPOINT=secret-f\nFLOWCHAIN_SCENE_SOUND=on\n`);
    expect(await (await health(request("/api/health"), undefined)).text()).not.toContain("secret");
  });
});

describe("the new-video form's sound effects", () => {
  const form = (h: Partial<StudioHealth>) =>
    renderToStaticMarkup(createElement(NewVideoForm, { health: { missing: [], queue: { mode: "local" }, ...h }, kits: [], tracks: [], presets: [] }));

  const note = (h: Partial<StudioHealth>) => /data-testid="sound-note"[^>]*>([^<]*)</.exec(form(h))![1];

  it("are a switch and a level only where scene sound is offered, with a note that each scene keeps its own clip's sound and that it costs nothing more", () => {
    const on = form({ sound: true });
    expect(on).toContain('aria-label="Sound effects"');
    expect(on).toContain('data-testid="sound-note"');
    expect(note({ sound: true })).toMatch(/its own clip/);
    expect(note({ sound: true })).toMatch(/costs nothing more/);
    // (the sound is free: neither note, the switch on or off, says it adds to the price, nor that the price is lower without it)
    expect(on).not.toMatch(/adds to the price|price is lower|made for each scene/);
    expect(readFileSync(join(import.meta.dirname, "../components/NewVideoForm.tsx"), "utf8")).not.toMatch(/adds to the price|price is lower/);
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
    const on = draftArgs(NewVideo.parse({ topic: "t" }), run, true);
    const off = draftArgs(NewVideo.parse({ topic: "t", sfx: false }), run, true);
    expect(on).not.toContain("--no-sfx");
    expect(off.filter((a) => !on.includes(a))).toEqual(["--no-sfx"]);
    expect(on.filter((a) => !off.includes(a))).toEqual([]);
  });

  it("are never asked for by a draft where the studio does not offer them, whatever the form sent", () => {
    // (the worker decides by its own switch too: a customer who was shown no switch must not be sold sound by it)
    const run = "20261006-120000-abc001";
    const offered = draftArgs(NewVideo.parse({ topic: "t", sfx: true }), run, true);
    const notOffered = draftArgs(NewVideo.parse({ topic: "t", sfx: true }), run, false);
    expect(notOffered.filter((a) => !offered.includes(a))).toEqual(["--no-sfx"]);
    expect(offered.filter((a) => !notOffered.includes(a))).toEqual([]);
    expect(draftArgs(NewVideo.parse({ topic: "t", sfx: false }), run, false).filter((a) => a === "--no-sfx")).toHaveLength(1);
    expect(refusal("runs", notOffered)).toBeUndefined();
  });
});

describe("the sound effects a form sends, for a draft or a series' recipe", () => {
  it("are off wherever scene sound is not offered, whatever the hidden switch holds, and the switch's value where it is", () => {
    expect(sfxToSend({}, true)).toBe(false);
    expect(sfxToSend({}, false)).toBe(false);
    expect(sfxToSend({ sound: true }, true)).toBe(true);
    expect(sfxToSend({ sound: true }, false)).toBe(false);
  });
});

describe("a new draft's scene sound", () => {
  // the studio's own health answer is the one gate: here (no queue) it is read from the studio's .env
  const draftCommand = async (env: string, json: object) => {
    withKeys();
    // (the clip engine's switch from the studio's .env alone: it is what offers sound)
    delete process.env.FLOWCHAIN_LTX;
    await writeFile(join(studio.root, ".env"), env);
    await stub(studio, "_draft-manifest.json", draftManifest("placeholder"));
    const res = await createDraft(request("/api/drafts", { json: { topic: "foxes", motion: "stills", ...json } }), undefined);
    expect(res.status).toBe(202);
    const { runId } = await res.json();
    await until(() => readJob(join(studio.runs, runId))?.state === "ended");
    return (await calls(studio)).at(-1)!;
  };

  it("is asked for only while the studio offers it, and never when the customer turned it off", async () => {
    expect(await draftCommand("FLOWCHAIN_LTX=on\n", {})).not.toContain("--no-sfx");
    expect(await draftCommand("FLOWCHAIN_LTX=on\n", { sfx: false })).toContain("--no-sfx");
    // (the removed scene-sound worker's switch offers nothing)
    expect(await draftCommand("RUNPOD_FOLEY_ENDPOINT=f\nFLOWCHAIN_SCENE_SOUND=on\n", { sfx: true })).toContain("--no-sfx");
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

// (an old run made with scene sound, whose sounds were bought before the worker that made them was removed)
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
