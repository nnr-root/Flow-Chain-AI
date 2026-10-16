# Phase 8: the layers of a video, its languages, and its audience

Date: 2026-10-15. Status: §1–§5 built; §6 tried (upscaling measured and built as §8; speaking characters parked,
§6.2); §8 built, not yet deployed.

The owner asked for seven things on 2026-10-15. Two were fixes and are recorded in the phase 7 spec: the silence
trim that cut the last word (§22) and the hands of a shadow figure (§23). This spec covers the other five:

1. visual-style master prompts beyond Style that can be combined with the other prompts;
2. video-type master prompts (documentary, education, motivation and so on) that can be combined as well;
3. a quality path with Wan 2.2, lip sync where someone speaks, and upscaling;
4. one video in several languages: the same pictures, with a voice and captions for each language;
5. a video in one language made for that language's culture, carefully, and never for a video made in several.

The owner's answers to the design questions (2026-10-15):

- Four layers, chosen apart (§1).
- Versions in other languages share the pictures (§4).
- Cultural adaptation applies within the limits written in §5.
- The quality path starts with a small paid trial (§6).

## 1. Four layers

A video is built from four choices. Each decides a different thing, so any combination of them works:

| Layer | Decides | Where it lives |
|---|---|---|
| **Niche** (phase 7 §19) | what a channel is about; its rules of truth and harm | `src/niches.ts` |
| **Video type** (§2) | how it is told: the hook, the shape, the delivery | `src/formats.ts`, `--format` |
| **Style** (phase 2.2) | how a picture is drawn: medium, line, light, colour | `src/presets.ts`, `--style` |
| **Edit** (§3) | how it moves and is cut: camera, cuts, a finish over the frame | `src/edits.ts`, `--edit` |

When two layers speak, these rules decide:

- **The niche's rules always hold.** A type or an edit never loosens them.
- **The type decides the hook, the shape and the delivery** when there is one. The niche's own hook and shape are
  then left out of the prompt, not just outranked: two openings given to one model produce a mixture of both.
- **The style owns the medium and the colour.** An edit's words never name either (§3).

The script's prompt gives each layer its own block (`layerRules` in `src/providers/gemini.ts`):

| Block | Whole script | Long video's outline | Long video's parts |
|---|---|---|---|
| Niche | yes | yes | yes (its hook and shape only where it opens) |
| Type | yes | yes | yes (its hook and shape only where it opens) |
| Edit | yes | no (an outline frames no scene) | yes |
| Audience (§5) | yes | yes | yes |

A test builds a prompt for every niche × every type it may go with × every edit.

Every new field is optional and is part of the script's key only when a run has it, so every earlier run keeps its
key (`format`, `edit`, `localize` in `RunRequest`).

## 2. Video types

There are eight types:

| Type | `goesWith` |
|---|---|
| Documentary | fact |
| Explainer | fact |
| Story | any |
| Top list | any |
| Motivational | any |
| Myth vs fact | fact |
| Versus | any |
| You are there (second-person POV) | any |

Each has an opening line (hook), a shape from the first line to the last (arc), a delivery, and rules.

**Types that tell what is so.** Documentary, explainer and myth-busting carry the fact rules every true video keeps
(`FACT_RULES`). They cannot be used for a niche of made-up stories (`formatClash`):

- A made-up story told as a documentary, or a myth "busted" that nobody believed, is a lie told well.
- The CLI refuses the combination, and so do the studio's draft and series routes.
- The form greys the option out and clears it when such a niche is chosen.

**Types that suit any niche.** For each of these, the line that matters in a niche of what is so is written into its
rules:

- a story is a real one, and no one's thoughts are invented;
- a list's items are real;
- a versus never mocks a real person.

**2.1 Where the types come from.** They are the shapes the most watched faceless shorts take, the same survey as the
niches (phase 7 §19.1).

- The order of a list (counting down to number one, saying the number aloud) is the most kept-to convention in
  "top N" shorts.
- "You are there" is the second-person, present-tense POV form of history and disaster channels.
- No figure about retention is written into any rule: none was measured here.

## 3. Edits

An edit says how the camera moves, how one scene gives way to the next, and what lies over the frame. There are six:

