import { readFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { ActionLevel, Camera, SuggestedTransition } from "../../src/manifest/schema.js";
import type { PresetName } from "../../src/presets.js";
import { UnusableResultError } from "../../src/providers/retry.js";
import type {
  ImageOutput, ImageProvider, ImageRequest, InspectRequest, LlmProvider, PreparedJob, ScriptRequest, SpeakRequest, SubmitOptions, UpscaleProvider, UpscaleRequest,
  TtsProvider, VideoOutput, VideoProvider, VideoRequest, WaitOptions,
} from "../../src/providers/types.js";
import { ffmpeg, probeVideo } from "../../src/media/ffmpeg.js";
import { makeAudio, makeImage, makeVideo } from "../helpers/media.js";

export type Shot = "continue" | "cut";

export type FakeScriptOptions = {
  characterKind?: "people" | "animal" | "other" | "none";
  shots?: Shot[];
  cameras?: Camera[];
  actionLevels?: ActionLevel[];
  transitions?: SuggestedTransition[];
  stylePreset?: PresetName;
  hook?: string;
  /** Which scenes have the character in frame; all of them unless said. */
  shown?: boolean[];
};

export function fakeScript(sceneCount: number, opts: FakeScriptOptions = {}) {
  return {
    title: "Fake run",
    stylePreset: opts.stylePreset ?? "cinematic_history",
    hook: opts.hook ?? "Foxes never sleep",
    hashtags: ["#wildlife", "#foxes", "#redfox", "#nightanimals", "#animalfacts"],
    // ("people", so the stand-in's character is drawn from a portrait as every earlier test expects)
    styleBible: { artStyle: "flat test pattern", characters: "a red fox", palette: "teal, orange", setting: "a snowy forest at night, the present day", characterKind: opts.characterKind ?? "people" },
    scenes: Array.from({ length: sceneCount }, (_, i) => ({
      narration: `Scene ${i + 1} says hello. Then it pauses and continues.`,
      imagePrompt: `image ${i + 1}`,
      motionPrompt: `motion ${i + 1}`,
      shot: opts.shots?.[i] ?? (i === 0 ? "cut" : "continue"),
      camera: opts.cameras?.[i] ?? "zoom_in",
      actionLevel: opts.actionLevels?.[i] ?? "high",
      suggestedTransition: opts.transitions?.[i] ?? "fade",
      showsCharacter: opts.shown?.[i] ?? true,
    })),
  };
}

/** `count` words. */
export const words = (count: number, word = "fox"): string => Array.from({ length: count }, () => word).join(" ");

/** A version's translation (phase 8 spec §4): each scene's line as long as its seconds hold at the asked rate. */
export function fakeTranslation(req: ScriptRequest) {
  if (req.ask?.kind !== "translate") throw new Error("not a translation");
  const rate = req.wordsPerSecond ?? 2.4;
  return {
    title: "Fake version",
    hook: "Füchse schlafen nie",
    narrations: req.ask.seconds.map((sec) => words(Math.max(1, Math.round(sec * rate)), "fuchs")),
    hashtags: ["#tiere", "#fuchs", "#rotfuchs", "#nachttiere", "#tierwissen"],
  };
}

/** A script whose scenes have the narrations given by their word counts (for a run asked for by its length). */
export function timedScript(wordCounts: number[], opts: FakeScriptOptions = {}) {
  const script = fakeScript(wordCounts.length, opts);
  script.scenes.forEach((s, i) => (s.narration = words(wordCounts[i])));
  return script;
}

export class FakeLlm implements LlmProvider {
  promptVersion?: string;
  calls: ScriptRequest[] = [];
  /** The look at pictures (phase 8 spec §9): absent, like a provider without one, unless a test gives it. */
  inspect?: (req: InspectRequest) => Promise<unknown>;
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
 * Models fal's queue: `prepare` builds the request (free, counted in `prepares`), `submit` buys one job
 * (counted in `submits`; an already aborted signal rejects without buying), `wait` polls it (counted in `waits`).
 * Each job renders its output once, on its first successful wait, and later waits return the same URL.
 */
abstract class FakeQueue<Req, Out> {
  prepares: Req[] = [];
  submits: Req[] = [];
  waits: string[] = [];
  /** The `timeoutMs` each wait was asked for. */
  waitTimeouts: Array<number | undefined> = [];
  /** How long one wait may take, like RunPod's providers expose; absent = the stage's default. */
  waitMs?: number;
  /** How long a submit may take, like RunPod's providers expose; absent = the stage's default. */
  submitMs?: number;
  /** Makes every submit take this long before it answers, like a slow upload. */
  submitDelayMs = 0;
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

  async prepare(req: Req): Promise<PreparedJob> {
    this.prepares.push(req);
    return { input: { req } };
  }

  async submit(job: PreparedJob, opts: SubmitOptions): Promise<string> {
    const req = job.input.req as Req;
    if (opts.signal.aborted) throw opts.signal.reason;
    if (this.failSubmit?.(req)) throw new Error("fake submit failure");
    if (this.submitDelayMs > 0) {
      // like a real request: it ends early, with the abort's reason, when the caller gives up
      await new Promise<void>((done, fail) => {
        const timer = setTimeout(done, this.submitDelayMs);
        opts.signal.addEventListener("abort", () => {
          clearTimeout(timer);
          fail(opts.signal.reason);
        });
      });
    }
    const n = this.submits.push(req);
    return `req-${n}`;
  }

  async wait(requestId: string, opts?: WaitOptions): Promise<Out> {
    this.waits.push(requestId);
    this.waitTimeouts.push(opts?.timeoutMs);
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

/** Full HD (phase 8 spec §8): the clip it is given, scaled up to the short side asked for. */
export class FakeUpscale extends FakeQueue<UpscaleRequest, VideoOutput> implements UpscaleProvider {
  protected async render(req: UpscaleRequest, n: number, path: (name: string) => string) {
    const file = path(`hd_${n}.mp4`);
    const filters: string[] = [];
    if (req.short !== undefined) filters.push(`scale=-2:${req.short}`);
    // (a stand-in for RIFE: twice the frames a second, frames repeated; enough to test the pipeline)
    if (req.interpolate !== undefined) filters.push(`fps=${(await probeVideo(req.videoPath)).fps * req.interpolate}`);
    await ffmpeg(["-i", req.videoPath, ...(filters.length ? ["-vf", filters.join(",")] : []), "-pix_fmt", "yuv420p", file]);
    return { out: { url: pathToFileURL(file).href }, file };
  }
}
