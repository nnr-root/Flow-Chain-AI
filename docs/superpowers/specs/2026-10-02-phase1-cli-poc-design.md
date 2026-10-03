# Phase 1 — CLI Proof of Concept: Design Spec

- **Date:** 2026-10-02
- **Status:** Approved (brainstorming sections 1–4)
- **Scope:** Phase 1 of the Flow-Chain-AI roadmap only. Phases 2–4 get their own spec → plan cycles.

## 1. Goal

A TypeScript CLI, `flowchain`, that turns a topic into a finished short-form video and proves the
risky parts of the product before any web/queue infrastructure exists:

1. The **Chain of Continuity** (Mode 1): the last frame viewers see of clip N (its *seam frame*, §4.7)
   seeds clip N+1.
2. **Cinematic Static FX** (Mode 2) as a cheap Ken Burns fallback, mixable per scene (hybrid).
3. **Auto-silence removal** without audio/video drift.
4. **Word-by-word captions** synced to the voiceover.
5. **Resumable, cache-aware, scene-granular** execution — the seed of Phase 4's scene re-roll.

### Non-goals (Phase 1)

Remotion, transitions (hard cuts only), SFX, Redis/BullMQ, any web UI, Supabase, payments,
thumbnails/SEO, dubbing, social publishing. Exception: optional BGM with sidechain ducking (`--bgm`).

## 2. Decisions

| Topic | Decision |
|---|---|
| Language/runtime | Node 25 + TypeScript, executed via `tsx` (no build step), npm |
| LLM | Gemini via `@google/genai`, JSON-schema structured output. Default model `gemini-flash-latest` (rolling alias), overridable via `GEMINI_MODEL` |
| TTS | ElevenLabs `POST /v1/text-to-speech/{voice_id}/with-timestamps`, one request per scene with `previous_text` / `next_text` |
| Image | fal.ai `fal-ai/flux/dev` with explicit `{width, height}` |
| Img2Vid | fal.ai `fal-ai/kling-video/v2.1/standard/image-to-video` (default; swappable to Kling 2.6/3.0 or MiniMax/Hailuo via config) |
| Media | System `ffmpeg`/`ffprobe` ≥ 6 with libass + libx264 |
| Output | `--aspect 9:16` (1080×1920, default) or `16:9` (1920×1080), 30 fps, H.264 + AAC |
| Pipeline | Staged, resumable, on-disk manifest; paid outputs cached by input hash |

All model IDs live in config, never in stage code. The model IDs used by a run are frozen into its
manifest at creation, so resuming never silently switches models.

## 3. Core Principle: Audio Drives Timing

TTS and silence trimming happen **before** any video exists. Each scene's trimmed audio duration is
the authoritative scene length; every video clip is fitted to it. This removes the spec-level
contradiction of trimming audio after fixed-length (5 s / 10 s) Img2Vid clips already exist.

## 4. Pipeline

```
flowchain run --topic "…" --aspect 9:16 --scenes 4 [--mode auto|1|2 | --modes 1,2,1,1] [--bgm file]

runs/<runId>/manifest.json   ← single source of truth, atomically rewritten after every stage

1 script     Gemini → Script {title, styleBible, scenes[]}
2 tts        ElevenLabs per scene → audio/scene_N.raw.mp3 + character alignment → words
3 silence    silencedetect → keep segments → audio/scene_N.wav (48 kHz mono) + remapped words + duration
4 keyframes  Flux → images/keyframe_N.png for scenes that need a fresh keyframe (§4.1)
5 clips      Mode 1: Kling i2v(chain image, motion prompt, 5|10 s) → clips/clip_N.mp4
                      chain image = keyframe, or frames/seam_{N-1}.png (the last frame fitted
                      clip N-1 shows, written by clip N's own run, §4.7)
             Mode 2: zoompan Ken Burns on keyframe → clips/clip_N.mp4 at exact frame count
6 fit        every clip → fitted/scene_N.mp4: exact frame count, output size, 30 fps, no audio
7 captions   global word timeline → captions.ass
8 assemble   concat video + concat audio (+ BGM duck) + burn captions + loudnorm → final.mp4
             + chain.png contact sheet
```

### 4.1 Keyframe rule

Scene `i` gets a fresh Flux keyframe iff **any** of:

- `i == 0`
- `mode[i] == 2`
- `script.scenes[i].shot == "cut"`
- `mode[i-1] == 2`

