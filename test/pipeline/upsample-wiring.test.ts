import { basename } from "node:path";
import { describe, expect, it } from "vitest";
import { type RunOptions, runPipeline } from "../../src/pipeline.js";
import { STAGES } from "../../src/stages/index.js";
import { REFERENCE_NOTE } from "../../src/stages/references.js";
import { fakeScript } from "../fakes/providers.js";
import { makeTestContext } from "../helpers/context.js";

// Phase 10 spec §3: a FLUX 3 picture is bought only from a prompt the upsampler has expanded, seeing the same references.

const auto: RunOptions = { budgetUsd: 100, confirm: async () => true };

type Req = { prompt: string; images?: string[] };
type Sub = { prompt: string; referenceImagePaths?: string[] };

/** The run of cut-references.test.ts, with a fake upsampler that records what it was asked and marks what it returns. */
async function run(profile: "runpod-flux3-klein@1" | "runpod-klein@1") {
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
  made.ctx.manifest.request.cutReferences = profile === "runpod-flux3-klein@1" ? true : undefined;
  made.ctx.manifest.request.format = "story" as never;
  const asked: Req[] = [];
  (made.fakes.llm as { upsample?: (r: Req) => Promise<string> }).upsample = async (r) => (asked.push(r), `UP:${r.prompt}`);
  return { ...made, asked };
}

const names = (r: Req) => (r.images ?? []).map((p) => basename(p));
const isPortrait = (prompt: string) => prompt.startsWith("Character reference");

describe("a FLUX 3 run through the whole scheduler, with the prompt upsampler", () => {
  it("buys every picture, the portrait included, from a prompt the upsampler expanded first", async () => {
    const { ctx, fakes, asked } = await run("runpod-flux3-klein@1");
    await runPipeline(ctx, STAGES, auto);
    const subs = fakes.image.submits as Sub[];
    expect(subs).toHaveLength(5);
    expect(asked).toHaveLength(5);
    for (const s of subs) expect(s.prompt.startsWith("UP:")).toBe(true);
    expect(subs[0].prompt.startsWith("UP:Character reference")).toBe(true);
  });

  it("shows the upsampler the same references the picture is conditioned on, the portrait none", async () => {
    const { ctx, asked } = await run("runpod-flux3-klein@1");
    await runPipeline(ctx, STAGES, auto);
    const portrait = asked.filter((r) => isPortrait(r.prompt));
    const kf = asked.filter((r) => !isPortrait(r.prompt));
    expect(portrait).toHaveLength(1);
    expect(portrait[0]).not.toHaveProperty("images");
    expect(kf.map(names)).toEqual([
      ["reference.png"],
      ["reference.png", "keyframe_01.png"],
      ["reference.png", "keyframe_01.png", "keyframe_02.png"],
      ["reference.png", "keyframe_01.png", "keyframe_03.png"],
    ]);
  });

  it("upsamples the reference note along with scenes 2 to 4, and not the portrait or scene 1", async () => {
    const { ctx, asked } = await run("runpod-flux3-klein@1");
    await runPipeline(ctx, STAGES, auto);
    expect(asked.filter((r) => isPortrait(r.prompt)).every((r) => !r.prompt.includes(REFERENCE_NOTE))).toBe(true);
    const kf = asked.filter((r) => !isPortrait(r.prompt));
    expect(kf.map((r) => r.prompt.includes(REFERENCE_NOTE))).toEqual([false, true, true, true]);
  });

  it("never calls the upsampler on the 4B profile, whose prompts are sent as they were", async () => {
    const { ctx, fakes, asked } = await run("runpod-klein@1");
    await runPipeline(ctx, STAGES, auto);
    expect(asked).toHaveLength(0);
    const subs = fakes.image.submits as Sub[];
    expect(subs.length).toBeGreaterThan(0);
    for (const s of subs) expect(s.prompt.startsWith("UP:")).toBe(false);
  });
});
