import { mkdir, writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { anchorScene, previousKeyframeScene, reframes, referencesFor } from "../../src/stages/references.js";
import { keyframesStage } from "../../src/stages/keyframes.js";
import { fakeScript } from "../fakes/providers.js";
import { makeTestContext } from "../helpers/context.js";

async function flux3Run(opts: { cutReferences?: boolean; shots?: Array<"cut" | "continue">; reframe?: boolean[] } = {}) {
  const { ctx, fakes, dir } = await makeTestContext({ modes: [1, 1, 1, 1], shots: opts.shots ?? ["cut", "continue", "cut", "cut"] });
  const m = ctx.manifest;
  m.request.imageProfile = "runpod-flux3-klein@1";
  if (opts.cutReferences !== undefined) m.request.cutReferences = opts.cutReferences;
  m.script = fakeScript(4, { shots: opts.shots ?? ["cut", "continue", "cut", "cut"] }) as never;
  (opts.reframe ?? []).forEach((r, i) => ((m.script!.scenes[i] as { reframe?: boolean }).reframe = r));
  return { ctx, fakes, m, dir };
}

describe("which scene's picture is the anchor and which came before", () => {
  it("takes the first keyframe as the anchor, and the nearest earlier keyframe as the previous one", async () => {
    const { m } = await flux3Run();
    expect(anchorScene(m)).toBe(0);
    expect(previousKeyframeScene(m, 2)).toBe(0); // scene 1 continues scene 0: no keyframe of its own
    expect(previousKeyframeScene(m, 3)).toBe(2);
    expect(previousKeyframeScene(m, 0)).toBe(-1);
  });
});

describe("what a keyframe is conditioned on", () => {
  it("is nothing for a profile that takes one reference, whatever else is set", async () => {
    const { m } = await flux3Run({ cutReferences: true, reframe: [false, false, true, false] });
    m.request.imageProfile = "runpod-klein@1";
    expect(referencesFor(m, 2)).toEqual([]);
  });

  it("is only the portrait while cut references are off", async () => {
    const { m } = await flux3Run({ cutReferences: false, reframe: [false, false, true, false] });
    expect(referencesFor(m, 2).every((p) => !p.includes("keyframe"))).toBe(true);
  });

  it("adds the look anchor to every later keyframe when cut references are on, and not to the anchor itself", async () => {
    const { m } = await flux3Run({ cutReferences: true });
    expect(referencesFor(m, 0).filter((p) => p.includes("keyframe"))).toEqual([]);
    expect(referencesFor(m, 2).filter((p) => p.includes("keyframe"))).toEqual(["images/keyframe_01.png"]);
  });

  it("adds the previous keyframe for a reframe, after the anchor, and does not repeat the anchor", async () => {
    const { m } = await flux3Run({ cutReferences: true, reframe: [false, false, true, true] });
    expect(reframes(m, 2)).toBe(true);
    expect(referencesFor(m, 2).filter((p) => p.includes("keyframe"))).toEqual(["images/keyframe_01.png"]); // previous is the anchor itself
    expect(referencesFor(m, 3).filter((p) => p.includes("keyframe"))).toEqual(["images/keyframe_01.png", "images/keyframe_03.png"]);
  });

  it("never reframes scene 1, a continue scene, or a run that did not freeze cut references", async () => {
    const a = await flux3Run({ cutReferences: true, reframe: [true, true, false, false] });
    expect(reframes(a.m, 0)).toBe(false);
    expect(reframes(a.m, 1)).toBe(false); // a continue scene
    const b = await flux3Run({ cutReferences: false, reframe: [false, false, true, false] });
    expect(reframes(b.m, 2)).toBe(false);
  });
});

describe("the keyframe stage's dependencies and cache keys", () => {
  it("makes a keyframe wait for the anchor and, for a reframe, for the previous keyframe", async () => {
    const { m } = await flux3Run({ cutReferences: true, reframe: [false, false, false, true] });
    const deps = (scene: number) => keyframesStage.deps(m, scene).filter((d) => d.stage === "keyframes").map((d) => d.scene);
    expect(deps(0)).toEqual([]);
    expect(deps(2)).toEqual([0]);
    expect(deps(3)).toEqual([0, 2]);
  });

  it("adds no key to a run that takes one reference, so it keeps exactly the cache key it had", async () => {
    const { ctx } = await makeTestContext({ modes: [1, 1], seed: 5 });
    ctx.manifest.script = fakeScript(2) as never;
    const inputs = JSON.parse(JSON.stringify(await keyframesStage.inputsFor(ctx, 0)));
    expect(Object.keys(inputs).sort()).toEqual(["model", "prompt", "seed", "size"]);
  });

  it("puts the hash of each reference in the key of a run that has them, and none in the single field", async () => {
    const { ctx, dir } = await flux3Run({ cutReferences: true });
    await mkdir(`${dir}/images`, { recursive: true });
    await writeFile(`${dir}/images/keyframe_01.png`, "anchor bytes");
    await writeFile(`${dir}/images/reference.png`, "portrait bytes"); // the portrait applies to scene 3 as well
    const inputs = JSON.parse(JSON.stringify(await keyframesStage.inputsFor(ctx, 2)));
    expect(inputs.references).toHaveLength(2); // the portrait, then the anchor
    expect(inputs).not.toHaveProperty("reference");
  });
});
