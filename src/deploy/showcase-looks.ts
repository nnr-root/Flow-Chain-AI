import type { Manifest } from "../manifest/schema.js";
import type { RenderProps } from "../media/remotion/props.js";
import type { RenderPropsOptions } from "../stages/build-render-props.js";
import { previewProps } from "../studio/props.js";

/*
 * Every look a visitor can give a showcase video on the landing page (Phase 4 spec §6), worked out here, when
 * the video is published, by the same function the studio's preview and `rerender` use. The page then only
 * chooses among them: nothing about captions, cuts or sounds is computed a second time in the browser.
 */

/** "preset" and "auto" are the run's own defaults: the style preset's captions, the cuts the script suggests. */
export const CAPTION_CHOICES = ["preset", "hormozi", "mrbeast", "minimalist"] as const;
export const CUT_CHOICES = ["auto", "cut", "fade", "dissolve", "blur", "zoom", "glitch"] as const;
export type CaptionChoice = (typeof CAPTION_CHOICES)[number];
export type CutChoice = (typeof CUT_CHOICES)[number];

export type Looks = {
  /** How the video was made: where the controls start. */
  made: { captions: CaptionChoice; cuts: CutChoice; hook: boolean; sfx: boolean };
  /** The captions in each style; `branded` where the video has a brand, whose font and colours they take. */
  captions: Record<CaptionChoice, { plain: RenderProps["captions"]; branded?: RenderProps["captions"] }>;
  /** The cuts with each transition, and the sounds that go with them, with and without the hook's impact. */
  cuts: Record<CutChoice, { boundaries: RenderProps["boundaries"]; sfx: { hook: RenderProps["audio"]["sfx"]; plain: RenderProps["audio"]["sfx"] } }>;
  /** The hook as it shows when on (its text can be replaced); null when the script has none. */
  hook: RenderProps["hook"];
  brand: RenderProps["brand"];
  bgm: RenderProps["audio"]["bgm"];
};

export type ShowcaseLooks = {
  /** The video as it was made. */
  props: RenderProps;
  looks: Looks;
  /** Every file any of the looks names: published path → source file. */
  files: Record<string, string>;
};

export function looksOf(m: Manifest, opts: RenderPropsOptions): ShowcaseLooks {
  const files: Record<string, string> = {};
  const look = (flags: Parameters<typeof previewProps>[2]): RenderProps => {
    const made = previewProps(m, opts, flags);
    Object.assign(files, made.files);
    return made.props;
  };
  const base = look({});
  const render = m.request.render;
  const hasBrand = !!render.brand;

  const captions = {} as Looks["captions"];
  for (const style of CAPTION_CHOICES) {
    captions[style] = hasBrand
      ? { branded: look({ captionStyle: style }).captions, plain: look({ captionStyle: style, brand: null }).captions }
      : { plain: look({ captionStyle: style }).captions };
  }
  const cuts = {} as Looks["cuts"];
  for (const transition of CUT_CHOICES) {
    const withHook = look({ transition, sfx: true, hookOn: true });
    cuts[transition] = { boundaries: withHook.boundaries, sfx: { hook: withHook.audio.sfx, plain: look({ transition, sfx: true, hook: false }).audio.sfx } };
  }
  const shown = look({ hookOn: true });
  return {
    props: base,
    looks: {
      made: {
        captions: CAPTION_CHOICES.includes(render.captionStyle as CaptionChoice) ? (render.captionStyle as CaptionChoice) : "preset",
        cuts: CUT_CHOICES.includes(render.transition as CutChoice) ? (render.transition as CutChoice) : "auto",
        hook: base.hook !== null,
        sfx: render.sfx,
      },
      captions, cuts, hook: shown.hook, brand: base.brand, bgm: base.audio.bgm,
    },
    files,
  };
}
