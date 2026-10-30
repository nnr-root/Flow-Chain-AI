import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { IdeaCard, IdeaSuggestions, sourceHost } from "@/components/IdeaSuggestions";

/* What a suggested topic looks like on the new-video form (phase 13 spec §6), rendered as the server would. */
const card = (sources: Array<{ title: string; url: string }>) =>
  renderToStaticMarkup(createElement(IdeaCard, { idea: { topic: "Night foxes", why: "Seen everywhere this week", sources }, onPick: () => {} }));

describe("a suggested topic's card", () => {
  it("shows each source by its title and the host its link really goes to, opened apart from the studio", () => {
    const html = card([{ title: "A model-chosen title", url: "https://www.example.org/foxes?x=1" }]);
    expect(html).toContain("Night foxes");
    expect(html).toContain("A model-chosen title");
    expect(html).toContain("(example.org)");
    expect(html).not.toContain("www.example.org)");
    expect(html).toMatch(/<a [^>]*href="https:\/\/www\.example\.org\/foxes\?x=1"[^>]*target="_blank"[^>]*rel="noopener noreferrer"/);
  });

  it("gives no link to an address that is not https or does not parse", () => {
    const html = card([
      { title: "plain", url: "http://example.org/a" },
      { title: "script", url: "javascript:alert(1)" },
      { title: "broken", url: "not a url" },
    ]);
    expect(html).not.toContain("<a ");
    expect(html).not.toMatch(/plain|script|broken/);
  });

  it("names the host without www., and nothing for what is not an https address", () => {
    expect(sourceHost("https://WWW.Example.org/x")).toBe("example.org");
    expect(sourceHost("https://news.example.org")).toBe("news.example.org");
    expect(sourceHost("http://example.org")).toBeNull();
    expect(sourceHost("::")).toBeNull();
  });

  it("is not shown before anything was asked: the form shows only the button", () => {
    const html = renderToStaticMarkup(createElement(IdeaSuggestions, { request: { language: "en" }, onPick: () => {} }));
    expect(html).toContain('data-testid="suggest-topic"');
    expect(html).not.toContain('data-testid="idea"');
  });
});
