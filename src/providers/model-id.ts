/**
 * Which provider serves a run (2.4 spec §3.4). Ids are frozen in each run's manifest: `runpod:<endpointId>/
 * <workflow>@<version>` for the studio's own GPU worker. Anything else names a hosted model the studio no longer
 * buys from (phase 5 spec §5.1): such a run still loads and re-renders, but nothing more can be bought for it. So does a
 * RunPod id whose worker is gone from the studio: Wan's clips (`clip-wan22-*`, removed on 2026-11-02, phase 15 spec §13.10)
 * and Foley's scene sounds (`sound-foley`, removed the same day, §13.12).
 */
export type ModelRef =
  | { provider: "retired"; model: string }
  | { provider: "runpod"; endpointId: string; workflow: string; version: number };

const RUNPOD = /^runpod:([A-Za-z0-9_-]+)\/([a-z0-9-]+)@(\d+)$/;

/** Workflows of RunPod workers the studio no longer has (their endpoints are deleted, their code is at the tags `wan-last` and `foley-last`). */
const RETIRED_WORKFLOWS = /^(clip-wan22-|sound-foley$)/;

export function parseModelId(id: string): ModelRef {
  if (!id.startsWith("runpod:")) return { provider: "retired", model: id };
  const m = RUNPOD.exec(id);
  if (!m) throw new Error(`invalid RunPod model id "${id}" (expected runpod:<endpointId>/<workflow>@<version>)`);
  if (RETIRED_WORKFLOWS.test(m[2])) return { provider: "retired", model: id };
  return { provider: "runpod", endpointId: m[1], workflow: m[2], version: Number(m[3]) };
}

/**
 * The clip model of a run made only of pictures in a studio that cannot make clips (no clip engine set up): it parses as
 * retired, so the run is made, loads and re-renders like any other, and only a clip asked of it is refused, in the words
 * below. They reach a customer's job log, so they name no model, setting or provider.
 */
export const NO_CLIPS_MODEL = "no-clips";
export const CLIPS_UNAVAILABLE = "moving clips are not available in this studio right now";
/** What a run of pictures made without a clip engine is told when any scene of it is asked to be other than a picture. */
export const PICTURES_ONLY = `this video is made of pictures only: ${CLIPS_UNAVAILABLE}`;

/** Whether a run was frozen as pictures only, with no clip engine (`NO_CLIPS_MODEL`): every scene of it is a picture, always. */
export const picturesOnly = (models: { video: string }): boolean => models.video === NO_CLIPS_MODEL;

export function runpodModelId(endpointId: string, workflow: string, version: number): string {
  return `runpod:${endpointId}/${workflow}@${version}`;
}

/** The worker graphs new RunPod runs use (2.4 spec §4.1). */
export const RUNPOD_WORKFLOWS = {
  // FLUX.2 klein (phase 5 spec §6.2); runs made on the SDXL worker before it keep their own id, and that
  // worker is gone: they load and re-render, and a picture of theirs cannot be made again
  keyframe: { workflow: "keyframe-klein", version: 1 },
  /** FLUX 3 klein (phase 10 spec §3): on its own endpoint, beside the 4B above. */
  keyframe3: { workflow: "keyframe-flux3-klein", version: 1 },
  voice: { workflow: "voice-voxcpm2", version: 1 },
  upscale: { workflow: "upscale-seedvr2", version: 1 },
  // the restorer's new workflow (phase 11): Full HD and/or smooth motion in one job
  restore: { workflow: "restore-video", version: 1 },
  // the LTX worker (phase 15): a clip with its sound and speech, the only clip engine since Wan was removed (§13.10)
  clipLtx: { workflow: "clip-ltx25", version: 1 },
} as const;
