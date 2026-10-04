import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import {
  captionFontFiles, checkFfmpeg, checkRemotionBrowser, formatChecks, parseFfmpegMajor, REQUIRED_FILTERS,
} from "../../src/doctor.js";

describe("doctor", () => {
  it("parses ffmpeg major versions", () => {
    expect(parseFfmpegMajor("ffmpeg version 8.1.2 Copyright (c) 2000-2026")).toBe(8);
    expect(parseFfmpegMajor("ffmpeg version n7.1 Copyright")).toBe(7);
    expect(parseFfmpegMajor("ffmpeg version N-118000-gabcdef Copyright")).toBeNull();
  });

  it("finds a usable ffmpeg on this machine", async () => {
    const checks = await checkFfmpeg();
    expect(checks.filter((c) => !c.ok)).toEqual([]);
  });

  it("only requires the ffmpeg filters the Remotion-era pipeline still uses", () => {
    expect(REQUIRED_FILTERS).toEqual(["silencedetect", "atrim", "concat", "tpad", "trim", "xstack", "loudnorm"]);
  });

  it("finds Remotion's browser (downloads it once if missing)", async () => {
    expect(await checkRemotionBrowser()).toMatch(/^ready \(/);
  });

  it("checks the font of every caption style and every style preset, each once", () => {
    const fonts = captionFontFiles("assets/fonts");
    expect(fonts.map((f) => f.replace("assets/fonts/", "")).sort()).toEqual([
      "Bangers-Regular.ttf",
      "Cinzel-Variable.ttf",
      "Inter-SemiBold.ttf",
      "LuckiestGuy-Regular.ttf",
      "Montserrat-ExtraBold.ttf",
      "Orbitron-Variable.ttf",
    ]);
    expect(fonts.every((f) => existsSync(f))).toBe(true);
  });

  it("formats checks one per line", () => {
    expect(formatChecks([{ name: "a", ok: true, detail: "fine" }, { name: "b", ok: false, detail: "bad" }])).toBe(
      "✓ a — fine\n✗ b — bad",
    );
  });
});
