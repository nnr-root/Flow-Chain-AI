# Phase 15 — LTX-2.5 clip engine and the speaking character: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** LTX-2.5 becomes the engine that makes a scene's clip (a new worker, a new video profile), a script may have a character who speaks (its voice, length and caption words come from its clip), and — only after the owner has watched a real run — Wan 2.2 is removed.

**Architecture:** `worker-ltx/` is a sibling of `worker-foley/` (own image, weights inside, official `ltx-pipelines` `DistilledPipeline` with long-clip windows, Whisper for the words of speech). The engine is a `VideoProfile` (`ltx25@1`), as the spec §13.4 says: `clipSec`, `costUsd`, `runOverheadUsd`, and the frame arithmetic live in `src/video-profiles.ts`; the provider (`RunpodVideo`) and the `clips` stage learn the clip's own `fps`, `hasAudio` and `words`. A speaking scene writes `scenes[i].audio` and `scenes[i].words` from its clip so `fit`, `captions` and `render` do not change (§13.2). Wan is a **separate, last, gated task**.

**Tech Stack:** TypeScript (pipeline, studio, worker), Python 3.11 (`worker-ltx`: torch 2.8, `ltx-pipelines` pinned by commit, faster-whisper), vitest, pytest, GitHub Actions for the image, RunPod REST for the deploy.

**Spec:** `docs/superpowers/specs/2026-10-31-phase15-ltx-engine-design.md` — **§13 wins over everything before it.** Read §1 (the measured spike), §5 (speech), §9 (licence), §13 first.

## Global Constraints

Copied from the spec and `CLAUDE.md`; every task includes them.

- **Nothing in this plan spends money or touches a real account by itself.** Tests use stand-ins only. The tasks that need a real call say so and stop for the owner's click: `npm run flowchain -- run …`, `runpod:deploy`, `server:setup`, `eval:prompts`, a pod. A push needs the owner's click each time (AskUserQuestion). Local commits on `main` are fine.
- **Never read or print `.env` or `deploy/server.env`; never print a token.** The owner's Hugging Face token only passes through the shell (a file the owner writes, read with `$(cat …)`), never into a log, a commit, or a prompt.
- **Never edit `test/unit/compat.test.ts`.** Manifest fields are added as **optional**; an old run folder must load.
- **Gemini's response schema:** no `enum` together with `maxItems`; `videoPrompt` and `speech` are plain strings (CLAUDE.md, phase 12 §9). After any schema change one real `run --draft` (about half a cent, the owner's click).
- **Every change to a prompt bumps `PROMPT_VERSION`** (`src/providers/prompt-version.ts`), updates `test/unit/prompt-pins.json` and adds a changelog line to `docs/superpowers/specs/2026-10-18-phase9-prompt-audit-design.md`.
- **Pure logic apart from what acts;** the pure part is tested. Comments say why. Tests are sentences about behaviour and must be able to fail.
- **No customer-facing surface names a model, a provider or a key:** add `/\bltx\b/i` and `/lightricks/i` to `INTERNAL_NAMES` (`web/lib/engines.ts`); `web/test/names.test.ts` must stay green. The word LTX may appear in `/terms` **only** as the owner words the licence notice (Task 12) and that exception is listed in the test beside Stripe.
- **Customers see credits, never dollars** (`amount()`); a speaking scene is priced as any clip of its length.
- **The worker checks what it is given** (`refusal()`, `commandKind()` in `web/server/jobs/redis.ts`); no new job kind is needed: a clip is made inside the run's `generate` job.
- **LTX is offered only while** `RUNPOD_LTX_ENDPOINT` and all three `runpodLtx*` prices are set; without them every earlier behaviour is unchanged (modes by environment).
- **No metadata is stripped from an LTX clip** (spec §9.4): a test greps the render and ffmpeg helpers for `-map_metadata` and `-fflags` with a value that removes provenance.
- **Wan stays working until Task 14.** Nothing before Task 14 deletes a Wan file, id, price or doc line.
- Commit messages: `feat:` / `fix:` / `docs:` / `test:` and one sentence saying what is now true, ending with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.

## File structure

