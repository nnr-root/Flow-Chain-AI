import { describe, expect, it } from "vitest";
import { anachronisms, isMoving } from "../../src/anachronism.js";
import { AUDIENCE, cultureRules } from "../../src/culture.js";
import { EDIT_IDS, EDITS, editById } from "../../src/edits.js";
import { FORMAT_IDS, FORMATS, formatById, formatClash } from "../../src/formats.js";
import { RunRequest } from "../../src/manifest/schema.js";
import { createManifest } from "../../src/manifest/store.js";
import { wordsToCaptions } from "../../src/media/remotion/caption-pages.js";
import { RenderProps } from "../../src/media/remotion/props.js";
import { finishFilter, grainOffset, kenBurnsTransform } from "../../src/media/remotion/timeline.js";
import { FACT_RULES, NICHES, nicheById } from "../../src/niches.js";
import { PRESETS } from "../../src/presets.js";
import { buildScriptPrompt } from "../../src/providers/gemini.js";
import { buildRenderProps } from "../../src/stages/build-render-props.js";
import { globalWords } from "../../src/stages/captions.js";
import { transitionInto } from "../../src/stages/look.js";
import { imagePrompt, motionPrompt } from "../../src/stages/visual.js";
import { SPEECH_LANGUAGE_CODES } from "../../src/voice/language.js";
import { fakeScript } from "../fakes/providers.js";

// Phase 8 spec: the layers a video is built from (§1), its type (§2), its edit (§3) and its audience (§5).

const base = { topic: "The war that lasted 38 minutes", aspect: "9:16", sceneCount: 4, voiceId: "narrator-m" } as const;

describe("the types of video", () => {
  it("are each told whole: a name, what they are, how they open, their shape, their delivery", () => {
    expect(new Set(FORMAT_IDS).size).toBe(FORMATS.length);
    for (const f of FORMATS) {
      expect(f.id, f.id).toMatch(/^[a-z]+(-[a-z]+)*$/);
      expect(f.label.trim().length, f.id).toBeGreaterThan(2);
      for (const field of [f.about, f.hook, f.arc, f.delivery]) expect(field.trim().length, f.id).toBeGreaterThan(5);
    }
  });

  it("hold every type that tells what is so to the truth, and keep it from telling a made-up story", () => {
    for (const f of FORMATS.filter((t) => t.goesWith === "fact")) for (const rule of FACT_RULES) expect(f.rules, f.id).toContain(rule);
    expect(formatClash("documentary", "fiction")).toMatch(/tells what is so/);
    expect(formatClash("myth-busting", "fiction")).toMatch(/tells what is so/);
    // a story may be told as a story, a list or a "you are there", and a type that tells what is so goes with any true niche
    for (const ok of ["story", "countdown", "pov"]) expect(formatClash(ok, "fiction"), ok).toBeNull();
    expect(formatClash("documentary", "fact")).toBeNull();
    expect(formatClash("documentary", undefined)).toBeNull();
    expect(formatClash(undefined, "fiction")).toBeNull();
  });

  it("decides how a video in a niche is told, while the niche keeps its subject, its voice and its rules", () => {
    const h = nicheById("history")!;
    const c = formatById("countdown")!;
    const p = buildScriptPrompt({ ...base, niche: "history", format: "countdown" });
    for (const part of [c.hook, c.arc, c.delivery, ...c.rules, h.promise, h.voice, ...h.rules]) expect(p).toContain(part);
    // the type's hook and shape in place of the niche's
    expect(p).not.toContain(h.hook);
    expect(p).not.toContain(h.arc);
    expect(p).toContain("the video type decides the first line, the shape and the delivery; the niche decides the subject and the tone, and its rules always hold");
    // a rule the niche already says is said once
    const doc = buildScriptPrompt({ ...base, niche: "history", format: "documentary" });
    expect(doc.split(FACT_RULES[0]).length - 1).toBe(1);
    // a type alone is told as such, and a video without one is asked for as before
    expect(buildScriptPrompt({ ...base, format: "explainer" })).toContain("Video type: Explainer.");
    expect(buildScriptPrompt({ ...base, niche: "history" })).toContain(h.hook);
    expect(buildScriptPrompt(base)).not.toMatch(/Video type:|Edit:|Audience:/);
  });

  it("opens a long video the type's way and carries its delivery through every part", () => {
    const timing = { targetSec: 180, sceneSec: { min: 3, max: 5 } };
    const outline = { title: "t", stylePreset: "cinematic_history" as const, styleBible: { artStyle: "a", characters: "c", palette: "p" }, hook: "h", parts: [{ summary: "a" }, { summary: "b" }, { summary: "c" }] };
    const ask = (index: number) => ({ kind: "part" as const, index, partSec: [60, 60, 60], outline, previous: [] });
    const v = formatById("versus")!;
    const plan = buildScriptPrompt({ ...base, timing, format: "versus", ask: { kind: "outline", partSec: [60, 60, 60] } });
    expect(plan).toContain(v.hook);
    expect(plan).toContain(v.arc);
    const middle = buildScriptPrompt({ ...base, timing, format: "versus", ask: ask(1) });
    expect(middle).not.toContain(v.hook);
    expect(middle).toContain(v.delivery);
  });

  it("is one the studio knows, kept with the run", () => {
    const run = { topic: "t", aspect: "9:16", sceneCount: 2, modes: [1, 1], voiceId: "narrator-m" };
    expect(RunRequest.parse({ ...run, format: "pov", edit: "calm", localize: false })).toMatchObject({ format: "pov", edit: "calm", localize: false });
    for (const bad of [{ format: "vlog" }, { edit: "shaky" }, { localize: "yes" }]) expect(RunRequest.safeParse({ ...run, ...bad }).success, JSON.stringify(bad)).toBe(false);
  });
});

