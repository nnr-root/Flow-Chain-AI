import { readFile, rm } from "node:fs/promises";
import type { Caption } from "@remotion/captions";
import { fileSha256 } from "../manifest/hash.js";
import { concatAudio, loudnessPass } from "../media/audio.js";
import { cellSize, contactSheet } from "../media/contact-sheet.js";
import { extractFrame, extractLastFrame } from "../media/frames.js";
import { engineHash, renderVideo } from "../media/remotion/render.js";
import { buildRenderProps, type RenderInputs } from "./build-render-props.js";
import { abs, outPath, paths } from "./paths.js";
import { requireAudio, requireClip, requireFitted } from "./require.js";
import type { Dep, Stage, StageContext } from "./types.js";

async function renderInputs(ctx: StageContext): Promise<RenderInputs> {
  const captions = JSON.parse(await readFile(abs(ctx, paths.captions), "utf8")) as Caption[];
  return buildRenderProps(ctx.manifest, { dir: ctx.dir, fontsDir: ctx.fontsDir, fps: ctx.fps, size: ctx.size }, captions);
}

/**
 * chain.png: one row per scene. Mode 1 = [first frame of the raw clip | last frame of the fitted clip], so
 * row N's right cell vs row N+1's left cell shows a continuing scene's seam. Mode 2 = the keyframe twice.
 */
async function writeChainSheet(ctx: StageContext): Promise<void> {
  const rows = [];
  for (const scene of ctx.manifest.scenes) {
    if (scene.mode === 2) {
      const still = abs(ctx, paths.keyframe(scene.idx));
      rows.push({ first: still, last: still });
      continue;
    }
    const first = await outPath(ctx, paths.firstFrame(scene.idx));
    const last = await outPath(ctx, paths.lastFrame(scene.idx));
    await extractFrame(abs(ctx, requireClip(scene).path), 0, first);
    await extractLastFrame(abs(ctx, requireFitted(scene).path), last);
    rows.push({ first, last });
  }
  await contactSheet(rows, abs(ctx, paths.chain), cellSize(ctx.size));
}

export const renderStage: Stage = {
  name: "render",
  perScene: false,
  paid: false,
  deps: (m) => [
    { stage: "captions" },
    ...m.scenes.map((s): Dep => ({ stage: "silence", scene: s.idx })),
    ...m.scenes.map((s): Dep => (s.mode === 1 ? { stage: "fit", scene: s.idx } : { stage: "keyframes", scene: s.idx })),
  ],
  async inputsFor(ctx) {
    const { props, files } = await renderInputs(ctx);
    const published: Record<string, string> = {};
    for (const [rel, src] of Object.entries(files)) {
      // narration.wav is written by this stage; the scene audio it is made from is hashed below instead
      if (rel !== paths.narration) published[rel] = await fileSha256(src);
    }
    return {
      props,
      files: published,
      audio: await Promise.all(ctx.manifest.scenes.map((s) => fileSha256(abs(ctx, requireAudio(s).path)))),
      engine: await engineHash(),
    };
  },
  outputsFor: () => [paths.final, paths.chain],
  estimateCostUsd: () => 0,
  async run(ctx) {
    const m = ctx.manifest;
    await concatAudio(m.scenes.map((s) => abs(ctx, requireAudio(s).path)), await outPath(ctx, paths.narration));
    const { props, files } = await renderInputs(ctx);
    const workDir = abs(ctx, paths.renderDir);
    const video = await outPath(ctx, paths.video);
    await renderVideo({ props, files, workDir, out: video, concurrency: ctx.renderConcurrency, log: ctx.log });
    await rm(workDir, { recursive: true, force: true }); // staged links and the bundle are not needed afterwards
    await loudnessPass(video, abs(ctx, paths.final), props.totalFrames / props.fps);
    await writeChainSheet(ctx);
    m.final = { path: paths.final, duration: props.totalFrames / props.fps, chain: paths.chain };
  },
};
