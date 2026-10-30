# Phase 14 — scene sound Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** every scene of a video gets a sound layer made for it by HunyuanVideo-Foley on the studio's own RunPod, from a sound bible and a sound prompt the script writes, with a seed of its own per scene; the phase 12 library goes.

**Architecture:** the script gains `soundBible` and a `soundPrompt` per scene (plain strings). A new per-scene paid stage `sound` (template: `src/stages/interpolate.ts`) runs after `fit`: it sends a small 480p silent video of the scene and the prompt to a new worker `worker-foley/` (template: `worker-upscale/`: weights inside the image, an endpoint that runs anywhere), downloads the wav, levels it, and keeps it in the run. The render plays each scene's track under the narration. The library, its table, cues, assets and `make:sfx` are deleted first.

**Tech Stack:** TypeScript (ESM, `.js` suffixes in `src/`), zod, Remotion, ffmpeg, Python 3.11 + PyTorch 2.8.0 (the worker), RunPod serverless, vitest, pytest.

**Spec:** `docs/superpowers/specs/2026-10-30-phase14-scene-sound-design.md` (read it; where this plan's Rulings differ, the Rulings are built and Task 7 rewrites the spec to match). Phase 12 spec §8–§9 are background (live bug, the owner's verdict).

## Global Constraints

- **Nothing that spends money runs without the owner's click.** Tests never reach RunPod, Gemini or R2: fakes and stub `fetch` only. `npm run runpod:deploy`, a real `run`, `reroll`, the measurements in Task 7 and any pod session are the controller's, after asking. An implementer never starts a pod or runs the real worker. `git push` is the owner's click.
- **A change to a response schema or to a prompt needs the real, cheap probe (Task 1, Step 8):** one `npm run flowchain -- run --topic … --draft --yes --budget 0.5 --scenes 4` (about half a cent) run by the controller. Gemini refused a schema as a whole once (phase 12 spec §9): **no `enum`, no `maxItems`, no nested arrays in the script schema**; plain strings only.
- **Every change to a prompt bumps `PROMPT_VERSION`**, with `UPDATE_PROMPT_PINS=1 npx vitest run test/unit/prompt-pin.test.ts` after the bump and a changelog line in `docs/superpowers/specs/2026-10-18-phase9-prompt-audit-design.md`. The response schema is pinned too (`schema:*` pins).
- Never read or print `.env`; never commit it, `prices.json` stays untracked.
- Manifest fields are **optional** (old runs load; `test/unit/compat.test.ts` is never edited). New request/scene fields are frozen per run.
- A dollar figure is never shown to a customer (`amount()`); no customer-facing surface names a model, a provider or a place the licence excludes (`web/lib/engines.ts`, `web/test/names.test.ts`).
- The web app never runs the CLI and holds no provider key. Nothing here touches credit or the database.
- Python tests: `npm run test:worker` (needs `npm run setup:worker` once); add the new folder to that script's list if it names folders.
- TypeScript conventions of CLAUDE.md: comments say why; tests are sentences about behaviour and must be able to fail; commit `feat:`/`fix:`/`docs:`/`test:` + one sentence + `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`; commit on `main`, **no push**; no new dependency in the TypeScript packages (the worker's Python requirements are its own).

## Rulings (where this plan differs from the spec)

1. **Weights live inside the worker's image** (as `worker-upscale/` does), not on the network volume: so the endpoint can run in any data centre (the picture endpoint's volume is in EU-RO-1 and was throttled for hours on 2026-10-30), there is no `fetch-models` task and no second volume. The image is large (about 25–30 GB); the first start on a host is slow; the deploy sets a long execution timeout. Spec §4 said volume.
2. **The model's input video is small:** the stage makes a 480-pixel (short side), 24 fps, silent copy of the scene for the worker (a Full HD fitted clip would exceed the request's 9 MB limit); the worker's answer does not depend on resolution beyond that.
3. **Levelling is a measured static gain plus a limiter**, not `loudnorm` (single-pass `loudnorm` is unreliable on 2–5 s files): measure integrated loudness with `ebur128`, apply `volume=<target − measured>dB`, then `alimiter` at 0.8. Starting target −26 LUFS.
4. **`request.sceneSound` freezes the choice at creation** (true only when `render.sfx`, `FLOWCHAIN_SCENE_SOUND=on`, the endpoint and the three prices are all there); a run keeps it.
5. **A scene longer than `SCENE_SOUND_MAX_SEC` (10) gets a track for its first 10 s with a fade-out; the rest is silent** (nothing is looped or made longer).
6. **A draft preview has no generated sound.** Runs made with the phase 12 library re-render **without** sound effects.
7. The `SoundProvider` is queued like the other RunPod providers; its `wait` resolves to `{ url, costUsd?, remove? }` and the cost is the measured execution time at `runpodFoleyUsdPerSec`.

---

### Task 1: Out with the library, in with the script's sound fields

