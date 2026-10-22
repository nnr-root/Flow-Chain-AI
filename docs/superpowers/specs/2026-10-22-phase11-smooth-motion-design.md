# Phase 11 — smooth motion: 60 fps as a paid choice, interpolated in the restorer worker

Date: 2026-10-22. Status: design approved section by section; not built.

## 0. Where this sits

Item 2 of the owner's five-item list (phase 9 spec §0): "cross the 720p limit, with a tile-based video upscale instead of a
latent upscale, and interpolation to 60 fps (extra credit if it is costly)". Roadmap so far: 5 prompts (phase 9, built),
1 chaining (phase 10, built), **2 this one**, 3 lip sync and sound effects, 4 trend discovery.

Reading the code first changed the question, and two of my own statements in the design conversation were wrong and are
corrected here:

- **"Cross the 720p limit" is already built** (phase 8 spec §8): Full HD takes the 480p clip to 1080p in pixel space, with
  tiled encode and decode (SeedVR2, `worker-upscale/`), as the paid choice `--upscale` / `clips: "1080p"`. This phase adds
  no resolution tier. A tier above 1080p was offered and not chosen.
- **Motion is not 16 fps stepped up to 30.** The clip worker already runs RIFE ×2 (`workers/handler.py:113` encodes at
  `req["fps"] * RIFE_MULTIPLIER`; `workers/src/flowchain_worker/workflows.py`, `RIFE_MULTIPLIER = 2`), so a clip arrives at
  32 fps with real in-between frames, and `fit` thins 32 to the pipeline's 30 (`fps=` in `src/media/fit.ts`), dropping about
  one frame in 16. A "real 30 fps" tier therefore exists today.
- **Converting an existing run to 60 fps is not possible without re-buying chained clips.** A chained (`continue`) clip is
  keyed on `prevFrames` and `fps` (`src/stages/clips.ts`), both of which change with the frame rate. 60 fps is a choice made
  when a run is created.

What is new, and what the owner chose: **60 fps as a per-run paid choice**, built by interpolating in the existing
restorer worker (approach A below). The default stays at today's 30 fps.

## 1. Decisions

| Question | Choice |
|---|---|
| What the phase covers | 60 fps as a paid choice, default unchanged (owner, 2026-10-22) |
| Where interpolation runs | in `worker-upscale/` (approach A), not in the Wan clip job (B) and not locally with `minterpolate` (C) |
| A tier above 1080p | not in scope |
| Existing runs | cannot be converted (§0) |

Approaches not chosen, kept for the record: **B** (RIFE ×4 in the clip worker) is the smallest change, but makes 60 fps a
property of the paid Wan job, so a remake re-buys the clip, and Full HD then upscales twice the frames: about
$0.034 more per second of clip at the measured 110 GPU seconds per clip second (`src/config.ts`, `upscaleSecPerClipSec`).
**C** (local ffmpeg `minterpolate`) is free but ghosts and warps AI video, and is slow on the CPU.

Why interpolation cannot simply come after the upscale as its own stage: the pipeline can send a worker a file only as
base64 inside the request (the restorer takes at most 9 MB: `MAX_VIDEO_BYTES` in
`worker-upscale/src/flowchain_upscale/contract.py`), and `R2.put` takes a text body only (`src/providers/r2.ts`). A finished
1080p clip does not fit. So for Full HD plus 60 fps both steps are **one job** that keeps the file on the worker's disk.

## 2. The choice, and where the frame rate lives

- A frozen optional request field `fps: 60` (absent means 30), following `upscale: true` (`src/manifest/schema.ts`): set at
  creation, never changed, so old runs load and keep every key. `RunRequest.fps: z.literal(60).optional()`.
