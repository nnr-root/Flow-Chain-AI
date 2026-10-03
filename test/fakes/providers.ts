import { readFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Camera } from "../../src/manifest/schema.js";
import { UnusableResultError } from "../../src/providers/retry.js";
import type {
  ImageOutput, ImageProvider, ImageRequest, LlmProvider, ScriptRequest, SpeakRequest, TtsProvider, VideoOutput,
  VideoProvider, VideoRequest,
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

/**
 * Models fal's queue: `submit` buys one job (counted in `submits`), `wait` polls it (counted in `waits`).
 * Each job renders its output once, on its first successful wait, and later waits return the same URL.
 */
abstract class FakeQueue<Req, Out> {
  submits: Req[] = [];
  waits: string[] = [];
  /** Throw from submit (nothing is queued). */
  failSubmit?: (req: Req) => boolean;
  /** Throw while waiting; the job stays queued, like a timeout or a network error. */
  failWait?: (req: Req) => boolean;
  /** The job completes (and is billed) but its output is unusable, like an NSFW-flagged image. */
  unusable?: (req: Req) => boolean;
  /** The job completes, but its output is not downloadable until release(), like a CDN hiccup. */
  withhold?: (req: Req) => boolean;
  private readonly outputs = new Map<string, Out>();
  private withheld: Array<{ from: string; to: string }> = [];

  constructor(protected readonly dir: string) {}

  protected abstract render(req: Req, n: number, path: (name: string) => string): Promise<{ out: Out; file: string }>;

  async submit(req: Req): Promise<string> {
    if (this.failSubmit?.(req)) throw new Error("fake submit failure");
    const n = this.submits.push(req);
    return `req-${n}`;
  }

  async wait(requestId: string): Promise<Out> {
    this.waits.push(requestId);
    const n = Number(requestId.replace("req-", ""));
    const req = this.submits[n - 1];
    if (req === undefined) throw new Error(`unknown request ${requestId}`);
    if (this.failWait?.(req)) throw new Error("fake wait failure");
    if (this.unusable?.(req)) throw new UnusableResultError(`fake request ${requestId} flagged NSFW`);
    const known = this.outputs.get(requestId);
    if (known) return known;
    const { out, file } = await this.render(req, n, (name) => join(this.dir, name));
    if (this.withhold?.(req)) {
      const hidden = `${file}.withheld`;
      await rename(file, hidden);
      this.withheld.push({ from: hidden, to: file });
    }
    this.outputs.set(requestId, out);
    return out;
  }

  /** Makes withheld outputs downloadable. */
  async release(): Promise<void> {
    for (const w of this.withheld) await rename(w.from, w.to);
    this.withheld = [];
    this.withhold = undefined;
  }
}

export class FakeImage extends FakeQueue<ImageRequest, ImageOutput> implements ImageProvider {
  protected async render(req: ImageRequest, n: number, path: (name: string) => string) {
    const file = path(`img_${n}.png`);
    await makeImage(file, { width: req.width, height: req.height, color: COLORS[n % COLORS.length] });
    return { out: { url: pathToFileURL(file).href, seed: 1000 + n }, file };
  }
}

/**
 * Every job renders a different clip, so hashes change on regeneration (like a real API). Frames are flat
 * grey levels that change every frame: x264 keeps them exact, so seam frames can be compared with frameDiff 0.
 */
export class FakeVideo extends FakeQueue<VideoRequest, VideoOutput> implements VideoProvider {
  protected async render(req: VideoRequest, n: number, path: (name: string) => string) {
    const file = path(`vid_${n}.mp4`);
    await makeVideo(file, { seconds: req.durationSec, fps: 24, width: 180, height: 320, flat: (n * 53) % 200 });
    return { out: { url: pathToFileURL(file).href }, file };
  }
}
