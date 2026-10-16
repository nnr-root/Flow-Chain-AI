/*
 * The words a person is shown for the names the pipeline uses. The names themselves (a caption style's, a
 * stage's, a job's) are what the CLI, the manifest and the API speak, and stay as they are: only what is on
 * screen changes here. The landing page's controls use the same words for the same things.
 */

export const CAPTION_LABELS: Record<string, string> = {
  preset: "Matched to the look",
  hormozi: "Punchy",
  mrbeast: "Playful",
  minimalist: "Quiet",
};

export const TRANSITION_LABELS: Record<string, string> = {
  auto: "As scripted",
  cut: "Hard cut",
  fade: "Fade",
  dissolve: "Dissolve",
  blur: "Blur",
  zoom: "Zoom",
  glitch: "Glitch",
};

/** A step of making a video, as the scene list, the spend table and a failure name it. */
export const STAGE_LABELS: Record<string, string> = {
  script: "Script",
  reference: "Character portrait",
  tts: "Voice",
  silence: "Pauses trimmed",
  modes: "Clip or still",
  keyframes: "Picture",
  clips: "Clip",
  upscale: "Full HD",
  fit: "Fitted to the voice",
  captions: "Captions",
  render: "Final cut",
};

/** What a job is doing, for "Working: …" and a place in the queue. */
export const JOB_LABELS: Record<string, string> = {
  draft: "writing the script",
  generate: "making the video",
  reroll: "remaking a scene",
  rerender: "cutting it again",
};

/** A name nobody gave a label is shown as it is, with its underscores as spaces: better than nothing, and it shows up in review. */
export const labelOf = (labels: Record<string, string>, name: string): string => labels[name] ?? name.replaceAll("_", " ");
