# Flow-Chain-AI — CLI and Studio

Turns a topic into a captioned short video. Audio drives timing: the voiceover is generated and
silence-trimmed first, then every visual is fitted to it frame-exactly. The final video is rendered with
Remotion (React): word-by-word captions, Ken Burns stills, transitions at cuts and ducked background music.

Design: `docs/superpowers/specs/2026-10-02-phase1-cli-poc-design.md` (pipeline),
`docs/superpowers/specs/2026-10-03-phase2.1-remotion-render-engine-design.md` (render engine),
`docs/superpowers/specs/2026-10-04-phase2.2-content-intelligence-design.md` (modes, transitions, style presets),
`docs/superpowers/specs/2026-10-05-phase2.3-retention-brand-design.md` (hook, sound effects, brand kit, clip lengths),
`docs/superpowers/specs/2026-10-05-phase2.4-runpod-providers-design.md` (RunPod providers)
and `docs/superpowers/specs/2026-10-06-phase3.1-web-ui-player-design.md` (the studio web app).

## Setup

1. `brew install ffmpeg` (≥ 6 with libx264), Node ≥ 22.12
2. `npm install`
3. `cp .env.example .env` and fill in `GEMINI_API_KEY`
4. Set up the GPU endpoints that make the pictures, the clips and the voice: see "The GPU worker" below
   (`npm run runpod:deploy`, then `npm run voice:deploy`)
5. `npm run flowchain -- doctor` — every line must show ✓ (the first run downloads Remotion's headless
   Chrome, ≈ 100 MB, once)

## Usage

```bash
npm run flowchain -- run --topic "The last lighthouse keeper" --scenes 4            # auto modes, Gemini picks the style
npm run flowchain -- run --topic "…" --style cyberpunk --budget 2                   # a fixed style preset and budget
npm run flowchain -- run --topic "…" --duration 60 --scene-seconds 3-5              # by length: the script decides the number of scenes
npm run flowchain -- run --topic "…" --modes 1,2,1,1 --aspect 16:9 --bgm music.mp3 # hybrid, modes fixed by hand
npm run flowchain -- run --topic "…" --caption-style mrbeast --transition zoom      # override the preset's look
npm run flowchain -- run --topic "…" --brand assets/brand/example                  # watermark, brand font and colours
npm run flowchain -- run --topic "…" --hook "3 minutes to midnight" --seed 42      # own hook title, fixed seed
npm run flowchain -- status <runId>
npm run flowchain -- resume <runId> [--from clips]
npm run flowchain -- reroll <runId> --scene 2 --stage clips    # later chained clips follow
npm run flowchain -- rerender <runId> --caption-style minimalist --transition dissolve   # free
npm run flowchain -- rerender <runId> --no-hook --sfx-gain 0.4 --no-brand                # free
npm run flowchain -- rerender <runId> --hook-on --sfx                                     # free
```

Mode 1 = image-to-video, each continuing clip starting from the last frame viewers see of the
previous (fitted) clip. Continue seams are always hard cuts.
Mode 2 = a still picture animated with a Ken Burns camera move at render time (no clip is generated).

`--mode auto` (the default) lets Gemini rate each scene's action level: high → Mode 1, low → Mode 2, medium →
Mode 1 while the run fits the budget (`--budget`, frozen with the run), otherwise Mode 2, largest saving first.
`--mode 1|2` or `--modes` fix the modes by hand. `status` shows each scene's mode and why.

Style presets (`--style`, default: Gemini picks one for the topic): `cinematic_history`, `anime`, `cyberpunk`,
`dark_fantasy`, `photorealistic_8k`, `3d_render`, `cartoon`, `comic_book`, `watercolor`, `pixel_art`, `film_noir`,
`flat_illustration`, `epic_fantasy`, `claymation`. A preset wraps every image and motion prompt and brings its own
caption look.

