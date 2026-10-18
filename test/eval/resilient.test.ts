import { describe, expect, it } from "vitest";
import { HttpError } from "../../src/providers/retry.js";
import { resilientJudge, resilientLlm } from "../../src/eval/resilient.js";
import type { ScriptRequest } from "../../src/providers/types.js";

const req = { topic: "t", aspect: "9:16", sceneCount: 3 } as ScriptRequest;

describe("an eval's model calls", () => {
  it("retry a transient error, and the result is the answer", async () => {
    let calls = 0;
    const llm = resilientLlm({ generateScript: async () => { if (++calls === 1) throw new Error("503 unavailable"); return { ok: 1 }; } }, 1);
    expect(await llm.generateScript(req)).toEqual({ ok: 1 });
    expect(calls).toBe(2);
  });
  it("still fail after the attempts, so the driver's abort handling applies", async () => {
    let calls = 0;
    const llm = resilientLlm({ generateScript: async () => { calls++; throw new Error("503 unavailable"); } }, 1);
    await expect(llm.generateScript(req)).rejects.toThrow(/failed after 3 attempts/);
    expect(calls).toBe(3);
  });
  it("do not retry an error that cannot be fixed by retrying", async () => {
    let calls = 0;
    const llm = resilientLlm({ generateScript: async () => { calls++; throw new HttpError("quota", 429); } }, 1);
    await expect(llm.generateScript(req)).rejects.toThrow();
    expect(calls).toBe(1);
  });
  it("hold for the judge too", async () => {
    let calls = 0;
    const judge = resilientJudge(async () => { if (++calls === 1) throw new Error("503"); return "answer"; }, 1);
    expect(await judge("p")).toBe("answer");
    let always = 0;
    const failing = resilientJudge(async () => { always++; throw new Error("503"); }, 1);
    await expect(failing("p")).rejects.toThrow(/failed after 3 attempts/);
    expect(always).toBe(3);
  });
});
