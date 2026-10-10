/*
 * What a series is to the browser and the server alike (phase 6 spec §3). No secrets, no database: the words an
 * episode's script is asked for are worked out here, so they can be tested without either.
 */

/** The longest topic the new-video form takes; an episode's built topic must fit in it. */
export const TOPIC_CHARS = 500;

/**
 * The topic of a series' next episode: the premise, which episode it is, and what the series has made already,
 * so the script is about something else. Built, not typed, and no paid call is made for it: the script stage,
 * which is paid for anyway, is what reads it. When the list of earlier titles would not fit, the oldest go
 * first: the most recent are the ones a new episode is likeliest to repeat.
 */
export function episodeTopic(premise: string, earlier: string[]): string {
  const about = premise.trim().replace(/[.\s]+$/, "");
  const n = earlier.length + 1;
  if (n === 1) return `${about}. This is the first video of a series.`.slice(0, TOPIC_CHARS);
  const head = `${about}. This is video ${n} of a series. Make it about something the series has not done yet. Already made: `;
  const titles = earlier.map((t) => t.trim().replace(/[;\s]+$/, "")).filter((t) => t !== "");
  let kept = titles;
  // (as many of the latest as fit; a premise that leaves no room for any still says which video it is)
  while (kept.length > 0 && head.length + kept.join("; ").length + 1 > TOPIC_CHARS) kept = kept.slice(1);
  if (kept.length === 0) return `${about}. This is video ${n} of a series. Make it about something the series has not done yet.`.slice(0, TOPIC_CHARS);
  return `${head}${kept.join("; ")}.`;
}

/** How often a series with a schedule is due. `manual`: only when its button is pressed. */
export const CADENCES = { manual: "Only when I ask", weekly3: "Three a week", daily: "One a day", daily2: "Two a day" } as const;
export type Cadence = keyof typeof CADENCES;

/** Why a series stands still, in the owner's words, by the reason the database keeps. */
export const PAUSED: Record<string, string> = {
  user: "You stopped it.",
  credit: "Your credit did not cover its next video.",
  failed: "Its last video was not finished. Have a look at it before letting the series go on.",
};

export type SeriesView = {
  id: string;
  name: string;
  premise: string;
  /** The look's name as the form knows it ("auto" when the topic chooses). */
  style: string;
  aspect: string;
  /** About how long each of its videos runs, in seconds. */
  durationSec: number;
  /** How long each scene of them stays, in seconds. */
  sceneSec: { min: number; max: number };
  createdAt: string;
  /** Its schedule, which is its owner's approval to make videos by itself (phase 6 spec §15). */
  cadence: Cadence;
  active: boolean;
  pausedReason: string | null;
  nextDueAt: string | null;
  /** Where its videos go (one of the owner's connected channels), and whether each is shown to the owner first. */
  channelId: string | null;
  reviewFirst: boolean;
  /** What its videos made this calendar month have used so far, with what is held for one being made. */
  monthUsd: number;
  /** Its videos, oldest first: the run's id, and its title once the script is written. */
  episodes: Array<{ runId: string; title?: string; state: string; spendUsd?: number }>;
};
