import type { PresetName } from "./presets.js";
import type { VoiceId } from "./voice/language.js";

/*
 * The kinds of video a faceless channel is made of (phase 7 spec §19): a niche is chosen, or written by the user,
 * and the script is written as videos that hold their audience in it are written. Each niche here was taken apart
 * from what the most watched faceless shorts in it do (spec §19.1 has the sources): what the audience comes for,
 * how the first line stops the scroll, the shape of the story, the voice it is told in, and, above all, what a video
 * in it must not do: say what is not so, harm whoever it is about, or tell someone how to harm.
 *
 * Everything a model reads is in English (it follows rules best in English; the narration is still written in the
 * video's language). Pure data: read by the CLI, the script stage and the browser.
 *
 * Left out on purpose: health and medicine, religion, politics and news, and anything sold to children as advice.
 * There a short video that is wrong does harm, and no rule written here makes a model reliably right.
 */

export type Niche = {
  id: string;
  /** What the form calls it. */
  label: string;
  /** What its videos are, in a few words, on the form. */
  about: string;
  /** Topics to start from: the form offers them, and the model reads them as the kind of thing the niche is. */
  examples: readonly string[];
  /** Whether its videos tell what is so (and must be accurate), or a story that is made up (and must say so). */
  kind: "fact" | "fiction";
  /** For the model: what the audience comes for, and what each video promises them. */
  promise: string;
  /** For the model: how the first line works. */
  hook: string;
  /** For the model: the shape of the video, from the hook to the last line. */
  arc: string;
  /** For the model: how it is told. */
  voice: string;
  /** For the model: what a video in it must and must not do. */
  rules: readonly string[];
  /** The styles its videos are usually made in: a hint when the style is left to the script. */
  styles: readonly PresetName[];
  /** The studio's voices that suit it: shown on the form. */
  voices: readonly VoiceId[];
};

/** What every video that tells what is so keeps to, whatever its niche. */
export const FACT_RULES: readonly string[] = [
  "Say only what is well established and could be checked in a good encyclopedia or a reputable source. Do not invent numbers, dates, names, quotes or studies; leave out a detail you are not sure of rather than guess it.",
  "Where something is disputed, a legend or a theory, say so in the narration (\"the story goes\", \"one theory is\"), never as fact.",
  "Never put words in a real person's mouth, and say nothing about a real, living person that would harm them if it were wrong.",
];

/** What every made-up story keeps to. */
export const FICTION_RULES: readonly string[] = [
  "This is fiction: invent the people and places, never present it as something that really happened, and never name a real private person.",
  "Unsettle, do not disgust: no gore described, no cruelty to children or animals, nothing sexual.",
];