**Files (delete):** `src/sounds.ts`, `src/media/sfx.ts`, `scripts/make-sfx.ts`, `assets/sfx/*.mp3`, `test/unit/sounds.test.ts`, `test/unit/scene-sfx.test.ts`, `test/unit/sfx-cues.test.ts`, `test/media/sfx.test.ts`; the `make:sfx` entry in `package.json`; `SFX_DIR` in `src/assets.ts` and every use of it.
**Files (modify):** `src/manifest/schema.ts`, `src/providers/gemini.ts`, `src/providers/prompt-version.ts`, `test/unit/prompt-pins.json`, `test/unit/scene-sounds.test.ts` (rewritten), `test/fakes/providers.ts` (`fakeScript`), `src/stages/build-render-props.ts`, `src/media/remotion/props.ts`, `src/media/remotion/layers/AudioLayer.tsx`, `src/doctor.ts`, `src/cli.ts` (`sfxDir`), `web/components/site/FeatureStage.tsx` and whatever else names a library sound (find with `grep -rn "impact\|whoosh\|\"pop\"\|SFX\|sfxCues\|sceneSfxCues\|SCENE_SOUNDS\|soundCues\|make:sfx\|assets/sfx" src web scripts test README.md CLAUDE.md package.json deploy .github`), `README.md` and `CLAUDE.md` mentions (small now; Task 7 completes them).

**Interfaces:**
- Produces (`src/manifest/schema.ts`): `SceneSpec.soundPrompt?: string` (max 200 characters, stored optional; `LlmSceneSpec.soundPrompt` required); `Script.soundBible?: string` (max 300, stored optional; `LlmScript.soundBible` required). `soundCues` and `SceneSoundCue` no longer exist (a stored script that carries `soundCues` still loads: zod drops the unknown key — a compat test row proves it).
- `RenderProps.audio` has no `sfx` list and `SfxCue` is gone; `buildRenderProps` takes no `sfxDir`; `--no-sfx` and `render.sfx`/`sfxGain` stay (they mean the generated layer from Task 4 on; for now they change nothing).

- [ ] **Step 1: Failing tests** (`test/unit/scene-sounds.test.ts`, rewritten):

```ts
import { describe, expect, it } from "vitest";
import { LlmScript, Script, SceneSpec } from "../../src/manifest/schema.js";
import { buildScriptPrompt, scriptJsonSchema } from "../../src/providers/gemini.js";
import { fakeScript } from "../fakes/providers.js";

describe("a script's sound fields", () => {
  it("are optional when stored, so a script from before them still loads, soundCues and all", () => {
    const old = { ...fakeScript(2), scenes: fakeScript(2).scenes.map((s) => ({ ...s, soundCues: [{ sound: "door", at: "start" }] })) };
    const parsed = Script.parse(old);
    expect(parsed.soundBible).toBeUndefined();
    expect(parsed.scenes[0].soundPrompt).toBeUndefined();
    expect("soundCues" in parsed.scenes[0]).toBe(false);
  });
  it("are required in what Gemini answers", () => {
    const answer = fakeScript(2);
    expect(LlmScript.safeParse(answer).success).toBe(true);
    expect(LlmScript.safeParse({ ...answer, soundBible: undefined }).success).toBe(false);
    expect(LlmScript.safeParse({ ...answer, scenes: [{ ...answer.scenes[0], soundPrompt: undefined }, answer.scenes[1]] }).success).toBe(false);
  });
  it("hold a bible of at most 300 characters and a prompt of at most 200", () => {
    expect(SceneSpec.safeParse({ ...fakeScript(1).scenes[0], soundPrompt: "x".repeat(201) }).success).toBe(false);
    expect(Script.safeParse({ ...fakeScript(1), soundBible: "x".repeat(301) }).success).toBe(false);
  });
  it("reach Gemini as plain strings: no enum and no maxItems anywhere near them (it refused such a schema whole, 2026-10-30)", () => {
    for (const kind of ["script", "part"] as const) {
      const schema = JSON.stringify(scriptJsonSchema(kind, 16));
      expect(schema, kind).toContain("soundPrompt");
      expect(schema, kind).not.toContain("soundCues");
    }
    const top = scriptJsonSchema("script", 16) as { properties: Record<string, Record<string, unknown>> };
    expect(top.properties.soundBible).toMatchObject({ type: "string" });
    expect(Object.keys(top.properties.soundBible)).not.toContain("enum");
  });
});

describe("the script prompt", () => {
  const prompt = buildScriptPrompt({ topic: "t", aspect: "9:16", sceneCount: 4, voiceId: "narrator-m" });
  it("asks for a sound bible first and a sound prompt for every scene, and says what they may not hold", () => {
    expect(prompt).toMatch(/soundBible/);
    expect(prompt).toMatch(/soundPrompt/);
    expect(prompt).toMatch(/no speech, voices, singing or music/i);
    expect(prompt).toMatch(/room tone/i);
    expect(prompt).toMatch(/differ/i);
  });
  it("no longer mentions the library's sounds", () => {
    expect(prompt).not.toMatch(/soundCues|footstep|heartbeat/);
  });
});
```
(`fakeScript` is extended in Step 3 so `LlmScript.safeParse(fakeScript(2))` passes; keep its other fields.)

- [ ] **Step 2: Run it, see it fail** (`npx vitest run test/unit/scene-sounds.test.ts`).

- [ ] **Step 3: Schema.** In `src/manifest/schema.ts`: delete the `soundCues` property and `SceneSoundCue`; add to `SceneSpec`

```ts
  /** Optional when stored (phase 14 spec §2): what is heard in this scene's place, built from the script's sound bible; the picture's sound is made from it. */
  soundPrompt: z.string().max(200).optional().describe("What is heard in this scene's place: concrete sources and materials from the sound bible, specific to the scene; at most 200 characters, English; no speech, voices, singing or music"),
```
and to `Script` (after `styleBible`, so the model settles it before the scenes):

