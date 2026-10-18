import { HASHTAGS } from "../hashtags.js";

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
