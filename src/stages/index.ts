import { captionsStage } from "./captions.js";
import { clipsStage } from "./clips.js";
import { fitStage } from "./fit.js";
import { keyframesStage } from "./keyframes.js";
import { modesStage } from "./modes.js";
import { renderStage } from "./render.js";
import { scriptStage } from "./script.js";
import { silenceStage } from "./silence.js";
import type { Stage } from "./types.js";
import { ttsStage } from "./tts.js";

/** Pipeline order. Audio stages come before any visual stage: audio drives timing (spec §3). */
export const STAGES: Stage[] = [
  scriptStage,
  ttsStage,
  silenceStage,
  modesStage,
  keyframesStage,
  clipsStage,
  fitStage,
  captionsStage,
  renderStage,
];
