# Phase 7: a video asked for by its length

Date: 2026-10-10. Owner's direction; built the same day against the fake providers and the stand-in CLI.
Two videos were then made on the real engines the same day (§10), which changed two numbers and fixed two faults.

## 1. What was asked

In place of a number of scenes, the owner chooses:

- **how long the video runs**: whole minutes from one to ten and nothing longer, and shorter lengths that suit a
  short;
- **how long each scene stays**, as one length ("5 seconds") or a range ("3 to 5"), with the longest no longer
  than the clip model can make;
- **what the video is made of**: generated pictures only, both, or generated clips only.

The script's model does the planning: how many scenes there are, and how long each is. The number of scenes
leaves the form. This is for every side of the product, not the form alone.

## 2. Decisions

- **Lengths** (`VIDEO_SECONDS`, `src/duration.ts`): 5, 10, 15, 20, 30 and 45 seconds, then 1 to 10 minutes. The
  short ones are the usual lengths of a short and of an ad; 30 seconds is where the form starts.
- **A scene stays 2 to 5 seconds** (`SCENE_SECONDS`), whole seconds, 3 to 5 unless said. Both ends are the clip
  model's: it makes 33 to 81 frames at 16 a second, 2.06 to 5.06 seconds. Five and not six, though the fit step
  can slow a clip by a quarter: that slack is what covers a scene whose voice ran long.
- **Audio still drives timing.** A length is a target for the writing. The script is asked for so many words,
  the voice speaks them, and the video is as long as the voice was. Every page says "about".
- **The voice speaks 2.4 words a second** (`WORDS_PER_SECOND`; first set at 2.7, see §10). It is the one number
  that turns seconds into words, and the first thing to measure again if videos come out long or short.
- **`--scenes` stays in the CLI** for the owner (1 to 12, as before) and every earlier run loads and continues
  unchanged. The studio no longer sends it, and the worker refuses a draft that carries it.

## 3. The pipeline

A run asked for by its length has `request.timing = { targetSec, sceneSec: { min, max } }` (optional, so old
runs load). It is created with `--duration <seconds> [--scene-seconds <n|a-b>]`. With it nothing can be given
per scene (`--modes`, `--shots`, a list for `--pin-modes`): there are no scenes yet to belong to.

- **Before the script** the run is laid out for an assumed number of scenes (`expectedScenes`), which is what
  its first estimate is made on.
- **The script** is asked for a length, as words, and for scenes within the range, and told how many scenes
  that allows (`sceneBounds`); it decides. Its answer is checked against limits wider than the ones it was
  given (`timingProblems`): an answer is paid for whether or not it is accepted, and the real length is the
  voice's anyway, so only an answer that would come out clearly wrong is sent back (once, with what was wrong).
- **After the script** the run has as many scenes as the script (`layOutScenes`): `request.sceneCount` and the
  scene states follow, and the one choice the run was made with (a mode for every scene) is spread over them.
  A scene that is dropped when a script is written again may have had a provider job on its way; what it was
  expected to cost moves to the run's `abandonedUsd` first, so no paid call leaves the record.
- **The script stage is keyed on the timing**, not on the number of scenes, which is its own answer: writing
  seven scenes where eight were assumed changes nothing it was written from.

Everything after the script is as it was: it works on the scenes that are there.

## 4. A long video is written in parts

One answer of two hundred scenes does not keep to its rules. So a video of more than 90 seconds
(`SINGLE_ANSWER_MAX_SECONDS`) is written in parts of about a minute (`scriptParts`): at most thirty scenes an
answer.

1. **An outline**: title, hook, look, characters, palette, and for each part what it tells, in a sentence or
   two. One story with a direction: no part repeats another.
2. **Each part**, in order: its scenes, for its own seconds, given the whole outline and the last two lines of
   the part before. The first is told to open on the hook, the last to land the payoff, the others not to
   conclude. Each part's first scene begins on a fresh picture.

