import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { GET as health } from "@/app/api/health/route";
import { POST as createDraft } from "@/app/api/drafts/route";
import { NewVideoForm, speechShown, speechToSend } from "@/components/NewVideoForm";
import { namesInternals, SELF_NAMES } from "@/lib/engines";
import { SPEECH_SWITCH } from "@/lib/labels";
import { readJob, type StudioHealth } from "@/server/jobs";
import { refusal } from "@/server/jobs/redis";
import { draftArgs, NewVideo, Recipe } from "@/server/schemas";
import { calls, draftManifest, request, stub, until, useStudio, withKeys } from "./helpers";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => {}, refresh: () => {} }) }));

/* Phase 15 spec §5, §7, §13.7: the studio offers a speaking character only while its clips are made with sound and the owner switched speech on. */
const studio = useStudio();
const answer = async (env: string) => {
  await writeFile(join(studio.root, ".env"), env);
  return JSON.parse(await (await health(request("/api/health"), undefined)).text()) as StudioHealth;
};
/** The clip endpoint that makes sound, switched on by the owner (phase 15 spec §13.8: the endpoint alone is not enough). */
const LTX = "RUNPOD_LTX_ENDPOINT=secret-l\nFLOWCHAIN_LTX=on\n";
const LTX_UNSWITCHED = "RUNPOD_LTX_ENDPOINT=secret-l\n";

describe("the health answer's speaking character", () => {
  it("is offered only when the clip endpoint that makes sound is set AND the owner switched speech on, and is absent otherwise", async () => {
    expect((await answer("")).speech).toBeUndefined();
    expect((await answer(LTX)).speech).toBeUndefined();
    expect((await answer("FLOWCHAIN_SPEECH=on\n")).speech).toBeUndefined();
    expect((await answer(`${LTX}FLOWCHAIN_SPEECH=off\n`)).speech).toBeUndefined();
    expect((await answer(`${LTX}FLOWCHAIN_SPEECH=on\n`)).speech).toBe(true);
  });

  it("never says where the clips are made", async () => {
    expect(JSON.stringify(await answer(`${LTX}FLOWCHAIN_SPEECH=on\n`))).not.toContain("secret");
  });
});

describe("the health answer's sound effects, with clips that carry their own sound", () => {
  it("are offered with the clip endpoint that makes sound switched on, and only then: the removed scene-sound worker's switch offers nothing", async () => {
    expect((await answer(LTX)).sound).toBe(true);
    expect((await answer(`${LTX}RUNPOD_FOLEY_ENDPOINT=f\nFLOWCHAIN_SCENE_SOUND=on\n`)).sound).toBe(true);
    expect((await answer(LTX_UNSWITCHED)).sound).toBeUndefined();
    expect((await answer("RUNPOD_FOLEY_ENDPOINT=f\nFLOWCHAIN_SCENE_SOUND=on\n")).sound).toBeUndefined();
    expect((await answer("")).sound).toBeUndefined();
  });
});

describe("the health answer's smooth motion, now that Wan is gone", () => {
  it("is never offered, with the clip engine or without it, even with the restorer switched on: it was measured on Wan's clips only", async () => {
    for (const env of ["", LTX, LTX_UNSWITCHED]) {
      expect((await answer(`${env}RUNPOD_UPSCALE_ENDPOINT=u\nFLOWCHAIN_SMOOTH_MOTION=on\n`)).smooth, env).toBeUndefined();
    }
  });
});

describe("the health answer while the owner has not switched the clip endpoint that makes sound on", () => {
  it("offers a studio of pictures only: no clips, no speech, no clip sound, no smooth motion, and nothing missing for it", async () => {
    for (const off of [LTX_UNSWITCHED, `${LTX_UNSWITCHED}FLOWCHAIN_LTX=off\n`, "", "RUNPOD_CLIP_ENDPOINT=c\n"]) {
      const h = await answer(`${off}FLOWCHAIN_SPEECH=on\nRUNPOD_UPSCALE_ENDPOINT=u\nFLOWCHAIN_SMOOTH_MOTION=on\n`);
      expect(h.clips, off).toBeUndefined();
      expect(h.speech).toBeUndefined();
      expect(h.sound).toBeUndefined();
      expect(h.smooth).toBeUndefined();
      expect(h.missing).not.toContain("RUNPOD_CLIP_ENDPOINT");
      expect(h.missing).not.toContain("RUNPOD_LTX_ENDPOINT");
    }
  });

  it("offers moving clips once it is switched on, without saying where they are made", async () => {
    const h = await answer(LTX);
    expect(h.clips).toBe(true);
    expect(JSON.stringify(h)).not.toContain("secret");
  });
});

