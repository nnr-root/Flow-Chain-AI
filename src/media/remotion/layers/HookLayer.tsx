import { fitText } from "@remotion/layout-utils";
import type React from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";
import type { CaptionStyle, HookProps } from "../props.js";
import { HOOK, hookLines, hookTitleLook, zoomAt } from "../timeline.js";
import { useCaptionFont } from "./Captions.js";

/** Snap zoom: scales its children (the scenes and transitions) from `zoomFrom` back to 1 at the start. */
export const SnapZoom: React.FC<{ hook: HookProps | null; children: React.ReactNode }> = ({ hook, children }) => {
  const frame = useCurrentFrame();
  const scale = hook ? zoomAt(frame, hook.zoomFrom, hook.zoomFrames) : 1;
  return <AbsoluteFill style={{ transform: scale !== 1 ? `scale(${scale})` : undefined }}>{children}</AbsoluteFill>;
};

/** The hook title: big, upper-centre, in the caption font, on one or two lines, its last word in the accent colour. */
export const HookLayer: React.FC<{ hook: HookProps; style: CaptionStyle }> = ({ hook, style }) => {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();
  const loaded = useCaptionFont(style);
  const look = hookTitleLook(frame, hook.endFrame);
  if (!loaded || !look.visible) return null;

  const words = hook.text.trim().split(/\s+/);
  const wanted = (HOOK.sizePctOfShortSide / 100) * Math.min(width, height);
  const fit = (line: string) =>
    fitText({
      text: line,
      withinWidth: width * (HOOK.widthPct / 100),
      fontFamily: style.font.family,
      fontWeight: style.font.weight,
      textTransform: "uppercase",
    }).fontSize;
  const { lines, fontSize } = hookLines(words, fit, wanted);
  const last = lines.length - 1;
  const lastWords = lines[last].split(" ");

  return (
    <AbsoluteFill>
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          top: `${HOOK.centerTopPct}%`,
          transform: `translateY(-50%) scale(${look.scale})`,
          opacity: look.opacity,
          textAlign: "center",
          whiteSpace: "pre",
          fontFamily: style.font.family,
          fontWeight: style.font.weight,
          fontSize,
          lineHeight: 1.1,
          textTransform: "uppercase",
          color: style.color,
          textShadow: style.shadow ?? undefined,
          WebkitTextStroke: style.stroke ? `${(style.stroke.pctOfSize / 100) * fontSize}px ${style.stroke.color}` : undefined,
          paintOrder: "stroke fill",
        }}
      >
        {lines.slice(0, last).map((line) => `${line}\n`)}
        {lastWords.length > 1 ? `${lastWords.slice(0, -1).join(" ")} ` : ""}
        <span style={{ color: style.activeColor }}>{lastWords.at(-1)}</span>
      </div>
    </AbsoluteFill>
  );
};
