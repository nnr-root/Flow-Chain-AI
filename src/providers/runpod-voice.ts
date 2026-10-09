import { z } from "zod";
import { WordTiming } from "../manifest/schema.js";
import { alignWords, heardShare } from "../voice/align.js";
import { NonRetryableError, UnusableResultError } from "./retry.js";
import type { RunpodClient, RunpodPolicy } from "./runpod.js";
import type { SpeakRequest, TtsProvider } from "./types.js";

/*
 * The studio's own voice (phase 5 spec §6.1): one line of a script to the voice worker, its speech and the
 * times of its words back. The speech comes inside the job's answer; nothing is stored anywhere on the way.
 */

export type VoiceDeps = {
  client: RunpodClient;
  /** GPU price per second of the voice endpoint. */
  usdPerSec: number;
  poll?: { pollMs?: number; sleep?: (ms: number) => Promise<void>; now?: () => number };
};

type Target = { endpointId: string; workflow: string; version: number };

const Answer = z.object({ audio: z.string().min(1), words: z.array(WordTiming), seconds: z.number().positive() });

/** One job may run two minutes (a line is seconds of work); it may wait an hour for a worker to start. */
const POLICY: RunpodPolicy = { executionTimeout: 120_000, ttl: 3_600_000 };
/** How long a line is waited for: long enough for a worker that has to start and load its models first. */
export const VOICE_WAIT_MS = 10 * 60_000;
/** Below this share of the script heard as written, the clip is taken to have gone wrong. */
const MIN_HEARD = 0.5;

const SEEDS = [42, 1337];

/** The clip was made and paid for, and is not the line. */
class Misspoken extends UnusableResultError {}

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class RunpodTts implements TtsProvider {
  constructor(
    private readonly deps: VoiceDeps,
    private readonly target: Target,
  ) {}

  /**
   * Speaks one line. The voice now and then says something other than it was given; speech that is not the
   * line is not used, and the line is asked for once more with another seed. What both tries cost is the cost.
   */
  async speak(req: SpeakRequest): Promise<{ audio: Buffer; words: WordTiming[]; costUsd?: number }> {
    let spent: number | undefined;
    const add = (usd: number | undefined) => {
      if (usd !== undefined) spent = Math.round(((spent ?? 0) + usd) * 10_000) / 10_000;
    };
    for (let attempt = 0; ; attempt++) {
      try {
        const got = await this.once(req, attempt);
        add(got.costUsd);
        return { audio: got.audio, words: got.words, ...(spent === undefined ? {} : { costUsd: spent }) };
      } catch (err) {
        if (!(err instanceof Misspoken)) throw err;
        add(err.costUsd);
        if (attempt >= 1) throw new UnusableResultError(err.message, spent);
      }
    }
  }

  private async once(req: SpeakRequest, attempt: number): Promise<{ audio: Buffer; words: WordTiming[]; costUsd?: number }> {
    const { pollMs = 2000, sleep = realSleep, now = Date.now } = this.deps.poll ?? {};
    const input = {
      task: "speak", workflow: `${this.target.workflow}@${this.target.version}`, text: req.text, voice: req.voiceId,
      ...(req.language ? { language: req.language } : {}),
      // the same line gives the same speech; a second try must not
      seed: SEEDS[attempt] ?? attempt,
    };
    const jobId = await this.deps.client.run(this.target.endpointId, input, POLICY, new AbortController().signal);
    const deadline = now() + VOICE_WAIT_MS;
    for (;;) {
      const job = await this.deps.client.status(this.target.endpointId, jobId);
      // A job that was bought is never bought again by the stage's retry: every way out from here on is final.
      if (job === null) throw new NonRetryableError(`voice job ${jobId} is no longer known to the endpoint`);
      const cost = typeof job.executionTime === "number" ? Math.round((job.executionTime / 1000) * this.deps.usdPerSec * 10_000) / 10_000 : undefined;
      if (job.status === "COMPLETED") {
        const refused = (job.output as { error?: unknown } | undefined)?.error;
        if (typeof refused === "string") throw new NonRetryableError(`the voice worker refused the line: ${refused}`);
        const answer = Answer.safeParse(job.output);
        if (!answer.success) throw new UnusableResultError(`voice job ${jobId} completed without speech`, cost);
        const { audio, words, seconds } = answer.data;
        if (heardShare(req.text, words) < MIN_HEARD) throw new Misspoken(`voice job ${jobId} did not speak the line it was given`, cost);
        return { audio: Buffer.from(audio, "base64"), words: alignWords(req.text, words, seconds), ...(cost === undefined ? {} : { costUsd: cost }) };
      }
      if (job.status === "FAILED" || job.status === "CANCELLED" || job.status === "TIMED_OUT") {
        throw new UnusableResultError(`voice job ${jobId} ${job.status.toLowerCase().replace("_", " ")}`, cost ?? 0);
      }
      if (now() >= deadline) throw new NonRetryableError(`voice job ${jobId} was not finished after ${VOICE_WAIT_MS / 60_000} minutes`);
      await sleep(pollMs);
    }
  }
}
