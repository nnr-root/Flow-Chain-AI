import { describe, expect, it } from "vitest";
import { CAPTION_CHOICES, CUT_CHOICES, looksOf } from "@src/deploy/showcase-looks";
import type { Manifest } from "@src/manifest/schema";
import { previewProps } from "@src/studio/props";
import { type Controls, madeControls, mediaUrl, restyle } from "@/lib/site/restyle";
import { finishedManifest, nextRunId } from "./helpers";

/*
 * The landing page restyles a showcase video in the browser by choosing among looks worked out when it was
 * published. What it shows must be exactly what the studio's preview — and so a free re-render — would show
 * for the same choices: checked here for every combination, against the studio's own function.
 */
const opts = { dir: "/runs/x", fontsDir: "/assets/fonts", sfxDir: "/assets/sfx", fps: 30, size: { width: 1080, height: 1920 } };
const brandLook = { name: "Example", logo: "brand/logo.svg", watermark: { position: "top-right" as const, widthPct: 14, opacity: 0.8, marginPct: 4 }, colors: { text: "#FFFFFF", accent: "#22D3EE" } };

function run(with_: { brand: boolean; bgm: boolean }): Manifest {
  const m = finishedManifest(nextRunId());
  m.script!.hook = "Three seconds to midnight";
  if (with_.bgm) m.request.bgm = "/music/bed.mp3";
  if (with_.brand) m.request.render.brand = brandLook as Manifest["request"]["render"]["brand"];
  return m;
}

/** What the studio would show for these controls: the same flags `rerender` takes. */
function studioShows(m: Manifest, c: Controls) {
  const copy = structuredClone(m);
  if (!c.music) delete copy.request.bgm;
  return previewProps(copy, opts, {
    captionStyle: c.captions, transition: c.cuts, sfx: c.sfx,
    hook: c.hook ? (c.hookText.trim() === "" ? undefined : c.hookText.trim()) : false,
    ...(c.hook ? { hookOn: true } : {}),
    ...(c.brand ? {} : { brand: null }),
  }).props;
}

describe("restyling a showcase video on the landing page", () => {
  it.each([{ brand: false, bgm: true }, { brand: true, bgm: true }, { brand: true, bgm: false }])("shows what the studio would, for every choice of controls (%o)", (with_) => {
    const m = run(with_);
    const { props, looks } = looksOf(m, opts);
    let checked = 0;
    for (const captions of CAPTION_CHOICES) {
      for (const cuts of CUT_CHOICES) {
        for (const hook of [true, false]) {
          for (const sfx of [true, false]) {
            for (const brand of with_.brand ? [true, false] : [false]) {
              for (const music of with_.bgm ? [true, false] : [false]) {
                const c: Controls = { captions, cuts, hook, hookText: hook && cuts === "zoom" ? "  My own title " : "", brand, music, sfx };
                expect(restyle(props, looks, c), JSON.stringify(c)).toEqual(studioShows(m, c));
                checked++;
              }
            }
          }
        }
      }
    }
    expect(checked).toBe(4 * 7 * 2 * 2 * (with_.brand ? 2 : 1) * (with_.bgm ? 2 : 1));
  });

  it("starts as the video was made", () => {
    const m = run({ brand: true, bgm: true });
    m.request.render.captionStyle = "mrbeast";
    m.request.render.transition = "glitch";
    m.request.render.sfx = false;
    const { props, looks } = looksOf(m, opts);
    expect(madeControls(looks)).toEqual({ captions: "mrbeast", cuts: "glitch", hook: true, hookText: "", brand: true, music: true, sfx: false });
    expect(restyle(props, looks, madeControls(looks))).toEqual(props);
    // a video without a brand or music has nothing to switch on
    expect(madeControls(looksOf(run({ brand: false, bgm: false }), opts).looks)).toMatchObject({ brand: false, music: false });
  });

  it("names every file any look needs, and fetches the bundled ones from one place", () => {
    const { files } = looksOf(run({ brand: true, bgm: true }), opts);
    expect(Object.keys(files).sort()).toEqual([
      // (the fixture's style preset brings Cinzel; the three named styles bring theirs)
      "Cinzel-Variable.ttf", "Inter-SemiBold.ttf", "LuckiestGuy-Regular.ttf", "Montserrat-ExtraBold.ttf", "bgm.mp3", "brand/logo.svg",
      "fitted/scene_01.mp4", "fitted/scene_02.mp4", "images/keyframe_03.png", "narration.wav", "sfx/impact_boom.mp3", "sfx/pop.mp3", "sfx/whoosh.mp3",
    ]);
    const shared = ["Inter-SemiBold.ttf", "sfx/pop.mp3"];
    expect(mediaUrl("clockmaker", shared, "sfx/pop.mp3")).toBe("/showcase/_shared/sfx/pop.mp3");
    expect(mediaUrl("clockmaker", shared, "fitted/scene_01.mp4")).toBe("/showcase/clockmaker/fitted/scene_01.mp4");
  });
});