Otherwise (Mode 1, `shot == "continue"`, previous scene Mode 1) its chain image is the seam frame of
clip `i-1`, `frames/seam_{i-1}.png` (§4.7). A "chain segment" is a maximal run of scenes starting at a keyframe scene.

### 4.2 Prompt composition

`styleBible` (artStyle, characters, palette) is prepended to every `imagePrompt` and `motionPrompt`:

```
imagePrompt' = "{artStyle}. {characters}. Palette: {palette}. {imagePrompt}"
motionPrompt' = "{motionPrompt}. Keep style consistent: {artStyle}. {characters}."
```

### 4.3 Clip duration selection (Mode 1)

`requestedSec = audioDuration <= 5.0 ? 5 : 10`. Narration is capped at 22 words (~9 s), so 10 s
covers every valid scene.

### 4.4 Frame-exact timeline (anti-drift)

Per-scene rounding to whole frames accumulates up to half a frame per scene. Instead, frame counts
come from **cumulative** boundaries:

```
start_i  = Σ_{k<i} duration_k                     (audio seconds)
frames_i = round(end_i · fps) − round(start_i · fps)
```

Total video frames = `round(totalAudio · fps)`; maximum A/V offset anywhere is ≤ ½ frame (16.7 ms
at 30 fps). Both Mode 2 generation and the fit stage target `frames_i`.

### 4.5 Fit plan (stage 6)

Let `clipDur` = source clip duration, `target = frames_i / fps`.

| Condition | FitPlan | ffmpeg |
|---|---|---|
| `clipDur >= target` | `{kind:"trim"}` | `-frames:v frames_i` |
| `target/clipDur <= 1.25` | `{kind:"slow", factor}` | `setpts=factor*PTS`, then `-frames:v` |
| `target/clipDur > 1.25` | `{kind:"slow+freeze", factor:1.25, freezeSec}` | `setpts=1.25*PTS,tpad=stop_mode=clone:stop_duration=freezeSec` |

All plans also apply `scale=W:H:force_original_aspect_ratio=increase,crop=W:H,fps=30,format=yuv420p`
followed by a safety `tpad=stop_mode=clone:stop_duration=0.5` (freeze plans: `freezeSec + 0.5`), and the
output is cut with `-frames:v frames_i`, so the frame count is exact even after fps conversion.
Mode 2 clips are generated at exactly `frames_i` and always resolve to `trim` (a no-op cut).

### 4.6 Silence removal (stage 3)

1. Convert raw MP3 → 48 kHz mono WAV.
2. `ffmpeg -i in.wav -af silencedetect=noise=-30dB:d=0.2 -f null -` → parse
   `silence_start` / `silence_end` from stderr (a trailing unterminated `silence_start` ends at file end).
3. `keepSegments`: complement of silences, then each silence is shrunk by **80 ms padding** on each
   side adjacent to speech (leading/trailing silence trimmed to 80 ms). Silences that become ≤ 0
   after padding are dropped.
4. Apply with one `atrim=start=a:end=b,asetpts=PTS-STARTPTS` per keep segment joined by `concat=n=K:v=0:a=1`
   (sample-accurate; `aselect` was measured 64 ms off because it works on whole audio frames).
5. `remapTimings(words, keepSegments)` moves word timings onto the trimmed timeline (§5.2).
6. `duration` = `ffprobe` of the output WAV (authoritative), `removedSec` = original − trimmed.

### 4.7 Seam frame (the chain image of a continuing scene)

Fit (§4.5) trims a clip longer than its audio to `frames_i`, so the raw clip's last frame is often
never shown (5.3 s of audio → 10 s clip → ~4.7 s of motion cut). A continuing scene must start from
what viewers last saw, so its chain image is the **seam frame** of clip `i-1`: the last frame that the
fitted clip `i-1` shows.

- Plan: `planFit(clipDur_{i-1}, frames_{i-1}/fps)`. For `trim` the seam is the source frame shown at
  output time `(frames_{i-1}−1)/fps`; for `slow` / `slow+freeze` the whole clip is used, so it is the raw
  last frame.
