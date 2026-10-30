import { z } from "zod";

export const IDEA_TOPIC_MAX = 300;
export const IDEA_COUNT = 8;
/**
 * How long the model call for ideas may take. A grounded call with a few web searches took 20–60 s when measured
 * (phase 13 spec §11); the studio's CLI limit and its wait (`IDEAS_WAIT_MS` in web/server/jobs/redis.ts) are longer.
 */
export const IDEAS_MODEL_TIMEOUT_MS = 90_000;

const WHY_MAX = 240;
const SOURCES_READ = 6;
const IDEAS_READ = 12;

const Source = z.object({ title: z.string().trim().min(1).max(120), url: z.string().url().refine((u) => u.startsWith("https://"), "https only") });

/** What a valid idea looks like once `parseIdeas` is done with it. */
export const Idea = z.object({
  topic: z.string().trim().min(8).max(IDEA_TOPIC_MAX),
  why: z.string().trim().min(8).max(WHY_MAX),
  sources: z.array(Source).max(SOURCES_READ).default([]),
});
export type Idea = z.infer<typeof Idea>;
const Topic = Idea.shape.topic;
const Why = z.string().trim().min(8);

/** A plain cut at the last word boundary before the limit (the model writes a long reason now and then). */
function cutAtWord(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = text.slice(0, max);
  const space = head.lastIndexOf(" ");
  return (space > 0 ? head.slice(0, space) : head).trim();
}

/**
 * One invalid field must not cost the valid ideas beside it (phase 13 spec §11.2): each idea is checked alone, and one
 * with no usable topic or reason is dropped and counted; a bad source link is dropped from its idea, which stays.
 */
export function parseIdeas(raw: unknown): { ideas: Idea[]; invalid: number } {
  const list = raw && typeof raw === "object" ? (raw as { ideas?: unknown }).ideas : undefined;
  if (!Array.isArray(list)) throw new Error("the answer did not have the right shape");
  const ideas: Idea[] = [];
  let invalid = 0;
  for (const item of list.slice(0, IDEAS_READ)) {
    const o = item && typeof item === "object" ? (item as Record<string, unknown>) : null;
    const topic = Topic.safeParse(o?.topic);
    const why = Why.safeParse(o?.why);
    if (!topic.success || !why.success) {
      invalid += 1;
      continue;
    }
    const sources = (Array.isArray(o?.sources) ? (o.sources as unknown[]).slice(0, SOURCES_READ) : [])
      .map((s) => Source.safeParse(s))
      .flatMap((r) => (r.success ? [r.data] : []));
    ideas.push({ topic: topic.data, why: cutAtWord(why.data, WHY_MAX), sources });
  }
  if (ideas.length === 0) throw new Error("no idea was left after the checks");
  return { ideas, invalid };
}

/** The model may wrap its JSON in prose or a code fence: take from the first `{` to the last `}`. */
export function parseIdeasText(text: string): unknown {
  const from = text.indexOf("{");
  const to = text.lastIndexOf("}");
  if (from < 0 || to <= from) throw new Error("the answer was not JSON");
  try {
    return JSON.parse(text.slice(from, to + 1));
  } catch {
    throw new Error("the answer was not JSON");
  }
}