export const NICHES: readonly Niche[] = [
  {
    id: "scary-stories",
    label: "Scary stories",
    about: "Short original horror, told around a campfire",
    examples: ["The night shift at an empty hospital", "A voicemail from my own number", "The house that was never on the map"],
    kind: "fiction",
    promise: "A complete, original scary story that builds dread and ends on a twist or a final chill.",
    hook: "Open in the middle of something wrong, in first person, in one plain sentence (\"I still don't know who was knocking.\"). No title, no greeting.",
    arc: "Normal situation, one small wrong detail, the wrongness grows, a turn the listener did not see coming, a last line that lingers. Each scene raises the tension a step.",
    voice: "Quiet, intimate, first person, past tense; short sentences; let silence work. Concrete sounds and details over adjectives.",
    rules: [...FICTION_RULES, "The fear comes from what is suggested and not shown."],
    styles: ["dark_fantasy", "film_noir", "photorealistic_8k"],
    voices: ["mystery", "storyteller", "trailer"],
  },
  {
    id: "true-crime",
    label: "True crime",
    about: "Real cases, told carefully and with respect",
    examples: ["The heist nobody noticed for three days", "How one fingerprint solved a 30-year-old case", "The forger who fooled the art world"],
    kind: "fact",
    promise: "One real, well-documented case, told as a story with the facts straight.",
    hook: "Open on the most striking documented fact of the case, or the question it left (\"For 30 years, one fingerprint was the only clue.\").",
    arc: "The moment it happened, who and where, how it was investigated, the turning point, how it ended or why it is still open.",
    voice: "Serious, measured, investigative; respectful of victims; no jokes about harm.",
    rules: [
      ...FACT_RULES,
      "Choose cases that are well documented and long settled, or famous unsolved ones; prefer property crimes, frauds, escapes and investigations over violence.",
      "Never name anyone as guilty who was not convicted; never speculate about a living person. Do not describe violence or injuries in detail, and never make a victim the punchline.",
      "Do not explain how to commit a crime or evade detection.",
    ],
    styles: ["film_noir", "photorealistic_8k", "cinematic_history"],
    voices: ["documentary", "trailer", "anchor"],
  },
  {
    id: "history",
    label: "History",
    about: "Surprising true stories from the past",
    examples: ["The war that lasted 38 minutes", "Why Romans used urine to whiten teeth", "The emperor who declared war on the sea"],
    kind: "fact",
    promise: "One surprising true story or fact from history, with the context that makes it make sense.",
    hook: "Lead with the most surprising true detail, stated plainly (\"The shortest war in history lasted 38 minutes.\").",
    arc: "The surprising fact, the setting in a line or two, what happened step by step, the consequence or what it tells us today.",
    voice: "Vivid and dramatic but precise; present the past as scenes the viewer can picture.",
    rules: [...FACT_RULES, "Give a period or a year only when you are sure of it. Do not judge the past by slogans; let the facts carry it."],
    styles: ["cinematic_history", "watercolor", "photorealistic_8k"],
    voices: ["documentary", "storyteller", "narrator-m"],
  },
  {
    id: "mythology",
    label: "Myths and legends",
    about: "Gods, heroes and legends of the world's cultures",
    examples: ["Why Medusa was cursed", "The Norse wolf who will swallow the sun", "The Japanese legend of the red string"],
    kind: "fact",
    promise: "One myth or legend told as a gripping story, true to how the culture it comes from tells it.",
    hook: "Open on the moment of drama, or the strangest part of the myth (\"Medusa was not born a monster.\").",
    arc: "Who and where in the myth, what they wanted, what went wrong, the ending as the myth tells it, and what it meant to the people who told it.",
    voice: "Epic, storytelling, like an old tale told well.",
    rules: [
      ...FACT_RULES,
      "Tell myths as myths (\"in Greek myth\", \"the legend says\"), keep to the main versions, and say where versions differ.",
      "Treat every culture's beliefs with respect; never mock a living religion.",
    ],
    styles: ["epic_fantasy", "dark_fantasy", "watercolor"],
    voices: ["storyteller", "trailer", "documentary"],
  },
  {
    id: "did-you-know",
    label: "Did you know?",
    about: "Quick, surprising facts about everyday things",
    examples: ["Why airplane windows are round", "The fruit that is technically a berry", "What happens to the gum you swallow"],
    kind: "fact",
    promise: "One surprising, true fact and the simple reason behind it.",
    hook: "State the surprising fact or ask the question everyone has wondered, in the first line.",
    arc: "The fact or the question, the reason in plain words, one extra detail that makes it stick, a quick closing line.",
    voice: "Casual, quick and curious, as if telling a friend.",
    rules: [...FACT_RULES, "Pick facts that are true as stated, not myths dressed as facts (\"we only use 10% of our brain\" is a myth)."],
    styles: ["3d_render", "flat_illustration", "cartoon"],
    voices: ["host", "upbeat", "explainer"],
  },
  {
    id: "space-science",
    label: "Space and science",
    about: "The universe, physics and big questions, made clear",
    examples: ["What would happen if you fell into a black hole", "How big the universe really is", "Why the Moon is drifting away"],
    kind: "fact",
    promise: "A sense of wonder about one big idea in science, explained so anyone follows it.",
    hook: "Open on the mind-bending part (\"Every second, the Moon gets a little further away.\").",
    arc: "The question, a picture of scale or an everyday comparison, the explanation step by step, what scientists still do not know.",
    voice: "Calm and full of wonder; plain words, one idea at a time.",
    rules: [...FACT_RULES, "Separate what is measured from what is a hypothesis, and say \"scientists think\" for the latter."],
    styles: ["photorealistic_8k", "3d_render", "cyberpunk"],
    voices: ["documentary", "calm", "explainer"],
  },
  {
    id: "psychology",
    label: "Psychology",
    about: "Why people think and act the way they do",
    examples: ["Why you remember embarrassing moments at night", "The bias that makes you overpay", "Why we trust confident people"],
    kind: "fact",
    promise: "One well-known finding about the mind, and how to spot it in everyday life.",
    hook: "Describe an everyday experience the viewer will recognise, then promise the reason (\"Ever replay an awkward moment at 2 a.m.?\").",
    arc: "The relatable moment, the name of the effect, what research found, how to spot it or use it well.",
    voice: "Curious and clear; talk to the viewer as \"you\".",
    rules: [
      ...FACT_RULES,
      "Keep to well-replicated findings and say \"research suggests\"; never diagnose, never label a viewer or a person with a disorder.",
      "Explain manipulation only so it can be recognised and resisted; never as a technique to use on others.",
    ],
    styles: ["flat_illustration", "3d_render", "watercolor"],
    voices: ["explainer", "calm", "narrator-f"],
  },
  {
    id: "motivation",
    label: "Motivation",
    about: "Mindset, discipline and life lessons",
    examples: ["Why discipline beats motivation", "What the Stoics knew about anger", "The two-minute rule that ends procrastination"],
    kind: "fact",
    promise: "One idea that changes how the viewer acts today, said with conviction.",
    hook: "A bold, short statement that challenges a common belief (\"Motivation is the reason you're stuck.\").",
    arc: "The claim, why it is so (an idea, a thinker or a short true story), what to do instead, a line that lands.",
    voice: "Deep, steady, conviction; short sentences with rhythm; second person.",
    rules: [
      ...FACT_RULES,
      "Attribute a quote only to who really said it; otherwise do not quote. No promises of wealth or success, no shaming, and never belittle anxiety, depression or rest.",
    ],
    styles: ["cinematic_history", "photorealistic_8k", "film_noir"],
    voices: ["trailer", "documentary", "narrator-m"],
  },
  {
    id: "money",
    label: "Money basics",
    about: "Saving, budgeting and how money works",
    examples: ["How compound interest really works", "The 50/30/20 budget in one minute", "Why inflation makes your savings shrink"],
    kind: "fact",
    promise: "One money idea explained so clearly the viewer can use it, as education, not advice.",
    hook: "A concrete, relatable number or situation (\"Saving 5 a day becomes over 1,800 a year.\").",
    arc: "The situation, the idea in plain terms, a simple worked example, the one thing to remember.",
    voice: "Confident, plain and trustworthy; no hype.",
    rules: [
      ...FACT_RULES,
      "General education only: never tell the viewer to buy or sell a specific stock, coin or product, never promise returns or \"get rich\", and say plainly that investing carries risk whenever it comes up.",
      "Keep numbers simple and correct; no currency or tax rules that differ by country presented as universal.",
    ],
    styles: ["flat_illustration", "3d_render", "photorealistic_8k"],
    voices: ["explainer", "anchor", "narrator-m"],
  },
  {
    id: "tech",
    label: "Tech explained",
    about: "How the technology around us works",
    examples: ["How your phone knows where you are", "What actually happens when you send an email", "How AI image generators work"],
    kind: "fact",
    promise: "How one piece of everyday technology really works, without jargon.",
    hook: "A surprising thing the viewer's own device does (\"Your phone knows where you are without the internet.\").",
    arc: "The everyday thing, the hidden mechanism in steps, one analogy that makes it click, why it matters.",
    voice: "Clear, upbeat, a little geeky; explain every term the first time.",
    rules: [
      ...FACT_RULES,
      "Explain how things work, not news: no product launches, prices, release dates or specifications that may be out of date, and no claims about what a company is about to do.",
    ],
    styles: ["3d_render", "cyberpunk", "flat_illustration"],
    voices: ["host", "explainer", "anchor"],
  },
  {
    id: "mysteries",
    label: "Unsolved mysteries",
    about: "Real puzzles nobody has explained yet",
    examples: ["The Voynich manuscript nobody can read", "The ship found sailing with no crew", "The lights over Phoenix"],
    kind: "fact",
    promise: "One real, documented mystery, the evidence, and the leading explanations, leaving the question open.",
    hook: "Open on the unexplained fact (\"No one has been able to read this book for 600 years.\").",
    arc: "What is known for certain, the strange part, the main theories, what would settle it, the open question.",
    voice: "Suspenseful but fair; curious, never certain.",
    rules: [
      ...FACT_RULES,
      "Present every explanation as a theory and give the ordinary one fairly; never claim the supernatural or a conspiracy as fact.",
      "Stay away from mysteries about vaccines, medicine, elections or tragedies with living families: there a theory can harm.",
    ],
    styles: ["film_noir", "dark_fantasy", "photorealistic_8k"],
    voices: ["mystery", "documentary", "trailer"],
  },
  {
    id: "animals",
    label: "Animals and nature",
    about: "The strangest and most amazing animals and places",
    examples: ["The fish that walks on land", "Why octopuses have three hearts", "The forest that glows at night"],
    kind: "fact",
    promise: "One amazing true thing about an animal or the natural world.",
    hook: "The jaw-dropping trait, first (\"This animal can survive in space.\").",
    arc: "The animal or place, the amazing trait, how and why it works, one more surprise.",
    voice: "Warm and full of wonder, like a nature documentary.",
    rules: [...FACT_RULES, "Do not give an animal human thoughts as fact; no dangerous handling or feeding advice."],
    styles: ["photorealistic_8k", "watercolor", "3d_render"],
    voices: ["documentary", "calm", "storybook"],
  },
  {
    id: "what-if",
    label: "What if?",
    about: "Hypothetical scenarios worked out with real science",
    examples: ["What if the Earth stopped spinning", "What if Earth had rings like Saturn", "What if all the ice melted"],
    kind: "fact",
    promise: "A hypothetical scenario played out step by step, grounded in what science actually says.",
    hook: "Pose the scenario as a question in the first line.",
    arc: "The scenario, the first thing that happens, what follows in order, the end state, a closing thought.",
    voice: "Energetic and vivid; build the scenario like a countdown.",
    rules: [...FACT_RULES, "Say plainly that it is hypothetical, keep every step to what science supports, and say where the answer is uncertain."],
    styles: ["3d_render", "photorealistic_8k", "cartoon"],
    voices: ["host", "explainer", "trailer"],
  },
  {
    id: "places",
    label: "Places and cultures",
    about: "Countries, cities and customs around the world",
    examples: ["The country with no rivers", "Why Japan has vending machines everywhere", "The city built on water"],
    kind: "fact",
    promise: "One surprising true thing about a place or a culture, told with respect.",
    hook: "The surprising fact about the place, first (\"There is a country with no rivers at all.\").",
    arc: "The place, the surprising fact, the reason (geography, history or custom), what it is like today.",
    voice: "Curious traveller; warm and respectful.",
    rules: [...FACT_RULES, "No stereotypes about a people or a country, and nothing that mocks a culture or a religion."],
    styles: ["photorealistic_8k", "watercolor", "flat_illustration"],
    voices: ["narrator-f", "documentary", "upbeat"],
  },
  {
    id: "life-stories",
    label: "Stories with a lesson",
    about: "Short made-up stories with a twist and a moral",
    examples: ["The man who planted trees for 40 years", "The farmer and the lost horse", "The potter who kept the cracked bowl"],
    kind: "fiction",
    promise: "A short, moving story, a fable or a parable, that ends on a lesson the viewer remembers.",
    hook: "Open on the character and their situation in one line (\"An old farmer lost his only horse.\").",
    arc: "Character and situation, a turn of fortune, the reaction, a second turn, the lesson said in one line at the end.",
    voice: "Warm, calm, like a grandparent telling a story.",
    rules: [
      ...FICTION_RULES,
      "A traditional fable or parable may be retold as such (\"an old story says\"), never as a true event.",
      "The lesson is kind and sound: no shaming, and nothing that tells someone in trouble not to seek help.",
    ],
    styles: ["watercolor", "cartoon", "claymation"],
    voices: ["storyteller", "calm", "storybook"],
  },
];

export const NICHE_IDS = NICHES.map((n) => n.id) as [string, ...string[]];
export const nicheById = (id: string | undefined): Niche | undefined => NICHES.find((n) => n.id === id);

/** The most a niche written by the user may say. */
export const NICHE_TEXT_MAX = 120;
