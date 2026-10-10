"use client";
import { useState } from "react";

/**
 * How much of a sentence is carried through sign-up: it travels in an address (and, for a new account, in the
 * emailed link), where every letter outside plain English takes up to nine characters. The form itself takes more.
 */
export const CARRIED_CHARS = 200;

/** Where a topic typed on the landing page leads: the new-video form with it filled in, by way of an account if there is none. */
export function startAddress(topic: string, signedIn: boolean): string {
  const text = topic.trim().slice(0, CARRIED_CHARS);
  const form = text === "" ? "/new" : `/new?topic=${encodeURIComponent(text)}`;
  return signedIn ? form : `/signup?next=${encodeURIComponent(form)}`;
}

/**
 * The hero's way in (Phase 4 spec §5): the visitor types what their video is about, and that sentence is in the
 * new-video form when they get there — after creating an account, if they have none. `free`: a new account is
 * given credit for a first draft, so the button may say so.
 */
export function TopicStart({ signedIn, free, sells = true, id = "hero-topic" }: { signedIn: boolean; free: boolean; sells?: boolean; id?: string }) {
  const [topic, setTopic] = useState("");
  return (
    <form
      className="mx-auto mt-6 max-w-[38rem]" data-testid={id === "hero-topic" ? "topic-start" : `topic-start-${id}`}
      onSubmit={(e) => {
        e.preventDefault();
        window.location.assign(startAddress(topic, signedIn));
      }}
    >
      <label htmlFor={id} className="sr-only">What is your video about?</label>
      {/* the bar a feed has under a video, where a comment is typed: here it is where a video starts */}
      <div className="flex flex-wrap gap-2 rounded-[30px] bg-sheet p-2 ring-1 ring-hairline focus-within:ring-2 focus-within:ring-signal">
        <input
          id={id} type="text" value={topic} onChange={(e) => setTopic(e.target.value)} maxLength={CARRIED_CHARS} data-testid={id}
          placeholder="What is your video about?"
          className="min-w-0 flex-1 basis-56 !rounded-full !border-0 !bg-transparent px-4 py-3 text-left text-[1.02rem] !outline-none"
        />
        <button type="submit" data-cta={`${id === "hero-topic" ? "hero" : "closing"}-${signedIn ? "new" : "signup"}`} className="rounded-full bg-signal px-6 py-3 text-[1.02rem] font-bold text-paper hover:bg-ink">
          {signedIn ? "Make this video" : free ? "Make a free draft" : "Create an account"}
        </button>
      </div>
      {!signedIn && (
        <p className="mt-3 text-[0.92rem] text-graphite">
          {free
            ? `You create an account, and the script for it is written for you to read: on us.${sells ? " Pictures and video are what credit is for." : ""}`
            : "You create an account, and your sentence is waiting in the form when you are in."}
        </p>
      )}
    </form>
  );
}
