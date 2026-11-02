import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { SceneStatus } from "@src/studio/status";
import { SceneRow } from "@/components/Studio";

const scene: SceneStatus = { scene: 1, mode: 2, override: 2, narration: "A fox at night.", imagePrompt: "a fox", steps: [] };
const row = (opts: { draft: boolean; picturesOnly?: boolean }) =>
  renderToStaticMarkup(createElement(SceneRow, { scene, picture: null, canReroll: false, busy: false, onMode: () => {}, onReroll: () => {}, ...opts }));

describe("a scene of a draft on the draft page", () => {
  it("offers no Auto and no Clip in a video of pictures made where no clip engine is set up (phase 15 spec §13.10)", () => {
    const page = row({ draft: true, picturesOnly: true });
    expect(page).not.toContain('aria-label="Scene 1 mode"');
    expect(page).not.toContain(">Auto<");
    expect(page).not.toContain(">Clip<");
    expect(page).toContain('data-testid="scene-1-pictures-only"');
  });

  it("offers Auto, Clip and Still in any other draft, as before", () => {
    const page = row({ draft: true });
    expect(page).toContain('aria-label="Scene 1 mode"');
    for (const label of [">Auto<", ">Clip<", ">Still<"]) expect(page).toContain(label);
    expect(page).not.toContain("pictures-only");
  });
});