- One helper, `fpsOf(request): number` = `request.fps ?? FPS`, in `src/config.ts`. The three places that use the constant
  today read it through the helper: `src/cli.ts:110`, `web/server/runs.ts:137`, `scripts/make-showcase.ts`. (`web/server/files.ts`
  and `KitForm.tsx`'s caption preview are checked by the plan; the preview may stay at 30.)
- CLI: `--fps 60` (the only value accepted). The studio form and `draftArgs` (`web/server/schemas.ts`) send it.
- A version in another language (phase 8 spec §4) keeps its source's `fps`: it reuses the source's clips.
- What reads the frame rate: `fit` (frame counts, `fps=` filter; already keyed on `fps` and `frames`), `render`, the
  captions' timing, and the players, which read `props.fps` already. The keyframes, the clips and the script do not read it
  except the chained-clip key above, which is why a 60 fps run is a new run.
- Mode 2 stills are moved by Remotion frame by frame, so they are smooth at 60 with no interpolation.
- The customer is shown credits, never dollars (`amount()`); this phase adds no `$${…}`.

## 3. The restorer worker (`worker-upscale/`)

- **Request.** `{task: "upscale", workflow, video: <base64 mp4 ≤ 9 MB>, short?: 720|1080, interpolate?: 2}`. At least one of
  `short` and `interpolate` is required. The existing workflow `upscale-seedvr2@1` keeps its exact contract (`short`
  required, no `interpolate`), so a run in flight and every old run are unaffected. The new workflow is `restore-video@1`.
- **Engine.** If `short` is given, SeedVR2 runs first as today. If `interpolate` is given, RIFE then runs on the local
  result (or on the input when there is no `short`) and re-encodes at twice the input frame rate (32 fps in, 64 out), with
  the audio untouched (clips carry none). One subprocess per step, a tail-of-output error, nothing retried.
- **RIFE** is the practical-RIFE implementation (MIT, the licence the clip worker's RIFE already has), pinned by commit with
  its weights baked into the image and checked by SHA-256, exactly as SeedVR2's. Task 1 (a gate, like phase 10's) reads the
  public repository and the weights' hashes and writes them into a new §3.1 (so §3.1 does not exist yet, and wins over this
  section once it does), and answers: does it support an exact target rate (so 32 can go to 60
  without the 64-to-60 thinning), what GPU memory it needs at 1080p, and the command line.
- **Transport.** In: base64 as today (a 480p 32 fps clip fits; the 1080p result never goes back in). Out: R2 as today; the
  pipeline downloads it and removes the bucket copy.
- **Image and deploy.** The image is built by the `upscale` job of `worker-image.yml`; `npm run runpod:deploy` already makes
  its template and endpoint (`RUNPOD_UPSCALE_ENDPOINT`). `models.upscale` keeps its name and now means "the restorer
  endpoint": a run that asks for Full HD or 60 fps freezes it.

## 4. The stages

- **`upscale`** (Full HD, `src/stages/upscale.ts`): for a 60 fps run it sends `interpolate: 2` in the same job. Its cache
  key (`inputsFor`) gains `interpolate: 2` only when set, so every other run keeps its key. Its output (`paths.upscaled`) is
  then a 64 fps clip.
- **`interpolate`** (new, `src/stages/interpolate.ts`): a paid per-scene stage in `StageName`; applies to Mode 1 scenes of a
  60 fps run **without** Full HD (`isSmoothed`); deps `clips`; keyed on the clip file, the multiplier and the model; output
  `paths.smoothed`; the scene gains an optional `smoothed: { path, sourceUrl?, duration }` like `upscaled`. Between `clips`
  and `fit`.
