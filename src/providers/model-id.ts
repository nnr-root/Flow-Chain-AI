/**
 * Which provider serves a run (2.4 spec §3.4). Ids are frozen in each run's manifest: `runpod:<endpointId>/
 * <workflow>@<version>` for RunPod; anything else is a fal model id (every run made before 2.4).
 */
export type ModelRef =
  | { provider: "fal"; model: string }
  | { provider: "runpod"; endpointId: string; workflow: string; version: number };

const RUNPOD = /^runpod:([A-Za-z0-9_-]+)\/([a-z0-9-]+)@(\d+)$/;

export function parseModelId(id: string): ModelRef {
  if (!id.startsWith("runpod:")) return { provider: "fal", model: id };
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
} as const;