- Extraction (`media/frames.ts extractSeamFrame`, no manifest knowledge): run the **identical** fit
  filter chain (`fitFilter(plan, size, fps)`) on the raw clip and keep only output frame `frames_{i-1}−1`
  (`trim=start_frame=frames−1`, `-frames:v 1`), written as a lossless PNG at output size. This matches
  `applyFit`'s frame choice exactly for every plan without encoding the fitted clip. (An output-side
  `-ss (frames−1)/fps` seek on the raw clip was measured one source frame off for 2 of 4 consecutive
  frame counts at 24→30 fps, because the fps conversion duplicates frames.) PNG is required: the chain
  image must not accumulate JPEG artifacts.
- It is computed consumer-side in clip `i`'s `run()` (free, deterministic), right before the clip is
  submitted, to `frames/seam_{i-1}.png` (1-based file names). Clip `i-1`'s own run no longer produces a
  chain image, and the manifest stores no last-frame record.
- Media test: the seam frame is pixel-identical (frameDiff 0, flat-colour frames that x264 keeps exact)
  to the last frame of `applyFit`'s output for trim, slow and slow+freeze plans.
- `extractLastFrame` (`-sseof -1 -i clip -update 1 last.png`, falling back to `ffprobe -count_frames` +
  `select=eq(n\,N-1)`) is still used for the fitted-clip column of `chain.png`.

### 4.8 Ken Burns (Mode 2)

Oversample to avoid zoompan jitter: scale the keyframe to 4× output width first, then
`zoompan=z=…:x=…:y=…:d=frames_i:s=WxH:fps=30`. Camera moves: `zoom_in`, `zoom_out`, `pan_left`,
`pan_right`, `pan_up`, `pan_down` (from `script.scenes[i].camera`). Max zoom 1.15.

### 4.9 Captions (stage 7)

- Global word times = scene-relative times + cumulative **audio** start of the scene (captions follow
  speech; the video boundary differs by ≤ ½ frame, §4.4).
- Words grouped into pages of ≤ 3 words, breaking early after `. , ! ? ;`.
- One ASS `Dialogue` event per word: shows the whole page in uppercase, active word highlighted
  (`{\c&H00E5FF&}` yellow, others white), from word start to next word start (last word: to its end).
- Style: bundled OFL font (Montserrat ExtraBold) from `assets/fonts/`, bold, outline 6, shadow 0,
  alignment 2 (bottom-center), `MarginV` = 30 % of height (9:16) / 12 % (16:9). Font size 7.5 % of
  width (9:16) / 5.5 % of height (16:9). `PlayResX/PlayResY` = output size.
- Burned in with `ass=captions.ass:fontsdir=assets/fonts` (both paths single-quoted; a path containing
  `'` or `:` is rejected up front, since ffmpeg 8 cannot parse either inside the quoted filter argument).

### 4.10 Assemble (stage 8)

1. Video: concat demuxer over `fitted/scene_*.mp4` (identical codec params) with `-c copy`.
2. Narration: concat of `audio/scene_*.wav` → `narration.wav`.
3. Optional BGM: loop/trim to length; `asplit` narration; `sidechaincompress`
   (threshold 0.05, ratio 8, attack 20 ms, release 300 ms) of BGM keyed by narration;
   BGM base volume 0.35; `amix=inputs=2:normalize=0`.
4. `loudnorm=I=-14:TP=-1.5:LRA=11` (social platform target).
5. Burn captions, encode `libx264 -crf 18 -preset medium -pix_fmt yuv420p`, `aac 192k`,
   `-movflags +faststart`. Length is pinned explicitly: `-frames:v totalFrames` for video and
   `apad,atrim=end=totalFrames/fps` for audio (no reliance on `-shortest`).
6. `chain.png`: for every scene, two frames scaled to 360 px height, laid out with `xstack` (rows =
   scenes in order; Mode 2 rows included): the **first frame of the raw clip** and the **last frame of
   the fitted clip** — what is actually seen on each side of every seam. Row N's right cell vs row N+1's
   left cell is the drift-inspection view for a continuing scene.

## 5. Data Model

All schemas are zod v4. The `Script` schema is converted with `z.toJSONSchema()` and passed to Gemini
as the response schema, so one definition serves validation and generation.

### 5.1 Script (LLM output)

```ts
const SceneSpec = z.object({
  narration:    z.string(),                          // ≤ 22 words (validated post-hoc)
  imagePrompt:  z.string(),
  motionPrompt: z.string(),
  shot:         z.enum(["continue", "cut"]),         // scene 0 is treated as cut regardless
  camera:       z.enum(["zoom_in","zoom_out","pan_left","pan_right","pan_up","pan_down"]),
});
const Script = z.object({
  title:      z.string(),
  styleBible: z.object({ artStyle: z.string(), characters: z.string(), palette: z.string() }),
  scenes:     z.array(SceneSpec).min(1).max(12),
});
```