describe("the edits", () => {
  // what a style says and an edit never does: a medium, a colour, a thing in the frame (spec §3)
  const STYLE_WORDS = /\b(anime|cel|watercolou?r|pixel|clay|comic|illustration|painting|drawn|3d|render|photo-?real|neon|pastel|black-and-white|monochrome|red|blue|green|yellow|orange|purple|pink|teal|amber|gold|sepia|candle|rain|street|city|forest|smoke)\b/i;

  it("speak only of light, framing and movement, which any style can take", () => {
    expect(new Set(EDIT_IDS).size).toBe(EDITS.length);
    for (const e of EDITS) {
      expect(`${e.picture} ${e.motion}`, e.id).not.toMatch(STYLE_WORDS);
      expect(e.stillMotion, e.id).toBeGreaterThan(0);
      expect(e.stillMotion, e.id).toBeLessThanOrEqual(2);
      // the finish is a gentle one: never a picture graded past recognition
      expect(Math.abs(e.finish.contrast - 1), e.id).toBeLessThanOrEqual(0.15);
      expect(e.finish.saturate, e.id).toBeGreaterThanOrEqual(0.6);
      expect(e.finish.saturate, e.id).toBeLessThanOrEqual(1.3);
    }
  });

  it("ask for every picture and clip with their words, after the scene's own, and leave a run without one as it was", () => {
    const script = fakeScript(2);
    const preset = PRESETS.anime;
    const e = editById("energetic")!;
    const plain = imagePrompt(script, 0, preset);
    const edited = imagePrompt(script, 0, preset, e);
    expect(edited).toBe(plain.replace(`${script.scenes[0].imagePrompt}.`, `${script.scenes[0].imagePrompt}. ${e.picture}.`));
    expect(edited.endsWith(preset.imageSuffix)).toBe(true);
    expect(imagePrompt(script, 0, null, e)).toContain(e.picture);
    const motion = motionPrompt(script, 0, preset, e);
    expect(motion.indexOf(e.motion)).toBeGreaterThan(motion.indexOf(script.scenes[0].motionPrompt));
    expect(motion.indexOf(e.motion)).toBeLessThan(motion.indexOf(preset.motionKeywords));
    expect(motionPrompt(script, 0, preset)).not.toContain(e.motion);
  });

  it("tell the script how to frame and cut", () => {
    const e = editById("calm")!;
    const p = buildScriptPrompt({ ...base, edit: "calm" });
    for (const line of e.script) expect(p).toContain(line);
    // a long video's outline frames no scene
    expect(buildScriptPrompt({ ...base, edit: "calm", timing: { targetSec: 180, sceneSec: { min: 3, max: 5 } }, ask: { kind: "outline", partSec: [60, 60, 60] } })).not.toContain("Edit:");
  });

  it("cut their own way, unless the run asked for one cut everywhere", () => {
    const m = createManifest("r", { topic: "t", aspect: "9:16", sceneCount: 4, modes: [1, 1, 1, 1], voiceId: "v" }, { llm: "l", tts: "t", image: "i", video: "v" });
    m.script = fakeScript(4, { transitions: ["cut", "fade", "dissolve", "zoom_transition"] });
    m.request.edit = "retro";
    expect([1, 2, 3].map((k) => transitionInto(m, k))).toEqual(["glitch", "glitch", "glitch"]);
    m.request.edit = "calm";
    expect([1, 2, 3].map((k) => transitionInto(m, k))).toEqual(["fade", "dissolve", "dissolve"]);
    m.request.render.transition = "cut";
    expect([1, 2, 3].map((k) => transitionInto(m, k))).toEqual(["cut", "cut", "cut"]);
  });

  it("lay their finish over the picture and move stills at their pace, in the render alone", () => {
    const m = createManifest("r", { topic: "t", aspect: "9:16", sceneCount: 2, modes: [1, 2], voiceId: "v", render: { captionStyle: "minimalist", transition: "auto", bgmGain: 0.5, hook: false, sfx: false, sfxGain: 0.6 } }, { llm: "l", tts: "t", image: "i", video: "v" });
    m.script = fakeScript(2, { cameras: ["zoom_in", "pan_left"] });
    m.scenes.forEach((s, i) => (s.audio = { path: `audio/scene_0${i + 1}.wav`, duration: 1, removedSec: 0, words: [{ text: `w${i}`, start: 0.1, end: 0.5 }] }));
    m.scenes[0].fitted = { path: "fitted/scene_01.mp4", frames: 30, plan: { kind: "trim" } };
    const opts = { dir: "/run", fontsDir: "/fonts", sfxDir: "/sfx", fps: 30, size: { width: 1080, height: 1920 } };
    const render = () => buildRenderProps(m, opts, wordsToCaptions(globalWords(m), 6)).props;
    // a run without an edit is rendered exactly as before
    const before = render();
    expect(before).not.toHaveProperty("finish");
    expect(before.scenes[1]).not.toHaveProperty("pace");
    m.request.edit = "archive";
    const after = render();
    expect(RenderProps.parse(after)).toEqual(after);
    expect(after.finish).toEqual(editById("archive")!.finish);
    expect(after.scenes[1]).toMatchObject({ kind: "still", pace: editById("archive")!.stillMotion });
    // an edit whose stills move as usual says nothing of it
    m.request.edit = "retro";
    expect(render().scenes[1]).not.toHaveProperty("pace");
  });

  it("grade with only the amounts that change the picture, and move the grain every frame the same way", () => {
    expect(finishFilter(editById("archive")!.finish)).toBe("contrast(1.05) saturate(0.7) sepia(0.45)");
    expect(finishFilter({ contrast: 1, saturate: 1, brightness: 1, sepia: 0, vignette: 0.3, grain: 0, scanlines: false })).toBeUndefined();
    expect(grainOffset(5)).toEqual(grainOffset(5));
    expect(grainOffset(5)).not.toEqual(grainOffset(6));
  });

  it("move a still's camera as before at pace 1, and further or less far otherwise, never off the picture", () => {
    for (const camera of ["zoom_in", "zoom_out", "pan_left", "pan_up"] as const) {
      expect(kenBurnsTransform(camera, 10, 31, 1), camera).toEqual(kenBurnsTransform(camera, 10, 31));
      for (const pace of [0.6, 1.4]) {
        for (const frame of [0, 15, 30]) {
          const t = kenBurnsTransform(camera, frame, 31, pace);
          // a shift of x% of the box is covered while it is at most (s - 1) / (2s)
          expect(Math.abs(t.xPct) + Math.abs(t.yPct), `${camera} ${pace} ${frame}`).toBeLessThanOrEqual(((t.scale - 1) / (2 * t.scale)) * 100 + 1e-9);
        }
      }
    }
    expect(kenBurnsTransform("zoom_in", 30, 31, 1.4).scale).toBeGreaterThan(kenBurnsTransform("zoom_in", 30, 31).scale);
    expect(kenBurnsTransform("zoom_in", 30, 31, 0.6).scale).toBeLessThan(kenBurnsTransform("zoom_in", 30, 31).scale);
  });
});

