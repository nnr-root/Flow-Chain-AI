import { describe, expect, it } from "vitest";
import { checkFfmpeg, formatChecks, parseFfmpegMajor } from "../../src/doctor.js";

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

  it("formats checks one per line", () => {
    expect(formatChecks([{ name: "a", ok: true, detail: "fine" }, { name: "b", ok: false, detail: "bad" }])).toBe(
      "✓ a — fine\n✗ b — bad",
    );
  });
});