Post-validation: `scenes.length === request.sceneCount` and every narration ≤ 22 words. On failure,
retry once with the validation errors appended to the prompt; on a second failure the run stops
(no paid media has been generated yet).

### 5.2 Word timings

```ts
type WordTiming = { text: string; start: number; end: number }   // seconds, scene-relative
```

- `wordsFromAlignment(alignment)`: ElevenLabs returns parallel arrays `characters`,
  `character_start_times_seconds`, `character_end_times_seconds`. Split on whitespace; word start =
  first char start, end = last char end.
- `remapTimings(words, keep)`: for a time `t`, find the keep segment containing it and map to
  `offset(segment) + (t − segment.start)`; a `t` inside a removed region snaps to the nearest kept
  boundary. Words whose mapped `end <= start` get a minimum 40 ms span.

### 5.3 Manifest (`runs/<runId>/manifest.json`, paths relative to the run dir)

```ts
const StageName = z.enum(["script","tts","silence","keyframes","clips","fit","captions","assemble"]);

const StageRecord = z.object({
  status:     z.enum(["done", "failed"]),
  inputHash:  z.string(),
  costUsd:    z.number(),
  finishedAt: z.string(),
  error:      z.string().optional(),
});

const FitPlan = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("trim") }),
  z.object({ kind: z.literal("slow"), factor: z.number() }),
  z.object({ kind: z.literal("slow+freeze"), factor: z.literal(1.25), freezeSec: z.number() }),
]);

const ProviderJob = z.object({            // saved BEFORE waiting on the fal queue (§6 Failure)
  requestId:   z.string(),
  inputHash:   z.string(),                 // the inputs this job was bought for
  submittedAt: z.string(),
  chargedUsd:  z.number().default(0),      // > 0 once the completed job is in the ledger
  result:      z.object({ url: z.string(), seed: z.number().optional() }).optional(),  // set when charged
});

const SceneState = z.object({
  idx:       z.number(),
  mode:      z.union([z.literal(1), z.literal(2)]),
  nonces:    z.partialRecord(StageName, z.number()).default({}),   // bumped by reroll
  stages:    z.partialRecord(StageName, StageRecord).default({}),
  jobs:      z.partialRecord(StageName, ProviderJob).default({}),          // paid fal jobs (keyframes, clips)
  tts:       z.object({ raw: z.string(), words: z.array(WordTiming) }).optional(),   // untrimmed TTS output
  audio:     z.object({ path: z.string(), duration: z.number(),                        // after silence removal
                        words: z.array(WordTiming), removedSec: z.number() }).optional(),
  keyframe:  z.object({ path: z.string(), seed: z.number(), sourceUrl: z.string() }).optional(),
  clip:      z.object({ path: z.string(), sourceUrl: z.string().optional(), duration: z.number(),
                        requestedSec: z.union([z.literal(5), z.literal(10)]).optional() }).optional(),
  fitted:    z.object({ path: z.string(), frames: z.number(), plan: FitPlan }).optional(),
});

const Manifest = z.object({
  schemaVersion: z.literal(1),
  runId: z.string(), createdAt: z.string(),
  request: z.object({ topic: z.string(), aspect: z.enum(["9:16","16:9"]), sceneCount: z.number(),
                      modes: z.array(z.union([z.literal(1), z.literal(2)])),
                      voiceId: z.string(), bgm: z.string().optional() }),
  models:  z.object({ llm: z.string(), tts: z.string(), image: z.string(), video: z.string() }),
  script:  Script.optional(),
  runStages: z.partialRecord(StageName, StageRecord).default({}),   // run-level stages: script, captions, assemble
  scenes:  z.array(SceneState),
  final:   z.object({ path: z.string(), duration: z.number(), captions: z.string(),
                      chain: z.string() }).optional(),
  ledger:  z.array(z.object({ stage: StageName, scene: z.number().optional(),
                              usd: z.number(), at: z.string() })),
});
```

`--mode auto` (default) resolves every scene to Mode 1; `--mode 1|2` sets all scenes; `--modes`
sets them individually (length must equal `--scenes`). The LLM never chooses modes.

## 6. Caching, Resume, Reroll

