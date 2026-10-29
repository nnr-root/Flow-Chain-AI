# Phase 12 — scene sound effects: the script names the sounds a scene would have, from a closed library

Date: 2026-10-29. Status: built; the owner's steps (§6) are not done.

## 0. Where this sits

Item 3 of the owner's five-item list, first half. Item 3 was "lip sync + auto SFX"; in the design conversation it was split into
three pieces, each with its own spec → plan → build loop:

- **A. Scene sound effects (this spec).** Free at run time, low risk.
- **B. Lip-sync trial (a spike, no kept code).** The same scene made two ways (a mouth painted over the Wan clip, and a
  sound-to-video model), cost and look compared. Paid on RunPod, so each spend needs the owner's click. It decides C.
- **C. Lip-sync production (designed after B).** Narrator's sentence in the character's mouth first; separate dialogue lines
  (other voices, captions, manifest) in a later phase. The owner chose "both, the first one first".

Today the studio has three fixed sounds (`impact` on the hook, `pop` and `whoosh` on cuts; `src/media/sfx.ts`, synthesized by
`scripts/make-sfx.ts`). They follow the edit, not the story: a door slams in the script and the video plays a pop.

Decisions of the owner for A: sounds come **by scene** (the script says what a scene would sound like); the library is
**synthesized with ffmpeg**, as the three are now (no licences, byte-identical rebuilds).

## 1. The library and its vocabulary

- `scripts/make-sfx.ts` grows from 3 recipes to 17 (14 new; `aevalsrc` + filters, fixed pseudo-random sequences, 44.1 kHz stereo
  MP3 in `assets/sfx/`, committed; renders never synthesize). First list, to be tuned by ear: `footstep`, `door`, `knock`, `rain`,
  `wind`, `thunder`, `crowd`, `engine`, `beep`, `glass`, `splash`, `fire`, `heartbeat`, `clock`, plus the existing `impact`,
  `whoosh`, `pop`. Names are fixed once published (they live in manifests).
- `SfxName` stays a closed union, now built from one table: `{ file, baseGain, leadFrames, kind: "hit" | "bed", about }`.
  `about` is a short English description handed to the script prompt; it is the only place a sound is described.
- **hit**: one short event (`door`, `footstep`, `knock`, `glass`). **bed**: a loop-able texture (`rain`, `wind`, `crowd`,
  `engine`, `fire`) that plays under the whole scene at a low level and fades in and out at the scene's seams.
- The set the script may choose from is `SCENE_SOUNDS`, the table minus the three edit sounds (`impact`, `whoosh`, `pop`), which
  stay driven by the edit and the hook only.

## 2. The script and the timing

- Each scene gains optional `soundCues: Array<{ sound: SceneSound; at: "start" | "middle" | "end" }>` (zod enum over
  `SCENE_SOUNDS`; at most 2 per scene; a bed cue ignores `at`). A name outside the vocabulary fails the schema, so the script
  step's existing validation and repair path handles it like any other bad field.
- The prompt gains the vocabulary (name + `about`) and one rule: name a sound only when the picture clearly has a source for it;
  when unsure, leave the list empty. Silence is the default. `PROMPT_VERSION` is bumped (`prompt-pin.test.ts` fails without it),
  and the niche/type/edit texts are untouched.
- Field is **optional in the manifest** (old runs load; `test/unit/compat.test.ts` is not edited). A scene's cues are part of the
  script, so they ride the script's input hash and are frozen with it.
