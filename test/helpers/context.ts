import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Prices } from "../../src/config.js";
import type { Mode } from "../../src/manifest/schema.js";
import { createManifest } from "../../src/manifest/store.js";
import type { StageContext } from "../../src/stages/types.js";
import { FakeImage, FakeLlm, FakeTts, FakeVideo, fakeScript, type Shot } from "../fakes/providers.js";
import { tempDir } from "./media.js";

export type TestContextOptions = {
  modes?: Mode[];
  shots?: Shot[];
  /** Overrides the LLM answer; receives the 1-based call number. */
  script?: (callNo: number) => unknown;
  bgm?: string;
};

/** A run in a temp dir with fake providers and small output sizes so media steps stay fast. */
export async function makeTestContext(opts: TestContextOptions = {}) {
  const modes = opts.modes ?? [1, 1];
  const dir = await tempDir("flowchain-run-");
  const fakesDir = join(dir, "_fakes");
  await mkdir(fakesDir);
  const fakes = {
    llm: new FakeLlm((req, callNo) =>
      opts.script ? opts.script(callNo) : fakeScript(req.sceneCount, { shots: opts.shots }),
    ),
    tts: new FakeTts(fakesDir),
    image: new FakeImage(fakesDir),
    video: new FakeVideo(fakesDir),
  };
  const manifest = createManifest(
    "test-run",
    { topic: "foxes", aspect: "9:16", sceneCount: modes.length, modes, voiceId: "voice-1", bgm: opts.bgm },
    { llm: "fake-llm", tts: "fake-tts", image: "fake-image", video: "fake-video" },
  );
  const logs: string[] = [];
  const ctx: StageContext = {
    dir,
    manifest,
    providers: fakes,
    prices: Prices.parse({}),
    size: { width: 180, height: 320 },
    keyframeSize: { width: 192, height: 336 },
    fps: 30,
    fontsDir: resolve("assets/fonts"),
    retryDelayMs: 0,
    log: (m) => logs.push(m),
  };
  return { ctx, fakes, logs, dir };
}
