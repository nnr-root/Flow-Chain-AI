import { describe, expect, it } from "vitest";
import { finalizeFilter, quoteFilterPath } from "../../src/media/assemble.js";

describe("finalizeFilter", () => {
  const base = { captions: "/r/captions.ass", fontsDir: "/p/assets/fonts", totalSec: 91 / 30 };

  it("burns captions and loudness-normalizes narration padded to the exact length", () => {
    const f = finalizeFilter({ ...base, hasBgm: false });
    expect(f).toBe(
      "[0:v]ass='/r/captions.ass':fontsdir='/p/assets/fonts'[v];" +
        "[1:a]aformat=sample_rates=48000:channel_layouts=stereo,loudnorm=I=-14:TP=-1.5:LRA=11,aresample=48000,apad,atrim=end=3.033333[a]",
    );
  });

  it("ducks background music under the narration", () => {
    const f = finalizeFilter({ ...base, hasBgm: true });
    expect(f).toContain("[2:a]aformat=sample_rates=48000:channel_layouts=stereo,volume=0.35[b]");
    expect(f).toContain("[b][n1]sidechaincompress=threshold=0.05:ratio=8:attack=20:release=300[d]");
    expect(f).toContain("[n2][d]amix=inputs=2:duration=first:normalize=0,loudnorm=");
  });
});

describe("quoteFilterPath", () => {
  it("quotes paths and rejects single quotes", () => {
    expect(quoteFilterPath("/a b/c.ass")).toBe("'/a b/c.ass'");
    expect(() => quoteFilterPath("/it's/c.ass")).toThrow(/quote/);
  });
});
