# Phase 11 — smooth motion: 60 fps as a paid choice, interpolated in the restorer worker

Date: 2026-10-22. Status: built; the owner's steps (§7) are not done.

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
  the audio untouched (clips carry none). One subprocess per step (two for interpolation: RIFE, then a re-encode: §3.1, §11), a tail-of-output error, nothing retried.
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

### 3.1 What RIFE's pages say (read on 2026-10-22 by task 1)

Read anonymously, with no token: the GitHub API and raw files of `hzwer/Practical-RIFE` at the commit below, the Hugging
Face Hub API (`/api/models/<repo>?blobs=true`) and a `HEAD` of the file, the zip's central directory (the last 8 KB of the
file, by a range request: the names inside, not the weights), PyPI's JSON API, and issues #55, #133 and #153. Nothing was
downloaded but that directory; nothing was run on a GPU.

| Fact | Value | Where it was read |
|---|---|---|
| Implementation | Practical-RIFE, `https://github.com/hzwer/Practical-RIFE`, its `inference_video.py` | the repository |
| Pinned commit | `bbfd2ea90910789a860ea3e2b32a240cd577b75e` (head of `main`, 2026-08-27, "Add Apple Silicon (MPS) support to warplayer (#156)") | `api.github.com/repos/hzwer/Practical-RIFE/commits/main` |
| Licence | MIT ("MIT License / Copyright (c) 2021 hzwer"); the README: "The content of these links is under the same MIT license as this project." The Hugging Face repository below carries no licence tag | `LICENSE`, README "Trained Model" |
| Python | README: "python <= 3.11" (the restorer's image is `python:3.11-slim`) | README "Installation" |
| Weights chosen | RIFE **4.26** (2024.09.21), the newest in the README's list (it recommends 4.25 "by default for most scenes", and says "4.24+ is quite suitable for post-processing of some diffusion model generated videos") | README "Frame Interpolation" |
| Weights source, pinned | `https://huggingface.co/hzwer/RIFE/resolve/01fdc7e97404120c243c3ea7b427046e5dc7643e/RIFEv4.26_0921.zip` (the author's own account; not gated, not private) | Hub API `models/hzwer/RIFE?blobs=true` |
| Size, SHA-256 | 22,869,906 bytes; `1fa9b9cda3d9b8c3e301359e2595960902f97bf926c08598b0e9957a3f3f760e` (the Hub's `lfs.sha256`, equal to the `x-linked-etag` and `x-linked-size` of a `HEAD` on the pinned URL) | Hub API and `HEAD` |
| What the zip holds | a folder `RIFEv4.26_0921/` with `flownet.pkl` (24,636,301 bytes), `IFNet_HDv3.py` (6,433), `RIFE_HDv3.py` (3,101), `refine.py` (3,510), `.DS_Store`, `__pycache__/*.cpython-311.pyc`, plus `__MACOSX/` entries. The model's code comes with the weights: the repository has none of it | the zip's central directory |
| Where it goes | `inference_video.py` line 92: `from train_log.RIFE_HDv3 import Model` (a fixed package name, imported from the script's own folder) and line 96 `model.load_model(args.modelDir, -1)` (reads `<modelDir>/flownet.pkl`). So the zip's folder must become `train_log/` inside the clone, and `--model` should be given as that absolute path (its default `'train_log'` is relative to the working directory) | `inference_video.py` |
| Other weights (not chosen) | 4.25 is only on Google Drive and Baidu from the author; third-party mirrors carry a `flownet.pkl` of 24,636,301 bytes, SHA-256 `6615790efd627772917205db291f51cd392528a157ecbb2ecaeec3bff8eb6de2` (`MonsterMMORPG/Practical-RIFE`, `Upsampler/rife-4-25`) | Hub API |
| The clip worker's weights | `rife49.pth`, 21,345,274 bytes, `e55fd00f3cc184e3c65961f4bb827a9da022e78eed36b055242c0ac30000d533`, from `marduk191/rife` (`workers/Dockerfile`). **Not usable here**: Practical-RIFE needs the 4.9 model code (`RIFE_HDv3.py`, `IFNet_HDv3.py`), which exists only inside the v4.9.2 zip on Google Drive, with no checksum. The 4.26 zip, code and weights in one file hashed by the author's own host, is the simplest | `workers/Dockerfile`, README |
| Exact target rate | **No.** `--fps` only sets the container's rate; the frames are always `--multi` times as many (see the lines below). The maintainer, issue #153: "Simply adding `--fps=60` changes the playback rate of the generated sequence; it does not automatically generate exactly the frames needed for every source rate." | `inference_video.py`, issue #153 |
| Frames out | `multi × (N − 1) + 1` for `N` frames in: each pair writes the earlier frame and `multi − 1` new ones (lines 261–264), and the last frame once (line 273). A 32 fps clip of `N` frames gives `2N − 1` frames at 64 fps: **one frame (1/64 s) short** of twice the length. A pair whose small thumbnails differ a lot (`ssim < 0.2`, a cut) repeats the earlier frame instead of interpolating (lines 239–242); a near-identical pair (`ssim > 0.996`) is replaced by an interpolation with the next frame (lines 225–237) | `inference_video.py` |
| Output codec | `cv2.VideoWriter_fourcc('m', 'p', '4', 'v')` (line 113): MPEG-4 Part 2, not H.264. The worker re-encodes it (or uses `--png` and encodes the frames itself) | `inference_video.py` |
| Audio | Read and written only when neither `--fps` nor `--png` is given (line 284: `if args.png == False and fpsNotAssigned == True and not args.video is None:`), through `transferAudio`, which runs `ffmpeg` and `import moviepy.editor` and works in `./temp` of the working directory. `moviepy` is at 2.2.1 on PyPI, which has no `moviepy.editor`: the import fails inside `try`, and the `except` then renames a file that does not exist, so the script would end with an error. Passing `--fps` (or `--png`) skips all of it; clips carry no audio | `inference_video.py`, PyPI |
| fp16, scale | `--fp16` ("fp16 mode for faster and more lightweight inference on cards with Tensor Cores"); `--scale` in `[0.25, 0.5, 1.0, 2.0, 4.0]`, default 1.0, "Try scale=0.5 for 4k video"; `--UHD` is `--scale=0.5`. Frames are padded to a multiple of `max(128, int(128 / scale))` (1080 → 1152 at scale 1.0) | `inference_video.py`, README |
| GPU memory at 1080p | **not stated** in the README, the code or the issues searched ("memory 1080", "VRAM", "out of memory"). The only figure is a user's speed, not memory: "about 77/78 FPS with Rife 4.15/4.14/4.14-lite for 1080p inputs and 2x interpolation and a RTX 3090" (issue #55). The model is ~25 MB and runs one frame pair at a time, so the 24 GB card is not expected to be the limit, but this is the owner's measurement to make (§7) | README, issues |
| Dependencies (`requirements.txt`) | `numpy>=1.16, <=1.23.5`, `tqdm>=4.35.0`, `sk-video>=1.1.10`, `torch>=1.3.0`, `opencv-python>=4.1.2`, `moviepy>=1.0.3`, `torchvision>=0.7.0`. Imported on the video path: `cv2`, `torch`, `numpy`, `tqdm`, `skvideo.io`, `torchvision` (via `model/loss.py`); `moviepy` only in the audio step skipped above | `requirements.txt`, the source |
| The numpy conflict | `sk-video` 1.1.10 (the latest) fails under numpy 2: `skvideo.io.vreader` raised "`np.float` was a deprecated alias for the builtin `float`" with numpy 2.0.2 (checked in a scratch virtualenv). The restorer's Python already has SeedVR2's unpinned `numpy` and `opencv-python`; the latest `opencv-python` (5.0.0.93) requires `numpy>=2`, and `opencv-python` 4.10/4.11 require `numpy>=1.23.5` on Python 3.11. So on 3.11 numpy must be **exactly 1.23.5** (a `cp311` manylinux wheel exists) for RIFE, which cannot share SeedVR2's packages | scratch venv, PyPI |

The command, verbatim from the README ("generate video_2X_xxfps.mp4"):

```
python3 inference_video.py --multi=2 --video=video.mp4
```

and its flags as `inference_video.py` defines them (a selection of lines 57–70, the whole `add_argument` block, verbatim;
`--img`, `--montage`, `--UHD`, `--skip`, `--ext` and `--exp` are left out):

```
parser.add_argument('--video', dest='video', type=str, default=None)
parser.add_argument('--output', dest='output', type=str, default=None)
parser.add_argument('--model', dest='modelDir', type=str, default='train_log', help='directory with trained model files')
parser.add_argument('--fp16', dest='fp16', action='store_true', help='fp16 mode for faster and more lightweight inference on cards with Tensor Cores')
parser.add_argument('--scale', dest='scale', type=float, default=1.0, help='Try scale=0.5 for 4k video')
parser.add_argument('--fps', dest='fps', type=int, default=None)
parser.add_argument('--png', dest='png', action='store_true', help='whether to vid_out png format vid_outs')
parser.add_argument('--multi', dest='multi', type=int, default=2)
```

The lines that decide the rate (103–110, 140): the frame count never depends on `--fps`.

```
    fps = videoCapture.get(cv2.CAP_PROP_FPS)
    ...
    if args.fps is None:
        fpsNotAssigned = True
        args.fps = fps * args.multi
    ...
    vid_out = cv2.VideoWriter(vid_out_name, fourcc, args.fps, (w, h))
```

What the worker (task 3) should therefore run, one clip, multiplier 2, with the clone at `/rife` and the zip's folder at
`/rife/train_log`; `--fps` is given as twice the input's rate (64 for a 32 fps clip) only so the audio step is skipped:

```
/rife/.venv/bin/python /rife/inference_video.py --multi=2 --video=<in.mp4> --output=<rife.mp4> --model=/rife/train_log --fps=64
```

then `ffmpeg` re-encodes `<rife.mp4>` (mp4v) to H.264 `yuv420p` at 64 fps. No `--fp16` and `--scale` 1.0 (the defaults)
until the owner's measurement says otherwise. `/rife/.venv` is a virtualenv made with `--system-site-packages` (so it
uses the image's CUDA `torch` and `torchvision`, which are not installed twice) in which `numpy==1.23.5`,
`sk-video==1.1.10`, `scipy==1.11.4` (sk-video needs scipy; the latest scipy requires `numpy>=2.0.0`, 1.11.4 requires
`numpy<1.28.0,>=1.21.6`), `opencv-python-headless==4.11.0.86` (an abi3 manylinux wheel; headless because the slim image
has no `libGL`) and `tqdm` are installed, shadowing the image's numpy 2 and its OpenCV. Two points only the image build can confirm, so its build check must import
the venv's `cv2`, `skvideo.io` and `torch` and load the model: that the image's `torch` runs with numpy 1.23.5, and that
`torch.load('{}/flownet.pkl'.format(path))` (in the zip's `RIFE_HDv3.py`, with no `weights_only`) loads under a `torch`
that defaults to `weights_only=True`. The zip's `RIFE_HDv3.py` (as read from a mirror of the same size,
`MonsterMMORPG/RIFE_4_26`) sets `self.version = 4.25`, so `make_inference` takes its `model.version >= 3.9` branch:
`model.inference(I0, I1, (i+1) * 1. / (n+1), args.scale)`. The exact-rate mode is therefore **not** in this
implementation; the model itself takes any `timestep`, so a later change could write its own loop that draws the frames of
an exact 60 fps timeline. Not built (§10).

## 4. The stages

- **`upscale`** (Full HD, `src/stages/upscale.ts`): for a 60 fps run it sends `interpolate: 2` in the same job. Its cache
  key (`inputsFor`) gains `interpolate: 2` only when set, so every other run keeps its key. Its output (`paths.upscaled`) is
  then a 64 fps clip.
- **`interpolate`** (new, `src/stages/interpolate.ts`): a paid per-scene stage in `StageName`; applies to Mode 1 scenes of a
  60 fps run **without** Full HD (`isSmoothed`); deps `clips`; keyed on the clip file, the multiplier and the model; output
  `paths.smoothed`; the scene gains an optional `smoothed: { path, sourceUrl?, duration }` like `upscaled`. Between `clips`
  and `fit`.
- **`fit`** plays the upscaled file, else the smoothed one, else the raw clip, in `deps`, `inputsFor` and `run`; its
  `fps=${fps}` filter thins 64 to 60 (§3.1 found no target-rate mode, so it always thins).
- **The seam frame** for chained scenes is still taken from the raw clip (`writeSeam`), as already for Full HD.
- **Touch points** the plan lists with `grep` and the graph (`graphify explain "upscaleStage"`, `affected`): `StageName`,
  `src/stages/index.ts`, `paths.ts`, `reroll.ts` (a clip's reroll must also remake its smoothed/upscaled file), `versions.ts`,
  `require.ts`, `src/studio/status.ts`, `web/lib/labels.ts` (the studio's words for the stage).
- **Cost.** `interpolateCost(prices, seconds, first)` and the extra inside the Full HD job are priced by GPU seconds per clip
  second and a cold start, from rates in `prices.json`: `runpodInterpolateUsdPerSec`, `runpodInterpolateSecPerClipSec`,
  `runpodInterpolateColdStartSec`, and for the combined job `runpodRestoreExtraSecPerClipSec`. **No defaults**: until the owner
  has measured and set them, the choice is not offered (gated by an owner switch, not by prices: §11) and `createProviders`/`estimateCostUsd` refuse (the rule phase 10 §3
  set for FLUX 3). The stage estimate is conservative; the job's own measured time is what is charged (`runProviderJob`).

## 5. The render, the studio, the queue

- **Render.** Remotion takes `fps` from the props already (`calculateMetadata` in `Root.tsx`). At 60 the local render makes
  twice the frames with the same encoder settings (h264, crf 18): roughly twice the render time and a file about 1.5 times
  larger, both measured by the owner. The loudness pass and the final duration use `totalFrames / fps` already.
- **The form** gets a "Motion" control, Standard or Smooth (60 fps), shown only when `health.smooth` is true: the restorer
  endpoint and its prices are set (gated by an owner switch, not by prices: §11). The health answer says that a setting is missing without saying which. The copy is plain
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
- 64-to-60 thinning drops about one frame in 16 unless §3's gate finds an exact-rate mode (it found none: §3.1).
- A 64 fps 1080p clip is a large download from R2; the measurement covers the time.
- The local render takes about twice as long and the file is larger; some platforms re-encode a 60 fps upload.
- The restorer image is rebuilt and redeployed; SeedVR2's behaviour under a changed image is unchanged by design (its step is
  untouched) but unverified without a GPU.
- 60 fps cannot be added to an existing run (§0).

## 10. Not in scope

A tier above 1080p; converting existing runs; changing the 30 fps default or fixing its 32-to-30 judder (a later change could
write its own loop at fractional time steps, §3.1's last paragraph; none exists today); the clip worker's RIFE; the other items on the list (lip sync and sound effects, trend discovery).

## 11. What the plan found and changed (a later section wins)

- **The form's control is gated by an owner switch, not by prices.** The web server never reads `prices.json` (it is the CLI's), so `health.smooth` is `RUNPOD_UPSCALE_ENDPOINT` set **and** `FLOWCHAIN_SMOOTH_MOTION=on` (default off, set by the owner after the rates are measured), like `FLOWCHAIN_CUT_REFERENCES`. The CLI still refuses a 60 fps run without the four rates, in `newRunRestore`, and `createProviders` refuses it too, so a mis-set switch fails plainly and early.
- **One GPU rate for the restorer's new workflow.** `restore-video@1` jobs, with or without Full HD, are charged at `runpodInterpolateUsdPerSec`; the old `upscale-seedvr2@1` workflow keeps `upscaleUsdPerSec`. A Full HD run that does not ask for 60 fps keeps the old workflow, so its jobs and keys are unchanged.
- **The fake restorer** stands in for both steps; its interpolation doubles the frame rate with ffmpeg's `fps=` filter (frames repeated, which is enough to test the pipeline).
- **No exact-rate mode** (§3.1): Practical-RIFE's `--fps` only relabels the frames. The worker sends `interpolate: 2` (32 fps in, 64 out) and `fit` thins 64 to 60, as §4 and §9 already allow.
- **The weights are RIFE 4.26 from the author's own Hugging Face repository**, pinned by revision and checked by SHA-256 (§3.1), not the README's Google Drive links and not the clip worker's `rife49.pth` (whose model code is only on Google Drive). The zip brings the model's code too; it is unpacked to `/rife/train_log`.
- **RIFE runs in its own virtualenv** (`/rife/.venv`, with the image's `torch`): its `sk-video` needs numpy 1.23.5, and SeedVR2's packages in the image's Python have numpy 2. The image's build check imports that venv's packages and loads the model.
- **A RIFE step is two subprocesses**, not one (§3 "One subprocess per step"): `inference_video.py`, then `ffmpeg` to re-encode its MPEG-4 Part 2 output to H.264. Both are pure command builders tested without a GPU; each failure raises with the tail of its output, nothing retried.
- **`--fps=<2 × input rate>` is always passed**, which skips the script's audio step (it imports `moviepy.editor`, absent from moviepy 2, and would end in an error); clips carry no audio.
- **The interpolated clip is one frame short**: `N` frames in give `2N − 1` out at 64 fps (1/64 s less than twice the length). `fit` must tolerate it (it already pads or trims to the frame count it computes); task 5's real-ffmpeg test uses a clip of that length.
- **GPU memory at 1080p is not stated** anywhere read; the 24 GB card is assumed enough for one frame pair at a time, and the owner's measurement (§7) confirms it.