```ts
  /** Optional when stored: the video's sound palette, written once (phase 14 spec §2). */
  soundBible: z.string().max(300).optional().describe("The video's sound palette in English: the place and time as sound, and three to five recurring elements; at most 300 characters"),
```
and make both required in `LlmSceneSpec` / `LlmScript` (as `actionLevel` and `showsCharacter` are: `.extend({ soundPrompt: SceneSpec.shape.soundPrompt.unwrap().…` — use the same trick the file uses for `actionLevel`; a required string with the same max and description). Add both to the part answers (`LlmPart` uses `LlmSceneSpec`; the outline `LlmOutline` carries `soundBible` beside `styleBible`; a long video's later parts read it from the stored outline — look at how `styleBible` is carried in `StoredOutline` and the `part` ask and do the same for `soundBible`). Keep property order so the bible comes before the scenes in `scriptJsonSchema`.

- [ ] **Step 4: Prompt.** In `sceneRules` in `src/providers/gemini.ts`, replace the `soundCues` rule by:

```
"- soundBible (once, before the scenes): the video's sound palette in English, at most 300 characters: the place and time as sound, and three to five recurring elements (for example: a storm coast lighthouse: wind, surf on rock, stone echo, brass machinery, a creaking iron stair).",
"- soundPrompt: what is heard in this scene's place, in English, at most 200 characters, built from the soundBible and specific to the scene (what moves, what it touches, how far away). No speech, voices, singing or music, ever. Concrete sources and materials. Scenes must differ from one another in what leads the sound while the soundBible keeps them one place. A scene with nothing to hear gets a quiet room tone, never an empty soundPrompt.",
```
(placed where the `soundCues` rule was; in the outline prompt ask for `soundBible` beside `styleBible`; check every place the existing prompt lists the fields of the answer). Delete the imports of `SCENE_SOUNDS`/`SCENE_SOUND_ABOUT`. Bump `PROMPT_VERSION` to `2026-10-30.21`; `UPDATE_PROMPT_PINS=1 npx vitest run test/unit/prompt-pin.test.ts`; add the changelog line (counter 21: "the library's `soundCues` rule is replaced by a `soundBible` and a `soundPrompt` for every scene (phase 14 spec §2)").

- [ ] **Step 5: `fakeScript`** (`test/fakes/providers.ts`): add `soundBible: "a stone lighthouse on a storm coast: wind, surf, stone echo"` and per scene `soundPrompt: \`wind and surf, scene ${i + 1}\``. Run the tests of Step 1: green.

- [ ] **Step 6: Delete the library.** Remove the files listed above and every reference found by the `grep` command in the Files list; in `build-render-props.ts` the `sfx:` expression and the `SFX, sfxCues` import go and `audio` loses `sfx`; `props.ts` loses `SfxCue` and `audio.sfx`; `AudioLayer.tsx` loses the cue map (keep the doc comment accurate); `FeatureStage.tsx`'s "In this video" line loses the sound labels (the line names what the page's video has: keep only what is still true; its test follows); `doctor.ts` loses the "bundled sounds" check (and its count in the doctor's tests). `render.sfx`, `render.sfxGain` and `--no-sfx`/`--sfx-gain` stay in the schema and CLI (Task 4 gives them meaning again); say so in a comment at their definition. The Dockerfiles or Compose files that copy `assets/sfx` (grep `deploy/`) are fixed.

- [ ] **Step 7: Run** `npx vitest run test/unit test/stages test/pipeline test/media web/test/restyle.test.ts web/test/names.test.ts web/test/routes.test.ts` (several minutes; re-run a timing-flaky file alone before believing a failure; `test/media/remotion-render.test.ts` takes ≈140 s alone) and `npm run typecheck`, `npm run web:build`. Everything that mentioned the library is green or deleted.

- [ ] **Step 8 (controller):** after the commit, run the real probe once: `npm run flowchain -- run --topic "A lighthouse keeper's daughter takes over the light" --draft --yes --budget 0.5 --scenes 4` (about half a cent; the owner has authorized spend of this size; if the owner has not authorized it in this session, ask first). It must buy the script; inspect `runs/<id>/script.json`: `soundBible` is there and each scene's `soundPrompt` is concrete and differs from its neighbours. If Gemini answers `INVALID_ARGUMENT`, find the cause by bisecting the schema (as phase 12 spec §9 did) before going on.

- [ ] **Step 9: Commit**

```bash
git add -A src test scripts web assets package.json README.md CLAUDE.md deploy docs
git commit -m "feat: the script writes a sound bible and a sound prompt for every scene, and the phase 12 library, its cues and its assets are gone"
```

---

### Task 2: The Foley worker (`worker-foley/`)

**Files:**
- Create: `worker-foley/Dockerfile`, `worker-foley/requirements.txt`, `worker-foley/handler.py`, `worker-foley/src/flowchain_foley/{__init__,contract,engine,storage,weights}.py`, `worker-foley/tests/test_contract.py`, `test_engine.py`, `test_weights.py`, `test_handler.py`
- Modify: `.github/workflows/worker-image.yml` (a `foley` job: tag `f-` + the folder's tree hash, image `flowchain-foley`, `paths` gets `worker-foley/**`), `package.json`'s `test:worker` script and the setup script if they name the folders, `.gitignore` nothing.

**Interfaces:**
- The contract (request `input`): `{ "task": "sound", "workflow": "sound-foley@1", "video": <base64 mp4, 1 byte–9 MB>, "prompt": <non-empty string ≤ 400>, "negative_prompt": <string ≤ 400, optional>, "seed": <int 0–2^31−1>, "guidance_scale": <number 1–10>, "steps": <int 10–60>, "audio_length": <number 1–10> }`; unknown fields refused. The answer: `{ "url": <presigned R2 url of flowchain/<job id>.wav>, "seed": n, "seconds": <wav length>, "executionMs": n }` or `{ "error": "<text>" }`.

- [ ] **Step 1: Read the templates** (`worker-upscale/` entire, `worker-picture/handler.py`, `contract.py`, `storage.py`) and the model's own code: its public repository `https://github.com/Tencent-Hunyuan/HunyuanVideo-Foley` (clone it to a scratch folder to read; do not vendor it into the repo) — find the functions `infer.py` uses (`load_model`/`feature_process`/`denoise_process`/`merge_audio_video` or their real names in `hunyuanvideo_foley`) and how it saves the wav. The trial on 2026-10-30 showed: `torch==2.8.0`, `torchaudio==2.8.0` and `torchvision==0.23.0` from the cu128 index (torch 2.11 broke saving: "TorchCodec is required"); `ffmpeg` and `libsndfile1` in the image; `requirements.txt` of the repo plus `huggingface_hub`; weights from the Hugging Face repository `tencent/HunyuanVideo-Foley` (about 18 GB; files `hunyuanvideo_foley_xxl.pth`, `synchformer_state_dict.pth`, `vae_128d_48k.pth`, the SigLIP/CLAP folders… read the real list from the repo's file listing); `infer.py` sets the seed to a fixed 1 (`set_manual_seed(1)`): this worker sets the seed from the request.

- [ ] **Step 2: Failing tests** (pytest, no GPU, no network, no real model). `test_contract.py`: accepts a full request and a minimal one (no negative prompt), refuses an unknown field, a bad workflow, a seed out of range, a `guidance_scale` of 0 or 11, `steps` of 5, `audio_length` of 0 or 11, an empty or 401-character prompt, a video that is not base64 or over 9 MB; the error texts name the field. `test_engine.py` with a **fake model object** injected (the engine takes the model loader as an argument so it can be replaced): two different seeds give different audio on the same input (the fake derives its noise from the seed; the test also asserts the engine called the fake with each request's own seed and never with 1 unless asked), the same seed twice gives the same audio, `audio_length` is passed through, the negative prompt is passed through. `test_weights.py`: `present(root)` is true only when every file has its size and the marker has the pinned revision (the structure of `worker-picture/.../weights_flux3.py`; here the files are in the image, so `ROOT = "/models/foley"`); `verify` refuses a wrong size and a wrong SHA-256 prefix. `test_handler.py`: with the engine, storage and weights faked: a good request returns a url, seed, seconds and executionMs; an invalid request returns `{"error": "invalid request: …"}`; missing R2 settings return the missing names, never values; the files the handler wrote are removed whatever happened (including when the engine raises).

- [ ] **Step 3: Run `npm run test:worker` and see the new tests fail** (modules missing).

- [ ] **Step 4: Write the worker.** `contract.py` (validate as above), `storage.py` (the upscale worker's, with `content_type` `audio/wav`), `weights.py` (pinned revision `REVISION` = the Hugging Face commit of `tencent/HunyuanVideo-Foley` at build time — look it up with the public API `https://huggingface.co/api/models/tencent/HunyuanVideo-Foley` and write the full SHA; `BIG` = each large file's (size, first 16 hex of SHA-256), computed by downloading once on the implementer's machine OR taken from the Hub's file metadata (`?blobs=true` gives sizes and `lfs.sha256`: use those, no download); `present`, `verify`), `engine.py` (`load(root)` builds the model once from the repository's package; `sound(model, video_path, prompt, negative_prompt, seed, guidance_scale, steps, audio_length, out_path)` sets the seed (`torch.manual_seed`, `numpy`, `random`) before sampling and writes a mono 48 kHz wav; the loader is a parameter), `handler.py` (as the picture worker's: validate, check R2 env, check `weights.present`, write the video to `/tmp/<job id>.mp4`, run, upload to `flowchain/<job id>.wav`, remove files in `finally`, answer). `Dockerfile` (from `worker-upscale/Dockerfile`'s pattern): `python:3.11-slim`, `apt` ffmpeg libsndfile1 git curl, torch/torchvision/torchaudio **pinned to 2.8.0 / 0.23.0 / 2.8.0** from the cu128 index, `git clone` of the model's repository **pinned by commit** (`ARG FOLEY_COMMIT`, read the current head's SHA from GitHub and pin it) and its requirements, then the weights downloaded with `curl` from `https://huggingface.co/tencent/HunyuanVideo-Foley/resolve/<REVISION>/<file>` and checked with `sha256sum -c`, then `COPY` the worker and a final `RUN python -c "import runpod, boto3; from flowchain_foley import weights; assert weights.present()"` plus an import check of the model's package. `requirements.txt`: `runpod>=1.10.1,<2`, `boto3>=1.36,<2` and what the handler itself needs (not torch). The image's `CMD ["python", "-u", "/handler.py"]`.

- [ ] **Step 5: Run `npm run test:worker`:** all green, including the old workers' tests. Add the `foley` job to the workflow (copy the `upscale` job, change names, `context: worker-foley`, tag prefix `f-`, image `flowchain-foley`; keep `free-disk-space`) and its `paths` entry.

- [ ] **Step 6: Commit**

```bash
git add worker-foley .github package.json
git commit -m "feat: a Foley worker makes a scene's sound from a small video and a prompt, with the seed, guidance and length it is asked for, and its weights inside its image"
```
(The image is built by the workflow after the owner pushes. **No agent builds or runs it.**)

---

### Task 3: The provider, the prices and the `sound` stage

**Files:**
- Create: `src/sound.ts` (pure), `src/stages/sound.ts`, `test/unit/sound.test.ts`, `test/pipeline/sound.test.ts`
- Modify: `src/manifest/schema.ts` (`StageName` + `"sound"`, `Models.sound?`, `Request.sceneSound?: true` frozen, scene `sound?: { path, sha256, seconds, seed, guidance, steps, prompt }` as `smoothed` is stored, `ProviderJob` stage names if they enumerate), `src/stages/index.ts`, `src/stages/paths.ts` (`paths.sound(i)` → `sound/scene_NN.wav`, `paths.soundInput(i)`), `src/providers/types.ts` (`SoundProvider`, `SoundRequest`, `Providers.sound?`), `src/providers/runpod-providers.ts` (`RunpodFoley`), `src/providers/factory.ts`, `src/config.ts` (env `FLOWCHAIN_SCENE_SOUND` on/off default off, `RUNPOD_FOLEY_ENDPOINT` optional; prices `runpodFoleyUsdPerSec`, `runpodFoleySecPerClipSec`, `runpodFoleyColdStartSec` optional; `foleyRates(p)` like `restoreRates`), `src/cli.ts` (`run` freezes `request.sceneSound`; `models.sound`), `src/reroll.ts` (`REROLLABLE` + `"sound"`), `src/studio/status.ts`, `src/versions.ts` and `src/stages/source.ts` wherever `interpolate`/`smoothed` is carried (grep `interpolate` — the files are listed in this task's Files from the repository grep: `src/cli.ts src/config.ts src/deploy/server.ts src/manifest/schema.ts src/providers/runpod-providers.ts src/providers/types.ts src/reroll.ts src/stages/{fit,index,interpolate,paths,source,upscale}.ts src/studio/status.ts src/versions.ts test/fakes/providers.ts`; mirror what `interpolate` gets in each, except where a place is about the restorer), `test/fakes/providers.ts` (`FakeSound`), `src/doctor.ts` (an endpoint check when the layer is on), `src/deploy/server.ts` if it passes provider env names through.

**Interfaces (produce):**
```ts
// src/sound.ts — pure, imports nothing but node:crypto and types
export const SCENE_SOUND_MAX_SEC = 10;
export const SOUND_STEPS = 50;
export const SOUND_NEGATIVE_PROMPT = "speech, voice, vocals, singing, music, narration, noise, distortion";
export const LOUDNESS_TARGET_LUFS = -26;
export const guidanceFor = (level: "low" | "medium" | "high" | undefined): number => (level === "low" ? 3.5 : level === "high" ? 5.5 : 4.5);
export function soundSeed(runSeed: number, scene: number, nonce: number): number; // sha256 of `${runSeed}:${scene}:${nonce}`, first 4 bytes big-endian, modulo 2**31
export const soundSeconds = (sceneSec: number): number => Math.min(Math.round(sceneSec * 10) / 10, SCENE_SOUND_MAX_SEC);
export function soundCost(p: Prices, seconds: number, first = false): number; // round4((seconds * secPerClipSec + (first ? coldStartSec : 0)) * usdPerSec); throws FOLEY_RATES_MISSING when unset
export function parseLoudness(ebur128Output: string): number | undefined; // the "I:" value of the Summary, in LUFS
export function gainFor(measuredLufs: number, targetLufs = LOUDNESS_TARGET_LUFS): number; // target − measured, clamped to ±30 dB
// src/providers/types.ts
export type SoundRequest = { videoPath: string; prompt: string; negativePrompt: string; seed: number; guidanceScale: number; steps: number; audioLengthSec: number };
export interface SoundProvider { /* the same queued contract as UpscaleProvider: prepare, submit, wait, waitMs, submitMs; wait resolves to { url, costUsd?, remove? } */ }
```
`RunpodFoley` input: `{ task: "sound", video: base64, prompt, negative_prompt, seed, guidance_scale, steps, audio_length }` (the base class adds `workflow: "sound-foley@1"`); `ext` `"wav"`; `executionTimeout: 300_000`, `ttl: 3_600_000`, wait 25 min (a cold start pulls a large image); `usdPerSec` = the endpoint's rate from `foleyRates`.

- [ ] **Step 1: Failing tests** (`test/unit/sound.test.ts`): `soundSeed` is deterministic, differs between scenes of one run, differs for a changed nonce and a changed run seed, always within `0…2**31−1`; `guidanceFor` maps 3.5/4.5/5.5 and defaults to 4.5; `soundSeconds(12) = 10`, `soundSeconds(4.26) = 4.3`; `soundCost` with rates `{usd 0.0003, sec 4, cold 90}`: 4 s first = round4((16 + 90) × 0.0003) = 0.0318, not first = 0.0048, and throws the missing-rates message without them; `parseLoudness` reads the `I:` of a recorded ebur128 summary text (put a real one from `ffmpeg -i x.wav -af ebur128 -f null -` in the test) and returns undefined on text without it; `gainFor(-40) = 14`, `gainFor(-10) = −16`, clamped at ±30. Pipeline test (`test/pipeline/sound.test.ts`, with `FakeSound`, fake media helpers from `test/helpers/media.ts`, as `test/pipeline/smooth.test.ts` does): a 4-scene run with `sceneSound` true buys one sound per scene after `fit`; each call carries that scene's `soundPrompt`, the fixed negative prompt, its own seed (four distinct seeds), the guidance of its action level, `audio_length` = the scene's length capped at 10; a still scene's input video exists, is silent and as long as its scene; the stored wav's integrated loudness is within 1 dB of −26 LUFS for a loud and a quiet fake answer; a second `resume` buys nothing; `reroll` of scene 2 `sound` buys only scene 2 with a new seed; a run without `sceneSound` buys nothing; a run whose script has no `soundPrompt` buys nothing; `render.sfx` false buys nothing; the cost estimate counts the cold start once (first scene); `models.sound` is recorded; the run without the endpoint or rates is made without sound and the log line says why.

- [ ] **Step 2: Run, see them fail.**

- [ ] **Step 3: Implement.** `src/sound.ts` as specified. Config: `foleyRates(p)` returns `{ usdPerSec, secPerClipSec, coldStartSec } | undefined` (all three set); a message constant `FOLEY_RATES_MISSING`. The stage (`src/stages/sound.ts`), after reading `src/stages/interpolate.ts` and `fit.ts` in full:

```ts
export const soundStage: Stage = {
  name: "sound",
  perScene: true,
  paid: true,
  appliesTo: (m, i) => m.request.sceneSound === true && m.request.render.sfx && Boolean(requireScript(m).scenes[i]?.soundPrompt),
  deps: (_m, scene) => [{ stage: "fit", scene }],
  // inputsFor: the hash covers everything that changes the sound: the model name, the prompt, the seed (with the scene's nonce), guidance, steps, length and the fitted video's sha256
  // outputsFor: [paths.sound(scene)]
  // estimateCostUsd: soundCost(prices, soundSeconds(sceneSeconds), firstSoundScene === scene)
  // run: build `sound/input_NN.mp4` (below), runProviderJob(ctx, scene, "sound", { provider: ctx.providers.sound, request, costUsd: estimate, … }) as interpolate does, download the wav, level it (below), store path/hash/seconds/seed/settings in `scene.sound`
};
```
The input video (`ffmpeg`, in `src/media/` beside the other helpers, pure arguments tested): a moving scene → the fitted video (`fitted/scene_NN.mp4`), a still scene → `-loop 1 -framerate 24 -i <keyframe> -t <seconds> -vf "scale=-2:480,zoompan=z='min(zoom+0.0015,1.15)':d=<frames>:s=…:fps=24"`; both end as short side 480, 24 fps, no audio (`-an`), `-crf 28`, `-pix_fmt yuv420p`, cut to `soundSeconds(...)`. Refuse (NonRetryable, clear text) a result over the 9 MB request limit. Levelling (`src/media/loudness.ts`): run `ffmpeg -i in.wav -af ebur128 -f null -`, `parseLoudness`, then `ffmpeg -i in.wav -af "volume=<gain>dB,alimiter=limit=0.8" -ar 48000 -ac 1 out.wav`; silence (`-inf`) is copied as it is with a logged warning. A scene longer than 10 s: the track is the first 10 s and gets a 0.5 s fade-out (`afade=t=out`), nothing else. `Providers.sound` comes from `RUNPOD_FOLEY_ENDPOINT` in `factory.ts` as `upscale` comes from its endpoint; `request.sceneSound` is set by `src/cli.ts run` (and by `src/providers/new-run.ts` if that is where requests are made) only when `FLOWCHAIN_SCENE_SOUND` is `on`, the endpoint is set, `foleyRates` exist and `render.sfx` is true; otherwise absent, with one log line (`scene sound is off: <the missing thing>`). `models.sound` = a short name of the endpoint's model (`"hunyuan-foley@1"`).

- [ ] **Step 4: Run** `npx vitest run test/unit/sound.test.ts test/pipeline/sound.test.ts test/pipeline test/stages test/unit/compat.test.ts test/unit/restore-provider.test.ts`, `npm run typecheck`. Then the whole `test/unit`.

- [ ] **Step 5: Commit**

```bash
git add -A src test
git commit -m "feat: a sound stage after the fit makes each scene's sound from its picture with a seed of its own, levels it to one loudness, and is bought once and rerolled alone"
```

---

### Task 4: The render plays each scene's sound

**Files:**
- Modify: `src/media/remotion/props.ts` (`audio.sound`), `src/media/remotion/layers/AudioLayer.tsx`, `src/media/remotion/timeline.ts` (pure helpers), `src/stages/build-render-props.ts`, `src/stages/render.ts` (publishes the files), `src/studio/props.ts` / the draft-preview path only to prove it gets no sound, `src/cli.ts` (`--sfx-gain` text), `web/lib/look.ts` only if its type names the removed field
- Tests: `test/unit/build-render-props.test.ts` (or the existing file; find with `ls test/*/build-render-props.test.ts`), `test/unit/timeline-sound.test.ts`, `test/media/remotion-render.test.ts` (alone), `web/test/restyle.test.ts`

**Interfaces:**
- `RenderProps.audio.sound: Array<{ src: string; from: number; frames: number; gain: number }>` (`z.object({ src, from: int ≥ 0, frames: int > 0, gain: ≥ 0 })`, default `[]`, so props from before parse).
- `timeline.ts`: `export function sceneSoundVolume(frame: number, frames: number, fadeFrames: number, speech: Range[], duckTo: number, rampFrames: number, gain: number): number` = `gain × bedVolume-like fade(frame, frames, fadeFrames) × duckVolume(globalFrame, speech, duckTo, rampFrames)` — the caller passes the scene's local frame and its `from` so the duck is read at the global frame (reuse `bedVolume` and `duckVolume`, both already in the file; `bedVolume` is the fade ramp; if the phase 12 follow-up removed it with the library, restore the 4-line ramp here: `Math.max(0, Math.min(1, f/fade, (total−f)/fade))`).
- `SOUND_MIX = { duckTo: 0.5, rampFrames: 10, fadeFrames: 6, baseGain: 0.5 }` at 30 fps, scaled by `framesAt` for the run's fps (`build-render-props.ts`, beside `BGM_MIX`); starting values, tuned by ear in Task 7.

- [ ] **Step 1: Failing tests.** `timeline-sound.test.ts`: at the first and last frame of a scene the volume is 0, at the middle it is `gain` (no speech), under speech it is `gain × duckTo`, ramps between over `rampFrames`, `fadeFrames` of 0 means no fade, and the values at 60 fps equal those at 30 fps for the same seconds (`framesAt`). `build-render-props` tests: a manifest whose scenes have `scene.sound` gives one entry per such scene with `from` = the scene's start frame, `frames` = its frames, `gain = sfxGain × SOUND_MIX.baseGain`, `src` published under `sound/`; `render.sfx = false` gives `[]`; a scene without `scene.sound` gives no entry; a manifest with none gives exactly the props it gave before apart from `audio.sound: []`; at 60 fps `from`/`frames` are doubled. The draft preview props (find `buildDraftProps`) carry `sound: []`.

- [ ] **Step 2: Implement.** `AudioLayer`: for each entry a `<Sequence from frames layout="none">` holding `<Audio src={media(entry.src)} volume={(f) => sceneSoundVolume(f, entry.frames, fade, speech, duckTo, ramp, entry.gain)} />` where the callback's `f` is local to the Sequence (Remotion semantics, already used by the phase 12 bed; verified there) and the global frame for the duck is `entry.from + f`; update the component's doc comment (narration first, music ducked, scene sounds ducked and faded). `props.ts`: replace nothing else. `build-render-props.ts`: read `m.scenes[i].sound` (path, kept under the run folder), publish `sound/scene_NN.wav`.

- [ ] **Step 3: Run** `npx vitest run test/unit/timeline-sound.test.ts <build-render-props test> web/test/restyle.test.ts web/test/names.test.ts`, then `test/media/remotion-render.test.ts` alone (≈140 s) and add one case to it (or a new small one) that renders a short video with one scene sound and checks the output has an audio stream whose peak is above silence; `npm run typecheck`, `npm run web:build`.

- [ ] **Step 4: Commit**

```bash
git add -A src test web
git commit -m "feat: the render plays each scene's own sound under the narration, faded at the cuts and ducked while it speaks"
```

---

### Task 5: The deploy knows the Foley endpoint

**Files:**
- Modify: `src/deploy/runpod.ts` (`NAMES.foley`/`foleyTemplate`, `DEFAULTS.foleyGpus`, `Existing`, `planDeploy` option `foley`, `deploy()` creating the template + endpoint "anywhere" as the upscale one, `foleyImageTag(treeHash) = f-…`), `scripts/runpod-deploy.ts` (the default image from `flowchain-foley` by `defaultImage("foley")`, `RUNPOD_FOLEY_IMAGE` override, `--no-foley`, writes `RUNPOD_FOLEY_ENDPOINT` into `.env`), `src/deploy/server.ts` if it lists provider env names, `test/unit/runpod-deploy.test.ts`
- Docs later (Task 7).

**Interfaces:** `DEFAULTS.foleyGpus = ["NVIDIA GeForce RTX 4090", "NVIDIA RTX A5000", "NVIDIA GeForce RTX 3090", "NVIDIA L4"]` (24 GB cards; **only names RunPod accepts**: reuse the exact spellings used for `upscaleGpus`, and for `NVIDIA L4` check the RunPod REST enum with a read-only `GET` of a pod/endpoint listing's schema or leave it out and say so); the template's `containerDiskInGb: 80` (the image is large), the endpoint's `executionTimeoutMs: 300_000`, `idleTimeout 30`, `workersMax 1`, `FlashBoot` off (as the others), **no network volume** (the same `anywhere` destructuring the upscale endpoint uses).

- [ ] **Step 1: Failing tests** in `test/unit/runpod-deploy.test.ts` (extend the existing fake REST): a plan with `{ foley: true }` includes a template and an endpoint step named `flowchain-foley`; the endpoint is created with the 24 GB cards, **no `networkVolumeIds` and no `dataCenterIds`**, the image tag `f-<12 hex>` from the tree hash; an existing endpoint is updated in place (not duplicated); without the option nothing about Foley is planned; the deploy's `.env` update names `RUNPOD_FOLEY_ENDPOINT` (look at how the script's pure part is tested for the other endpoints).
- [ ] **Step 2: Implement**, mirroring the upscale code path exactly; make the image's `ghcr` existence/public check (the deploy already verifies the image tags it names) cover `flowchain-foley`.
- [ ] **Step 3: Run** `npx vitest run test/unit/runpod-deploy.test.ts test/unit/doctor.test.ts`, `npm run typecheck`.
- [ ] **Step 4: Commit**

```bash
git add -A src scripts test
git commit -m "feat: runpod:deploy can create the Foley endpoint on 24 GB cards anywhere, from the image the workflow builds"
```
(**Never run `npm run runpod:deploy`**: it is the controller's, after the owner has pushed and the image exists.)

---

### Task 6: The studio

**Files:**
- Modify: `web/server/config.ts` (`Health.sound?: true` present only when true: the worker's environment has `FLOWCHAIN_SCENE_SOUND=on`, `RUNPOD_FOLEY_ENDPOINT` set and — the worker reads `prices.json`? No: **the web server and the worker's health answer never read `prices.json`**, so `sound` is true on the two settings alone and the CLI's own gate (the three prices) decides at creation), `web/server/jobs/index.ts` / `types.ts` if `StudioHealth` is mapped there, `web/lib/labels.ts` (a stage label for `sound`: the studio's words for the progress panel), `web/components/Studio.tsx` and `web/components/NewVideoForm.tsx` (the "Sound effects" switch and level: its note says the sound is made for each scene and adds to the price; shown only when `health.sound`), `web/lib/look.ts` if it names the old note, `src/studio/status.ts` (the stage's row in the progress report; done in Task 3 if mirrored from `interpolate`), `web/test/*` for each.

- [ ] **Step 1: Failing tests.** `health()` has `sound: true` only with the key pair; absent otherwise (the whole-answer health test stays untouched); the form's switch note renders only with `health.sound`; the label for `sound` is a studio word (no model or provider name: `names.test.ts` green); `draftArgs` carries `--no-sfx` when the switch is off (already) and nothing else new; with accounts the plan/price shown to the customer includes the sound stage's estimate through `amount()` (find how `interpolate`'s estimate reaches the plan: `src/studio/commands.ts` `plan` and `web/lib/credit.ts` `draftCapUsd`; the draft's cap must cover the sound stage when `sceneSound` is on or the paid run would be refused for cap — check `capFor`/`draftCapUsd` and extend it with the stage's cost the way `fps` extends it; this is the one place credit arithmetic is touched: add the tests for the new arithmetic beside the existing ones).
- [ ] **Step 2: Implement; Step 3: run** `npx vitest run web/test` files that your edits reach (health, schemas, credits, names, restyle, routes, studio components), `npm run typecheck`, `npm run web:build`.
- [ ] **Step 4: Commit**

```bash
git add -A web src test
git commit -m "feat: the studio offers scene sound where the endpoint is set, says it is made for each scene, and counts its price in the credit a video holds"
```

---

### Task 7: Documents, then the measurements (the owner's clicks)

- [ ] **Step 1: Spec.** Status → "built; the owner's steps (§11) are not done". Rewrite §4 (weights inside the image, anywhere endpoint) and §3/§5 where the plan's Rulings differ, add **§12 What was found and changed** (all seven Rulings and what the tasks found, with the parked items from the ledger).
- [ ] **Step 2: README.** A part "Scene sound": what it is; the licence's three excluded territories in the owner's words; `FLOWCHAIN_SCENE_SOUND`, `RUNPOD_FOLEY_ENDPOINT`, the three prices and how to measure them; deploy (`runpod:deploy` after a push and the workflow's build, the image is large); rollback (`FLOWCHAIN_SCENE_SOUND=off`); that runs made with the old library re-render without sound effects; remove the sound-library text and `make:sfx`.
- [ ] **Step 3: CLAUDE.md.** The never-run list gains nothing new (`runpod:deploy` is there); remove `make:sfx` from it; a layout row for `worker-foley/`; the specs table row; one sentence in "How the pipeline is built": a scene's sound is made from its `soundPrompt` by the `sound` stage; the prompt rules; the seed per scene (a fixed seed was why the trial sounded alike).
- [ ] **Step 4: Commit** `docs: the phase 14 spec and the manuals say how a scene's sound is made, priced, switched on and rolled back`.
- [ ] **Step 5 (controller, owner's click):** ask the owner (AskUserQuestion) to push (the workflow then builds `flowchain-foley`; a large image: it may take long; the package must be made public in GitHub's web UI by the owner), then to run `npm run runpod:deploy` (the controller runs it with the owner's yes; it prints its plan; the Foley endpoint is the new part). **Measurements on the real endpoint** (ask before each paid group; each is cents): (a) the same clip with three seeds and with guidance 3.5 and 5.5: download the wavs and give them to the owner to listen to; judge the seed hypothesis (are they audibly different?); (b) a 10 s and a 15 s clip: what the model does at its limit (the answer and the length); (c) seconds per clip on a warm worker and the worker's start (the job's `executionTime` and `delayTime` from RunPod's status API right after the run, as the 60 fps measurement did) → `runpodFoleyUsdPerSec` (the 24 GB flex rate: look up the current published price and cite it), `runpodFoleySecPerClipSec`, `runpodFoleyColdStartSec` in `prices.json`; (d) one whole four-scene video with `FLOWCHAIN_SCENE_SOUND=on` in the shell: cost, and the owner listens to how the layer sits under the narration; tune `SOUND_MIX` and `LOUDNESS_TARGET_LUFS` by that listening (a small commit). Record every number in spec §12 and update `web/content/measured.json`'s dated cost with the new full-video cost.

---

## Self-review

- **Spec coverage:** §2 script → Task 1; §3 stage (after fit, input video, seed/guidance/negative/length, normalize, switch and gates) → Task 3; §4 worker → Task 2 (+ Ruling 1) and Task 5 for the endpoint; §5 render and deletions → Tasks 1 and 4; §6 studio → Task 6; §7 territory → switch in Tasks 3 and 6, wording in Task 7; §8 measurements → Task 7 Step 5; §9 tests → each task; §10 parked → unchanged; §11 owner's steps → Task 7.
- **Placeholders:** none open; every "read first" names the file and what to read; the model's own function names, the Hub revision and file hashes are things the implementer looks up with the exact method given.
- **Type consistency:** `SoundRequest`, `SoundProvider`, `soundCost`, `soundSeed`, `guidanceFor`, `soundSeconds`, `parseLoudness`, `gainFor`, `scene.sound`, `request.sceneSound`, `models.sound`, `audio.sound`, `SOUND_MIX`, `sceneSoundVolume` are used with one spelling throughout; `Health.sound` is the only web-facing flag.
