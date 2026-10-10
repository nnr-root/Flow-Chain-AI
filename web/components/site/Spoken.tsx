import { Fragment } from "react";

/**
 * A title spoken once, the way a caption speaks it: yellow is on each word for the moment it would be said, then
 * moves on, and it comes to rest on `rest`, the word that is the point (`.spoken` in the theme). It is the
 * site's one movement that nobody asked for, and it is what the product does to every line of a script. With
 * "reduce motion" on, the yellow is simply on the word it rests on.
 */
export function Spoken({ text, rest }: { text: string; rest: string }) {
  const words = text.split(" ");
  const at = words.findIndex((w) => w.toLowerCase().replace(/[^a-z]/g, "") === rest.toLowerCase());
  return (
    <span className="spoken" aria-label={text}>
      {words.map((word, i) => (
        // (the words are one sentence to a screen reader, which is given the label above instead)
        <Fragment key={i}>
          <span aria-hidden="true" className={i === at ? "rest" : undefined} style={{ "--i": i } as React.CSSProperties}>{word}</span>
          {i < words.length - 1 ? " " : ""}
        </Fragment>
      ))}
    </span>
  );
}
