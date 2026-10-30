import { IDEA_COUNT, type Idea } from "./ideas.js";
import { leftOutOf } from "./leftout.js";

const SOURCES_MAX = 3;

export function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

const normal = (s: string): string => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/** Drops what the studio leaves out and what repeats; keeps only sources the search really visited (`hosts`), over https. */
export function filterIdeas(ideas: Idea[], hosts: string[]): { kept: Idea[]; dropped: Array<{ topic: string; reason: string }> } {
  const known = new Set(hosts.map((h) => h.toLowerCase().replace(/^www\./, "")));
  const seen = new Set<string>();
  const kept: Idea[] = [];
  const dropped: Array<{ topic: string; reason: string }> = [];
  for (const idea of ideas) {
    const category = leftOutOf(`${idea.topic} ${idea.why}`);
    if (category) {
      dropped.push({ topic: idea.topic, reason: `left out: ${category}` });
      continue;
    }
    const key = normal(idea.topic);
    if (seen.has(key)) {
      dropped.push({ topic: idea.topic, reason: "duplicate" });
      continue;
    }
    seen.add(key);
    const sources = idea.sources
      .filter((s) => {
        if (!s.url.startsWith("https://")) return false;
        const host = hostOf(s.url);
        return host !== null && known.has(host);
      })
      .slice(0, SOURCES_MAX);
    kept.push({ ...idea, sources });
  }
  return { kept: kept.slice(0, IDEA_COUNT), dropped };
}