| File | Create / modify | Responsibility |
|---|---|---|
| `worker-ltx/src/flowchain_ltx/contract.py` | create | the request, its refusals, frame and size arithmetic |
| `worker-ltx/src/flowchain_ltx/weights.py` | create | assemble layered weights at cold start (copy of foley's) |
| `worker-ltx/src/flowchain_ltx/engine.py` | create | load once; `DistilledPipeline` with windows; Whisper words; refuse CPU |
| `worker-ltx/src/flowchain_ltx/storage.py` | create | upload the mp4 to R2 (copy of foley's) |
| `worker-ltx/handler.py`, `Dockerfile`, `requirements.txt`, `tests/*` | create | handler, image, pins, pytest |
| `.github/workflows/worker-image.yml` | modify | the `ltx` job (tag `l-<tree>`), path filter |
| `src/deploy/runpod.ts`, `scripts/runpod-deploy.ts` | modify | LTX template and endpoint, card list, `chooseLtxImage`, `RUNPOD_LTX_ENDPOINT` |
| `src/config.ts` | modify | `RUNPOD_LTX_ENDPOINT`, `ltxRates`, `LTX_RATES_MISSING`, `FLOWCHAIN_SPEECH` |
| `src/providers/model-id.ts` | modify | `RUNPOD_WORKFLOWS.clipLtx` |
| `src/video-profiles.ts` | modify | profile `ltx25@1`, `ltxFrames`, `durationDep` input |
| `src/providers/runpod-providers.ts`, `types.ts` | modify | `RunpodVideo` input/output for LTX; `VideoRequest`, `VideoOutput` gain fields |
| `src/manifest/schema.ts` | modify | `videoPrompt`, `speech`, clip `fps`/`hasAudio`, `request.speech` |
| `src/providers/gemini.ts`, `prompt-version.ts`, `test/unit/prompt-pins.json`, `src/eval/cases.ts` | modify | the LTX prompt rules, the speech rules |
| `src/stages/clips.ts`, `visual.ts`, `tts.ts`, `silence.ts`, `modes.ts`, `fit.ts`, `captions.ts` | modify | the LTX clip, speaking scene, `durationDep`, fps-aware fit |
| `src/media/…`, `src/stages/build-render-props.ts`, `src/media/remotion/…` | modify | a clip's own sound as the scene's ambient |
| `web/server/config.ts`, `web/server/schemas.ts`, `web/server/actions.ts`, `web/components/NewVideoForm.tsx`, `web/lib/engines.ts`, `web/lib/labels.ts` | modify | `Health.speech`, the switch, the hidden-form rule, names |
| `web/app/(marketing)/terms/…`, `README.md`, `docs/…` | modify | the licence notice (owner-approved), the owner's manual |
| `test/…`, `web/test/…`, `worker-ltx/tests/…` | create / modify | every task's tests |

---

## Task 1: `worker-ltx` — the contract and the arithmetic (Python, pure)

**Files:** create `worker-ltx/src/flowchain_ltx/__init__.py`, `contract.py`, `worker-ltx/tests/conftest.py`, `tests/test_contract.py`. Copy the *shape* of `worker-foley/src/flowchain_foley/contract.py` and `worker-foley/tests/test_contract.py` (read both first: they show the repository's way of refusing unknown fields, bounding numbers and naming errors).

**Interfaces — Produces:**
```python
FPS = 24
MIN_FRAMES, MAX_FRAMES = 49, 361          # 2 s .. 15 s at 24 fps
SIZE_MULTIPLE = 64
class ContractError(ValueError): ...
@dataclass(frozen=True)
class ClipRequest:
    image_png: bytes; prompt: str; frames: int; fps: int; width: int; height: int; seed: int
    speech_language: str | None = None      # present = run Whisper and return words
def parse(payload: dict) -> ClipRequest: ...
def frames_for_seconds(seconds: float) -> int: ...   # nearest 8k+1 that covers it, clamped
```

- [ ] **Step 1: Failing tests** in `tests/test_contract.py`: (a) `task` must be `"clip"`; (b) any field not listed is refused with the field named; (c) `frames` must be `8k+1` within `[49, 361]` — 48, 50, 362 and 0 are refused, 49, 97, 361 accepted; (d) `fps` must be 24; (e) `width` and `height` must be multiples of 64 and each between 256 and 1920; (f) `prompt` is 1–4000 characters; (g) `image` is base64 of a PNG (the first eight bytes), not empty; (h) `seed` is an integer ≥ 0; (i) `speech_language` is `None` or one of `en`, `tr`; (j) `frames_for_seconds(2.0)` is 49, `(5.04)` is 121, `(15.0)` is 361, `(0.5)` is 49, `(20.0)` is 361, and every result satisfies `(n - 1) % 8 == 0`.
- [ ] **Step 2:** `cd worker-ltx && python -m pytest tests/test_contract.py -v` → FAIL (module missing).
- [ ] **Step 3: Implement** `contract.py`: `frames_for_seconds` is `8 * ceil((seconds * FPS - 1) / 8) + 1`, then clamped to the bounds; `parse` builds the dataclass and raises `ContractError(f"unknown field {name}")` etc.
- [ ] **Step 4:** run again → PASS.
- [ ] **Step 5: Commit** `feat: the LTX worker's request is checked field by field, and a clip's frames are 8k+1 between 2 and 15 seconds`.

## Task 2: `worker-ltx` — weights, engine, handler, image

**Files:** create `weights.py`, `engine.py`, `storage.py`, `handler.py`, `Dockerfile`, `requirements.txt`, `tests/test_weights.py`, `test_engine.py`, `test_handler.py`. **Copy and adapt** `worker-foley/src/flowchain_foley/weights.py`, `storage.py`, `handler.py` and their tests (they implement: layered-file assembly at cold start with a size check, R2 upload with a key under `flowchain/`, the RunPod serverless handler loop, and a `FakeEngine` seam for tests). Do not copy anything about video input or Foley models.

**Interfaces:**
- Consumes: `contract.ClipRequest`, `contract.parse`.
- Produces: `engine.make_clip(req) -> ClipResult(mp4_path: str, seconds: float, has_audio: bool, words: list[dict] | None)`; `handler(job) -> {"url": …, "seconds": …, "has_audio": …, "words": …}`.

- [ ] **Step 1: Failing tests.** `test_engine.py` (the model is replaced by a fake whose "pipeline" writes a short mp4 made by ffmpeg, so it needs ffmpeg like `worker-foley`'s tests): refuses a CPU with the message `LTX needs a GPU`; windows are passed `--chunk-pixel-frames 97` and `--chunk-carry-frames 25` only above 121 frames; `words` is `None` unless `speech_language` is set, and a list of `{"text","start","end"}` with `start < end` and sorted when it is; the output file has an audio stream (`ffprobe`). `test_handler.py`: an unknown field comes back as an error object, not a crash; a valid job returns the four keys; the uploaded key is under `flowchain/`. `test_weights.py`: the two-layer assembly (copy foley's cases).
- [ ] **Step 2:** run the three files → FAIL.
- [ ] **Step 3: Implement.** `engine.py` loads **once** (module global, like the voice worker): the distilled transformer, text encoder, both VAEs, the spatial upscaler, from `/models/ltx/…` (paths in one constant block), `quantization="fp8-cast"`; the Whisper model `large-v3-turbo` from `/models/whisper` (`compute_type="float16"` on cuda). It calls the pipeline's Python entry (the same arguments the CLI `python -m ltx_pipelines.distilled` takes: `--num-frames`, `--frame-rate`, `--width`, `--height`, `--seed`, `--image <png> 0 1.0`, `--prompt`, and the two `--chunk-*` flags above 121 frames) and reads the result's duration and audio stream with `ffprobe`. **The pipeline's Python API is not in this plan's reading: Step 3 begins by reading `packages/ltx-pipelines/src/ltx_pipelines/distilled.py` at the pinned commit and calling its class directly; if it only offers a CLI, call it as a subprocess and say so in a comment.**
- [ ] **Step 4:** the three test files → PASS; `python -m pytest worker-ltx/tests -q` all green.
- [ ] **Step 5: Dockerfile and requirements.** Base `runpod/pytorch:2.8.0-py3.11-cuda12.8.1-cudnn-devel-ubuntu22.04`; `torch==2.8.0`, `torchvision==0.23.0`, `torchaudio==2.8.0` pinned; `ltx-pipelines` and `ltx-core` installed from the Lightricks repository **by commit** (pin the commit that was tested on 2026-10-31: read it from `git -C /workspace/LTX-2 rev-parse HEAD` on the owner's pod session, or from the `LTX-2` clone the spike used, and write it in the Dockerfile with a comment saying why); `faster-whisper`, `boto3`, `runpod`. Weights are downloaded **at build time** with `HF_TOKEN` passed as a **build secret** (`--mount=type=secret,id=hf_token`), never an `ARG` or `ENV`, split into byte-range layers above 9 GB (copy foley's split commands, one file `diffusion_models/ltx-2.5-22b-distilled-transformer-bf16.safetensors` is about 44 GB: five layers). Build-time checks (copy foley's): every file exists with the expected size, `HF_HUB_OFFLINE=1` loads the text encoder, and `python -c "import ltx_pipelines"` and the CLI `--help` list `--chunk-pixel-frames`, `--chunk-carry-frames`, `--quantization`.
- [ ] **Step 6: Commit** `feat: worker-ltx makes a clip with its sound and the words of its speech, from the studio's own endpoint (not built or deployed yet)`.

## Task 3: The image job and the deploy planner

**Files:** modify `.github/workflows/worker-image.yml` (an `ltx` job copied from the `foley` job: tag `l-$(git rev-parse HEAD:worker-ltx | cut -c1-12)`, image `…/flowchain-ltx`, `timeout-minutes: 150`, the `hf_token` secret passed as a **build secret**, path filter gains `worker-ltx/**`); modify `src/deploy/runpod.ts`, `scripts/runpod-deploy.ts`, `test/unit/deploy-runpod.test.ts` (or the deploy test file that covers `planDeploy`: find it with `grep -ln planDeploy test`).

**Interfaces — Produces:** `NAMES.ltxTemplate = "flowchain-ltx"`, `NAMES.ltx = "flowchain-ltx"`; `DeployConfig.ltxImage?: string`, `ltxGpus?: string[]`; `DEFAULTS.ltxGpus = ["NVIDIA A100 80GB PCIe", "NVIDIA A100-SXM4-80GB", "NVIDIA L40S", "NVIDIA RTX 6000 Ada Generation", "NVIDIA A40"]`; `ltxImageTag(treeHash)` returns `l-<12>`; `chooseLtxImage(...)` mirrors `chooseFoleyImage`; `Deployed.ltxEndpointId`; the env block gains `RUNPOD_LTX_ENDPOINT`.

- [ ] **Step 1: Failing tests** for each: the plan lists the two LTX steps only when `opts.ltx`; the template body has `containerDiskInGb: 220`, `isServerless: true` and the endpoint is made "anywhere" (no network volume, no data-centre list) with `minCudaVersion: "12.8"` (copy the Foley assertions); `ltxGpus` default is the five cards in order; `ltxImageTag("abcdef0123456789")` is `l-abcdef012345`; `chooseLtxImage` with the default image missing returns a skip message and does not throw, with a named image missing throws; `RUNPOD_LTX_ENDPOINT` is in the env block only when an endpoint exists.
- [ ] **Step 2:** run → FAIL. **Step 3:** implement beside the Foley code (same functions, same order; do not refactor Foley). **Step 4:** PASS, plus `npm run typecheck`.
- [ ] **Step 5: Commit** `feat: runpod:deploy makes the LTX endpoint on any of five 48 and 80 GB cards, and skips it with one line while its image is not built`.

## Task 4: Settings and prices

**Files:** modify `src/config.ts`, `src/providers/model-id.ts`, `web/lib/engines.ts`, and tests `test/unit/config.test.ts`, `test/unit/model-id.test.ts`, `web/test/names.test.ts`.

**Interfaces — Produces:** `Env.RUNPOD_LTX_ENDPOINT`, `Env.FLOWCHAIN_SPEECH`; `ltxRates(p: Prices): { usdPerSec; secPerClipSec; coldStartSec } | undefined` (all three of `runpodLtxUsdPerSec`, `runpodLtxSecPerClipSec`, `runpodLtxColdStartSec` set and positive, else `undefined`); `LTX_RATES_MISSING` (the message, in the style of `FOLEY_RATES_MISSING`); `RUNPOD_WORKFLOWS.clipLtx = { workflow: "clip-ltx25", version: 1 }`.

- [ ] **Step 1: Failing tests:** `ltxRates` is `undefined` with any one price missing, zero, or negative, and the object with all three; `parseModelId("runpod:abc/clip-ltx25@1")` parses; `runpodModelId("abc", "clip-ltx25", 1)` round-trips; a name test: `namesInternals("LTX-2.5")` and `namesInternals("Lightricks")` are true.
- [ ] **Step 2–4:** implement, PASS, typecheck. **Step 5: Commit** `feat: LTX has its endpoint, its three measured prices and a workflow id, and its name is an internal one`.

## Task 5: The video profile `ltx25@1`

**Files:** modify `src/video-profiles.ts`; test `test/unit/video-profiles.test.ts` (extend; find its present name with `ls test/unit | grep video`).

**Interfaces — Produces:**
```ts
export const LTX_FPS = 24;
export const LTX_MIN_FRAMES = 49, LTX_MAX_FRAMES = 361;
export function ltxFrames(narrationSec: number): number;      // 8k+1, covers narration / MAX_STRETCH, clamped
// VideoProfileId gains "ltx25@1"; VIDEO_PROFILES["ltx25@1"]: clipSec = ltxFrames(s) / LTX_FPS;
// costUsd(p, clipSec) = round4(clipSec * ltxRates(p).secPerClipSec * ltxRates(p).usdPerSec);
// runOverheadUsd = round4(coldStartSec * usdPerSec); clipHeight: 640 (the SHORT side, as for Wan's 480/720; the provider derives the long side 1152 from the picture's orientation)
```
`MAX_STRETCH` stays 1.25 (the fit step's largest stretch; the same rule as `wanFrames`).

- [ ] **Step 1: Failing tests:** `ltxFrames` for every whole narration second from 1 to 20 and for 0.3: the result is `8k+1`, between 49 and 361, `frames/24 * 1.25 >= min(narration, 15*1.25)` for narrations up to 18.75 s, and **never** below 49; a narration over 18.75 s returns 361 (the scene is chained); the profile's `costUsd` with prices `{ runpodLtxUsdPerSec: 0.00016, runpodLtxSecPerClipSec: 29, runpodLtxColdStartSec: 120 }` for a 5.04 s clip is `round4(5.04 * 29 * 0.00016)`; without prices it throws `LTX_RATES_MISSING`; `videoProfileOf("ltx25@1").id`; an old manifest with `videoProfile: "wan22-480p@1"` still resolves.
- [ ] **Step 2–4:** implement, PASS. **Step 5: Commit** `feat: ltx25@1 is a video profile: 24 fps, frames in eights, two to fifteen seconds, priced by the GPU seconds a clip second takes`.

## Task 6: The provider, the clip record and the manifest

**Files:** modify `src/providers/types.ts` (`VideoRequest` gains `fps?`, `seed?`, `speechLanguage?`, `width?`, `height?`; `VideoOutput` gains `fps?`, `hasAudio?`, `words?`), `src/providers/runpod-providers.ts` (`RunpodVideo.input` branches on the target's workflow: Wan keeps today's input; `clip-ltx25` sends the contract of Task 1; `output` reads `has_audio` and `words`), `src/manifest/schema.ts` (below), tests `test/unit/runpod-providers.test.ts`, `test/unit/manifest-schema.test.ts`.

**Schema additions, all optional:** `SceneSpec.videoPrompt: z.string().max(1200).optional()`, `SceneSpec.speech: z.string().max(240).optional()`; the same on `LlmSceneSpec`/`LlmOutline` **as plain required-or-empty strings (empty = none)** to stay out of the enum/`maxItems` trap; `Clip.fps: z.number().optional()`, `Clip.hasAudio: z.boolean().optional()`; `Request.speech: z.boolean().optional()` (frozen).

- [ ] **Step 1: Failing tests:** the LTX input for a 5.04 s portrait clip is `{ task: "clip", image: <base64>, prompt, frames: 121, fps: 24, width: 640, height: 1152, seed }`, with `speech_language` only when asked; the Wan input is **byte for byte what it was**; `output` returns `fps: 24`, `hasAudio: true`, and `words` as given, and for a Wan output none of the three; an old `manifest.json` with none of the new fields loads (`compat.test.ts` still passes untouched); the Gemini response schema produced for a script has no `enum` next to a `maxItems` (extend the existing guard test).
- [ ] **Step 2–4:** implement, PASS; `npx vitest run test/unit/compat.test.ts`. **Step 5: Commit** `feat: a clip may carry its own frame rate, its sound and the words of its speech, and a scene may carry a prompt written for LTX and a sentence to be spoken`.

## Task 7: The prompts (script step)

**Files:** modify `src/providers/gemini.ts` (`sceneRules` and the outline), `src/providers/prompt-version.ts` (bump to the next number after `2026-10-31.22`: `2026-10-31.23`), `test/unit/prompt-pins.json` (re-pin as `prompt-pin.test.ts` instructs), the phase 9 spec changelog, `src/eval/cases.ts` (three cases: a speaking scene, a non-speaking scene with no `speech`, a scene that must not ask for a cut or a widescreen look).

**Rules to write (these are the contract; the words may be tuned by the eval, the rules may not):** `videoPrompt` is one flowing paragraph in the present tense naming who does one action in what order, the camera, the light, and a last sentence beginning `Audio:`; it never asks for a cut, a shot sequence, "cinematic", "film", "widescreen", "letterbox" or "black bars"; it says what must **not** move when a person stays still; it repeats the scene's `soundPrompt` ideas inside `Audio:`. `speech` is empty unless the request allows speech (the prompt receives a boolean) and the scene is one where an invented person talks to the camera; at most two scenes, one speaker; at most 14 words (counted with `src/voice/words.ts`, never `split(/\s+/)`); written in the video's language; the `videoPrompt` of that scene quotes the sentence and says "lips moving precisely with every word".

- [ ] **Step 1: Failing tests** (pure, no Gemini): `prompt-pin.test.ts` fails with the old version; a rules test asserts the prompt text contains the forbidden-word list and the `Audio:` rule; an input-builder test shows `speech` rules are **absent** from the prompt when `request.speech` is false.
- [ ] **Step 2–4:** implement; PASS. **Step 5: Commit** `feat: the script step writes a prompt for LTX in one paragraph with its sound, and may give one invented person a short sentence to say`.
- [ ] **Step 6 (the owner's click):** one real `npm run flowchain -- run … --draft` after this task and after Task 6, as the schema changed (about half a cent). Record the result in the ledger. **Do not run it without the click.**

## Task 8: The `clips` stage for LTX, and a clip's own frame rate

**Files:** modify `src/stages/clips.ts`, `src/stages/visual.ts` (`motionPrompt` stays for Wan; a new `clipPrompt(script, i, …)` returns `videoPrompt` when the run's profile is `ltx25@1` and falls back to `motionPrompt` when a scene has none), `src/stages/fit.ts`, `src/media/fit.ts`, `src/media/frames.ts`, `src/stages/interpolate.ts`, `src/stages/types.ts` (`ctx.fps` stays the **video's** fps; add `clipFps(clip)`), tests `test/stages/clips.test.ts`, `test/media/fit.test.ts`, `test/stages/fit.test.ts`.

**Interfaces — Consumes:** `VIDEO_PROFILES["ltx25@1"]`, `RunpodVideo` new output. **Produces:** `scenes[i].clip = { path, sourceUrl, duration, requestedSec, fps, hasAudio }`; the seed for scene `i` is `soundSeed`-style: a stable function of the run id and scene index (reuse `src/sound.ts`'s `soundSeed` so the two cannot drift; import it, do not copy).

- [ ] **Step 1: Failing tests (stages, with `test/fakes/` providers; add a fake LTX video provider that returns a 24 fps clip with audio, made by ffmpeg like the other fakes):** a run on `ltx25@1` asks the provider for `fps 24`, a size 640×1152, the scene's `videoPrompt`, a stable seed; the clip record carries `fps: 24` and `hasAudio: true`; a scene with no `videoPrompt` falls back to the motion prompt; `fit` of a 24 fps clip and of a 16 fps clip each yield the scene's frame count at the video's fps (frame-exact, audio-driven: the visual never decides a duration); the **seam frame** of a 24 fps clip is its last shown frame; `interpolate` reads the clip's fps (a 24 fps input is refused until Task 13's measurement unless `--fps 60` is off).
- [ ] **Step 2–4:** implement, PASS; **`npx vitest run test/stages test/media`** whole directories (a skipped test proves nothing: read the summary). **Step 5: Commit** `feat: the clips stage asks LTX for a scene with the prompt written for it and a seed of its own, and fit and seams read the clip's own frame rate`.

## Task 9: The speaking scene

**Files:** modify `src/stages/tts.ts`, `src/stages/silence.ts` (`appliesTo` false for a scene with `speech`), `src/stages/visual.ts` (`durationDep(m, k)`, `isSpeaking(m, i)`; every caller that built `{ stage: "silence", scene: k }` for a duration now calls `durationDep`), `src/stages/clips.ts` (the speaking branch), `src/stages/modes.ts` (a speaking scene is always Mode 1), `src/stages/captions.ts` (words come from `scenes[i].words`), `src/stages/require.ts`, tests `test/stages/speech.test.ts`, `test/stages/clips.test.ts`, `test/pipeline/…`.

**Behaviour (spec §4, §5, §13.2–13.3):** for a speaking scene the `clips` stage (a) does **not** depend on its own `silence`; (b) makes the clip with `speechLanguage` set and the sentence inside the prompt; (c) extracts the clip's audio to `audio/scene_<n>.wav`, trims its silence with the code `silence` uses, and writes `scenes[i].audio = { path, duration }` and `scenes[i].words = result.words`; (d) **fails with a message that names the scene** when the trimmed speech is longer than 6.5 s or has no words ("scene 3's sentence does not fit; the script wrote too many words") — no retry, the provider job is already recorded; (e) every later duration reader goes through `durationDep`.

- [ ] **Step 1: Failing tests (fake provider returns a clip whose audio is a known tone with silence at both ends, and `words`):** `tts` and `silence` skip the speaking scene and still run for others; the scene's `audio.duration` equals the clip's audio length minus its trimmed silence (±1 frame at the video fps); `words` are copied; the timeline's later scene is placed **after** the speaking scene's trimmed length; **a run with no speaking scene runs its stages in exactly today's order — the plan lists the same stage/scene pairs** (compare `planRun` output against a stored list); a speaking scene that is too long fails with the scene's number in the message; the `modes` stage keeps a speaking scene at Mode 1 even when auto would choose Mode 2; `durationDep` returns `silence` for an ordinary scene and `clips` for a speaking one; `captions` of a speaking scene use the clip's words.
- [ ] **Step 2–4:** implement, PASS; run `test/pipeline` whole directory and `test/unit/compat.test.ts`. **Step 5: Commit** `feat: a scene whose character speaks takes its sound, its length and its caption words from its clip, and every other scene is made in the order it always was`.

## Task 10: Sound in the render

**Files:** modify `src/stages/build-render-props.ts`, `src/media/loudness.ts` (read; reuse), `src/media/remotion/props.ts` and `layers/AudioLayer.tsx` only if a clip's sound needs a field the Foley entry lacks (read first: it should not), `src/stages/sound.ts` (**unchanged unless a test below fails**), tests `test/media/…`, `test/stages/build-render-props.test.ts`.

**Behaviour (spec §6):** for a scene whose clip `hasAudio` and that has no Foley sound, the clip's audio is extracted (`ffmpeg -vn`, **no `-map_metadata -1`**), levelled to `LOUDNESS_TARGET_LUFS` (−26, ambient) by the existing loudness code, and put in `audio.sound` exactly as a Foley sound is; a **speaking** scene gets **no ambient entry at all**: its voice already is the scene's audio (Task 9 wrote `scenes[i].audio` from the clip), played and levelled as any voiceover, so the clip's sound is never added a second time (ruling, ledger preflight); a scene with Foley sound keeps it and the clip's sound is ignored for it (Foley wins until the owner decides, spec §6.3); `FLOWCHAIN_SCENE_SOUND=off` still means no ambient sound for ordinary scenes, and a speaking scene keeps its voice because that is its audio, not a sound entry.

- [ ] **Step 1: Failing tests:** each of the cases above (including: a speaking scene yields no `audio.sound` entry); a **metadata test** greps `src/media/*.ts` and `src/stages/*.ts` for `map_metadata`, `-fflags`, `+bitexact` and `-metadata` flags that remove provenance and fails if one is applied to an LTX clip's path (list the allowed uses by file and line in the test, as the names test does for its exceptions).
- [ ] **Step 2–4:** implement, PASS. **Step 5: Commit** `feat: a clip's own sound plays under the narration like a scene's sound, a speaking scene's voice is its audio, and no step strips what a clip carries`.

## Task 11: The studio

**Files:** modify `web/server/config.ts` (`Health.speech?: true`, present only while LTX is on and `FLOWCHAIN_SPEECH` is `on`, and learned by the web app from the worker's health like `Health.sound`), `web/server/schemas.ts`, `web/server/actions.ts` (`draftArgs` adds `--speech` or `--no-speech`), `src/cli.ts` (the `--speech` / `--no-speech` flags, frozen into `request.speech`), `web/components/NewVideoForm.tsx` (the switch "Let a character speak", off by default, a help line: "the voice can differ between scenes"), `web/lib/labels.ts`, `web/worker/series.ts` (a series recipe's `speech` is kept; old recipes without it mean off), tests `web/test/health.test.ts`, `web/test/new-video-form.test.tsx`, `web/test/actions.test.ts`, `web/test/names.test.ts`, `test/unit/cli.test.ts`.

- [ ] **Step 1: Failing tests:** `Health.speech` is absent without the endpoint, the three prices or the switch; the form shows the switch only with `speech: true`; **when speech is not offered the form sends `speech: false` and `draftArgs` carries `--no-speech`** (the hidden-form rule of phase 14 §6); the CLI refuses `--speech` while `ltxRates` is missing, with `LTX_RATES_MISSING`; a series recipe saved before this phase loads with speech off; `names.test.ts` passes with the new internal names and the form's text contains neither "LTX" nor "Lightricks".
- [ ] **Step 2–4:** implement, PASS; run `npx vitest run web/test` as a whole directory; with the local database up, the account tests **ran** (read the summary; a skip proves nothing). **Step 5: Commit** `feat: the new-video form can let a character speak while the studio can make it, and a recipe saved before it still means no speech`.

## Task 12: Licence notice, README, docs (the owner approves the text)

**Files:** modify `web/app/(marketing)/terms/page.tsx` (or its content file: find with `ls web/app/\(marketing\)/terms`), `README.md` ("Clips with LTX": setup, `fetch`/build, the three prices to measure, the territory and competition notes, rollback), `CLAUDE.md` (the "How the pipeline is built" paragraph for the engine, the speech rule, and the row in the layout table for `worker-ltx/`), `docs/superpowers/specs/…phase15…` (a new §14 only if something is found).

- [ ] **Step 1:** write **a draft** of the licence notice for `/terms`: the Use-based restrictions of Attachment A (items 1–20, in the licensor's words, not paraphrased) inside the studio's acceptable-use section, the sentence that content may be machine made and is marked so, and the sentence that the engine is subject to a third party's licence (without a model name outside the notice itself). **Do not publish it: put it in `docs/superpowers/specs/phase15-terms-draft.md`, commit, and ask the owner to approve the words through AskUserQuestion before it goes into `/terms`.** The test that exempts the notice from `names.test.ts` is added only with the approved text.
- [ ] **Step 2:** README and CLAUDE.md edits (plain sentences, the density of the neighbouring paragraphs).
- [ ] **Step 3: Commit** `docs: the owner's manual and the project guide describe the LTX engine, speech and the licence's conditions; the terms text waits for the owner's approval`.

## Task 13: Everything the owner must do, as a checked list

This task writes no code. It ends the implementation part and **stops**.

- [ ] Write `docs/superpowers/specs/…phase15…` §14 "Owner steps in order": (1) the licence email, (2) approve the terms text, (3) build the image (push, CI; the Hugging Face token as a build secret), (4) `RUNPOD_LTX_IMAGE`-or-default `npm run runpod:deploy`, (5) `npm run server:setup` for the worker's settings (`RUNPOD_LTX_ENDPOINT`, `FLOWCHAIN_SPEECH=on`), (6) measure the three prices with one four-scene run and one run with a speaking scene (the owner's click, tavan 1 USD each), set `prices.json`, (7) update `web/content/measured.json` with the new full-video cost, (8) watch and listen (Desktop folders), (9) decide Foley and Wan. Commit it.
- [ ] Update `phase15-ltx-engine-pending.md` in the memory directory with the state.
- [ ] **STOP. Report to the owner** and wait. Task 14 does not start by itself.

## Task 14: Remove Wan — only after the owner's yes (gated)

**Gate:** the owner has (a) run a real LTX video, (b) watched and listened, (c) said "remove Wan" in so many words. Without all three, **do nothing**.

**Files:** delete `workers/` (the Wan worker, its image job in `worker-image.yml`, its tests), remove `clip-wan22-*` from `RUNPOD_WORKFLOWS` (the ids move into the `retired` handling of `parseModelId`: a `clip-wan22-*` id parses to `{ provider: "retired" }`), the two `wan22-*` profiles' **prices** (their ids stay in `VideoProfileId`, as `kling-*` do, **and `wanFrames` and each Wan profile's `clipSec` stay**: an old run's clips stage hash includes `requestedSec`, and a changed hash would make a free re-render stale; only their `costUsd` becomes a refusal), the Wan prices from `src/config.ts` (the keys stay readable and ignored), the Wan paragraphs of the README and CLAUDE.md, and the deploy planner's Wan endpoint and template; `git tag wan-last` on the commit **before** this task.

- [ ] **Step 1: Tests first:** an old run (a fixture with a `clip-wan22-480p@1` model id) loads, re-renders for free, and a clip that would have to be bought says why it cannot; `compat.test.ts` untouched and green; the deploy plan has no Wan steps; `grep -ri wan22 src web` finds only the retired-id handling and its tests.
- [ ] **Step 2–4:** remove, run `npm run typecheck`, then `npx vitest run` by directory (`test/unit`, `test/stages`, `test/media`, `test/pipeline`, `test/db`, `web/test`) — the whole suite takes ten minutes and its timing tests need re-running alone before a failure is believed.
- [ ] **Step 5: Commit** `feat: Wan 2.2 is removed: an old run still re-renders, and the tag wan-last is the way back`.

## Final review

After Task 13 (and again after Task 14 if it runs): one whole-branch review on the most capable model, one fix wave, rulings recorded in `.superpowers/sdd/…/progress.md`, then the spec gains §14 (what was found) and the memory file is updated.

## Self-review (written 2026-10-31)

- **Spec coverage:** §0 (engine, speech, Foley, Wan) → Tasks 5–9, 10, 14; §1 (evidence) is background; §2 (worker, cards, lengths, sizes) → Tasks 1–3, 5; §3 (ids, manifest) → Tasks 4, 6; §4 (prompt, timing) → Tasks 7, 8, 9; §5 (speech) → Tasks 7, 9, 11; §6 (sound) → Task 10; §7 (prices, studio) → Tasks 4, 5, 11; §8 (Wan, way back) → Task 14; §9 (licence) → Tasks 10 (metadata), 12 (terms), 13 (email); §10 (tests) → inside each task; §11–12 → Task 13; §13 → Tasks 1, 2, 5, 8, 9.
- **Known gap on purpose:** the 60 fps path (§8, §11.6) is refused for an LTX run in Task 8's interpolate test until the owner's measurement; it is **not** built here.
- **Known gap on purpose:** the exact Python entry of `ltx-pipelines` is read in Task 2 Step 3, not guessed here.
- **Type consistency:** `ltxFrames` (Task 5) is the TypeScript twin of `frames_for_seconds` (Task 1); both clamp 49–361 and produce `8k+1` — Task 6's input test asserts the worker's refusals are never reached by the TypeScript side.