- **Cache key:** `inputHash = sha256(stableJson({ stage, model, nonce, inputs }))`, where `inputs` is
  stage-defined and **includes the sha256 of every upstream file the stage consumes**.
- **Skip rule:** a stage (or scene-stage) is skipped iff its record is `done`, the stored
  `inputHash` equals the freshly computed one, and its output files exist.
- **Chain cascade:** the seam file does not exist yet when clip N is hashed, so for Mode 1 scene N
  continuing from N−1 `inputs` contains what determines the seam frame instead: `sha256(clip N−1 file)`,
  `frames_{N−1}`, output size and fps (plus model, prompt, `requestedSec`). Re-generating clip N−1
  changes that hash and invalidates N, and so on until the next keyframe scene. `deps()` of a continuing
  clip are `clips(N−1)` and `silence(0..N−1)` (frames_{N−1} depends on every earlier duration), so the
  planner prices the cascade before it runs. Consequence: a re-voice that changes `frames_{N−1}` by even
  one frame (cumulative rounding, §4.4) moves the seam frame and regenerates clip N (paid).
- **Mode 1 clip inputs** contain `requestedSec`, not the audio hash — re-voicing a scene only
  regenerates its own clip if the 5/10 s bucket changes (continuing clips after it also follow the
  seam rule above). Free stages (fit/captions/assemble) depend on
  audio hashes and always re-run when audio changes.
- **Reroll:** `flowchain reroll <runId> --scene N --stage keyframes|clips|tts` (CLI scene numbers
  are 1-based; manifest `idx` is 0-based) bumps `scenes[N-1].nonces[stage]`; the pipeline then re-runs, and hashing decides everything downstream.
  Before executing, the CLI lists which (scene, stage) pairs will run and their estimated cost.
  `--stage clips` is rejected for a Mode 2 scene (its clip is a deterministic Ken Burns render of the
  keyframe, so a new nonce would only re-render the same frames); the message points to `--stage keyframes`.
- **Failure:** LLM and TTS calls are retried (3 attempts, exponential backoff, per-call timeout
  LLM 60 s, TTS 60 s). Clearly non-retryable errors are not retried: HTTP 400/401/403/404/422 and
  errors marked non-retryable (the original error is kept as `cause`). After the last attempt the stage
  writes a `failed` record and the run stops; the next `resume` continues from there.
- **Paid fal jobs (keyframes, clips) use the queue API explicitly, never `subscribe`:** `fal.queue.submit`
  is called exactly once (never retried); its request id is stored in `scenes[i].jobs[stage]` together
  with the inputHash it was bought for, and the manifest is saved **before** waiting. Waiting polls
  `fal.queue.status` until `COMPLETED` (deadline: image 120 s, video 600 s), then fetches
  `fal.queue.result`; polling may be retried because it never buys anything. A timeout, error or Ctrl-C
  while waiting fails the stage with the request id kept, and the next attempt for the same inputHash
  polls that id again. A new job is submitted only when there is no job for the current inputHash
  (e.g. after a reroll nonce bump). A result without `images[0].url` / `video.url`, or with
  `has_nsfw_concepts[0] === true`, is a non-retryable error (charged, since fal completed the job);
  resuming re-polls the same request and fails the same way, so the way forward is a reroll.
- **Charge at provider success:** a paid stage records spend through `ctx.charge(usd)` the moment the
  provider returns (each LLM answer, each TTS response, each completed fal job), before any download or
  post-processing; `charge` appends the ledger entry and saves the manifest. A completed fal job also
  saves its result URL, so a failed download or post-processing step is retried on resume by
  re-downloading, without calling or paying the provider again. A stage record's `costUsd` is the total
  charged for its inputHash across attempts. Nothing paid is regenerated without a hash change.
- **Persistence:** manifest saved via write-to-temp + `rename` after every scene-stage (and on every
  `charge` and fal submit).
- **Exclusive run lock:** `run`/`resume`/`reroll` create `<runDir>/.lock` with flag `wx` before
  executing and remove it in `finally`; if it already exists the command fails with "run is already in
  progress" (after a hard kill the file stays behind and is deleted by hand).
- **Downloads:** every remote output is downloaded immediately (120 s timeout via
  `AbortSignal.timeout`, covering the body too); `sourceUrl` is
  informational, while `jobs[stage].result.url` is what a resume re-downloads from.

## 7. Module Layout

