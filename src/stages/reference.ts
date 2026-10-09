import { imageProfileOf, takesReference } from "../image-profiles.js";
import { MAX_SEED, type Manifest } from "../manifest/schema.js";
import { download } from "../providers/download.js";
import { TIMEOUTS } from "../providers/retry.js";
import { runProviderJob } from "./job.js";
import { effectivePreset } from "./look.js";
import { outPath, paths } from "./paths.js";
import { requireScript } from "./require.js";
import type { Stage, StageContext } from "./types.js";
import { showsCharacter } from "./visual.js";

/** The portrait is square: a face and shoulders need no more, and it is quick to make. */
const REFERENCE_SIZE = { width: 1024, height: 1024 };

const hasCharacters = (m: Manifest): boolean => {
  const c = m.script?.styleBible.characters.trim().toLowerCase();
  return c === undefined || (c !== "" && c !== "none"); // before the script exists, assume characters
};

/**
 * The generated reference portrait applies to RunPod runs (the only provider that takes references) with
 * characters and no brand-kit portrait (2.4 spec §5.2). It is scene 1's job, so a run it does not apply to
 * (every run made before 2.4) has no target and never plans it.
 */
export function referenceApplies(m: Manifest, scene: number): boolean {
  return scene === 0 && takesReference(m.request.imageProfile) && !m.request.referenceImage && hasCharacters(m) && someoneAppears(m);
}

/** A script whose every scene is without the character needs no portrait. Before the script exists, assume one does. */
const someoneAppears = (m: Manifest): boolean => !m.script || m.script.scenes.some((_s, i) => showsCharacter(m.script!, i));

/** The run-relative portrait keyframes are conditioned on, if the run has one. */
export function referenceImageOf(m: Manifest): string | undefined {
  if (!takesReference(m.request.imageProfile)) return undefined;
  return m.request.referenceImage ?? (referenceApplies(m, 0) ? paths.reference : undefined);
}

/** The portrait scene i's keyframe is conditioned on: none for a scene the character is not in. */
export function referenceFor(m: Manifest, scene: number): string | undefined {
  if (m.script && !showsCharacter(m.script, scene)) return undefined;
  return referenceImageOf(m);
}

function portraitPrompt(m: Manifest): string {
  const script = requireScript(m);
  const preset = effectivePreset(m);
  const look = preset ? preset.imagePrefix : script.styleBible.artStyle;
  const finish = preset ? ` ${preset.imageSuffix}` : "";
  // The klein worker copies what it is shown: clasped hands and whatever stood beside the portrait came back in
  // every scene (phase 5 spec §9.12). Its portrait is asked for first and bare, with the look after it.
  if (m.request.imageProfile === "runpod-klein@1") {
    return (
      `Character reference portrait of ${script.styleBible.characters}. ` +
      "Neutral front-facing waist-up portrait, arms relaxed at the sides, empty hands, nothing else in the frame: " +
      `no furniture, no objects, no window. Plain light grey studio backdrop, soft even light. ${look}.`
    );
  }
  return (
    `${look}. Character reference portrait of ${script.styleBible.characters}. ` +
    `Neutral front-facing waist-up portrait, plain light grey background, soft even studio light.${finish}`
  );
}

/** The portrait's seed: the run's seed plus the portrait's reroll count, wrapped like a keyframe's. Undefined without a run seed. */
export function referenceSeed(m: Manifest): number | undefined {
  const seed = m.request.seed;
  if (seed === undefined) return undefined;
  return (seed + (m.scenes[0].nonces.reference ?? 0)) % (MAX_SEED + 1);
}

const inputs = (ctx: StageContext) => ({
  model: ctx.manifest.models.image,
  prompt: portraitPrompt(ctx.manifest),
  size: REFERENCE_SIZE,
  seed: referenceSeed(ctx.manifest),
  preset: effectivePreset(ctx.manifest)?.name,
});

export const referenceStage: Stage = {
  name: "reference",
  perScene: true,
  paid: true,
  appliesTo: (m, scene) => referenceApplies(m, scene),
  deps: () => [{ stage: "script" }],
  inputsFor: async (ctx) => inputs(ctx),
  outputsFor: () => [paths.reference],
  estimateCostUsd: (ctx) => imageProfileOf(ctx.manifest.request.imageProfile).referenceUsd(ctx.prices, REFERENCE_SIZE),
  async run(ctx) {
    const req = inputs(ctx);
    const image = ctx.providers.image;
    const result = await runProviderJob(ctx, 0, "reference", {
      label: "character reference",
      costUsd: imageProfileOf(ctx.manifest.request.imageProfile).referenceUsd(ctx.prices, REFERENCE_SIZE),
      prepare: () => image.prepare({ prompt: req.prompt, ...REFERENCE_SIZE, seed: req.seed, preset: req.preset }),
      submit: (job, signal) => image.submit(job, { signal }),
      wait: (id) => image.wait(id, { timeoutMs: image.waitMs ?? TIMEOUTS.image }),
      waitMs: image.waitMs ?? TIMEOUTS.image,
      submitTimeoutMs: image.submitMs,
    });
    await download(result.url, await outPath(ctx, paths.reference));
    // the run has its own copy now: the one the worker uploaded is taken out of the bucket
    await result.remove?.();
  },
};
