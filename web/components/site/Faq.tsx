import { MAX_SCENES } from "@src/manifest/schema";
import { inWords } from "@/lib/site/calculator";

/*
 * The questions a careful buyer asks, answered as the product actually behaves (Phase 4 spec §5, block 8).
 * Every answer here is a statement about the code; when the code changes, so must the answer.
 */
type Facts = {
  /** What the videos on the page used, in words ("23, 32 and 81 cents"). */
  used: string;
  /** The studio takes payments: only then are plans, top-ups and Stripe something to ask about. */
  sells: boolean;
  /** The resolution clips are generated at on the studio's own GPU ("480p"), from a video on the page; empty when none was made there. */
  ownResolution: string;
};

const questions = ({ used, sells, ownResolution }: Facts): Array<{ q: string; a: string[] }> => [
  {
    q: "What will a video cost me?",
    a: [
      "It depends on its length and on how many scenes move. Before anything is generated you are shown the most it can cost, and that amount is the limit: you approve it, it is held from your credit, and what the video did not use comes back.",
      `The videos on this page used ${used} of credit. Their receipts are above.`,
    ],
  },
  ...(sells ? [{
    q: "Does my credit expire?",
    a: ["A plan's credit is for its month: what is left when the next month is paid for is gone, and so is what is left when a plan ends. Credit from a top-up does not expire. Plan credit is spent first."],
  }] : []),
  {
    q: "What happens if a video fails half-way, or I stop it?",
    a: [
      "It waits for you. Nothing is retried on its own, and when you continue, nothing that was already made is bought again.",
      "You pay for what was made, and for anything that had already been sent to a model when it stopped: the model's maker charges for that whether or not the result is collected.",
    ],
  },
  {
    q: "What can it not do?",
    a: [
      `It makes short videos of up to ${inWords(MAX_SCENES)} scenes, upright (9:16) or wide (16:9), from one sentence. It is not an editor with a timeline: you choose the look, the cuts, the opening title, the music and the brand, and you can have any single scene made again.`,
      `Writing inside the pictures — a label on a bottle, a street sign — comes out as scribble, as it does with most picture models.${ownResolution ? ` On our own GPU the moving clips are generated at ${ownResolution} and set into a full-HD video.` : ""}`,
    ],
  },
  {
    q: "Do I have to keep the page open while it works?",
    a: ["No. Videos are made on the server, in a queue; you see your place in line, and the video is in your account when you come back."],
  },
  ...(sells ? [
    {
      q: "Who sees my card?",
      a: ["Stripe. You pay on Stripe's own page, and manage or cancel a plan on Stripe's own page; Flow Chain is told that a payment was made, and nothing about the card."],
    },
    {
      q: "Can I get my money back?",
      a: ["When a payment is refunded, the credit it bought is taken back in the same proportion. Ending a plan stops the next month from being charged; the month already paid for stays yours until it is over."],
    },
  ] : []),
];

/** `usedCents`: what each showcase video on the page used, from its receipt, so the answer quotes the page's own figures. */
export function Faq({ usedCents, sells, ownClips }: { usedCents: number[]; sells: boolean; ownClips: string }) {
  const sorted = [...usedCents].sort((a, b) => a - b).map(String);
  const used = sorted.length > 1 ? `${sorted.slice(0, -1).join(", ")} and ${sorted.at(-1)} cents` : `${sorted[0] ?? "a few"} cents`;
  return (
    <div className="max-w-[52rem]" data-testid="faq">
      {questions({ used, sells, ownResolution: /\b(\d{3,4}p)\b/.exec(ownClips)?.[1] ?? "" }).map(({ q, a }) => (
        <details key={q} className="group border-t border-hairline last:border-b">
          <summary className="flex cursor-pointer list-none items-baseline justify-between gap-6 py-5 text-[1.2rem] marker:hidden [&::-webkit-details-marker]:hidden">
            {q}
            <span aria-hidden="true" className="figures text-[1.1rem] text-graphite transition-transform group-open:rotate-45">+</span>
          </summary>
          <div className="space-y-3 pb-6 pr-10 text-[1.02rem] leading-[1.55] text-graphite">
            {a.map((p) => <p key={p}>{p}</p>)}
          </div>
        </details>
      ))}
    </div>
  );
}
