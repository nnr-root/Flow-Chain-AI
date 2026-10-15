import { existsSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { wordsToCaptions } from "../../src/media/remotion/caption-pages.js";
import { loadManifest, saveManifest } from "../../src/manifest/store.js";
import { planRun, type RunOptions, runPipeline, sealInherited } from "../../src/pipeline.js";
import { buildScriptPrompt } from "../../src/providers/gemini.js";
import { buildRenderProps } from "../../src/stages/build-render-props.js";
import { globalWords } from "../../src/stages/captions.js";
import { STAGES } from "../../src/stages/index.js";
import { validateTranslation } from "../../src/stages/script.js";
import { copySourceFiles, versionManifest, versionProblem } from "../../src/versions.js";
import { makeTestContext } from "../helpers/context.js";
import { tempDir } from "../helpers/media.js";

// Phase 8 spec §4: a version of a video in another language.

const auto: RunOptions = { budgetUsd: 100, confirm: async () => true };

/** A finished English run of three scenes: a clip, a clip that carries on from it, and a still. */
async function finishedRun() {
  const made = await makeTestContext({ modes: [1, 1, 2], shots: ["cut", "continue", "cut"] });
  made.ctx.manifest.request.language = "en";
  await runPipeline(made.ctx, STAGES, auto);
  return made;
}

async function versionOf(made: Awaited<ReturnType<typeof finishedRun>>, language: "de" | "ja" = "de") {
  const source = made.ctx.manifest;
  const manifest = versionManifest(source, { runId: "test-version", language, voiceId: source.request.voiceId, ttsModel: "fake-tts", llmModel: "fake-llm" });
  const dir = await tempDir("flowchain-version-");
  await copySourceFiles(made.ctx.dir, dir);
  const ctx = { ...made.ctx, dir, manifest };
  await sealInherited(ctx, STAGES);
  await saveManifest(dir, manifest);
  return ctx;
}

describe("a version in another language", () => {
  it("buys the translation and the voice, and not one picture or clip again", async () => {
    const made = await finishedRun();
    const { fakes } = made;
    const source = structuredClone(made.ctx.manifest);
    const bought = { images: fakes.image.submits.length, clips: fakes.video.submits.length, lines: fakes.tts.calls.length, scripts: fakes.llm.calls.length };

    const ctx = await versionOf(made);
    await runPipeline(ctx, STAGES, auto);

    expect(fakes.image.submits.length).toBe(bought.images);
    expect(fakes.video.submits.length).toBe(bought.clips);
    expect(fakes.llm.calls.length).toBe(bought.scripts + 1);
    expect(fakes.tts.calls.length).toBe(bought.lines + 3);
    // what it bought is only what it says, and the source's money is in the source's ledger alone
    expect(new Set(ctx.manifest.ledger.map((e) => e.stage))).toEqual(new Set(["script", "tts"]));
    expect((await loadManifest(made.ctx.dir)).ledger).toEqual(source.ledger);

    // what is said is the translation's, in its language; what the pictures were asked for is the source's
    const asked = fakes.llm.calls.at(-1)!;
    expect(asked).toMatchObject({ language: "de", ask: { kind: "translate", source: { narrations: source.script!.scenes.map((s) => s.narration) } } });
    expect(asked.ask?.kind === "translate" && asked.ask.seconds).toEqual(source.scenes.map((s) => s.audio!.duration));
    expect(fakes.tts.calls.slice(-3).every((c) => c.text.startsWith("fuchs") && c.language === "de")).toBe(true);
    const script = ctx.manifest.script!;
    expect(script.title).toBe("Fake version");
    expect(script.hashtags).toContain("#fuchs");
    expect(script.scenes.map((s) => s.imagePrompt)).toEqual(source.script!.scenes.map((s) => s.imagePrompt));
    expect(script.styleBible).toEqual(source.script!.styleBible);
    expect(JSON.parse(await readFile(join(ctx.dir, "script.json"), "utf8")).title).toBe("Fake version");
    expect(existsSync(join(ctx.dir, "final.mp4"))).toBe(true);

    // its request is the source's in the new language, never made for one audience, and says where it is from
    expect(ctx.manifest.request).toMatchObject({ language: "de", localize: false, silence: 2, versionOf: { runId: source.runId, language: "en" } });
    // and a resume finds nothing to do
    expect((await planRun(ctx, STAGES)).items).toEqual([]);
  });

  it("blends a seam its source cut: the scene before it ends on another frame now", async () => {
    const made = await finishedRun();
    const ctx = await versionOf(made);
    await runPipeline(ctx, STAGES, auto);
    const opts = { dir: ctx.dir, fontsDir: ctx.fontsDir, sfxDir: ctx.sfxDir, fps: ctx.fps, size: ctx.size };
    const boundary = (m: typeof ctx.manifest) => buildRenderProps(m, opts, wordsToCaptions(globalWords(m), 6)).props.boundaries[0];
    expect(boundary(made.ctx.manifest)).toMatchObject({ kind: "seam", transition: "cut", halfWindow: 0 });
    expect(boundary(ctx.manifest)).toMatchObject({ kind: "seam", transition: "dissolve" });
    expect(boundary(ctx.manifest).halfWindow).toBeGreaterThan(0);
  });

  it("stops rather than buy what its source bought, when a file of it is gone", async () => {
    const made = await finishedRun();
    const ctx = await versionOf(made);
    await rm(join(ctx.dir, "clips/clip_02.mp4"));
    const plan = await planRun(ctx, STAGES);
    // (planned, for nothing: it is not this run's to buy)
    expect(plan.items.find((i) => i.stage === "clips")).toMatchObject({ scene: 1, costUsd: 0 });
    const clips = made.fakes.video.submits.length;
    await expect(runPipeline(ctx, STAGES, auto)).rejects.toThrow(/clips of scene 2 of this version is run test-run's, and is never made again here/);
    expect(made.fakes.video.submits.length).toBe(clips);
  });

  it("is made only of a finished run that was not made for one audience, in another language, and never of a version", async () => {
    const made = await finishedRun();
    const m = made.ctx.manifest;
    expect(versionProblem(m, "de")).toBeNull();
    expect(versionProblem(m, "en")).toMatch(/already in English/);
    expect(versionProblem({ ...m, request: { ...m.request, language: "tr", localize: true } }, "de")).toMatch(/made for viewers in Turkey/);
    expect(versionProblem({ ...m, request: { ...m.request, versionOf: { runId: "x", title: "t", hook: "h", narrations: ["n"], seconds: [1] } } }, "de")).toMatch(/is itself a version of x/);
    const unmade = structuredClone(m);
    delete unmade.scenes[1].clip;
    expect(versionProblem(unmade, "de")).toMatch(/not made yet/);
    expect(versionProblem({ ...m, script: undefined }, "de")).toMatch(/no script yet/);
  });

  it("drops a title its owner typed in the source's language, and asks for a hook in the new one", async () => {
    const made = await finishedRun();
    made.ctx.manifest.request.render.hookText = "Foxes never sleep";
    const ctx = await versionOf(made);
    expect(ctx.manifest.request.render.hookText).toBeUndefined();
    expect(made.ctx.manifest.request.render.hookText).toBe("Foxes never sleep");
  });
});

describe("a version's translation", () => {
  const seconds = [2, 4];

  it("is asked for line by line, each as long as its scene's pictures, keeping every name and fact", () => {
    const p = buildScriptPrompt({ topic: "t", sceneCount: 2, aspect: "9:16", voiceId: "narrator-m", language: "de", wordsPerSecond: 2.5, ask: { kind: "translate", source: { title: "Foxes", hook: "Foxes never sleep", narrations: ["One.", "Two."] }, seconds, from: "en" } });
    expect(p).toContain("You are making a finished faceless short video in German.");
    expect(p).toContain("it was told in English");
    expect(p).toContain('1. (2.0 seconds: 4 to 6 words) "One."');
    expect(p).toContain('2. (4.0 seconds: 9 to 11 words) "Two."');
    expect(p).toContain("Keep every name, number and fact; add nothing and leave nothing out");
    expect(p).toContain("- hashtags: exactly 5");
  });

  it("is sent back when a line is clearly too long or too short for its pictures, or a scene has none", () => {
    const ok = { title: "t", hook: "Füchse schlafen nie", narrations: ["a b c d e", "a b c d e f g h i j"], hashtags: ["#fuchs"] };
    expect(validateTranslation(ok, seconds, "de", 2.5)).toMatchObject({ ok: true });
    const long = validateTranslation({ ...ok, narrations: ["a b c d e f g h i", ok.narrations[1]] }, seconds, "de", 2.5);
    expect(long).toMatchObject({ ok: false, problems: [expect.stringMatching(/scene 1 narration has 9 words; its 2.0 seconds hold 4 to 6/)] });
    expect(validateTranslation({ ...ok, narrations: ["a b c d e"] }, seconds, "de", 2.5)).toMatchObject({ ok: false, problems: [expect.stringMatching(/expected exactly 2 narrations/)] });
    expect(validateTranslation({ ...ok, hook: "one two three four five six seven" }, seconds, "de", 2.5)).toMatchObject({ ok: false });
  });
});
