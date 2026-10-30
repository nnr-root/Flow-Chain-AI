# Phase 14 — scene sound: a sound made for each scene from its picture, replacing the library

Date: 2026-10-30. Status: built; the owner's steps (§11) are not done. Where §12 differs from an earlier section, §12 wins.

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
  keyframe, a slow zoom for the scene's length. Either way the worker is sent a small copy (short side 480, 24 fps, no audio),
  because a Full HD clip would pass the request's 9 MB limit (§12, ruling 2).
- **Request to the worker:** the video, `soundPrompt`, the negative prompt, the seed, `guidance_scale`, steps, `audio_length`.
  - **Seed** for scene *i*: derived from the run's seed and *i* (so scenes differ, and a rerolled scene differs from before: its nonce
    changes the seed like the other rerolls).
  - **`guidance_scale`** from the scene's `actionLevel`: low 3.5, medium 4.5, high 5.5 (starting values, tuned by ear).
  - **Negative prompt**, always: "speech, voice, vocals, singing, music, narration, noise, distortion".
  - **Length:** the scene's seconds, at most `SCENE_SOUND_MAX_SEC` (starts at 10; the model's real limit is measured, §8): a longer
    scene gets a track for its first 10 s with a fade-out and the rest is silent (nothing is looped), never a decision that makes a
    visual shorter. A scene under 1 s asks the worker for 1 s and the track is trimmed to the scene.
- **After the answer** the audio is levelled locally by ffmpeg (integrated loudness measured with `ebur128`, a static gain to one
  target for every scene, a starting value of −26 LUFS, then `alimiter` at 0.8 with `level=false`, so a loud and a quiet result
  end alike; single-pass `loudnorm` is unreliable on 2–5 s files) and kept as `sound/scene_NN.wav`; the manifest records path, hash, seconds, the
  seed and settings used, and the charge, as the other stages do. A failed scene after its attempts is a stage failure like any
  other (resumable, nothing bought twice).
- **Switch and gates.** The stage applies only when `request.render.sfx` is true (the studio's "Sound effects", the CLI's `--no-sfx`
  turns it off: nothing is bought) **and** `FLOWCHAIN_SCENE_SOUND=on`, the endpoint is set (`RUNPOD_FOLEY_ENDPOINT`) and the three
  prices exist (`runpodFoleyUsdPerSec`, `runpodFoleySecPerClipSec`, `runpodFoleyColdStartSec`, in `prices.json`; kept while any run
  may be resumed). Without them a new run is made without sound; it says so in plain words only when the switch is on and something is missing, and
  is silent about it otherwise. The choice is frozen when the run is created (`request.sceneSound`), and a run keeps it.
- A dollar figure is never shown to a customer (`amount()`); the plan and the draft's price include the stage; `web/content/measured.json`
  (what a video costs) is re-measured by the owner after the first real run.

## 4. The worker (`worker-foley/`)

