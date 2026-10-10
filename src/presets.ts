import { z } from "zod";
import type { CaptionStyle } from "./media/remotion/props.js";
import { CAPTION_STYLES } from "./media/remotion/styles.js";

export const PresetName = z.enum([
  "cinematic_history", "anime", "cyberpunk", "dark_fantasy", "photorealistic_8k", "3d_render",
  "cartoon", "comic_book", "watercolor", "pixel_art", "film_noir", "flat_illustration", "epic_fantasy", "claymation",
]);
export type PresetName = z.infer<typeof PresetName>;

/**
 * A complete look: the words wrapped around every picture and motion prompt, and the caption style.
 *
 * How the words are chosen (phase 2.2 spec §12):
 * - They say how a picture is made — the medium, the line, the light, the colour, the finish — and never what
 *   is in it. The picture model draws what it reads: a prefix that named candles put candles on a cliff edge,
 *   and one that names a street or rain would put them in a kitchen (phase 5 spec §9.12). What is in the frame
 *   is the script's to say, scene by scene.
 * - The medium comes first, in the prefix, because the first words weigh most; the suffix finishes the look.
 * - They say what is wanted, not what is not: the picture model takes no negative prompt, and "no outlines"
 *   reads to it as outlines.
 * - The motion words say how things move and what the camera does. For a drawn look they also say that the
 *   picture stays drawn: a clip model left alone turns flat drawings into something half real within a second.
 * - Never a named studio, artist or product.
 */
export type StylePreset = {
  name: PresetName;
  /** What a person is shown in place of the name. */
  label: string;
  /** One line telling the script model (and the person choosing) when the preset fits. */
  description: string;
  /** Replaces the script's styleBible.artStyle. */
  artStyle: string;
  /** Replaces the script's styleBible.palette, for a look that is a palette (a black-and-white film, neon). */
  palette?: string;
  imagePrefix: string;
  imageSuffix: string;
  motionKeywords: string;
  caption: CaptionStyle;
};

const CINZEL = { family: "Cinzel", file: "Cinzel-Variable.ttf", weight: 700 };
const BANGERS = { family: "Bangers", file: "Bangers-Regular.ttf", weight: 400 };
const ORBITRON = { family: "Orbitron", file: "Orbitron-Variable.ttf", weight: 700 };

