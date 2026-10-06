import { describe, expect, it } from "vitest";
import { Prices } from "../../src/config.js";
import { createManifest } from "../../src/manifest/store.js";
import { wordsToCaptions } from "../../src/media/remotion/caption-pages.js";
import { RenderProps } from "../../src/media/remotion/props.js";
import { applyRenderOptions } from "../../src/rerender.js";
import { buildRenderProps } from "../../src/stages/build-render-props.js";
import { globalWords } from "../../src/stages/captions.js";
import { captionStyleFor } from "../../src/stages/look.js";
import {
  draftDurations, draftEstimate, draftWords, estimateNarrationSec, isDraft, parseModeOverrides, setDraftModes,
} from "../../src/studio/draft.js";
import { draftSceneSvg, silentWav, wrapText } from "../../src/studio/draft-media.js";
import { buildDraftProps, previewProps } from "../../src/studio/props.js";
import { statusOf } from "../../src/studio/status.js";
import { fakeScript } from "../fakes/providers.js";

const opts = { dir: "/run", fontsDir: "/fonts", sfxDir: "/sfx", fps: 30, size: { width: 1080, height: 1920 } };
const keyframeSize = { width: 1000, height: 1000 };
const done = { status: "done" as const, inputHash: "h", costUsd: 0, finishedAt: "t" };

/** An auto run with a script and nothing else: a draft. Scene 2 continues scene 1; scene 3 is a low-action cut. */
function draft() {
  const m = createManifest(
    "r",
    { topic: "t", aspect: "9:16", sceneCount: 3, modeBudgetUsd: 10, modePrices: Prices.parse({}), voiceId: "v", bgm: "/music/song.mp3" },
    { llm: "l", tts: "t", image: "i", video: "v" },
  );
  m.script = fakeScript(3, { shots: ["cut", "continue", "cut"], actionLevels: ["high", "medium", "low"] });
  m.runStages.script = done;
  m.ledger.push({ stage: "script", usd: 0.0055, at: "t" });
  return m;
}

/** The same run with its media bought: audio for every scene, fitted clips for the two Mode 1 scenes. */
function finished() {
  const m = draft();
  m.scenes[2].mode = 2;
  m.scenes.forEach((s, i) => {
    s.stages.tts = done;
    s.audio = {
      path: `audio/scene_0${i + 1}.wav`,
      duration: [1.5, 1.0, 2.0][i],
      removedSec: 0,
      words: [
        { text: "alpha", start: 0.1, end: 0.4 },
        { text: "beta", start: 0.4, end: 0.8 },
      ],
    };
  });
  m.scenes[0].fitted = { path: "fitted/scene_01.mp4", frames: 45, plan: { kind: "trim" } };
  m.scenes[1].fitted = { path: "fitted/scene_02.mp4", frames: 30, plan: { kind: "trim" } };
  return m;
}

describe("draft estimates", () => {
  it("estimates a narration's length from its characters, never below one second", () => {
    expect(estimateNarrationSec("a".repeat(100))).toBe(5.5);
    expect(estimateNarrationSec("  hi  ")).toBe(1);
  });

  it("spreads each scene's words over its estimated length without gaps, by their letters", () => {
    const m = draft();
    const durations = draftDurations(m);
    const words = draftWords(m);
    expect(words.map((w) => w.text).join(" ")).toBe(m.script!.scenes.map((s) => s.narration.trim()).join(" "));
    for (let k = 1; k < words.length; k++) expect(words[k].start).toBeCloseTo(words[k - 1].end, 9);
    expect(words[0].start).toBe(0);
    expect(words.at(-1)!.end).toBeCloseTo(durations.reduce((a, b) => a + b, 0), 9);
    const firstScene = words.slice(0, m.script!.scenes[0].narration.trim().split(/\s+/).length);
    expect(firstScene.at(-1)!.end).toBe(durations[0]);
    const longer = firstScene.toSorted((a, b) => b.text.length - a.text.length)[0];
    const shorter = firstScene.toSorted((a, b) => a.text.length - b.text.length)[0];
    expect(longer.end - longer.start).toBeGreaterThanOrEqual(shorter.end - shorter.start);
  });

  it("plans provisional modes with the run's own rules, budget and pins", () => {
    const m = draft();
    expect(draftEstimate(m, keyframeSize).modes).toEqual([1, 1, 2]);
    expect(draftEstimate(m, keyframeSize, [2, null, 1]).modes).toEqual([2, 1, 1]);
    m.request.modes = [1, 1, 1];
    expect(() => draftEstimate(m, keyframeSize)).toThrow("needs an auto run");
  });
});

