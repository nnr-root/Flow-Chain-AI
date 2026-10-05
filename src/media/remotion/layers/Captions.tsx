import { loadFont } from "@remotion/fonts";
import { fitText } from "@remotion/layout-utils";
import type React from "react";
import { Fragment, useEffect, useState } from "react";
import {
  AbsoluteFill, cancelRender, continueRender, delayRender, staticFile, useCurrentFrame, useVideoConfig,
} from "remotion";
import type { CaptionPage, CaptionStyle } from "../props.js";
import { activePageIndex, activeTokenIndex } from "../timeline.js";

/**
 * Loads the style's bundled font before any frame is captured (no system fonts are used). The render is
 * released only after the re-render with the font has been committed, so no frame is captured without its
 * caption; a font that fails to load fails the render.
 */
export function useCaptionFont(style: CaptionStyle): boolean {
  const [handle] = useState(() => delayRender(`font ${style.font.family}`));
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    loadFont({ family: style.font.family, url: staticFile(style.font.file), weight: String(style.font.weight) }).then(
      () => setLoaded(true),
      (err: unknown) => cancelRender(err),
    );
  }, [style.font.family, style.font.file, style.font.weight]);
  useEffect(() => {
    if (loaded) continueRender(handle);
  }, [loaded, handle]);
  return loaded;
}

/** Word-by-word captions: the visible page, with the word being spoken in the active style. */
export const Captions: React.FC<{ style: CaptionStyle; bottomPct: number; pages: CaptionPage[] }> = ({
  style,
  bottomPct,
  pages,
}) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const loaded = useCaptionFont(style);
  if (!loaded) return null;

  const ms = (frame / fps) * 1000;
  const pageIndex = activePageIndex(pages, ms);
  if (pageIndex < 0) return null;
  const page = pages[pageIndex];
  const active = activeTokenIndex(page, ms);

  const textTransform = style.textCase === "upper" ? "uppercase" : "none";
  const wanted = (style.sizePctOfShortSide / 100) * Math.min(width, height);
  const fitted = fitText({
    text: page.text,
    withinWidth: width * 0.9,
    fontFamily: style.font.family,
    fontWeight: style.font.weight,
    textTransform,
  }).fontSize;
  const fontSize = Math.min(wanted, fitted);

  return (
    <AbsoluteFill>
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          bottom: `${bottomPct}%`, // percent of the frame height (padding percentages would use the width)
          fontFamily: style.font.family,
          fontWeight: style.font.weight,
          fontSize,
          lineHeight: 1.1,
          textTransform,
          textAlign: "center",
          whiteSpace: "pre",
          color: style.color,
          textShadow: style.shadow ?? undefined,
          WebkitTextStroke: style.stroke ? `${(style.stroke.pctOfSize / 100) * fontSize}px ${style.stroke.color}` : undefined,
          paintOrder: "stroke fill",
        }}
      >
        {page.tokens.map((token, i) => {
          const isActive = i === active;
          const sinceStart = frame - (token.fromMs / 1000) * fps;
          const pop = isActive && style.activeAnim === "pop" ? 1 + 0.15 * Math.max(0, 1 - sinceStart / 4) : 1;
          const fadeIn = isActive && style.activeAnim === "fade" ? Math.min(1, style.inactiveOpacity + sinceStart / 4) : 1;
          // the space stays outside the (possibly scaled) word, so a popping word never swallows it
          return (
            <Fragment key={i}>
              {token.text.startsWith(" ") ? " " : ""}
              <span
                style={{
                  display: "inline-block",
                  margin: style.activeAnim === "pop" ? "0 0.08em" : undefined,
                  color: isActive ? style.activeColor : style.color,
                  opacity: isActive ? fadeIn : style.inactiveOpacity,
                  transform: pop !== 1 ? `scale(${pop})` : undefined,
                }}
              >
                {token.text.trimStart()}
              </span>
            </Fragment>
          );
        })}
      </div>
    </AbsoluteFill>
  );
};