```
src/
  cli.ts                 commander: run | resume | reroll | status | doctor
  config.ts              env + model IDs + price table (zod-validated); prices.json override
  pipeline.ts            ordered stages, skip rule, cost estimate + confirm, ledger
  doctor.ts
  manifest/  schema.ts  store.ts  hash.ts
  providers/ types.ts  gemini.ts  elevenlabs.ts  fal.ts  retry.ts  download.ts
  media/     ffmpeg.ts  silence.ts  frames.ts  kenburns.ts  fit.ts  timeline.ts  captions.ts
             assemble.ts  contact-sheet.ts
  stages/    script.ts  tts.ts  silence.ts  keyframes.ts  clips.ts  fit.ts  captions.ts  assemble.ts
             job.ts (runProviderJob: submit once, persist request id, poll, charge once)
assets/fonts/            Montserrat-ExtraBold.ttf + OFL.txt
test/
  unit/  media/  pipeline/  fakes/  helpers/
```

**Dependency rule:** `pipeline → Stage interface`; `stages → providers/types + media + manifest`;
`media → ffmpeg only` (no manifest knowledge); providers implement `providers/types`. In Phase 2,
`stages/` + `media/` move into BullMQ workers unchanged; `manifest/store.ts` is swapped for
Supabase; `media/assemble.ts` is replaced by Remotion.

### 7.1 Contracts

```ts
interface LlmProvider   { generateScript(req: ScriptRequest): Promise<Script> }
interface TtsProvider   { speak(req: { text: string; previousText?: string; nextText?: string; voiceId: string })
                            : Promise<{ audio: Buffer; words: WordTiming[] }> }
interface QueuedProvider<Req, Out> {            // fal queue: submit buys one job, wait only polls it
  submit(req: Req): Promise<string>              // request id; never waits
  wait(requestId: string, opts: { timeoutMs: number }): Promise<Out>
}
type ImageProvider = QueuedProvider<{ prompt: string; width: number; height: number; seed?: number },
                                    { url: string; seed: number }>
type VideoProvider = QueuedProvider<{ imagePath: string; prompt: string; durationSec: 5 | 10 },
                                    { url: string }>   // submit uploads imagePath via fal.storage.upload;
                                                       // Kling v2.1 takes aspect from the input image

interface Stage {
  name: StageName
  perScene: boolean
  paid: boolean
  appliesTo?(m: Manifest, scene: number): boolean               // e.g. keyframes only where needed
  deps(m: Manifest, scene?: number): Dep[]                      // only for pricing cascades
  inputsFor(ctx: StageContext, scene?: number): Promise<unknown> // async: hashes upstream files
  outputsFor(m: Manifest, scene?: number): string[]             // must exist for a cache hit
  estimateCostUsd(ctx: StageContext, scene?: number): number    // never throws; uses fallbacks
  run(ctx: RunContext, scene?: number): Promise<void>           // records spend via ctx.charge(usd)
}
// RunContext = StageContext + { inputHash (keys persisted jobs), charge(usd) (ledger entry + save, immediately) }
```

`clips` is the one stage that must execute scenes in order (Mode 1 chain). All other per-scene
stages run scenes sequentially in Phase 1 (simplicity); parallelism is a Phase 2 concern.

Keyframe sizes (Flux requires multiples of 16): 9:16 → 1088×1920 (fit crops to 1080), 16:9 → 1920×1088.

## 8. Cost Estimates & Budget

Price table (USD) in `config.ts`, overridable via `prices.json` (strict: an unknown key, e.g. a typo, is
an error; parse and validation errors name the file):

| Item | Default |
|---|---|
| Flux Dev | 0.025 / megapixel |
| Kling v2.1 standard | 0.25 per 5 s + 0.05 per extra second |
| ElevenLabs | 0.30 / 1 000 characters (adjust to plan) |
| Gemini | 0.30 / 1M input tokens, 2.50 / 1M output tokens (estimate) |

- **Two checkpoints:** (1) at start, covering all remaining work with fallbacks where data is not yet
  known (≈130 narration chars/scene, 10 s clips); (2) right before `keyframes`, when script and audio
  exist and every remaining estimate is exact. At each checkpoint print a per-scene/per-stage table and
  confirm interactively if the planned total exceeds `--budget` (default `FLOWCHAIN_BUDGET_USD=3`), or
  for a reroll whenever paid work is planned; checkpoint 2 only re-asks if its paid total exceeds what
  was already confirmed. `--yes` skips.