Python, in the shape of `worker-upscale/`: `Dockerfile` (torch, torchvision and torchaudio pinned to 2.8.0 through a constraints file,
the package's requirements pinned by commit, ffmpeg), `handler.py`, a contract module (zod-checked on the TypeScript side), storage
upload to the run bucket as the other workers do.
- **The weights are inside the image** (about 18 GB of model files, about 3 GB of the two encoders the program loads by name, torch:
  roughly 25–30 GB), each file checked against a pinned SHA-256 at build time. So the endpoint runs in **any data centre** with
  24 GB cards; there is no network volume, no `fetch-models` and no second volume (the picture endpoint's volume sits in one place and
  was throttled for hours on 2026-10-30). The first start on a host is slow; the deploy sets a long execution timeout.
- **The main model file (10.3 GB) is stored as two byte-range layers** (about 5.2 and 5.1 GB), because GitHub's registry limits a
  layer to 10 GB; the worker joins them into one file on its own disk at a cold start (`weights.assemble`, atomic, safe to repeat; a
  one-time copy of about 10 GB, so the container disk is set to 80 GB). A build step checks the joined hash.
- **The image is built by the workflow** (`worker-image.yml`, the `foley` job: tag `f-` + the folder's tree hash, image
  `flowchain-foley`, 120 minutes allowed, runner disk freed first), **not by an agent, and was never built or run in this phase.**
  The package must be made public by the owner in GitHub's web UI, as the others.
- The model is built once per worker and kept; a job takes the arguments of §3; the seed is set from the request (random, numpy and
  torch all) and it is **tested** that two seeds give different audio on the same input, with a fake model and with stub `torch` and
  `numpy` modules. The model program writes a fixed seed 1 itself and ignores `--audio_length`; the worker sets the seed first and
  trims after generating (generation cannot be shortened, the visual features would no longer fit the latents).
- GPU: 24 GB cards (the trial ran on one), three card names anywhere, 300 s execution timeout, one worker at most, no flash boot.
- `runpod:deploy` creates the template and the endpoint and writes `RUNPOD_FOLEY_ENDPOINT` into `.env`; no secret (public weights).
  While the default image is not in GHCR it **skips Foley with one plain line** and deploys the rest; an image named by
  `RUNPOD_FOLEY_IMAGE` that is missing is an error. `--no-foley` leaves it out.

## 5. The render

- `RenderProps.audio.sfx` (the list of cues) is replaced by `audio.sound`: for each scene with a track, `{ src, from, frames,
  gain }` (the scene's frames, as `fit` made them).
- `AudioLayer` plays each track in a `Sequence` for its scene with a short fade at both ends (6 frames at 30 fps, scaled by `framesAt`)
  so cuts never click, at `sfxGain` times a base gain, and **ducked under speech** with the same `duckVolume` the music uses (the speech
  ranges are already in the props), so narration is always first. Starting values tuned by ear in the first real runs.
- `sfxCues`, the `SFX` table, `src/sounds.ts`, `scripts/make-sfx.ts`, `assets/sfx/`, `npm run make:sfx` and the doctor's "bundled
  sounds" check are deleted; `compat.test.ts` keeps proving old runs load. **An old run made with the library, rendered again,
  has no sound effects** (nothing makes them any more); it says so in the run's page text; the hook's impact and the cut sounds are
  gone for every run. (The landing page's sound control and "Sound on the cuts" feature went with them, and the three published
  showcases lost their sound keys: visitors hear narration and music only.)
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

1. Push (the owner's click); the worker-image workflow builds `flowchain-foley` (large, may take long, and its first build may need
   fixes, §12); make the package public in GitHub's web UI; then `npm run runpod:deploy` (it prints its plan).
2. The measurements of §8, with the controller; set the three prices.
3. Set `FLOWCHAIN_SCENE_SOUND=on` in `.env` (on a server, then `npm run server:deploy`, which writes it into the worker's settings; §12).
4. Decide on offering the layer in the EU, the UK and South Korea (§7), and confirm the platform you post to accepts the audio.

## 12. What was found and changed

Built in seven tasks on `main` (no push). No provider was called and no pod started by any of them.

### Rulings of the plan (these differ from §3–§5 above and are built)

1. **Weights inside the image**, anywhere endpoint (§4 now says it). 2. **The worker is sent a small copy of the scene** (480 px
short side, 24 fps, silent). 3. **Levelling is a measured static gain plus a limiter**, not `loudnorm`. 4. **`request.sceneSound`
freezes the choice at creation.** 5. **A scene over 10 s gets 10 s of track, faded, then silence.** 6. **A draft preview has no
generated sound; runs made with the phase 12 library re-render without sound effects.** The draft note no longer says the sound
effects are real. 7. **The provider is queued like the other RunPod providers**; its answer is `{ url, costUsd?, remove? }`, and the
cost is the measured execution time at `runpodFoleyUsdPerSec`.

### Rulings of the controller

- The main weights file is two byte-range layers joined on the worker's disk at a cold start, to stay under the registry's 10 GB layer
  limit. If wrong, the cost is extra cold-start time, or the limit is in GiB and one layer would have fit.
- `models.sound` is `runpod:<endpoint>/sound-foley@1`, not a short name: a run is rebuilt from its frozen model id and so stays on the
  endpoint it was made with.
- A translated version buys each scene's sound again (a version's narration changes the lengths); it is priced through `versionCapUsd`.

### What the tasks found

- **Task 1 (script).** `soundBible` and `soundPrompt` added, plain strings; `PROMPT_VERSION` 2026-10-30.21; a real `run --draft` probe
  returned both fields. The deletions went beyond the plan: the landing page's sound control, the "Sound on the cuts" feature and the
  three showcases' sound keys went with the library (owner heads-up: the showcase videos now play with narration and music only).
  `StageContext.sfxDir` stays optional and unused only because `compat.test.ts`, which is never edited, still passes it.
- **Task 2 (worker).** The model's file is not named `_xxl`; the program needs two encoders loaded by name from the Hub, so they are baked
  in with `HF_HUB_OFFLINE=1`; its requirements pull a transformers fork and `audiotools` from GitHub, now pinned by commit. The trial's
  `torchaudio` problem is avoided by writing the wav with the standard library.
- **Task 3 (the `sound` stage).** `limiter` needed `level=false` (ffmpeg 8 re-levels otherwise: −24 instead of −26 LUFS). A scene
  under 1 s is asked as 1 s and trimmed. The default-off log line named `FLOWCHAIN_SCENE_SOUND` to every customer: now silent by
  default, `FLOWCHAIN_` names are masked in `publicLog`. The seed is the first four bytes of a SHA-256 of the run's seed, the scene and
  its nonce (a run without a seed counts from 0). `sfxGain` is not in the input hash (it is a render choice).
- **Task 4 (render).** `SOUND_MIX` lives in `timeline.ts` and is re-exported; each scene's track fades 6 frames at 30 fps at both ends
  and ducks under speech like the music. The render stage now depends on `sound` for scenes that have it.
- **Task 5 (deploy).** The planner has the Foley template and endpoint; `chooseFoleyImage` skips Foley with one line when the default
  image is not in GHCR. The NVIDIA L4 is left out of the card list because its name was not checked.
- **Task 6 (studio).** No credit arithmetic changed: every hold comes from `plan --json`, which prices the sound stage (proved by mutation:
  an estimate of 0 fails the tests). `Health.sound` is the only web-facing flag. A re-render that turns sound on for a finished video
  that never had it is refused in plain words (the CLI says "use resume"); the studio has no path to buy a finished video's missing sound.

### Facts, said plainly

- The trial of §1 ran on an **RTX 4090**.
- **The seed hypothesis is still unproven by ear**: the code shows a fixed seed 1; nobody has listened to scenes made with different
  seeds. §8 (a) does that.
- **The image has never been pushed or built.** Unverified until the first CI build: the offline cache pointer (`refs/main` written by
  hand, then offline), that the 10 GB file is served with 206 range responses (checked by headers on a small file only), that GitHub's
  10 GB layer limit is as documented, the real loader and sampler (`_load`, `_sample`), and the image size. The first build may need
  fixes.
- The real model functions are wired by name (`load_model`, `feature_process`, `denoise_process`) and untested without a GPU.

### Parked, in plain words

- A still scene's input video always zooms in, even when the render pans or zooms out (§3 said "the same camera"); mapping `camera` onto it
  is a follow-up. Durations are rounded to a tenth; the render places tracks by the scene's frames, not by `sound.seconds`.
- The cost estimate assumes 10 s a scene before the voice exists and a warm worker on a reroll or resume (as `interpolate` does).
- A translated version buys sound again (deliberate).
- An engine exception can carry paths in the worker's own text (the pipeline does not show worker text to users, as with the other
  workers); seven dev and UI packages from the model's requirements add image size; the 60 fps case in the render proves only that the
  ramp helper scales, and `AudioLayer`'s own scaling has no direct test at 60 fps.
- `web/server/actions.ts` imports `soundNotMade` from the stage module, the web server's first runtime import of a stage (it pulls ffmpeg
  and providers into the Next bundle): move `hasSceneSound` and `soundNotMade` to the pure `src/sound.ts` and re-export.