describe("draft modes", () => {
  it("a run is a draft only while nothing but the script was bought", () => {
    const m = draft();
    expect(isDraft(m)).toBe(true);
    expect(isDraft(finished())).toBe(false);
    const submitted = draft();
    submitted.scenes[0].jobs.keyframes = { requestId: "q", inputHash: "h", submittedAt: "t", chargedUsd: 0 };
    expect(isDraft(submitted)).toBe(false);
    const unscripted = draft();
    delete unscripted.runStages.script;
    expect(isDraft(unscripted)).toBe(false);
  });

  it("pins scenes, writes every scene's provisional mode and returns the new estimate", () => {
    const m = draft();
    const before = draftEstimate(m, keyframeSize).estimatedUsd;
    const plan = setDraftModes(m, [2, 2, null], keyframeSize);
    expect(m.request.modeOverrides).toEqual([2, 2, null]);
    expect(m.scenes.map((s) => s.mode)).toEqual([2, 2, 2]);
    expect(plan.reasons).toEqual(["set by you", "set by you", "auto: low action"]);
    expect(plan.estimatedUsd).toBeLessThan(before);
  });

  it("clearing every pin removes the field, so the run is again as if it never had overrides", () => {
    const m = draft();
    setDraftModes(m, [2, 2, 2], keyframeSize);
    setDraftModes(m, [null, null, null], keyframeSize);
    expect(m.request.modeOverrides).toBeUndefined();
    expect(m.scenes.map((s) => s.mode)).toEqual([1, 1, 2]);
  });

  it("refuses once media is bought, on explicit runs and with the wrong number of scenes", () => {
    expect(() => setDraftModes(finished(), [1, 1, 1], keyframeSize)).toThrow("is not a draft any more");
    expect(() => setDraftModes(draft(), [1, 1], keyframeSize)).toThrow("expected 3 modes (one per scene), got 2");
    const explicit = draft();
    explicit.request.modes = [1, 1, 1];
    expect(() => setDraftModes(explicit, [1, 1, 1], keyframeSize)).toThrow("explicit modes");
  });

  it("parses auto,1,2 lists", () => {
    expect(parseModeOverrides("auto, 1,2")).toEqual([null, 1, 2]);
    expect(() => parseModeOverrides("1,3")).toThrow('invalid mode "3" (use auto, 1 or 2)');
  });
});

describe("buildDraftProps", () => {
  it("returns valid, deterministic RenderProps with placeholder stills, estimated lengths and a silent narration", () => {
    const m = draft();
    const { props, files } = buildDraftProps(m, opts);
    expect(() => RenderProps.parse(props)).not.toThrow();
    expect(buildDraftProps(m, opts)).toEqual({ props, files });
    const frames = draftDurations(m).map((d) => Math.round(d * 30));
    expect(props.totalFrames).toBe(Math.round(draftDurations(m).reduce((a, b) => a + b, 0) * 30));
    expect(props.scenes.map((s) => [s.kind, s.src])).toEqual([
      ["still", "draft/scene_01.svg"],
      ["still", "draft/scene_02.svg"],
      ["still", "draft/scene_03.svg"],
    ]);
    expect(Math.abs(props.scenes[0].frames - frames[0])).toBeLessThanOrEqual(1);
    expect(files["draft/scene_02.svg"]).toBe("virtual:scene:1");
    expect(props.audio.narration).toBe("draft/silence.wav");
    expect(files["draft/silence.wav"]).toBe("virtual:silence");
  });

  it("keeps everything that is already real: captions in the run's style, hook, music, sound effects, boundaries", () => {
    const m = draft();
    const { props, files } = buildDraftProps(m, opts);
    const spoken = props.captions.pages.flatMap((p) => p.tokens.map((t) => t.text.trim())).join(" ");
    expect(spoken).toBe(m.script!.scenes.map((s) => s.narration.trim()).join(" "));
    expect(props.captions.style).toEqual(captionStyleFor(m));
    expect(props.hook?.text).toBe(m.script!.hook);
    expect(props.audio.bgm?.src).toBe("bgm.mp3");
    expect(files["bgm.mp3"]).toBe("/music/song.mp3");
    expect(props.audio.sfx.length).toBeGreaterThan(0);
    expect(props.audio.speech.length).toBeGreaterThan(0);
    // provisional modes 1,1,(1): scene 2 continues scene 1 as a seam, scene 3 is a cut
    expect(props.boundaries.map((b) => b.kind)).toEqual(["seam", "cut"]);
  });

  it("follows provisional modes and pending look changes without touching the run", () => {
    const m = draft();
    setDraftModes(m, [1, 2, null], keyframeSize);
    const snapshot = structuredClone(m);
    const { props } = buildDraftProps(m, opts, { captionStyle: "minimalist", hook: false, transition: "glitch" });
    expect(props.boundaries.map((b) => [b.kind, b.transition])).toEqual([
      ["cut", "glitch"],
      ["cut", "glitch"],
    ]);
    expect(props.hook).toBeNull();
    expect(props.captions.style.font.family).not.toBe(captionStyleFor(m).font.family);
    expect(m).toEqual(snapshot);
  });
});