| Edit | Feel |
|---|---|
| Cinematic | slow and deliberate, deep shadows, grain |
| Fast and punchy | quick moves, hard cuts and zooms |
| Calm | still or drifting, fades |
| Archive film | slow pans, sepia, heavy grain and vignette |
| Retro tape | glitch cuts, scan lines |
| Dreamy | floating camera, blurs between scenes |

An edit reaches a video in four places:

1. **The script** is told how to frame, move and cut (`Edit.script`): the shots, the transitions to suggest, and how
   much moves.
2. **Every picture and clip** is asked for with its words (`Edit.picture`, `Edit.motion`). The words come after the
   scene's own words, so the subject still leads, and before the style's suffix, which finishes the look.
3. **The cuts** the script suggests are turned into the edit's own (`Edit.transitions`). A run that chose one
   transition for every cut keeps it.
4. **The render** grades the picture and lays a finish over it: a CSS filter, a vignette, moving grain, a tape's
   scan lines (`FinishLayer`). Stills move at the edit's pace (`stillMotion`, which scales the Ken Burns travel and
   never uncovers the frame). This part is free, and only the picture gets it: the captions and the title sit above
   it.

**Why an edit never names a medium or a colour.** An edit is chosen apart from the style, so it must suit every
style:

- an edit that said "pastel" would colour a black-and-white film;
- one that named a lens type would fight a drawn look.

So `picture` and `motion` speak only of light, distance, angle and movement. A test holds them to a list of style
words. The grades are gentle: contrast within ±15% and saturation between 0.6 and 1.3. A browser render test
checks:

- the grade is there (sepia warms grey);
- the vignette darkens the corners;
- the scan lines make rows differ;
- the grain moves from frame to frame;
- a run without an edit renders exactly as before.

**Not built: motion graphics proper.** Animated arrows, maps, counters and kinetic titles over the picture would be
a new kind of layer: something the script asks for at a moment, drawn by the renderer. That needs its own design:

- what the script may ask for;
- how it is timed to the words;
- how the picture model is kept from drawing the same thing.

Parked until the owner asks for it. The "motion" the owner can choose now is the camera, the cuts and the finish.

## 4. A video in several languages

A **version** is a new run made from a finished one. It keeps every picture and clip, and gets its own narration,
voice, captions, hashtags and render in another language.

```
npm run flowchain -- translate <runId> --language ja [--voice <id>] [--budget <usd>] [--yes]
```

**What a version buys.** A version buys the translation (one script answer) and the voice. The pictures and clips
were paid for by the run it comes from, and nothing of them is bought again:

- The version's copies of the `modes`, `reference`, `keyframes` and `clips` records are **inherited**. Their key is
  the source run and the file itself, not the inputs that bought them.
- Its scenes are longer or shorter than the source's, and the stages' usual inputs depend on that length, so with
  their usual key every clip would be bought again.
- If an inherited stage ever had to run (a file was deleted, `--from keyframes`), the run stops and says so instead
  of buying.

**How the translation is asked for.** The translation is written to each scene's own length:

- the source's spoken seconds for that scene;
- at the new language's and voice's words a second;
- within a scene's limit.

That keeps every clip within the speed change the fit already allows (×1.25, then a held frame). Each answer is
checked like a script, scene by scene, and sent back once with what was wrong.

**The rest of the version.**

- The picture and clip prompts are copied, not translated: those models read English.
- The hook and the hashtags are written again in the new language, as its speakers would write them, not
  translated tag by tag.
- The fit, captions and render are the usual free stages.

**A seam in a version is a short dissolve.** A continuing clip was generated from the frame its scene's previous clip
showed last in the source. In a version that previous scene has another length, so it ends on another frame, and a
hard cut there would jump. A five-frame dissolve hides that. Turning a seam into a dissolve is the only change to how a
version is cut.

**Which runs can have versions.** A run that was made for its language's audience (`localize: true`, §5) has none:

- its pictures belong to one culture, and the owner's rule is that a video in several languages is never adapted
  to one;
- such a run is refused, with the reason;
- the new-video form says to turn adaptation off for a video that will be made in other languages.

**How a version is recorded.** A version names its source (`request.versionOf`). A version of a version is refused:
it is made from the source instead.

