# Flow-Chain-AI — Phase 1 CLI

Turns a topic into a captioned short video. Audio drives timing: the voiceover is generated and
silence-trimmed first, then every visual is fitted to it frame-exactly.

Design: `docs/superpowers/specs/2026-10-02-phase1-cli-poc-design.md`

## Setup

1. `brew install ffmpeg` (≥ 6 with libass and libx264), Node ≥ 22.12
2. `npm install`
3. `cp .env.example .env` and fill in `GEMINI_API_KEY`, `FAL_KEY`, `ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_ID`
4. `npm run flowchain -- doctor` — every line must show ✓

## Usage

```bash
npm run flowchain -- run --topic "The last lighthouse keeper" --scenes 4            # all Mode 1 (AI video chain)
npm run flowchain -- run --topic "…" --modes 1,2,1,1 --aspect 16:9 --bgm music.mp3 # hybrid
npm run flowchain -- status <runId>
npm run flowchain -- resume <runId> [--from clips]
npm run flowchain -- reroll <runId> --scene 2 --stage clips    # later chained clips follow
```

Mode 1 = Kling image-to-video, each continuing clip starting from the last frame viewers see of the
previous (fitted) clip.
Mode 2 = Flux still + Ken Burns camera move (no video API cost).

Each run lives in `runs/<runId>/`: `manifest.json` (state, cache keys, cost ledger), `final.mp4`,
`chain.png` (per scene: first frame of the raw clip and last frame of the fitted clip — use it to judge
continuity drift at each seam), plus intermediates.

## Costs

Estimates come from the price table in `src/config.ts` (override with `prices.json`). A run asks for
confirmation when the estimate exceeds `FLOWCHAIN_BUDGET_USD` (default $3); rerolls always ask; `--yes`
skips. A typical 4-scene Mode 1 run is about $1.20. `npm run smoke` runs a real 3-scene hybrid video.

## Tests

`npm test` runs unit, ffmpeg and fake-provider pipeline tests offline. `npm run typecheck` runs `tsc`.