Each answer is checked on its own and sent back once on its own. **Each accepted answer is saved with its
charge** (`manifest.scriptParts`, keyed by the stage's input hash), so continuing a stopped run buys none of
them again; the field is gone once the script is whole.

**What a script costs** (`scriptAnswerCost`): an answer of few scenes costs what a script always has, so a
video of about twenty seconds costs what it did and the measurement the plans are sized by still stands;
beyond that an answer grows by its scenes. A ten-minute script is eleven answers.

## 5. What the video is made of

The form's choice is the request's `motion`, as before, now said in the studio's words and for the whole video:
**Pictures only** (every scene pinned to a still), **Pictures and clips** (the mode rules: a clip where the
script says something happens, a still where little does), **Clips only** (every scene pinned to a clip). A
scene can still be changed on the draft. With pictures only there is no clip size to choose, and the form does
not show one.

## 6. The studio

- **The request** (`NewVideo`): `durationSec` (one of the lengths) and `sceneSec` in place of `scenes`. A
  series' saved choices are the same shape; one saved before this is read with today's defaults.
- **The form**: Length; "Each scene stays" from and to, which cannot cross, with the number of scenes that
  makes; Made of. No number of scenes.
- **What a draft holds** follows from its length (`draftCapUsd`): the script with every answer bought twice,
  and a little over; never less than the $0.02 a short one always held. The worker works the same amount out
  from the command it is given (`draftCapOfArgs`) and takes the job only with exactly that held; a command that
  names no length a video can have matches no hold.
- **A run can have 360 scenes** (`MAX_SCENES`): ten minutes of two-second scenes, with the fifth more a script
  is allowed. A run asked for by a number of scenes is still held to twelve.

## 7. Found while building

- **A long video would have run the player out of audio tags.** Each cut's sound was mounted from its cue to
  the end of the video; with hundreds of cuts, hundreds of audio tags at once, and a player has sixteen. Each is
  now mounted for two seconds (the longest sound is 1.2 s). The sound is the same.
- **The model's time limit** for an answer was a minute; an answer of forty scenes takes longer. A run asked
  for by its length has five (`TIMEOUTS.llmLong`).

## 8. What a long video costs and takes (worked out, not measured)

The pipeline makes one thing at a time. From the speeds the price table records: a clip takes about 100 to 120
seconds to make, a picture about 6, a line of voice about 5.

| | Scenes | Made of clips only | Made of pictures only |
|---|---|---|---|
| 30 seconds | 6 to 10 | about 15 minutes, about 600 credits | a few minutes, about 200 credits |
| 1 minute | 12 to 20 | about half an hour | about 5 minutes |
| 10 minutes | 120 to 200 | **4 to 6 hours**, about 10,000 credits | about half an hour, about 1,500 credits |

A job is never retried on its own, so a ten-minute video of clips that meets one failure in those hours waits
for its owner to continue it (nothing made is bought again). Ten minutes of clips is also more than the
smallest plan's month of credits. Neither was changed here; both are the owner's to know.

## 9. Checked, and not

**Ran:** the arithmetic of lengths, scenes, words, parts and prices; the prompts (the prompt of a run asked for
by its scenes is the same text as before, compared byte for byte); the script stage for a short video, a
sent-back answer, two refusals, a video in parts, a part sent back alone, a stopped run continued, answers kept
for other inputs; laying scenes out again with money on its way; a whole run by its length through every
stage with the fake providers, in clips and in pictures only; a draft priced and pinned by its script's
scenes; the request, the command and the worker's refusal of a number of scenes; a ten-minute draft's hold
with accounts, and the worker's own reckoning of it; the form in a browser.

**Not checked, and this is most of the risk:** no script here was written by the real model. Whether it keeps
to a word count, how far a "30 second" video really lands from 30 seconds, whether a ten-minute outline holds
together as one story, and whether hours of clips complete, are all unknown until the owner runs one. The
first to run is a 30-second one, then a two-minute one (the shortest that is written in parts).

**Parked:** making several clips at once (what would bring ten minutes of clips from hours to less); saying on
the draft how far the script's own estimate is from the length asked for; an email when a long video is done.

## 10. The first two real videos (owner's click, 2026-10-10)

Made with the CLI on the studio's own engines, each as a draft and then continued under a cap of one dollar.

| Asked for | Made of | Scenes | Came out | Cost | Run |
|---|---|---|---|---|---|
| 30 seconds, scenes of 3 to 5 | pictures and clips (5 clips, 2 pictures) | 7 | **34.4 s** | $0.174 | `20261010-184702-447afb` |
| 2 minutes, scenes of 3 to 5, written in two parts | pictures only | 28 | **148.5 s** | $0.127 | `20261010-185123-a2ab78` |

Both finished without a failure. The two-minute script read as one piece across its parts: the second part
carried on from the first's last lines and ended the video.

**Found and fixed:**

- **The model's service refuses a schema whose list of scenes may be long.** A limit of 12 or 16 entries is
  taken; 24, 54 and 360 are answered "invalid argument"; no limit is taken. A short list now says its limit as
  before, and a longer one says none (the number of scenes is checked when the answer is back). Refused
  requests were not billed.
- **A run of pictures only was priced as clips before its script existed**, and stopped at its cap having
  spent nothing. A pinned scene now starts in the mode it is pinned to.
- **Both videos ran long**, by 15% and 24%. Two causes, both measured: the voice spoke 2.42 words a second over
  these 35 scenes, not the 2.7 that seven earlier four-scene videos had given; and the model wrote every scene
  at the top of its range (12 or 13 words, 21 of 28 scenes over five seconds, the longest 6.2). The rate is now
  2.4, and the prompt says what a scene is on average and not to write every one at the longest length.

**After the fix, scripts only** (two more drafts, three cents): 30 seconds came back as 76 words in 7 scenes of
10 to 11, about 31 seconds at the measured rate; two minutes as 282 words in 28 scenes of 8 to 12, about 117.
Neither was sent back. These two were not spoken, so their real lengths are worked out and not measured.

**Still unknown:** anything longer than two minutes; a long video of clips (hours); how a different voice or
language moves the rate.

## 11. Several clips at once: what the endpoint does (owner's click, 2026-10-10)

A probe, not a change: the clip endpoint's `workersMax` was set from 1 to 3, four clip jobs (65 frames, 480p,
the pictures of run `…447afb`) were sent at once, and the setting was put back to 1 (read back: nothing else on
the endpoint moved either time).

