import type { Manifest } from "../manifest/schema.js";
import type { CaptionStyle, Transition } from "../media/remotion/props.js";
import { CAPTION_STYLES } from "../media/remotion/styles.js";
import { PRESETS, type StylePreset } from "../presets.js";

/** The run's style preset: --style, else Gemini's pick; null only for runs scripted before 2.2. */
export function effectivePreset(m: Manifest): StylePreset | null {
  const name = m.request.style ?? m.script?.stylePreset;
  return name ? PRESETS[name] : null;
}

/** An explicit caption style wins; "preset" is the preset's look (hormozi when there is no preset). */
export function captionStyleFor(m: Manifest): CaptionStyle {
  const name = m.request.render.captionStyle;
  if (name !== "preset") return CAPTION_STYLES[name];
  return effectivePreset(m)?.caption ?? CAPTION_STYLES.hormozi;
}

/** The hook title's text: `--hook` text, else the script's hook; null when turned off or empty (no hook at all). */
export function hookTextFor(m: Manifest): string | null {
  if (!m.request.render.hook) return null;
  const text = (m.request.render.hookText ?? m.script?.hook ?? "").trim();
  return text === "" ? null : text;
}

/** The transition at the cut into scene k (seams are handled by the caller and are always hard cuts). */
export function transitionInto(m: Manifest, k: number): Transition {
  const option = m.request.render.transition;
  if (option !== "auto") return option;
  const suggested = m.script?.scenes[k]?.suggestedTransition;
  if (suggested === undefined) return "fade";
  return suggested === "zoom_transition" ? "zoom" : suggested;
}
