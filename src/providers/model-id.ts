/**
 * Which provider serves a run (2.4 spec §3.4). Ids are frozen in each run's manifest: `runpod:<endpointId>/
 * <workflow>@<version>` for the studio's own GPU worker. Anything else names a hosted model the studio no longer
 * buys from (phase 5 spec §5.1): such a run still loads and re-renders, but nothing more can be bought for it.
 */
export type ModelRef =
  | { provider: "retired"; model: string }
  | { provider: "runpod"; endpointId: string; workflow: string; version: number };

const RUNPOD = /^runpod:([A-Za-z0-9_-]+)\/([a-z0-9-]+)@(\d+)$/;

export function parseModelId(id: string): ModelRef {
  if (!id.startsWith("runpod:")) return { provider: "retired", model: id };
  const m = RUNPOD.exec(id);
  if (!m) throw new Error(`invalid RunPod model id "${id}" (expected runpod:<endpointId>/<workflow>@<version>)`);
  return { provider: "runpod", endpointId: m[1], workflow: m[2], version: Number(m[3]) };
}

export function runpodModelId(endpointId: string, workflow: string, version: number): string {
  return `runpod:${endpointId}/${workflow}@${version}`;
}

/** The worker graphs new RunPod runs use (2.4 spec §4.1). */
export const RUNPOD_WORKFLOWS = {
  keyframe: { workflow: "keyframe-sdxl", version: 1 },
  clip: { workflow: "clip-wan22-480p", version: 1 },
  voice: { workflow: "voice-voxcpm2", version: 1 },
} as const;