describe("previewProps", () => {
  it("without flags is exactly what the render stage builds from the captions stage's output", () => {
    const m = finished();
    const captions = wordsToCaptions(globalWords(m), captionStyleFor(m).maxWordsPerPage);
    expect(previewProps(m, opts)).toEqual(buildRenderProps(m, opts, captions));
  });

  it("with flags is exactly what a rerender with those flags would render, and leaves the run untouched", () => {
    const m = finished();
    const snapshot = structuredClone(m);
    const flags = { captionStyle: "mrbeast", transition: "blur", bgmGain: "0.1", hook: "Look here", sfx: false };
    const applied = structuredClone(m);
    applyRenderOptions(applied, flags);
    const captions = wordsToCaptions(globalWords(applied), captionStyleFor(applied).maxWordsPerPage);
    const preview = previewProps(m, opts, flags);
    expect(preview).toEqual(buildRenderProps(applied, opts, captions));
    expect(preview.props.hook?.text).toBe("Look here");
    expect(preview.props.audio.sfx).toEqual([]);
    expect(preview.props.audio.bgm?.gain).toBe(0.1);
    expect(m).toEqual(snapshot);
  });

  it("previews a brand kit from its own folder until it is installed into the run", () => {
    const look = {
      name: "Acme",
      logo: "logo.svg",
      watermark: { position: "top-right" as const, widthPct: 14, opacity: 0.8, marginPct: 4 },
      font: { family: "AcmeSans", file: "acme.ttf", weight: 700 },
    };
    const { props, files } = previewProps(finished(), { ...opts, brandDir: "/kits/acme" }, { brand: look });
    expect(props.brand?.logo).toBe("logo.svg");
    expect(files["logo.svg"]).toBe("/kits/acme/logo.svg");
    expect(files["acme.ttf"]).toBe("/kits/acme/acme.ttf");
    expect(props.captions.style.font.family).toBe("AcmeSans");
  });
});

describe("draft media", () => {
  it("wraps text to a line budget and marks what was cut", () => {
    expect(wrapText("one two three four", 9, 3)).toEqual(["one two", "three", "four"]);
    expect(wrapText("one two three four five six", 9, 2).at(-1)).toMatch(/…$/);
  });

  it("draws a scene card with the scene's facts and escapes its prompt", () => {
    const m = draft();
    m.script!.scenes[1].imagePrompt = 'A <fox> & a "hen"';
    const svg = draftSceneSvg(m, 1, opts.size);
    expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1920"')).toBe(true);
    expect(svg).toContain("SCENE 2 OF 3  ·  CONTINUE  ·  CLIP  ·  MEDIUM ACTION");
    expect(svg).toContain("A &lt;fox&gt; &amp; a &quot;hen&quot;");
    expect(svg).not.toContain("<fox>");
  });

  it("makes a silent WAV of the asked length", () => {
    const wav = silentWav(2, 8000);
    expect(wav.length).toBe(44 + 2 * 8000 * 2);
    expect(wav.toString("ascii", 0, 4)).toBe("RIFF");
    expect(wav.readUInt32LE(40)).toBe(32000);
    expect(wav.subarray(44).every((b) => b === 0)).toBe(true);
  });
});

describe("statusOf", () => {
  it("reports a draft with each scene's script facts, pins and pending steps", () => {
    const m = draft();
    setDraftModes(m, [null, 2, null], keyframeSize);
    const s = statusOf(m);
    expect(s.draft).toBe(true);
    expect(s.modes).toBe("auto");
    expect(s.runSteps).toEqual([
      { stage: "script", status: "done" },
      { stage: "modes", status: "pending" },
      { stage: "captions", status: "pending" },
      { stage: "render", status: "pending" },
    ]);
    expect(s.scenes.map((x) => [x.scene, x.mode, x.override, x.shot, x.actionLevel])).toEqual([
      [1, 1, null, "cut", "high"],
      [2, 2, 2, "continue", "medium"],
      [3, 2, null, "cut", "low"],
    ]);
    expect(s.scenes[1].steps.map((x) => x.stage)).toEqual(["tts", "silence", "keyframes"]);
    expect(s.scenes[0].narration).toBe(m.script!.scenes[0].narration);
    expect(s.spendUsd).toBe(0.0055);
  });

  it("carries failures with their error text", () => {
    const m = finished();
    m.scenes[0].stages.clips = { ...done, status: "failed", error: "boom" };
    const s = statusOf(m);
    expect(s.draft).toBe(false);
    expect(s.scenes[0].steps.find((x) => x.stage === "clips")).toEqual({ stage: "clips", status: "failed", error: "boom" });
    expect(s.scenes[2].steps.map((x) => x.stage)).not.toContain("clips");
  });
});
