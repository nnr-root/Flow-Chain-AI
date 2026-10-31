# Phase 15 — LTX-2.5 as the clip engine, and a character who speaks

Date: 2026-10-31. Status: design, approved section by section by the owner in chat (sections 1–5); sections 6–10 written
from the same conversation and the licence reading, to be reviewed with this file. **In this spec a later section wins over
an earlier one.**

## 0. What is decided

- **LTX-2.5 replaces Wan 2.2 as the engine that makes a scene's clip.** The owner's direction (2026-10-31): "if it is valuable
  enough, delete Wan, keeping it as a backup has no point." Wan is therefore removed in this phase's last task, **after** a real
  LTX run has been made, watched and accepted by the owner (§8). Until then Wan stays the only working clip path.
- **A scene may have a character who speaks.** The script says which scenes (§5); that scene's voice and length come from its
  clip, not from the voiceover (a deliberate, narrow exception to "audio drives timing", §4).
- **A clip's own sound is used as the scene's ambient sound** (§6). The Foley worker (phase 14) is **not** deleted by this
  spec: whether it stays is the owner's decision after listening to LTX's ambient sound (§6.3, open).
- **Not in this phase:** LTX audio-to-video (feeding it our own voice), multi-shot clips, the distilled-plus-detailing
  (DFR) path. All three were tried on 2026-10-31 and did not earn their place (§1).

## 1. Evidence (all measured 2026-10-31; a Gemini model was the only judge, see the caveat)

Hardware for every LTX number: one RunPod A40 (48 GB), `--quantization fp8-cast`, USD 0.59/h; the cost of a clip is its
seconds times that rate, model loading included. Wan numbers are from the studio's own Wan endpoint, 720p.

| Measurement | Result |
|---|---|
| Distilled, image to video, 512×896, 121 frames (5 s) at 24 fps | 91–98 s per scene, USD ≈ 0.015–0.016 |
| Distilled, text to video, 640×1152, 121–145 frames | 144–167 s, USD ≈ 0.024–0.027 |
| Distilled, 12 s (289 frames, windows of 97 with 25 carried) | 281–296 s |
| Distilled, 15 s at 512×896 | 273 s |
| DFR (detailing pass), 576×1024 | 109–126 s; barely better than distilled |
| DFR, 1088×1920, 5 s | 279 s |
| Wan 2.2 on the studio's endpoint, 720p, 81 frames (5 s) | USD 0.0655–0.084 per clip (four clips, total 0.2842) |
| Wan 2.2 limit | 81 frames at 16 fps: about 5 s; 480p or 720p |

A Gemini model watched Wan and LTX clips that began from the same frame (four scenes). Scores are visual / motion / prompt
fit / consistency, out of 10: speaking woman 6/5/6/6 (Wan) against 7/7/6/7 (LTX); speaking man 7/6/7/7 against 6/6/7/7;
runner 6/5/5/6 against 5/5/6/5; espresso 6/4/4/4 against 7/5/5/6. **The two engines are level on picture and motion; LTX is
about half to a third the cost per clip and makes sound and speech.** The judge is one model on a few clips and cannot hear
recording quality (it scored the same voice samples alike before and after a mastering step the owner could tell apart): the
owner's own viewing is the decision (§8).

LTX found, in order of use to us:

1. **It speaks.** Given a sentence in the prompt, it made the face, the mouth movement and the voice in one pass. The
   transcript a Gemini model heard equalled the given English and the given Turkish sentence word for word. Lip sync scored
   7 (English) and 6 (Turkish). No other part of the studio can do this.
2. **15 s in one clip, up to 1088×1920**, against Wan's 5 s and 720p.
3. **A cheaper clip** (above).

LTX failed at, and §0 leaves out: audio-to-video with our own ElevenLabs voice (lip sync 3–4: the mouth stays still while the
sound plays); a multi-shot clip in a vertical frame (the model draws a widescreen picture inside the vertical frame, black
bands above and below, with or without a prompt that forbids them); and ambient sound that the prompt asks for in a speaking
clip (the judge heard none). The runner clip did not do the jump it was asked to; neither did Wan's.