describe("the health answer's missing settings", () => {
  it("never asks for Wan's clip endpoint, with the clip engine or without it, and still asks for everything else a run needs", async () => {
    for (const env of [LTX, ""]) {
      expect((await answer(env)).missing).not.toContain("RUNPOD_CLIP_ENDPOINT");
      expect((await answer(env)).missing).toContain("RUNPOD_KEYFRAME_ENDPOINT");
    }
  });
});

describe("the new-video form's choice of what a video is made of", () => {
  const form = (h: Partial<StudioHealth>) =>
    renderToStaticMarkup(createElement(NewVideoForm, { health: { missing: [], queue: { mode: "local" }, ...h }, kits: [], tracks: [], presets: [] }));

  it("offers pictures only, and says why, where no clip engine is set up", () => {
    const page = form({});
    expect(page).toContain("Pictures only");
    expect(page).not.toContain("Pictures and clips");
    expect(page).not.toContain("Clips only");
    expect(page).toContain("Moving clips are not available in this studio right now.");
  });

  it("offers clips where it is, and no clip size but full HD where that is offered", () => {
    const page = form({ clips: true });
    expect(page).toContain("Pictures and clips");
    expect(page).toContain("Clips only");
    expect(page).not.toMatch(/720p|HD \(720p\)/);
    expect(page).not.toContain('aria-label="Clip quality"');
    expect(form({ clips: true, fullHd: true })).toContain("Full HD (1080p)");
  });
});

describe("the new-video form's speaking character", () => {
  const form = (h: Partial<StudioHealth>, series = false) =>
    renderToStaticMarkup(createElement(NewVideoForm, { health: { missing: [], queue: { mode: "local" }, ...h }, kits: [], tracks: [], presets: [], series }));

  it("is a switch, off by default, with a line saying the voice can differ, only where speech is offered", () => {
    const on = form({ speech: true, sound: true });
    expect(on).toContain(`aria-label="${SPEECH_SWITCH.label}"`);
    expect(on).toContain(SPEECH_SWITCH.label);
    expect(on).toContain('data-testid="speech-note"');
    expect(on).toContain(SPEECH_SWITCH.help.replace("'", "&#x27;"));
    const input = /<input[^>]*aria-label="Let a character speak"[^>]*>/.exec(on)![0];
    expect(input).not.toMatch(/checked/);
    for (const off of [form({}), form({ sound: true }), form({}, true)]) {
      expect(off).not.toContain(SPEECH_SWITCH.label);
      expect(off).not.toContain('data-testid="speech-note"');
    }
    expect(form({ speech: true }, true)).toContain(SPEECH_SWITCH.label);
  });

  it("is told of in the studio's own words, naming no model, provider or part of the studio", () => {
    expect(SPEECH_SWITCH.label).toBe("Let a character speak");
    expect(SPEECH_SWITCH.help).toBe("The character's voice can differ between scenes.");
    const page = form({ speech: true, sound: true, smooth: true, fullHd: true });
    for (const words of [SPEECH_SWITCH.label, SPEECH_SWITCH.help]) {
      expect(namesInternals(words)).toBe(false);
      expect(SELF_NAMES.some((n) => n.test(words))).toBe(false);
    }
    expect(page).not.toMatch(/ltx|lightricks/i);
  });
});

describe("the speech a form sends, for a draft or a series' recipe", () => {
  it("is off wherever speech is not offered, whatever the hidden switch holds, and the switch's value where it is", () => {
    expect(speechToSend({}, true, "en")).toBe(false);
    expect(speechToSend({}, false, "en")).toBe(false);
    expect(speechToSend({ speech: true }, true, "en")).toBe(true);
    expect(speechToSend({ speech: true }, true, "tr")).toBe(true);
    expect(speechToSend({ speech: true }, false, "en")).toBe(false);
  });

  it("is off in a language speech was not measured in, whatever the hidden switch holds", () => {
    for (const language of ["ja", "de", "ar"] as const) expect(speechToSend({ speech: true }, true, language)).toBe(false);
  });
});

describe("the new-video form's speaking character, by the video's language", () => {
  it("is not shown for a language speech was not measured in, though the studio offers speech", () => {
    // (the form starts in English and a change of language happens in the browser: this is the check it renders by)
    expect(speechShown({ speech: true }, "en")).toBe(true);
    expect(speechShown({ speech: true }, "tr")).toBe(true);
    expect(speechShown({ speech: true }, "ja")).toBe(false);
    expect(speechShown({}, "en")).toBe(false);
  });
});

