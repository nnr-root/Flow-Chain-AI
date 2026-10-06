import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseRange, resolvePublished, serveFile, serveStatic } from "@/server/files";
import { preview } from "@/server/runs";
import { draftManifest, finishedManifest, nextRunId, useStudio } from "./helpers";

const studio = useStudio();
const get = (headers: Record<string, string> = {}) => new Request("http://127.0.0.1/f", { headers });

describe("published files", () => {
  it("serves only what the run's props publish, plus the run's own outputs", () => {
    const id = nextRunId();
    const dir = join(studio.runs, id);
    const shown = preview(finishedManifest(id), id);
    expect(resolvePublished(dir, "fitted/scene_01.mp4", shown)).toBe(join(dir, "fitted/scene_01.mp4"));
    expect(resolvePublished(dir, "final.mp4", shown)).toBe(join(dir, "final.mp4"));
    expect(resolvePublished(dir, "images/keyframe_02.png", shown)).toBe(join(dir, "images/keyframe_02.png"));
    for (const bad of ["manifest.json", "job.log", "../other/final.mp4", "images/../manifest.json", "audio/scene_01.wav", ".lock", "/etc/passwd"]) {
      expect(() => resolvePublished(dir, bad, shown)).toThrow("no file");
    }
  });

  it("a file outside the run folder is reachable only because the run names it (its music)", () => {
    const id = nextRunId();
    const m = finishedManifest(id);
    expect(() => resolvePublished(join(studio.runs, id), "bgm.mp3", preview(m, id))).toThrow("no file");
    m.request.bgm = "/music/library/song.mp3";
    expect(resolvePublished(join(studio.runs, id), "bgm.mp3", preview(m, id))).toBe("/music/library/song.mp3");
  });
});

describe("byte ranges", () => {
  it("parses the three forms and rejects what cannot be satisfied", () => {
    expect(parseRange(null, 100)).toBeUndefined();
    expect(parseRange("bytes=0-9", 100)).toEqual({ start: 0, end: 9 });
    expect(parseRange("bytes=90-", 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange("bytes=-10", 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange("bytes=50-500", 100)).toEqual({ start: 50, end: 99 });
    for (const bad of ["bytes=100-", "bytes=9-1", "bytes=-", "items=0-1", "bytes=a-b"]) expect(parseRange(bad, 100)).toBeNull();
  });

  it("serves whole files, ranges, 416 and 304", async () => {
    const file = join(studio.root, "clip.mp4");
    await writeFile(file, Buffer.from("0123456789"));
    const whole = await serveStatic(get(), file);
    expect(whole.status).toBe(200);
    expect(whole.headers.get("content-type")).toBe("video/mp4");
    expect(whole.headers.get("accept-ranges")).toBe("bytes");
    expect(whole.headers.get("content-length")).toBe("10");
    expect(await whole.text()).toBe("0123456789");

    const part = await serveStatic(get({ range: "bytes=2-5" }), file);
    expect(part.status).toBe(206);
    expect(part.headers.get("content-range")).toBe("bytes 2-5/10");
    expect(await part.text()).toBe("2345");

    const past = await serveStatic(get({ range: "bytes=10-" }), file);
    expect(past.status).toBe(416);
    expect(past.headers.get("content-range")).toBe("bytes */10");

    const again = await serveStatic(get({ "if-none-match": whole.headers.get("etag")! }), file);
    expect(again.status).toBe(304);
    await expect(serveStatic(get(), join(studio.root, "missing.mp4"))).rejects.toMatchObject({ code: "not_found" });
    await mkdir(join(studio.root, "folder"));
    await expect(serveStatic(get(), join(studio.root, "folder"))).rejects.toMatchObject({ code: "not_found" });
  });

  it("an SVG is sandboxed, so an uploaded logo opened directly cannot run script", async () => {
    const file = join(studio.root, "logo.svg");
    await writeFile(file, '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    const res = await serveStatic(get(), file);
    expect(res.headers.get("content-type")).toBe("image/svg+xml");
    expect(res.headers.get("content-security-policy")).toContain("sandbox");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });
});

describe("a draft's stand-ins", () => {
  it("are generated on request: a card per scene and silence as long as the draft", async () => {
    const id = nextRunId();
    const m = draftManifest(id);
    const shown = preview(m, id);
    const card = await serveFile(get(), shown.files["draft/scene_02.svg"], m, id, shown);
    expect(card.headers.get("content-type")).toBe("image/svg+xml");
    expect(await card.text()).toContain("SCENE 2 OF 3");

    const silence = await serveFile(get(), shown.files["draft/silence.wav"], m, id, shown);
    expect(silence.headers.get("content-type")).toBe("audio/wav");
    const seconds = shown.props.totalFrames / shown.props.fps;
    expect((await silence.arrayBuffer()).byteLength).toBe(44 + Math.round(seconds * 8000) * 2);
    await expect(serveFile(get(), "virtual:scene:9", m, id, shown)).rejects.toMatchObject({ code: "not_found" });
    await expect(serveFile(get(), "virtual:other", m, id, shown)).rejects.toMatchObject({ code: "not_found" });
  });
});
