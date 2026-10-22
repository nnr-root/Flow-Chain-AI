import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { POST as createDraft } from "@/app/api/drafts/route";
import { GET as health } from "@/app/api/health/route";
import { calls, request, useStudio, withKeys } from "./helpers";

const studio = useStudio();
const smooth = async (env: string) => {
  await writeFile(join(studio.root, ".env"), env);
  return JSON.parse(await (await health(request("/api/health"), undefined)).text()).smooth;
};

describe("the health answer's smooth motion", () => {
  it("is offered only when the restorer is set up AND the owner switched it on, and is absent otherwise", async () => {
    expect(await smooth("RUNPOD_UPSCALE_ENDPOINT=secret-u\n")).toBeUndefined();
    expect(await smooth("FLOWCHAIN_SMOOTH_MOTION=on\n")).toBeUndefined();
    expect(await smooth("RUNPOD_UPSCALE_ENDPOINT=secret-u\nFLOWCHAIN_SMOOTH_MOTION=off\n")).toBeUndefined();
    expect(await smooth("RUNPOD_UPSCALE_ENDPOINT=secret-u\nFLOWCHAIN_SMOOTH_MOTION=on\n")).toBe(true);
  });

  it("never says where the restorer is", async () => {
    await writeFile(join(studio.root, ".env"), "RUNPOD_UPSCALE_ENDPOINT=secret-u\nFLOWCHAIN_SMOOTH_MOTION=on\n");
    expect(await (await health(request("/api/health"), undefined)).text()).not.toContain("secret");
  });
});

describe("a draft that asks for smooth motion", () => {
  it("is refused while it is not offered, before anything is started", async () => {
    withKeys();
    await writeFile(join(studio.root, ".env"), "RUNPOD_UPSCALE_ENDPOINT=secret-u\n");
    const res = await createDraft(request("/api/drafts", { json: { topic: "foxes", fps: 60 } }), undefined);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatchObject({ code: "validation", message: "fps: smooth motion is not available in this studio yet" });
    expect(await calls(studio)).toEqual([]);
  });
});