export const PRESETS: Record<PresetName, StylePreset> = {
  cinematic_history: {
    name: "cinematic_history",
    label: "Cinematic history",
    description: "historical events and figures, wars, empires, documentary drama",
    artStyle: "cinematic 35mm film still, natural light, period-accurate details, muted earth tones",
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
    label: "Anime",
    description: "character-driven stories, feelings, friendship, rivalry and coming of age",
    artStyle: "2D anime illustration, cel shading, clean line art, hand-painted backgrounds, vibrant colours",
    imagePrefix: "2D anime illustration, cel-shaded with flat colour fills, clean confident line art, hand-painted background",
    imageSuffix: "Vibrant saturated colours, crisp two-tone shadows, dramatic rim light, sharp and expressive",
    motionKeywords: "2D anime animation, the drawing stays flat and cel-shaded, expressive motion, smooth camera",
    caption: {
      font: BANGERS,
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
    label: "Cyberpunk",
    description: "technology, the future, AI, hacking, robots and science fiction",
    artStyle: "cyberpunk science-fiction film still, neon light in teal and magenta, deep shadows, glossy reflections, high contrast",
    palette: "teal, magenta, electric blue, near-black",
    imagePrefix: "Cyberpunk science-fiction film still, lit by neon light in teal and magenta, deep shadows, glossy reflections",
    imageSuffix: "Hazy volumetric light, high contrast, sharp detail, moody futuristic atmosphere",
    motionKeywords: "Moody futuristic atmosphere, neon light glints and shifts across surfaces, slow gliding camera",
    caption: {
      font: ORBITRON,
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
    label: "Dark fantasy",
    description: "horror, curses, monsters, dark mysteries and the supernatural",
    artStyle: "gothic dark fantasy oil painting, low warm light against deep shadow, crimson accents",
    imagePrefix: "Gothic dark fantasy oil painting, low warm light against deep shadow, rich visible brushwork",
    imageSuffix: "Crimson accents, ominous atmosphere, dramatic chiaroscuro, high detail",
    motionKeywords: "Slow ominous motion, the light flickers, slow creeping camera",
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
    label: "Photoreal",
    description: "nature, science, travel, food, health and real-world explainers",
    artStyle: "photorealistic photograph, shot on a full-frame camera, natural light, true-to-life colour",
    imagePrefix: "Photorealistic photograph, shot on a full-frame camera, natural light",
    imageSuffix: "True-to-life colour, ultra sharp, fine detail, realistic textures",
    motionKeywords: "Realistic natural motion, smooth handheld camera",
    caption: CAPTION_STYLES.minimalist,
  },
  "3d_render": {
    name: "3d_render",
    label: "3D animation",
    description: "how things work, products, inventions and light-hearted facts",
    artStyle: "stylized 3D animation still, soft global illumination, smooth rounded shapes, playful colours",
    imagePrefix: "Stylized 3D animation still, soft global illumination, smooth rounded shapes, polished materials",
    imageSuffix: "Playful bright colours, soft shadows, shallow depth of field, clean composition",
    motionKeywords: "Smooth 3D animation, bouncy playful motion that eases in and out, gentle camera",
    caption: { ...CAPTION_STYLES.hormozi, activeColor: "#FF9F1C", activeAnim: "pop" },
  },
  cartoon: {
    name: "cartoon",
    label: "Cartoon",
    description: "comedy, everyday life, fun facts, kids' topics and anything light and funny",
    artStyle: "2D cartoon, bold black outlines, flat bright colours, simple rounded shapes, exaggerated expressions",
    imagePrefix: "2D cartoon illustration, bold even black outlines, flat bright colour fills, simple rounded shapes",
    imageSuffix: "Exaggerated expressive poses, simple uncluttered background, cheerful saturated colours, clean and readable",
    motionKeywords: "2D cartoon animation, snappy exaggerated motion with squash and stretch, the drawing stays flat with bold outlines, steady camera",
    caption: { ...CAPTION_STYLES.mrbeast, activeColor: "#FFD23F" },
  },
  comic_book: {
    name: "comic_book",
    label: "Comic book",
    description: "heroes and villains, action, crime, sport rivalries and dramatic true stories",
    artStyle: "comic book illustration, heavy black inking, halftone dot shading, bold primary colours, dynamic angles",
    imagePrefix: "Comic book illustration filling the whole frame, heavy black ink lines, halftone dot shading, bold flat primary colours",
    imageSuffix: "Dramatic tilted camera angle, strong contrast, dynamic composition, crisp printed texture",
    motionKeywords: "The picture stays an inked comic illustration, punchy dynamic motion, quick camera push",
    caption: {
      font: BANGERS,
      textCase: "upper",
      sizePctOfShortSide: 8.5,
      color: "#FFFFFF",
      activeColor: "#FFE500",
      inactiveOpacity: 1,
      stroke: { color: "#000000", pctOfSize: 20 },
      shadow: "0 6px 0 rgba(0,0,0,0.85)",
      maxWordsPerPage: 2,
      activeAnim: "pop",
    },
  },
  watercolor: {
    name: "watercolor",
    label: "Watercolour storybook",
    description: "fables, bedtime stories, animals, seasons and gentle or nostalgic topics",
    artStyle: "watercolour storybook illustration, soft translucent washes, delicate pencil outlines, paper texture, gentle pastel colours",
    imagePrefix: "Watercolour storybook illustration, soft translucent washes, delicate pencil outlines, visible paper texture",
    imageSuffix: "Gentle pastel colours, soft diffused light, loose painterly edges, calm and warm",
    motionKeywords: "Gentle slow motion, the picture stays a soft watercolour painting, slow drifting camera",
    caption: { ...CAPTION_STYLES.minimalist, activeColor: "#FFE1A8", inactiveOpacity: 0.7 },
  },
  pixel_art: {
    name: "pixel_art",
    label: "Pixel art",
    description: "video games, retro technology, internet culture and nostalgic countdowns",
    artStyle: "16-bit pixel art, large crisp square pixels, limited colour palette, flat shading with dithering",
    imagePrefix: "16-bit pixel art, large crisp square pixels, limited colour palette, flat shading with dithering",
    imageSuffix: "Clear readable silhouettes, hard pixel edges, retro video game look",
    motionKeywords: "Retro video game animation, simple motion in few frames, the pixels stay crisp and square, slow sideways camera pan",
    caption: {
      font: ORBITRON,
      textCase: "upper",
      sizePctOfShortSide: 6.5,
      color: "#FFFFFF",
      activeColor: "#7CFF4F",
      inactiveOpacity: 1,
      stroke: { color: "#000000", pctOfSize: 14 },
      shadow: "0 5px 0 rgba(0,0,0,0.9)",
      maxWordsPerPage: 3,
      activeAnim: "none",
    },
  },
  film_noir: {
    name: "film_noir",
    label: "Film noir",
    description: "true crime, detectives, spies, scandals, heists and unsolved cases",
    artStyle: "black-and-white film noir still, hard low-key light, long deep shadows, high contrast, film grain",
    palette: "black, white, silver grey",
    imagePrefix: "Black-and-white film noir still, hard low-key light, long deep shadows, strong contrast",
    imageSuffix: "Monochrome silver-grey tones, dramatic side light, visible film grain, tense atmosphere",
    motionKeywords: "Black-and-white footage, slow deliberate motion, the shadows shift, slow creeping camera",
    caption: {
      font: CINZEL,
      textCase: "upper",
      sizePctOfShortSide: 6.5,
      color: "#F2F2F2",
      activeColor: "#D9B44A",
      inactiveOpacity: 0.8,
      stroke: { color: "#000000", pctOfSize: 12 },
      shadow: "0 4px 16px rgba(0,0,0,0.7)",
      maxWordsPerPage: 3,
      activeAnim: "fade",
    },
  },
  flat_illustration: {
    name: "flat_illustration",
    label: "Flat illustration",
    description: "business, money, productivity, psychology, how-to guides and step-by-step explainers",
    artStyle: "flat vector illustration, simple geometric shapes in solid colour, minimal detail, generous empty space",
    imagePrefix: "Flat vector illustration, simple geometric shapes defined by solid colour alone, minimal detail",
    imageSuffix: "Limited harmonious colours, even soft light, generous empty space, clean modern composition",
    motionKeywords: "Clean motion-graphics animation, shapes glide and ease in and out, the colours stay flat, steady camera",
    caption: { ...CAPTION_STYLES.hormozi, activeColor: "#5EEAD4" },
  },
  epic_fantasy: {
    name: "epic_fantasy",
    label: "Epic fantasy",
    description: "myths, legends, gods, quests, ancient worlds and heroic tales",
    artStyle: "epic fantasy concept art, painterly digital painting, grand scale, luminous golden light, rich jewel colours",
    imagePrefix: "Epic fantasy concept art, painterly digital painting, grand sense of scale, luminous golden light",
    imageSuffix: "Rich jewel colours, atmospheric depth, sweeping composition, intricate detail",
    motionKeywords: "Majestic slow motion, the light shifts gently, sweeping cinematic camera",
    caption: {
      font: CINZEL,
      textCase: "upper",
      sizePctOfShortSide: 6.5,
      color: "#FFFFFF",
      activeColor: "#F5C542",
      inactiveOpacity: 1,
      stroke: { color: "#000000", pctOfSize: 12 },
      shadow: "0 4px 16px rgba(0,0,0,0.6)",
      maxWordsPerPage: 3,
      activeAnim: "none",
    },
  },
  claymation: {
    name: "claymation",
    label: "Claymation",
    description: "quirky facts, food, pets, crafts, cosy humour and odd little stories",
    artStyle: "stop-motion claymation, everything hand-sculpted from modelling clay, handmade miniature look, soft studio light",
    imagePrefix: "Stop-motion claymation still, everything hand-sculpted from modelling clay with visible fingerprints, handmade miniature look",
    imageSuffix: "Soft warm studio light, shallow depth of field, tactile handmade textures, charming and slightly imperfect",
    motionKeywords: "Stop-motion animation with a slightly uneven handmade rhythm, the clay stays solid and sculpted, steady camera",
    caption: { ...CAPTION_STYLES.mrbeast, activeColor: "#FF9F1C" },
  },
};
