# Phase 9 — the prompts Gemini is given: audit, versions, and a way to measure them

Date: 2026-10-18. Status: design approved section by section; not built.

## 0. Where this sits

The owner asked for five improvements at once. They are independent, so each gets its own spec, plan and build,
in this order (cheap and certain first, paid GPU experiments after):

| # | Item | Spec |
|---|---|---|
| 5 | The prompts given to Gemini: audit, versions, eval harness | **this one** |
| 1 | Clips that read as one clip (chaining) | later spec |
| 2 | Past 720p with tiled upscaling, and 60 fps by interpolation (extra credit if costly) | later spec |
| 3 | Lip sync and automatic sound effects | later spec |
| 4 | Trend discovery, paid in credit | later spec |

This spec is only item 5. Prompts for items 1 to 4 are designed in their own specs (ruling: they depend on
what those features turn out to need).

## 1. What is in scope

Every piece of text that steers a model:

- `src/providers/gemini.ts`: the whole-script, outline, part and translate prompts, and the inspect prompt.
- The content files that feed them: `src/niches.ts`, `src/formats.ts`, `src/edits.ts`, `src/culture.ts`, `src/presets.ts`.
- How `src/stages/visual.ts` wraps Gemini's text (`imagePrompt()`, `motionPrompt()`) for the picture and clip models.
- Every example written inside a prompt (a "for example …", a sample setting, a sample creature). An example pulls
  outputs towards its own content, so each is checked for that and kept, shortened or removed.

Each piece is checked for: contradictions between layers, a rule said twice, a rule the validator never enforces,
and a rule the model cannot follow.

## 2. Findings so far (from `gemini.ts`)

The content files are audited in task 1 (§8) and their findings are added to this section as §2.1, which wins over
anything above it.

1. **One temperature for every call.** All script calls use 0.9. A translation must keep facts, names and numbers,
   and a part must follow its outline, so both want less. Target: script 0.9, outline 0.9, part 0.7, translate 0.3,
   inspect 0 (as it is). The table is part of the prompt version (§4).
2. **`continue` scenes are written without being told to carry on.** The whole script is one answer, so Gemini sees the
   previous scene, but no rule says a `continue` scene's `motionPrompt` carries on the previous scene's camera move
   and direction. Each clip then starts at rest. This is the writing-stage half of item 1 (chaining); the other half
   (what the clip worker is given) is that item's own spec. In a part-written script the first scene of a part sees
   the previous part's last lines only, so the rule there is limited to what is known.
3. **The topic is not fenced.** `req.topic` is put in quotes as it comes; the user's niche text is fenced and called
   "not an instruction". The topic gets the same fence.
4. **The inspect prompt is narrow.** It looks for body faults only. It does not look for a main subject that is missing
   or replaced, and, for the three frames of a clip, a change of identity or style between them (item 1 needs this).
5. **Most rules are already enforced in code, so the cost is in the retries.** `validateScript`, `validateOutline`,
   `validatePart` and `validateTranslation` (`src/stages/script.ts`) already check scene and word counts (CJK in
   characters), the hook cap, anachronisms and moving hands, and `answer()` sends a rejected answer back once with
   the reasons. **Every answer is paid for, accepted or not, and a second rejection fails the run.** So a prompt that
   makes the model break these rules costs money twice over. What the prompt still holds alone: generic hashtags
   (put right in code, never a rejection), a text or logo asked for in an `imagePrompt`, and continuity between
   `continue` scenes. (An earlier draft of this finding said the hand and anachronism rules were prompt-only; they
   are not.)

### 2.1 Findings from the content files and inline examples

Read in full: `src/niches.ts`, `src/formats.ts`, `src/edits.ts`, `src/culture.ts`, `src/presets.ts`, `src/stages/visual.ts`,
and the layer code in `src/providers/gemini.ts` that quotes them. Line numbers are as of `7d43c32`, before tasks 2 and 3
move them. A `fix`, `shorten` or `remove` row has its own task in the plan (Task 3.1 onward, in this order).

