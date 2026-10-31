import { HASHTAGS } from "../hashtags.js";
import { countUnits, speechCap } from "../voice/words.js";

/** What an eval check found: which check, where in the answer, and what. */
export type Finding = { check: string; where: string; detail: string };

// (phase 9 spec §6: the checks the pipeline's own validators do not make)
const TEXT_ASKED = /\b(text|captions?|subtitles?|logos?|watermarks?|lettering|typography|writing on|words on)\b/i;
const GENERIC_TAG = /^#(fyp|foryou|foryoupage|viral|shorts|trending|reels|tiktok|explore)$/i;
const MOVE = /\b(push[- ]?in|pull[- ]?(back|out)|pan(s|ning)?|orbit(s|ing)?|tilt(s|ing)?|dolly|zoom(s|ing)?|track(s|ing)?)\b/i;
const STATIC = /\b(static|locked[- ]off|still) (camera|shot|frame)\b|\bcamera (is |stays |holds )?(static|still)\b/i;

/** Each picture prompt that asks for writing in the picture, which a picture model draws as gibberish. */
export function textAsked(scenes: ReadonlyArray<{ imagePrompt: string }>): Finding[] {
  return scenes.flatMap((s, i) => {
    const found = TEXT_ASKED.exec(s.imagePrompt);
    return found ? [{ check: "text-asked", where: `scene ${i + 1}`, detail: found[0] }] : [];
  });
}

/** The hashtags as sent, before they are put right in code: exactly five, none of the generic ones. */
export function rawHashtags(tags: readonly string[] | undefined): Finding[] {
  const sent = tags ?? [];
  return [
    ...(sent.length === HASHTAGS ? [] : [{ check: "hashtag-count", where: "hashtags", detail: `${sent.length} sent, ${HASHTAGS} asked` }]),
    ...sent.filter((t) => GENERIC_TAG.test(t)).map((t) => ({ check: "hashtag-generic", where: "hashtags", detail: t })),
  ];
}

/** A continue scene that holds the camera still straight after a scene that moved it: the clip starts from rest. */
export function startsFromRest(scenes: ReadonlyArray<{ motionPrompt: string; shot: string }>): Finding[] {
  return scenes.flatMap((s, i) =>
    i > 0 && s.shot === "continue" && STATIC.test(s.motionPrompt) && MOVE.test(scenes[i - 1].motionPrompt)
      ? [{ check: "starts-from-rest", where: `scene ${i + 1}`, detail: s.motionPrompt }]
      : [],
  );
}

// (phase 15 spec §1, §4: asked for any of these, the clip model drew a widescreen picture with black bands inside the
// vertical frame, or several shots in one clip; "cuts the bread" is an action, not a cut, so a cut is "cut to"/"cut away")
const WIDESCREEN = /\bcinematic\b|\bfilm\b|\bwidescreen\b|\bletterbox(?:ed)?\b|\bblack bars\b|\bcuts? (?:to|away)\b|\bmulti-?shot\b|\bshot sequence\b|\bsequence of shots\b/gi;
const AUDIO_SENTENCE = /(?:^|[.!?"”]\s+)Audio:\s*\S/;
const LIPS = "lips moving precisely with every word";

/** Each clip prompt that asks for a cut or a widescreen look, and each whose sound is not in a last "Audio:" sentence. */
export function videoPromptFaults(scenes: ReadonlyArray<{ videoPrompt?: string }>): Finding[] {
  return scenes.flatMap((s, i) => {
    if (!s.videoPrompt) return [];
    const where = `scene ${i + 1}`;
    const words = [...s.videoPrompt.matchAll(WIDESCREEN)].map((m) => ({ check: "video-widescreen", where, detail: m[0] }));
    return AUDIO_SENTENCE.test(s.videoPrompt) ? words : [...words, { check: "video-audio", where, detail: s.videoPrompt.slice(-80) }];
  });
}

/**
 * The sentences people say (phase 15 spec §5): none where the run did not allow them; where it did, at most two
 * scenes, each sentence within the cap (counted by the words module, so in characters without spaces), and quoted
 * in its scene's clip prompt with the lip clause.
 */
export function speechFaults(scenes: ReadonlyArray<{ speech?: string; videoPrompt?: string }>, allowed: boolean, language?: string): Finding[] {
  const speaking = scenes.map((s, i) => ({ ...s, said: s.speech?.trim() ?? "", where: `scene ${i + 1}` })).filter((s) => s.said);
  if (!allowed) return speaking.map((s) => ({ check: "speech-not-allowed", where: s.where, detail: s.said }));
  return [
    ...(speaking.length > 2 ? [{ check: "speech-scenes", where: "scenes", detail: `${speaking.length} scenes speak, 2 at most` }] : []),
    ...speaking.flatMap((s) => [
      ...(countUnits(s.said, language) > speechCap(language) ? [{ check: "speech-words", where: s.where, detail: s.said }] : []),
      ...(s.videoPrompt?.includes(s.said) && s.videoPrompt.toLowerCase().includes(LIPS) ? [] : [{ check: "speech-unquoted", where: s.where, detail: s.said }]),
    ]),
  ];
}
