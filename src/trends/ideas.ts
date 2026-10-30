import { z } from "zod";

export const IDEA_TOPIC_MAX = 300;
export const IDEA_COUNT = 8;

export const Idea = z.object({
  topic: z.string().trim().min(8).max(IDEA_TOPIC_MAX),
  why: z.string().trim().min(8).max(240),
  sources: z.array(z.object({ title: z.string().trim().min(1).max(120), url: z.string().url().refine((u) => u.startsWith("https://"), "https only") })).max(6).default([]),
});
export type Idea = z.infer<typeof Idea>;
export const IdeasParsed = z.object({ ideas: z.array(Idea).min(1).max(12) });

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
