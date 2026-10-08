import { describe, expect, it } from "vitest";
import { CARRIED_CHARS, startAddress } from "@/components/site/TopicStart";
import { safeNext } from "@/lib/supabase/settings";

/** A topic typed on the landing page must arrive in the new-video form as typed, and lead nowhere else. */
describe("the landing page's way in", () => {
  /** The path the sign-up page will send the visitor on to, as the server decides it. */
  const afterSignup = (address: string) => safeNext(new URL(address, "http://studio.test").searchParams.get("next"));
  const topicOf = (path: string) => new URL(path, "http://studio.test").searchParams.get("topic");

  it("carries the topic through creating an account, whatever is in it", () => {
    for (const topic of [
      "Three mistakes that make product photos look cheap",
      "Why owls don't blink & other night facts: 100% true?",
      "a/b testing #1 — does \"free\" = more sign-ups?",
      "Kahvaltıda ne yenir? ğüşiöç İstanbul",
      "//evil.example/path and \\\\evil too",
      "x".repeat(CARRIED_CHARS),
      // letters that take nine characters each in an address: the longest sentence the hero carries still fits
      // what the sign-up accepts as a destination (2000 characters)
      "視".repeat(CARRIED_CHARS),
      "Я".repeat(CARRIED_CHARS),
    ]) {
      const address = startAddress(topic, false);
      expect(address.startsWith("/signup?next=")).toBe(true);
      const next = afterSignup(address);
      expect(next.startsWith("/new?topic="), topic).toBe(true);
      expect(topicOf(next), topic).toBe(topic);
      expect(next.length, topic.slice(0, 20)).toBeLessThanOrEqual(2000);
      // with a session there is no detour
      expect(topicOf(startAddress(topic, true))).toBe(topic);
    }
  });

  it("leads to the form itself when nothing was typed, and never keeps more than the form takes", () => {
    expect(startAddress("   ", false)).toBe("/signup?next=%2Fnew");
    expect(startAddress("", true)).toBe("/new");
    expect(topicOf(startAddress(`  ${"y".repeat(600)}  `, true))).toBe("y".repeat(CARRIED_CHARS));
  });
});
