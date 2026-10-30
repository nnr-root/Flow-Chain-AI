# Phase 14 — scene sound: a sound made for each scene from its picture, replacing the library

Date: 2026-10-30. Status: design, not built.

## 0. Where this sits

Phase 12 (scene sound effects) built a closed library of 17 synthesized sounds the script could name. The owner listened and
called them bad ("berbat"), and asked for sound **made for each scenario** instead of a library (2026-10-30). This phase replaces
the library (phase 12 spec §1–§2, now superseded; its §8 and §9 stand).

Decisions of the owner (design conversation, 2026-10-30):

- **A sound layer for each scene**, laid under the whole scene, not single timed hits.
- **The old sounds go**: the 14 synthesized scene sounds, the three edit sounds (hook impact, cut whoosh and pop), the script's
  `soundCues`, and `make:sfx`. One mechanism.
- **The engine is HunyuanVideo-Foley on the studio's own RunPod**, after reading what each engine's licence allows (§1). The owner
  chose it knowing its licence excludes three territories.
- After listening to a trial (§1): "not bad, but better: not always the same sound; vary the sounds and/or their settings, and make
  them agree with each other, because the present one is too monotonous."

## 1. What was found first (the trial, 2026-10-30)

- **Licences.** MMAudio's checkpoints are CC-BY-NC 4.0 and ThinkSound's and TangoFlux's are non-commercial: none can be used by a
  product that sells credit. **HunyuanVideo-Foley** is under the Tencent Hunyuan Community License: commercial use allowed, but "THIS
  LICENSE AGREEMENT DOES NOT APPLY IN THE EUROPEAN UNION, UNITED KINGDOM AND SOUTH KOREA"; outputs may not be used to improve another
  AI model; above 100 million monthly active users a separate licence is needed; the licence text goes with any distribution. The
  owner accepts this; §7 keeps it switchable. ElevenLabs' sound effects (hosted, text only) were the licence-clean alternative and
  stay a possible second engine.
- **Quality and time.** On three of the studio's clips (a wide storm shot, a figure climbing stairs, a still-picture video) on an RTX
  4090 (24 GB) without offload: 53–56 s a clip including loading the model (about 18 GB of weights); the audio came out at the video's
  length, 48 kHz mono; levels differed a lot (one clip's peak at −0.9 dB, another's mean at −32.5 dB). Judged "not bad".
- **Why it was monotonous (a cause found in its code, not yet proven by ear).** `infer.py` sets the seed to a fixed 1
  (`set_manual_seed(1)`): every scene of the trial started from the same noise. The other settings are open: `guidance_scale`
  (default 4.5), `num_inference_steps` (50), `neg_prompt`, `audio_length`. The worker built here sets the seed per scene (§4).
- **The package needs torch and torchaudio 2.8.0**: with 2.11 (what pip picked) saving a wav fails ("TorchCodec is required").

## 2. The script writes a sound bible and a sound for each scene

- `Script` gains `soundBible` (string, English, at most 300 characters): the video's sound palette, written once before the scenes
  (like `styleBible`, so the model settles it first): the place and time as sound, and three to five recurring elements, e.g. "a
  lighthouse on a storm coast: wind, surf on rock, stone echo, brass machinery, a creaking iron stair".
- Every scene gains `soundPrompt` (string, English, at most 200 characters): what is heard in that scene's place, **built from the
  palette and specific to the scene** (what moves, what it touches, how far, how loud). Rules in the prompt: no speech, voices, singing
  or music; concrete sources and materials; scenes differ from one another in what leads (wind, then footsteps and echo, then fire)
  while the palette keeps them one place; a scene with nothing to hear gets a quiet room tone, never an empty prompt.
- **Both fields are plain strings with no enum and no `maxItems`** (the lesson of phase 12 spec §9: Gemini refuses some schema
  combinations as a whole). Both are optional when stored: a script from before has neither and its runs get no sound stage.
  `LlmScript` requires them. `soundCues`, `SCENE_SOUNDS` and the phase 12 vocabulary are deleted; stored scripts that carry
  `soundCues` still load (an unknown key is dropped by zod).
