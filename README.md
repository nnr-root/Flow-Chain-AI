# Flow-Chain-AI — CLI

Turns a topic into a captioned short video. Audio drives timing: the voiceover is generated and
silence-trimmed first, then every visual is fitted to it frame-exactly. The final video is rendered with
Remotion (React): word-by-word captions, Ken Burns stills, transitions at cuts and ducked background music.

Design: `docs/superpowers/specs/2026-10-02-phase1-cli-poc-design.md` (pipeline) and
`docs/superpowers/specs/2026-10-03-phase2.1-remotion-render-engine-design.md` (render engine).

## Setup

1. `brew install ffmpeg` (≥ 6 with libx264), Node ≥ 22.12
2. `npm install`
3. `cp .env.example .env` and fill in `GEMINI_API_KEY`, `FAL_KEY`, `ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_ID`
4. `npm run flowchain -- doctor` — every line must show ✓ (the first run downloads Remotion's headless
   Chrome, ≈ 100 MB, once)

## Usage

```bash
npm run flowchain -- run --topic "The last lighthouse keeper" --scenes 4            # all Mode 1 (AI video chain)
npm run flowchain -- run --topic "…" --modes 1,2,1,1 --aspect 16:9 --bgm music.mp3 # hybrid
npm run flowchain -- run --topic "…" --caption-style mrbeast --transition zoom      # another look
npm run flowchain -- status <runId>
npm run flowchain -- resume <runId> [--from clips]
npm run flowchain -- reroll <runId> --scene 2 --stage clips    # later chained clips follow
npm run flowchain -- rerender <runId> --caption-style minimalist --transition dissolve   # free
```

Mode 1 = Kling image-to-video, each continuing clip starting from the last frame viewers see of the
previous (fitted) clip. Continue seams are always hard cuts.
Mode 2 = Flux still animated with a Ken Burns camera move at render time (no video API cost).

Caption styles: `hormozi` (default), `mrbeast`, `minimalist`. Transitions at cuts: `cut`, `fade` (default),
`dissolve`, `blur`, `zoom`, `glitch`. `--bgm-gain` sets the music level outside speech (default 0.35); under
speech it ducks to 18 % of that.

Each run lives in `runs/<runId>/`: `manifest.json` (state, cache keys, cost ledger), `final.mp4`,
`chain.png` (per scene: first frame of the raw clip and last frame of the fitted clip, or the keyframe for
Mode 2 — use it to judge continuity at each seam), plus intermediates.

## Costs

Estimates come from the price table in `src/config.ts` (override with `prices.json`). A run asks for
confirmation when the estimate exceeds `FLOWCHAIN_BUDGET_USD` (default $3); rerolls always ask; `--yes`
skips. A typical 4-scene Mode 1 run is about $1.20. `rerender` never calls a paid API. `npm run smoke` runs
a real 3-scene all-Mode-1 video with `--shots cut,continue,continue`, so two real continuity seams are
always exercised (≈ $0.90–1.65, depending on the 5/10 s clip buckets). `--shots` is a testing override;
without it the LLM decides.

Rendering a 16 s 1080×1920 video takes about 1.5 minutes on Apple Silicon (`--render-concurrency` tunes it).

## Tests

`npm test` runs unit, ffmpeg, Remotion (headless Chrome) and fake-provider pipeline tests offline (about
2–3 minutes). `npm run typecheck` runs `tsc`.
