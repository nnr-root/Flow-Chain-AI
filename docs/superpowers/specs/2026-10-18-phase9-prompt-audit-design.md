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

## 3. Rulings

- **Changing a prompt never re-buys an old run's script.** The script stage's input hash covers the request's fields
  (model, language, voice, rate, …), not the prompt text. This is why no version needs to enter a hash, and why
  `test/unit/compat.test.ts` is not edited.
- **A long script resumed after a prompt change** writes its remaining parts under the new prompt. The saved outline
  keeps the story whole. Keeping old prompt texts per version costs more than it protects.
- **Same-model judging is biased.** Judge scores mean something only against the baseline, never as grades.

## 4. Prompt versions

- `PROMPT_VERSION`: a dated constant exported from `src/providers/gemini.ts`, for example `"2026-10-18.1"`. It is
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

(none yet; the first entry is written in task 2)
