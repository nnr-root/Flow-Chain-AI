/** The categories the studio does not suggest topics in (phase 13 spec §6). Narrow on purpose: myths and history are not caught. */
export const LEFT_OUT: Record<"health" | "religion" | "politics" | "money", RegExp> = {
  health: /\b(cures?|diagnos\w*|symptoms?|therapy|vaccin\w*|cancer|diabet\w*|weight loss|diet|supplements?|medicat\w*|mental health|depress\w*|covid|pandemic)\b/i,
  religion: /\b(allah|jesus|christ(ian\w*)?|islam\w*|muslims?|qur'?an|koran|bible|pope|mosque|church|prayer|atheis\w*|judaism|hindu\w*|buddhis\w*)\b/i,
  politics: /\b(elections?|votes?|voting|prime minister|parliament|congress|senate|republican\w*|democrat\w*|trump|biden|putin|sanctions?|immigration|campaign|politician\w*|political)\b/i,
  money: /\b(crypto\w*|bitcoin|ethereum|nfts?|forex|day trading|stock tips?|get rich|passive income|loans?|mortgages?|trading bot|casino|betting|gambl\w*)\b/i,
};

export function leftOutOf(text: string): string | null {
  for (const [name, pattern] of Object.entries(LEFT_OUT)) if (pattern.test(text)) return name;
  return null;
}
