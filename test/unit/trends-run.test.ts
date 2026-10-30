import { describe, expect, it } from "vitest";
import { hostsOfChunks } from "../../src/providers/gemini.js";
import { fetchChart } from "../../src/providers/youtube-chart.js";
import { makeIdeas } from "../../src/trends/run.js";
import type { IdeasRequest } from "../../src/providers/types.js";
import { FakeLlm } from "../fakes/providers.js";

const KEY = "AIzaSECRETKEY123";
const idea = (topic: string, url = "https://example.com/a") => ({ topic, why: "people are searching for it this week", sources: [{ title: "Example", url }, { title: "Other", url: "https://other.org/b" }] });
const eight = [
  idea("How the new tram line changes commuting"),
  idea("Why octopuses are so smart"),
  idea("The history of the paper clip"),
  idea("What happens inside a volcano"),
  idea("How bees decide where to live"),
  idea("The fastest trains in the world"),
  idea("The election results explained by politics experts"),
  idea("Why the parliament vote is politics again"),
];
const answerText = `Here you go:\n${JSON.stringify({ ideas: eight })}\nDone.`;

function llmWith(text: string, seen: IdeasRequest[] = []) {
  const llm = new FakeLlm(() => ({}));
  llm.ideas = async (req) => {
    seen.push(req);
    return { text, hosts: ["example.com"], usage: { searches: 2 } };
  };
  return llm;
}
const noChart = async () => [];

describe("makeIdeas", () => {
  it("keeps six, drops the left-out ones, and leaves only sources the search visited", async () => {
    const seen: IdeasRequest[] = [];
    const chart = async () => [{ title: "Chart title one", channel: "c", categoryId: "1", views: 5 }];
    const out = await makeIdeas({ llm: llmWith(answerText, seen), chart, today: "2026-10-30" }, { language: "tr" });
    expect(out.ideas).toHaveLength(6);
    expect(out.dropped).toBe(2);
    for (const i of out.ideas) expect(i.sources.map((s) => s.url)).toEqual(["https://example.com/a"]);
    expect(seen[0].region).toBe("TR");
    expect(seen[0].chart.map((c) => c.title)).toEqual(["Chart title one"]);
    expect(out.usage?.searches).toBe(2);
  });

  it("keeps the valid ideas beside invalid ones and counts both kinds of drop", async () => {
    const mixed = [...eight.slice(0, 4), { topic: "short", why: "people are searching for it this week" }, { topic: "A topic with no reason at all" }];
    const out = await makeIdeas({ llm: llmWith(JSON.stringify({ ideas: [...mixed, ...eight.slice(6)] })), chart: noChart, today: "2026-10-30" }, { language: "en" });
    expect(out.ideas).toHaveLength(4);
    expect(out.dropped).toBe(4);
  });

  it("goes on with an empty chart when the chart throws", async () => {
    const seen: IdeasRequest[] = [];
    await makeIdeas({ llm: llmWith(answerText, seen), chart: async () => { throw new Error(`boom ${KEY}`); }, today: "2026-10-30" }, { language: "en" });
    expect(seen[0].chart).toEqual([]);
  });

  it("rejects an answer that is not JSON, has the wrong shape, or is all left out, without a key or a link", async () => {
    const cases: Array<[string, string]> = [
      ["no json here", "the answer was not JSON"],
      [JSON.stringify({ ideas: "x" }), "the answer did not have the right shape"],
      [JSON.stringify({ ideas: [{ topic: "x" }] }), "no idea was left after the checks"],
      [JSON.stringify({ ideas: [eight[6], eight[7]] }), "no idea was left after the checks"],
    ];
    for (const [text, message] of cases) {
      const err = await makeIdeas({ llm: llmWith(text), chart: noChart, today: "2026-10-30" }, { language: "en" }).catch((e: Error) => e);
      expect((err as Error).message).toBe(message);
      expect((err as Error).message).not.toMatch(/https?:|AIza|key/i);
    }
  });

  it("rejects a provider without ideas", async () => {
    await expect(makeIdeas({ llm: new FakeLlm(() => ({})), chart: noChart, today: "2026-10-30" }, { language: "en" })).rejects.toThrow("this provider cannot suggest topics");
  });
});

describe("hostsOfChunks", () => {
  it("reads titles and direct links, skips the redirect host, collapses duplicates", () => {
    const hosts = hostsOfChunks([
      { web: { title: "Example.COM", uri: "https://vertexaisearch.cloud.google.com/grounding-api-redirect/abc" } },
      { web: { uri: "https://www.bbc.co.uk/x" } },
      { web: { title: "example.com" } },
      {},
    ]);
    expect(hosts).toEqual(["example.com", "bbc.co.uk"]);
    expect(hosts).not.toContain("vertexaisearch.cloud.google.com");
  });
});

describe("fetchChart", () => {
  it("asks for the most popular chart of the region with the key", async () => {
    let url = "";
    const stub = (async (u: string) => {
      url = u;
      return new Response(JSON.stringify({ items: [{ snippet: { title: "A video", channelTitle: "C", categoryId: "10" }, statistics: { viewCount: "42" } }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const chart = await fetchChart(KEY, "TR", stub);
    expect(url).toContain("chart=mostPopular");
    expect(url).toContain("regionCode=TR");
    expect(url).toContain(`key=${KEY}`);
    expect(chart).toEqual([{ title: "A video", channel: "C", categoryId: "10", views: 42 }]);
  });

  it("says only that the chart is not available, on an HTTP error and on a network error", async () => {
    const forbidden = (async () => new Response("no", { status: 403 })) as unknown as typeof fetch;
    const err403 = await fetchChart(KEY, "US", forbidden).catch((e: Error) => e);
    expect((err403 as Error).message).toBe("the chart is not available (HTTP 403)");
    const down = (async (u: string) => { throw new Error(`failed ${u}`); }) as unknown as typeof fetch;
    const errNet = await fetchChart(KEY, "US", down).catch((e: Error) => e);
    expect((errNet as Error).message).toBe("the chart is not available");
    for (const e of [err403, errNet]) expect((e as Error).message).not.toMatch(new RegExp(`${KEY}|googleapis`));
  });
});
