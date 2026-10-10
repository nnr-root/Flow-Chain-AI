import { describe, expect, it } from "vitest";
import { episodeTopic, TOPIC_CHARS } from "@/lib/series";

describe("the topic a series' next video is written from", () => {
  it("is the premise and a word that a series begins, for the first one", () => {
    expect(episodeTopic("Greek myths, one god at a time.", [])).toBe("Greek myths, one god at a time. This is the first video of a series.");
  });

  it("names what the series has made already, so the next is about something else", () => {
    const topic = episodeTopic("Greek myths, one god at a time", ["The Rage of Zeus", "Hera's Revenge"]);
    expect(topic).toBe("Greek myths, one god at a time. This is video 3 of a series. Make it about something the series has not done yet. Already made: The Rage of Zeus; Hera's Revenge.");
  });

  it("always fits the form's topic, dropping the oldest titles first when there are too many", () => {
    const titles = Array.from({ length: 60 }, (_x, i) => `The Tale Number ${i + 1} of the Old Gods`);
    const topic = episodeTopic("Greek myths, one god at a time", titles);
    expect(topic.length).toBeLessThanOrEqual(TOPIC_CHARS);
    expect(topic).toContain("This is video 61 of a series");
    expect(topic).toContain("The Tale Number 60 of the Old Gods");
    expect(topic).not.toContain("The Tale Number 1 of the Old Gods;");
    // whole titles only: none is cut in the middle
    expect(topic.endsWith("of the Old Gods.")).toBe(true);
  });

  it("still says which video it is when the premise leaves no room for a single title", () => {
    const topic = episodeTopic("p".repeat(300), ["A Title That Is " + "long ".repeat(30)]);
    expect(topic.length).toBeLessThanOrEqual(TOPIC_CHARS);
    expect(topic).toContain("This is video 2 of a series");
    expect(topic).not.toContain("Already made");
  });

  it("leaves out titles that are empty, and the stray punctuation of the ones that are not", () => {
    expect(episodeTopic("Heists", ["  ", "The Vault; ", "Midnight Train"])).toContain("Already made: The Vault; Midnight Train.");
  });
});
