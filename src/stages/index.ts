import { captionsStage } from "./captions.js";
import { clipsStage } from "./clips.js";
import { fitStage } from "./fit.js";
import { keyframesStage } from "./keyframes.js";
import { modesStage } from "./modes.js";
import { referenceStage } from "./reference.js";
import { renderStage } from "./render.js";
import { scriptStage } from "./script.js";
import { silenceStage } from "./silence.js";
import type { Stage } from "./types.js";
import { ttsStage } from "./tts.js";

/**
 * Pipeline order. Audio stages come before any visual stage: audio drives timing (spec §3). The portrait comes
 * straight before the keyframes that are conditioned on it: with the voice between them the picture worker had
 * stopped, and every run paid for two of its starts (phase 5 spec §9.12–9.13).
 */
export const STAGES: Stage[] = [
  scriptStage,
  ttsStage,
  silenceStage,
  modesStage,
  referenceStage,
  keyframesStage,
  clipsStage,
  fitStage,
  captionsStage,
  renderStage,
];
