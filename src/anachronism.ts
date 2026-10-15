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
