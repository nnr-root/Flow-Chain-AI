import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Camera } from "../../src/manifest/schema.js";
import type {
  ImageProvider, ImageRequest, LlmProvider, ScriptRequest, SpeakRequest, TtsProvider, VideoProvider, VideoRequest,
} from "../../src/providers/types.js";
import { makeAudio, makeImage, makeVideo } from "../helpers/media.js";

export type Shot = "continue" | "cut";

export function fakeScript(sceneCount: number, opts: { shots?: Shot[]; cameras?: Camera[] } = {}) {
  return {
    title: "Fake run",
    styleBible: { artStyle: "flat test pattern", characters: "a red fox", palette: "teal, orange" },
    scenes: Array.from({ length: sceneCount }, (_, i) => ({
      narration: `Scene ${i + 1} says hello. Then it pauses and continues.`,
      imagePrompt: `image ${i + 1}`,
      motionPrompt: `motion ${i + 1}`,
      shot: opts.shots?.[i] ?? (i === 0 ? "cut" : "continue"),
      camera: opts.cameras?.[i] ?? "zoom_in",
    })),
  };
}

export class FakeLlm implements LlmProvider {
  calls: ScriptRequest[] = [];
  constructor(private readonly respond: (req: ScriptRequest, callNo: number) => unknown) {}
  async generateScript(req: ScriptRequest): Promise<unknown> {
    this.calls.push(req);
    return this.respond(req, this.calls.length);
  }
}

/** Speaks the first half of the words, pauses 0.5 s, then speaks the rest, so silence removal has work to do. */
export class FakeTts implements TtsProvider {
  calls: SpeakRequest[] = [];
  constructor(private readonly dir: string) {}
  async speak(req: SpeakRequest) {
    this.calls.push(req);
    const words = req.text.split(/\s+/).filter(Boolean);
    const half = Math.ceil(words.length / 2);
    const per = 0.25;
    const path = join(this.dir, `tts_${this.calls.length}.mp3`);
    await makeAudio(path, [{ tone: half * per }, { silence: 0.5 }, { tone: (words.length - half) * per, freq: 550 }]);
    const timings = words.map((text, i) => {
      const start = i < half ? i * per : half * per + 0.5 + (i - half) * per;
      return { text, start, end: start + per - 0.02 };
    });
    return { audio: await readFile(path), words: timings };
  }
}

const COLORS = ["0x3366aa", "0xaa6633", "0x33aa66", "0xaa3366", "0x6633aa"];

export class FakeImage implements ImageProvider {
  calls: ImageRequest[] = [];
  constructor(private readonly dir: string) {}
  async generate(req: ImageRequest) {
    const n = this.calls.push(req);
    const path = join(this.dir, `img_${n}.png`);
    await makeImage(path, { width: req.width, height: req.height, color: COLORS[n % COLORS.length] });
    return { url: pathToFileURL(path).href, seed: 1000 + n };
  }
}

/** Every call renders a differently tinted clip, so last-frame hashes change on regeneration (like a real API). */
export class FakeVideo implements VideoProvider {
  calls: VideoRequest[] = [];
  failWhen?: (req: VideoRequest) => boolean;
  constructor(private readonly dir: string) {}
  async imageToVideo(req: VideoRequest) {
    const n = this.calls.push(req);
    if (this.failWhen?.(req)) throw new Error("fake video failure");
    const path = join(this.dir, `vid_${n}.mp4`);
    await makeVideo(path, { seconds: req.durationSec, fps: 24, width: 180, height: 320, hue: (n * 47) % 360 });
    return { url: pathToFileURL(path).href };
  }
}
