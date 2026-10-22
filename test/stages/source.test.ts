import { describe, expect, it } from "vitest";
import { playedClip } from "../../src/stages/source.js";
import { makeTestContext } from "../helpers/context.js";

describe("which clip file a scene plays", () => {
  it("is the raw clip, the full HD one, or the smoothed one, by what the run asked for", async () => {
    const { ctx } = await makeTestContext({ modes: [1] });
    const m = ctx.manifest;
    expect(playedClip(m, 0)).toEqual({ stage: "clips", path: "clips/clip_01.mp4" });
    m.request.upscale = true;
    expect(playedClip(m, 0)).toEqual({ stage: "upscale", path: "clips/clip_01.hd.mp4" });
    m.request.upscale = undefined;
    m.request.fps = 60;
    expect(playedClip(m, 0)).toEqual({ stage: "interpolate", path: "clips/clip_01.60.mp4" });
    m.request.upscale = true;
    // Full HD wins: the combined job's one file is the upscaled path
    expect(playedClip(m, 0)).toEqual({ stage: "upscale", path: "clips/clip_01.hd.mp4" });
  });
});
