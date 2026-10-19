import { basename } from "node:path";
import { describe, expect, it } from "vitest";
import { type RunOptions, runPipeline } from "../../src/pipeline.js";
import { bumpNonce } from "../../src/reroll.js";
import { STAGES } from "../../src/stages/index.js";
import { fakeScript } from "../fakes/providers.js";
import { makeTestContext } from "../helpers/context.js";

// Phase 10 spec §5: a FLUX 3 keyframe is conditioned on the portrait, the look anchor and, for a reframe, the previous keyframe.

const auto: RunOptions = { budgetUsd: 100, confirm: async () => true };

/** Four cut scenes in stills (Mode 2), scenes 3 and 4 reframes; the FLUX 3 profile cannot be priced without its rates. */
async function run(profile: "runpod-flux3-klein@1" | "runpod-klein@1", cutReferences: boolean) {
  const made = await makeTestContext({
    modes: [2, 2, 2, 2],
    characters: "a red fox in a coat",
    script: () => {
      const s = fakeScript(4, { shots: ["cut", "cut", "cut", "cut"] });
      s.scenes.forEach((sc, i) => ((sc as { reframe?: boolean }).reframe = i >= 2));
      return s;
    },
  });
  Object.assign(made.ctx.prices, { runpodPicture3UsdPerSec: 0.0006, runpodPicture3Sec: 24, runpodPortrait3Sec: 12, runpodPicture3ColdStartSec: 90 });
  made.ctx.manifest.request.imageProfile = profile;
  made.ctx.manifest.request.cutReferences = cutReferences ? true : undefined;
  return made;
}

type Sub = { prompt: string; referenceImagePaths?: string[] };
const keyframeSubmits = (subs: Sub[]) => subs.filter((r) => !r.prompt.startsWith("Character reference"));
const names = (r: Sub) => (r.referenceImagePaths ?? []).map((p) => basename(p));

describe("a FLUX 3 run with cut references, through the whole scheduler", () => {
  it("makes the keyframes in order, each conditioned on the portrait, the anchor and, for a reframe, the previous keyframe", async () => {
    const { ctx, fakes } = await run("runpod-flux3-klein@1", true);
    await runPipeline(ctx, STAGES, auto);
    const subs = fakes.image.submits as Sub[];
    expect(subs[0].prompt.startsWith("Character reference")).toBe(true);
    expect(subs[0].referenceImagePaths).toBeUndefined();
    const kf = keyframeSubmits(subs);
    expect(kf.map((r) => r.prompt.match(/image (\d)/)?.[1])).toEqual(["1", "2", "3", "4"]);
    expect(names(kf[0])).toEqual(["reference.png"]);
    expect(names(kf[1])).toEqual(["reference.png", "keyframe_01.png"]);
    expect(names(kf[2])).toEqual(["reference.png", "keyframe_01.png", "keyframe_02.png"]); // a reframe: the previous keyframe is scene 2's, after the anchor
    expect(names(kf[3])).toEqual(["reference.png", "keyframe_01.png", "keyframe_03.png"]);
  });

  it("buys nothing more when the finished run is run again", async () => {
    const { ctx, fakes } = await run("runpod-flux3-klein@1", true);
    await runPipeline(ctx, STAGES, auto);
    const before = fakes.image.submits.length;
    await runPipeline(ctx, STAGES, auto);
    expect(fakes.image.submits).toHaveLength(before);
  });

  it("makes all four keyframes again when the anchor is rerolled, because each is keyed on the anchor's bytes", async () => {
    const { ctx, fakes } = await run("runpod-flux3-klein@1", true);
    await runPipeline(ctx, STAGES, auto);
    const before = fakes.image.submits.length;
    bumpNonce(ctx.manifest, 1, "keyframes");
    await runPipeline(ctx, STAGES, auto);
    expect(fakes.image.submits.length - before).toBe(4);
  });

  it("makes only the rerolled keyframe again when cut references are off", async () => {
    const { ctx, fakes } = await run("runpod-flux3-klein@1", false);
    await runPipeline(ctx, STAGES, auto);
    const before = fakes.image.submits.length;
    bumpNonce(ctx.manifest, 1, "keyframes");
    await runPipeline(ctx, STAGES, auto);
    expect(fakes.image.submits.length - before).toBe(1);
  });

  it("makes only the rerolled keyframe again on the profile that takes one reference", async () => {
    const { ctx, fakes } = await run("runpod-klein@1", false);
    await runPipeline(ctx, STAGES, auto);
    const before = fakes.image.submits.length;
    bumpNonce(ctx.manifest, 1, "keyframes");
    await runPipeline(ctx, STAGES, auto);
    expect(fakes.image.submits.length - before).toBe(1);
  });
});