describe("a draft's command for speech", () => {
  const run = "20261006-120000-abc001";
  const args = (json: object, soundOffered: boolean, speechOffered: boolean) => draftArgs(NewVideo.parse({ topic: "t", ...json }), run, soundOffered, speechOffered);

  it("is --speech only where speech is offered and the customer turned it on, and --no-speech in every other case", () => {
    expect(args({ speech: true }, true, true)).toContain("--speech");
    expect(args({ speech: true }, true, true)).not.toContain("--no-speech");
    for (const [json, offered] of [[{ speech: false }, true], [{}, true], [{ speech: true }, false], [{}, false]] as const) {
      const a = args(json, true, offered);
      expect(a).toContain("--no-speech");
      expect(a).not.toContain("--speech");
    }
  });

  it("is a choice the form makes, off by default, and a series' recipe saved before it means no speech", () => {
    expect(NewVideo.parse({ topic: "t" }).speech).toBe(false);
    expect(Recipe.parse({}).speech).toBe(false);
    expect(draftArgs({ ...Recipe.parse({}), topic: "t" }, run, true, true)).toContain("--no-speech");
  });

  it("asks for no sound effects only when neither sound source is offered", () => {
    expect(args({}, true, false)).not.toContain("--no-sfx");
    expect(args({}, false, false)).toContain("--no-sfx");
  });

  it("is --no-speech for a video in a language speech was not measured in, even where it is offered and asked for", () => {
    expect(args({ speech: true, language: "ja" }, true, true)).toContain("--no-speech");
    expect(args({ speech: true, language: "tr" }, true, true)).toContain("--speech");
  });

  it("is accepted by the worker either way, once, and never both together", () => {
    const base = ["run", "--draft", "--yes", "--run-id", run, "--topic", "t"];
    expect(refusal("runs", args({ speech: true }, true, true))).toBeUndefined();
    expect(refusal("runs", args({}, true, false))).toBeUndefined();
    expect(refusal("runs", [...base, "--speech", "--speech"])).toBe("a draft may not repeat --speech");
    expect(refusal("runs", [...base, "--speech", "--no-speech"])).toMatch(/speech/);
  });
});

describe("a new draft's speech", () => {
  const draftCommand = async (env: string, json: object) => {
    withKeys();
    await writeFile(join(studio.root, ".env"), env);
    await stub(studio, "_draft-manifest.json", draftManifest("placeholder"));
    const res = await createDraft(request("/api/drafts", { json: { topic: "foxes", ...json } }), undefined);
    expect(res.status).toBe(202);
    const { runId } = await res.json();
    await until(() => readJob(join(studio.runs, runId))?.state === "ended");
    return (await calls(studio)).at(-1)!;
  };

  it("is asked for only while the studio offers it and the customer turned it on", async () => {
    const offered = `${LTX}FLOWCHAIN_SPEECH=on\n`;
    expect(await draftCommand(offered, { speech: true })).toContain("--speech");
    expect(await draftCommand(offered, {})).toContain("--no-speech");
    // (and the clip's own sound is heard: the draft does not turn sound effects off)
    expect(await draftCommand(LTX, {})).not.toContain("--no-sfx");
  });

  it("is refused in plain words while it is not offered, before anything is started", async () => {
    withKeys();
    await writeFile(join(studio.root, ".env"), LTX);
    const res = await createDraft(request("/api/drafts", { json: { topic: "foxes", speech: true } }), undefined);
    expect(res.status).toBe(400);
    const { error } = await res.json();
    expect(error.code).toBe("validation");
    expect(error.message).toMatch(/^speech: /);
    expect(namesInternals(error.message)).toBe(false);
    expect(await calls(studio)).toEqual([]);
  });
});

describe("a new draft that asks for speech in a language it was not measured in", () => {
  it("is refused in plain words, before anything is started", async () => {
    withKeys();
    await writeFile(join(studio.root, ".env"), `${LTX}FLOWCHAIN_SPEECH=on\n`);
    const res = await createDraft(request("/api/drafts", { json: { topic: "foxes", speech: true, language: "de" } }), undefined);
    expect(res.status).toBe(400);
    const { error } = await res.json();
    expect(error).toMatchObject({ code: "validation", message: "speech: a character can speak only in a video in English or Turkish" });
    expect(await calls(studio)).toEqual([]);
  });
});

describe("a draft that asks for smooth motion while clips are made at 24 frames a second", () => {
  it("is refused as smooth motion is wherever it is not offered, before anything is started", async () => {
    withKeys();
    await writeFile(join(studio.root, ".env"), `${LTX}RUNPOD_UPSCALE_ENDPOINT=u\nFLOWCHAIN_SMOOTH_MOTION=on\n`);
    const res = await createDraft(request("/api/drafts", { json: { topic: "foxes", fps: 60 } }), undefined);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatchObject({ code: "validation", message: "fps: smooth motion is not available in this studio yet" });
    expect(await calls(studio)).toEqual([]);
  });
});
