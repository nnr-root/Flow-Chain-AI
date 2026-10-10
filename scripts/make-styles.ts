/*
 * npm run make:styles [-- <style> …]: makes the picture each style is shown by on the new-video form, on the
 * studio's own picture engine. **It buys pictures** (one a style, a fraction of a cent each, and the engine's
 * start): the owner's click, like every command that spends.
 *
 * Each picture is made the way a video's pictures are: the style's own words around one plain sentence of
 * what is in the frame, at the size of an upright video. The sentence is chosen to be a subject the style
 * suits (the style's description says which). The pictures are written to web/public/styles/ and listed in
 * web/content/style-pictures.json, which is what the form reads.
 */
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { keyframeSize, loadEnv, loadPrices } from "../src/config.js";
import { ffmpeg } from "../src/media/ffmpeg.js";
import { type PresetName, PRESETS } from "../src/presets.js";
import { download } from "../src/providers/download.js";
import { createProviders } from "../src/providers/factory.js";
import { newRunProviders, newRunVoice } from "../src/providers/new-run.js";
import { TIMEOUTS } from "../src/providers/retry.js";
import { imagePrompt } from "../src/stages/visual.js";

/** What is in each style's picture: one subject, where it is, how close, the light. No art style: the preset says that. */
const SUBJECTS: Record<PresetName, { scene: string; palette: string }> = {
  cinematic_history: { scene: "A Roman centurion in a red cloak stands on a stone road at dawn, a legion's standards behind him in the mist, medium shot from slightly below", palette: "ochre, deep red, bronze, grey" },
  anime: { scene: "A girl with short dark hair stands on a school rooftop at sunset, wind lifting her scarf, the city far below, medium shot from the side", palette: "orange, pink, deep blue, white" },
  cyberpunk: { scene: "A courier in a hooded jacket waits beside a motorbike in a narrow city alley at night, wet ground reflecting signs, medium shot at eye level", palette: "magenta, cyan, black, violet" },
  dark_fantasy: { scene: "A lone knight in dented armour holds a lantern at the gate of a ruined cathedral, ravens on the broken arch, wide shot from behind", palette: "charcoal, ash grey, dull gold, blood red" },
  photorealistic_8k: { scene: "A red fox stands in tall frosted grass at sunrise, breath visible in the cold air, close-up at eye level with a soft background", palette: "amber, white, pale gold, brown" },
  "3d_render": { scene: "A small round robot holds a watering can over a single sprouting plant on a workshop bench, close-up at eye level, warm lamp light", palette: "teal, orange, cream, soft grey" },
  cartoon: { scene: "A cheerful baker carries a towering stack of doughnuts across a sunny kitchen while a cat watches from the counter, medium shot", palette: "yellow, sky blue, pink, cream" },
  comic_book: { scene: "A masked hero lands in a crouch on a rooftop water tower, cape snapping behind, the city skyline at dusk, low angle medium shot", palette: "red, blue, yellow, black" },
  watercolor: { scene: "A hedgehog in a tiny rowing boat drifts across a pond among water lilies on a misty morning, wide shot from the bank", palette: "sage green, soft blue, peach, cream" },
  pixel_art: { scene: "A small adventurer with a sword stands before a glowing cave entrance on a grassy hill under a starry sky, wide shot from the side", palette: "emerald, navy, gold, purple" },
  film_noir: { scene: "A detective in a trench coat and hat stands under a streetlamp on an empty wet street, a long shadow behind him, medium shot from across the road", palette: "black, white, silver grey" },
  flat_illustration: { scene: "A person at a desk waters a plant growing out of a stack of coins beside a laptop, medium shot straight on, plain background", palette: "indigo, coral, mint, off-white" },
  epic_fantasy: { scene: "A robed traveller with a staff stands on a cliff above a vast valley where a dragon circles a distant white citadel at golden hour, wide shot from behind", palette: "gold, azure, emerald, ivory" },
  claymation: { scene: "A plump penguin in a knitted scarf holds a mug of cocoa beside a tiny snowy cottage, close-up at eye level", palette: "ice blue, red, white, warm brown" },
};

async function main(): Promise<void> {
  process.loadEnvFile(".env");
  const env = loadEnv();
  const asked = process.argv.slice(2);
  const unknown = asked.filter((n) => !Object.hasOwn(PRESETS, n));
  if (unknown.length > 0) throw new Error(`no such style: ${unknown.join(", ")} (the styles are ${Object.keys(PRESETS).join(", ")})`);
  const names = (asked.length > 0 ? asked : Object.keys(PRESETS)) as PresetName[];
  const chosen = newRunProviders(env, "480p");
  const models = { llm: env.GEMINI_MODEL, tts: newRunVoice(env).model, image: chosen.image, video: chosen.video };
  const { image } = createProviders(env, models, loadPrices());
  const outDir = "web/public/styles";
  await mkdir(outDir, { recursive: true });
  const size = keyframeSize("9:16");
  let usd = 0;
  for (const name of names) {
    const preset = PRESETS[name];
    const subject = SUBJECTS[name];
    const script = { title: "", styleBible: { artStyle: preset.artStyle, characters: "none", palette: preset.palette ?? subject.palette }, scenes: [{ narration: "", imagePrompt: subject.scene, motionPrompt: "", shot: "cut" as const, camera: "zoom_in" as const, showsCharacter: false }] };
    const job = await image.prepare({ prompt: imagePrompt(script, 0, preset), ...size, seed: 7, preset: name });
    const id = await image.submit(job, { signal: AbortSignal.timeout(image.submitMs ?? TIMEOUTS.submit) });
    const made = await image.wait(id, { timeoutMs: image.waitMs ?? TIMEOUTS.image });
    const raw = join(outDir, `_${name}.png`);
    await download(made.url, raw);
    // the worker's copy is taken out of the bucket once the picture is here
    await made.remove?.();
    // small enough to sit fourteen in a row on a phone, sharp enough on a dense screen
    await ffmpeg(["-i", raw, "-vf", "scale=432:768:force_original_aspect_ratio=increase,crop=432:768", "-q:v", "4", join(outDir, `${name}.jpg`)]);
    await rm(raw, { force: true });
    usd += made.costUsd ?? 0;
    console.log(`${name}: made${made.costUsd === undefined ? "" : ` ($${made.costUsd.toFixed(4)})`}`);
  }
  const have = Object.keys(PRESETS).filter((n) => existsSync(join(outDir, `${n}.jpg`)));
  await writeFile("web/content/style-pictures.json", `${JSON.stringify({ madeOn: new Date().toISOString().slice(0, 10), styles: have }, null, 2)}\n`);
  console.log(`${names.length} picture(s) made for about $${usd.toFixed(4)}; ${have.length} of ${Object.keys(PRESETS).length} styles have one.`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
