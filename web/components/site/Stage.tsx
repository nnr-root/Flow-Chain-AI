import { Frame } from "@/components/Sketch";

/*
 * The Stage: the upright frame a video plays in, the one dark thing on a page. It is the last panel of a board,
 * the one that moves, and is drawn around like the others.
 */

/** `caption`: what is noted under the frame, in red pencil. `order`: its turn when a board is drawn in. */
export function Stage({ children, caption, order }: { children?: React.ReactNode; caption?: [string, string]; order?: number }) {
  return (
    <figure className="mx-auto w-full max-w-[21rem]" data-testid="stage">
      <div className="relative">
        <div className="relative aspect-[9/16] overflow-hidden bg-stage">{children}</div>
        <Frame seed={7} order={order} weight={2.4} />
      </div>
      {caption && (
        <figcaption className="note mt-3 flex justify-between gap-4">
          <span>{caption[0]}</span>
          <span>{caption[1]}</span>
        </figcaption>
      )}
    </figure>
  );
}