| # | Where | Finding | Verdict | Why |
|---|---|---|---|---|
| 6 | `src/providers/gemini.ts:90` (`bibleRules`, the setting) | Every script and outline prompt carries a full period setting as its example: `(for example "Constantinople, spring 1453: Ottoman soldiers in kaftans and turbans and Byzantine defenders in mail; wooden galleys, torches and oil lamps, parchment and quills")`. It is also the eval's `period-constantinople` case, word for word. | shorten (to the form only: `<place>, <season> <year>: …`) | A list of real objects of one siege is what gets copied into other periods ("parchment and quills" in a pharaoh's court); and an eval case whose answer is in the prompt measures copying, not the prompt. The rule's own words already say what a setting holds; the form keeps their order. |
| 7 | `src/providers/gemini.ts:91` (`bibleRules`, the moving setting) | `(for example "Several times and places: Zanzibar 1896, Honduras 1969, the Sinai 1967")` is the answer of the real test video "Tarihin en kısa beş savaşı" (phase 8 spec §7) that this rule was written after; the history niche's first example is the same war ("The war that lasted 38 minutes", `src/niches.ts:95`) and so is its hook (`:98`), and the eval case `eras-wars` asks for it. | remove (the names; keep the form with placeholders) | Three wars said in every prompt pull a list video toward wars and hand the "shortest wars" topic its answer; the eval would score that as a success of the prompt. |
| 8 | `src/providers/gemini.ts:105` (a figure that is not a person) | `(for example "a featureless silhouette of pure black smoke, with no skin, face or fingers")` and `("the black smoke silhouette drifts closer")`. | keep | Copied, it is the safe outcome: a figure with no hands, which is what the rule is for (phase 7 spec, the hand fix). A sameness of ghosts is a taste cost the eval's judge can show; not worth losing the technique. |
| 9 | `src/providers/gemini.ts:110` (motionPrompt) | `(for example a slow push-in, a pan left, an orbit, a tilt up, or a static camera)`. | keep | Generic camera words; nothing in them can become a subject. The `continue` rule (finding 2) handles "static" after a moving scene. |
| 10 | `src/providers/gemini.ts:167` and `:193` (`nicheRules`, `formatRules`), quoting `Niche.hook` / `VideoFormat.hook` | A niche's or a type's opening is given as `- Hook: …`, the same word as the answer's `hook` field, which `HOOK_RULE` (`:68`) defines as "2-6 punchy words shown as a big title". The scary-stories hook says `in one plain sentence ("I still don't know who was knocking."). No title, no greeting.` (`src/niches.ts:65`): read as the `hook` field, it asks for a sentence and for no title. `hookProblems` (`src/stages/script.ts:25`) rejects a hook over six words, so that misreading is a paid retry. | fix (label it `- First line (scene 1's narration, not the hook title):`) | Two rules under one name contradict each other; a different label removes the contradiction without touching the content files. |
| 11 | `src/providers/gemini.ts:196` (the tie-break) with `Niche.voice` | The tie-break says the type decides "the hook, the shape and the delivery", but the niche's `- Voice:` line stays in the prompt and names a person and a tense: scary-stories `"Quiet, intimate, first person, past tense"` (`src/niches.ts:67`) with "You are there" `"Second person, present tense"` (`src/formats.ts:122`); motivation `"second person"` (`src/niches.ts:178`) with documentary `"third person"` (`src/formats.ts:45`). Both pairs are allowed (`formatClash` blocks neither). | fix (the tie-break names the person and tense) | The model is given two persons and two tenses and no rule says which wins; the type is the one that must, since its shape is built on it. |
| 12 | `src/providers/gemini.ts:205` (`editRules`) quoting `Edit.about` | The script model is told `Edit: ${e.label} (${e.about.toLowerCase()})`. `about` is the form's description of the render's finish: retro `"A video tape: glitch cuts, scan lines, bright colour"` (`src/edits.ts:117`), archive `"faded tones, heavy grain"` (`:103`), cinematic `"film grain"` (`:60`). | fix (drop the `about` from the line) | Phase 8 §3: an edit's words never name a medium or a colour. Grain, scan lines and the grade are the renderer's; Gemini cannot make them and, told them, writes "bright neon colours" or "a VHS still" into imagePrompts, which fights the style. |
| 13 | `src/providers/gemini.ts:245`, `:307` and `FLOW_RULE` (`:226`) | "All narrations together read as one continuous script…" and "It is one spoken piece…" say the same thing twice. | keep | Short, and they agree; one also carries the hook in scene 1. Not worth a version. |
| 14 | `src/niches.ts`, ten niches' `hook` | The hook's example sentence restates one of the niche's own `examples`: true-crime `:76`/`:79` (fingerprint), history `:95`/`:98` (38 minutes), mythology `:109`/`:112` (Medusa), space-science `:141`/`:144` (Moon), psychology `:155`/`:158`, motivation `:173`/`:176`, tech `:208`/`:211`, mysteries `:225`/`:228` (Voynich), places `:271`/`:274`, life-stories `:285`/`:288`. | keep | Only a user who picks the form's own example topic gets that sentence handed to them, and it is a correct opening for it. The history case is made worse by finding 7, which is fixed. |
| 15 | `src/niches.ts:257` (`what-if.examples`) | `"What if you didn't sleep for a week"`: a health topic, in a file whose head says (`:14`) "Left out on purpose: health and medicine". `nicheRules` quotes it to the model, and the form offers it as a topic. | fix (replace with `"What if Earth had rings like Saturn"`) | An example is a topic the studio invites; this one invites what the niches were built to leave out. |
| 16 | `src/niches.ts:285` (`life-stories.examples`) | `"The two wolves inside you"` is widely told as a Cherokee legend, and no Cherokee source for it is documented. The niche is fiction, so it carries `FICTION_RULES`, not `FACT_RULES`; its own rule invites `("an old story says")` (`:293`), and nothing stops "a Cherokee elder told his grandson". | fix (replace with `"The potter who kept the cracked bowl"`) | A video would state as a people's tradition what is not known to be one; the mythology niche's rule ("true to how the culture tells it") exists for exactly that. |
| 17 | `src/niches.ts:181` with `src/formats.ts:91` | motivation's `"No promises of wealth or success"` and motivational's `"Promise no money, health or success"` both reach a motivation × motivational prompt (`formatRules` drops only identical strings). | keep | They agree; merging them changes two layers for no measured gain. |
| 18 | `src/formats.ts:75` (`countdown.delivery`) against `FLOW_RULE` (`src/providers/gemini.ts:226`) | `"Brisk; each item a fresh beat; nothing between the items."` against "It is one spoken piece, not a list of facts read out: each line follows from the one before it and leads to the next". | fix (`"Brisk; each item a fresh beat, its lines told as one piece; one short line carries the viewer from each item to the next number."`) | A direct contradiction in every countdown prompt. The type is a list, but FLOW_RULE was written after a list of facts read out sounded wrong (phase 8 §9); the new delivery keeps the beat and lets the lines follow on. |
| 19 | `src/formats.ts:73`, `:110`, `:120` (type hooks) | `("Five animals that should not exist.")`, `("A crocodile against a shark: who wins?")`, `("You are a sailor on the Titanic, and it is 11:39 at night.")`. | keep | Each shows a shape (a number, a matchup, "you" and a time) and the topic is always given. "Five" may anchor the count over "about one for every two or three scenes"; the eval's countdown cases will show it. |
| 20 | `src/edits.ts:105` and `:108` (`archive.script`, `archive.picture`) | `"Soft, faded contrast, as in an old photograph"` is added to every picture of an archive run, and the script is told `"frames that feel like photographs of the moment"`. A photograph is a medium. `test/unit/layers.test.ts:86` (`STYLE_WORDS`) misses it: its list has `photo-?real`, not `photograph`, and checks `picture` and `motion` only, not `script`. | fix (picture `"Soft, faded contrast and gentle, even light, a still and composed frame"`; script `"Camera: slow pans and push-ins across still, composed frames, as if each moment were held."`) | Phase 8 §3, the edit's own file (`src/edits.ts:6-8`): a medium in an edit turns a watercolour or a cartoon toward a photograph. Changes the picture cache key of archive runs (row 26). |
| 21 | `src/edits.ts`, the other five edits | — | none | `picture`, `motion` and `script` of cinematic, energetic, calm, retro and dreamy name no medium and no colour (checked with the test's word list plus `photograph`). |
| 22 | `src/culture.ts:57` with `FACT_RULES` (`src/niches.ts:46`) | The audience rule gives the people "their names" of the audience; `FACT_RULES` says "Do not invent … names". In a true niche with `localize`, both are in the prompt. | keep | `FACT_RULES` is about names presented as fact; the audience rule applies only where the topic leaves the people open, which in a true niche is rare. The `lang-tr` eval case will show a problem if there is one. No culture rule tells the model to write in English; they are about who is in the video, as they should be. |
| 23 | `src/presets.ts`, `motionKeywords` | Several name a camera move that is added after the scene's own move and the edit's: pixel_art `"slow sideways camera pan"` (`:200`), comic_book `"quick camera push"` (`:169`), photorealistic_8k `"smooth handheld camera"` (`:139`). A clip can then be told three moves. | keep | What the clip model is given beyond Gemini's words is item 1's (§9), and every change here changes every clip's cache key (row 26). Passed to item 1's spec. |
| 24 | `src/presets.ts`, `description` and the picture words | — | none | The descriptions name topics, not things to draw; the image words name the medium and finish, never a thing in the frame (their own rule, `:14-24`). photorealistic_8k's description says "health" (`:135`): a look, not a niche, so it invites nothing. |
| 25 | `src/stages/visual.ts:36` and `:53` | The setting is added to every picture and clip: `Setting: ${b.setting}.` For a video that moves between times and places the setting is a list of all of them, so a picture of one era is told every other era too. `bibleRules` says (`gemini.ts:90`) "It is added to every picture, so it must be true of every scene", which a list of eras is not; each scene already names its own year and place first (`:91`). | fix (leave a moving setting, `isMoving`, out of the picture and clip prompts) | A picture model given "1896, 1969, 1967" mixes their things; the anachronism check (`src/anachronism.ts`) holds each scene to its own year only in words. Changes the picture and clip cache keys of moving runs only (row 26). |
| 26 | `src/stages/keyframes.ts:42`, `src/stages/clips.ts:57` | The picture and clip stages hash the wrapped prompt (`imagePrompt(…)`, `motionPrompt(…)`), so a change to an edit's `picture`/`motion`, a preset's words or the text `visual.ts` adds changes the cache key of every old run that uses it: `resume` or `reroll` would buy its pictures or clips again. §3's ruling ("changing a prompt never re-buys") is true of the script only. | keep (as a ruling: see §3) | Nothing is deployed and the owner's own runs are the only old runs; `rerender` is free and asks for nothing. Rows 20 and 25 accept it; row 23 is not changed partly for it. |

## 3. Rulings

- **Changing a prompt never re-buys an old run's script.** The script stage's input hash covers the request's fields
  (model, language, voice, rate, …), not the prompt text. This is why no version needs to enter a hash, and why
  `test/unit/compat.test.ts` is not edited.
- **The words wrapped around a picture or a clip are in those stages' cache keys** (§2.1, row 26): a change to an
  edit's `picture`/`motion`, a preset's words or what `visual.ts` adds makes an old run that is resumed or rerolled buy
  those pictures or clips again. Accepted while nothing is deployed; once there are customers' runs, such a change
  needs its own ruling.
- **A long script resumed after a prompt change** writes its remaining parts under the new prompt. The saved outline
  keeps the story whole. Keeping old prompt texts per version costs more than it protects.
- **Same-model judging is biased.** Judge scores mean something only against the baseline, never as grades.

## 4. Prompt versions

- `PROMPT_VERSION`: a dated constant exported from `src/providers/prompt-version.ts` (`src/providers/gemini.ts` imports it and exposes it as `promptVersion` on `GeminiLlm`), for example `"2026-10-18.1"`. It is
  bumped by hand whenever any prompt text changes **or any imported content file changes** (`niches.ts`,
  `formats.ts`, `edits.ts`, `culture.ts`, `presets.ts`, and the text `visual.ts` adds), or the temperature table
  changes. Each bump has a one-line entry in the changelog at the end of this spec.
- The manifest gains an **optional** field `scriptPromptVersion`, written when a script is written. It is **not** in any
  input hash. Its uses: knowing which prompt wrote a script, and the eval's comparison.
- A **pin test** snapshots the rendered prompts for a fixed set of requests **together with `PROMPT_VERSION`**, so a
  prompt edit without a bump fails the test and a bump without an edit shows in the diff.

## 5. Changes to the prompts

Made in task 3 (§8) from the findings in §2 and §2.1, and each measured by the eval:

- the temperature table (finding 1);
- the continuity rule for `continue` scenes (finding 2);
- the fence around the topic (finding 3);
- the wider inspect prompt (finding 4), with a frame-to-frame check that applies to clips only;
- any example found to bias outputs, and any contradiction found in the content files.

## 6. The eval harness

Pure and free, in `src/eval/`, unit-tested, following the repo's split of what decides from what acts:

- **Cases** (`test/eval/cases`): about two dozen fixed requests over the niches, types and edits; several languages
  including Chinese or Japanese and Arabic; short and multi-part lengths. Hard ones on purpose: an animal topic, a
  period setting, a video across several eras, and a topic that contains an instruction.
- **The main measure: first-try acceptance.** Each answer is run through the pipeline's own validators
  (`validateScript`, `validateOutline`, `validatePart`, `validateTranslation`), not copies of them, and counted as
  accepted or rejected with its reasons. A rejection is paid money (see §2, finding 5), so the rate of first-try
  acceptance is the number a prompt change is judged by first. The validators already count through
  `src/voice/words.ts`, so Chinese and Japanese are counted in characters; the case set holds one of each to prove
  it reaches the harness.
- **Extra checks the validators lack:** no text, logo or watermark asked for in an `imagePrompt`; no generic hashtag
  in the raw answer (before `normalizeHashtags` puts it right); a `continue` scene's `motionPrompt` does not start
  from rest (a cheap lexical check, backed by the judge); the raw hashtag count is 5.
- **A check must be able to fail:** each extra check is tested against a hand-written good and a hand-written bad
  script; the validators already have their own tests.

Acting, in `scripts/eval-prompts.ts` as `npm run eval:prompts`:

- It spends money, so it is on the owner's-click list in `CLAUDE.md` and is never run by an agent. It prints an
  estimate from the price table and requires an explicit `--cap`, like the pipeline.
- Each case runs **3 or more times** by default (temperature 0.9 is not deterministic); results are pass rates.
- A **judge** call (temperature 0, a fixed rubric, scores 1 to 5) rates: how paintable each `imagePrompt` is, how
  plausible each `motionPrompt` is, the continuity between `continue` scenes, how the narration flows, and the fit to
  niche and type. The judge prompt is in this audit's scope. The judge's model id is recorded.
- Full outputs go to `eval-out/<PROMPT_VERSION>/` (git-ignored). A committed `test/eval/baseline.json` keeps scores
  only: each score's **mean and spread**. A regression is reported only when a drop is larger than the baseline's own
  spread, so natural variation is not flagged.
- It reads the Gemini key from the shell environment, never from `.env`, and touches no run, credit, queue or studio.

## 7. Testing

All free, in the normal loop: the pin test; every eval check against good and bad fixtures; the runner against a fake
LLM (`test/fakes/`) including the refusal when `--cap` is missing or too low; the existing layer, niche, language and
compat tests, which stay green with `compat.test.ts` unedited; `npm run typecheck`.

## 8. Order of work (one commit each)

1. The audit of the content files and inline examples, written into §2.1.
2. `PROMPT_VERSION`, the temperature table, the pin test, the optional manifest field. The audit of the content files may add findings to §2.1; the plan's later tasks are written against §2 as it stands and are amended if §2.1 changes them.
3. The prompt fixes (§5), with the bump.
4. The pure eval checks and cases.
5. The runner script and the `CLAUDE.md` changes (the owner's-click list, `eval-out/` in the never-commit list, this spec in the table).
6. The owner's first baseline run (costs money; the owner starts it).

## 9. Not in scope

The picture and clip models' own wording beyond what Gemini writes into them (item 1); prompts for items 2 to 4;
billing, the queue, the studio.

## 10. Risks

- A fix that helps one language may hurt another: the multilingual cases are there to catch it.
- Judge scores drift if the judge model changes: the baseline records its id.
- Until the owner's first run, the prompt fixes are held by tests only, not by measurement.

## Changelog of `PROMPT_VERSION`

- `2026-10-18.1` — the baseline: the prompts and temperatures exactly as they were before this phase (all 0.9, inspect 0). The eval's first run measures this version.
- `2026-10-18.2` — translate 0.3 and part 0.7 (others unchanged); a `continue` scene's motionPrompt carries on the previous camera move (finding 2); the topic is fenced as a subject (finding 3); the picture and clip check also looks for a missing or replaced subject, and between a clip's frames for a subject that changes (finding 4).
- `2026-10-18.3` — the setting's example is its form (`<place>, <season> <year>: …`), not the siege of Constantinople (§2.1, row 6).
- `2026-10-18.4` — the example of a moving setting is its form with placeholders; the three wars of the phase 8 test video are gone from every prompt (§2.1, row 7).
- `2026-10-18.5` — a niche's and a type's opening is labelled "First line (scene 1's narration, not the hook title)" instead of "Hook", and the tie-break says "the first line" (§2.1, row 10).
- `2026-10-18.6` — where a niche and a type differ, the type also decides the person and tense (§2.1, row 11).
- `2026-10-18.7` — the script is told an edit's name and how to frame and cut, not the form's description of its finish (§2.1, row 12).
- `2026-10-18.8` — the "What if?" niche's example about a week without sleep, a health topic the niches leave out, is "What if Earth had rings like Saturn" (§2.1, row 15).
- `2026-10-18.9` — the "Stories with a lesson" niche's example "The two wolves inside you", told as a Cherokee legend without a source, is "The potter who kept the cracked bowl" (§2.1, row 16).
- `2026-10-18.10` — a top list's delivery no longer says "nothing between the items", which contradicted the rule that every script is one spoken piece (§2.1, row 18).
- `2026-10-18.11` — no prompt text changed: the pin test now also renders a niche with a type, an outline and a part with every layer, and a script with a style, characters and feedback.
- `2026-10-18.12` — the script may mark a cut as a reframe (phase 10 spec §4): a new rule offered only to a documentary, story or pov run that takes several picture references; and a note, added only to a picture prompt that has a look reference, to take the look and copy nothing else; no prompt changes for any other run (its response-schema field reached every run until `.15`).
- `2026-10-18.13` — a new Gemini call, `upsample`, expands a picture prompt for the FLUX 3 picture model with BFL's own text-to-image or image-editing instructions, and sees the reference pictures when there are some (phase 10 spec §3, §3.1); greedy decoding; no other prompt changed.
- `2026-10-18.14` — the picture check also looks for what was copied from a reference and, for the FLUX 3 profile, for unlawful, unsafe or infringing content (phase 10 spec §6).
- `2026-10-18.15` — the response schemas the model is given no longer carry the reframe or unsafe fields for a run that does not use them (they leaked into every run at `.12` and `.14`), the schemas are pinned, and the upsampler's decoding settings (thinking off, 3584 tokens) are part of the pinned table (phase 10 final review).
- `2026-10-29.16` — the script prompt gains a `soundCues` rule and the sound vocabulary (scene `soundCues` rule and the sound vocabulary added to the script prompt; phase 12 spec §2): up to two sounds a scene clearly has a source for, silence by default.
