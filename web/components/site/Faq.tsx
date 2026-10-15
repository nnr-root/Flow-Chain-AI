import { lengthInWords, SCENE_SECONDS, VIDEO_SECONDS } from "@src/duration";

/*
 * The questions a careful buyer asks, answered as the product actually behaves (Phase 4 spec §5, block 8).
 * Every answer here is a statement about the code; when the code changes, so must the answer.
 */
type Facts = {
  /** What the videos on the page used, in words ("460, 634 and 1,625 credits"). */
  used: string;
  /** The studio takes payments: only then are plans and Stripe something to ask about. */
  sells: boolean;
  /** The height clips are generated at (480), from a video on the page made the way the studio makes them now; absent when none says. */
  clipHeight?: number;
};

const questions = ({ used, sells, clipHeight }: Facts): Array<{ q: string; a: string[] }> => [
  {
    q: "What will a video cost me?",
    a: [
      "It depends on its length and on how many scenes move. Before anything is generated you are shown the most credits it can use, and that amount is the limit: you approve it, it is held from your credits, and what the video did not use comes back.",
      `The videos on this page used ${used}. Their receipts are above.`,
    ],
  },
  ...(sells ? [{
    q: "Does my credit expire?",
    a: ["A plan's credits are for their month, whether the plan is paid by the month or by the year: what is left when the next month's come is gone, and so is what is left when a plan ends. Credits that did not come with a plan do not expire, and a plan's are spent first."],
  }] : []),
  {
    q: "What happens if a video fails half-way, or I stop it?",
    a: [
      "It waits for you. Nothing is retried on its own, and when you continue, nothing that was already made is bought again.",
      "You pay for what was made, and for anything that was already being generated when it stopped: that computing time is used whether or not the result is collected.",
    ],
  },
  {
    q: "What can it not do?",
    a: [
      `It makes videos of the length you choose, from ${lengthInWords(VIDEO_SECONDS[0])} to ${lengthInWords(VIDEO_SECONDS[VIDEO_SECONDS.length - 1])}, upright (9:16) or wide (16:9), from one sentence. A scene stays for ${SCENE_SECONDS.min} to ${SCENE_SECONDS.max} seconds, and a video's length is its narration's, so it is about what you asked for and not to the second. It is not an editor with a timeline: you choose the look, the cuts, the opening title, the music and the brand, and you can have any single scene made again.`,
      `Writing inside the pictures — a label on a bottle, a street sign — comes out as scribble, as it does in most generated pictures.${clipHeight ? ` The moving clips are generated at ${clipHeight}p and set into a full-HD video.` : ""}`,
    ],
  },
  {
    q: "Do I have to keep the page open while it works?",
    a: ["No. Videos are made on the server, in a queue; you see your place in line, and the video is in your account when you come back."],
  },
  ...(sells ? [
    {
      q: "Who sees my card?",
      a: ["Stripe. You pay on Stripe's own page, and manage or cancel a plan on Stripe's own page; Flow Chain AI is told that a payment was made, and nothing about the card."],
    },
    {
      q: "Can I get my money back?",
      a: ["When a payment is refunded, the credit it bought is taken back in the same proportion. Ending a plan stops the next month from being charged; the month already paid for stays yours until it is over."],
    },
  ] : []),
];

/** `usedCredits`: what each showcase video on the page used, from its receipt, so the answer quotes the page's own figures. */
export function Faq({ usedCredits, sells, clipHeight }: { usedCredits: number[]; sells: boolean; clipHeight?: number }) {
  const sorted = [...usedCredits].sort((a, b) => a - b).map((n) => n.toLocaleString("en-US"));
  const used = sorted.length > 1 ? `${sorted.slice(0, -1).join(", ")} and ${sorted.at(-1)} credits` : `${sorted[0] ?? "a few hundred"} credits`;
  return (
    <div className="max-w-[52rem]" data-testid="faq">
      {questions({ used, sells, clipHeight }).map(({ q, a }) => (
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
