import type React from "react";
import { createContext, useContext } from "react";
import { staticFile } from "remotion";

/** Turns a published path from RenderProps (e.g. "fitted/scene_01.mp4") into a URL the browser can load. */
export type MediaResolver = (publishedPath: string) => string;

/** A render stages its files in the bundle's public folder, so the default is Remotion's `staticFile`. */
const MediaContext = createContext<MediaResolver>(staticFile);

/** Lets a host other than the render bundle (the web Player) serve the same published paths from its own URLs. */
export const MediaProvider: React.FC<{ resolve: MediaResolver; children: React.ReactNode }> = ({ resolve, children }) => (
  <MediaContext.Provider value={resolve}>{children}</MediaContext.Provider>
);

export const useMedia = (): MediaResolver => useContext(MediaContext);
