"use client";

/** A page that could not be put together (the job queue being away, mostly): say so, and offer to try again. */
export default function PageError({ error, reset }: { error: Error; reset: () => void }) {
  return (
    <div className="mx-auto max-w-xl px-6 py-16 text-center" data-testid="page-error">
      <h1 className="text-lg font-semibold">This page could not be loaded</h1>
      <p className="mt-2 text-sm text-dim">{error.message || "Something went wrong."} Your runs are safe on disk.</p>
      <button type="button" onClick={reset} className="mt-6 rounded-md border border-line px-4 py-2 text-sm">
        Try again
      </button>
    </div>
  );
}
