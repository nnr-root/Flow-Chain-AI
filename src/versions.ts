import { cp, mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { AUDIENCE } from "./culture.js";
import { wordsPerSecond } from "./duration.js";
import type { Manifest, RunRequest, SceneState, StageName } from "./manifest/schema.js";
import { needsKeyframe } from "./stages/visual.js";
import { LANGUAGE_IN_ENGLISH, type SpeechLanguage } from "./voice/language.js";

/*
 * A version of a video in another language (phase 8 spec §4): a new run that keeps every picture and clip of the
 * run it is made from, and has its own narration, voice, captions and render. It buys the translation and the voice;
 * what the pictures and clips cost was paid by the source.
 */

/**
 * The stages a version has from its source and never buys. Their usual inputs follow the scenes' lengths, which a
 * version's narration changes: keyed on them, every clip would be bought again. They are keyed on the source and
 * their files instead (`inheritedInputs`), and refuse to run.
 */
export const INHERITED: readonly StageName[] = ["modes", "reference", "keyframes", "clips"];

export const isInherited = (m: Manifest, stage: StageName): boolean => m.request.versionOf !== undefined && INHERITED.includes(stage);

/** Why a run cannot have a version in `language`, or null. */
export function versionProblem(source: Manifest, language: SpeechLanguage): string | null {
  const r = source.request;
  if (r.versionOf) return `run ${source.runId} is itself a version of ${r.versionOf.runId}: make the version from that one`;
  // (its pictures belong to one culture: a video in several languages is never made for one, spec §5)
  if (r.localize) return `run ${source.runId} was made for viewers in ${AUDIENCE[r.language!] ?? r.language}; a video to be made in other languages is made without that (--no-localize)`;
  if (r.language === language) return `run ${source.runId} is already in ${LANGUAGE_IN_ENGLISH[language]}`;
  if (!source.script) return `run ${source.runId} has no script yet`;
  const unmade = source.scenes.some((s) => !s.audio || (s.mode === 1 && !s.clip) || (needsKeyframe(source, s.idx) && !s.keyframe));
  if (unmade) return `run ${source.runId} is not made yet: its pictures and clips are what a version is made of`;
  return null;
}

/**
 * What a version is given of its source's folder: the pictures (the portrait among them), the clips, and a brand's
 * files. Nothing else: what was made from the source's narration is made anew in the version's language, and a
 * job's own files (its record, its log) are the folder's owner's, never copied into another run.
 */
const KEPT = ["images", "clips", "brand"];

export async function copySourceFiles(sourceDir: string, dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  for (const entry of await readdir(sourceDir)) {
    if (KEPT.includes(entry)) await cp(join(sourceDir, entry), join(dir, entry), { recursive: true });
  }
}

/**
 * What a version holds of its owner's credit, from its plan: the translation as if it were sent back once and bought
 * again (an answer is paid for either way), and the voice with half again for a language that takes more letters to
 * say the same. What is not spent comes back when the job is settled.
 */
export function versionCapUsd(items: ReadonlyArray<{ stage: StageName; costUsd: number }>): number {
  const script = items.filter((i) => i.stage === "script").reduce((sum, i) => sum + i.costUsd, 0);
  const rest = items.filter((i) => i.stage !== "script").reduce((sum, i) => sum + i.costUsd, 0);
  return Math.round((2 * script + 1.5 * rest + 0.005) * 10_000) / 10_000;
}

export type VersionOptions = { runId: string; language: SpeechLanguage; voiceId: string; ttsModel: string; llmModel: string; now?: Date };

/**
 * A version's manifest (pure): the source's request in the new language and voice, its scenes with their modes,
 * pictures and clips, and nothing that was made from the narration. Its inherited stages are recorded as done,
 * for nothing, once their files are in place (`sealInherited` in the pipeline).
 */
export function versionManifest(source: Manifest, o: VersionOptions): Manifest {
  const s = source.request;
  const { hookText: _theirs, ...render } = s.render;
  const request: RunRequest = {
    ...s,
    language: o.language,
    voiceId: o.voiceId,
    // the words a second its narration is written to, frozen now as every new run's is (phase 7 spec §20)
    wordsPerSecond: wordsPerSecond(o.language, o.voiceId),
    silence: 2,
    localize: false,
    // a title the source's owner typed is in the source's language: the version's hook is translated
    render,
    versionOf: {
      runId: source.runId,
      ...(s.language ? { language: s.language } : {}),
      title: source.script!.title,
      hook: source.script!.hook ?? "",
      narrations: source.script!.scenes.map((x) => x.narration),
      seconds: source.scenes.map((x) => x.audio!.duration),
    },
  };
  const scenes: SceneState[] = source.scenes.map((x) => ({
    idx: x.idx,
    mode: x.mode,
    ...(x.modeReason ? { modeReason: x.modeReason } : {}),
    nonces: {},
    stages: {},
    jobs: {},
    ...(x.keyframe ? { keyframe: x.keyframe } : {}),
    ...(x.clip ? { clip: x.clip } : {}),
  }));
  return {
    schemaVersion: source.schemaVersion,
    runId: o.runId,
    createdAt: (o.now ?? new Date()).toISOString(),
    request,
    models: { ...source.models, llm: o.llmModel, tts: o.ttsModel },
    // the source's script until the translation replaces what is said in it: its pictures' words stay
    script: structuredClone(source.script!),
    runStages: {},
    scenes,
    ledger: [],
  };
}