- When the sound switch is off the hidden form still sends `sfx: true` (harmless: `sceneSound` is not frozen and the Look control is
  hidden for such a run). A stale sound record (done, but its hash changed) is not caught by `soundNotMade`.
- Small test cleanups: the schema test's title claims "no maxItems" but checks only `soundBible`'s subtree for an enum; a loop's braces in
  `restyle.test.ts` are misindented; the reroll total is asserted with `toBeGreaterThanOrEqual`; two web cases only characterize
  `assertApproved`. `web:e2e` and `test:accounts` were not run (only the draft note's text changed); `store.test.ts` and the bucket group of
  `tenant-queue.test.ts` need Docker and the MinIO image, which this machine cannot pull.

### For the owner to rule on (found in review of Task 6; both older than this phase)

- **The run view sends `models` to the browser**, now including `runpod:<endpoint>/sound-foley@1`, against the rule that no surface names a
  model or an endpoint. `names.test.ts` holds sources, not payloads.
- **The `estimate_changed` refusal shows a dollar figure** ("$x.xx", since 2026-10-06), against the rule that a customer sees credits.

### Measurements (not done)

§8 (a) to (d) are the owner's click after the deploy; the numbers, the three prices and the listening decisions (`SOUND_MIX`,
`LOUDNESS_TARGET_LUFS`, the guidance values) are written here when they exist, and `web/content/measured.json` gets the new full-video
cost.
