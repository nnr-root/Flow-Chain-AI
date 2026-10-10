/*
 * The Stage: the upright frame a video plays in. Its corners are a phone's, because a phone is where these
 * videos are watched; on a page as dark as it is, a thin line of light tells where it ends.
 */

/** `caption`: what is said under the frame, left and right. */
export function Stage({ children, caption }: { children?: React.ReactNode; caption?: [string, string] }) {
  return (
    <figure className="mx-auto w-full max-w-[21rem]" data-testid="stage">
      <div className="relative aspect-[9/16] overflow-hidden rounded-[26px] bg-stage ring-1 ring-hairline">{children}</div>
      {caption && (
        <figcaption className="note mt-3 flex justify-between gap-4 text-[0.9rem] text-graphite">
          <span>{caption[0]}</span>
          <span>{caption[1]}</span>
        </figcaption>
      )}
    </figure>
  );
}
