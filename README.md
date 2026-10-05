# Flow-Chain-AI — CLI

Turns a topic into a captioned short video. Audio drives timing: the voiceover is generated and
silence-trimmed first, then every visual is fitted to it frame-exactly. The final video is rendered with
Remotion (React): word-by-word captions, Ken Burns stills, transitions at cuts and ducked background music.

Design: `docs/superpowers/specs/2026-10-02-phase1-cli-poc-design.md` (pipeline),
`docs/superpowers/specs/2026-10-03-phase2.1-remotion-render-engine-design.md` (render engine),
`docs/superpowers/specs/2026-10-04-phase2.2-content-intelligence-design.md` (modes, transitions, style presets) and
`docs/superpowers/specs/2026-10-05-phase2.3-retention-brand-design.md` (hook, sound effects, brand kit, clip lengths).

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

## Tests

`npm test` runs unit, ffmpeg, Remotion (headless Chrome) and fake-provider pipeline tests offline (about
2–3 minutes). `npm run typecheck` runs `tsc`.