describe("a video made for its language's viewers", () => {
  it("knows an audience for every language but English, which has no one audience", () => {
    for (const code of SPEECH_LANGUAGE_CODES) expect(AUDIENCE[code] !== undefined, code).toBe(code !== "en");
    expect(cultureRules("en")).toBeNull();
    expect(cultureRules(undefined)).toBeNull();
  });

  it("puts its people and places where the topic leaves them open, and changes nothing the topic decides", () => {
    const p = buildScriptPrompt({ ...base, language: "ja", localize: true, topic: "A nurse's strangest night shift" });
    expect(p).toContain("Audience: this video is made for viewers in Japan.");
    expect(p).toContain("styleBible.characters and styleBible.setting say so");
    expect(p).toContain("a real event, a real person, a period in history, a named place, or anyone the topic names stays exactly as it is");
    expect(p).toContain("No national costume, flags, famous landmarks or stereotypes");
  });

  it("is never made for one where the run did not freeze it so: an earlier run, or one to be made in other languages too", () => {
    expect(buildScriptPrompt({ ...base, language: "ja" })).not.toContain("Audience:");
    expect(buildScriptPrompt({ ...base, language: "ja", localize: false })).not.toContain("Audience:");
    expect(buildScriptPrompt({ ...base, language: "en", localize: true })).not.toContain("Audience:");
  });

  it("is written in every part of a long video, where new people may appear", () => {
    const timing = { targetSec: 180, sceneSec: { min: 3, max: 5 } };
    const outline = { title: "t", stylePreset: "anime" as const, styleBible: { artStyle: "a", characters: "c", palette: "p" }, hook: "h", parts: [{ summary: "a" }, { summary: "b" }, { summary: "c" }] };
    const req = { ...base, timing, language: "tr" as const, localize: true };
    expect(buildScriptPrompt({ ...req, ask: { kind: "outline", partSec: [60, 60, 60] } })).toContain("viewers in Turkey");
    expect(buildScriptPrompt({ ...req, ask: { kind: "part", index: 2, partSec: [60, 60, 60], outline, previous: [] } })).toContain("viewers in Turkey");
  });
});

