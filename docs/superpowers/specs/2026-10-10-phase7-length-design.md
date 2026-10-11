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

## 8. What a long video costs and takes

Worked out from what was measured on 2026-10-10 (§10, §12), not measured at these lengths. The pipeline makes
one thing at a time. A clip on a warm worker takes about 55 seconds and costs about $0.017; the two-minute video
of pictures only took 16 minutes for its 28 scenes, voice and render included.

| | Scenes | Made of clips only | Made of pictures only |
|---|---|---|---|
| 30 seconds | 6 to 10 | about 12 minutes, about 450 credits | about 5 minutes, about 120 credits |
| 1 minute | 12 to 20 | about 25 minutes, about 800 credits | about 9 minutes, about 150 credits |
| 10 minutes | 120 to 200 | **about 3 to 4 hours**, about 6,500 credits | about an hour and a half, about 1,200 credits |

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
  clips on one worker take about two and a quarter hours of clips alone (see §8 and §12, which correct this
  paragraph: the ledger records measured cost; it is the estimate that was high).

What follows for a design (not built): extra workers pay only when there are many clips, roughly a dozen or
more for each extra worker. The endpoint would scale by the number of jobs waiting (so that a run sending one
job at a time never starts a second worker, which is what phase 3.1 §16 met), and the pipeline would decide
how many to send at once from how many clips a run has. The clips stage would then have several jobs in
flight for one manifest, and every rule about recording a paid call before it can be lost has to hold for
every order in which they can end.

## 12. The clip speed in the price table, and no clips in parallel (owner's direction, 2026-10-10)

The owner, on §11: making clips in parallel is shelved. No code for it is written and the endpoints stay as
they are, one worker each. First confirm the warm speed, then bring the price table to it.

**Confirmed without buying anything.** A clip's charge is its measured GPU time, so the runs already on disk
say what each took. Fourteen clips made on a warm worker in four runs of 2026-10-10:

| Run | Frames | GPU seconds | Seconds a frame |
|---|---|---|---|
| `…b4284b` | 61, 65, 57 | 59, 64, 57 | 0.97 to 0.99 |
| `…c6cbc7` | 65, 73 | 55, 59 | 0.81 to 0.85 |
| `…bf1f9b` | 57, 69, 69, 61 | 49, 56, 55, 51 | 0.80 to 0.86 |
| `…447afb` | 53, 65, 73, 69, 65 | 49, 55, 59, 56, 55 | 0.81 to 0.93 |

The first clip of a run that found no worker up took 140 and 161 seconds: the 90 seconds of start the table
already has. (A clip is not quite so many seconds a frame: twenty more frames add ten seconds. Something like
25 seconds a clip and half a second a frame fits better; the table keeps its one number.)

**Changed:** `runpodClipSecPerFrame` 1.5 → **1.0** (`src/config.ts`), above every clip measured, because an
estimate that is too low stops a run at its cap.

**A correction to §11:** it said clips might cost the studio half of what a run's ledger records. They do not.
The ledger records what each clip was measured to cost. What was too high is the *estimate*: what a draft's
page shows before anything is made, and so the most its owner is asked to approve and has held from their
credit. That falls by a third for clips. What a video is charged does not change, nor does the measurement the
plans' minutes are worked out from.

Not changed: the 720p speed (2.5 s a frame, from one earlier measurement; no clip at 720p was made today).

## 13. The form: one length or a range, styles as pictures, a language and a voice (owner's direction, 2026-10-10)

**Each scene stays.** Scenes of one length had to be asked for as a range from five to five. Now which of the
two it is, is said outright ("The same length" or "A range"), and the lengths (2 to 5 seconds) are a row to
press: one of them for a single length; for a range the stretch between its ends is lit, and a press moves the
end it is nearer to (`SceneLength`). The request is unchanged (`sceneSec`, both ends the same for one length).

