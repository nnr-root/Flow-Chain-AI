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

export type SeriesView = {
  id: string;
  name: string;
  premise: string;
  /** The look's name as the form knows it ("auto" when the topic chooses). */
  style: string;
  aspect: string;
  scenes: number;
  createdAt: string;
  /** Its videos, oldest first: the run's id, and its title once the script is written. */
  episodes: Array<{ runId: string; title?: string; state: string; spendUsd?: number }>;
};
