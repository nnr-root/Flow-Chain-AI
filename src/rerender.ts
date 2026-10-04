import { type Manifest, RenderOptions, type StageName } from "./manifest/schema.js";
import type { Plan } from "./pipeline.js";
import type { Providers } from "./providers/types.js";

export type RerenderFlags = { captionStyle?: string; transition?: string; bgmGain?: string };

/** Applies new render options to the run (validated); options that are not given keep their current value. */
export function applyRenderOptions(m: Manifest, flags: RerenderFlags): void {
  m.request.render = RenderOptions.parse({
    ...m.request.render,
    ...(flags.captionStyle === undefined ? {} : { captionStyle: flags.captionStyle }),
    ...(flags.transition === undefined ? {} : { transition: flags.transition }),
    ...(flags.bgmGain === undefined ? {} : { bgmGain: Number(flags.bgmGain) }),
  });
}

const FREE_STAGES: StageName[] = ["captions", "render"];

/**
 * A rerender may only re-run the free captions/render stages. Anything else in the plan means paid work is
 * missing or stale, so the run must be finished with `resume` first; nothing is spent here.
 */
export function assertRenderOnly(plan: Plan, runId: string): void {
  const other = plan.items.filter((i) => !FREE_STAGES.includes(i.stage) || i.costUsd > 0);
  if (other.length > 0) {
    const steps = other.map((i) => (i.scene === undefined ? i.stage : `${i.stage} scene ${i.scene + 1}`)).join(", ");
    throw new Error(`run ${runId} is not complete (${steps} would run); use resume`);
  }
}

/** Providers for a rerender: any call is a bug, because a rerender never buys anything. */
export function noPaidProviders(): Providers {
  const refuse = () => Promise.reject(new Error("rerender never calls a paid provider"));
  return {
    llm: { generateScript: refuse },
    tts: { speak: refuse },
    image: { prepare: refuse, submit: refuse, wait: refuse },
    video: { prepare: refuse, submit: refuse, wait: refuse },
  };
}
