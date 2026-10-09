import { z } from "zod";
import type { CaptionStyle } from "./media/remotion/props.js";
import { CAPTION_STYLES } from "./media/remotion/styles.js";

export const PresetName = z.enum([
  "cinematic_history", "anime", "cyberpunk", "dark_fantasy", "photorealistic_8k", "3d_render",
]);
export type PresetName = z.infer<typeof PresetName>;

/**
 * A complete look: the words wrapped around every Flux and Kling prompt, and the caption style. Prompts
 * describe visual qualities only, never named studios, artists or products.
 */
export type StylePreset = {
  name: PresetName;
  /** One line telling Gemini when the preset fits. */
  description: string;
  /** Replaces the script's styleBible.artStyle. */
  artStyle: string;
  imagePrefix: string;
  imageSuffix: string;
  motionKeywords: string;
  caption: CaptionStyle;
};

const CINZEL = { family: "Cinzel", file: "Cinzel-Variable.ttf", weight: 700 };

export const PRESETS: Record<PresetName, StylePreset> = {
  cinematic_history: {
    name: "cinematic_history",
    description: "historical events and figures, documentary drama",
    artStyle: "cinematic 35mm film still, natural light, period-accurate costumes and props, muted earth tones",
    imagePrefix: "Cinematic 35mm film still, natural light, period-accurate details",
    imageSuffix: "Shallow depth of field, subtle film grain, muted earth tones, high detail",
    motionKeywords: "Slow, steady cinematic camera, natural motion, gentle film grain",
    caption: {
      font: CINZEL,
      textCase: "upper",
      sizePctOfShortSide: 6.5,
      color: "#FFFFFF",
      activeColor: "#E8C468",
      inactiveOpacity: 1,
      stroke: { color: "#000000", pctOfSize: 12 },
      shadow: "0 4px 16px rgba(0,0,0,0.6)",
      maxWordsPerPage: 3,
      activeAnim: "none",
    },
  },
  anime: {
    name: "anime",
    description: "stories, myths, adventure and anything playful or emotional",
    artStyle: "anime key visual, cel shading, clean line art, painted background, vibrant colours",
    imagePrefix: "Anime key visual, cel shading, clean confident line art, detailed painted background",
    imageSuffix: "Vibrant saturated colours, dramatic lighting, crisp and expressive",
    motionKeywords: "Anime-style animation, expressive character motion, dynamic camera",
    caption: {
      font: { family: "Bangers", file: "Bangers-Regular.ttf", weight: 400 },
      textCase: "upper",
      sizePctOfShortSide: 9,
      color: "#FFFFFF",
      activeColor: "#FF4FA3",
      inactiveOpacity: 1,
      stroke: { color: "#000000", pctOfSize: 18 },
      shadow: "0 6px 0 rgba(0,0,0,0.85)",
      maxWordsPerPage: 2,
      activeAnim: "pop",
    },
  },
  cyberpunk: {
    name: "cyberpunk",
    description: "technology, the future, AI, hacking and city nightlife",
    artStyle: "neon-lit cyberpunk night city, rain reflections, holographic signs, teal and magenta haze",
    imagePrefix: "Neon-lit futuristic night city, rain-slick streets with reflections, glowing holographic signs",
    imageSuffix: "Teal and magenta haze, volumetric light, high contrast, sharp detail",
    motionKeywords: "Moody neon-lit motion, drifting rain and haze, flickering signs",
    caption: {
      font: { family: "Orbitron", file: "Orbitron-Variable.ttf", weight: 700 },
      textCase: "upper",
      sizePctOfShortSide: 6.5,
      color: "#FFFFFF",
      activeColor: "#FF2BD6",
      inactiveOpacity: 1,
      stroke: { color: "#000000", pctOfSize: 8 },
      shadow: "0 0 12px rgba(0,229,255,0.9), 0 0 28px rgba(0,229,255,0.6)",
      maxWordsPerPage: 3,
      activeAnim: "none",
    },
  },
  dark_fantasy: {
    name: "dark_fantasy",
    description: "horror, legends, dark mysteries and the supernatural",
    artStyle: "gothic dark fantasy oil painting, candlelight and deep shadows, crimson accents",
    imagePrefix: "Gothic dark fantasy oil painting, candlelight and deep shadows, rich brushwork",
    imageSuffix: "Crimson accents, ominous atmosphere, dramatic chiaroscuro, high detail",
    motionKeywords: "Slow ominous motion, flickering candlelight, drifting mist",
    caption: {
      font: CINZEL,
      textCase: "upper",
      sizePctOfShortSide: 6.5,
      color: "#EDE6D6",
      activeColor: "#C0182B",
      inactiveOpacity: 0.75,
      stroke: { color: "#000000", pctOfSize: 12 },
      shadow: null,
      maxWordsPerPage: 3,
      activeAnim: "fade",
    },
  },
  photorealistic_8k: {
    name: "photorealistic_8k",
    description: "nature, science, travel, food and real-world explainers",
    artStyle: "photorealistic, shot on a full-frame camera, natural light, true-to-life colour",
    imagePrefix: "Photorealistic photograph, shot on a full-frame camera, natural light",
    imageSuffix: "True-to-life colour, ultra sharp, fine detail, realistic textures",
    motionKeywords: "Realistic natural motion, smooth handheld camera",
    caption: CAPTION_STYLES.minimalist,
  },
  "3d_render": {
    name: "3d_render",
    description: "kids' topics, products, how-things-work and light-hearted facts",
    artStyle: "stylized 3D render, soft global illumination, clay-like materials, playful colours",
    imagePrefix: "Stylized 3D render, soft global illumination, smooth clay-like materials",
    imageSuffix: "Playful bright colours, soft shadows, clean composition",
    motionKeywords: "Bouncy playful animation, smooth camera",
    caption: { ...CAPTION_STYLES.hormozi, activeColor: "#FF9F1C", activeAnim: "pop" },
  },
};