- `PROMPT_VERSION` is bumped with the pins and the changelog line; **after the schema change a real `run --draft` (about half a cent)
  is run before it is called done**.

## 3. The pipeline: a `sound` stage

- A new per-scene paid stage `sound`, **after `fit`** (it needs the scene's final picture at exactly the scene's length) and before
  `captions`; in `StageName`, `STAGES` and `REROLLABLE`. It follows `interpolate` (src/stages/interpolate.ts) as its template:
  `appliesTo`, `deps` on `fit`, `inputsFor` (the hash), `outputsFor`, `estimateCostUsd` (with the worker's start counted once, on the
  first scene), `run` through `runProviderJob` so a submitted job is written down before it can be lost.
- **Input video.** A moving scene: its fitted clip. A still scene (no clip): a short silent video made locally by ffmpeg from the
  keyframe, a slow zoom for the scene's length (the same camera the render will use, so the sound follows what is seen).
- **Request to the worker:** the video, `soundPrompt`, the negative prompt, the seed, `guidance_scale`, steps, `audio_length`.
  - **Seed** for scene *i*: derived from the run's seed and *i* (so scenes differ, and a rerolled scene differs from before: its nonce
    changes the seed like the other rerolls).
  - **`guidance_scale`** from the scene's `actionLevel`: low 3.5, medium 4.5, high 5.5 (starting values, tuned by ear).
  - **Negative prompt**, always: "speech, voice, vocals, singing, music, narration, noise, distortion".
  - **Length:** the scene's seconds, at most `SCENE_SOUND_MAX_SEC` (starts at 10; the model's real limit is measured, §8): a longer
    scene is made in the first 10 s and the rest holds the sound's tail faded, never a decision that makes a visual shorter.
- **After the answer** the audio is normalized locally by ffmpeg (`loudnorm`, a single target for every scene, a starting value of
  −26 LUFS, so a loud and a quiet result end alike) and kept as `sound/scene_NN.wav`; the manifest records path, hash, seconds, the
  seed and settings used, and the charge, as the other stages do. A failed scene after its attempts is a stage failure like any
  other (resumable, nothing bought twice).
- **Switch and gates.** The stage applies only when `request.render.sfx` is true (the studio's "Sound effects", the CLI's `--no-sfx`
  turns it off: nothing is bought) **and** `FLOWCHAIN_SCENE_SOUND=on`, the endpoint is set (`RUNPOD_FOLEY_ENDPOINT`) and the three
  prices exist (`runpodFoleyUsdPerSec`, `runpodFoleySecPerClipSec`, `runpodFoleyColdStartSec`, in `prices.json`; kept while any run
  may be resumed). Without them a new run is made without sound and says so; a run keeps what it was made with.
- A dollar figure is never shown to a customer (`amount()`); the plan and the draft's price include the stage; `web/content/measured.json`
  (what a video costs) is re-measured by the owner after the first real run.

## 4. The worker (`worker-foley/`)

