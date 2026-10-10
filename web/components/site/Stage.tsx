/*
 * The Stage: the upright frame a video plays in, the one dark thing on a page. Its corners are a phone's,
 * because a phone is where these videos are watched.
 */

/** `caption`: what is said under the frame, left and right. */
export function Stage({ children, caption }: { children?: React.ReactNode; caption?: [string, string] }) {
  return (
    <figure className="mx-auto w-full max-w-[21rem]" data-testid="stage">
      <div className="relative aspect-[9/16] overflow-hidden rounded-[18px] bg-stage">{children}</div>
      {caption && (
        <figcaption className="figures mt-3 flex justify-between gap-4 text-[0.85rem] text-graphite">
          <span>{caption[0]}</span>
          <span>{caption[1]}</span>
        </figcaption>
      )}
    </figure>
  );
}
