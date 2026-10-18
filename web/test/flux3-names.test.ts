import { describe, expect, it } from "vitest";
import { namesInternals } from "@/lib/engines";

describe("what customers are never shown", () => {
  it("includes the new picture model's names", () => {
    for (const text of ["FLUX 3 klein", "klein 4B", "Qwen3-VL", "RUNPOD_PICTURE3_ENDPOINT"]) expect(namesInternals(text), text).toBe(true);
  });
});
