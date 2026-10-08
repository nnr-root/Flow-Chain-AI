import type { RenderProps } from "@src/media/remotion/props";
import type { CaptionChoice, CutChoice, Looks } from "@src/deploy/showcase-looks";

/* What the landing page's controls do to a showcase video (Phase 4 spec §6). No imports that run: it is used in the browser. */

export type Controls = {
  captions: CaptionChoice;
  cuts: CutChoice;
  hook: boolean;
  /** Empty = the title the script wrote. */
  hookText: string;
  brand: boolean;
  music: boolean;
  sfx: boolean;
};

/** The controls as the video was made. */
export function madeControls(looks: Looks): Controls {
  return { captions: looks.made.captions, cuts: looks.made.cuts, hook: looks.made.hook, hookText: "", brand: looks.brand !== null, music: looks.bgm !== null, sfx: looks.made.sfx };
}

/**
 * The player's props for a choice of controls. Everything is chosen from what was worked out when the video was
 * published (by the pipeline's own functions); the one thing made here is the hook's text, which is the
 * visitor's to type.
 */
export function restyle(base: RenderProps, looks: Looks, c: Controls): RenderProps {
  const text = c.hookText.trim();
  const hook = c.hook && looks.hook ? { ...looks.hook, text: text === "" ? looks.hook.text : text } : null;
  const brand = c.brand ? looks.brand : null;
  const captions = looks.captions[c.captions];
  const cut = looks.cuts[c.cuts];
  return {
    ...base,
    captions: (brand && captions.branded) || captions.plain,
    boundaries: cut.boundaries,
    hook,
    brand,
    audio: { ...base.audio, bgm: c.music ? looks.bgm : null, sfx: c.sfx ? (hook ? cut.sfx.hook : cut.sfx.plain) : [] },
  };
}

/**
 * Where a published file is fetched from. The bundled caption fonts and sound effects are the same for every
 * video and are kept once (`shared`); everything else is the video's own.
 */
export function mediaUrl(slug: string, shared: readonly string[], path: string): string {
  return shared.includes(path) ? `/showcase/_shared/${path}` : `/showcase/${slug}/${path}`;
}
