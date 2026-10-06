// Builds the runs folder the browser test uses: one finished run with real (tiny) media and one draft.
// Nothing here costs anything: the media is made with ffmpeg and the script is written by hand.
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { Prices } from "../../src/config.js";
import type { Manifest } from "../../src/manifest/schema.js";
import { createManifest, saveManifest } from "../../src/manifest/store.js";

export const DONE_ID = "20261006-120000-e2e001";
export const DRAFT_ID = "20261006-120100-e2e002";
const runs = resolve(process.argv[2] ?? ".e2e/runs");
// this script deletes that folder with everything in it, so it only ever accepts the browser test's own
if (!runs.endsWith(`${sep}.e2e${sep}runs`)) {
  throw new Error(`make-fixtures deletes its target folder, so the target must end with .e2e/runs; got ${runs}`);
}
const done = { status: "done" as const, inputHash: "h", costUsd: 0, finishedAt: "2026-10-06T12:00:00.000Z" };
const ffmpeg = (...args: string[]) => execFileSync("ffmpeg", ["-v", "error", "-y", ...args], { stdio: "inherit" });

function scripted(runId: string): Manifest {
  const m = createManifest(
    runId,
    { topic: "A fox crosses a frozen river", aspect: "9:16", sceneCount: 3, modeBudgetUsd: 3, modePrices: Prices.parse({}), voiceId: "voice" },
    { llm: "llm", tts: "tts", image: "image", video: "video" },
  );
  m.script = {
    title: runId === DONE_ID ? "The Fox and the River" : "Draft of the Fox",
    stylePreset: "cinematic_history",
    hook: "The ice is thin",
    styleBible: { artStyle: "film still", characters: "a red fox", palette: "white, orange" },
    scenes: [
      { narration: "A red fox stops at the frozen river.", imagePrompt: "A red fox at the edge of a frozen river at dawn", motionPrompt: "slow push in", shot: "cut", camera: "zoom_in", actionLevel: "high", suggestedTransition: "fade" },
      { narration: "It tests the ice with one paw.", imagePrompt: "The fox's paw touching thin ice", motionPrompt: "the paw presses down", shot: "continue", camera: "zoom_in", actionLevel: "medium", suggestedTransition: "cut" },
      { narration: "Then it crosses without a sound.", imagePrompt: "The fox walking across the ice into mist", motionPrompt: "wide still shot", shot: "cut", camera: "pan_left", actionLevel: "low", suggestedTransition: "dissolve" },
    ],
  };
  m.runStages.script = done;
  m.ledger.push({ stage: "script", usd: 0.0055, at: done.finishedAt });
  return m;
}

rmSync(runs, { recursive: true, force: true });
mkdirSync(runs, { recursive: true });

const finished = scripted(DONE_ID);
const dir = join(runs, DONE_ID);
const durations = [1.5, 1.0, 2.0];
for (const sub of ["fitted", "images", "audio"]) mkdirSync(join(dir, sub), { recursive: true });
finished.scenes[2].mode = 2;
finished.scenes.forEach((s, i) => {
  const words = finished.script!.scenes[i].narration.split(" ");
  const per = durations[i] / words.length;
  s.modeReason = `auto: ${finished.script!.scenes[i].actionLevel} action`;
  for (const stage of ["tts", "silence"] as const) s.stages[stage] = done;
  s.audio = {
    path: `audio/scene_0${i + 1}.wav`,
    duration: durations[i],
    removedSec: 0,
    words: words.map((text, k) => ({ text, start: k * per, end: (k + 1) * per - 0.02 })),
  };
});
// two fitted clips (scene 2 continues scene 1), a still for scene 3, the narration and a "final" video
ffmpeg("-f", "lavfi", "-i", "testsrc2=size=180x320:rate=30", "-frames:v", "45", "-pix_fmt", "yuv420p", join(dir, "fitted/scene_01.mp4"));
ffmpeg("-f", "lavfi", "-i", "smptebars=size=180x320:rate=30", "-frames:v", "30", "-pix_fmt", "yuv420p", join(dir, "fitted/scene_02.mp4"));
ffmpeg("-f", "lavfi", "-i", "color=c=0x224466:size=192x336", "-frames:v", "1", join(dir, "images/keyframe_03.png"));
ffmpeg("-f", "lavfi", "-i", "color=c=0x664422:size=192x336", "-frames:v", "1", join(dir, "images/keyframe_01.png"));
ffmpeg("-f", "lavfi", "-i", "sine=frequency=330:duration=4.5", "-ar", "48000", join(dir, "narration.wav"));
ffmpeg("-f", "lavfi", "-i", "testsrc2=size=180x320:rate=30", "-f", "lavfi", "-i", "sine=frequency=330:duration=4.5", "-t", "4.5", "-pix_fmt", "yuv420p", "-shortest", join(dir, "final.mp4"));
finished.scenes[0].fitted = { path: "fitted/scene_01.mp4", frames: 45, plan: { kind: "trim" } };
finished.scenes[1].fitted = { path: "fitted/scene_02.mp4", frames: 30, plan: { kind: "trim" } };
for (const i of [0, 1]) for (const stage of ["keyframes", "clips", "fit"] as const) if (stage !== "keyframes" || i === 0) finished.scenes[i].stages[stage] = done;
finished.scenes[2].stages.keyframes = done;
for (const stage of ["modes", "captions", "render"] as const) finished.runStages[stage] = done;
finished.final = { path: "final.mp4", duration: 4.5, chain: "chain.png" };
finished.ledger.push({ stage: "tts", scene: 0, usd: 0.02, at: done.finishedAt }, { stage: "clips", scene: 0, usd: 0.06, at: done.finishedAt });
await saveManifest(dir, finished);

await saveManifest(join(runs, DRAFT_ID), scripted(DRAFT_ID));
// what the stub CLI answers when the studio prices the draft (the browser test rewrites it to simulate a cheaper plan)
writeFileSync(join(runs, "_plan.json"), JSON.stringify({ items: [{ stage: "tts", scene: 1, costUsd: 0.02 }], totalUsd: 0.31 }));
console.log(`fixtures in ${dirname(dir)}`);
