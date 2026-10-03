import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { CaptionStyle, CaptionStyleName } from "../../src/media/remotion/props.js";
import { CAPTION_STYLES, captionBottomPct } from "../../src/media/remotion/styles.js";

describe("caption styles", () => {
  it("defines every style name with a valid style, a bundled font and its license", () => {
    for (const name of CaptionStyleName.options) {
      const style = CAPTION_STYLES[name];
      expect(CaptionStyle.safeParse(style).success).toBe(true);
      expect(existsSync(resolve("assets/fonts", style.font.file))).toBe(true);
    }
    for (const license of ["OFL.txt", "LuckiestGuy-LICENSE.txt", "Inter-LICENSE.txt"]) {
      expect(existsSync(resolve("assets/fonts", license))).toBe(true);
    }
  });

  it("keeps Phase 1's hormozi look and sets mrbeast and minimalist apart", () => {
    expect(CAPTION_STYLES.hormozi).toMatchObject({ textCase: "upper", activeColor: "#FFE500", maxWordsPerPage: 3, activeAnim: "none" });
    expect(CAPTION_STYLES.mrbeast).toMatchObject({ activeColor: "#3CFF5A", maxWordsPerPage: 2, activeAnim: "pop" });
    expect(CAPTION_STYLES.minimalist).toMatchObject({ textCase: "none", inactiveOpacity: 0.6, maxWordsPerPage: 6, stroke: null });
  });

  it("places captions higher in portrait than in landscape", () => {
    expect(captionBottomPct(1080, 1920)).toBe(30);
    expect(captionBottomPct(1920, 1080)).toBe(12);
  });
});