- `at` becomes a frame in the pure function `sceneSfxCues(scenes, boundaries, opts)` beside `sfxCues`: `start` = the scene's
  first frame (plus the transition's half window when a transition leads in), `middle` = the scene's midpoint, `end` = its last
  second. Frames use `framesAt` so 60 fps shifts nothing audibly and 30 fps output is unchanged.
- **Conflicts**: a hit that would land within 6 frames (at 30 fps; scaled) of a hook impact or a cut sound is dropped, so the edit's
  sounds win. Two hits of one name in one scene collapse to one. Beds never overlap another bed in the same scene (first wins).
- `buildRenderProps` publishes the cues next to the existing list (`audio.sfx`), with `kind` and, for a bed, its duration;
  `src/media/remotion/` plays a bed with a gain envelope. `render.sfx = false` (`--no-sfx`) silences all of it; `sfxGain` scales
  all of it. Beds sit lower than hits by their `baseGain` so the narration stays first; the music ducking rule is unchanged
  (sound effects neither duck the music nor are ducked, phase 2.3 §5.3).

## 3. Cost, studio, names

- No paid call is added. The script grows by the vocabulary (a few hundred tokens), counted by the ordinary script price.
- The studio keeps its one "sound effects" switch; the form does not list sounds. No customer surface names a model or provider
  (nothing here does). The vocabulary's English `about` strings are prompt text, not shown.
- `restyle.test.ts` still holds: the landing page restyles through the same `previewProps`, so cues are computed there too.

## 4. Tests

- The vocabulary is closed: an unknown sound fails the scene schema; the prompt carries every `SCENE_SOUNDS` entry (a test builds
  the prompt and checks).
- `sceneSfxCues`: each `at`, the 6-frame conflict rule, hit de-duplication, bed envelope, `sfx: false` empty, an old scene
  without the field, 30 and 60 fps frame positions (30 fps identical to what a scene would give by `framesAt(x, 30)`).
- `make:sfx` run twice writes identical bytes for every recipe; every recipe's file exists and is non-empty and within its
  declared duration.
- Compat: a manifest with no `soundCues` loads and renders as before.
- A test must fail without the fix it guards (project convention).

## 5. Out of scope (parked on purpose)

- Sounds outside the vocabulary (a text-to-audio model on RunPod) and sounds taken from the finished clip (video-to-audio).
  Either would be a new paid worker; ask again after B/C.
- The user's own sound effects, and a list of sounds in the studio.
- Lip sync (B, C above).

## 6. The owner's steps after the build (none spends money)

1. Listen to the new library once (`npm run make:sfx` then play `assets/sfx/`), and say which sounds sound wrong; recipes are
   cheap to retune.
2. Make one video at the next paid run and judge whether the sounds fit; a script that names too many sounds is fixed in the
   prompt rule (silence by default), not in code.

## 7. What was found and changed

Rulings of the plan (they win over §1–§2 where they differ):

- **Library size:** 17 sounds, not about 24: the 3 edit sounds, 9 hits (`footstep`, `door`, `knock`, `glass`, `beep`, `clock`,
  `heartbeat`, `splash`, `thunder`) and 5 beds (`rain`, `wind`, `crowd`, `engine`, `fire`). `src/sounds.ts` holds the vocabulary
  (`EDIT_SOUNDS`, `SCENE_SOUNDS`, `SCENE_SOUND_ABOUT`) and imports nothing, because the browser reads it through the schema.
- **A hit is at most 1.9 s long.** A longer sound is a bed.
- **`at` is ignored for a bed:** it runs under the whole scene, fading at the seams.
- **A clash is judged against the edit's sounds only** (the hook's impact and the cut sounds); the edit's sounds win. Two scenes'
  own sounds are not compared with each other.

What the tasks found:

- The recipes in `scripts/make-sfx.ts` are first formulas and have **never been auditioned by ear**. ffmpeg accepted all of them
  and a test holds each to be non-silent, of its length and byte-identical on a second build; whether they sound right is the
  owner's step 1.
- **Hashes.** The script stage's input hash covers request fields only, never scene fields, and `PROMPT_VERSION` is in no input
  hash. Scene cues therefore ride the frozen script, and an old run does not buy its script again. The render stage hashes the
  whole props object, so cues (which flow into `audio.sfx`) are already covered; a test asserts that props differ when the cue
  list differs.
- `PROMPT_VERSION` is now `2026-10-29.16`. Its date prefix differs from the earlier entries, so
  `test/unit/prompt-changelog.test.ts` was changed: changelog versions may span dates, the counters run 1..n, and the last entry
  equals `PROMPT_VERSION`. It still fails on a missing or duplicate line.
- The schema converter needed no change: the optional enum array comes out of `z.toJSONSchema` as it is.

Parked or minor:

- **Gemini's live acceptance of the nested array, enum and `maxItems: 2` inside a scene is untested** (built against fakes).
  Confirm it on the first real script.
- **A `start` hit in scene 0 is always dropped while the hook is shown:** both land on frame 0 and the edit's impact wins. The
  script's `middle` or `end` is the way to have a sound in scene 0.
- The 60 fps test checks that the same second is hit within 0.05 s, not an exact frame times two (`sceneFrames` at 60 fps does
  not simply double the fitted frames of the fixture).
- One prompt assertion (`/empty/i`, that the list is left empty when unsure) is weak: it would pass on other uses of the word.