Caption styles: `preset` (default: the style preset's look), `hormozi`, `mrbeast`, `minimalist`. Transitions at
cuts: `auto` (default: the one Gemini suggests for each cut), `cut`, `fade`, `dissolve`, `blur`, `zoom`, `glitch`.
`--bgm-gain` sets the music level outside speech (default 0.35); under speech it ducks to 40 % of that.

The first 3 s open with a hook: a snap zoom and a big title Gemini writes (or `--hook "…"`)
(`--no-hook` turns it off, and `rerender --hook-on` brings a removed hook back). The script also writes a sound bible
(the video's sound palette) and a sound prompt for every scene; a sound is made from each prompt (`--no-sfx` and `--sfx-gain`
control it; see "Scene sound" below).

A brand kit is a folder with `brand.json` (see `assets/brand/example`): a logo watermarked at a corner, and an
optional font, text and accent colours and character bible. `--brand <dir>` copies it into the run;
`--characters "…"` sets the character bible directly. Every keyframe of a run shares one seed (`--seed`).

Each run lives in `runs/<runId>/`: `manifest.json` (state, cache keys, cost ledger), `final.mp4`,
`chain.png` (per scene: first frame of the raw clip and last frame of the fitted clip, or the keyframe for
Mode 2 — use it to judge continuity at each seam), plus intermediates.

## Costs

Estimates come from the price table in `src/config.ts` (override with `prices.json`). A run asks for
confirmation when the estimate exceeds `FLOWCHAIN_BUDGET_USD` (default $3); rerolls ask unless you give `--budget`; `--yes` skips.
For `--mode auto` runs, `--budget` (or `FLOWCHAIN_BUDGET_USD`) and the price table are frozen with the run for
the mode rules; a later `--budget` only changes when to ask. `resume --from <stage>` re-runs, and re-buys,
that stage and every later one (so `--from modes` re-buys every keyframe and clip). On runs with a seed,
`resume --from keyframes` (or an earlier stage) reproduces the same keyframes because the seed is fixed;
`reroll --scene N --stage keyframes` gets new ones. Narration is capped at 16 words per scene, and a clip is
only as long as its narration needs (the fit step stretches it by up to a quarter), so a typical 4-scene
Mode 1 run is about $0.30. `rerender` never calls a paid API. `npm run smoke` runs a real 3-scene all-Mode-1
video with `--shots cut,continue,continue`, so two real continuity seams are always exercised. `--shots` is a testing override; without it the LLM decides. `npm run
smoke:auto` runs a real 4-scene `--mode auto --style cyberpunk` video with the example music bed, and `npm run
smoke:brand` a 4-scene `--style anime` video with the example brand kit.

Rendering a 16 s 1080×1920 video takes about 1.5 minutes on Apple Silicon (`--render-concurrency` tunes it).

## The GPU worker (keyframes and clips)

Pictures (FLUX.2 klein, which keeps a character from a portrait) and clips (Wan 2.2 image-to-video) run on
your own RunPod Serverless endpoints: roughly $0.20 per 4-scene video at 480p, about $0.30 and twice the wait with 720p clips
(`--clips 720p`, or "HD" in the studio's form). This is the only way the studio makes
pictures. Runs made earlier on hosted models (fal) still load and re-render for free, but they can no longer be
resumed or rerolled: `resume` and `reroll` say so and buy nothing.

One-time setup (accounts and keys only):

1. RunPod: create an API key → `RUNPOD_API_KEY` in `.env`.
2. Cloudflare R2: create a bucket and an S3 API token with read/write on it → `R2_ACCOUNT_ID`, `R2_BUCKET`,
   `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` in `.env`.
3. Push this repo to GitHub: the `worker-image` Action builds `ghcr.io/<owner>/flowchain-worker`. Make that
   package public (GitHub → Packages → flowchain-worker → Package settings → Change visibility).
4. `npm run runpod:deploy` creates the network volume, template and two endpoints, downloads the model weights
   onto the volume and writes `RUNPOD_KEYFRAME_ENDPOINT` / `RUNPOD_CLIP_ENDPOINT` into `.env`. It shows what it
   will create, the monthly volume cost (≈ $3.50 for 50 GB, which the two models fill almost to the brim) and the one-time model download it runs on the
   endpoints' GPUs (≈ $1–2), and asks first; re-running it updates in place. It uses the image tag built from the
   current `workers/` folder and stops if that image is not public on GHCR. `RUNPOD_WORKER_IMAGE` deploys another
   image instead, `RUNPOD_DATACENTER` picks another data centre (default `EU-RO-1`), and `--yes` skips the question.

Then `npm run flowchain -- doctor`. `npm run smoke:runpod` makes a real 4-scene video and is a paid run.

While a run's pictures are made, the clip worker is asked to start (a job that makes one tiny throwaway clip, so its models are loaded;
nothing is uploaded), so the first clip does not wait for it; what that start costs is charged with the first clip.

`npm run runpod:deploy -- --remove-old-volume` deletes the larger volume used before (`flowchain-models`), once a
run on the new one has worked. It refuses while any endpoint still reads from it. A deleted volume is gone for good.

Re-running `runpod:deploy` also takes off the volume any weight the clip worker no longer lists (the earlier
picture models; the text encoder and VAE, which are inside the clip image now).

### FLUX 3 klein pictures (optional)

A second picture model, on its own endpoint beside the 4B above; a run keeps the model it was made with. In order:

1. On Hugging Face, accept the terms of `black-forest-labs/flux-3-image-klein`, make a read token, and read the model's `LICENSE.md`.
2. Deploy its endpoint on a 48 GB card (names as RunPod lists them; the token is passed through the shell for this command only):
   `RUNPOD_PICTURE3_GPUS="<48 GB card names, comma separated>" HF_TOKEN=… npm run runpod:deploy`. It writes `RUNPOD_PICTURE3_ENDPOINT` into `.env`.
3. Measure one real video and set the four `runpodPicture3UsdPerSec`, `runpodPicture3Sec`, `runpodPortrait3Sec`, `runpodPicture3ColdStartSec` prices in `prices.json`. The model is not offered until all four are set; keep them while any run made with it may be resumed or remade.
4. `FLOWCHAIN_IMAGE_MODEL=flux3` insists on it and `klein4b` forces the 4B. To try references between cuts, make the same script and seed twice, with `FLOWCHAIN_CUT_REFERENCES=off` and `on`, then compare: `npm run eval:cuts -- <runOn> <runOff>` (free). Set it to `on` in `.env` if that shows a gain.

Both picture models are one image and one template, so any `runpod:deploy` puts the 4B on the same software as FLUX 3. To go back to the picture image from before FLUX 3:
`RUNPOD_PICTURE_IMAGE=ghcr.io/<owner>/flowchain-picture:p-795ce3d4a463 npm run runpod:deploy` (this also takes FLUX 3 down).

### Smooth motion (60 fps, optional)

A video can be made at 60 frames a second instead of 30. It is a choice made when the video is created (`--fps 60`, or "Frame rate" in
the studio's form once it is switched on); it cannot be added to a video that exists, because chained clips are made for one frame rate.
The default stays 30: clips already arrive at 32 fps from the clip worker. At 60, every moving clip goes through the restorer
worker (`worker-upscale/`, the one that does Full HD), which interpolates it from 32 to 64 fps; the fit then thins 64 to 60, so one frame
in 16 is dropped (there is no mode that lands on 60 exactly). In a Full HD video at 60 fps it is one job per clip, not two. The render takes
longer and the file is larger; measure both on your machine. A 60 fps run is refused until the four prices below are set. In order:

1. Rebuild and push the restorer image: the `upscale` job of `.github/workflows/worker-image.yml` does it when `worker-upscale/` changes (the tag is `u-` and the first 12 characters of that folder's tree hash). The image is rebuilt from nothing (`worker-image.yml` has no layer cache), so every layer is resolved again: SeedVR2 then runs on whatever `torch` is current, not the one Phase 8 measured. Compare one Full HD video before and after; the rollback tag below exists for this. Only the build confirms two things: that the interpolator's separate virtualenv (numpy 1.23.5 beside the image's torch) works, and that its weights load. The build's final check runs both and fails the image if either is wrong.
2. `npm run runpod:deploy` (it prints its plan first) puts the new image on the restorer endpoint.
3. Make one video with `npm run flowchain -- run … --fps 60` and one with `--upscale --fps 60`. The ledger holds dollars per job, not seconds: read each job's execution time in the RunPod console (the reliable source), or divide the job's `usd` in the ledger by the per-second price it was charged at (your provisional `runpodInterpolateUsdPerSec`), then divide by the clip's seconds.
4. Set `runpodInterpolateUsdPerSec`, `runpodInterpolateSecPerClipSec` (interpolation alone), `runpodInterpolateColdStartSec` and `runpodRestoreExtraSecPerClipSec` (what Full HD adds inside the same job) in `prices.json`. Keep them while any 60 fps run may be resumed or remade.
5. Set `FLOWCHAIN_SMOOTH_MOTION=on` in `.env`. The studio shows the choice only when the restorer endpoint is set and this is `on` (the web server does not read `prices.json`, so the switch is yours to set after measuring).
6. Judge the motion: fast action, faces, fine detail; and that the platform you post to accepts a 60 fps upload.

To go back to the restorer image from before smooth motion, in this order:

1. Set `FLOWCHAIN_SMOOTH_MOTION=off` first. The form hides the control, a new draft that asks for 60 fps is refused, `generate` of a 60 fps draft is refused before any credit is held, and a series whose recipe is 60 fps stops and waits for its owner.
2. Wait for any 60 fps run that is already generating to end, or stop it: it would buy its clips and then fail at the restorer.
3. `RUNPOD_UPSCALE_IMAGE=ghcr.io/<owner>/flowchain-upscale:u-415cd27e11cc npm run runpod:deploy`. That takes smooth motion down but not Full HD (the old image has the old workflow).

The switch gates the studio only. `npm run flowchain -- run … --fps 60` (your own tool) is not gated by it, only by the four prices, so a 60 fps run from the command line after the rollback fails at the restorer.

### Scene sound (optional)

Each scene can have a sound layer made for it: the script writes a sound prompt for the scene, and a sound model on the studio's own
GPU endpoint listens to the scene's picture and makes what would be heard there (wind, footsteps, a machine). It plays under the whole
scene, under the narration and ducked while it speaks. It replaces the old library of bundled sound effects: those, the hook's impact,
the cut sounds and `npm run make:sfx` are gone. A video made with the old library and rendered again has no sound effects; nothing makes
them any more.

**Where the model's licence does not apply.** It is under the Tencent Hunyuan Community License: commercial use is allowed, but the
licence does not apply in the European Union, the United Kingdom and South Korea; outputs may not be used to improve another AI model;
above 100 million monthly active users a separate licence is needed. You accepted this knowing it. Whether to offer the layer to users in
those three places is yours to decide (spec §7); `FLOWCHAIN_SCENE_SOUND` is the one switch, and a video without sound is complete.

Settings, in `.env`. On a server they are the worker's: `npm run server:setup` and `server:deploy` write them (with whatever
`deploy/server.env` sets over them) into the worker's settings file, and the web app's file never carries them. The web app does not need
them: with the queue it learns whether scene sound is offered from the worker's health answer, the form shows the switch only then, and a
new draft carries `--no-sfx` whenever that answer does not offer it, so a customer who was shown no switch is never sold sound (a series on
a schedule is begun by the worker, which asks its own settings the same way). In the owner's own studio without the queue, `.env` is both.

- `FLOWCHAIN_SCENE_SOUND=on|off` (default off). A new video gets scene sound only when this is `on`, the endpoint is set, the three prices
  exist and its sound effects are not switched off. The choice is frozen when the video is created.
- `RUNPOD_FOLEY_ENDPOINT`: written by `npm run runpod:deploy`.
- In `prices.json`: `runpodFoleyUsdPerSec` (the 24 GB flex rate per second, from RunPod's published price: look it up and cite it),
  `runpodFoleySecPerClipSec` (seconds of work for one second of scene) and `runpodFoleyColdStartSec`. Keep them while any run made with
  sound may be resumed or remade.

In order:

1. Push. The worker-image workflow builds `flowchain-foley` (tag `f-` and the first 12 characters of `worker-foley/`'s tree hash). The image
   is large (25 to 30 GB with the model inside) and the build may take long; its first build has never been run and may need fixes.
2. In GitHub's web UI, make the `flowchain-foley` package public (the first time).
3. `npm run runpod:deploy` (it prints its plan first). While the image is missing it skips Foley with one line and deploys the rest.
4. Measure on the real endpoint (each step is cents): the same clip with three seeds and two guidance values, and listen (are they different
   enough?); a 10 s and a 15 s clip (what the model does at its limit); the job's `executionTime` and `delayTime` from RunPod's status
   right after a run on a warm worker, then a cold one, for the three prices; then one whole four-scene video, its cost, and how the layer sits
   under the narration (tune `SOUND_MIX` and `LOUDNESS_TARGET_LUFS` by ear). Update `web/content/measured.json` with the new full-video cost.
5. Set `runpodFoley*` in `prices.json`, then `FLOWCHAIN_SCENE_SOUND=on` in `.env` (on a server: then `npm run server:deploy`, which
   writes it into the worker's settings).

Rollback: set `FLOWCHAIN_SCENE_SOUND=off` in `.env` (on a server: in `deploy/server.env`, which wins over `.env`, then
`npm run server:deploy`). The form hides the control and new videos are made without sound; a video already made keeps its sound and plays it.

Runs with characters get one generated reference portrait (or a brand kit's `reference` image), made after the
voice and straight before the pictures so the picture worker starts once; every keyframe of a scene the
character is in is conditioned on it; `reroll <runId> --stage reference --scene 1` generates a new portrait (keyframes are then
redone from it). Clips are 480p (upscaled to the output size) with frame interpolation to 32 fps. GPU time is
charged per job from RunPod's measured execution time; cold starts and idle time are not attributed per job.

### Topic ideas (optional)

The new-video form can offer "Suggest a topic": one model call with Google Search (and, with a key, YouTube's public most-popular
chart for the language's usual region) that writes up to eight ideas for the chosen niche, each with a sentence on why it is current and
its sources. Choosing one only fills the topic field; the video is the usual paid draft. The same niche rules hold as for every video
(no health, religion, politics or money products), and a link is shown only when the model really read that site.

- `FLOWCHAIN_TREND_IDEAS=on` in `.env` switches it on (default `off`); it also needs `GEMINI_API_KEY`. On a server the **worker** needs
  both, since the web reads the worker's health answer.
- `YOUTUBE_API_KEY` is optional: a YouTube Data API v3 key (Google Cloud console, no OAuth). Without it the model works from search alone.
- From the command line (the owner's, a paid call): `npm run flowchain -- ideas --language en --niche <id>` (or `--niche-text "…"`)
  prints the ideas as JSON and the tokens and searches used on a line starting `ideas:` on stderr.
- **Time.** A call that searches the web takes 20–60 s (measured 2026-10-30), so a click can take up to about two minutes: the prompt
  asks for at most three searches, the model call may take 90 s, the CLI 100 s, and the studio waits 110 s (`IDEAS_WAIT_MS`) before
  saying nothing came. Other quick commands still wait 60 s.
- **Price.** A studio with accounts charges a fixed credit for each click, read from `web/content/ideas-price.json`, and shows the button
  only once `usd` there is a number. To set it: run `ideas` for three niches, take the tokens and searches from the `ideas:` lines, work
  out the cost at the provider's current published prices, add a margin, and write `{ "usd", "measuredOn", "basis" }`. Write `usd` with
  at most four decimals (0.0123, not 0.01234): credit is held in ten-thousandths, and a finer price counts as no price (no button). Check on the same
  runs that Google Search worked on your key and model (the sources are not empty). A user who gets no ideas, or ideas after the studio
  stopped waiting, pays nothing. The owner's own studio without accounts charges nothing.
- **Rollback.** Set `FLOWCHAIN_TREND_IDEAS=off` on the **worker** (its `.env`, or `deploy/server.env` on a server) and restart the
  worker: the web reads the switch from the worker's health answer, which it caches, so changing the web's own setting does nothing.
  The button then goes and the route answers 404; there is nothing else to undo. The migration that added the `ideas` kind stays
  applied. Old hidden request rows are not pruned.

### The voice

New runs are spoken by the hosted voice (ElevenLabs) while `ELEVENLABS_API_KEY` is set, and by the studio's own
voice below without it (phase 5 spec §11: the owner's listening test of the own voice failed in Turkish and in
telling its voices apart). The studio's voices (Storyteller, Host, the narrators…) are roles: which hosted voice
plays each, in each language, is in `assets/voices/elevenlabs.json`. To fill it:

1. `npm run make:voices -- --hosted-candidates en` (and `tr`, …): the library's voices native to that language,
   most used first, with their previews in `.superpowers/voices/` to listen to. Reads only; buys nothing.
2. `npm run make:voices -- --hosted-add <role> <language> <voiceId> [<publicOwnerId>]`: gives a role that voice
   (a library voice is added to the account first: it needs the `publicOwnerId` from step 1).
3. `npm run make:voices -- --again en tr`: the samples on the form, made again in the hosted voices (a few cents).

A line costs its characters at `ttsPer1kChars` in `prices.json` (0.30 a thousand by default, the dearest it is
sold at: lower it to your plan's rate). A role with no voice in a language speaks it in its English voice, and the
form says so; a role with no voice at all is refused before anything is bought. Runs made with the studio's own
voice stay on it.

### The studio's own voice

`npm run voice:deploy` creates one more endpoint, for the voiceover (VoxCPM2, with a Whisper model that says
when each word was spoken, which the captions need), and writes `RUNPOD_VOICE_ENDPOINT` into `.env`. Without the
hosted voice's key, every new run is spoken there: about a cent for the first line of a run (the worker loads its models) and about a tenth
of a cent for each line after it. It needs no volume and uploads nothing: a line goes in, its speech comes back in the
answer. The first line on a host that has never run it waits about four minutes while the image is fetched. Its image is built by the same GitHub Action from `worker-voice/`; make the
`flowchain-voice` package public once, like the other.

- Two voices are in the image, `narrator-m` (the default) and `narrator-f`; `FLOWCHAIN_VOICE` or `--voice` picks
  one. Both were invented from a written description, not recorded from a person. Each has a Turkish and an
  English reference clip; a script in another language is spoken from the English one.
- The voice reads digits its own way, and not always rightly in Turkish: for a number that must be right, have
  the script write it in words.
- A line the voice did not speak as written (it happens now and then) is asked for once more by itself; both
  tries are charged. After that the run stops, to be continued by hand.

The model stack is licensed for commercial use (VoxCPM2 and Whisper: Apache 2.0 and MIT).

FLUX.2 klein 4B and Wan 2.2 are Apache 2.0, which allows commercial use. The FLUX 3 klein picture model (when you set it up, below) is not: it is under the FLUX Kommunity License v.1.0. Its outputs may be used commercially while your gross annualised revenue, with your affiliates, is under US$5M; the text does not address hosting the model for others; Black Forest Labs may end the license on notice; and its pictures must not be used to train another model. `docs/superpowers/specs/2026-10-18-phase10-flux3-reframe-design.md` §1 has the details, and the license itself is the one to read.

## Studio (web app)

`npm run web` starts the studio at <http://127.0.0.1:3131>: a local, single-user front end to the same runs the
CLI makes (everything in `runs/` shows up, and anything made in the studio can be resumed from the terminal).

1. **New video** buys only the script (about $0.006) and opens a **draft**: the real Remotion composition in the
   browser with placeholder pictures, estimated timing and no voice, but the real captions, hook, transitions,
   brand, music and sound effects.
2. On the draft, set each scene to **Auto, Clip or Still**; the price updates. **Generate video** shows the
   estimate on the button, and that amount is a cap on what the job spends in total (`--cap`): if what the job
   has already spent plus what is still planned ever exceeds it, the run stops and asks again instead of
   spending more.
3. A finished run plays with its real media. Caption style, transitions, hook, sound effects, music level and
   brand preview live as you change them; **Apply and re-render** is free. Each scene can get a new voice take,
   picture or clip, priced before you confirm and capped at that price in the same way. Generating and
   regenerating a scene first save a look you changed but have not saved, so the video is made with the look
   the preview shows; **Save this look** keeps a look on a run that is not finished yet.
4. **Brand kits** creates kits by upload (logo, optional font, colours, characters, portrait) into `brand-kits/`;
   music can be uploaded in the new-video form (`uploads/music/`). Both folders are git-ignored. Upload limits:
   logo 2 MB, font 5 MB, portrait 6 MB, music an MP3 of up to 20 MB.

The studio has no login. It listens on `127.0.0.1` only, answers only requests addressed to `127.0.0.1` or
`localhost`, and refuses any write that does not come from its own pages. API keys stay in `.env`, and only
the CLI uses their values: the studio reads `.env` only to see which names are set, and the browser never receives a value. Jobs are the CLI itself, started detached, so
a job keeps running if the web server restarts; at most two run at once. The preview is not frame-exact (the
rendered MP4 is), and draft timings are estimates.

The studio's own settings are not read from `.env`: set `STUDIO_MAX_JOBS` (how many jobs may run at once) and
`RUNS_DIR` (another runs folder) in the environment the studio starts in, for example
`STUDIO_MAX_JOBS=3 npm run web`.

Remotion is free for individuals and companies of up to three people; larger companies need its company licence.

The studio uses these CLI commands, which also work on their own:

| Command | Does |
|---|---|
| `run --draft` | buys only the script and stops; `resume` continues |
| `run --pin-modes auto,1,2` | pins scenes of an auto run to clip (1) or still (2) |
| `draft-modes <runId> --modes auto,1,2` | changes the pins while only the script is bought |
| `plan <runId> [--reroll 2:clips] [--modes …] [--json]` | what continuing would do and cost, without doing it |
| `look <runId> …` | stores a new look without rendering (takes `rerender`'s look options, not `--render-concurrency`; works on a draft) |
| `status <runId> --json` | the status as JSON |
| `reroll … --budget <usd>` | a reroll that spends up to an amount without asking |
| `resume … --cap <usd>`, `reroll … --cap <usd>` | stops the command when what it has spent plus what is still planned would exceed the amount |

## Studio on a server

One server runs the studio over HTTPS — for you alone behind one login, or with accounts (next section): a proxy (Caddy), the web app, **one
worker** that takes jobs from a queue (Redis) and runs the CLI for each, and Redis. Jobs wait their turn: two
generations run at once by default, the rest show their place in line. A job is never retried on its own — a
failed or interrupted run waits for you to press Resume, so nothing is bought twice.

Once, by hand: rent a server (4 vCPU, 8 GB RAM, Ubuntu or Debian, your ssh key for `root`), point a DNS name
at it, then `cp deploy/server.env.example deploy/server.env` and fill in `SERVER_HOST` and `STUDIO_HOST`. The
provider keys are taken from your `.env`.

| Command | Does |
|---|---|
| `npm run server:setup` | installs Docker if missing, creates `/opt/flowchain`, writes the settings and keys, makes the login password (shown once), turns on the nightly backup if `BACKUP_BUCKET` is set, then deploys |
| `npm run server:deploy` | copies the last commit to the server, builds, restarts and waits until the studio answers; a running job gets up to 30 minutes to finish first |
| `npm run server:backup` | copies runs, brand kits and uploads to the backup bucket now |

`npm run server:setup -- --new-password` replaces the login. Run setup again after changing a key in `.env` or
a setting in `deploy/server.env`. Connect to the server once by hand first (`ssh root@<server>`) and compare the
host key it shows with the one your provider lists: the scripts trust the key they see on first contact. If a
deploy is cut off (the laptop sleeps, the connection drops), run it again; it picks up where the server is.

On the server the web app holds no provider keys and never runs the CLI; only the worker does. The data is in
`/opt/flowchain/data` (`runs/`, `brand-kits/`, `uploads/`): a run made there is an ordinary run folder. The
backup copies new and changed files and never deletes from the bucket. How many jobs run at once is
`WORKER_CONCURRENCY` in `deploy/server.env` there (`STUDIO_MAX_JOBS` applies to `npm run web` only). If the worker is down, the studio says
so and refuses to start paid work instead of queueing it.

Locally nothing changes: without `REDIS_URL`, `npm run web` starts jobs itself as before. To try the queue on
your machine: `redis-server` in one terminal, then `REDIS_URL=redis://127.0.0.1:6379 npm run worker` and
`REDIS_URL=redis://127.0.0.1:6379 npm run web`.

## Accounts, credit and storage

With `STUDIO_ACCOUNTS=1` in `deploy/server.env` the studio has accounts, kept in a database of its own that
runs on the same server (Postgres, in the stack). Without it, nothing below applies and the studio is the
single-user app described above.

- **Signing in.** Anyone can create an account with an email address and a password, or with Google. Each user
  sees only their own videos, brand kits and music: everything of anyone else's answers "not found". There is
  no proxy login and no password from setup in this mode: you sign up like everyone else.
- **Credit.** Every account has a balance in USD, starting at 0. A generation or a regenerated scene holds the
  amount you approve on its button, the worker runs it capped at that amount, and what it did not spend comes
  back; a draft holds $0.02 for its script (about $0.006). The account page shows the balance and every
  movement. With too little credit the button says so and nothing starts. You add credit with
  `npm run studio:grant -- --email <address> --usd 5` (`--usd -2` takes some back; it prints which studio it
  acted on).
- **What is charged.** What the run's own record says was spent, plus anything that was sent to a provider and
  not collected: a clip, picture, narration or script request that was on its way when the job was stopped is
  charged, because the provider bills it either way. This errs on the side of charging: a request the provider
  in the end never ran, or one that cost less than expected, stays charged at the expected price. A provider
  that bills by measured time can also come out slightly above a cap; the real amount is charged, and a
  balance below zero has to be topped up before anything paid can start.
- **Storage.** With `STUDIO_BUCKET` set (a private R2 bucket of its own), every run is copied to the bucket
  after each job and uploads are kept there; the server's disk is a cache. A run untouched for
  `STUDIO_CACHE_DAYS` (14) is removed from the disk and comes back when its owner opens it. A file the disk
  lacks is served by a link to the bucket that is valid for five minutes.
- **Limits.** One account may have two long jobs waiting or working (`STUDIO_USER_JOBS`). The database's
  `settings` table holds the rest: two paid jobs at once per account (`max_user_jobs`), twenty videos a day
  that are created and never started (`max_unstarted_runs`), twenty brand kits and fifty tracks (with or
  without a bucket). An upload is read only up to its limit, and the proxy passes on no request above 40 MB.
  Signing in, signing up and asking for a reset are each limited to twenty attempts in five minutes per
  visitor. Kits and tracks cannot be removed in the studio yet, so their limits are per account for good.

Once, by hand:

1. An SMTP service for the two emails the studio sends (the link that confirms an address, the link to choose
   a new password): put `SMTP_URL` (for example `smtps://user:password@smtp.example.com`) and `MAIL_FROM`
   (`Flow Chain AI <hello@yourdomain>`) in `.env`. Setup refuses accounts without them: an address nobody
   confirmed is nobody's.
2. Optional, for "Continue with Google": a Google OAuth client whose redirect URI is
   `https://<your studio>/auth/callback`; put `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` in `.env`. Without
   them the button is not shown.
3. Create the bucket and put `STUDIO_BUCKET` in `.env`.
4. Put `STUDIO_ACCOUNTS=1` in `deploy/server.env`.

Then `npm run server:setup` does the rest: it starts the database, makes its three passwords (they are kept
on the server only, in `db.env`, and never shown), creates the tables, and deploys. `npm run server:deploy`
brings the database up to the deployed commit before it starts the new code; `npm run db:migrate` does only
that. The web app gets its own address of the database, the mail server, the bucket and its keys; the worker
alone gets the provider keys and the address that can settle credit.

How it holds: the web app connects as a role that can only read a user's own rows and run the functions a
user may run; every write goes through a function that checks who is calling; settling, granting and
fulfilling payments can only be done by the worker's role, whose password the web app never has. The worker
runs a paid job only when credit is held for exactly that job, whoever queued it. Accounts always work through
the queue (`REDIS_URL`). A studio that is set up to have accounts and finds none configured answers nothing at
all, rather than run without a login.

What to know:

- **The web app tells the database who the visitor is.** It checks the session first, but the database takes
  its word. So a flaw that let someone run code in the web app could read any user's rows and hold any user's
  credit. It could still not grant credit, settle, or fulfil a payment. (With a hosted accounts service the
  database checked each visitor's token itself; running your own trades that away.)
- **The database is yours to look after.** It listens only inside the server (nothing outside can reach it),
  and with `BACKUP_BUCKET` set a copy of it is taken every night by the database itself and stored with the
  runs. Without a backup bucket there is no copy anywhere: accounts, balances and the record of every payment
  are on that one disk.
- **A migration that was applied is never edited.** Setup and deploy compare each file in `db/migrations/`
  with what the database had applied and refuse to go on if one has changed; put every change in a new file.
- Passwords are kept as salted scrypt hashes, sessions and emailed links as the SHA-256 of a random secret: a
  copy of the database signs nobody in. A session lasts 30 days; changing a password ends every other one.
- Guessing at passwords is limited per visitor (twenty attempts in five minutes), never per account: nobody
  can lock someone else out by guessing. One address is sent at most three emails an hour.
- Free work is not limited in number: re-renders and price checks cost you nothing at a provider but use the
  server's CPU. Two long jobs per account at a time is the only brake.
- With a bucket, a file the disk lacks is loaded by the browser straight from R2. Allow the studio's address in
  the bucket's CORS settings (GET, from `https://<your studio>`), or fonts loaded that way will be refused.
- The links in confirmation and reset emails sign in only the browser that asked for them: a link that worked
  anywhere could be used to sign someone into another person's account. Opened elsewhere, a confirmation link
  still confirms the address (the visitor then signs in with their password); a reset link does nothing.
- An account that has a history of payments cannot be deleted: its ledger is kept.

To try it on your machine: `npm run studio:local` (below) starts everything, the database included. For the
database alone: `npm run db:start` (Postgres in Docker, on 127.0.0.1:54330), `npm run db:reset` to empty it and
load it again from `db/migrations/`.

## Series

In a studio with accounts, **Series** keeps one kind of video set up: a name, a sentence saying what its videos
are about, and the new-video form's choices. **Make the next video** on a series' page starts an ordinary draft
(the script, held from credit as ever) whose topic is built from that sentence and the titles the series has
already made, so each is about something else. Removing a series leaves its videos in the list.

**By itself.** On a series' page you can give it a schedule (three a week, one or two a day). Approving it is
all there is: no amount is asked for. From then on the worker makes its videos without asking again, each held
from credit as usual, for as long as the credit covers them. It stops and says why on its page when your credit
does not cover the next video, or when a video is not finished (nothing is retried). It sends no email. You can stop it at any time. The worker looks at series every
two minutes (`WORKER_SERIES_MS`, in milliseconds).

**Publishing to a user's own YouTube channel** (optional). With `YOUTUBE_CLIENT_ID`, `YOUTUBE_CLIENT_SECRET` and
`CHANNEL_KEY` set, a user connects their channel on the account page (on Google's own consent page; the studio
never asks for a password) and a finished video has a Publish button. A series can be given a channel; with
"Show me each video first" off, its videos are published as they are finished.

Once, to turn it on: in a Google Cloud project switch on the YouTube Data API v3 and make an OAuth client with
the redirect address `https://<STUDIO_HOST>/auth/youtube/callback` (locally `http://127.0.0.1:3131/auth/youtube/callback`);
put its id and secret in `.env`, and `CHANNEL_KEY` as 32 random bytes in base64 (`openssl rand -base64 32`).
Keep that key: channel tokens are sealed with it, and with another every user must connect again.

What to know:

- **Until Google has audited the project, YouTube keeps every video it uploads private.** The user sees it on
  their channel; nobody else does. The audit and the verification of the upload permission are asked for in
  the Google Cloud console.
- A new project may upload about a hundred videos a day.
- Only the worker holds the client's secret, the key, and (sealed, in the database) the users' tokens. The web
  app holds none of them.
- This has been run only against a stand-in for Google. The first real consent and upload are yours to try.

## Payments

With `STRIPE_SECRET_KEY` set (and accounts, which payments need) users buy credit themselves. Without it
nothing below exists and credit is granted by hand as before.

- **What is sold.** `billing/plans.json` lists the plans, each with its monthly price, the cost it covers
  (`creditUsd`, in dollars of what videos cost you) and the minutes of fully generated video it is built around.
  A customer is never shown those dollars: they see **credits**, 2,000 to a dollar of cost (`CREDITS_PER_USD` in
  `web/lib/credit.ts`). The defaults are Starter $39 for 9,000 credits, Creator $99 for 27,000 and Pro $199 for
  80,000 a month: 5, 15 and 45 minutes of video in which every scene moves, with a fifth to spare (measured on
  2026-10-15 at $0.245 for four scenes spoken by the hosted voice: phase 6 spec §17). `yearlyMonths: 10` sells each plan by the year as well, for the price of
  ten months; its credits still come every month (the worker grants each month's on its day), and what is left
  of a month does not carry over. Nothing is sold once: `topups` is empty (the
  studio can still sell top-ups if you list some). What is left of a plan's price after its cost is yours: 88%,
  86% and 80% before Stripe's fee, the server and the hosted voice's subscription (phase 6 spec §13 has the market
  these prices were set against, §17 the credits).
  In your own studio without accounts, amounts stay in dollars: that is your bill.
- **Two kinds of credit.** A plan's credit is for its month, however the plan is paid: what is left when the
  next month begins expires, and so does what is left when the plan ends. Credit you grant (and a
  top-up's, if you sell any) never expires.
  Plan credit is spent first. The account page shows both, the plan, and every payment with its receipt.
- **Buying.** `/pricing` shows what is on sale (anyone may read it). A button there opens Stripe's own
  checkout page; the studio never sees a card. "Manage subscription" on the account page opens Stripe's portal:
  cancelling ends the plan with the month that was paid for, and a change of plan starts with the next month
  (the account page shows the new plan's name at once; its price and credit begin with the next invoice).
- **Refunds.** A refund or a dispute in Stripe takes back the credit that payment granted, in proportion. If it
  was already spent the balance goes below zero, and nothing paid starts until it is topped up. Refunding a
  past month of a plan takes its share out of what the user has now, whether or not that month's credit was
  used: grant it back (`npm run studio:grant`) if that is not what you meant.

Once:

1. In Stripe (begin in test mode), copy the secret key to `.env` as `STRIPE_SECRET_KEY`. `STUDIO_HOST` must
   be set in `deploy/server.env`: it is where Stripe will send its confirmations.
2. Edit `billing/plans.json` if the defaults are not what you sell.
3. `npm run stripe:setup` shows what it would create in Stripe and asks before doing it: the products and
   prices, the portal's settings, and the webhook endpoint for `https://<STUDIO_HOST>/api/stripe/webhook`,
   whose signing secret it writes to `.env` (with the endpoint's id, `STRIPE_WEBHOOK_ENDPOINT`, so that a
   secret is never taken for another endpoint's). Run it again whenever `plans.json` changes, and after
   switching between a test key and a live one: a changed price is archived and a new one made, and someone
   subscribed at the old price keeps it until they change plan. With any key that is not a test key it insists
   on `-- --live`; without a terminal it needs `-- --yes`.
4. `npm run db:migrate`, then `npm run server:setup`. Both the web app and the worker get the Stripe key; only
   the web app gets the webhook's signing secret.

How it holds: Stripe tells the studio about a payment by calling the webhook. The web app checks Stripe's
signature on that call and passes on nothing but the event's id. The worker asks Stripe itself for that event
and for the payment as it is now, reads what it grants from the price in Stripe, and records the event's id
together with its effect in one database transaction, so an event delivered twice, a forged call, or an id put
straight into the queue grants nothing. The web app cannot grant credit at all. Every hour (and when it
starts) the worker asks Stripe for the last three days' events and fulfils any that no webhook brought.

What to know:

- The Stripe secret key is in the web app as well as the worker, because the web app opens the checkout and
  portal pages. Someone who took over the web app could use it against your Stripe account (read customers,
  refund, change prices). In the studio they still could not add credit directly; they could change what a
  price says it grants, and the worker never grants more than was paid, so the most that buys is credit at
  cost. A restricted key for the web app is not set up by this version.
- Tax is not handled: prices are charged as listed. Turn on Stripe Tax and add what your country requires
  before selling for real.
- Credit follows money the studio can see: a payment that names a charge, in USD, for at least the credit it
  grants. An invoice you mark as paid by hand in Stripe, one paid from a customer's Stripe balance, or a
  checkout made free by a coupon grants nothing; grant that credit yourself (`npm run studio:grant`).
- Only cards and other methods that confirm at once are tested. A payment that confirms days later is
  fulfilled when it does.
- A price created by hand in Stripe's dashboard is not sold by the studio unless its metadata says
  `studio=flowchain`, a `key` and `credit_usd`; a payment for one that lacks them is logged by the worker and
  retried by Stripe until the price is put right.
- Prices are in USD only, and a plan is billed by the month.

## The whole studio on this machine

`npm run studio:local` starts everything with one command: the local database (Docker), a queue, the worker
and the web app with accounts, and Stripe's test mode when `.env` has a test key and the Stripe CLI is
installed and logged in. It opens the studio in the browser; Ctrl+C stops all of it.
`npm run studio:local -- grant <email> 5` gives an account credit in the local database.
`npm run studio:local -- --built` builds the web app first and serves it as a server would: a minute longer to
start, and a change to the code shows only after the next start, but the pages run at their real speed. Without it
they run in development mode, which shows every change at once and makes the browser do several times the work.

It never uses a database other than the local one, a mail server or the real bucket, whatever `.env` says, and
never a live Stripe key. It sends no email: an account works as soon as it is created.
It does use your provider keys: a video generated there is really generated and paid for, up to the amount
approved on its button.

## The landing page

In a studio with accounts, a visitor without a session who opens the bare address sees the landing page; a
signed-in user sees their videos there. The landing page, `/pricing`, `/terms`, `/privacy`, the account forms and
the studio are one site with one look: one layout, one typeface (a file in the repository) and one stylesheet.

- **The videos on it are real runs.** `npm run make:showcase -- <runId> --slug <name>` publishes a finished
  upright run into `web/public/showcase/<name>/`: the media made small, what the player needs, every look a
  visitor can give it (worked out by the same function a free re-render uses), how it was made, and its
  receipt from the run's own ledger. It is free and calls no provider. Then list it in
  `web/lib/site/showcases.ts`; the first one listed is the one a visitor meets. The files are public: the
  export leaves out machine paths and the ids of your GPU endpoints, and a test checks that.
- **Every number on it is computed** — from those receipts, from what Stripe has on sale, and from
  `web/content/comparison.json`, where another company's price carries the address it was read at and the
  date. **An entry older than 90 days is no longer shown**, and when none is left the comparison table and
  the comparing headline go with it (the page then opens with a plain one). Read the prices again and update
  the dates to keep them. The headline compares only while a video on the page was made the way the studio makes
  them now, and the comparison holds for it.
- **A free first draft (optional).** In the database's `settings` row, `welcome_credit_usd` (0 = off; 0.05
  covers a couple of script drafts and no clip) gives each new account that much once its address is
  confirmed, and `welcome_daily_cap_usd` (5) is the most given away in a day to all new accounts together.
  The page says "Make a free draft" only while a new account would really be given enough for one; a
  sentence typed there is in the new-video form after sign-up. Turn it on with
  `npm run studio:welcome -- --usd 0.05` (`--usd 0` turns it off; `--cap 5` sets the day's limit).
- **Before real money:** `/terms` and `/privacy` say that they are not written yet. Replace them.

## Tests

`npm test` runs unit, ffmpeg, Remotion (headless Chrome), fake-provider pipeline and studio server tests offline
(about 2–3 minutes). `npm run typecheck` runs `tsc` for the pipeline and the studio. `npm run test:e2e` builds the
studio and drives it in a browser against fixture runs and a stand-in CLI (run `npx playwright install chromium`
once); it never reaches a provider. `npm run test:queue` runs the queue and worker against a
throwaway Redis (needs `redis-server` on the PATH; these tests are skipped without it). `npm run test:stack` builds
the server's images and drives the whole Compose stack through the proxy's login with the stand-in CLI, and
checks the Compose and proxy files of both kinds of deployment (needs Docker; the first build takes several
minutes). The tests of accounts, credit and storage are part of `npm test`
and are skipped unless the local database is running (`npm run db:start`; storage also needs Docker for
a stand-in bucket). `npm run test:accounts` drives the studio with accounts in a browser: the landing page (the live player, the
calculator, a topic carried through sign-up, welcome credit, how fast it paints on a slowed-down phone),
sign-up, credit, a video, buying a top-up and a plan, and a second user who sees none of it. It turns a
database-wide setting on for a moment, so run it on its own, not beside `npm test`. Payments are tested against a
stand-in Stripe (`web/test/stripe.ts`); no test reaches Stripe or needs its keys. The RunPod worker's Python tests: `npm run setup:worker` once,
then `npm run test:worker`.