| Job | Waited | Ran | Worker |
|---|---|---|---|
| 3 | 7 s | 153 s | the one that was already up |
| 2 | 155 s | 54 s | the same one, after job 3 |
| 1 | 153 s | 166 s | a second, started for this |
| 4 | 144 s | 179 s | a third, started for this |

All four done 320 seconds after they were sent; 552 GPU seconds billed.

- **It works**: RunPod started two more workers for the queue and each took a job.
- **A worker that starts costs about two minutes of GPU before its first frame** (166 and 179 seconds for a
  clip that takes 54 on a warm one), and its job waited two and a half minutes for it.
- **So four clips gained nothing**: one worker would have made them in about 315 seconds (153, then 54 each)
  for 315 GPU seconds. Three workers took as long and billed three quarters more.
- **A warm worker made 65 frames in 54 seconds**, 0.83 a frame, where the price table says 1.5. One
  observation; if it holds, clips cost the studio about half of what a run's ledger records, and ten minutes of
  clips on one worker take about two and a quarter hours, not the four to six of §8.

What follows for a design (not built): extra workers pay only when there are many clips, roughly a dozen or
more for each extra worker. The endpoint would scale by the number of jobs waiting (so that a run sending one
job at a time never starts a second worker, which is what phase 3.1 §16 met), and the pipeline would decide
how many to send at once from how many clips a run has. The clips stage would then have several jobs in
flight for one manifest, and every rule about recording a paid call before it can be lost has to hold for
every order in which they can end.