**Planning.** An inherited stage follows nothing of the version's own: a new narration does not plan a clip again.
It is planned, at no cost, only when its file is gone, and then the run stops (`execute` refuses it). A test makes a
source run and a version with stand-ins and checks:

- not one picture or clip is bought again;
- the version's ledger holds only the script and the voice;
- the source's ledger is untouched;
- a resume finds nothing to do;
- a deleted clip stops the run instead of buying it.

### 4.1 In the studio (built 2026-10-16)

A finished run's page has an "Other languages" panel. It appears only when the run is done, is not a version, and
was not made for one audience. The panel has a language (any the studio offers, other than the run's own), a voice
of that language (the run's own where the language has it), the price, and one button. Behind it:

- **Price.** `plan <run> --json --translate <l> --voice <v>` is the CLI's own planner, run against the source's
  files with the version's manifest in memory. Nothing is written. It answers what the version would cost and what
  it holds (`versionCapUsd`):
  - the translation twice, since an answer is paid for whether or not it is sent back;
  - the voice and a half, for a language that takes more letters to say the same;
  - what is not spent comes back when the job is settled.
- **Job.** `POST /api/runs/<id>/versions` checks the price again against what the user was shown (a higher figure
  is `estimate_changed` and starts nothing). It then makes a new run of the user's (`newTenantRun`) and starts a
  paid `generate` job on it:
  `translate <source> --language <l> --voice <v> --run-id <new> --budget <cap> --cap <cap>`.
  `refusal()` holds the job to exactly that shape:
  - both ids are run ids, so they are never paths, and they differ;
  - the job is the new run's;
  - no `--yes`.
- **Worker.** Before such a job, the worker brings the source from the bucket under the job's user's own key. A
  source of someone else's is not there to bring, so the job fails before anything is bought.
- **The version's page** says it was made from the original and links to it. It offers no new picture, clip or
  portrait (only a new voice for a line), and no versions of its own.

Tests:

- the route test prices, refuses a lower approval, and starts the exact command;
- the queue test runs it with accounts and a bucket: another user gets 404, the new run is the owner's, and exactly
  what was spent is charged;
- the browser test goes from the panel to the new video's page.

## 5. Made for its language's viewers

A video in one language other than English is made for the people who speak it. Where the topic leaves open who is
in it and where it happens, the people, their names, homes, streets, food and money are theirs. A Japanese video about
a nurse's night shift shows a Japanese nurse. The audience for each language is in `src/culture.ts`. The script is
told:

- to write it into `styleBible.characters` and `styleBible.setting`;
- to change nothing the topic decides: a real event, a real person, a period in history, a named place;
- that people look and dress as people there really do in the video's time: no national costume, flags, landmarks
  or stereotypes unless the subject is about them ("the audience should recognise their own life, not a postcard of
  it").

**Frozen per run, on by default.**

- `localize` is frozen when the run is made: true for a video in a language that has an audience, unless
  `--no-localize` or the form's box says otherwise.
- English is never adapted: it is spoken across the world and names no one audience.
- An earlier run has no `localize` and was not adapted, and its key is unchanged.
- **Why on by default:** the owner asked for it for every single-language video.
- **Why it can be turned off:** a video that will also be made in other languages must not be adapted (§4).

## 6. The quality path: Wan 2.2, lip sync, upscaling (a trial, not built)

The goal is clips closer to the newest closed models' quality, and lip sync only where someone speaks on screen.
What exists in the open as of 2026-10:

- **Upscaling:** a one-step video restorer (SeedVR2-class) can take the 480p or 720p clip to 1080p, sharpen it and
  remove some of the clip model's mush.
  - It costs GPU seconds per clip.
  - It belongs between `clips` and `fit`, as a paid per-scene stage with its own price row.
- **Lip sync:** Wan 2.2's speech-to-video model (S2V) animates a face to an audio track.
  - Today no scene has someone speaking on screen. The narrator is never seen, and the scene rules forbid speaking
    to the camera (phase 5 §9.12).
  - So lip sync needs a new kind of scene first: a character who says a line on screen, with that line's audio as
    the scene's own.
  - That is a script change and a voice change, not only a model change.

**The trial (owner's click, a few dollars).**

1. Upscale three existing clips from the last two runs on a temporary endpoint.
2. Make one speaking shot from a run's portrait and a line of its audio.
3. Measure the seconds and cost of each, and look at the pictures side by side.

**What the results decide.**

- Whether upscaling is offered (likely as the HD choice, in place of 720p generation).
- Whether speaking characters are worth the new scene kind.

Nothing of this is built until the trial has been looked at.

### 6.1 The trial, run 2026-10-16 (owner's click)

**Setup.** One temporary pod (A100 80GB PCIe, $1.79/h, `runpod/pytorch:1.4.0-cu1281-torch280-ubuntu2204`):

- Inputs went in by presigned links and results came back the same way.
- The pod removed itself at the end (a trap, and a 95-minute watchdog). The local script removed it again and
  found it gone.
- It ran for 36 minutes, about $1.08, plus $0.015 for the portrait.
- The scripts are kept out of the repository (`.superpowers/trial/`). They were a one-off.

**Upscaling (SeedVR2, the command-line `inference_cli.py`, batch 33, temporal overlap 4).** Three clips from the
2026-10-15 runs (480×832, 4.4–5.4 s, 105–129 frames) became 1080×1872:

| | 3B (fp16) | 7B (fp16) |
|---|---|---|
| seconds per clip, warm | 174–209 | 196–238 |
| first clip, with the model's download | 314 | 391 |
| A100 cost per clip, warm | ≈ $0.09–0.10 | ≈ $0.10–0.12 |

What the pictures show:

- The gain is plain at full size: chain links, bark, cloth and faces come out sharp where the 480p clip is soft.
- 7B is a little more natural than 3B, which over-sharpens slightly.
- **The cost is the catch.** One upscale costs about three times what the clip it upscales cost to make. It is a
  premium choice ("HD") rather than every video's.

**Speech to video (Wan 2.2 S2V-14B, official `generate.py`).**

- It downloaded in 203 s, loaded, and failed on its first step with an assertion inside its attention.
- The S2V model calls flash-attention directly, with no fallback, and the trial left flash-attn out to save its
  hour-long build.
- **Next try:** install a prebuilt flash-attn wheel for torch 2.8 / CUDA 12.8 / Python 3.11 (about $1 more).
- Two things stand regardless of the outcome:
  - its audio encoder is English wav2vec2, so lip sync in other languages is to be seen, not assumed;
  - a speaking scene is still a new kind of scene (§6).

### 6.2 Speech to video, second try (owner's click, 2026-10-16): no result

**What was run.** The same pod and method, with a prebuilt flash-attn for torch 2.8 / CUDA 12.8 added, and only the
speaking portrait.

**What came back.** Nothing: no video, no timings and no log. The local script removed the pod at its 65-minute
limit (HTTP 204), after 69 minutes on the A100 ($2.06). Speech to video has cost $3.14 in all and produced nothing
to look at.

**Why the pod did not remove itself.**

- Its 60-minute watchdog sent the script a TERM signal.
- Bash defers a trap until the program running in the foreground ends, and that program was the model.
- So the trap that uploads the log and removes the pod never ran.
- The local backstop is what held the cost. It worked as it was meant to: no pod is left.
- **What a next trial must do differently:**
  - upload its log every few minutes, not only at the end;
  - have its watchdog stop the whole process group.

**What can be said.** At 704×1024 with its default steps, S2V did not finish a 4-second line within about 50
minutes of an A100 after its download. Either it is that slow on one card, or it stalled; the missing log cannot
tell which.

**Ruling: speaking characters are parked.** Several reasons together:

- the unknown time and cost;
- its English audio encoder;
- it needs a new kind of scene first (§6).

A third try is not worth it until one of those changes: a faster distilled S2V, or the owner asking for on-screen
speakers.

## 7. What the first real video showed (2026-10-16)

The owner approved a real test, made with the real script model, voice and pictures:

- **The video:** "Tarihin en kısa beş savaşı" in Turkish, history × Top list × Cinematic, 30 seconds, not made for
  one audience. Run `20261016-074446-67058f`: $0.14, 25.6 s.
- **Its English version:** run `20261016-075113-4f5eff`: $0.14, 28.9 s.

**What worked.**

- **The type.** The script counted down as the type asks: "Beş… Dört… Üç… İki… Ve bir numara", the number said at the
  start of each item, number one last.
- **The facts.** Indo-Pakistani War 13 days, Petrich 10 days, Six-Day War 132 hours, Football War 100 hours,
  Anglo-Zanzibar 38 minutes: all right.
- **The edit.** The cuts are dissolves, and the vignette and grade are on the picture.
- **The version.** It bought one translation and seven lines of voice, and no picture. Its lines kept each scene's
  ideas in that scene, and its hook and hashtags were written in English, not translated.

**What was wrong, and is fixed.** Every scene was the same vaulted archive room. The setting rule asked for "the one
time and place the whole video is set in". A list of five wars from five places and decades has none, so the model
chose a room none of them happened in. Now:

- A video that moves between times or places begins its setting with "Several times and places:" and names them.
- Each of its imagePrompts names its own year and place first.
- The Top list type says so for items from different times.
- The anachronism check holds each scene of such a video to the year its own picture names
  (`isMoving` in `src/anachronism.ts`).

**Noted, not changed.**

- **The video ran short.** It was 25.6 s against 30. The script chose "low" action for every scene, so all seven are
  stills: a list told over still pictures has nothing in it that runs long.
- **The English version ran longer.** The English lines came out up to 1.6 s longer than the Turkish scene they
  replace. Numbers said in full ("one hundred thirty-two hours") are long in English. A still takes any length.
  A clip slows a quarter and then holds its last frame (§4).

## 8. Full HD: upscaled clips as a paid choice (built 2026-10-16, not yet deployed)

The owner chose, after §6.1, to offer upscaling as a paid HD choice. The choice is called **Full HD (1080p)** and
sits beside Standard and HD (720p) in the new-video form. Each moving clip is made at 480p, as a standard one is,
then upscaled to 1080p before it is fitted. Stills are not upscaled: a still is moved over a picture that is sharp
already.

**The pipeline.**

- `--upscale` freezes `request.upscale: true` and `models.upscale` (the endpoint).
- A paid per-scene stage `upscale` runs between `clips` and `fit` (`src/stages/upscale.ts`):
  - it applies only to a Mode 1 scene of such a run;
  - it is keyed on the clip file itself, so a clip made again is upscaled again, and nothing else is;
  - the fit then plays `clips/clip_NN.hd.mp4` and is keyed on that file;
  - a run without it keeps every key it had.
- A version (§4) inherits the upscaled clips like the rest.
- **Price.** It is the GPU seconds the trial measured for each second of clip (40, A100, warm), at the endpoint's
  rate, plus one worker start for the run's first. The table's defaults are replaced once the endpoint is measured
  on its own card.
  - **Why it lives in the stage file:** `src/cost.ts` is imported by the browser, through `duration.ts`, and must
    not reach the config.

**The worker** (`worker-upscale/`).

- It runs SeedVR2 3B (fp16) through the program's own `inference_cli.py`, pinned to v2.5.24, which is what the
  trial ran. Settings: batch 33, overlap 4, full HD decoded in tiles.
- **Why 3B:** it fits the 24 GB cards the endpoints use, and in the trial it was close to 7B.
- **Its weights are in its image**, downloaded at a pinned revision and checked by SHA-256 at build:
  - the network volume holds the clip and picture models, and has no room left;
  - a worker reads the weights at every start, which its own disk does fastest.
- Its endpoint reads no volume, so it may run in any data centre with a 24 GB card.
- **Contract:** `{task: "upscale", workflow: "upscale-seedvr2@1", video: <base64 mp4 ≤ 9 MB>, short: 720|1080}`.
- The image is built by the `upscale` job of `worker-image.yml`. `npm run runpod:deploy` makes its template and
  endpoint and writes `RUNPOD_UPSCALE_ENDPOINT`; `-- --no-upscale` leaves them out.

**The studio.**

- The health answer says `fullHd: true` once that setting is there, without saying what it is. The form offers the
  choice only then.
- A draft asking for it in a studio without it is refused before anything is held.
- The command line it sends is `--clips 480p --upscale`.

**Not yet true.**

- The worker has not run on RunPod. Building its image (on the next push) and the deploy are both owner's clicks,
  and so is a first full HD video to measure its real seconds and cost on a 24 GB card.
- Until then the choice does not appear: without the endpoint, `fullHd` is false.
