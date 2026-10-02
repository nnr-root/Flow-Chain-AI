import { describe, expect, it } from "vitest";
import { cellSize } from "../../src/media/contact-sheet.js";
import { kenBurnsFilter, zoompanExpr } from "../../src/media/kenburns.js";

const CENTER_X = "iw/2-(iw/zoom/2)";
const CENTER_Y = "ih/2-(ih/zoom/2)";

describe("zoompanExpr", () => {
  it("zooms around the center", () => {
    expect(zoompanExpr("zoom_in", 73)).toEqual({ z: "1+0.15*on/72", x: CENTER_X, y: CENTER_Y });
    expect(zoompanExpr("zoom_out", 73)).toEqual({ z: "1.15-0.15*on/72", x: CENTER_X, y: CENTER_Y });
  });

  it("pans at a fixed 1.15 zoom", () => {
    expect(zoompanExpr("pan_left", 73)).toEqual({ z: "1.15", x: "(iw-iw/zoom)*(1-on/72)", y: CENTER_Y });
    expect(zoompanExpr("pan_right", 73)).toEqual({ z: "1.15", x: "(iw-iw/zoom)*(on/72)", y: CENTER_Y });
    expect(zoompanExpr("pan_up", 73)).toEqual({ z: "1.15", x: CENTER_X, y: "(ih-ih/zoom)*(1-on/72)" });
    expect(zoompanExpr("pan_down", 73)).toEqual({ z: "1.15", x: CENTER_X, y: "(ih-ih/zoom)*(on/72)" });
  });

  it("never divides by zero for a one-frame scene", () => {
    expect(zoompanExpr("zoom_in", 1).z).toBe("1+0.15*on/1");
  });
});

describe("kenBurnsFilter", () => {
  it("oversamples 4x at the output aspect before zoompan", () => {
    const f = kenBurnsFilter("zoom_in", 15, { width: 180, height: 320 }, 30);
    expect(f).toContain("scale=720:1280:force_original_aspect_ratio=increase,crop=720:1280,zoompan=");
    expect(f).toContain(":d=15:s=180x320:fps=30,format=yuv420p[v]");
  });
});

describe("cellSize", () => {
  it("keeps the output aspect at a 360 px row height with an even width", () => {
    expect(cellSize({ width: 1080, height: 1920 })).toEqual({ width: 202, height: 360 });
    expect(cellSize({ width: 1920, height: 1080 })).toEqual({ width: 640, height: 360 });
  });
});
