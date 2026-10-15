/*
 * Things of a later time in a script set in the past (phase 7 spec §21). The setting is added to every picture, and
 * the script's model is told what may not be in it; this is the last check, on the words of the prompts, before
 * any picture is bought. It looks only for what is plainly modern, so a sword is never taken for a smartphone:
 * a word that is also old ("suit" of armour, drinking "glasses", a folding "screen", the "camera" of a shot) is not on it.
 */

/** Whether a setting is in the past: a year before 1900, a year BC, or the name of a period. */
export function isPast(setting: string): boolean {
  const s = setting.toLowerCase();
  if (/\b\d{1,4}\s*(bc|bce)\b/.test(s)) return true;
  const years = [...s.matchAll(/\b(\d{3,4})\b/g)].map((m) => Number(m[1]));
  if (years.some((y) => y < 1900)) return true;
  return /\b(ancient|antiquity|medieval|middle ages|prehistoric|stone age|bronze age|iron age|century|centuries|renaissance|feudal|viking|roman empire|byzantine|ottoman|pharaoh|samurai|edo period|victorian|colonial)\b/.test(s);
}

const MODERN = /\b(business suits?|three-piece suits?|blazers?|neckties?|tuxedos?|wristwatch(es)?|sunglasses|eyeglasses|smartphones?|mobile phones?|telephones?|laptops?|computers?|televisions?|tv screens?|cars?|trucks?|plastic|zippers?|jeans|t-shirts?|sneakers|hoodies?|electric (lights?|lamps?)|light ?bulbs?|neon|asphalt|airplanes?|helicopters?|microphones?)\b/i;

/** For a script set in the past: each scene prompt naming something plainly modern, as a problem the model can act on. */
export function anachronisms(scenes: ReadonlyArray<{ imagePrompt: string; motionPrompt: string }>, setting: string | undefined, first = 1): string[] {
  if (!setting || !isPast(setting)) return [];
  const problems: string[] = [];
  scenes.forEach((s, i) => {
    for (const field of ["imagePrompt", "motionPrompt"] as const) {
      const found = MODERN.exec(s[field]);
      if (found) problems.push(`scene ${i + first} ${field} shows "${found[0]}", which does not belong to the setting (${setting}): describe what people and things there really were`);
    }
  });
  return problems;
}

/*
 * Motion a generated clip gets wrong (phase 7 spec §23). The clip model draws hands and fingers badly when they
 * move, and turns a figure "shifting closer" into an arm reaching out, skin-coloured on a shadow. Its negative prompt
 * does nothing at the guidance it runs at (cfg 1, for speed), so the motion is kept out of what it is asked for.
 * A word with another sense is looked for only in the hand's ("waves goodbye", not the waves of the sea).
 */
const HAND_MOTION = /\b(reach(es|ed|ing)?|grab(s|bed|bing)?|grasp(s|ed|ing)?|clutch(es|ed|ing)?|snatch(es|ed|ing)?|point(s|ed|ing)? (at|to|toward)|wav(es|ed|ing) (goodbye|hello|at|to|his|her|their|a hand)|gestur(e|es|ed|ing)|clap(s|ped|ping)?|beckon(s|ed|ing)?|fingers?|hands? (move|moves|moving|reach|reaches|reaching|rise|rises|lift|lifts))\b/i;

/** Each motion prompt that asks for a moving hand, as a problem the model can act on. */
export function handMotions(scenes: ReadonlyArray<{ motionPrompt: string }>, first = 1): string[] {
  return scenes.flatMap((s, i) => {
    const found = HAND_MOTION.exec(s.motionPrompt);
    return found ? [`scene ${i + first} motionPrompt has "${found[0]}": generated clips get moving hands wrong. Keep hands still or out of the frame, and give the scene a camera move and slow, simple motion instead`] : [];
  });
}