## 2. The worker (`worker-ltx/`)

- A sibling of `worker-foley/`: Python, its own image built by the workflow (`flowchain-ltx`), weights inside the image
  (the same two-layer byte-range split for any file over the registry's 10 GB layer limit, joined at cold start), the official
  `ltx-pipelines` package pinned by commit, torch pinned, build-time checks that the model loads offline and that its CLI
  takes the flags the worker passes. Refuses a CPU.
- One pipeline: **`DistilledPipeline`** (8 steps, then a 2× spatial pass) with long-clip windows. Weights it needs: the
  distilled transformer, the Gemma 4 text encoder, both VAEs and the spatial upscaler (about 60 GiB in total). DFR, A2Vid,
  the full model and the detailing LoRA are **not** put in the image.
- Input (the contract, tested like the Foley one): `task` `clip`; the start frame (base64 PNG); `prompt`; `frames`
  (8k+1); `fps` 24; `width`, `height` (each divisible by 64); `seed`. Output: an mp4 with video and audio, uploaded to R2 like
  every other worker's. A request with a field it does not know is refused.
- Cards: A100 80 GB, L40S, RTX 6000 Ada, A40, "anywhere", in the deploy planner's list, the first one that is in stock
  taking the job. **A100 80 GB is the fastest but the one that is often out of stock** (it is why FLUX 3's endpoint waited
  more than 600 s repeatedly); no code may depend on it. `containerDiskInGb` is sized for the 60 GiB of weights plus room.
- Clip length: 49 to 361 frames (2 s to 15 s) at 24 fps. A scene whose clip would be longer is chained exactly as now: the
  seam frame of one clip starts the next.
- Size: portrait 640×1152 for the standard quality; the only other size offered is 1088×1920, **replacing** the Full HD
  restorer for LTX runs only if the owner's viewing says its picture is better than SeedVR2 on a 640×1152 clip (open, §11).

## 3. Model id, the manifest, and the old runs

- The video model of a new run is `runpod:<endpoint>/clip-ltx25@1` (`src/providers/model-id.ts` gets the workflow; the id
  is frozen in `models.video`, so a run keeps its engine through `resume`, `reroll` and `rerender`).
- Old runs carry `clip-wan22-480p@1` / `-720p@1`. After Wan is removed (§8) those ids parse to the existing `retired` shape:
  the run re-renders for free; a clip that would have to be bought again says why it cannot. `test/unit/compat.test.ts` is not
  edited.
- New manifest fields, all optional: on a scene, `videoPrompt` (the long prompt, §4) and `speech` (§5); on a clip, `fps` and
  `hasAudio`; on the request, `speech` (frozen: whether talking scenes may be written, §5). The clip's `fps` is read, never
  the constant `WAN_FPS`; the one place that said 16 (`clipFrames`) becomes engine-specific.
- A run's request freezes `request.clipEngine` implicitly through `models.video` and nothing else; no second switch.

## 4. Stages, timing and the prompt

- **The prompt is written for LTX, not for Wan.** The Wan motion prompt is a short sentence; LTX is given one flowing
  paragraph in the present tense: what is seen, who does what in what order, the camera, the light, and a sentence that begins
  "Audio:" for what is heard. The script step writes it (`videoPrompt`, ≤ 1200 characters; a plain string in the response schema,
  no enum and no `maxItems`: the rule in CLAUDE.md about Gemini's schema applies). It includes the scene's own `soundPrompt`
  words in its "Audio:" sentence. Prompt text changed, so `PROMPT_VERSION` is bumped and the pin updated.
  The rules to write in: never ask for a multi-shot sequence or for hard cuts inside one clip; never ask for a letterbox
  look ("cinematic", "film") in a vertical frame; one action per clip; say what is **not** happening when a person must stay
  still.
- **Timing without a speaking scene is exactly as today:** the voiceover is made and trimmed first, each clip is fitted to its
  scene's seconds (`fit`), nothing about a visual decides a length. `layOutScenes`, `src/duration.ts` and the clip-length rules
  that assume 5 s are re-derived from the engine (15 s at most, 2 s at least); this is a task of its own with a test for every
  length the studio can ask for.
- **A scene with `speech` is the exception, and the only one.** Its clip is made **before** the run's timeline is laid out:
  the clip's sound is measured and **its length is the scene's length** (silence at both ends trimmed by the same code that
  trims voiceover). That scene has no voiceover line and no TTS call; the other scenes' lines are spoken and trimmed as usual,
  and the timeline is the sequence of all of them. A run whose script has no speaking scene never takes this path, and its
  stages run in today's order.
- A speaking clip is **never fitted to a length by cutting its speech**: if the sentence does not fit the scene, the script
  step wrote too many words, and the stage fails with a message that names the scene (no hidden retry; every paid call is
  recorded before it can be lost, as always).

## 5. The speaking character

- The script step writes, for a scene in which a character talks, `speech`: the sentence, in the video's language, and the
  scene's prompt describes the person and the sentence in quotation marks, with the clause "lips moving precisely with every
  word". The form gains one switch, **"Let a character speak"**, off by default; with it off the script step may not write
  `speech` and the schema accepts none. At most **two** speaking scenes per video, and at most one speaker (see below).
- **The sentence is at most about 14 spoken words and 6 s** (what was measured: a 16-word line came out in 5–6 s). Longer
  speech is not tried.
- **Consistency is not promised.** LTX does not hold a voice across clips. The same short description of the person and the
  same seed are written into every speaking scene; the limit is stated in the studio's help text for the switch ("the voice
  can differ between scenes").
- **No real person.** The prompt describes an invented person. A reference photo of a real person is never given; the
  licence forbids impersonation without consent (§9, item 7) and so does this studio. The studio never offers a way to bring a
  face in.
- **Sound policy:** a speaking scene's sound is its clip's sound; the narrator's line for that scene is silent; a run's
  narrator may continue in the scenes around it.
- **Languages:** the speech is written in the video's language. English and Turkish were tried; any other language is
  offered for speech only after a measurement (the list is a constant with its test, like `OWN_VOICE_LANGUAGES`), until then
  the switch is offered for those two.

## 6. Sound and the render

1. **The clip's sound** (its ambient part, in a scene with no speech) is a track like the Foley one: a scene's `sound`
   entry in the render props, ramped to nothing at the last rendered frame, ducked under speech, at the loudness set by
   `LOUDNESS_TARGET_LUFS`. The code of phase 14 that places and mixes a scene's sound is reused as it is; only where the
   file comes from changes.
2. A speaking scene's sound is the dialogue and is put **above** the ambient level and not ducked by the narrator, which
   is silent there.
3. **Foley (open, the owner's decision):** the worker, its image, `RUNPOD_FOLEY_ENDPOINT`, the three `runpodFoley*` prices and
   the `sound` stage remain until the owner has listened to a real LTX run. If LTX's ambient sound is good enough, a later
   task of this phase removes them, as Wan is removed; if it is not, a scene's sound keeps coming from Foley and only
   speaking scenes use the clip's sound. Either way a run made with Foley re-renders (the clip's sound is part of the clip
   file; the Foley track is in the manifest as it is now).
4. **No ambient sound is promised from a speaking clip:** the judge heard none in the English one. The "Audio:" sentence of
   the prompt asks for it and the stage records whether the file has any; nothing in the studio says there will be.

## 7. Prices, credit and the studio

- New prices in `prices.json` and `src/config.ts`, in the shape of the Foley ones: `runpodLtxUsdPerSec` (the rate of the
  card the endpoint is made on; the deploy's list has more than one price, so the endpoint's own measured rate is the one
  kept), `runpodLtxSecPerClipSec` (seconds of GPU per second of clip; measured: about 29 at 640×1152 including a load),
  `runpodLtxColdStartSec`. **Without all three, LTX is not offered and a run that was made with it refuses to resume**
  (same rule as FLUX 3 and Foley); measure on the card the endpoint actually gets before setting them.
- `RUNPOD_LTX_ENDPOINT` plus the three prices make LTX the engine for **new** runs; without them the studio behaves as before
  (modes by environment, nothing else). The web app never reads `prices.json`; the worker tells it (`Health.speech` is true
  only while LTX is on and speech is allowed in the territory, §9).
- A customer is shown credits, never dollars (phase 6 §12): a speaking scene is priced as any clip of its length; there is no
  second price for speech.
- The hidden form rule of phase 14 is followed: when speech is not offered, the form sends `speech: false` and the CLI is
  given nothing to ask for it.

## 8. Retiring Wan, and the way back

- Order of this phase's tasks ends with: (a) a real LTX run, resumed once from disk (no repeated paid call); (b) the owner
  watches and listens and says whether to proceed; (c) only then the removal task: `workers/` (the Wan worker), its
  Dockerfile and image job, `clip-wan22-*` workflows from `RUNPOD_WORKFLOWS`, `WAN_FPS`, the Wan prices, the Wan paragraphs
  of the README and CLAUDE.md, and the deploy planner's Wan endpoint. `retired` takes over the old ids.
- **The way back before (c):** setting `RUNPOD_LTX_ENDPOINT` empty brings Wan back for new runs; nothing else changes.
- **The way back after (c):** the git tag `wan-last` on the commit before the removal, the Wan image tag kept in the
  registry, and a note in the README. This is deliberately **not** a switch: the owner has said a backup has no point, and a
  second engine kept alive costs its tests, its image and its prices forever.
- The restorer worker (`worker-upscale/`, SeedVR2 and RIFE) is **not touched**: it takes a clip of any frame rate. Whether it is
  still needed for Full HD is decided after the owner has seen 1088×1920 clips (§11). 60 fps: RIFE doubles 24 to 48 or
  thins to 60 only if measured; until then `request.fps` 60 is refused for an LTX run, and the control is hidden (the
  rollback order of phase 11 is unchanged).

## 9. Licence (read in full, 2026-10-31)

The LTX-2.x Community License (`Lightricks/LTX-2`, `LICENSE-2_x`) and the LTX-2.5 model page. **This is the section that can
stop the phase.**

1. **Revenue:** free while the entity's yearly revenue is under USD 10,000,000; at or above it a paid Commercial Use
   Agreement is required (licensing@ltx.io). The same kind of limit as FLUX 3's (USD 5M); both are tracked together.
2. **Hosting for others is allowed** (§3: "host for third parties remote access purposes (e.g. SaaS)"), on conditions: the
   Use-based restrictions of Attachment A, the acceptable use policy, **must be included as an enforceable provision in the
   terms users accept**, and users must be told. **Task:** `/terms` gains those restrictions (and §3.1's notice) before any
   LTX-made video is offered; this is a customer-facing legal text, so it goes to the owner for approval, not written alone.
3. **Attachment A, item 20:** the model may not be used "in any product, service, or application that directly competes with
   Licensor's commercial products or services, or is designed to replace or substitute Licensor's offerings in the market,
   without a separate commercial license". Lightricks sells an AI video platform (LTX Studio). **A studio that turns a topic into
   a finished video can be read as competing.** I cannot decide this: it needs the owner's written question to
   licensing@ltx.io, and the answer in writing, **before** a paying customer is served a video made with LTX. The owner's own
   machine and tests are not concerned. Until it is answered, the phase is built, tested and run privately (as the FLUX 3 phase
   waited for its licence email).
4. **Provenance and disclosure:** the licence requires keeping the model's own safety measures, watermarking, "content
   provenance", "latent disclosure" and metadata, never removing or weakening them (§6, item 19), and complying with the EU AI
   Act and the California AI Transparency Act. The worker and the render therefore **keep whatever the file carries**: no
   step strips metadata from an LTX clip (a test names the render step and ffmpeg flags, `-map_metadata` and `-fflags`),
   and the studio says in its terms and on a video's page that it is AI made. A task confirms what the clip file actually
   carries (an `ffprobe` of a real clip), since nothing here has been looked for yet.
5. **Item 5:** machine-made content may not be passed on without clearly saying it is machine made (the same disclosure).
6. **Item 7 (no impersonation without consent), item 3 (no verifiably false content meant to deceive):** the studio's niche
   rules already keep fiction labelled as fiction; speech adds a person who talks, so the niche rule for facts (`FACT_RULES`)
   applies to what a speaker says; a niche that is not about facts may have fiction spoken. The invented-person rule of §5 stays.
7. **Item 18 (commercial use):** the clip files and their sound are never used to train or tune any model, ours or others'.
8. **No territory exclusion was found** in the licence text (the only place the word appears is the sanctions clause). This is
   a reading, not a legal opinion; it is to be confirmed in the same email as item 3. Compare Foley (EU, UK and South Korea are
   excluded) and MiniMax H3 (the EU, the UK, South Korea **and the United States** are excluded, which is why H3 was
   dropped); the Foley territory rule still governs a scene's sound while Foley exists (§6.3).
9. **Updates (§6):** the licensor may "update" the model remotely and asks users to run the latest version; the image pins
   a commit and its weights. A note in the README says an image is rebuilt on purpose, never silently.

## 10. Tests

- **Worker (Python, `worker-ltx/tests`):** the contract (every field, every refusal), frame arithmetic (8k+1; sizes divisible by
  64), the weights assembly, the handler with the model replaced, a refusal on CPU, the output having an audio stream.
- **Pipeline (vitest):** `clipFrames` for LTX (every length from 2 s to 15 s, both rounding directions); the provider's input and
  output shapes; the model-id workflow and the `retired` ids; the speaking-scene timeline (a scene with speech takes its
  length from the clip; a script with none takes today's path, **pinned by a test that compares the stage order**); a clip
  that is longer than its scene; the `fps` and `hasAudio` fields on old manifests (optional; `compat.test.ts` untouched);
  the script schema (no enum with `maxItems`; the `videoPrompt` and `speech` fields), the prompt pin.
- **Real calls (the owner's click, each):** one `run --draft` after any schema change (about half a cent, as always); one
  four-scene run, one with a speaking scene; both measured for the three prices.
- **Studio:** `Health.speech`, the form's switch, the hidden-form rule, the price file; the existing names test keeps "LTX"
  out of every customer-facing surface (add it to `INTERNAL_NAMES`), and a **grep test** confirms the licence-required
  notice is in `/terms` only as the owner words it.

## 11. Parked and open

1. **The owner's viewing and listening** of a real run (§8b), including the ambient sound (§6.3) and 1088×1920 against Full
   HD (§2).
2. **The licence email (§9.3, §9.8)**, the paid-licence question at USD 10M, and the terms text (§9.2). The owner sends it.
3. **Voice across speaking scenes** (§5): a way to keep one speaker's voice (a reference voice, if the model gains one) is
   not available; a limit, not a task.
4. **Other languages for speech** (§5): after a measurement each.
5. **Prices on the card the endpoint gets** (§7), including the A100's.
6. **60 fps from a 24 fps clip** (§8): measure RIFE 24 to 48 and a thinning to 60, or LTX's own temporal upscaler.
7. **Multi-shot, audio-to-video, DFR, a bigger model:** tried and left (§1); each is a spike of its own if asked for again.
8. **A scene's speech longer than 6 s:** chained clips would break the voice; not attempted.

## 12. Owner steps (money or a real account: each one the owner's click)

1. Write to licensing@ltx.io (§9.3, §9.8); keep the answer in the repository's docs.
2. Approve the `/terms` text (§9.2).
3. `npm run runpod:deploy` with the new image and the card list; `npm run server:setup` for the worker's settings.
4. The first real run and the first one with a speaking scene (§10).
5. Decide Foley (§6.3) and Wan (§8) after watching.
6. Revoke the Hugging Face token pasted into the chat on 2026-10-29 **and** the one used on 2026-10-31, and make one new
   token that is only passed through the shell (§2 needs it only for `fetch-models`/the image build).

## 13. Found while writing the plan (this section wins over every earlier one)

1. **Captions of a speaking scene need word times, and nothing in §5 made them.** The voiceover's words come from the voice
   worker (own voice: Whisper on what was heard) or from ElevenLabs' alignment; a clip's speech has neither. **`worker-ltx`
   runs Whisper over the clip's audio itself** (faster-whisper, `large-v3-turbo`, on the card, about 1.6 GB more in the image)
   when the request carries `speech_language`, and returns `words` (`text`, `start`, `end`, in seconds) with the mp4. The studio
   needs no voice endpoint for a speaking scene. The contract and its tests gain `speech_language` and `words`.
2. **A speaking scene is made to look like a spoken one.** For a scene with `speech`, the stages `tts` and `silence` do not apply
   (`appliesTo`); the `clips` stage, after the picture is made, extracts the clip's sound to the scene's audio file, trims its
   silence with the code `silence` uses, and writes `scenes[i].audio` (path, trimmed duration) and `scenes[i].words`.
   Every stage after `clips` (`fit`, `captions`, `render`) then reads an audio and words as it always does and **needs no change**.
3. **Dependencies change in one place.** Where a stage depends on the duration of an earlier scene `k` (the seam frame, the
   scene frame counts, the auto modes) it names `{stage:"silence",scene:k}` today; it must name `{stage:"clips",scene:k}` when
   scene `k` speaks. One function (`durationDep(m, k)` in `src/stages/visual.ts`) is the only place that says it. A speaking
   scene is **always Mode 1** (it needs a clip); the `modes` stage may not decide otherwise for it.
4. **The place of a new engine is `VIDEO_PROFILES`** (`src/video-profiles.ts`), not the provider: "a provider billed per second
   adds a profile here; nothing else changes". LTX is the profile `ltx25@1` (24 fps, `8k+1` frames, 49 to 361, 640×1152);
   `wan22-*` and `wanFrames` are removed with Wan (§8) and their ids stay in the `VideoProfileId` enum as retired so old runs
   load (as the two Kling ids do).
5. **A clip is no longer 16 fps.** `fit`, `planFit`, `extractSeamFrame` and the interpolate stage read the clip's own `fps`
   (recorded on the clip, §3); a test with a 24 fps clip and a 16 fps clip covers each.
6. **A speaking scene's sound is kept whole; only its tail is cut (found while building Task 9).** §13.2's "trims its silence
   with the code `silence` uses" is replaced: the `clips` stage keeps the clip's sound whole and cuts only its end, at the
   last word's end plus 0.4 s (`SPEECH_TAIL_SEC`, a short fade into the cut), and the words are the worker's at the times it
   heard them. The silence code removes leading silence and every pause of 0.2 s or more, but the picture is not trimmed with
   the sound: it plays from its first frame, so lips and voice would drift apart. The fit cuts the clip's picture at the
   scene's length (its normal trim), so both end together. The 6.5 s limit (`MAX_SPOKEN_SEC`) applies to that cut length.
   A speaking clip is asked for at 169 frames (7.04 s at 24 fps), the shortest LTX length that leaves room for a sentence
   of up to 6.5 s; a real run must check that LTX does not stretch the sentence to fill the clip. The `modes` stage leaves
   speaking scenes out of its dependencies, because it runs before `clips` and does not read their length (§13.3's
   `durationDep` is used everywhere else).
