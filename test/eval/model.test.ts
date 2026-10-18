import { describe, expect, it } from "vitest";
import { modelMismatch, withoutEmpty } from "../../src/eval/model.js";

describe("the model an eval is judged by", () => {
  it("treats an empty variable as unset, so the default applies", () => {
    expect(withoutEmpty({ GEMINI_MODEL: "", GEMINI_API_KEY: "k", OTHER: undefined })).toEqual({ GEMINI_API_KEY: "k" });
  });
  it("says nothing when there is no baseline or the same model judged both", () => {
    expect(modelMismatch(undefined, "gemini-x-001")).toBeNull();
    expect(modelMismatch("gemini-x-001", "gemini-x-001")).toBeNull();
  });
  it("warns that scores are not comparable when another model judged the baseline", () => {
    expect(modelMismatch("gemini-a", "gemini-b")).toBe("the baseline was judged by gemini-a, this run by gemini-b: scores are not comparable");
  });
});