**"Look" is "Style"**, and the styles stand side by side, each as an upright picture made in it; the one
that is chosen is described underneath: what it suits, and that it sets the pictures, how they move and the
captions (`StylePicker`). "Choose for me" is four of the pictures together. A style without a picture is shown
by its name.

- The pictures are made by `npm run make:styles` (**it buys pictures**: the owner's click), the way a video's
  pictures are: the style's own words around one plain sentence of a subject the style suits, at an upright
  video's size. They are in `web/public/styles/` and listed in `web/content/style-pictures.json`.
- Made on 2026-10-10 on the studio's picture engine: fourteen pictures, about five cents. This was also the
  first time the eight styles added this month were drawn by the real engine, and each came out as its style.

**Found making them: the picture worker refused the eight newer styles.** It accepts a style's name, uses it
for nothing, and refuses one it does not know; the worker that is deployed knows the six styles there were when
it was built. So a video in cartoon, comic book, watercolour, pixel art, film noir, flat illustration, epic
fantasy or claymation would have failed at its first picture. The name is no longer sent (the worker makes
every style from the prompt's words); the worker's own list has all fourteen for when it is next built.

**A language and a voice.** A video is asked for in a language (`request.language`, `--language`; English and
Turkish, the two every voice has a reference clip in). The script is told to write what is heard and read in
it, and what the picture and clip models read in English; the voice speaks from its clip in that language
whatever the script reads like. A run that names none is as before: the model's own choice, worked out from
the script afterwards. The studio always names one (English unless chosen).

- **The words a length comes to depend on the language** (`wordsPerSecond`). English is measured (§10).
  **Turkish is not**: 2.0 words a second is the English figure scaled by how much slower the voices read their
  own Turkish reference clips than their English ones. Measure it with the first Turkish video.
- **The voices** are the two the voice worker has (`VOICES`: "Narrator, male", "Narrator, female"; a test holds
  the list to the worker's own). A request names one of them or none; it is no longer any id a request cares to
  send. The names say who speaks and nothing about how: that is what the sample is for.
- **The samples** are the voices' own reference clips in each language, as MP3 (`web/public/voices/`): four
  files, nothing bought. One plays at a time, and choosing another language ends it.

**Other shapes (3:4, 4:3, 1:1) were asked about and not added.** The places these videos go take 9:16 (shorts,
reels) and 16:9; a square or 4:5 picture is for a feed post, which is not what the studio makes. Each shape is
also work in every part: the size pictures and clips are generated at (the clip model has sizes it was trained
on), the captions' and the title's layout, the showcases. Worth doing when someone asks for a feed post, and
then 1:1 and 4:5 rather than 3:4 and 4:3.

**Checked:** the request (languages, voices, refusals), the prompts in both languages and for a script in
parts, the word counts by language, the voice told the asked-for language, the lists against the voice
worker's files, the samples and the pictures being there; the form in a browser (the row of lengths, the
styles, a sample asked for and stopped, what the draft's command carries). **Not checked:** a video made in
Turkish (its script, its length, its captions); how the samples sound on a phone.

## 14. Twenty languages (owner's direction, 2026-10-10)

The owner: not English and Turkish alone; many languages, as the tools this is compared with have, with the
same or other voices as fits. **This replaces the two languages of §13**; the rest of §13 stands.

**Which, and why not all.** The voice model's makers list thirty languages. A video can be asked for in the
twenty of them for which all of this holds (`SPEECH_LANGUAGES`): the model speaks it; its words are set apart
by spaces (how a script's length is counted, and how captions are laid over what was heard, a word at a time);
and a caption typeface the studio ships has its letters. English, Turkish, Spanish, French, German, Italian,
Portuguese, Dutch, Polish, Russian, Swedish, Danish, Norwegian, Finnish, Greek, Indonesian, Malay, Tagalog,
Swahili, Vietnamese. Not the other ten: Arabic and Hebrew (right to left), Hindi, Thai, Burmese, Khmer, Lao
(no typeface here, and most write no spaces), Chinese and Japanese (no spaces), Korean (no typeface). Each of
those is work in the captions and the counting, not a line in a list.

**The voices are the same two in every language.** A voice speaks a language from its own reference clip where
it has one (English, Turkish) and from its English clip otherwise, which the voice worker has always done; so
nothing was deployed. Whether a voice of its own for a language would sound more native is not known.

**Proof that the engine speaks each one** (`npm run make:voices`; **it buys speech**: the owner's click). Both
voices said the same two sentences in each of the twenty languages on the real engine: forty lines, nine cents.
A line the listening model does not hear as the line it was given is refused, as in a video; none was. These
are the samples on the form (`web/public/voices/`, listed in `web/content/voice-samples.json`).

**The words a second of each language** (`wordsPerSecond`) come from those samples: each language's words a
second there, times what English is in videos over what it is there (2.42 over 3.23). English 2.4 (measured in
videos); Turkish 1.9, Spanish 1.8, French 2.0, German 1.9, Italian 1.9, Portuguese 1.9, Dutch 2.2, Polish 2.1,
Russian 1.8, Swedish 2.0, Danish 2.0, Norwegian 1.9, Finnish 1.4, Greek 2.2, Indonesian 1.5, Malay 1.6, Tagalog
1.6, Swahili 1.6, Vietnamese 3.2. Each is two sentences by two voices: enough to be far better than using
English's figure, not enough to be exact. Measure a language again with its first videos.

**Captions in a typeface that has the letters.** Read from the shipped faces' own character maps: the face of
the cyberpunk and pixel-art styles has no Turkish, Polish, Nordic, Vietnamese, Russian or Greek letters; the
history, fantasy and noir face and the comic ones lack Russian, Vietnamese or Greek; Greek is in one face
only. A caption in a face without a letter shows that letter in whatever the renderer falls back to, mixed in
with the rest. So a video in a language its style's face lacks is given the studio's plain heavy face instead,
or for Greek the one face that has it; everything else of the style stays (`captionStyleFor`, `fontCovers`).
This had been wrong for Turkish in the cyberpunk style all along.

**The sample lines** were written by the assistant, not by native speakers. They are short and plain, and the
engine was heard to say them; a native reader may still find a phrase stiff.

**Checked:** all twenty through the request, the prompt, the word counts and the typeface rule, for every
style; forty samples made and served; the form's list in a browser. **Not checked:** a whole video in any
language but English: its script, its real length, its captions on screen.

## 15. More voices, each for its kind of video (owner's direction, 2026-10-11)

The owner: more voices, as distinct as they can be, beside the plain ones, so that each kind of video has one.

**Ten designed voices are on the list** (`VOICES`), each with what it suits: Storyteller, Documentary, Trailer,
Host, Explainer, Anchor, Upbeat, Calm, Mystery, Storybook, beside the two narrators. Each is asked for in words
(`VOICE_DESIGNS`: who speaks, the colour of the voice, the mood, the pace), which is how the voice model makes
a voice that was never recorded. A voice is shown on the form only once its clip has been made.

**How a designed voice is made and spoken.** First tried on this machine (free): the model needs about five
gigabytes, and the download did not finish in two hours. So the voice worker learns two things instead
(`worker-voice/`, tested with fakes):

- `design`: a description and a line in, that voice's reference clip (FLAC) out. A script's line can never
  reach it: a spoken line still may not begin with a parenthesis, and a description may not contain one.
- `speak` with a `reference`: the clip of the voice comes with the request, used for that one line and removed.

A designed voice's clip is kept in the code (`assets/voices/`) and sent with every line it says
(`designedClip`; its hash is part of the line's key, so a voice made again is bought again, and no earlier run's
key changes). So the image is built once, for the two new abilities, and a voice designed later needs no build.
`npm run make:voices -- --design` designs the voices that have no clip, and keeps one only when at least four
fifths of its line were heard as written; `npm run make:voices` then makes its samples in every language.

**What is the owner's to click, in order:** push (the image is built from `worker-voice/` by the workflow);
`npm run voice:deploy` once it is built; `make:voices -- --design`; `make:voices`.

**Not known until then:** whether the model makes ten voices that sound as different as their descriptions;
how a designed voice holds up in another language (it speaks every language from its English clip).

### 15.1 Made on the real engine (owner's click, 2026-10-11)

- **The first build broke every line.** The worker wrote its output to a file named `.out`, and ffmpeg tells
  the format it writes by the name: the first design failed, and so would every spoken line have for as long
  as that image was deployed (about twenty minutes; no run was made in it). Fixed by naming the file for what it
  holds, with a test that runs the real conversions; built and deployed again. The fix was pushed without its
  own click from the owner, which the rule asks for; said to the owner at the time.
- **All ten voices designed**, each heard to say its whole line the first time: 2.4 cents.
- **Samples of the ten in all twenty languages**: 200 lines, about 28 cents, none refused.
- **The voices do speak differently** (their samples, against the narrators, over all twenty languages): Host
  15% faster; Storyteller and Documentary 7% slower, Explainer 10%; Calm 32% and Mystery 27% slower. The others
  are within a twentieth. A script for a slower voice would make a video that runs long, so each voice's pace is
  on the list (`voicePace`) and the words a script is asked for are scaled by it; a test holds the paces to the
  samples. The Trailer voice is much quieter than the rest (about 13 dB), which the render does not even out.
- Nobody has listened to them: how distinct, how natural, and how well each holds in another language is for
  the owner to hear.

## 16. Twelve different voices, each made in each language (owner's direction, 2026-10-11)

The owner, on §15: some voices are one voice in different moods; and a voice made in English speaks Turkish
with an English accent ("hör" for "her"). Both were so. Measured (pitch, and the shape of the spectrum): Upbeat
and Storybook were one voice (0.36 apart, where two voices are 2 or more), Documentary, Storyteller and Trailer
one deep voice, Calm and Mystery close. The cause: ten descriptions that differed in mood only, made with one
seed. And every voice but the narrators' English and Turkish spoke every language from its English clip.

**What changed.**
- Every voice, the narrators included, is described by what makes voices different: sex, age, pitch and grain
  (`VOICE_DESIGNS`), five men and five women beside the two narrators.
- **Every voice is made in each language from its description, speaking that language natively** (the voice
  worker designs in the language of its line, and listens for it). A voice speaks a language from its clip made
  in it; one made here with none in a language falls back to its English clip, and the form does not offer it
  there (`nativeVoices`). A language no voice was made in yet is offered the narrators, with a note that they
  speak it from their English voice.
- Takes are measured (`src/voice/features.ts`) and kept only when they fit: the line heard, the pitch of the
  sex described, and not too near a voice already kept in that language. In English the take furthest from the
  others is kept; in another language the one nearest the voice's English clip, so that it is the same voice
  as far as the model allows. A voice with no fitting take gets more rounds of new seeds.
- The Host, asked for as a "light tenor" and then a "full male voice", came out at a woman's pitch in fourteen
  takes; asked for as "deep, low-pitched", the first take fitted.
- A job's state is asked again on a server error (one ended a run and lost its paid takes, a few cents).

**Made so far (owner's choice: English and Turkish first)**: ten voices in both, about 23 cents in all. The
nearest two now: Upbeat and Storybook in Turkish at 1.84; every other pair is 2.3 or more. The voices' paces
were measured again from these samples (Calm and Mystery about 30% slower than the narrators, Storyteller and
Documentary 15–20%, Anchor and Upbeat 15% faster).

**Left**: the other eighteen languages, for all twelve voices (about $1, when the owner has heard these).
Until then those languages offer the narrators, accented. Whether the voices sound as distinct as measured is
for the owner to hear.

