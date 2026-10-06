import type { RunStatus } from "@src/studio/status";
import type { Look } from "@/server/schemas";

/** What the look controls hold; `brand` is "keep" (the run's current brand), "none" or a kit's slug. */
export type LookControls = {
  captionStyle: string;
  transition: string;
  hookOn: boolean;
  hookText: string;
  sfx: boolean;
  sfxGain: number;
  bgmGain: number;
  brand: string;
};

/** The controls as the run currently is. */
export function controlsOf(status: RunStatus): LookControls {
  const r = status.render;
  return {
    captionStyle: r.captionStyle,
    transition: r.transition,
    hookOn: r.hook,
    hookText: status.hook ?? r.hookText ?? "",
    sfx: r.sfx,
    sfxGain: r.sfxGain,
    bgmGain: r.bgmGain,
    brand: "keep",
  };
}

/** Only what differs from the run: the pending look, in the API's shape. An empty object means nothing to apply. */
export function pendingLook(status: RunStatus, c: LookControls): Look {
  const was = controlsOf(status);
  const look: Record<string, unknown> = {};
  if (c.captionStyle !== was.captionStyle) look.captionStyle = c.captionStyle;
  if (c.transition !== was.transition) look.transition = c.transition;
  const text = c.hookText.trim();
  if (!c.hookOn && was.hookOn) look.hook = false;
  else if (c.hookOn && text !== "" && text !== was.hookText) look.hook = text;
  else if (c.hookOn && !was.hookOn) look.hookOn = true;
  if (c.sfx !== was.sfx) look.sfx = c.sfx;
  if (c.sfxGain !== was.sfxGain) look.sfxGain = c.sfxGain;
  if (c.bgmGain !== was.bgmGain) look.bgmGain = c.bgmGain;
  if (c.brand === "none") {
    if (status.render.brand) look.brandKit = null;
  } else if (c.brand !== "keep") look.brandKit = c.brand;
  return look as Look;
}