describe("the layers together (spec §1)", () => {
  it("can all be chosen at once, each saying its own part once", () => {
    const p = buildScriptPrompt({ ...base, niche: "mysteries", format: "pov", edit: "cinematic", language: "ko", localize: true, style: "film_noir" });
    for (const head of ["Niche: Unsolved mysteries.", "Video type: You are there.", "Edit: Cinematic", "Audience: this video is made for viewers in South Korea.", 'use exactly "film_noir"']) {
      expect(p.split(head).length - 1, head).toBe(1);
    }
    // every niche goes with every type it is allowed, and every edit
    for (const n of NICHES) for (const f of FORMATS) if (!formatClash(f.id, n.kind)) for (const e of EDITS) expect(() => buildScriptPrompt({ ...base, niche: n.id, format: f.id, edit: e.id })).not.toThrow();
  });
});

describe("a video that moves between times and places (spec §7)", () => {
  it("is told to say so in its setting and to name each scene's own year and place, never one room for all", () => {
    const p = buildScriptPrompt({ ...base, format: "countdown" });
    expect(p).toContain('begin it with "Several times and places:"');
    expect(p).toContain("every imagePrompt names its own year and place in its first words");
    expect(p).toContain("Never put such a video in one room or one place that none of its events happened in");
    expect(p).toContain('styleBible.setting begins "Several times and places:"');
  });

  it("holds each scene to the time its own picture names", () => {
    const setting = "Several times and places: Zanzibar 1896, Honduras 1969";
    const scenes = [
      { imagePrompt: "Zanzibar harbour, 1896: a palace under bombardment, sailors in white", motionPrompt: "smoke drifts, a car waits" },
      { imagePrompt: "Honduras, 1969: soldiers beside a truck on a dirt road", motionPrompt: "dust rises" },
    ];
    expect(anachronisms(scenes, setting)).toEqual([expect.stringMatching(/^scene 1 motionPrompt shows "car", which does not belong to the time this scene names/)]);
    expect(isMoving(setting)).toBe(true);
    expect(isMoving("Constantinople, spring 1453")).toBe(false);
  });
});