Python, in the shape of `worker-picture/`: `Dockerfile` (torch and torchaudio pinned to 2.8.0, the package's requirements, ffmpeg),
`handler.py`, a contract module (zod-checked on the TypeScript side), storage upload to the run bucket as the other workers do.
- Weights (about 18 GB) on the network volume in the endpoint's data centre, fetched by the deploy like FLUX 3's; the repository is
  public. The volume has room for them (checked at plan time; the deploy refuses when it does not).
- The model is built once per worker and kept; a job takes the arguments above; the seed is set from the request (the trial's fixed 1
  is the cause of §1, so it is **tested** that two seeds give different audio on the same input, with a fake model).
- GPU: 24 GB cards (the trial ran on one); the model's own offload flag as a fallback.
- An image tag `f-` + the folder's tree hash, built by the existing worker-image workflow, packages public as the others.
- `runpod:deploy` creates the endpoint and writes `RUNPOD_FOLEY_ENDPOINT` into `.env`; no secret (public weights).

## 5. The render

- `RenderProps.audio.sfx` (the list of cues) is replaced by `audio.sound`: for each scene with a track, `{ src, from, frames,
  gain }` (the scene's frames, as `fit` made them).
- `AudioLayer` plays each track in a `Sequence` for its scene with a short fade at both ends (6 frames at 30 fps, scaled by `framesAt`)
  so cuts never click, at `sfxGain` times a base gain, and **ducked under speech** with the same `duckVolume` the music uses (the speech
  ranges are already in the props), so narration is always first. Starting values tuned by ear in the first real runs.
- `sfxCues`, the `SFX` table, `src/sounds.ts`, `scripts/make-sfx.ts`, `assets/sfx/`, `npm run make:sfx` and the doctor's "bundled
  sounds" check are deleted; `compat.test.ts` keeps proving old runs load. **An old run made with the library, rendered again,
  has no sound effects** (nothing makes them any more); it says so in the run's page text; the hook's impact and the cut sounds are
  gone for every run.
- Both the landing page's restyle and the studio's draft preview reach the new props through `assembleRenderProps` as before
  (`web/test/restyle.test.ts` holds this). A draft preview has no generated sound (nothing is bought for a preview).

## 6. The studio

The form's "Sound effects" switch and level stay and mean this layer; its note says it is made for each scene and adds to the price
(in credits). It is offered only where the endpoint, the prices and `FLOWCHAIN_SCENE_SOUND=on` exist (the health answer carries a
`sound: true` only when true, like `smooth`; the web never reads `prices.json`). No surface names a model, a provider or a place the
licence excludes. The studio's own parts get no name (`web/lib/engines.ts` lists).

## 7. Territory, honestly

The licence does not apply in the EU, the UK or South Korea. The studio's operator is outside them, but customers may not be. This
design does not decide that: it makes the layer **one switch** (`FLOWCHAIN_SCENE_SOUND`) and never makes a run depend on it (a run
without sound is complete). The owner decides whether to offer it to users there (§11, step 4).

## 8. Measurements, the owner's click

After the build, the controller asks and runs, on the real endpoint: (a) the same clip with three seeds and with two guidance values:
are they audibly different and do they suit the picture (the owner listens); (b) the longest scene the model can make
(a 10 s clip; a 15 s clip) and what it does beyond its limit; (c) seconds a clip on a warm worker and the worker's start, for the three
prices; (d) a whole four-scene video with sound, its cost and how the layer sits under the narration. The prices are written only
after (c).

## 9. Tests (none reaches a provider)

Script schema accepts and requires the two strings, refuses a missing `soundPrompt` in a Gemini answer, loads a script with
`soundCues` and none; the prompt carries the bible rule and the rules (no speech or music; differ between scenes; room tone) and
`PROMPT_VERSION` moves; the `sound` stage's hash, deps, cost (first scene carries the start), gates (switch, prices, endpoint,
`render.sfx` off), reroll of a scene (new seed), resume (no second purchase), a still scene's local video; the loudness step on a
loud and a quiet fixture ends within a decibel of the target; the worker's contract and its seed test; props and `AudioLayer`
(fades, ducking, scene boundaries, 30 and 60 fps frames); the deletion of the library leaves `compat`, `restyle`, `names`, the
route-flag test and the health whole-answer test green; the real `run --draft` probe after the schema change (owner-click-free,
a cent) is run by the controller.

## 10. Out of scope, parked

A second engine (ElevenLabs sound effects) behind the same provider interface; music; narration-synchronized hits; a separate
ambience bed spanning a group of scenes in one place (the sound bible makes scenes agree in character; making the ambience
literally continuous across cuts is a later step if listening shows it is needed); sound for the studio's draft preview;
retrofitting sound onto runs that exist.

## 11. The owner's steps after the build

1. `npm run runpod:deploy` (the Foley image is built by the worker-image workflow after a push; the deploy prints its plan).
2. The measurements of §8, with the controller; set the three prices.
3. Set `FLOWCHAIN_SCENE_SOUND=on` in `.env` and on the worker.
4. Decide on offering the layer in the EU, the UK and South Korea (§7), and confirm the platform you post to accepts the audio.
