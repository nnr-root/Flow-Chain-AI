import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type RunOptions, runPipeline } from "../../src/pipeline.js";
import type { InspectRequest } from "../../src/providers/types.js";
import { STAGES } from "../../src/stages/index.js";
import { makeTestContext } from "../helpers/context.js";

const auto: RunOptions = { budgetUsd: 100, confirm: async () => true };

async function run(profile: "runpod-flux3-klein@1" | "runpod-klein@1") {
  const made = await makeTestContext({ modes: [2, 2], seed: 100 });
  made.ctx.manifest.request.imageProfile = profile;
  // the FLUX 3 profile cannot be priced without its four rates
  Object.assign(made.ctx.prices, { runpodPicture3UsdPerSec: 0.0006, runpodPicture3Sec: 24, runpodPortrait3Sec: 12, runpodPicture3ColdStartSec: 90 });
  return made;
}

describe("the look at a FLUX 3 picture for unsafe content (phase 10 spec §6)", () => {
  it("makes an unsafe picture again with another seed and uses the new one", async () => {
    const { ctx, fakes } = await run("runpod-flux3-klein@1");
    let first = true;
    fakes.llm.inspect = async (req) => {
      const bad = req.expected.includes("image 1") && first;
      if (bad) first = false;
      return bad ? { ok: false, problems: ["unsafe"], unsafe: true } : { ok: true, problems: [] };
    };
    await runPipeline(ctx, STAGES, auto);
    const made = fakes.image.submits.filter((r) => r.prompt.includes("image 1"));
    expect(made).toHaveLength(2);
    expect(new Set(made.map((r) => r.seed)).size).toBe(2);
    expect(ctx.manifest.scenes[0].keyframe).toBeDefined();
  });

  it("stops with a plain message when the last try is unsafe too, and keeps no keyframe file for it", async () => {
    const { ctx, fakes, dir } = await run("runpod-flux3-klein@1");
    fakes.llm.inspect = async () => ({ ok: false, problems: ["unsafe"], unsafe: true });
    await expect(runPipeline(ctx, STAGES, auto)).rejects.toThrow(/flagged as unsafe content/);
    expect(ctx.manifest.scenes[0].keyframe).toBeUndefined();
    expect(existsSync(join(dir, "images/keyframe_01.png"))).toBe(false);
  });

  it("still uses a merely malformed picture on the last try, but looks at that try too", async () => {
    const { ctx, fakes } = await run("runpod-flux3-klein@1");
    const seen: InspectRequest[] = [];
    fakes.llm.inspect = async (req) => (seen.push(req), req.expected.includes("image 1") ? { ok: false, problems: ["blur"] } : { ok: true, problems: [] });
    await runPipeline(ctx, STAGES, auto);
    expect(fakes.image.submits.filter((r) => r.prompt.includes("image 1"))).toHaveLength(3);
    expect(seen.filter((r) => r.expected.includes("image 1"))).toHaveLength(3);
    expect(seen.every((r) => r.checkContent === true)).toBe(true);
    expect(ctx.manifest.scenes[0].keyframe).toBeDefined();
  });

  it("is never asked of the 4B profile", async () => {
    const { ctx, fakes } = await run("runpod-klein@1");
    const seen: InspectRequest[] = [];
    fakes.llm.inspect = async (req) => (seen.push(req), { ok: true, problems: [] });
    await runPipeline(ctx, STAGES, auto);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((r) => r.checkContent !== true && r.references === undefined)).toBe(true);
  });
});
