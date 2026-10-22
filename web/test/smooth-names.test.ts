import { describe, expect, it } from "vitest";
import { namesInternals } from "@/lib/engines";

describe("what customers are never shown", () => {
  it("includes the restorer's model names, and not the English word", () => {
    for (const text of ["SeedVR2", "RIFE 4.9", "RIFE"]) expect(namesInternals(text), text).toBe(true);
    expect(namesInternals("a life rife with detail")).toBe(false);
  });
});
