"use client";
import { useEffect, useState } from "react";
import { getJson } from "@/lib/api";
import type { StudioHealth } from "@/server/jobs";

/**
 * On a server, work is done by the worker through the queue. When either is away, say so on every page: a click
 * would otherwise be refused with no hint of why, or seem to wait for ever.
 */
export function QueueBanner() {
  const [problem, setProblem] = useState("");
  useEffect(() => {
    let gone = false;
    const check = () =>
      getJson<StudioHealth>("/api/health").then(
        ({ queue }) => {
          if (gone) return;
          setProblem(
            queue.mode !== "queue" ? "" : !queue.redis ? "The job queue is unavailable." : !queue.worker ? "The worker is offline." : "",
          );
        },
        () => {},
      );
    void check();
    const timer = setInterval(check, 15_000);
    return () => {
      gone = true;
      clearInterval(timer);
    };
  }, []);
  if (!problem) return null;
  return (
    <p role="status" data-testid="queue-banner" className="border-b border-bad/40 bg-bad/10 px-6 py-2 text-center text-sm text-bad">
      {problem} Nothing can be started until it is back; runs already bought are safe.
    </p>
  );
}
