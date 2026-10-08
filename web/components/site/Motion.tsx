"use client";
import { MotionConfig } from "motion/react";

/** Every spring on the marketing side follows the visitor's own setting: with "reduce motion" on, things change in place. */
export function Motion({ children }: { children: React.ReactNode }) {
  return <MotionConfig reducedMotion="user">{children}</MotionConfig>;
}
