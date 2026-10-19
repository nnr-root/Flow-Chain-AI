import { FACT_RULES } from "./niches.js";

/*
 * The type of a video (phase 8 spec §2): how it is built, whatever it is about. A niche says what a channel is
 * about and holds it to the truth; a style says how the pictures are drawn; an edit says how they move and are cut;
 * a type says how the video is told: how it opens, the shape it takes, how the narrator delivers it. The four are
 * chosen apart and go together: a history channel makes a documentary one day and a top list the next.
 *
 * Where a niche and a type both speak, the type decides the hook, the shape and the delivery; the niche keeps the
 * subject, the tone and its rules, which always hold. Each type was taken from what the most watched faceless
 * shorts of its kind do (spec §2.1).
 *
 * Everything a model reads is in English. Pure data: read by the CLI, the script stage and the browser.
 */

export type VideoFormat = {
  id: string;
  /** What the form calls it. */
  label: string;
  /** What it is, in a few words, on the form. */
  about: string;
  /**
   * "fact": only for a video that tells what is so: a made-up story told as a documentary or a myth busted is a
   * lie told well. "any": a story niche may use it too.
   */
  goesWith: "fact" | "any";
  /**
   * Whether the script may mark a cut as a reframe (phase 10 spec §4): the same place and moment from a new view,
   * drawn from the previous picture. Told in a place the viewer stays in: yes; a list or an argument: no.
   */
  reframe: boolean;
  /** For the model: how the first line works. */
  hook: string;
  /** For the model: the shape of the video, from the hook to the last line. */
  arc: string;
  /** For the model: how the narrator delivers it. */
  delivery: string;
  /** For the model: what a video of this type must and must not do. */
  rules: readonly string[];
};

export const FORMATS: readonly VideoFormat[] = [
  {
    id: "documentary",
    label: "Documentary",
    about: "A real subject told in order, with its facts",
    goesWith: "fact",
    reframe: true,
    hook: "Open on the single most striking fact or moment of the subject, said plainly, with no question and no greeting.",
    arc: "Where and when it begins, what happened in order, the turning point, what it changed, and why it still matters, in the last line.",
    delivery: "Measured and serious, third person; concrete names, places and dates; one idea a scene, and room for it to land.",
    rules: [...FACT_RULES],
  },
  {
    id: "explainer",
    label: "Explainer",
    about: "How or why something works, step by step",
    goesWith: "fact",
    reframe: false,
    hook: "Open on the question the viewer has wondered about, or on the surprising fact that raises it.",
    arc: "The question, the everyday picture of it, how it works one step a scene (each step following from the last), one plain comparison that makes it click, and the last line answering the question in so many words.",
    delivery: "A clear, friendly teacher talking to one person; every term said in plain words the first time it is used.",
    rules: [...FACT_RULES, "Simplify without saying anything false: a comparison is called a comparison."],
  },
  {
    id: "story",
    label: "Story",
    about: "One person, one moment that matters, told as it happens",
    goesWith: "any",
    reframe: true,
    hook: "Open in the middle of the moment that matters, on what the person sees or does, in one sentence.",
    arc: "Who they are and what they want, what stands in the way, the turn nobody saw coming, how it ends, and in the last line what it meant.",
    delivery: "Past tense, scene by scene, concrete details over adjectives; the narrator shows what happened and does not explain it.",
    rules: ["In a niche of what is so, the story is a real, documented one and only what is known of it is told; nobody's thoughts are invented."],
  },
  {
    id: "countdown",
    label: "Top list",
    about: "A numbered list that counts down to number one",
    goesWith: "any",
    reframe: false,
    hook: "Say what the list is and how many there are, with the number in it (\"Five animals that should not exist.\").",
    arc: "From the least to the most striking: each item has its number said aloud at its start, is named, and is given the one reason it is on the list; the last is number one.",
    // (not "nothing between the items": every script is told it is one spoken piece, not a list read out)
    delivery: "Brisk; each item a fresh beat, its lines told as one piece; one short line carries the viewer from each item to the next number.",
    rules: [
      "Exactly the number of items the hook promised, each one different from the others. As many items as the length gives room for: about one for every two or three scenes.",
      "In a niche of what is so, every item is real and the reason given for it is true.",
      'Items from different times or places are each shown in their own: styleBible.setting begins "Several times and places:".',
    ],
  },
  {
    id: "motivational",
    label: "Motivational",
    about: "A short speech to the viewer, from a hard truth to one thing to do",
    goesWith: "any",
    reframe: false,
    hook: "A hard truth said straight to the viewer, in the second person.",
    arc: "The struggle the viewer knows, the turn in how to see it, one example (a real, documented one in a niche of what is so), and one small, concrete thing to do today.",
    delivery: "Direct and warm, building energy; short sentences; a line that returns, said again with more weight.",
    rules: [
      "Promise no money, health or success; say what effort can do, never what it guarantees.",
      "No shaming; nothing that tells someone who is struggling to push through instead of asking for help.",
    ],
  },
  {
    id: "myth-busting",
    label: "Myth vs fact",
    about: "A common belief, and what is actually so",
    goesWith: "fact",
    reframe: false,
    hook: "Say the myth the way most people believe it, as if it were true, then cut it short.",
    arc: "The myth, why so many believe it, what is actually so and how it is known, the true picture, which is stranger, and a one-line takeaway.",
    delivery: "Confident and curious; always clear which line is the myth and which is the fact.",
    rules: [...FACT_RULES, "The myth is a real, widespread belief, never one made up to be knocked down."],
  },
  {
    id: "versus",
    label: "Versus",
    about: "Two things face off, round by round",
    goesWith: "any",
    reframe: false,
    hook: "Put the matchup as a question (\"A crocodile against a shark: who wins?\").",
    arc: "Both sides introduced, then a round for each way they compare (size, speed, strength, or whatever matters here), one round a scene or two, then the verdict with its reason, or an honest \"it depends\" where there is none.",
    delivery: "A commentator's energy, fair to both sides; the score said as it goes.",
    rules: ["In a niche of what is so, every comparison rests on what is known; never pit real people against each other to mock either one."],
  },
  {
    id: "pov",
    label: "You are there",
    about: "The viewer is put in a time and a place, as it happens to them",
    goesWith: "any",
    reframe: true,
    hook: "Put the viewer there in the second person, present tense (\"You are a sailor on the Titanic, and it is 11:39 at night.\").",
    arc: "Arriving, what you see, hear and smell, what happens to you, the moment it turns, and how it ends for you.",
    delivery: "Second person, present tense, close and sensory; short sentences as the tension rises.",
    rules: ["In a niche of what is so, everything you meet is what was really there; nothing graphic."],
  },
];

export const FORMAT_IDS = FORMATS.map((f) => f.id) as [string, ...string[]];
export const formatById = (id: string | undefined): VideoFormat | undefined => FORMATS.find((f) => f.id === id);

/** Why a type and a niche cannot go together, or null: a type that tells what is so is not used to tell a story. */
export function formatClash(format: string | undefined, nicheKind: "fact" | "fiction" | undefined): string | null {
  const f = formatById(format);
  if (!f || f.goesWith === "any" || nicheKind !== "fiction") return null;
  return `"${f.label}" tells what is so, and this niche's videos are made-up stories`;
}