- Planning which (stage, scene) pairs will run uses each stage's static `deps()` (upstream stage/scene
  pairs) to propagate "will run" downstream, so a reroll's cascade is priced before it happens.
  Execution itself still decides purely by input hash.
- Ledger entries are **computed** from the price table and actual request parameters, not provider
  invoices; `status` labels them as estimated actuals. They are written the moment a provider call
  succeeds (§6 "Charge at provider success"), so a later failure never hides money already spent.
- Typical 4-scene 9:16: Mode 1 ≈ $1.20; Mode 2 only ≈ $0.30.

## 9. `flowchain doctor`

Runs standalone and automatically before `run`/`resume`/`reroll`:

1. `ffmpeg`/`ffprobe` present, version ≥ 6, `--enable-libass` and `--enable-libx264`, filters
   `silencedetect zoompan ass tpad sidechaincompress loudnorm` present.
2. Required env vars set.
3. Gemini: `models.get(GEMINI_MODEL)` succeeds (clear error on retired model IDs).
4. fal: tiny `fal.storage.upload` succeeds (validates key, no generation cost).
5. ElevenLabs: `GET /v1/voices/{ELEVENLABS_VOICE_ID}` succeeds.
6. `assets/fonts/Montserrat-ExtraBold.ttf` exists.

## 10. Configuration (`.env.example`)

```
GEMINI_API_KEY=
GEMINI_MODEL=gemini-flash-latest
FAL_KEY=
FAL_IMAGE_MODEL=fal-ai/flux/dev
FAL_VIDEO_MODEL=fal-ai/kling-video/v2.1/standard/image-to-video
ELEVENLABS_API_KEY=
ELEVENLABS_VOICE_ID=
ELEVENLABS_MODEL=eleven_multilingual_v2
FLOWCHAIN_BUDGET_USD=3
RUNS_DIR=./runs
```

## 11. Testing

1. **Unit** (no ffmpeg, no network): `parseSilencedetect`, `keepSegments`, `remapTimings`,
   `wordsFromAlignment`, `planFit`, `frameCounts` (cumulative rounding), `requestedSec`,
   `needsKeyframe`, `zoompanFilter`, `wordsToAss`/paging, `inputHash` stability, manifest round-trip,
   cost estimation.
2. **Media** (real ffmpeg, fixtures generated at test time with `lavfi`; no binaries in git):
   silence removal duration ±20 ms; `extractLastFrame` equals the true last frame (frame-numbered
   `testsrc2` + pixel compare); `extractSeamFrame` equals the last frame of `applyFit`'s output
   (frameDiff 0) for every plan; `applyFit` ±1 frame for each plan; Ken Burns exact frame count;
   assemble A/V duration within 1 frame; contact sheet dimensions.
3. **Pipeline** (fake providers that emit generated media and count calls): full Mode 1 / Mode 2 /
   hybrid runs; resume after injected failure at scene 3 clips makes zero repeat calls for completed
   work; cascade with shots `[cut, continue, continue, cut]` (all Mode 1) — `reroll --scene 2
   --stage clips` regenerates clips 2 and 3 only (scene 4 is a cut); checkpoint-2 estimate equals the
   ledger sum of the media stages for a fresh run; in an all-Mode-1 continue run the image sent to the
   video provider for scene 2 equals the last frame of fitted scene 1 (frameDiff 0); a video wait failure
   followed by resume submits no second job and charges once; a post-processing failure after a
   successful job is charged once and resume does not call the provider again; an unusable (NSFW) result
   is charged once and not retried.
4. **Live smoke** (`npm run smoke`, manual, ≈ $0.90–1.80): 3 scenes, all Mode 1 (`--modes 1,1,1`) so
   at least one continue seam is exercised (re-run if the LLM chose only cuts), real APIs. Never in CI.

## 12. Definition of Done

1. `flowchain run --topic "…" --aspect 9:16 --scenes 4` produces `final.mp4` with captions synced to
   speech, A/V stream durations within 1 frame, and no silence gap > 200 ms in narration.
2. `--modes 1,2,1,1` produces a hybrid video.
3. Resume-after-failure and `reroll` behave as specified (pipeline tests green).
4. Every run writes `chain.png` for drift inspection.
5. `npm test` (unit + media + pipeline) passes offline; `flowchain doctor` passes with real keys.
