import type React from "react";
import { AbsoluteFill, Img, useVideoConfig } from "remotion";
import { useMedia } from "../media.js";
import type { BrandProps } from "../props.js";

/** The brand watermark: the logo at its corner, on top of everything, never zoomed. */
export const BrandLayer: React.FC<{ brand: BrandProps }> = ({ brand }) => {
  const { width, height } = useVideoConfig();
  const media = useMedia();
  const margin = (brand.marginPct / 100) * Math.min(width, height);
  const [vertical, horizontal] = brand.position.split("-");
  return (
    <AbsoluteFill>
      <Img
        src={media(brand.logo)}
        style={{
          position: "absolute",
          width: `${brand.widthPct}%`,
          height: "auto",
          opacity: brand.opacity,
          top: vertical === "top" ? margin : undefined,
          bottom: vertical === "bottom" ? margin : undefined,
          left: horizontal === "left" ? margin : undefined,
          right: horizontal === "right" ? margin : undefined,
        }}
      />
    </AbsoluteFill>
  );
};
