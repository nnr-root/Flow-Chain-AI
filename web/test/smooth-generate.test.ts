import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { POST as generate } from "@/app/api/runs/[id]/generate/route";
import { calls, draftManifest, nextRunId, params, request, saveRun, stub, until, useStudio } from "./helpers";
import { readJob } from "@/server/jobs";

const studio = useStudio();
const on = () => writeFile(join(studio.root, ".env"), "RUNPOD_UPSCALE_ENDPOINT=secret-u\nFLOWCHAIN_SMOOTH_MOTION=on\n");
const off = () => writeFile(join(studio.root, ".env"), "RUNPOD_UPSCALE_ENDPOINT=secret-u\nFLOWCHAIN_SMOOTH_MOTION=off\n");
const draft = async (fps?: 60) => {
  const id = nextRunId();
  const m = draftManifest(id);
  if (fps) m.request.fps = fps;
  await saveRun(studio, m);
  await stub(studio, "_plan.json", { items: [], totalUsd: 0.25 });
  return id;
};
const go = (id: string) => generate(request(`/api/runs/${id}/generate`, { json: { approvedUsd: 0.25 } }), params({ id }));

describe("generating a 60 fps draft", () => {
  it("is refused while smooth motion is not offered, before anything is priced or started", async () => {
    await off();
    const id = await draft(60);
    const res = await go(id);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatchObject({ code: "validation", message: "smooth motion is not available in this studio right now" });
    expect(await calls(studio)).toEqual([]);
  });

  it("goes through while it is offered", async () => {
    await on();
    const id = await draft(60);
    expect((await go(id)).status).toBe(202);
    await until(() => readJob(join(studio.runs, id))?.state === "ended");
    expect((await calls(studio)).at(-1)).toEqual(["resume", id, "--budget", "0.25", "--cap", "0.25"]);
  });

  it("leaves a draft without 60 fps alone, offered or not", async () => {
    await off();
    const id = await draft();
    expect((await go(id)).status).toBe(202);
    await until(() => readJob(join(studio.runs, id))?.state === "ended");
  });
});
