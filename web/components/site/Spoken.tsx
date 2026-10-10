/**
 * A line read out once, the way a caption reads it: the highlighter is on each word for the moment it would be
 * spoken, then moves on, and after the last word it is put down (`.spoken` in the theme). It is the page's one
 * movement that nobody asked for, and it shows what the product does to every line of a script. With "reduce
 * motion" on, nothing moves.
 */
export function Spoken({ text }: { text: string }) {
  const words = text.split(" ");
  return (
    <span className="spoken" aria-label={text}>
      {words.map((word, i) => (
        // (the words are one sentence to a screen reader, which is given the label above instead)
        <span key={i} aria-hidden="true" style={{ "--i": i } as React.CSSProperties}>{word}{i < words.length - 1 ? " " : ""}</span>
      ))}
    </span>
  );
}
