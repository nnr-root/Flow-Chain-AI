import type { ChartItem } from "./chart.js";
import { filterIdeas } from "./filter.js";
import { type Idea, parseIdeas, parseIdeasText } from "./ideas.js";
import { regionFor } from "./region.js";
import type { IdeasAnswer, LlmProvider } from "../providers/types.js";

export type IdeasInput = { niche?: string; nicheText?: string; format?: string; language: string; region?: string };

/** One model call, then every check: what comes out is only ideas that passed. Messages here never carry a key or a link. */
export async function makeIdeas(
  deps: { llm: LlmProvider; chart: (region: string) => Promise<ChartItem[]>; today: string },
  input: IdeasInput,
): Promise<{ ideas: Idea[]; dropped: number; usage?: IdeasAnswer["usage"] }> {
  const region = regionFor(input.language, input.region);
  if (!deps.llm.ideas) throw new Error("this provider cannot suggest topics");
  // The chart is a help, not a need: without it the web alone is used.
  let chart: ChartItem[] = [];
  try {
    chart = await deps.chart(region);
  } catch {
    chart = [];
  }
  const answer = await deps.llm.ideas({ niche: input.niche, nicheText: input.nicheText, format: input.format, language: input.language, region, chart, today: deps.today });
  const parsed = parseIdeas(parseIdeasText(answer.text));
  const { kept, dropped } = filterIdeas(parsed.ideas, answer.hosts);
  if (kept.length === 0) throw new Error("no idea was left after the checks");
  return { ideas: kept, dropped: parsed.invalid + dropped.length, usage: answer.usage };
}