- **`fit`** plays the upscaled file, else the smoothed one, else the raw clip, in `deps`, `inputsFor` and `run`; its
  `fps=${fps}` filter thins 64 to 60 (or lands exactly if §3's gate finds a target-rate mode).
- **The seam frame** for chained scenes is still taken from the raw clip (`writeSeam`), as already for Full HD.
- **Touch points** the plan lists with `grep` and the graph (`graphify explain "upscaleStage"`, `affected`): `StageName`,
  `src/stages/index.ts`, `paths.ts`, `reroll.ts` (a clip's reroll must also remake its smoothed/upscaled file), `versions.ts`,
  `require.ts`, `src/studio/status.ts`, `web/lib/labels.ts` (the studio's words for the stage).
- **Cost.** `interpolateCost(prices, seconds, first)` and the extra inside the Full HD job are priced by GPU seconds per clip
  second and a cold start, from rates in `prices.json`: `runpodInterpolateUsdPerSec`, `runpodInterpolateSecPerClipSec`,
  `runpodInterpolateColdStartSec`, and for the combined job `runpodRestoreExtraSecPerClipSec`. **No defaults**: until the owner
  has measured and set them, the choice is not offered and `createProviders`/`estimateCostUsd` refuse (the rule phase 10 §3
  set for FLUX 3). The stage estimate is conservative; the job's own measured time is what is charged (`runProviderJob`).

## 5. The render, the studio, the queue

- **Render.** Remotion takes `fps` from the props already (`calculateMetadata` in `Root.tsx`). At 60 the local render makes
  twice the frames with the same encoder settings (h264, crf 18): roughly twice the render time and a file about 1.5 times
  larger, both measured by the owner. The loudness pass and the final duration use `totalFrames / fps` already.
- **The form** gets a "Motion" control, Standard or Smooth (60 fps), shown only when `health.smooth` is true: the restorer
  endpoint and its prices are set. The health answer says that a setting is missing without saying which. The copy is plain
  and shows no dollars; the price shows through the credit estimate.
- **The queue.** The worker's command check (`refusal()` / `commandKind`, `web/server/jobs/redis.ts`) allows exactly
  `--fps 60`, as it allows `--upscale`, and no other number; a paid job still needs an open reservation for that exact
  user, run, kind and cap.
- **Names.** `INTERNAL_NAMES` (`web/lib/engines.ts`) gains `/seedvr/i` and the case-sensitive `/\bRIFE\b/` ("rife" is an
  ordinary English word); `web/test/names.test.ts` holds the pages and published files to them.

## 6. Testing

All free, against stand-ins: `fpsOf` and the schema (an old request has no `fps` and every key is unchanged, pinned beside
`compat.test.ts`, which is untouched); a fake restorer provider (`test/fakes/`) and a configurable frame rate in the fake
video; stage tests for `interpolate` and for the 60 fps `upscale` key; a real-ffmpeg `fit` test that thins a 64 fps clip to
60; the `reroll` of a clip remaking its smoothed file; the profile gate (no rates, no choice); the form, `draftArgs` and the
queue's allow-list; `names.test.ts`; Python tests for the contract (both workflows), the pure RIFE command, and the handler
with a stubbed engine (cleanup on success and on failure). No Gemini prompt changes, so no `PROMPT_VERSION` bump.

## 7. What only the owner can do

In order: rebuild and push the worker image and run `npm run runpod:deploy` (its plan is printed first); measure GPU seconds
per clip second for interpolation alone and inside a Full HD job, and the render time and file size at 60, and set the four
prices; make one 60 fps video and one Full HD plus 60 video and judge the motion. None of these is run by an agent
(CLAUDE.md, "Rules that are never broken").

## 8. Order of work (one task and one commit each, a reviewer after each)

1. The gate: read RIFE's repository and weights into §3.1 (commit, hashes, command, target-rate mode, memory).
2. `fps` in the request, `fpsOf`, the CLI flag, and the three call sites; tests for unchanged keys.
3. The worker: contract, engine, weights, Dockerfile (Python, stubbed).
4. The provider and the profile: `restore-video@1` request shape, rates, pricing gate, the fake.
5. The stages: `interpolate`, the combined `upscale` key, `fit`'s source order, `reroll`, `versions`.
6. The studio: `health.smooth`, the form, `draftArgs`, the queue allow-list, the labels, the names.
7. The owner's steps (not dispatched).

## 9. Risks

- RIFE can warp fast or complex motion in AI video; the owner's visual check is the only judge.
- 64-to-60 thinning drops about one frame in 16 unless §3's gate finds an exact-rate mode.
- A 64 fps 1080p clip is a large download from R2; the measurement covers the time.
- The local render takes about twice as long and the file is larger; some platforms re-encode a 60 fps upload.
- The restorer image is rebuilt and redeployed; SeedVR2's behaviour under a changed image is unchanged by design (its step is
  untouched) but unverified without a GPU.
- 60 fps cannot be added to an existing run (§0).

## 10. Not in scope

A tier above 1080p; converting existing runs; changing the 30 fps default or fixing its 32-to-30 judder (a later change could
reuse §3's exact-rate mode); the clip worker's RIFE; the other items on the list (lip sync and sound effects, trend discovery).
