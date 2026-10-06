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
3. `cp .env.example .env` and fill in `GEMINI_API_KEY`, `FAL_KEY`, `ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_ID`
4. `npm run flowchain -- doctor` — every line must show ✓ (the first run downloads Remotion's headless
   Chrome, ≈ 100 MB, once)

## Usage

```bash
npm run flowchain -- run --topic "The last lighthouse keeper" --scenes 4            # auto modes, Gemini picks the style
npm run flowchain -- run --topic "…" --style cyberpunk --budget 2                   # a fixed style preset and budget
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

Mode 1 = Kling image-to-video, each continuing clip starting from the last frame viewers see of the
previous (fitted) clip. Continue seams are always hard cuts.
Mode 2 = Flux still animated with a Ken Burns camera move at render time (no video API cost).

`--mode auto` (the default) lets Gemini rate each scene's action level: high → Mode 1, low → Mode 2, medium →
Mode 1 while the run fits the budget (`--budget`, frozen with the run), otherwise Mode 2, largest saving first.
`--mode 1|2` or `--modes` fix the modes by hand. `status` shows each scene's mode and why.

Style presets (`--style`, default: Gemini picks one for the topic): `cinematic_history`, `anime`, `cyberpunk`,
`dark_fantasy`, `photorealistic_8k`, `3d_render`. A preset wraps every image and motion prompt and brings its own
caption look.

Caption styles: `preset` (default: the style preset's look), `hormozi`, `mrbeast`, `minimalist`. Transitions at
cuts: `auto` (default: the one Gemini suggests for each cut), `cut`, `fade`, `dissolve`, `blur`, `zoom`, `glitch`.
`--bgm-gain` sets the music level outside speech (default 0.35); under speech it ducks to 40 % of that.

The first 3 s open with a hook: a snap zoom, a big title Gemini writes (or `--hook "…"`) and an impact sound
(`--no-hook` turns it off, and `rerender --hook-on` brings a removed hook back). Cuts get sound effects: a
whoosh into `zoom` and `blur`, a pop on `glitch` and hard cuts, nothing on `fade` and `dissolve` (`--no-sfx`,
`--sfx-gain`; `rerender --sfx` turns them back on). The sounds are bundled in `assets/sfx` (`npm run make:sfx`
regenerates them).

A brand kit is a folder with `brand.json` (see `assets/brand/example`): a logo watermarked at a corner, and an
optional font, text and accent colours and character bible. `--brand <dir>` copies it into the run;
`--characters "…"` sets the character bible directly. Every keyframe of a run shares one Flux seed (`--seed`).

Each run lives in `runs/<runId>/`: `manifest.json` (state, cache keys, cost ledger), `final.mp4`,
`chain.png` (per scene: first frame of the raw clip and last frame of the fitted clip, or the keyframe for
Mode 2 — use it to judge continuity at each seam), plus intermediates.

## Costs

Estimates come from the price table in `src/config.ts` (override with `prices.json`). A run asks for
confirmation when the estimate exceeds `FLOWCHAIN_BUDGET_USD` (default $3); rerolls always ask; `--yes` skips.
For `--mode auto` runs, `--budget` (or `FLOWCHAIN_BUDGET_USD`) and the price table are frozen with the run for
the mode rules; a later `--budget` only changes when to ask. `resume --from <stage>` re-runs, and re-buys,
that stage and every later one (so `--from modes` re-buys every keyframe and clip). On runs with a seed,
`resume --from keyframes` (or an earlier stage) reproduces the same keyframes because the seed is fixed;
`reroll --scene N --stage keyframes` gets new ones. Narration is capped at 16 words per scene, and a 5 s clip
is bought whenever a scene's narration lasts at most 6 s (the fit step stretches it), so a typical 4-scene
Mode 1 run is about $1.35. `rerender` never calls a paid API. `npm run smoke` runs a real 3-scene all-Mode-1
video with `--shots cut,continue,continue`, so two real continuity seams are always exercised (≈ $0.90–1.65,
depending on the 5/10 s clip lengths). `--shots` is a testing override; without it the LLM decides. `npm run
smoke:auto` runs a real 4-scene `--mode auto --style cyberpunk` video with the example music bed, and `npm run
smoke:brand` a 4-scene `--style anime` video with the example brand kit.

Rendering a 16 s 1080×1920 video takes about 1.5 minutes on Apple Silicon (`--render-concurrency` tunes it).

## RunPod (self-hosted keyframes and clips)

Keyframes (SDXL with IP-Adapter character references) and clips (Wan 2.2 image-to-video) can run on your own
RunPod Serverless endpoints instead of fal: roughly $0.20–0.35 per 4-scene video instead of ≈ $1.35. Each run
keeps the provider it was created with, so older fal runs are never affected.

One-time setup (accounts and keys only):

1. RunPod: create an API key → `RUNPOD_API_KEY` in `.env`.
2. Cloudflare R2: create a bucket and an S3 API token with read/write on it → `R2_ACCOUNT_ID`, `R2_BUCKET`,
   `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` in `.env`.
3. Push this repo to GitHub: the `worker-image` Action builds `ghcr.io/<owner>/flowchain-worker`. Make that
   package public (GitHub → Packages → flowchain-worker → Package settings → Change visibility).
4. `npm run runpod:deploy` creates the network volume, template and two endpoints, downloads the model weights
   onto the volume and writes `RUNPOD_KEYFRAME_ENDPOINT` / `RUNPOD_CLIP_ENDPOINT` into `.env`. It shows what it
   will create, the monthly volume cost (≈ $5.60 for 80 GB) and the one-time model download it runs on the
   endpoints' GPUs (≈ $1–2), and asks first; re-running it updates in place. It uses the image tag built from the
   current `workers/` folder and stops if that image is not public on GHCR. `RUNPOD_WORKER_IMAGE` deploys another
   image instead, `RUNPOD_DATACENTER` picks another data centre (default `EU-RO-1`), and `--yes` skips the question.

Then `npm run flowchain -- run --provider runpod …` (or `PROVIDER_MODE=runpod` in `.env`) and
`PROVIDER_MODE=runpod npm run flowchain -- doctor`. `npm run smoke:runpod` makes a real 4-scene video on RunPod
and is a paid run.

Runs with characters get one generated reference portrait (or a brand kit's `reference` image) that every keyframe
is conditioned on; `reroll <runId> --stage reference --scene 1` generates a new portrait (keyframes are then
redone from it). Clips are 480p (upscaled to the output size) with frame interpolation to 32 fps. GPU time is
charged per job from RunPod's measured execution time; cold starts and idle time are not attributed per job.

The model stack is licensed for commercial use (SDXL / RealVisXL / Animagine under CreativeML Open RAIL++-M,
IP-Adapter Apache 2.0, Wan 2.2 Apache 2.0). Open RAIL++-M requires its use restrictions to be passed on in your
customer terms.

## Studio (web app)

`npm run web` starts the studio at <http://127.0.0.1:3131>: a local, single-user front end to the same runs the
CLI makes (everything in `runs/` shows up, and anything made in the studio can be resumed from the terminal).

1. **New video** buys only the script (about $0.006) and opens a **draft**: the real Remotion composition in the
   browser with placeholder pictures, estimated timing and no voice, but the real captions, hook, transitions,
   brand, music and sound effects.
2. On the draft, set each scene to **Auto, Clip or Still**; the price updates. **Generate video** shows the
   estimate on the button and passes it to the pipeline as a cap: if the plan ever exceeds it, the run stops and
   asks again instead of spending more.
3. A finished run plays with its real media. Caption style, transitions, hook, sound effects, music level and
   brand preview live as you change them; **Apply and re-render** is free. Each scene can get a new voice take,
   picture or clip, priced before you confirm.
4. **Brand kits** creates kits by upload (logo, optional font, colours, characters, portrait) into `brand-kits/`;
   music can be uploaded in the new-video form (`uploads/music/`). Both folders are git-ignored.

The studio has no login. It listens on `127.0.0.1` only and refuses any write that does not come from its own
pages. API keys stay in `.env`, which only the CLI reads; the browser never sees them. Jobs are the CLI itself,
started detached, so a job keeps running if the web server restarts; at most two run at once
(`STUDIO_MAX_JOBS`). The preview is not frame-exact (the rendered MP4 is), and draft timings are estimates.
Remotion is free for individuals and companies of up to three people; larger companies need its company licence.

The studio uses these CLI commands, which also work on their own:

| Command | Does |
|---|---|
| `run --draft` | buys only the script and stops; `resume` continues |
| `run --pin-modes auto,1,2` | pins scenes of an auto run to clip (1) or still (2) |
| `draft-modes <runId> --modes auto,1,2` | changes the pins while only the script is bought |
| `plan <runId> [--reroll 2:clips] [--modes …] [--json]` | what continuing would do and cost, without doing it |
| `look <runId> …` | stores a new look without rendering (takes `rerender`'s options; works on a draft) |
| `status <runId> --json` | the status as JSON |
| `reroll … --budget <usd>` | a reroll capped at an amount instead of asking |

## Tests

`npm test` runs unit, ffmpeg, Remotion (headless Chrome), fake-provider pipeline and studio server tests offline
(about 2–3 minutes). `npm run typecheck` runs `tsc` for the pipeline and the studio. `npm run test:e2e` builds the
studio and drives it in a browser against fixture runs and a stand-in CLI (run `npx playwright install chromium`
once); it never reaches a provider. The RunPod worker's Python tests: `npm run setup:worker` once,
then `npm run test:worker`.
