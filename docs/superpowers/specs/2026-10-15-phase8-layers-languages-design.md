# Phase 8: the layers of a video, its languages, and its audience

Date: 2026-10-15. Status: §1–§3 and §5 built; §4 built in the commit after them; §6 is a trial still to run (it
spends, so it waits for the owner's click).

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
